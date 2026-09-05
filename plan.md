# CLAUDE.md — Project Brief for Claude Code

This file is the single source of truth for this project. Read it fully before writing code.

---

## 0. ALWAYS CHECK THESE LINKS FIRST

> **Automated as a skill:** invoke the `build-workflow` skill before planning or
> building anything, and again before finalizing any agent logic, outreach copy,
> metrics, README, architecture doc, or pitch. Its Step 1 carries this link list
> and the "how to use the sources" steps.

Before starting any work session, and again before finalizing any agent's logic, copy, or the README/pitch — open these. This project is judged by Razorpay engineers on how well it reflects Razorpay's actual product and language, not generic fintech assumptions. Re-checking these regularly is cheap insurance against drifting into generic-hackathon territory.

| Source | Link | Why it matters |
|---|---|---|
| **Buildathon program page** | https://razorpay.com/buildathon/ | Source of truth for tracks, "the bar," and submission requirements — re-read the exact wording before finalizing anything |
| **Razorpay main website** | https://razorpay.com/ | General product surface, positioning, current messaging |
| **Razorpay Developer Docs** | https://razorpay.com/docs/ | API correctness — payment links, subscriptions, webhooks, test mode |
| **Test Mode / test card & UPI details** | https://razorpay.com/docs/payments/payments/test-card-upi-details/ | Exact test credentials and simulated failure scenarios to build against |
| **Webhooks docs** | https://razorpay.com/docs/webhooks/ | Real event types/payloads (`payment.failed`, `subscription.charged`, etc.) |
| **Payment Links API** | https://razorpay.com/docs/payments/payment-links/ | For simulating/triggering payment events |
| **Subscriptions API** | https://razorpay.com/docs/payments/subscriptions/ | Relevant to the "failed-subscription recovery" direction |
| **Agent Studio + Agentic Experience Platform launch (Newsroom)** | https://razorpay.com/newsroom/razorpay-launches-the-worlds-first-ai-native-agent-studio-for-payments-at-ftx26-powered-by-anthropics-claude/ | **Most important non-docs link.** Describes Razorpay's own production agents (Abandoned Cart Conversion Agent, Dispute Responder Agent, Subscription Recovery Agent) — mirror their naming/tone |
| **Razorpay Newsroom (general)** | https://razorpay.com/newsroom/ | Latest official announcements — check for anything published after this file was written |
| **FTX'26 event hub** | https://razorpay.com/ftx26/ | Context on Razorpay's agentic commerce direction, partners, positioning |
| **Razorpay Sprint 2026 product blueprint** | https://razorpay.com/sprint/26 | Real examples: RTO/return-risk-by-pincode scoring, dispute agents — good stretch-feature inspiration |
| **Razorpay LinkedIn company page** | https://www.linkedin.com/company/razorpay/ | Latest company posts, product announcements, hiring/culture signals — *verify this URL resolves before relying on it, LinkedIn company handles occasionally change* |
| **Razorpay GitHub org (SDKs, sample code)** | https://github.com/razorpay | Official Python SDK and integration examples — check for the current recommended SDK version/usage pattern |
| **Razorpay X (Twitter)** | https://twitter.com/Razorpay | Fastest-moving source for very recent announcements |

**Rule of thumb:** if you're about to invent a detail (a failure code, an API field name, an agent name, a metric Razorpay already reports publicly), stop and check the docs/newsroom links above first. Anything that can be verified against a real Razorpay source should be.

---

## 1. What this project is

We're building a submission for the **Razorpay AI Buildathon** (a student hiring program — build a working prototype, get evaluated on a public GitHub repo + 5-min pitch video + architecture writeup + panel interview, no resume screen).

**Track chosen: AI Revenue Recovery.**

> Build an agent that detects revenue at risk, determines the right intervention, and executes a bounded recovery workflow — from payment failures and checkout abandonment to overdue receivables.

**The bar we're graded against (verbatim from the brief):**
> Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail.

### Official problem statement — Track 03: AI Revenue Recovery (verbatim, from razorpay.com/buildathon/)

> **Find revenue that's slipping away and win it back**
>
> Build an agent that detects revenue at risk, determines the right intervention, and executes a bounded recovery workflow: from payment failures and checkout abandonment to overdue receivables.
>
> **Why now:** Revenue loss rarely happens in one clean step. A payment degrades, a checkout gets abandoned, a subscription fails, or an invoice goes overdue. AI can now close the loop from detecting the problem to diagnosing it, choosing the right intervention, and recovering the money.
>
> **Example directions:**
> - Payment degradation → root cause → recovery action
> - Checkout drop-off recovery
> - Failed-subscription recovery
> - B2B receivables chaser
> - Mandate retry sequencer
> - Hinglish voice recovery
> - Promise-to-pay tracker
>
> **The bar:** Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail.

Our project sits squarely in the first example direction ("Payment degradation → root cause → recovery action") with elements of "B2B receivables chaser" (the escalation ladder + stopping rules) and a plausible stretch into "Mandate retry sequencer" if time allows. **Always re-verify this text against the live buildathon page before submission** in case wording is updated.

**Deadline: September 5.** Today is August 27. Target: fully built and demo-ready by **September 3**, leaving Sep 4 for the pitch video and Sep 5 for submission. Treat Sep 3 as a hard feature freeze.

---

## 2. Why this approach (don't build a generic retry bot)

Most entrants in this track will build a single generic "payment failed → send a nudge" retry loop applied identically to every case. That is explicitly NOT what wins here. The differentiator is:

**Root-cause-differentiated recovery.** A failed payment can happen for very different reasons, and each deserves a different intervention:

