# AGENTS_CONTRACT.md — frozen cross-agent contract

Last updated: 2026-09-05 — simulation-engine amendment (S9): `click_payment_link`
gained an optional `forced_reason` param for the tester-driven fake-checkout
screen, a playground-only `wrong_password` failure reason, and an
`insufficient_funds` carve-out (never escalates; reschedules
`sim_state.salary_reminder_day` instead). See §12/§13.

Previously (2026-09-05): owner amendment (Phase B0 plan-review): resolved
payment-engine-builder's P5-P8 and simulation-engine-builder's S4-S7 contract
questions from their plan-only pass — most notably **P5, a real bug catch**:
`resolve_fake_capture` needed an `attempt` salt or a bounded `/pay/:token`
retry would replay the identical failure forever. See §11/§12/§13.

Previously (2026-09-05, same day): added the
unified payment-capture engine (`app/agents/payment.py`, §11), the
`PaymentLinkStatus` vocabulary, six new `Event` columns, and the Playground
`sim_state` contract (§12). See "Payment-capture engine" and "Playground
sim_state" below.

Previously (2026-09-04): added the Triage agent, the `tickets` table, and the
three human-review endpoints. See "Human Review Triage" below.

This file is the single source of truth every stage builder follows. The
team-lead owns it; builders **never edit it** — raise a "contract question" in
your plan and the team-lead amends it. At runtime the agents are strictly
sequential (each reads the `status` the previous one wrote). At build time they
couple only through: the `RootCause` vocabulary, the audit `action` registry,
the stopping-rule constants, the fraud-cluster signature, and the audit
`payload` shapes — all frozen below.

All persistence goes through `backend/app/db/store.py`. No raw SQL anywhere
else. `log_action` is the only audit write and its `reasoning` is never empty.
Money is `Decimal`, quantised to paise (`store.MONEY`). Test mode only.

---

## 1. Per-stage I/O

| Stage | Reads (status filter) | store.py calls | Writes (status out) | Audit rows |
|---|---|---|---|---|
| **Detection** (`detection.py`) | `get_events_by_status("detected")` | `get_events_by_status`, `update_event`, `log_action` | stays `detected` (at-risk, confirmed) **or** `exception` (obvious non-recoverable) | exactly one per event: `flagged_at_risk` or `routed_to_exception` |
| **Diagnosis** (`diagnosis.py`) | `get_events_by_status("detected")` | `get_events_by_status`, `all_events` (for cluster scan), `update_event`, `log_action` | `diagnosed` (+ `root_cause`, `diagnosis_confidence`) **or** `flagged` (triage: `root_cause="suspected_fraud"`) | one per event: `classified_root_cause` or `llm_classified_root_cause`; plus `halted_fraud_cluster` for each clustered event |
| **Recovery** (`recovery.py`) | `get_events_by_status("diagnosed")` | `get_events_by_status`, `update_event`, `log_action`, `payment.create_payment_link`, `payment.resolve_fake_capture`, `payment.apply_capture` (§11) | `action_taken` → `payment_link_sent` (`payment_link_status=AWAITING_CAPTURE`); fake gateway resolves synchronously → `recovered` (via `apply_capture`) or `exception`; a real Razorpay link stays `action_taken`/`AWAITING_CAPTURE` until an async webhook confirms it; refuses `flagged` (never reads it) | `intervention_selected` (always), then one or more action rows (below), `payment_link_sent`, then `payment_captured`/`marked_recovered` or `payment_capture_failed`/`halted_stopping_rule`/`routed_to_exception` |
| **Triage** (`triage.py`) | `get_events_by_status(["flagged","exception"])` | `tickets_for_event`, `get_audit_trail`, `insert_ticket`, `log_action` | **writes no event rows on `run()`** — opens tickets only | one `opened_review_ticket` row per new ticket (`agent="triage"`) |
| **Audit** (`audit.py`) | `all_events`, `get_audit_trail` | `all_events`, `get_audit_trail`, `log_action` | **writes no event rows** | one `batch_metrics` row (`agent="audit"`, `event_id` = `all_events(session)[0].event_id`, the earliest event) |