| Root cause | Right intervention |
|---|---|
| Insufficient funds | Wait + retry near a likely salary-credit window (not immediately) |
| Expired mandate / card | Send a re-authorization link, don't just retry the old charge |
| Bank/network downtime | Suggest an alternate payment method |
| OTP/auth failure | Prompt for a fresh, guided retry |
| Abandoned checkout (mid-flow) | Personalized nudge, possibly a small bounded discount |
| Overdue B2B invoice | Escalation ladder: friendly reminder → formal notice → human handoff (never further) |
| Repeated failures across a cluster of accounts (looks like fraud/abuse, not a genuine recoverable failure) | HALT recovery, flag for human review — do not keep retrying |

That last row is intentional: it's our planned "one failure handled gracefully" moment for the demo (see Section 6).

---

## 3. System architecture — 4 agents + a shared store

```
                     ┌─────────────────────┐
  synthetic events ─▶│  Detection Agent     │  flags at-risk revenue, writes to event store
  (+ optional real   └──────────┬──────────┘
   Razorpay test-mode           │
   webhooks)                    ▼
                     ┌─────────────────────┐
                     │  Diagnosis Agent     │  classifies root cause (rules-first, LLM for
                     └──────────┬──────────┘  ambiguous/free-text cases), includes the
                                │             "is this actually fraud, not a genuine
                                ▼              failure?" triage check
                     ┌─────────────────────┐
                     │  Recovery Agent      │  routes to root-cause-specific intervention,
                     └──────────┬──────────┘  drafts outreach copy, enforces stopping rules
                                │
                                ▼
                     ┌─────────────────────┐
                     │  Audit/Reporting     │  every decision logged; computes ₹ recovered,
                     │  Agent               │  recovery rate by cause, honest exception list
                     └─────────────────────┘

     All four agents read/write through one shared PostgreSQL event store
     (backend/app/db/store.py) — this IS the audit trail.
```

**Every agent action must be written to the `audit_log` table before/as it acts.** No action happens silently. This is non-negotiable — it's literally what "the bar" asks for.

---

## 4. Tech stack (decided, don't relitigate)

- **Python backend + React frontend.** No Go. The backend needs agent reasoning
  quality and clean architecture, not concurrency/throughput; a polyglot split
  would burn build-time on plumbing with no judging payoff.
- `FastAPI` — backend API + optional webhook listener for real Razorpay test-mode events
- **PostgreSQL** — event store + audit log (see schema below). Run as a local
  process via `scripts/pg.ps1` (Docker needs WSL2, unavailable on this Win 11
  Home box). Accessed with `psycopg`/SQLAlchemy.
- `pandas` — synthetic data generation, metrics rollups
- `anthropic` Python SDK — Diagnosis Agent reasoning on ambiguous cases + Recovery Agent message drafting
- `razorpay` Python SDK — test-mode payment link / subscription / webhook integration
- **React** (Vite) — dashboard frontend, talking to the FastAPI backend. Streamlit dropped.
- `uv` — Python dependency + venv management (not `pip`/`requirements.txt`)
- `python-dotenv` — env var loading
- `faker` — synthetic customer data
- `pytest` — sanity tests, so the live demo doesn't break