Triage runs **after** Recovery and **before** Audit — every event is terminal by
then. It is idempotent: `tickets_for_event` skips any event that already has a
ticket, open or closed, so re-running the pipeline never duplicates or reopens
work. A human then drives the ticket forward outside the pipeline via
`assign_ticket` / `resolve_ticket` / `raise_customer_question` (see "Human
Review Triage" below) — those write `agent="human"` audit rows and, on a money
resolution, an `Event` update (`recovered_amount`, `human_recovered_amount`,
possibly `status`).

Detection also routes to `exception`: a `failed_payment` / `expired_mandate`
whose `raw_failure_reason` is null/blank (no signal for Diagnosis) and any
event whose `currency != "INR"` (out of scope for test-mode recovery). The
seeded batch produces neither, so these are defensive.

Detection runs first even though the generator already sets `status="detected"`:
it re-affirms genuine risk and diverts obvious non-recoverables (amount ≤ 0 after
rules, unsupported `event_type`, `recovered_amount` already ≥ `amount`).

Terminal statuses: `recovered`, `exception`, `flagged`. The pipeline asserts
every event is terminal at the end **except** an event whose
`payment_link_status=AWAITING_CAPTURE` from a *real* Razorpay link (§11) —
that one genuinely waits on an async webhook that may never arrive in an
offline demo run, and staying `action_taken` is the honest state, not a bug.
`test_pipeline.py`'s terminal-status assertion is scoped to exclude this case
(only reachable when `RAZORPAY_KEY_ID`/`SECRET` are configured — the default
demo run never produces it, since the fake-gateway path always resolves
synchronously).

---

## 2. `RootCause` vocabulary → trigger → intervention

`RootCause` is a `StrEnum` in `store.py`. Diagnosis sets it; Recovery routes on
it. Rules-first mapping from `raw_failure_reason`:

| `root_cause` | `raw_failure_reason` triggers | `event_type` fallback | Recovery intervention | Rules confidence |
|---|---|---|---|---|
| `insufficient_funds` | `insufficient_fund` | — | schedule retry near next salary window (`scheduled_retry`) | 0.95 |
| `expired_instrument` | `card_expired`, `card_number_invalid`, `mandate_creation_expired`, `mandate_creation_failed` | `expired_mandate` | send re-authorization / re-mandate link (`sent_reauth_link`) | 0.9 |
| `bank_downtime` | `bank_not_available`, `bank_technical_error`, `gateway_technical_error` | — | suggest alternate payment method + short-delay retry (`suggested_alternate_method`) | 0.9 |
| `auth_failure` | `authentication_failed`, `payment_timed_out`, `incorrect_otp`, `invalid_otp` | — | prompt a fresh guided retry (`prompted_guided_retry`) | 0.9 |
| `card_declined` | `card_declined`, `card_disabled_for_online_payments` | — | one cautious retry, then exception (`scheduled_retry` then `routed_to_exception`) | 0.8 |
| `checkout_abandoned` | `None`, `payment_cancelled` | `abandoned_checkout` | personalized nudge; bounded discount only above the human-approval gate (`sent_nudge`, maybe `awaiting_human_approval`) | 0.85 (0.7 for `payment_cancelled`) |
| `invoice_forgotten` | `None` | `overdue_invoice` | escalation ladder: reminder → formal notice → human handoff (`escalation_stage_advanced`) | 0.85 |
| `suspected_fraud` | set by triage only | — | Recovery refuses to act; stays `flagged` | n/a |
| `unknown` | anything unmatched | — | Recovery routes straight to `exception` with reason "unclassified root cause" | ≤ 0.4 |

If the rules map yields `unknown` / confidence ≤ 0.5 **and** there is free-text
in `raw_failure_reason`, Diagnosis calls Claude (see §5). Claude must return one
of the enum members; anything else is coerced to `unknown`.

---

## 3. Audit `action` registry (exact strings — do not drift)

Audit aggregates on these; a typo silently breaks a metric.

| Agent | `action` | When |
|---|---|---|
| detection | `flagged_at_risk` | event confirmed genuinely at-risk, left `detected` |
| detection | `routed_to_exception` | obvious non-recoverable diverted |
| detection | `ingested_webhook_event` | written by `app/webhooks/listener.py` when a Razorpay test-mode webhook creates an event; the event enters as `detected` and the Detection Agent triages it on the next run |
| diagnosis | `classified_root_cause` | rules classifier decided |
| diagnosis | `llm_classified_root_cause` | Claude fallback decided |
| diagnosis / triage | `halted_fraud_cluster` | member of a fraud-signature cluster → `flagged` (agent=`triage`) |
| recovery | `intervention_selected` | routed a `diagnosed` event to its intervention |
| recovery | `scheduled_retry` | a bounded retry was scheduled |
| recovery | `sent_reauth_link` | re-authorization / re-mandate link drafted+sent |
| recovery | `suggested_alternate_method` | alternate-method outreach drafted+sent |
| recovery | `prompted_guided_retry` | guided-retry outreach drafted+sent |
| recovery | `sent_nudge` | abandoned-checkout nudge drafted+sent |
| recovery | `escalation_stage_advanced` | invoice escalation moved one stage |
| recovery | `awaiting_human_approval` | action above `HUMAN_APPROVAL_THRESHOLD_INR` — flagged, NOT executed |
| recovery | `halted_stopping_rule` | a stopping rule stopped further action → `exception` |
| recovery | `payment_link_sent` | `create_payment_link` result stamped on the event (`payment_link_id/url/status=AWAITING_CAPTURE/sent_at`) |
| recovery | `payment_captured` | written by `payment.apply_capture` on a successful capture (agent is always `recovery` regardless of trigger — webhook, fake gateway, or `/pay/:token`) → `recovered` |
| recovery | `payment_capture_failed` | written by `payment.apply_capture` on a failed capture attempt; `Event.status` untouched, caller decides next step |
| recovery | `marked_recovered` | **kept for audit.py backward-compat** (its `avg_hours_to_recovery` calc reads this action's `simulated_hours_to_recovery` payload) — logged by `recovery.py` immediately after a successful `apply_capture` on the fake-gateway (synchronous) path only; money clawed back → `recovered` was already set by `apply_capture`, this is the metrics-facing echo, never a second status write |
| recovery | `routed_to_exception` | gave up with a stated reason → `exception` |
| triage | `opened_review_ticket` | pipeline step: a terminal `flagged`/`exception` event with no existing ticket gets one |
| human | `assigned_review_ticket` | an employee took an `open` ticket (→ `under_review`) |
| human | `resolved_review_ticket` | an employee closed a ticket `resolved` or `unresolved`; `reasoning` **is** the employee's own note, verbatim |
| human | `human_recovered` | written alongside `resolved_review_ticket` only when `recovered_amount > 0`; the event's `recovered_amount` / `human_recovered_amount` were just updated |
| human | `raised_customer_question` | mid-call or in a message, the customer asked something the AI cannot answer — opens a `customer_question` ticket |
| audit | `batch_metrics` | end-of-run metrics snapshot |

---

## 4. Stopping-rule constants (defined in `recovery.py`, imported by tests)

| Constant | Value | Meaning |
|---|---|---|
| `MAX_RETRY_ATTEMPTS` | `3` | `attempts_so_far` at/above this → no more retries, `halted_stopping_rule` → `exception` |
| `MAX_ESCALATION_STAGE` | `3` | invoice ladder stages: 1 reminder, 2 formal notice, 3 human handoff. Never advance past 3 (no auto-legal, no auto-suspension) |
| `COOLDOWN_HOURS` | `24` | minimum simulated gap between two contacts to the same customer |
| `HUMAN_APPROVAL_THRESHOLD_INR` | `Decimal("5000")` | any discount offer or escalation on an amount strictly above this → `awaiting_human_approval` (audit flag only, action not executed) |
| `SALARY_WINDOW_DAY` | `1` | day-of-month a salary-credit retry targets for `insufficient_funds` |
| `RETRY_BACKOFF_HOURS` | `6` | delay for a `bank_downtime` retry |

Simulated time: Recovery computes `retry_at` / contact timestamps as offsets
from `event.updated_at`; nothing sleeps. "Recovered" is decided by a
deterministic per-event rule (see §7), not randomness, so the demo is stable.

---

## 4a. Human Review Triage (`triage.py`) — priority constants

| Constant | Value | Meaning |
|---|---|---|
| `PRIORITY_BASE[SUSPECTED_FRAUD]` | `90` | money may be leaving; the halt is already in force |
| `PRIORITY_BASE[CUSTOMER_QUESTION]` | `80` | a real person is waiting on an answer |
| `PRIORITY_BASE[AWAITING_APPROVAL]` | `75` | recovery is blocked until someone signs off |
| `PRIORITY_BASE[EXCEPTION_NO_ERROR]` | `65` | the AI has no signal; needs human eyes |
| `PRIORITY_BASE[INVOICE_HANDOFF]` | `55` | ladder ended exactly where it was designed to |
| `PRIORITY_BASE[OTHER]` | `40` | |
| `PRIORITY_BASE[STALLED_NO_RESPONSE]` | `25` | **the automation behaved correctly** — stopping rules did their job. Still ticketed (lost revenue), but never allowed to outrank fraud, approval, or a waiting customer |
| `AMOUNT_WEIGHT_CAP` / `AMOUNT_WEIGHT_DIVISOR` | `15` / `5000` | priority += `min(15, amount/5000)` — breaks ties within a reason; can never let money override reason ordering |
| `PRIORITY_BANDS` | critical ≥85, high ≥60, medium ≥40, else low | display bands; mirrored in the frontend (`actionLabels.priorityBand`) |

`_classify(event, trail)` reads the event's own audit trail to pick the reason —
never guesses. A ticket has **one owner**: `assign_ticket` refuses a
non-`open` ticket; `resolve_ticket` refuses a ticket that isn't `under_review`,
an unrecognised `outcome`, an empty note, or a `recovered_amount` that would push
the event's total above what was ever at risk.

---

## 5. Claude usage

- **Provider-agnostic** via `app/llm.py` — `llm.chat(system, user, *, settings)`
  and `llm.available(settings)`. Providers auto-detected in order
  `anthropic → openrouter → openai` (or forced with `LLM_PROVIDER`). OpenRouter
  and OpenAI use the OpenAI-compatible REST endpoint over `httpx`; Anthropic
  uses its native SDK. OpenRouter's default model is a Claude model.
- Diagnosis: call **only** when rules confidence ≤ 0.5 and `raw_failure_reason`
  is non-null free-text. **RAG (`app/rag.py`) runs first:** embed the case,
  retrieve the nearest already-classified cases from `resolved_cases`
  (pgvector), and prepend them to the prompt as few-shot examples. System
  prompt: classify into the `RootCause` enum; return JSON
  `{"root_cause": <member>, "confidence": <0..1>, "reasoning": <str>}`. On no
  provider / any exception → fall back to `root_cause="unknown"`, confidence
  `0.3`, reasoning notes the fallback. Never raises. The
  `llm_classified_root_cause` payload adds `model` = `llm.model_label(settings)`,
  `rag_examples` = count of retrieved cases, `similar_case_ids` = their ids.
- RAG degrades to a no-op when pgvector is absent (embedded-Postgres fallback)
  or no embeddings backend is configured — Diagnosis then behaves exactly as
  before. Embeddings: `llm.embed()` — OpenAI `text-embedding-3-small`
  (`dimensions=384`) if `OPENAI_API_KEY`, else local `fastembed`
  (`all-MiniLM-L6-v2`, 384-d). OpenRouter has no embeddings endpoint.
- The knowledge base is **curated + bounded**: near-duplicate inserts skipped
  (`rag_dedup_distance`), each `(root_cause, event_type)` bucket capped
  (`rag_bucket_cap`). `pipeline.run` seeds ~20 reference cases on the first run
  and appends confidently-classified batch events after each run. All vector
  search is behind `store.nearest_resolved_cases` — the only ANN lookup in the
  codebase.
- Recovery: the LLM drafts outreach copy only. Plain business English, mirror
  Razorpay's Agent Studio tone (e.g. "Hi, I noticed you left … would you like a
  payment link?"). No ML jargon. Template fallback per intervention when no
  provider. The drafted text goes in the audit `payload`, key `message`.
- Both degrade silently to deterministic behaviour so tests pass offline.

---

## 6. Fraud-cluster signature (Diagnosis triage)

A cluster is ≥ 3 events in `detected`/`diagnosed` that share **all** of:

- identical `raw_failure_reason` (non-null),
- `amount` within a ±₹50 band (max − min ≤ `Decimal("50")`),
- ≥ 3 **distinct** `customer_id`s,
- `max(created_at) − min(created_at) ≤ 60 minutes` (tight time clustering),
- every member `attempts_so_far >= 2` (already retried hard).

The generator backdates the batch over `BATCH_SPAN_DAYS` (14) and places the
seeded cluster inside one `FRAUD_WINDOW_MINUTES` (40) window ~3 days back, so
the full five-part signature is testable and ordinary same-reason events do not
coincidentally cluster.

Match → every member: `update_event(status="flagged", root_cause="suspected_fraud")`
and `log_action(agent="triage", action="halted_fraud_cluster", reasoning=…,
payload={signature})`. Recovery never sees them (it reads only `diagnosed`).
The generator seeds exactly one such cluster as `event_id = fraud_NN`.

`batch_metrics` audit row uses `event_id` of the **first event in the batch**
(FK must resolve) with `agent="audit"`; the metrics live entirely in `payload`.

---

## 7. Audit `payload` shapes

| `action` | `payload` keys |
|---|---|
| `flagged_at_risk` | `{amount_at_risk: str, event_type: str}` |
| `routed_to_exception` (detection) | `{reason: str}` |
| `classified_root_cause` | `{root_cause: str, confidence: float, matched_reason: str \| null}` |
| `llm_classified_root_cause` | `{root_cause: str, confidence: float, model: str, used_fallback: bool}` |
| `halted_fraud_cluster` | `{signature: {raw_failure_reason: str, amount_band: [str,str], customer_count: int, window_minutes: int}, cluster_event_ids: [str]}` |
| `intervention_selected` | `{root_cause: str, intervention: str}` |
| `scheduled_retry` | `{retry_at: str(ISO), attempt: int}` |
| `sent_reauth_link` / `suggested_alternate_method` / `prompted_guided_retry` / `sent_nudge` | `{message: str, channel: "email"\|"sms", contact_at: str(ISO)}` |
| `escalation_stage_advanced` | `{stage: int, stage_name: str, message: str, contact_at: str(ISO)}` |
| `awaiting_human_approval` | `{amount: str, threshold: str, proposed_action: str}` |
| `halted_stopping_rule` | `{rule: str, attempts_so_far: int}` |
| `payment_link_sent` | `{link_id: str, link_url: str, source: "razorpay"\|"fake_gateway"}` |
| `payment_captured` | `{recovered_amount: str, source: "razorpay_webhook"\|"fake_gateway", link_id: str}` |
| `payment_capture_failed` | `{reason: "insufficient_funds"\|"wrong_otp"\|"user_cancelled", source: str, link_id: str}` |
| `marked_recovered` | `{recovered_amount: str, simulated_hours_to_recovery: float}` |
| `routed_to_exception` (recovery) | `{reason: str}` |
| `opened_review_ticket` | `{ticket_id: str, reason: str, priority: int, priority_band: str}` |
| `assigned_review_ticket` | `{ticket_id: str, employee_email: str, reason: str, priority: int}` |
| `resolved_review_ticket` | `{ticket_id: str, employee_email: str, outcome: "resolved"\|"unresolved", reason: str, recovered_amount: str}` |
| `human_recovered` | `{ticket_id: str, employee_email: str, amount: str, event_recovered_total: str, human_recovered_total: str}` |
| `raised_customer_question` | `{ticket_id: str, channel: str, question: str, raised_by: str\|null, priority: int}` |
| `batch_metrics` | the plan.md §7 block — see §8 |

**Deterministic recovery outcome (so the demo is stable):** an event is
`recovered` iff `stable_hash(event_id) % 100 < p` and no stopping rule fired
first. `stable_hash` = `int.from_bytes(hashlib.sha256(event_id.encode()).digest()[:8], "big")`
(NOT builtin `hash()` — that is PYTHONHASHSEED-salted). Otherwise → `exception`
(reason "intervention exhausted, no response").

| root_cause / intervention | success rate `p` | `simulated_hours_to_recovery` |
|---|---|---|
| `insufficient_funds` | 70 | 72 |
| `expired_instrument` | 55 | 36 |
| `bank_downtime` | 75 | 6 |
| `auth_failure` | 60 | 24 |
| `card_declined` | 20 | 48 |
| `checkout_abandoned` | 40 | 24 |
| `invoice_forgotten` | 50 | 48 |

`recovered_amount` on success = full `amount` (no partial recovery in v1).

---

## 8. API response contract (frozen)

See `documentation.md` §5 for the full field tables. `frontend/src/api/fixtures.json`
holds one realistic sample of each. Shapes:

- `GET /api/events` → `{events: EventRead[], count: int}`
- `GET /api/events/{id}/audit` → `{event: EventRead, trail: AuditRead[]}`
- `GET /api/events/{id}/similar` → `{event_id: str, similar: SimilarCase[]}` —
  `SimilarCase = {event_id, event_type, raw_failure_reason, case_text,
  root_cause, source, similarity}` (RAG; `similar` is `[]` when the knowledge
  base / embeddings are unavailable)
- `GET /api/events/{id}/voice/audio` → `{event_id, available: bool, provider,
  audio_format, sample_rate, audio: [{index, speaker, audio_base64}]}` — Sarvam
  AI TTS per dialogue turn; `available:false` + `audio:[]` when `SARVAM_API_KEY`
  is unset or the provider errors (dashboard then uses the browser voice)
- `GET /api/tickets` → `{tickets: TicketRead[], count, open_count,
  under_review_count}` — the human review queue, priority desc then oldest
  first. Optional `?status=open`
- `GET /api/tickets/{id}` → `{ticket: TicketRead, event: EventRead | null,
  trail: AuditRead[]}` — everything a reviewer needs in one call
- `POST /api/tickets/{id}/assign` (body `{employee_email}`) → `{status: "ok",
  ticket: TicketRead}` — 404 unknown, 409 not `open`
- `POST /api/tickets/{id}/resolve` (body `{employee_email, outcome, note,
  recovered_amount?}`) → `{status: "ok", ticket: TicketRead}` — 404 unknown, 409
  on any lifecycle guard (not `under_review`, bad outcome, empty note, amount
  above what is still at risk)
- `POST /api/events/{id}/raise-question` (body `{question, channel?,
  employee_email?}`) → `{status: "ok", ticket: TicketRead}` — 404 unknown
  event, 422 empty question / bad channel
- `POST /api/pipeline/run` → `{metrics: MetricsBlock, ran_at: str}`
- `GET /api/metrics` → `MetricsBlock` (last run, computed from current DB state)

`MetricsBlock`:

```json
{
  "total_at_risk": "199558.65",
  "total_recovered": "84210.00",
  "overall_recovery_rate": 0.42,
  "event_count": 74,
  "by_root_cause": [
    {"root_cause": "insufficient_funds", "at_risk": "...", "recovered": "...",
     "count": 12, "recovered_count": 8, "recovery_rate": 0.67}
  ],
  "by_intervention": [
    {"intervention": "scheduled_retry", "count": 12, "recovered_count": 8,
     "recovery_rate": 0.67, "at_risk": "...", "recovered": "..."}
  ],
  "avg_hours_to_recovery": 31.4,
  "status_breakdown": {"recovered": 30, "exception": 36, "flagged": 4,
                       "detected": 0, "diagnosed": 0, "action_taken": 0},
  "exceptions": [
    {"event_id": "evt_003", "event_type": "failed_payment",
     "amount": "1234.00", "root_cause": "card_declined",
     "reason": "intervention exhausted, no response"}
  ],
  "fraud_cluster": {"flagged_event_ids": ["fraud_00","fraud_01","fraud_02","fraud_03"],
                    "reason": "matching-signature cluster halted for human review"},
  "ai_recovered": "77210.00",
  "human_recovered": "7000.00",
  "tickets": {
    "total": 46, "open": 40, "under_review": 2, "resolved": 3, "unresolved": 1,
    "needs_attention": 42,
    "by_reason": {"suspected_fraud": 4, "customer_question": 1,
                  "awaiting_approval": 4, "exception_no_error": 2,
                  "invoice_handoff": 1, "stalled_no_response": 34, "other": 0},
    "oldest_open_hours": 6.2, "resolution_rate": 0.75, "human_recovered": "7000.00"
  }
}
```

All money fields are decimal strings. Rates are floats 0–1. `exceptions` is the
honest, complete list — never truncated, never cherry-picked. `total_recovered`
is the honest total; `ai_recovered + human_recovered` always equals it —
`ai_recovered` is derived, never independently written.

`TicketRead`:

```json
{
  "ticket_id": "tkt_0004", "event_id": "evt_061",
  "reason": "awaiting_approval", "priority": 76, "status": "resolved",
  "summary": "a bounded discount offer on Rs 7092.97 is above the human-approval gate. Not executed; needs your sign-off.",
  "detail": null,
  "assigned_employee_email": "asha@acme.com",
  "assigned_at": "2026-09-04T18:03:11Z",
  "resolution_note": "Approved the bounded offer within policy; customer completed checkout on the call.",
  "resolution_outcome": "resolved",
  "recovered_amount": "7092.97",
  "created_at": "2026-09-04T17:40:00Z", "updated_at": "2026-09-04T18:05:02Z"
}
```

---

## 9. File boundaries

| Builder | May edit | Must not touch |
|---|---|---|
| detection | `app/agents/detection.py`, `tests/test_detection.py` | everything else |
| diagnosis | `app/agents/diagnosis.py`, `tests/test_diagnosis.py` | " |
| recovery | `app/agents/recovery.py`, `tests/test_recovery.py` | " |
| audit | `app/agents/audit.py`, `tests/test_audit.py` | " |
| payment-engine | `app/agents/payment.py`, `tests/test_payment.py`, the capture branch of `app/webhooks/listener.py`, `app/api/payment_routes.py` (new) | `recovery.py`, `playground.py`, `store.py`, `main.py` wiring beyond mounting its own router |
| simulation-engine | `app/agents/playground.py`, `tests/test_playground.py` | `payment.py`, `recovery.py`, `store.py`, route registration in `routes.py` beyond coordinated request/response field additions |
| frontend | `frontend/src/**` | backend, docs |

No builder edits `store.py`, `pipeline.py`, `main.py`, `app/agents/__init__.py`,
`app/api/*` (except the payment-engine builder's own new router file, mounted
by team-lead), or any `.md` doc. Doc changes are returned as a "docs delta" in
the final report; the team-lead applies them.

`detection.py`, `diagnosis.py`, `recovery.py` each expose
`run(session, *, settings=None) -> list[str]` (event_ids acted on) plus small
pure helpers tests call directly.

`audit.py` exposes **two** entry points: `compute_metrics(session) -> dict`
(the `MetricsBlock`, pure read — this is what `pipeline.py` and the API return)
and `run(session, *, settings=None) -> list[str]` (calls `compute_metrics`,
writes the one `batch_metrics` audit row, returns `[sentinel_event_id]`).

Tests use the `session` fixture from `conftest.py` and auto-skip when Postgres
is down. Anthropic is never called in tests — `diagnosis.claude_classify` and
`recovery._claude_draft` are monkeypatched or hit their no-API-key fallback.

---

## 11. Payment-capture engine (`app/agents/payment.py`) — frozen signatures

**The single integrity fix of this round**: `Event.status` becomes `RECOVERED`
from a capture **only** via `apply_capture` below. Nothing else — not
`recovery.py`'s dispatch logic, not a conversation outcome, not a coin flip —
may ever write `status=RECOVERED`. `recovery.py._resolve_outcome` (team-lead
owns this rewrite) calls into this module instead of its old
`_stable_hash`-driven coin flip.

```python
# backend/app/agents/payment.py

def razorpay_configured(settings: Settings) -> bool:
    """True iff razorpay_key_id AND razorpay_key_secret are both set.
    Necessary but NOT sufficient for the real API to be used -- see
    _should_use_real_razorpay."""

def _should_use_real_razorpay(settings: Settings) -> bool:
    """True only when razorpay_configured(settings) AND the operator has
    explicitly opted in via settings.use_real_razorpay_payment_links (default
    False). Keys being present alone does NOT trigger the real path --
    P9 addendum, added after a live account hit Razorpay's test-mode cap of
    30 payment links per business: once hit, every real call fails with
    429 RATE_LIMIT_EXCEEDED and silently falls back anyway, so
    auto-attempting just because keys exist is a trap, not a feature."""

def create_payment_link(
    session: store.Session, event: Event, *, settings: Settings,
) -> PaymentLinkResult:
    """Real Razorpay test-mode Payment Link (POST /v1/payment_links) when
    _should_use_real_razorpay(settings), else a deterministic fake link/token.
    A Razorpay HTTP failure (timeout, 4xx/5xx, 5s timeout) NEVER raises --
    falls through to the fake path, same posture as llm.py's provider
    fallback. Does not write to the DB itself -- the caller (recovery.py)
    stamps the returned fields via update_event."""
    # PaymentLinkResult = {"link_id": str, "link_url": str,
    #   "status": "created", "source": "razorpay" | "fake_gateway"}

def resolve_fake_capture(
    event: Event, link_id: str, *, settings: Settings, attempt: int = 1,
) -> CaptureResult:
    """PURE function -- no session/DB access, reads only in-memory Event
    fields (amount, root_cause, customer_fake_balance, event_id). Reuses
    recovery.SUCCESS_RATES + recovery._stable_hash (imported, never
    duplicated) for the per-root-cause success roll; deterministic given the
    same inputs -- hash the string f"{event.event_id}:{link_id}:{attempt}",
    NOT just `event.event_id`/`link_id` alone (see P5: without the `attempt`
    salt, a customer who fails once could never succeed on a bounded retry
    with the same link -- a dead-end UX). `event.customer_fake_balance <
    event.amount` forces reason="insufficient_funds" regardless of the
    root-cause roll, on every attempt (a real balance shortfall doesn't
    self-cure by retrying). This purity is a HARD interface contract:
    playground.py calls this directly without a session and must never gain
    one."""
    # CaptureResult = {"captured": bool,
    #   "reason": "captured" | "insufficient_funds" | "wrong_otp" | "user_cancelled",
    #   "amount": Decimal}

def apply_capture(
    session: store.Session, event: Event, capture: CaptureResult, *, source: str,
) -> None:
    """THE ONLY place Event.status ever becomes RECOVERED from a capture.
    On capture.captured=True: update_event(status=RECOVERED,
    recovered_amount=capture["amount"], payment_link_status=CAPTURED,
    payment_capture_source=source); log_action(action="payment_captured",
    reasoning never empty); ptp.evaluate_ptp_status(session, event) so an
    active PROMISED can flip to HONORED immediately.
    On capture.captured=False: payment_link_status=FAILED,
    payment_capture_source=source; log_action(action="payment_capture_failed",
    reasoning=capture["reason"]). Event.status is left untouched on failure --
    the caller (recovery.py or the /pay/:token router) decides
    exception vs. bounded retry."""
```

`source` is always one of `"razorpay_webhook" | "fake_gateway"` (never
`"none"` -- that value is reserved for `payment_capture_source`'s default,
meaning "no capture attempted yet"). `apply_capture` always logs with
`agent=Agent.RECOVERY` regardless of *who* calls it (the webhook listener, the
`/pay/:token` router, or `recovery.py`'s synchronous fake-gateway path) --
money-capture is conceptually a Recovery-agent action no matter which surface
triggered it; the `payload["source"]` distinguishes the trigger.

**Dual-log on the synchronous fake-gateway success path (batch pipeline
only):** `apply_capture` writes `payment_captured` (the truthful "here is the
capture that justifies RECOVERED" row). Immediately after, `recovery.py`
additionally logs the pre-existing `marked_recovered` action with
`simulated_hours_to_recovery` — kept **only** because `audit.compute_metrics`
already reads that specific action/payload key for `avg_hours_to_recovery`.
This is an echo for a metrics reader, not a second status write — `apply_capture`
already set `status=RECOVERED` before `recovery.py`'s echo fires. The real
Razorpay-webhook path does **not** get a `marked_recovered` echo (no
`recovery.py` code runs when a webhook arrives asynchronously, out-of-band from
any pipeline run) — `avg_hours_to_recovery` is documented as "fake-gateway-path
only" in `documentation.md` as a result; noted under §13 as a new resolved
question (P1).

**Webhook wiring** (`app/webhooks/listener.py`, payment-engine builder edits):
on `payment.captured` / `payment_link.paid` (already in `SUCCESS_EVENTS`,
currently ignored), extract the entity via the **same event-name → entity-key
convention `AT_RISK_EVENTS` already uses** (P6): a new
`CAPTURE_EVENTS: dict[str, str] = {"payment.captured": "payment",
"payment_link.paid": "payment_link"}` — i.e. `payment.captured`'s entity lives
under `payload.payment.entity` (Razorpay copies the link's `notes` onto the
resulting payment object too — this is *why* `notes` is set redundantly
alongside `reference_id` at link-creation time, per §11's create-link
paragraph), while `payment_link.paid`'s entity lives under
`payload.payment_link.entity`, matching the existing `payment_link.expired`
mapping's key. From that entity: extract `entity.notes.event_id` (fallback
`entity.reference_id`); no matching event → `{"status": "ignored"}` HTTP 200;
already `payment_link_status=CAPTURED` → ignored (idempotent against webhook
redelivery); otherwise `apply_capture(..., source="razorpay_webhook")`.
Existing signature verification stays first, unchanged.

**`create_payment_link`'s `session` parameter** (P5-adjacent, not a retry
question): kept in the frozen signature for call-site consistency with every
other agent function in this codebase (all take `session` first) and as a
placeholder for a future DB-backed use (e.g. a cross-run idempotency check).
**It is fine for the current implementation to leave it structurally
unused** — do not have `create_payment_link` call `log_action` itself; owning
the audit row stays with the caller (`recovery.py` / the webhook / the
`/pay/:token` router) so `reasoning` matches whichever context actually
triggered link creation, rather than a generic message written blind to the
caller.

**`/pay/:token` router** (`app/api/payment_routes.py`, new, mounted by
team-lead in `main.py`): **no new DB column for the attempt counter** — count
existing `payment_capture_failed` audit rows for the event
(`store.get_audit_trail(session, event_id)`, filtered by `action`) the same
way `recovery.py._cooldown_adjust` already scans the trail for prior
contacts; `attempt = failed_count + 1` feeds `resolve_fake_capture`'s new
`attempt` param directly, so the audit log **is** the attempt-count state,
no new column needed. On the 4th+ attempt (`failed_count >= 3`): **HTTP 409**
(P7) — not 200-with-a-reason-field, not 429 — for consistency with this
codebase's existing convention of using 409 for "guard violation given
current object state" (see the ticket routes' 409s in `documentation.md`
§5), not raw HTTP rate-limit semantics nobody else in this API uses. Body:
`{"status": "error", "reason": "max_attempts_exceeded", "attempts_remaining": 0}`.
`GET /api/pay/{token}` → display data (masked name,
amount, `payment_link_status`); `POST /api/pay/{token}/attempt` →
`resolve_fake_capture(event, token, settings=settings, attempt=failed_count+1)`
then `apply_capture(..., source="fake_gateway")` on success (`apply_capture`'s
own `payment_captured` log row is the only log write on success — the router
does not additionally log); on failure, `apply_capture`'s own
`payment_capture_failed` row **is** the failed-attempt record (does not touch
`Event.status`) and the router returns
`{captured: false, reason: str, attempts_remaining: int}`, bounded to 3
attempts per token (P2: exact "token" identity — resolved as
`payment_link_id` itself, since the fake gateway's `link_id` already doubles
as the URL-safe token).

---

## 12. Playground `sim_state` — frozen shape

Sibling object to the existing `history` list, round-tripped by the frontend
on every `/start` / `/message` / `/advance` / `/pay` call. **Absent on any
call → safe turn-1 defaults**, so every pre-existing test that doesn't pass it
keeps working.

```jsonc
{
  "mode": "custom" | "ai",                 // renamed from interactive|auto
  "controlled_by": {"agent": "ai" | "human", "customer": "ai" | "human"},
  "sim_day": 1,
  "sim_hour": 9,
  "exchanges_today": 0,
  "attempts_so_far": 0,
  "escalation_stage": 0,
  "customer_last_responded_day": 1,
  "customer_response_probability": 0.7,    // adjusted +-0.15/-0.1 per day, clamped [0.1, 0.95]
  "outstanding_asks": [],                  // list[str], keyword-matched customer asks not yet addressed
  "last_reply_text": null,                 // string | null -- anti-repetition for the deterministic fallback
  "capture_attempts": 0,                   // bounded ~3 attempts at click_payment_link, mirrors /pay/:token
  "salary_reminder_day": 0                 // 0 = not scheduled; set to sim_day+5 on an insufficient_funds
                                            // capture failure (sandbox analogue of recovery.SALARY_WINDOW_DAY,
                                            // since sim_day is a relative counter, not a calendar date) (S9)
}
```

`playground.py` exposes (simulation-engine builder; signatures may be refined
in the Phase B0 plan but the `sim_state` shape above and the
`resolve_fake_capture`-only / never-`apply_capture` guarantee are frozen):

```python
def start_session(event, *, mode, channel=None, settings=None) -> dict: ...
def send_message(event, history, message, channel, *, speaker=None, sim_state=None, settings=None) -> dict: ...
def advance_conversation(event, history, channel, *, sim_state=None, settings=None) -> dict: ...
def click_payment_link(event, history, channel="call", *, sim_state=None, settings=None, forced_reason=None) -> dict:
    """Renamed from simulate_payment. A deprecated `simulate_payment` alias
    may be kept (S5 -- see routes.py migration note below). Calls
    payment.resolve_fake_capture(event, link_id, settings=settings,
    attempt=sim_state["capture_attempts"] + 1) -- pure, imported, salted with
    the sim_state attempt counter (P5's fix applies here too: without the
    salt a rehearsal retry would replay the identical failure forever) --
    and renders wrong_otp / insufficient_funds / user_cancelled / success --
    weighted, never an unconditional instant success. `link_id` is a
    playground-owned synthetic id (e.g. `sim_{event.event_id}`, S4 --
    distinct from payment.py's own `fake_`/`plink_` prefixes; never persisted,
    never collides since this module never writes anywhere). Increments
    sim_state["capture_attempts"]. MUST NEVER call payment.apply_capture
    (that writes to the DB and would break the sandboxing guarantee) --
    test_playground.py asserts zero calls to it via a spy/mock.

    Optional `forced_reason: str | None = None` (S9): lets a tester-driven
    fake-checkout screen pick the outcome explicitly ("success" | "wrong_otp"
    | "wrong_password" | "user_cancelled" | "insufficient_funds") instead of
    the random weighted roll. `forced_reason=None` (default) is byte-for-byte
    the behavior above. When set, `resolve_fake_capture` is skipped entirely
    and a CaptureResult-shaped dict is built locally with the same
    paise-rounding convention. `wrong_password` is playground-only -- never
    added to payment.py's CaptureResult reason vocabulary, since that
    module's contract is frozen and shared with the real DB-writing
    `/pay/:token` flow. `insufficient_funds` (forced or rolled) never
    escalates regardless of attempt count -- it instead sets
    `sim_state["salary_reminder_day"] = sim_day + 5` and keeps outcome
    "ongoing"."""
```

**Escalation object** (`outcome="escalated"` responses):

```jsonc
{
  "reason": "customer_requested_human" | "out_of_scope" | "max_attempts_exceeded",
  "outstanding_asks": [],
  "last_customer_message": "...",
  "root_cause": "insufficient_funds",
  "attempts_so_far": 3,
  "conversation_summary": "..."   // LLM one-liner, or a template built from
                                   // outstanding_asks + turn count offline
}
```

`CUSTOMER_RESPONSE_PROBABILITY = 0.7` (module constant, the *initial* value
`sim_state.customer_response_probability` starts from); rolled deterministically
per `(event_id, turn_index)` — reuse `recovery._stable_hash`-style hashing
(import from `recovery.py`, never redefine) so it's reproducible in tests.
`SAME_DAY_EXCHANGE_CAP = 20` — a circuit breaker only, never expected to fire
on a real conversation; the clock advances on a natural pause (silence,
explicit deferral, cadence), never a raw message-count cap.

**`routes.py` migration (S5):** the simulation-engine builder keeps a
deprecated `simulate_payment = click_payment_link` alias and has
`start_session`/etc. accept the legacy `"interactive"|"auto"` mode strings
(mapped internally to `"custom"|"ai"`) so `routes.py` needs **zero**
coordinated changes in Phase B — team-lead migrates `routes.py` to the new
names/shapes as part of Phase C's API-integration pass (not deferred
indefinitely), then the alias can be dropped in the same change once nothing
calls it.

**Human takeover outcome declaration (S6):** when `controlled_by.agent ==
"human"`, `send_message(..., speaker="agent", ...)` accepts an explicit
optional `outcome` param, trusted as-supplied (never inferred from the
human's freeform text) — inferring intent from arbitrary human phrasing is
unreliable and would silently misclassify a human reviewer's own call.

**`_DEFERRAL_PATTERNS` (S7):** the simulation-engine builder defines this
keyword set freely (e.g. "kal", "tomorrow", "baad me", "call me later"),
same latitude already granted to the `outstanding_asks` keyword-pattern map
(S1) — not a frozen vocabulary, team-lead reviews for reasonable coverage at
merge, not for an exact list match.

---

## 13. Resolved contract questions (Phase B0)

| # | Question | Resolution |
|---|---|---|
| D1 | `flagged_at_risk` payload `amount_at_risk` — gross or net? | **Net**: `amount − recovered_amount`, quantised, as a string. |
| D2 | Null `raw_failure_reason` on `failed_payment`/`expired_mandate`? | Detection → `exception`, reason "no failure signal to diagnose". |
| D3 | Non-INR currency? | Detection → `exception`, reason "non-INR currency out of scope for test-mode recovery". |
| D4 | `run()` return — acted-on vs examined? | All examined ids (each gets an audit row). |
| Dg1 | 60-min window on seeded data? | **Kept** — generator now backdates the batch (`BATCH_SPAN_DAYS=14`) and clusters the fraud events in one `FRAUD_WINDOW_MINUTES=40` window. Full five-part signature. |
| Dg2 | `halted_fraud_cluster` payload — is `cluster_event_ids` a sibling of `signature`? | Yes, sibling key (as written in §7). |
| Dg3 | `payment_cancelled` mapping? | `checkout_abandoned` @ 0.7 confidence; no Claude call. |
| Dg4 | Claude-fallback path status? | Still `diagnosed` (only triage produces `flagged`). |
| R1 | `suspected_fraud` seen in `diagnosed` (data bug)? | Recovery sets `status="flagged"` and logs `agent="recovery", action="halted_stopping_rule", payload={"rule":"suspected_fraud_refusal"}`. Never runs an intervention. |
| R2 | Approval-gate path status flow? | `diagnosed → action_taken → exception` (money action logged as `awaiting_human_approval`, not executed). Audit derives the exception `reason` from the `awaiting_human_approval` payload (`proposed_action` + `threshold`). |
| R7 | Escalation stage 3 (human handoff) terminal status? | `exception`, reason "escalated to human handoff, automated recovery stops" — a human now owns it and automation must not proceed. Confirmed. |
| R3 | `card_declined` one retry — can it recover? | Yes, honour the deterministic outcome (`p = 20`) after the single cautious retry. |
| R4 | Escalation-stage counter source? | `event.attempts_so_far`; Recovery bumps it per `escalation_stage_advanced`. |
| R5 | Cooldown detection scope? | Scan `get_audit_trail` for prior `contact_at`/`retry_at` on the same `customer_id` within this run. Cooldown only delays `contact_at`, never causes an exception. |
| R6 | `simulated_hours_to_recovery` per cause? | Fixed values, table in §7. |
| A1 | Audit `run()` return type vs the uniform contract? | Split into `compute_metrics()` + `run()` — see §9. |
| A2 | `overall_recovery_rate` basis? | Money-based: `total_recovered / total_at_risk`. Per-group rates stay count-based. |
| A3 | `batch_metrics` `event_id`? | `all_events(session)[0].event_id` (earliest `created_at`). |
| A4 | Re-run behaviour? | Appends a fresh `batch_metrics` row each run — tolerated for v1. |
| A5 | Include `suspected_fraud` / `unknown` in `by_root_cause` at 0 recovered? | Yes. |
| F1 | `GET /api/metrics` shape vs `pipelineRun.metrics`? | Identical `MetricsBlock` (fixture will be regenerated in Phase C so both samples match). |
| F2 | ₹ recovered by intervention? | Added `at_risk` + `recovered` (decimal strings) to `by_intervention[]` — Audit computes them. |
| F3 | Single-event endpoint? | No — `GET /api/events/{id}/audit` returns `{event, trail}`; the queue uses the list. |
| F4 | `avg_hours_to_recovery` unit? | Hours. |
| F5 | Pagination on `GET /api/events`? | No — full list (batch is ~74 rows). |
| P1 | `avg_hours_to_recovery` when a real Razorpay webhook (not the fake gateway) confirms capture? | Not included — no `marked_recovered` echo fires on the async webhook path (see §11 "dual-log" note). Documented as a fake-gateway-path-only metric until a future round adds a capture-timestamp-based calc for both paths. |
| P2 | `/pay/:token` token identity? | The token **is** `payment_link_id` (fake gateway's own `fake_...` id) — no separate token table/column needed. |
| P3 | Does `apply_capture`'s failed-capture path set `Event.status`? | No — leaves it untouched; `recovery.py` (batch) sets `EXCEPTION`, the `/pay/:token` router leaves it for a bounded retry (~3 attempts), by design (§2/§11). |
| P4 | Razorpay-configured but the create-link HTTP call fails (timeout/4xx/5xx)? | Falls through to the fake-gateway path silently, same posture as `llm.py`'s provider fallback — `source="fake_gateway"` in that run even though keys were configured. |
| P9 | Should `create_payment_link` attempt the real API automatically whenever both Razorpay keys are configured? | **No, changed post-launch.** A live demo account hit Razorpay's test-mode cap of 30 payment links per business; every subsequent real call failed with `429 RATE_LIMIT_EXCEEDED` and silently fell back to the fake gateway anyway, making the "hybrid" behavior invisible/confusing. Added `settings.use_real_razorpay_payment_links` (default `False`) and `_should_use_real_razorpay(settings) = razorpay_configured(settings) and use_real_razorpay_payment_links`. The fake gateway is now the default even with valid keys present; the real API is opt-in only. |
| S1 | `outstanding_asks` matching — exact keyword list? | Left to the simulation-engine builder's plan (Phase B0) to propose; team-lead reviews for coverage of the plan's named examples (GST invoice, WhatsApp/email resend) before approval. |
| S2 | Does `click_payment_link` ever need a `session` param for future real-DB writes? | No — frozen as pure/stateless per §12; any future "commit a rehearsal outcome to the real store" feature is an explicit, separate, human-gated action outside this module, not an implicit side effect here. |
| S3 | `sim_state` versioning — what happens to an old frontend session dict missing new keys mid-migration? | Every new key has a documented default (§12); `playground.py` fills missing keys rather than requiring the full shape, so a partially-old `sim_state` degrades gracefully instead of erroring. |
| P5 | `resolve_fake_capture` is deterministic per `(event_id, link_id)` — doesn't a `/pay/:token` retry with the same token replay the identical failure forever? | **Yes, this was a real dead-end bug in the frozen draft — fixed.** Added an `attempt: int = 1` param; the hash salts on `f"{event.event_id}:{link_id}:{attempt}"`, not just `event_id`/`link_id`. `customer_fake_balance < amount` still forces `insufficient_funds` on every attempt (a real shortfall doesn't self-cure). `/pay/:token`'s attempt number = count of prior `payment_capture_failed` audit rows + 1 (no new column); Playground's attempt number = `sim_state["capture_attempts"] + 1`. |
| P6 | `_entity(event, "payment_link")` key for `payment_link.paid` — consistent with `payment_link.expired`'s existing shape? | Yes, confirmed — new `CAPTURE_EVENTS` map: `payment.captured` → entity key `"payment"`, `payment_link.paid` → entity key `"payment_link"` (matches `AT_RISK_EVENTS`' existing convention). Razorpay copies a link's `notes` onto the resulting payment object too, so `payment.captured`'s `entity.notes.event_id` is reliable even though it's a different entity than the link itself. |
| P7 | `/pay/:token/attempt` on the 4th+ attempt — 200 with a reason field, or 429? | **409** — matches this codebase's existing convention (ticket routes) of 409 for "guard violation given current object state," not a raw HTTP rate-limit code introduced nowhere else in this API. |
| P8 | `create_payment_link`'s `session` param — used anywhere in the body? | Currently structurally unused by design — kept for call-site consistency with every other agent function (`session` first) and as a placeholder for a future DB-backed use. `create_payment_link` must NOT call `log_action` itself; the caller owns that audit row so `reasoning` matches its actual triggering context. |
| S4 | Playground's own synthetic `link_id` for `resolve_fake_capture` calls — collision risk with `payment.py`'s `fake_`/`plink_` prefixes? | No — use a distinct prefix (e.g. `sim_{event_id}`); never persisted anywhere (this module never writes to the DB), so there is no namespace to collide in. |
| S5 | `routes.py` still calls `simulate_payment` with legacy `"interactive"\|"auto"` mode strings — coordinate a `routes.py` change now, or alias? | Alias approved: keep a deprecated `simulate_payment = click_payment_link` and accept legacy mode strings (mapped internally to `"custom"\|"ai"`) so Phase B needs zero `routes.py` coordination. Team-lead migrates `routes.py` to the new names in Phase C's API-integration pass, then drops the alias in the same change. |
| S6 | When a human takes over as the Resolver, how is the conversation outcome declared? | An explicit optional `outcome` param on `send_message` when `speaker="agent"`, trusted as-supplied, never inferred from the human's freeform text — inferring intent from arbitrary human phrasing is unreliable. |
| S7 | Is `_DEFERRAL_PATTERNS` (e.g. "kal", "tomorrow") part of the frozen contract? | No — same latitude as the `outstanding_asks` keyword map (S1): the builder defines it freely; team-lead reviews for reasonable coverage at merge, not an exact-list match. |
| S9 | Embedded fake-checkout screen needs a tester-forced payment outcome (success/wrong OTP/wrong password/cancelled/insufficient funds) instead of a random roll — how, without breaking S2's pure/stateless guarantee or payment.py's frozen `CaptureResult` vocabulary? | Added `click_payment_link(..., forced_reason: str | None = None)` — no new param on `payment.resolve_fake_capture`, no `session` anywhere. `forced_reason=None` (default) is unchanged; when set, `resolve_fake_capture` is skipped and a `CaptureResult`-shaped dict is built locally in `playground.py` with the same `_q`/`MONEY` paise-rounding convention. `wrong_password` is a playground-only reason (login/credentials failure before the OTP step) — deliberately **not** added to `payment.py`, since that module's `CaptureResult` vocabulary (`captured`/`insufficient_funds`/`wrong_otp`/`user_cancelled`) is frozen and shared with the real DB-writing `/pay/:token` flow; a fifth reason there would ripple into `apply_capture`'s payload shape and the real webhook path for no real-flow benefit. Also carved out: `insufficient_funds` (forced or randomly rolled) never escalates on attempt-count, unlike every other failure reason — it schedules `sim_state["salary_reminder_day"] = sim_day + 5` instead and stays "ongoing". `sim_day` is only a relative rehearsal counter, not a calendar date, so `+5` is a bounded, deterministic sandbox approximation of `recovery.SALARY_WINDOW_DAY`, not a claim of calendar accuracy. |