Repo is a monorepo: FastAPI **backend/** + React **frontend/**. See
`documentation.md` §2 for the authoritative tree.

> The `agents/store.py` reference below is superseded by
> `backend/app/db/store.py`. Table/column definitions still apply.

**Payments: Razorpay TEST MODE only.** No real money, ever. Test API keys (`rzp_test_...`), test cards, test UPI VPAs, test webhook events. This is explicit in the brief ("Razorpay test-mode APIs").

---

## 5. Data model (PostgreSQL)

### `events` table
| column | notes |
|---|---|
| `event_id` | PK |
| `event_type` | `failed_payment` \| `abandoned_checkout` \| `overdue_invoice` \| `expired_mandate` |
| `customer_id` | |
| `amount`, `currency` | |
| `raw_failure_reason` | whatever the gateway/synthetic generator gave us, pre-diagnosis |
| `attempts_so_far` | int, used for stopping-rule enforcement |
| `days_overdue` | int, relevant for B2B invoices |
| `created_at`, `updated_at` | |
| `status` | `detected` → `diagnosed` → `action_taken` → `recovered` \| `exception` \| `flagged` |
| `root_cause` | filled by Diagnosis Agent |
| `diagnosis_confidence` | float 0–1 |
| `recovered_amount` | float, 0 until recovered |
| `payment_link_id`, `payment_link_url`, `payment_link_status`, `payment_link_sent_at`, `payment_capture_source`, `customer_fake_balance` | the unified payment-capture engine (`app/agents/payment.py`, 2026-09-05) — `recovered_amount`/`status="recovered"` are set ONLY when `payment_link_status` reaches `captured`, via `apply_capture`. See §12 below and `AGENTS_CONTRACT.md` §11. |

### `audit_log` table
| column | notes |
|---|---|
| `id` | PK autoincrement |
| `event_id` | FK |
| `agent` | `detection` \| `diagnosis` \| `recovery` \| `triage` |
| `action` | e.g. `classified_root_cause`, `sent_reminder`, `halted_stopping_rule` |
| `reasoning` | human-readable justification — this is what we show the panel |
| `payload` | JSON blob (e.g. drafted message text, or decision metrics) |
| `timestamp` | |

---

## 6. Stopping rules & guardrails (must be explicit and visible, not implicit)

- **Max retry attempts per case** — e.g. 3, then auto-flag for human review.
- **Max escalation stages** for overdue invoices — e.g. reminder → formal notice → human handoff. Never auto-escalate further (no auto-legal-action, no auto-account-suspension).
- **Cooldown windows** between contacts — don't spam a customer.
- **Amount threshold for human approval** — any discount offer or aggressive escalation above a set ₹ amount requires human sign-off before executing (simulate this as a flag in the audit log, not a UI, if time is short).
- **The fraud-pattern triage halt** — if a case shows signs of being part of a cluster (same failure reason, same amount pattern, tight time clustering across multiple "customers"), the Diagnosis Agent must reclassify it as `flagged` instead of `recoverable`, and the Recovery Agent must refuse to act on it. Log the reasoning clearly. **This is our deliberate "one failure handled gracefully" demo moment** — build a synthetic case that triggers this, and make sure the demo shows the system catching its own initial misclassification and correcting course.

> **2026-09-04 — built past "not a UI, if time is short":** the "auto-flag for
> human review" line above and the approval-threshold flag are now a real,
> bounded workflow — `app/agents/triage.py` + the `/attention` dashboard page.
> See §12.

---

## 7. Synthetic dataset requirements

Generate 50–100 synthetic events (`data/generate_synthetic_data.py`, output to `data/synthetic_events.csv` or directly seeded into the DB) with realistic variety:
- Mix of all four `event_type`s
- Mix of root causes represented in `raw_failure_reason` (insufficient funds, bank downtime, expired mandate, OTP failure, generic abandonment, forgotten invoice)
- A deliberate small cluster (3–5 events) with matching failure signatures designed to trigger the fraud-pattern triage halt described above
- A realistic spread of amounts (₹200 to ₹50,000) and days_overdue (0–90) for B2B cases
- Use `faker` for customer_id/names to keep it realistic without real PII

**Metrics to compute and display at the end of every pipeline run:**
- Total ₹ at risk in the batch
- ₹ recovered, broken down by root cause
- Recovery rate (%) by intervention type
- Average time-to-recovery (simulated)
- **Exception list**: every case NOT recovered, with the stated reason why — do not hide or minimize this list, it's explicitly what the judging bar asks for ("honest exception list", "don't cherry-pick")

---

## 8. Repo structure to build

> **Superseded.** The tree below is the original single-package Streamlit plan.
> The live layout is the FastAPI `backend/` + React `frontend/` monorepo in
> `documentation.md` §2. Kept here only for the agent/file naming intent.

```
/data
    generate_synthetic_data.py
    synthetic_events.csv          (generated, gitignored if large)
    events.db                     (gitignored)
/agents
    store.py                      (shared SQLite event store — build this FIRST, everything depends on it)
    detection.py
    diagnosis.py
    recovery.py
    audit.py
/webhooks
    listener.py                   (FastAPI app, Razorpay test-mode webhook endpoint — optional/stretch)
/dashboard
    app.py                        (Streamlit dashboard)
/docs
    architecture.md                (diagram + explanation, for submission)
    README.md
run_pipeline.py                    (single entrypoint: loads synthetic batch, runs all 4 agents, prints/report metrics)
requirements.txt
.env.example
.gitignore
tests/
    test_store.py
    test_diagnosis.py
```

---

## 9. Build order (follow this sequence)

1. `backend/app/db/store.py` — the shared PostgreSQL event store. Everything else depends on this schema. Build and test this first.
2. `data/generate_synthetic_data.py` — produces the batch, seeds the DB via `store.py`.
3. `agents/detection.py` — reads synthetic batch (and later, optionally, real webhook events), marks events `detected`.
4. `agents/diagnosis.py` — rules-based root-cause classification first (fast, deterministic, easy to demo/explain), fall back to a Claude API call for ambiguous free-text `raw_failure_reason` values. Include the fraud-cluster triage check here.
5. `agents/recovery.py` — routes each diagnosed event to its intervention, drafts message copy via Claude, enforces all stopping rules from Section 6, updates status to `recovered` / `exception` / `flagged`.
6. `agents/audit.py` — aggregates `audit_log` + `events` into the metrics from Section 7.
7. `run_pipeline.py` — wires 3–6 together as one runnable script producing a clean printed/markdown summary.
8. React dashboard (`frontend/`) — visualizes the pipeline output served by the FastAPI backend (at-risk queue, per-case decision trail, recovery charts, exception list).
9. `webhooks/listener.py` — only if time allows; wires real Razorpay test-mode webhooks into `detection.py` instead of pure synthetic replay.
10. `docs/architecture.md` + `README.md` — write last, once the system is stable, including a section titled "What broke and how we fixed it" (this is explicitly requested by the buildathon submission process).

**If short on time, cut in this order (never cut the core 4 agents, stopping rules, or audit trail):**
1. React dashboard → fall back to a clean printed/markdown report from `run_pipeline.py`
2. Real Razorpay webhook wiring → fall back to pure synthetic batch replay
3. Claude-drafted outreach copy → fall back to templated text

---

## 10. Non-negotiables (these are literally the judging criteria)

- Every money-related agent action must be **explainable** (has a `reasoning` string in the audit log), **bounded** (respects a stopping rule or threshold), and **gated** (human-approval flag above a set amount).
- Metrics must be **honest** — computed from the full batch, exceptions included, never cherry-picked.
- The demo must include **one real handled failure** — use the fraud-cluster triage halt from Section 6 as this moment.
- Test mode only. No real money at any point.
- Public GitHub repo, clean README, architecture diagram, setup instructions a stranger could follow, and a "what broke and how we fixed it" writeup.

---

## 11. Reference sources — read these before building, and re-check them mid-build

This project is being built *for* Razorpay, evaluated *by* Razorpay engineers, on top of Razorpay's own product surface. Optimizing for their needs means our design choices, terminology, and even our dashboard's visual language should echo what they've already shipped — not read like a generic fintech side project. Treat the links below as required reading, not optional context.

### Buildathon program (source of truth for the actual ask)
- **Buildathon site (tracks, "the bar," submission requirements):** https://razorpay.com/buildathon/
  - Re-read the exact wording of the AI Revenue Recovery track and "the bar" before finalizing metrics/report — match their language in the README and pitch (e.g. use their phrase "audit trail," "stopping rules," "measured money recovered" verbatim where natural).

### Razorpay API / test-mode docs (source of truth for integration correctness)
- **Main developer docs:** https://razorpay.com/docs/
- **Test mode / test card & UPI details:** https://razorpay.com/docs/payments/payments/test-card-upi-details/
- **Payment Links API:** https://razorpay.com/docs/payments/payment-links/
- **Subscriptions API (relevant for "failed-subscription recovery" direction):** https://razorpay.com/docs/payments/subscriptions/
- **Webhooks (payloads, event types like `payment.failed`, `subscription.charged`):** https://razorpay.com/docs/webhooks/
- **Python SDK reference:** https://razorpay.com/docs/api/ (check current SDK repo on GitHub too — `razorpay/razorpay-python`)
  - Use these to make sure our synthetic `raw_failure_reason` values and event schema mirror Razorpay's *real* failure codes/error descriptions, not made-up ones — this is an easy, high-signal way to show we understood their actual system.

### Razorpay's own AI agent products (source of truth for "what good looks like" to this panel)
- **Agent Studio + Agentic Experience Platform launch (FTX'26, built on Claude Agent SDK):** https://razorpay.com/newsroom/razorpay-launches-the-worlds-first-ai-native-agent-studio-for-payments-at-ftx26-powered-by-anthropics-claude/
  - This is critical: Razorpay already ships an **Abandoned Cart Conversion Agent**, a **Dispute Responder Agent**, and a **Subscription Recovery Agent** (built with ElevenLabs). Our project should be positioned explicitly as complementary to / inspired by this suite, using consistent naming conventions (e.g. call our agents things like "Recovery Agent," "Diagnosis Agent" the same deliberate, plain-English way Razorpay names theirs — not generic ML jargon).
- **FTX'26 event hub (context on Razorpay's agentic commerce direction, partners, positioning):** https://razorpay.com/ftx26/
- **Razorpay Sprint 2026 product blueprint (RTO/return-risk scoring, dispute agents, AI-native payments messaging):** https://razorpay.com/sprint/26
  - Note the RTO/return-pattern-by-pincode language here — if there's time for a stretch feature, echoing this exact kind of segmented risk analysis (by pincode/product/customer) in our exception list or metrics would directly mirror something they've already built and validated as valuable.

### Ecosystem context (for accurate, credible framing — not to over-engineer against)
- **NPCI UAP context (agentic UPI, consent + spending-limit pattern):** referenced in prior research this session — search "NPCI Unified Agent Protocol UPI 2026" for latest if citing in the pitch. Use this only to correctly frame *why now* (mirrors the brief's own "why now" language) — do not attempt to integrate real UAP infra.

### How to use these sources while building
1. **Before writing `agents/diagnosis.py`'s rules-based classifier:** pull real failure/error codes from the Razorpay docs (test-mode section) so root-cause categories map to actual gateway language, not invented ones.
2. **Before writing `agents/recovery.py`'s intervention copy:** skim the Agent Studio launch page again and consciously echo their tone/framing (plain business English, not ML-speak) in any Claude-drafted messages.
3. **Before finalizing `docs/README.md` and the pitch script:** re-read the buildathon page's exact "the bar" text and make sure every sentence of our submission can be mapped back to a specific phrase in it (explainable, bounded, gated; measured money recovered; compliant escalation; stopping rules; audit trail; honest exception list).
4. **If time allows a stretch feature:** pull one idea directly from Razorpay Sprint 2026 (e.g. pincode-level return-risk segmentation) and adapt it into the Revenue Recovery context — this signals we did real homework on their product, not just the brief.

---

## 12. Current status

**Live status lives in [documentation.md](documentation.md) §13** (build table) and
[architecture.md](architecture.md) §2 (pipeline diagram). Summary as of
2026-08-28:

- **Done:** Section 9 step 1 (`backend/app/db/store.py` — shared event store) and
  step 2 (`backend/app/data/generate.py` — synthetic batch + fraud cluster).
- **Done (steps 3–8) via a Claude Code agent team** (team-lead + 5 stage
  builders): all four agents built and merged — `agents/detection.py` (3),
  `agents/diagnosis.py` + fraud triage (4), `agents/recovery.py` + stopping
  rules (5), `agents/audit.py` metrics (6); `app/pipeline.py` chaining them (7);
  `app/api/*` routers to the frozen contract mounted in `main.py` and a React
  dashboard (`frontend/src/pages/*`) against a real-run `fixtures.json` (8).
  `AGENTS_CONTRACT.md` (+ §10 Q&A resolutions) is the frozen cross-agent
  contract. 113 backend tests green.
- **Also done (2026-09-04):** multi-provider LLM client (`app/llm.py` —
  Anthropic / OpenRouter / OpenAI); RAG knowledge base (`app/rag.py`, pgvector
  HNSW) wired into Diagnosis + a "similar past cases" dashboard panel; Postgres
  moved to the `pgvector/pgvector` Docker container; **step 9** — Razorpay
  test-mode webhook listener (`app/webhooks/listener.py`, `POST
  /webhooks/razorpay`, HMAC-SHA256 verified). 146 backend tests green.
- **§9 build order: steps 1–10 all done.** Only remaining work is the pitch
  video and an optional browser pass of the new dashboard panels on live API.
- **Failure-code correction (2026-09-03):** §5 / §7 name `raw_failure_reason`
  values illustratively. Verified against
  `razorpay.com/docs/payments/payments/test-card-details`, the generator now
  uses Razorpay's real test-mode failed-card-payment codes: `insufficient_fund`
  (not `insufficient_funds`), `authentication_failed` (not `incorrect_otp`),
  `payment_timed_out`, `card_number_invalid`, plus retained `card_expired`,
  `card_declined`, `bank_not_available`, `gateway_technical_error`. Root-cause
  mapping is in `AGENTS_CONTRACT.md` §2.
- **Event time spread (2026-09-03):** `EventCreate` gained an optional
  `created_at`; the generator backdates the synthetic batch over 14 days and
  places the fraud cluster inside one 40-minute window, so the Diagnosis
  fraud-cluster signature can keep its "tight time clustering" (≤ 60 min)
  clause. `insert_event` honours a supplied `created_at` (and matches
  `updated_at` to it).
- **RAG knowledge base (2026-09-04):** §4 didn't anticipate retrieval. Added
  `app/rag.py` — a `resolved_cases` pgvector table (HNSW index) the Diagnosis
  Agent retrieves from before the LLM classifies an unrecognised free-text
  failure reason ("here's how similar past failures were diagnosed"). The KB is
  **curated + bounded**: near-duplicate inserts skipped, each
  `(root_cause, event_type)` bucket capped. All vector search is behind one
  function (`store.nearest_resolved_cases`) so it lifts to a dedicated store
  later. Embeddings via `llm.embed()` — OpenAI `text-embedding-3-small` if a key
  is set, else local `fastembed` (`all-MiniLM-L6-v2`, 384-d), else RAG is a
  no-op and Diagnosis is unchanged. NOT using LangGraph. LangChain only for the
  `Embeddings` wrapper. Deps: `pgvector`, `fastembed`, `numpy`, `langchain-core`.
- **Docker is available after all (2026-09-04):** earlier docs said Docker
  needs WSL2 and is unavailable here — **wrong**. Docker Desktop is installed
  and WSL2 works. Postgres now runs as the `pgvector/pgvector:pg17` container
  (`docker compose up -d`) so pgvector is native. `scripts/pg.ps1` (embedded
  binary) is kept as a no-extension fallback — RAG is disabled on that path.
- **Provider-agnostic LLM (2026-09-04):** §4 pins the `anthropic` SDK. The LLM
  is now behind `app/llm.py`, which also supports **OpenRouter** and **OpenAI**
  (OpenAI-compatible REST). Auto-detects `anthropic → openrouter → openai`;
  OpenRouter's default model is a Claude model, so the "built on Claude" framing
  holds. Both call-sites (Diagnosis free-text fallback, Recovery outreach) still
  degrade to deterministic behaviour with no key. Added `httpx` to runtime deps.
- **Deterministic recovery outcome (2026-09-04):** whether a recovery attempt
  succeeds is decided by `sha256(event_id) % 100 < p` against a per-intervention
  success rate, not an RNG — repeatable demo + tests. `AGENTS_CONTRACT.md` §7.
- **Urgent human attention / review tickets (2026-09-04):** §6 already asks for
  "auto-flag for human review" and an approval-threshold flag "simulated ... not
  a UI, if time is short" — this builds the not-short-on-time version. New
  `tickets` table (FK to `events`) + `app/agents/triage.py`, wired into
  `pipeline.py` between Recovery and Audit. Every `flagged`/`exception` event
  the automation could not carry further gets exactly one priority-scored
  ticket (`suspected_fraud` ≫ `customer_question` ≫ `awaiting_approval` ≫
  `exception_no_error` ≫ `invoice_handoff` ≫ `stalled_no_response`); idempotent,
  never reopens closed work. **Design call on "tried 3×, no response":** this is
  not an automation failure — Recovery's stopping rules did their job — but it
  is still lost revenue a person may choose to chase personally, which is
  compliant precisely because a human, not the automation, is now deciding and
  it is logged. So it **is** ticketed, at the lowest priority band, never
  crowding out fraud/approval/customer-question work. A reviewer takes a ticket
  (`open → under_review`, one owner), records what they did, and closes it
  `resolved` or `unresolved` — an honest "couldn't fix this" is a first-class
  outcome. Money a human recovers is tracked separately
  (`Event.human_recovered_amount`); `MetricsBlock.total_recovered` is unchanged
  and still the honest total, with `ai_recovered`/`human_recovered` as the
  derived split. Every human action writes `agent="human"` to the audit trail
  (new `Agent.HUMAN` member) with the reviewer's own note as the `reasoning`,
  verbatim — the trail names who decided, never launders a person's call through
  an agent. `raise_customer_question()` covers the live case: mid-call or in a
  message, the customer asks something the AI can't answer, so it's handed to a
  person instead of improvised (`VoiceCallDrawer` gained an escalation button).
  Reviewer identity is a work email in `localStorage`, stamped on every
  action — attribution, not authentication; the dashboard is an internal
  test-mode tool and real deployment would put SSO in front of it. Frontend:
  new `/attention` route, `TicketDrawer`, assign/resolve/raise-question modals,
  `ReviewerSignIn`. Verified against the buildathon page ("compliant escalation,
  stopping rules, and an audit trail" — exact wording) and the Agent Studio
  launch page (neither mentions human review; Razorpay's own Subscription
  Recovery Agent still pairs automation with a human channel). `AGENTS_CONTRACT.md`
  amended by the owner (not a builder) to add the Triage stage, the `tickets`
  table, and the three human-review endpoints.
- **Hinglish voice — real TTS (2026-09-04):** Direction 6's `VoiceCallDrawer`
  played its call script through the browser `SpeechSynthesis` voice, which
  sounds robotic and mangles Hinglish. Added `app/agents/voice_tts.py` —
  **Sarvam AI `bulbul:v3`** neural TTS (an Indian model built for code-mixed
  Hindi/English), a distinct voice for the agent (`priya`) and the simulated
  customer (`rahul`). New endpoint `GET /api/events/{id}/voice/audio` returns a
  base64 WAV per dialogue turn; the drawer plays them in sequence and **falls
  back to the browser voice** when `SARVAM_API_KEY` is unset or Sarvam errors —
  the agents and pipeline are unchanged. Mirrors Razorpay's own Subscription
  Recovery Agent, which pairs recovery logic with a dedicated voice vendor.
- **Dashboard glass fallback (2026-09-04):** `GlassCard` uses a frosted
  `backdrop-blur` surface, not the full liquid-glass refraction library; can be
  upgraded later without an API change.
- **Synthetic customer contact data (2026-09-04):** Four new fields
  (`customer_name`, `customer_phone`, `customer_bank_account`, `customer_upi_vpa`)
  added to `Event` / `EventCreate` / `EventRead` and generated by the synthetic
  batch generator via `_fake_contact()` using Faker. These are **entirely
  invented** — Razorpay's test-mode docs were verified and have no customer /
  contact simulator. They exist so (a) a case reads like a real record in the
  dashboard, and (b) the Playground has a named, phone-number-bearing persona to
  role-play against. Phone and bank-account numbers are shown masked in
  `DetailDrawer`. These fields are never real PII.
- **Simulate / Playground — sandboxed rehearsal explicitly excluded from
  MetricsBlock (2026-09-04):** `app/agents/playground.py` implements a live
  turn-by-turn conversation between two LLM personas (Resolver + Customer/Business)
  for a judge or developer to probe the AI's behaviour. It is **stateless and
  read-only against the store** — it never calls `insert_ticket`, `update_event`,
  or `log_action`. The `history` list lives in the browser and is resent with
  every API call; the backend holds no session state. This means `/api/metrics`
  is guaranteed byte-identical before and after any Simulate session, verified
  in both `test_playground.py` (DB-row-count snapshot) and `test_api.py` (HTTP
  level, full `MetricsBlock` comparison). The brief §6 does not describe a
  "judge playtesting" mode; this is a deliberate addition because the submission
  will be demoed live.
- **Payment-capture integrity fix — in progress (2026-09-05, Phase A of a
  team-lead + 2-builder round):** a second AI agent's follow-on Playground work
  had left `recovery.py._resolve_outcome` marking `status="recovered"` via a
  hard-coded coin flip (`SUCCESS_RATES` + `_stable_hash`) with **no payment
  capture, conversation outcome, or PTP behind it** — the user caught this by
  hand as a genuine "we could lose the hackathon" risk (a judge could see
  "recovered" events with nothing behind them). Fix: one unified capture engine
  (`app/agents/payment.py`, new) — a hybrid real-Razorpay-test-mode Payment
  Link (webhook-confirmed, when `RAZORPAY_KEY_ID`/`SECRET` are set) /
  deterministic fake-gateway (sync-resolved) path — becomes the **only** place
  `Event.status` ever becomes `recovered` from a capture, reused by both the
  batch pipeline and the Playground. New `PaymentLinkStatus` enum + 6 `Event`
  columns (§5 above); `recovery.py._resolve_outcome` will be rewritten by
  team-lead personally (the highest-stakes edit in this round) to call
  `payment.create_payment_link` instead of the coin flip. Confirmed via
  Razorpay docs research this session: Payment Links support real test-mode
  creation (`POST /v1/payment_links`, amount in paise, `reference_id` ≤ 40
  chars, `notes` up to 15 pairs/256 chars each, response `id` prefixed
  `plink_...`, `status` one of `created`/`paid`/`expired`/`cancelled`/
  `partially_paid`) and test-mode webhooks genuinely fire `payment_link.paid`
  on a real test payment — this repo's webhook listener already names that
  event in `SUCCESS_EVENTS` but had never wired it up. Alongside this, the
  Simulate/Playground engine (§ "Simulate / Playground" above) is being
  redesigned for two named modes with either-side takeover, a multi-day game
  clock advancing on natural conversation pauses (never a raw message-count
  cap), and two distinct structured escalation triggers, plus a liquid-glass
  restyle to match `DetailDrawer.tsx`'s existing drawer system. Full plan at
  `C:\Users\Tejas Jain\.claude\plans\we-ought-to-have-recursive-scroll.md`; see
  `AGENTS_CONTRACT.md` §11/§12 for the frozen `payment.py` signatures and
  Playground `sim_state` shape. **Phases A/B/C all landed (2026-09-05):**
  `app/agents/payment.py` built (payment-engine-builder) with the webhook
  capture wiring and the new `/pay/:token` router (mounted by team-lead in
  `main.py`); `app/agents/playground.py` fully rewritten (simulation-engine-builder)
  with modes/takeover/game-clock/escalation/`click_payment_link`;
  `recovery.py._resolve_outcome` rewritten by team-lead personally to call the
  new engine instead of the coin flip; `routes.py`'s playground endpoints
  migrated to the new mode default + `sim_state`/`speaker`/`outcome` fields.
  **A real operational hazard surfaced and was fixed during this pass:** this
  dev machine's `.env` has real Razorpay test-mode keys configured, and
  `pipeline.run()` already defaults to `get_settings()` — without a fix, every
  full-pipeline test run would have called the real Payment Links API for each
  diagnosed event, burning the 30-test-link quota and leaving most events
  non-terminal. Fixed with a new autouse `_no_real_razorpay` fixture in
  `tests/conftest.py` (same isolation posture as the existing
  `_offline_embeddings` fixture). Frontend liquid-glass restyle + Simulation
  settings panel (plan's §4/§5) dispatched to `frontend-builder` next; docs
  deltas (`documentation.md`, `architecture.md`, `history.md`) applied in this
  same pass per §13's rules.
- **Systemized Unified Audit Log & Customer Action Trail (2026-09-05):**
  Unified the AI pipeline decision trail and simulation event logs into one standardized, systemized, color-coded audit log component (`AuditTimeline.tsx`). Customer actions (link clicks, OTP entries, customer replies, calls answered, silence) elevated to first-class audit events; strict chronological sorting merges store records and live simulation events via a monotonic `sortKey`; 7 semantic color-coded categories with interactive filter pills; specialized inline cards for Payment Links, Mandate Renewals, and verified Payment Captures. Deployed across `TicketDrawer.tsx`, `DetailDrawer.tsx`, and `SimulateSession.tsx` Column 2.
- **Simulate tab Controls & Actions rework (2026-09-05):** the panel had
  drifted — a "Tester Input" box duplicating the live WhatsApp chat input, a
  "Simulate Customer Actions" group with two canned-string buttons and a
  third (Click Link & Pay) disabled at exactly the moment (post-PTP) it was
  meant to be used, and payment/mandate links in the transcript were inert
  text. Removed both redundant sections; the "AI Simulation Engine" card is
  now one vertical stack: Next Turn → Auto-Run → Out-of-Scope Query → Force
  Human Escalation → Record Promise to Pay (PTP). PTP now opens a simulated
  ticket "with a human" (`ticketStatus` state — disables the AI-engine
  buttons, only the payment-link path stays live) that clears to "recovered"
  once the customer later pays. A payment/mandate link in any turn's text is
  now clickable and opens a new embedded fake-checkout screen inside the
  phone mockup (never a separate page — stays sandboxed) where the tester
  explicitly picks the outcome: succeed, wrong OTP, wrong email/password,
  press back before completing, or insufficient balance — with a "‹ Back to
  WhatsApp" bail-out that makes no API call. Backed by a new `forced_reason`
  param on `playground.click_payment_link` (dispatched to
  `simulation-engine-builder`; `AGENTS_CONTRACT.md` §12/§13 new entry S9):
  `None` (every existing caller) keeps the exact original random-roll
  behavior via `payment.resolve_fake_capture`; a tester-picked reason builds
  the `CaptureResult` locally instead — `wrong_password` is a **playground-only**
  reason, never added to `payment.py`'s frozen `CaptureResult` vocabulary
  (that module stays untouched, still shared with the real, DB-writing
  `/pay/:token` flow). An `insufficient_funds` checkout failure never
  escalates — it reschedules to `sim_state.salary_reminder_day = sim_day + 5`,
  a bounded sandbox stand-in for `recovery.SALARY_WINDOW_DAY` (the real
  constant targets a calendar day-of-month; `sim_day` has no calendar
  backing). 50 backend tests green (`test_playground.py`, 13 new); full
  `documentation.md`/`architecture.md` deltas applied same-pass.
- **Simulate tab: PTP escalation bugfix + reminder cadence (2026-09-05):**
  a real bug surfaced in a live transcript the user reviewed by hand: the
  agent logged "Promise-to-Pay recorded" and the *very next line* was
  "Escalated to human review queue: max attempts exceeded" — a customer who
  had just agreed to pay was being silently re-escalated in the same turn,
  purely because the generic attempts/escalation-stage ceiling happened to be
  crossed. `_resolve_escalation_reason` (`backend/app/agents/playground.py`)
  now never fires that ceiling when the outcome this turn is already
  `ptp_promised`/`resolved`. Beyond the immediate fix, a Promise-to-Pay is now
  a proper state machine decoupled from the attempts ladder entirely
  (`sim_state.ptp_active`/`ptp_target_day`/`ptp_target_date_label`) —
  confirmed against the real `app/agents/ptp.py` design (`PROMISED →
  HONORED|BROKEN`, broken = overdue past a grace period) that a promise is
  meant to *pause* escalation, not accelerate it: it now only escalates via
  `ptp_overdue` (the promised date passes unpaid) or `ptp_payment_failed` (a
  payment attempt made while the promise is outstanding fails), never from
  "more turns happened." Customer-facing dates are now real calendar strings
  ("1st October"), never raw `"Day N"` — `_format_calendar_date`/`_ordinal`,
  reusing `recovery._next_salary_window` for the `insufficient_funds`
  reschedule. A new reminder-cadence gate (`reminder_cta`/`reminder_days`)
  stops the same automated nudge from repeating same-day (observed in the
  same transcript: an identical "you cancelled the payment" line sent twice
  back-to-back) and caps it at 3 distinct days before handing off
  (`reminders_exhausted`), resetting whenever the actual ask changes.
  `AGENTS_CONTRACT.md` §12/§13 new entry S10. Frontend (`SimulateSession.tsx`):
  `ticketStatus` split into `'ptp_pending'` (its own "Awaiting Settlement"
  banner, not lumped into `'human_review'`) vs `'human_review'`
  (only reached via a genuine escalation now); the AI Simulation Engine
  buttons and chat input now stay enabled through `outcome==='ptp_promised'`
  (previously `outcome!=='ongoing'` disabled them the instant a PTP was
  recorded, making it impossible to ever watch a promise resolve or go
  overdue). 64 backend tests green (`test_playground.py`, 15 new); full
  `documentation.md`/`architecture.md` deltas applied same-pass.
- **Simulate tab: bare-agreement override + bot-question fix (2026-09-05):**
  this deployment runs with `OPENROUTER_API_KEY` configured, so conversations
  are LLM-driven — and a follow-up live transcript exposed a gap the S10 fix
  didn't cover: the customer replied "okay" to the agent's own "should I send
  you the payment link?", an unambiguous agreement, but the LLM's own
  judgment didn't classify it as such, so the case never became a PTP at all
  and instead kept accumulating attempts until the generic
  `max_attempts_exceeded` ceiling fired — the S10 fix only protects a PTP
  *after* it's recorded, not the recognition step itself. Fixed with
  `_apply_agreement_override` (`backend/app/agents/playground.py`,
  `AGENTS_CONTRACT.md` §13 new entries S11a/S11b): runs after every LLM call
  in both `send_message` and `advance_conversation`, and if the outcome is
  still `"ongoing"` while the message is an unambiguous agreement
  (`_is_clear_agreement`, same semantics the deterministic fallback already
  used, now shared/extracted), force-corrects to `"ptp_promised"` regardless
  of the model's own judgment — cheap insurance, costs nothing when the model
  already agrees, never applied to the human-takeover path. Same transcript
  also showed an off-topic "Are you a bot?" getting the same recycled
  root-cause-explanation text as a genuine failure question, because the
  fallback's question-detection fired on any bare `"?"`; fixed with a new
  identity-question branch and a requirement that the explanation branch see
  an actual on-topic signal. Also fixed the frontend's "Reminders Cap: X/3"
  badge (`SimulateSession.tsx`), previously a `Math.min(3, sim_day)` guess
  disconnected from the real S10 cadence state — now reads
  `sim_state.reminder_days.length`. 86 backend tests green
  (`test_playground.py`, 6 new); full `documentation.md`/`architecture.md`
  deltas applied same-pass.
- **Simulate tab: escalation is not a hard stop + voice-input removed
  (2026-09-05):** the user pointed out that once a case is escalated to
  human review, the agent should still keep answering customer queries as
  long as they're in scope — e.g. if the customer suddenly agrees to pay
  after escalation, the agent should still help with a payment link, exactly
  like a real support hand-off (a ticket being open doesn't mean the AI goes
  silent). `SimulateSession.tsx`'s `isActionable` locked the entire
  conversation (chat, Next Turn, Auto-Run, every panel button) the instant
  `outcome==='escalated'`; changed to `outcome!=='resolved' &&
  outcome!=='halted'` — escalation of any reason stays fully interactive,
  matching the user's explicit call-out that a suspected-fraud `halted` case
  should remain the one genuine hard stop (Recovery already refuses to act
  on those). Confirmed this needed **no backend change at all**: the S10 PTP
  state machine already lets a same-turn `ptp_promised`/`resolved` outcome
  win over the escalation ceiling, and `phase==='ended'` already rendered the
  full UI — the lock was purely this one frontend flag. Also removed the
  voice-input feature per the user's request ("remove the voice in the
  whatsapp chat") — the mic button lived only in the WhatsApp chat input bar,
  and voice playback was already gated to `channel==='call'` (permanently
  unreachable since `begin()` forces `channel: 'message'`), so the entire
  `SpeechRecognition` apparatus was dead code once that one button was gone;
  deleted rather than left dormant. `npm run build` clean; no backend tests
  affected (frontend-only change).
- **Approved deviations from this brief:** PostgreSQL (not SQLite) — run as a
  local process via `scripts/pg.ps1` since Docker needs WSL2 (unavailable on this
  Win 11 Home box); `uv` (not `pip`/`requirements.txt`); a FastAPI **backend/** +
  React **frontend/** monorepo instead of a single Streamlit app (Streamlit
  dropped). Repo layout in Section 8 is superseded by the tree in
  `documentation.md` §2.

---

## 13. Documentation upkeep (non-negotiable)

Two living docs must be kept accurate. **In the same change** that adds or alters
a file, function, class, API endpoint, DB table/column, enum value, config key,
CLI, or command — update BOTH:

| File | Holds | Update when |
|---|---|---|
| [`documentation.md`](documentation.md) | Exhaustive reference: file-by-file table (path → purpose → status); every public function/class with signature + return + notes; every DB column; every Pydantic schema; every endpoint (method, path, handler, response); the runbook; the test inventory; the Section 9 build-status table. | Any code, schema, endpoint, dependency, or command change. |
| [`architecture.md`](architecture.md) | Diagrams (Mermaid): agent pipeline, runtime topology, ERD, event-lifecycle state machine, request-flow sequence. Plus component-responsibility table, design-decision log, tech-stack table. | Any change to the agent flow, data model, runtime topology, or a design decision. |

Rules:
- Prefer **tables** and Mermaid diagrams over prose.
- Every file in the repo appears in `documentation.md` §3 with a one-line purpose
  and a status (done / scaffold / planned / stretch).
- When a diagram's boxes change state (built vs not), recolour them
  (`classDef done` / `classDef todo` in `architecture.md` §2).
- Bump the "Last updated" line in both files and note which Section 9 step the
  change corresponds to.
- If a change contradicts this brief, record it under "approved deviations" in
  Section 12 above — do not silently diverge.
