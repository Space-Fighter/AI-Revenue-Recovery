# Documentation — AI Revenue Recovery

Detailed reference for every file, class, function, endpoint, and command in the
repo. Companion to [architecture.md](architecture.md) (diagrams + design
rationale) and [CLAUDE.md](CLAUDE.md) (the project brief).

> **Keep this current.** Section 13 of CLAUDE.md requires `documentation.md` and
> `architecture.md` to be updated in the same change that adds/alters a file,
> function, class, endpoint, table, or command.

Last updated: 2026-09-05 — **Simulate tab: PTP escalation bugfix + reminder cadence** (plan.md §9, `AGENTS_CONTRACT.md` §12/§13 S10):
Fixed a real bug the user caught in a live transcript: `_resolve_escalation_reason` was overriding a same-turn `ptp_promised`/`resolved` outcome into `"escalated"` purely because the attempts/escalation-stage ceiling had been crossed — a customer who'd just agreed to pay got immediately bounced to "human review." Now decoupled entirely: a new PTP state machine (`sim_state.ptp_active`/`ptp_target_day`/`ptp_target_date_label`) suspends the generic attempts ladder while a promise is outstanding — a PTP case only escalates if it goes overdue (`ptp_overdue`) or a payment attempt made while it's outstanding fails (`ptp_payment_failed`), never just from more turns happening. Customer-facing dates are now real calendar strings ("1st October"), never raw `"Day N"` — `_format_calendar_date`/`_ordinal`, reusing `recovery._next_salary_window` for the `insufficient_funds` reschedule. New reminder-cadence gate (`reminder_cta`/`reminder_days`, `_classify_reminder_cta`/`_reminder_gate`) stops the same automated reminder from repeating same-day and caps it at 3 distinct days before escalating (`reminders_exhausted`), resetting whenever the actual ask changes — send/advance responses can now come back `suppressed: true` with a `null` turn on a same-day duplicate. Frontend (`SimulateSession.tsx`): `ticketStatus` is now `'none'|'ptp_pending'|'human_review'|'recovered'` (was conflating PTP with human review); a Promise-to-Pay shows its own "Awaiting Settlement" banner and no longer disables Next Turn/Auto-Run (a PTP is a wait, not a stop — those buttons now stay live through `outcome==='ongoing'||'ptp_promised'`, only disabling on a genuinely terminal outcome) so the tester can watch a promise resolve or go overdue.
<!-- previous update: Simulate tab Controls & Actions rework -->

Previously (2026-09-05) — **Simulate tab Controls & Actions rework** (plan.md §9, Simulate/Playground UI):
Removed the redundant "Tester Input" box and "Simulate Customer Actions" button group from `SimulateSession.tsx` (and the dead `logAction` no-op stub + its ~10 call sites); the "AI Simulation Engine" card is now one vertical stack — Next Turn → Auto-Run → Out-of-Scope Query → Force Human Escalation → Record Promise to Pay (PTP). Payment/mandate links in the transcript are now clickable and open a new embedded fake-checkout screen inside the phone mockup (`phoneView: 'chat'|'checkout'`) where the tester explicitly picks the outcome (succeed / wrong OTP / wrong email-password / press back / insufficient balance) — backed by a new `forced_reason` param on `playground.click_payment_link` (`backend/app/agents/playground.py`, `AGENTS_CONTRACT.md` §12/§13 S9). `payment.py`/`payment_routes.py`/`PayCheckout.tsx` (the real DB-writing `/pay/:token` flow) untouched.
<!-- previous update: Systemized Unified Audit Log & Customer Action Trail -->

Previously (2026-09-05) — **Systemized Unified Audit Log & Customer Action Trail** (plan.md §15):
Unified the AI pipeline decision trail and simulation event logs into one standardized, systemized, color-coded audit log component (`frontend/src/components/AuditTimeline.tsx`). Customer actions (link clicks, OTP entries, customer replies, calls answered, silence) elevated to first-class audit events; strict chronological sorting merges store records and live simulation events via a monotonic `sortKey`; 7 semantic color-coded categories with interactive filter pills; specialized inline cards for Payment Links, Mandate Renewals, and verified Payment Captures. Deployed across `TicketDrawer.tsx`, `DetailDrawer.tsx`, and `SimulateSession.tsx` Column 2.
<!-- previous update: Payment-capture integrity fix + Playground redesign -->

existing direct callers). New `_no_real_razorpay` autouse test fixture
(`conftest.py`) — discovered this session that a developer's local `.env` with
real Razorpay test-mode keys would otherwise make the full-pipeline tests hit
the live API. Fixed two now-outdated `test_api.py` assertions that assumed the
old always-succeeds payment simulation. **Frontend (§3.5):** `SimulateSession.tsx`
and `VoiceCallDrawer.tsx` restyled onto the liquid-glass system; `SimulateSession.tsx`
further rewritten to the user's hand-drawn wireframe-sketch structure — a
two-column live-session layout (phone mockup + a structured, timestamped
Messaging/Call/Customer-Actions transcript-log panel), a "Take over this
simulation" + "View Transcripts" control pairing, and `click_payment_link`
outcomes logged as distinct Customer Actions entries rather than folded into
chat bubbles; new standalone `PayCheckout.tsx` page (`/pay/:token`, outside
`AppShell`); new "Simulation settings" data-source toggle on `Playground.tsx`;
`types.ts`/`dataSource.ts`/`client.ts` gained the `sim_state`/`escalation`/
payment types. `npm run build` + `npm run lint` both clean. §3.3, §3.4, §3.5,
§5, §13 updated; see `AGENTS_CONTRACT.md` §11-§13 for the frozen contract and
history.md for the full session brief.

Previously (2026-09-04) — **Simulate / Playground + Sarvam TTS fix + synthetic
contact data**: `app/agents/playground.py` (stateless sandboxed rehearsal, two
independently-prompted LLM personas, `interactive` + `auto` modes); 3 new routes
(`POST /events/{id}/playground/start|message|advance`); `chat_turns()` added to
`app/llm.py`; synthetic contact fields (`customer_name/phone/bank_account/upi_vpa`)
on `Event`/`EventCreate`/`EventRead`; `frontend/.env` created (`VITE_DATA_SOURCE=live`)
— fixes Sarvam TTS. New frontend pages: `Playground.tsx` + `SimulateSession.tsx`.
New tests: `test_playground.py` (26), extended `test_llm.py` (8 total), 4 new
playground endpoint tests in `test_api.py`. Docs: §3.3, §3.4, §3.5, §5 endpoints,
§7 Event columns, §9 `llm.py` functions, §12 test inventory all updated.
Prior: 2026-09-04 — **Urgent human attention / review tickets**: new
`tickets` table + `TicketStatus` / `TicketReason` enums + `Agent.HUMAN` and
`Event.human_recovered_amount` (`app/db/store.py`); new Triage agent
(`app/agents/triage.py`) wired into `pipeline.py` between Recovery and Audit;
5 new endpoints (`GET /api/tickets`, `GET /api/tickets/{id}`, `POST
/api/tickets/{id}/assign`, `POST /api/tickets/{id}/resolve`, `POST
/api/events/{id}/raise-question`); `MetricsBlock` gains `ai_recovered`,
`human_recovered` and a `tickets` block; generator gains `build_silent_failures`;
frontend `/attention` page + `TicketDrawer` + ticket modals + reviewer sign-in.
19 new triage tests, 8 new store tests, 6 new API tests (190 backend tests).
Prior: 2026-09-04 — Sarvam AI neural TTS for the Hinglish Voice Recovery
Agent (Direction 6): `app/agents/voice_tts.py` (`bulbul:v3`, agent/customer
speakers), `GET /api/events/{id}/voice/audio` → base64 WAV clips per dialogue
turn; `VoiceCallDrawer.tsx` plays them and falls back to the browser
`SpeechSynthesis` voice when `SARVAM_API_KEY` is unset. New config keys
`SARVAM_API_KEY` / `SARVAM_TTS_*`. 3 new voice tests (149 backend tests).
Prior: 2026-09-04 — GitHub Actions CI (`.github/workflows/ci.yml`):
pgvector service container + `uv sync --frozen` + both pytest chunks + frontend
build/lint, on every push and PR. Prior: 2026-09-04 — Razorpay test-mode
webhook listener (build-order step 9): `app/webhooks/listener.py`, `POST /webhooks/razorpay` (HMAC-SHA256
signature check → `EventCreate` → same pipeline), 12 tests. 146 backend tests.
Prior: 2026-09-04 — RAG knowledge base: `app/rag.py` (pgvector
`resolved_cases` table + HNSW index) wired into the Diagnosis Agent's free-text
fallback; `app/llm.embed()` (OpenAI or local `fastembed`); `GET
/api/events/{id}/similar`; "Similar past cases" dashboard panel; Postgres moved
to the `pgvector/pgvector` Docker container (the "Docker unavailable" note was
wrong). 134 backend tests. Prior: 2026-09-04 — provider-agnostic LLM client
(app/llm.py: Anthropic / OpenRouter / OpenAI). Prior: 2026-09-04 — Phase B + C
of the agent-team build: all four agent
modules built and merged (`detection` / `diagnosis` / `recovery` / `audit`,
build-order steps 3–6), `app/pipeline.py` chaining them (step 7), `app/api/*`
routers to the frozen contract mounted in `main.py` (step 8), `fixtures.json`
regenerated from a real seed-42 run, React dashboard pages built against it.
113 backend tests green. Prior: 2026-09-03 — Phase A + B0 of the agent-team
build (plan.md §9 steps 3–6 prep): added `RootCause` StrEnum to `store.py` and typed
`EventUpdate.root_cause`; added optional `EventCreate.created_at` (backdated
insert) and taught `insert_event` to honour it; corrected generator
`raw_failure_reason` codes to real Razorpay test-mode strings
(`insufficient_fund`, `authentication_failed`, `payment_timed_out`,
`card_number_invalid`) and spread the batch `created_at` over
`BATCH_SPAN_DAYS=14` with the fraud cluster in one `FRAUD_WINDOW_MINUTES=40`
window; froze `backend/app/agents/AGENTS_CONTRACT.md` (incl. §10 Phase-B0 Q&A
resolutions) and the API response contract (§5); added
`frontend/src/api/fixtures.json`. Prior: 2026-09-03 — merged the four
frontend skills (`scroll-craft`,
`liquid-glass`, `glass-scroll-3d`, `revrec-dashboard`) into one `frontend` skill
with four modes under `.claude/skills/frontend/<mode>/GUIDE.md` (§3.1); no
build-order step (tooling/process only). Prior: 2026-09-03 — added the
`build-workflow` project skill (§3.1), which absorbs and replaces
`razorpay-source-check` and adds a plan.md
check-out/update step. Prior:
2026-08-28 — after CLAUDE.md
Section 9 **step 2** (synthetic data generator) + switch to a local (non-Docker)
PostgreSQL. Build status table at the bottom.

---

## 1. What this is

A four-agent pipeline that detects revenue at risk (failed payments, abandoned
checkouts, overdue invoices, expired mandates), diagnoses the root cause,
executes a **bounded** recovery workflow, and writes every decision to an audit
trail. Submission for the Razorpay AI Buildathon, Track 03. **Test mode only —
no real money.**

Split into a Python/FastAPI **backend** and a React **frontend** (monorepo).

---

## 2. Repository map

```
RAZORPAY BUILDATHON/
├── CLAUDE.md                     project brief / source of truth
├── documentation.md              this file
├── architecture.md               diagrams + design decisions
├── docker-compose.yml            Postgres 16 container
├── .gitignore
├── scripts/
│   └── init-test-db.sql          creates the revrec_test database (once)
├── backend/
│   ├── pyproject.toml            Python deps (uv), pytest config
│   ├── uv.lock
│   ├── .env.example
│   └── app/
│       ├── main.py               FastAPI app
│       ├── config.py             typed settings (pydantic-settings)
│       ├── db/store.py           shared event store + schema models
│       ├── data/generate.py      synthetic batch generator
│       ├── agents/               detection · diagnosis · recovery · audit (empty)
│       ├── api/                  REST routers (empty)
│       └── webhooks/             Razorpay test-mode listener (empty)
│   └── tests/
│       ├── conftest.py           shared fixtures
│       ├── test_store.py         18 tests
│       └── test_generate.py      7 tests
└── frontend/
    ├── package.json              React 19 + Vite + Tailwind v4 + Recharts
    ├── vite.config.ts            dev server + /api,/health proxy → :8000
    └── src/
        ├── main.tsx              React entrypoint
        ├── App.tsx               app shell
        ├── index.css             @import "tailwindcss"
        └── api/client.ts         typed fetch wrapper
```

---

## 3. File reference

### 3.1 Root / infrastructure

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project brief. Track, "the bar," architecture, tech-stack decisions, build order (Section 9), stopping rules (Section 6), data model (Section 5). Read first. |
| `documentation.md` | This file. |
| `architecture.md` | Mermaid diagrams (pipeline, ERD, lifecycle, runtime), component responsibilities, design-decision log. |
| `scripts/pg.ps1` | **Active Postgres path.** Manages a self-contained PostgreSQL 17 (zonky embedded-postgres binaries from Maven Central) under `%LOCALAPPDATA%\revrec-pg` — no Docker, no admin. Subcommands: `install` (download + `initdb` + create `revrec` & `revrec_test`), `start`, `stop`, `restart`, `status` (via `pg_ctl`). Port 5432, superuser `revrec`, `trust` auth (localhost dev only). |
| `docker-compose.yml` | **Full-stack orchestration:** `db` (`pgvector/pgvector:pg17` datastore), `backend` (`FastAPI` app on `:8000`), `frontend` (`Nginx` SPA + proxy on `:3000`). Run full stack via `docker compose up -d --build` or DB alone via `docker compose up -d db`. |
| `scripts/init-db.sql` | First-container-start init: `CREATE DATABASE` for `revrec_test` + the three parallel-build test DBs, and `CREATE EXTENSION vector` in every DB. |
| `scripts/init-test-db.sql` | Legacy single-test-DB init — superseded by `init-db.sql`, no longer referenced by `docker-compose.yml`. |
| `.gitignore` | Ignores `__pycache__`, `.venv`, `.pytest_cache`, `.env`, `node_modules`, `frontend/dist`, `**/data/synthetic_events.csv`. |
| `.github/workflows/ci.yml` | GitHub Actions CI. **backend** job: `pgvector/pgvector:pg17` service container, `uv sync --frozen`, creates `revrec_test`, runs `pytest -q --ignore=tests/test_pipeline.py` then `pytest -q tests/test_pipeline.py`. **frontend** job: `npm ci`, `npm run lint`, `npm run build`. Triggers: push to `main`, all PRs, manual. No secrets — every LLM/embedding call is mocked. |
| `.github/workflows/cd.yml` | GitHub Actions CD. Multi-stage image build & push to GitHub Container Registry (`ghcr.io`) for both `backend` and `frontend`. Triggers: push to `main`, release tags (`v*`), manual dispatch. Uses Buildx + GitHub Actions layer caching (`type=gha`). |
| `.claude/skills/` | Claude Code project skills (dev tooling, not shipped): `build-workflow` (mandatory per-task workflow wrapper: check out/update plan.md → verify against Razorpay sources (link list + how-to embedded in its Step 1) → keep architecture.md diagrams current → documentation.md → history.md brief; absorbed the former `razorpay-source-check` skill), `scroll-craft` + `liquid-glass` (vendored UI skills), `glass-scroll-3d` (composite scroll+R3F+glass, for the welcome page), `frontend` (one skill, four modes — `scroll-craft` + `liquid-glass` vendored UI guides, `glass-scroll-3d` composite scroll+R3F+glass for the welcome page, `revrec-dashboard` dashboard UI: tokens + chart catalog + data-table/timeline components, combines dataviz + liquid-glass; each mode is a `GUIDE.md` under `.claude/skills/frontend/<mode>/`). |
| `plan.md` | The project brief (formerly `CLAUDE.md`; renamed). `CLAUDE.md` is now a short operational guide pointing here. |
| `readme.md` | **The submission README** (build-order step 10): the-bar mapping, root-cause→intervention table, the fraud-cluster demo moment, run instructions + example output, and the "what broke / what we'd do next" writeup. |

### 3.2 `backend/` — packaging & config

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage production container (`ghcr.io/astral-sh/uv:0.5.24-python3.11-bookworm-slim` builder → `python:3.11-slim-bookworm` runtime) with `uv sync --frozen --no-dev`, curl healthcheck on `/health`, port 8000. |
| `.dockerignore` | Excludes `.venv`, `__pycache__`, `.pytest_cache`, `.env`, tests, data CSVs from Docker context. |
| `pyproject.toml` | Project `razorpay-revenue-recovery-backend`, `requires-python >=3.11`. Deps: `anthropic`, `sqlmodel`, `psycopg[binary]`, `razorpay`, `fastapi`, `uvicorn[standard]`, `pydantic-settings`, `pandas`, `python-dotenv`, `faker`, `httpx`, **`pgvector`** (SQLAlchemy `Vector` type), **`fastembed`** (local embeddings, ONNX — no torch), **`numpy`**, **`langchain-core`** (`Embeddings` interface). Dev: `pytest`. `[tool.uv] package = false`. `pythonpath = ["."]`. |
| `uv.lock` | Resolved dependency lockfile (committed). |
| `.env.example` | Template for `backend/.env`. Keys below. |

**`backend/.env` keys**

| Key | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://revrec:revrec@localhost:5432/revrec` | `store.get_engine`, `config.Settings` |
| `TEST_DATABASE_URL` | `…/revrec_test` | `tests/conftest.py` |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS in `main.py` |
| `LLM_PROVIDER` | auto | force `anthropic` \| `openrouter` \| `openai`; else auto-detect in that order |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-sonnet-5` | Diagnosis fallback + Recovery outreach (optional) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | — / `anthropic/claude-3.7-sonnet` | same, via OpenRouter (OpenAI-compatible) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` | same, via OpenAI |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | RAG embeddings when `OPENAI_API_KEY` set (else local `fastembed`) |
| `RAG_ENABLED` / `RAG_TOP_K` / `RAG_BUCKET_CAP` / `RAG_DEDUP_DISTANCE` | `true` / `5` / `200` / `0.05` | RAG retrieval + knowledge-base curation knobs |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | — | webhook listener (later) |
| `SARVAM_API_KEY` | — | Sarvam AI TTS for the Hinglish voice player (optional; no key → browser voice) |
| `SARVAM_TTS_MODEL` / `_LANGUAGE_CODE` / `_SAMPLE_RATE` | `bulbul:v3` / `hi-IN` / `22050` | Sarvam TTS request params |
| `SARVAM_TTS_SPEAKER_AGENT` / `_SPEAKER_CUSTOMER` | `priya` / `rahul` | Sarvam voices for the agent and simulated customer turns |

### 3.3 `backend/app/` — application code

| File | Purpose | Status |
|---|---|---|
| `app/__init__.py` … `app/webhooks/__init__.py` | Package markers. `agents/`, `api/`, `webhooks/` are empty placeholders. | scaffold |
| `app/main.py` | FastAPI application. See §5. | minimal (health only) |
| `app/config.py` | `Settings` (pydantic-settings) + cached `get_settings()`. See §4. | done |
| `app/llm.py` | Provider-agnostic LLM client for Diagnosis + Recovery + Playground. Chat: `chat()` (one-shot), `chat_turns()` (multi-turn, for the Playground personas), `available()`, `resolve_provider()`, `model_label()`, `LLMUnavailable` — auto-detects `anthropic → openrouter → openai` (or `LLM_PROVIDER`). Embeddings (for RAG): `embed(texts, *, settings) -> list[list[float]]`, `embeddings_available()`, `resolve_embed_provider()`, `embed_label()` — OpenAI `text-embedding-3-small` (`dimensions=384`) if `OPENAI_API_KEY`, else local `fastembed` `all-MiniLM-L6-v2` (384-d). `EMBED_DIM = 384`. | **done** |
| `app/rag.py` | RAG knowledge base for the Diagnosis Agent. `case_text(event)`, `RevRecEmbeddings` (LangChain `Embeddings` wrapper over `llm.embed`), `retrieve_similar(session, event, *, settings, k)`, `format_for_prompt(similar)`, `seed_reference_cases(session, *, settings)` (~20 canonical examples, first run only), `index_resolved_cases(session, *, settings)` (append confidently-classified batch events; dedup + bucket-cap). No-op when pgvector or embeddings are unavailable. | **done** |
| `app/db/store.py` | The shared event store: table models, Pydantic schema models, engine/session helpers, CRUD + audit functions. See §6–§9. | **done, step 1** |
| `app/data/generate.py` | Deterministic synthetic batch generator incl. fraud cluster. See §10. | **done, step 2** |
| `app/agents/AGENTS_CONTRACT.md` | Frozen cross-agent contract: per-stage I/O, `RootCause`→intervention map, audit `action` registry, stopping-rule constants, fraud-cluster signature, audit `payload` shapes, Claude-usage rules, API response contract, file boundaries, §10 Phase-B0 Q&A resolutions. | **done** |
| `app/agents/__init__.py` | Imports the four stage modules; documents the uniform `run(session, *, settings=None) -> list[str]` entry point (audit also `compute_metrics`). | **done, step 7** |
| `app/agents/detection.py` | Detection Agent. `run(session, *, settings=None) -> list[str]` + pure `classify(event) -> (bool, str)`. Flags at-risk revenue (`flagged_at_risk`); routes obvious non-recoverables to `exception` (`routed_to_exception`). Idempotent. Details: `AGENTS_CONTRACT.md` §1/§3/§7. | **done, step 3** |
| `app/agents/diagnosis.py` | Diagnosis Agent. `run()`, pure `classify(event) -> (RootCause, conf, matched_reason, reasoning)`, `find_fraud_clusters(events)`, isolated `claude_classify(event, settings)`. Fraud triage first (→ `flagged`/`suspected_fraud`), then rules map, then Claude fallback when rules conf ≤ 0.5 on free text. Details: `AGENTS_CONTRACT.md` §2/§5/§6. | **done, step 4** |
| `app/agents/recovery.py` | Recovery Agent. `run()`, `draft_outreach(intervention, event, *, settings)`, `_stable_hash(event_id)`; constants `MAX_RETRY_ATTEMPTS=3`, `MAX_ESCALATION_STAGE=3`, `COOLDOWN_HOURS=24`, `HUMAN_APPROVAL_THRESHOLD_INR=Decimal("5000")`, `SUCCESS_RATES`, `HOURS_TO_RECOVERY`, `INTERVENTIONS`. Reads `diagnosed` only. **`_resolve_outcome` (2026-09-05) is payment-capture-gated, not a coin flip**: sends a payment link via `app.agents.payment.create_payment_link` (lazy-imported to avoid a circular import — `payment.py` imports `SUCCESS_RATES`/`_stable_hash` from this module), stamps `payment_link_id/url/status=AWAITING_CAPTURE/sent_at`, logs `payment_link_sent`. A real Razorpay link stays `action_taken`/`AWAITING_CAPTURE` (async webhook). A fake-gateway link resolves synchronously via `payment.resolve_fake_capture` + `payment.apply_capture` — `apply_capture` is the only place `status` becomes `RECOVERED`; `recovery.py` additionally logs a `marked_recovered` echo (kept for `audit.compute_metrics`'s `avg_hours_to_recovery`, fake-gateway path only). Human-approval gate logs + does not execute; escalation never past stage 3. Details: `AGENTS_CONTRACT.md` §4/§7/§10/§11. | **done, step 5** |
| `app/agents/payment.py` | **Unified payment-capture engine (new, 2026-09-05).** The single integrity fix of this round — `Event.status` becomes `RECOVERED` from a capture ONLY here. `razorpay_configured(settings)`; `create_payment_link(session, event, *, settings)` (real Razorpay test-mode `POST /v1/payment_links` when configured — amount in paise, `reference_id=event_id`, `notes={"event_id"}` — else a deterministic `fake_{event_id}` link; any HTTP failure degrades silently to the fake path); `resolve_fake_capture(event, link_id, *, settings, attempt=1)` (**pure**, no session/DB access — reuses `recovery.SUCCESS_RATES`/`_stable_hash`; hash-salts on `f"{event_id}:{link_id}:{attempt}"` so a bounded retry can actually vary outcome; `customer_fake_balance < amount` forces `insufficient_funds` on every attempt); `apply_capture(session, event, capture, *, source)` (sets `RECOVERED`+`payment_link_status=CAPTURED` and logs `payment_captured` on success, or `payment_link_status=FAILED` + logs `payment_capture_failed` on failure, always `agent=Agent.RECOVERY`; calls `ptp.evaluate_ptp_status` on success). Details: `AGENTS_CONTRACT.md` §11. | **done** |
| `app/agents/sequencer.py` | **Mandate Retry Sequencer (Direction 5).** `plan_retry_sequence(event)` — calendar & salary-cycle aware, rail-adaptive (UPI AutoPay / e-NACH / Card Token), NPCI 3-attempt compliant retry sequencer. | **done** |
| `app/agents/voice.py` | **Hinglish Voice Recovery Agent (Direction 6).** `generate_hinglish_voice_script(event)` — conversational multi-turn phone dialogue and WhatsApp outreach in natural Hinglish. One-shot prerecorded transcript (one LLM call, deterministic for a given case). | **done** |
| `app/agents/voice_tts.py` | **Hinglish Voice TTS (Direction 6).** `synthesize_script(script)` / `synthesize_turn(text, speaker)` — Sarvam AI `bulbul` neural speech per dialogue turn (agent vs customer speaker), returns base64 WAV. `available(settings)` gate; never raises — returns `available: false` with no key or on provider error. Returns a `reason` field for diagnosability. | **done** |
| `app/agents/playground.py` | **Simulate / Playground (rewritten 2026-09-05).** Stateless sandboxed rehearsal agent. Public API: `pick_channel(event)`, `build_persona(event)`, `start_session(event, *, mode, channel=None, settings=None)`, `send_message(event, history, message, channel, *, speaker=None, sim_state=None, settings=None, outcome=None)`, `advance_conversation(event, history, channel, *, sim_state=None, settings=None)`, `click_payment_link(event, history, channel="call", *, sim_state=None, settings=None, forced_reason=None)` (`simulate_payment` kept as a deprecated alias). **`forced_reason` (2026-09-05, AGENTS_CONTRACT.md §12/§13 S9):** `None`/omitted keeps the exact original random-roll behavior via `payment.resolve_fake_capture` (regression-guarded by tests); one of `"success"`/`"wrong_otp"`/`"wrong_password"`/`"user_cancelled"`/`"insufficient_funds"` (the tester's explicit pick at the embedded checkout screen) builds the `CaptureResult` locally instead — `wrong_password` is a playground-only reason, never added to `payment.py`'s frozen `CaptureResult` vocabulary. `insufficient_funds` is a permanent carve-out from the 3-attempt escalation: it always keeps `outcome="ongoing"`, sets `sim_state.salary_reminder_day = sim_day + 5` (new sim_state key, default `0`; a bounded sandbox stand-in for `recovery.SALARY_WINDOW_DAY` since `sim_day` is a relative counter, not a calendar date) and advances the clock via `_advance_day`. Modes `"custom"`/`"ai"` (legacy `"interactive"`/`"auto"` strings still accepted, mapped internally via `_MODE_ALIASES`) with either-side takeover via `sim_state.controlled_by`. **`sim_state`** (AGENTS_CONTRACT.md §12): a sibling dict to `history` — multi-day game clock (`sim_day`/`sim_hour`/`exchanges_today`, advances on a natural pause via `_bump_clock`, never a raw message cap; `SAME_DAY_EXCHANGE_CAP=20` is a circuit breaker only), `customer_response_probability` (starts at `CUSTOMER_RESPONSE_PROBABILITY=0.7`, deterministic per-`(event_id, turn_index)` roll via `_roll_customer_response`, ±0.15/-0.1 adjustment), `outstanding_asks` (keyword-matched via `_ASK_PATTERNS`, fed back into the agent prompt, cleared via `_clear_addressed_asks`), `last_reply_text` (anti-repetition — `_alternate_phrasing` swaps in a variant for the deterministic fallback), `capture_attempts`. Two distinct structured escalation triggers via `_resolve_escalation_reason`: `customer_requested_human` (`_HUMAN_REQUEST_PATTERNS`, immediate, any attempt count) vs `out_of_scope`/`max_attempts_exceeded` (imports `MAX_RETRY_ATTEMPTS`/`MAX_ESCALATION_STAGE` from `recovery.py`, never redefines) — both produce a structured `escalation` object (`_build_escalation`: reason, outstanding_asks, last_customer_message, root_cause, attempts_so_far, conversation_summary). `click_payment_link` calls the pure `payment.resolve_fake_capture` (salted with `sim_state.capture_attempts`, link_id prefix `sim_{event_id}`) — **never** `payment.apply_capture`. Two independently-prompted LLM personas (`chat_turns`): Resolver (agent) + Customer/Business. **Never writes to the store.** **PTP state machine + reminder cadence (2026-09-05, S10, bugfix):** `_resolve_escalation_reason`'s attempts-ceiling check now never fires when the base outcome is already `"ptp_promised"`/`"resolved"` (previously clobbered a same-turn PTP into `"escalated"` — a real bug). New `sim_state` keys `ptp_active`/`ptp_target_day`/`ptp_target_date_label` (`_activate_ptp_if_needed`, `_apply_turn_state_machine`): while `ptp_active`, the generic attempts/escalation-stage ladder is suspended entirely — the case only escalates via `ptp_overdue` (`sim_day >= ptp_target_day`), `ptp_payment_failed` (a `click_payment_link` attempt while outstanding fails — composes with `forced_reason`), or an explicit human request; a successful capture clears `ptp_active`. Customer-facing dates are real calendar strings, never `sim_day` (`_ordinal`, `_format_calendar_date`; `salary_reminder_date_label` uses `recovery._next_salary_window`, `ptp_target_date_label` uses a plain `+5`-day offset). New reminder-cadence gate (`reminder_cta`/`reminder_days`, `_classify_reminder_cta`/`_reminder_gate`), applied only to the pre-PTP nudge ladder when the turn's outcome is still `"ongoing"`: the identical ask is suppressed same-day (`send_message`/`advance_conversation` can return `{"suppressed": true, "turn"/"agent_turn": None}` instead of a duplicate bubble) and escalates as `reminders_exhausted` past 3 distinct days; a genuinely different ask resets the cap. New escalation reasons: `ptp_overdue`, `ptp_payment_failed`, `reminders_exhausted`. Details: `AGENTS_CONTRACT.md` §12/§13 S10. | **done** |
| `app/agents/triage.py` | **Human Review Triage.** Pipeline stage between Recovery and Audit. `run(session)` opens one priority-scored ticket per `flagged`/`exception` event that has none (idempotent, never reopens closed work); `_classify(event, trail)` → `TicketReason` from the event's own audit trail; `_priority(reason, event)` = `PRIORITY_BASE[reason] + min(15, amount/5000)`; `_summarize(...)` writes the plain-English "why a human is needed" line; `priority_band(n)` → critical/high/medium/low. Human actions: `assign_ticket(ticket_id, employee_email)` (open → under_review, one owner), `resolve_ticket(ticket_id, employee_email, outcome, note, recovered_amount=None)` (under_review → resolved/unresolved; money bounded by what is still at risk; updates `Event.human_recovered_amount` and flips the event to `recovered` when nothing is outstanding), `raise_customer_question(event_id, question, channel, employee_email)`. `compute_ticket_metrics(session)` → the `tickets` block. Every human action writes an `agent="human"` audit row. | **done** |
| `app/agents/ptp.py` | **Promise-to-Pay Tracker (Direction 7).** `record_promise_to_pay()`, `evaluate_ptp_status()`, `compute_ptp_metrics()` — pauses escalation, tracks commitment fulfillment/breaking, computes honor rates. | **done** |
| `app/agents/audit.py` | Audit Agent. `compute_metrics(session) -> dict` (the MetricsBlock — pure read, what the API returns) + `run(session, *, settings=None) -> list[str]` (writes one `batch_metrics` row on the earliest event). Full-batch metrics + complete honest exception list. Details: `AGENTS_CONTRACT.md` §7/§8. | **done, step 6** |
| `app/pipeline.py` | `run(database_url=None, *, settings=None) -> dict` chains Detection→Diagnosis→Recovery→Audit over the seeded batch and returns the MetricsBlock; argparse CLI (`--reset`, `--count`, `--seed`, `--json`) with a printed summary. | **done, step 7** |
| `app/webhooks/__init__.py`, `app/webhooks/listener.py` | Razorpay **test-mode** webhook listener (`POST /webhooks/razorpay`), mounted in `main.py`. `verify_signature(body, signature, secret)` (HMAC-SHA256, constant-time), `razorpay_event_to_eventcreate(event)` (maps `payment.failed` / `payment_link.expired` / `invoice.expired` / `subscription.halted` → `EventCreate`; success/unknown → `None`), `AT_RISK_EVENTS`, `SUCCESS_EVENTS`. Signed → inserts a `detected` event + one `ingested_webhook_event` audit row; the pipeline then runs on it unchanged. Idempotent (dedup by event id). **Capture wiring (2026-09-05, AGENTS_CONTRACT.md §11 P6):** `CAPTURE_EVENTS = {"payment.captured": "payment", "payment_link.paid": "payment_link"}` — on either event, `_handle_capture_webhook` extracts `entity.notes.event_id` (fallback `entity.reference_id`) via `_capture_event_id`, then calls `payment.apply_capture(..., source="razorpay_webhook")`. Unmatched `event_id` or already-`CAPTURED` → `{"status": "ignored"}` (idempotent against redelivery). | **done, step 9** |
| `app/api/__init__.py`, `app/api/routes.py` | REST routers to the frozen contract (`/api/events`, `/api/events/{id}/audit`, `/api/events/{id}/similar`, `/api/events/{id}/voice`, `/api/events/{id}/voice/audio`, `/api/events/{id}/sequencer`, `POST /api/events/{id}/ptp`, **`POST /api/events/{id}/playground/start\|message\|advance\|pay`** (Simulate — sandboxed rehearsal, reads DB never writes), `/api/metrics`, `/api/pipeline/run`), mounted in `main.py`. **2026-09-05:** `PlaygroundStartRequest.mode` default changed to `"custom"` (`"custom"`/`"ai"`/legacy `"interactive"`/`"auto"` all accepted, echoed back verbatim); `PlaygroundMessageRequest` gained `speaker` (`"customer"`\|`"agent"`), `sim_state`, `outcome`; `PlaygroundAdvanceRequest`/`PlaygroundPayRequest` gained `sim_state`; `playground_pay` now calls `playground.click_payment_link` (was `simulate_payment`, kept as an alias in `playground.py`). **2026-09-05:** `PlaygroundPayRequest` gained `forced_reason: str \| None`, passed straight through to `click_payment_link(forced_reason=...)`. See §5. | **done, step 8** |
| `app/api/payment_routes.py` | **`/pay/:token` fake-checkout backend surface (new, 2026-09-05).** Not the ops dashboard — the standalone page a real customer lands on from an SMS/WhatsApp link. `GET /api/pay/{token}` → masked display data (`_find_by_token` linear-scans `payment_link_id`, small batch so no dedicated index needed); `POST /api/pay/{token}/attempt` → `payment.resolve_fake_capture` (attempt = count of prior `payment_capture_failed` audit rows + 1, via `_failed_attempts`) then `payment.apply_capture(..., source="fake_gateway")` on success — a real DB write, the batch pipeline's genuine payment surface, UI-fronted. Bounded to `MAX_ATTEMPTS=3`; the 4th+ attempt is **HTTP 409** (`AGENTS_CONTRACT.md` §13 P7). Mounted in `main.py` by team-lead (the builder leaves it unmounted by design). | **done** |

### 3.4 `backend/tests/`

| File | Purpose |
|---|---|
| `conftest.py` | Fixtures: `_require_postgres` (session-scoped, non-autouse, `pytest.skip` if DB unreachable, 3s connect timeout), `test_database_url`, `session` (per-test `reset_db` + `Session`, depends on `_require_postgres`), `_offline_embeddings` (autouse — `app.llm.embed` raises, RAG degrades offline by default), **`_no_real_razorpay` (autouse, new 2026-09-05) — unsets `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` and clears `get_settings`'s `lru_cache` for every test, so the full-pipeline integration tests never call the real Razorpay API even when a developer's local `.env` has real test-mode keys configured (needed to hand-test the webhook listener). Without this, `test_pipeline.py` would burn Razorpay's 30-test-link quota and leave most events non-terminal (`AWAITING_CAPTURE`).** |
| `test_store.py` | 18 tests — schema DDL, insert/update lifecycle, status queries, audit trail, FK enforcement, and the Pydantic schema layer (bounds, `extra="forbid"`, normalisation). 13 need Postgres, 5 don't. |
| `test_generate.py` | 7 tests — batch size/coverage, validity, amount & days_overdue bounds, no-gateway-reason invariants, determinism, fraud-cluster signature, and DB seeding (1 needs Postgres). |
| `test_sequencer.py` | 3 tests — salary window date calculation, rail detection, compliance tags, and multi-step schedule validation. |
| `test_voice.py` | 5 tests — deterministic offline Hinglish script generation (2); Sarvam TTS: unavailable without key, synthesizes every turn with the right per-speaker voice (mocked `httpx`), degrades on provider error (3). |
| `test_ptp.py` | 2 tests — promise recording, state transitions (`promised` → `honored`/`broken`), escalation pause, and aggregate PTP metrics. |
| `test_llm.py` | 8 tests — provider auto-detect priority (anthropic→openrouter→openai), explicit `LLM_PROVIDER` override, `available()` / `model_label()`, `LLMUnavailable` when no key; **`chat_turns()`: available gate, correct multi-turn dispatch, `LLMUnavailable` without key, OpenRouter explicit override.** All offline (monkeypatched). |
| `test_playground.py` | Extended 2026-09-05 (33 tests) — original coverage (`pick_channel` mapping, persona masking, deterministic offline fallback reaching a terminal outcome, LLM-path prompts, malformed-JSON safety, the sandboxing DB-snapshot guarantee) **plus**: `CUSTOMER_RESPONSE_PROBABILITY` roll determinism per `(event_id, turn_index)`; an in-scope multi-question exchange is not truncated/force-escalated; `_HUMAN_REQUEST_PATTERNS` escalates immediately regardless of attempt count with a well-formed `escalation` object (`reason="customer_requested_human"`); exhausting `MAX_RETRY_ATTEMPTS`/`MAX_ESCALATION_STAGE` escalates with `reason="out_of_scope"`/`"max_attempts_exceeded"`; `outstanding_asks` populate via `_ASK_PATTERNS` and clear via `_clear_addressed_asks`; anti-repetition swaps in `_alternate_phrasing` when the deterministic fallback would repeat `last_reply_text`; **the sandboxing edge**: `click_payment_link` calls `payment.resolve_fake_capture` but a spy/mock proves **zero** calls to `payment.apply_capture`. All offline except the sandboxing tests (`session`). |
| `test_payment.py` | New 2026-09-05 (23 tests) — fake link/token shape; `resolve_fake_capture` determinism (same inputs → same output) and the `attempt`-salt fix (different attempt → can vary outcome, AGENTS_CONTRACT.md §13 P5); `customer_fake_balance < amount` forces `insufficient_funds` on every attempt; `apply_capture` sets/doesn't-set `RECOVERED` correctly and always logs with `agent=Agent.RECOVERY`; a real-link HTTP failure (timeout/4xx/5xx, mocked `httpx`) degrades to the fake gateway without raising; webhook capture via both `notes.event_id` and `reference_id`; unmatched/duplicate webhook delivery → ignored/200; `/pay/:token` router: display data, successful/failed attempt, the 3-attempt bound returning **HTTP 409**. |

### 3.5 `frontend/`

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage production container (`node:20-alpine` builder → `nginx:alpine-slim` runtime). Builds static assets and serves via Nginx on port 80. |
| `nginx.conf` | Production Nginx configuration: SPA routing (`try_files $uri $uri/ /index.html`), reverse proxy to backend `/api/`, `/health`, and `/webhooks/`, gzip compression, and static asset caching. |
| `.dockerignore` | Excludes `node_modules`, `dist`, `.env*`, and git files from Docker context. |
| `package.json` | React 19, `react-dom`, `recharts`; dev: `@tailwindcss/vite`, `tailwindcss`, `vite`, `typescript`, `@vitejs/plugin-react`, `oxlint`, `@types/*`. Scripts: `dev`, `build` (`tsc -b && vite build`), `lint`, `preview`. |
| `vite.config.ts` | Plugins `react()`, `tailwindcss()`. Dev server on `5173`, proxies `/api` and `/health` → `http://localhost:8000`. |
| `src/index.css` | `@import "tailwindcss";` — Tailwind v4 single-line setup. |
| `src/main.tsx` | Mounts `<App/>` into `#root` under `<StrictMode>`. |
| `src/App.tsx` | **Restructured 2026-09-05**: `/pay/:token` is now a top-level sibling route rendered *without* `AppShell` chrome (`PayCheckout`, a public-facing page a real customer lands on from an SMS/WhatsApp link); every other route moved into a `DashboardRoutes` component still wrapped in `AppShell`. |
| `src/api/client.ts` | `request<T>()` fetch wrapper (JSON, throws on non-2xx). `api.health()`, `listEvents`, `getAuditTrail`, `getSimilar`, `getVoiceScript`, `getSequencerSchedule`, `recordPTP`, `getMetrics`, `runPipeline`; **`getPaymentPage(token)`** (`GET /api/pay/{token}`), **`attemptPayment(token)`** (`POST /api/pay/{token}/attempt`, 2026-09-05). |
| `src/api/fixtures.json` | Sample of every API response shape (`events`, `eventAudit`, `pipelineRun`, `metrics`) per `AGENTS_CONTRACT.md` §8. **Regenerated from a real seed-42 pipeline run** (74 events, 40 exceptions). Default data source until `VITE_DATA_SOURCE=live`. |
| `src/api/types.ts` | TypeScript types for the contract (`EventRead`, `AuditRead`, `MetricsBlock`, `ByRootCause`, `ByIntervention`, `ExceptionRow`, `FraudCluster`, `SimilarCase`, `EventSimilarResponse`, `VoiceScript`, `RetryStep`, `PTPMetrics`, `TicketRead`, `TicketStatus`, `TicketReason`, `TicketMetrics`, `TicketsResponse`, `TicketDetailResponse`, response wrappers). **2026-09-05:** `PlaygroundMode` extended to `'custom' \| 'ai' \| 'interactive' \| 'auto'`; new `PlaygroundSimState` (mirrors `AGENTS_CONTRACT.md` §12's frozen shape: `mode`, `controlled_by`, `sim_day`/`sim_hour`/`exchanges_today`, `attempts_so_far`, `escalation_stage`, `customer_last_responded_day`, `customer_response_probability`, `outstanding_asks`, `last_reply_text`, `capture_attempts`), `PlaygroundEscalationReason`, `PlaygroundEscalation` (`reason`, `outstanding_asks`, `last_customer_message`, `root_cause`, `attempts_so_far`, `conversation_summary`); `sim_state`/`escalation`/`no_response` fields added to every Playground request/response interface; new `PaymentPageResponse`, `PaymentAttemptFailureReason`, `PaymentAttemptResponse` for the `/pay/:token` surface. **2026-09-05 (Controls & Actions rework):** `PlaygroundSimState` gained `salary_reminder_day?: number`; new `ForcedPaymentReason` (`'success'\|'wrong_otp'\|'wrong_password'\|'user_cancelled'\|'insufficient_funds'`) — the tester's explicit pick at the embedded fake-checkout screen. **2026-09-05 (S10, PTP/reminder bugfix):** `PlaygroundSimState` gained `salary_reminder_date_label?`, `ptp_active?: boolean`, `ptp_target_day?: number`, `ptp_target_date_label?: string`, `reminder_cta?: string`, `reminder_days?: number[]`; `PlaygroundEscalationReason` gained `'ptp_overdue'\|'ptp_payment_failed'\|'reminders_exhausted'`; `PlaygroundMessageResponse.turn` and `PlaygroundAdvanceResponse`/`PlaygroundMessageResponse` gained `suppressed?: boolean` (`turn`/`agent_turn` now nullable — a same-day reminder-cadence duplicate). |
| `src/api/dataSource.ts` | The adapter every page calls: `listEvents` / `getAuditTrail` / `getMetrics` / `getSimilar` / `getVoiceScript` / `getVoiceAudio` / `getSequencerSchedule` / `recordPTP` / `getTickets` / `getTicket` / `assignTicket` / `resolveTicket` / `raiseQuestion` / `runPipeline` / `playgroundStart`, `playgroundMessage`, `playgroundAdvance` (all now thread `sim_state` through; `playgroundMessage` gained `speaker`/`outcome` params), **`playgroundPay`** (calls `click_payment_link`; **2026-09-05:** takes an optional `forcedReason: ForcedPaymentReason` arg, threaded through `client.ts` as `forced_reason` in the POST body — fixture/offline mode also honors it, building the matching failure/success turn and `salary_reminder_day` locally), **`getPaymentPage`, `attemptPayment`** (2026-09-05, `/pay/:token` surface). Fixture-mode **tickets are sticky** (in-memory array) so the take→resolve sequence actually demonstrates; event fixtures stay read-only. |
| `src/api/actionLabels.ts` | Plain-business-English labels for agent / status / root cause / intervention / audit action / event type / ticket status / ticket reason. **Extended 2026-09-05:** `AuditCategory` (`payment`, `customer`, `intervention`, `diagnosis`, `commitment`, `safety`, `human`, `simulation`), `CATEGORY_THEME` with color-codings and icons, `getAuditCategory(action, agent)`, and labels for payment engine, customer actions, and simulation lifecycle. |
| `src/components/*` | `AppShell` (nav now includes **⚡ Simulate** link), `Card`, `GlassCard`, `StatTile`, `StatusPill`, `DataTable`, `ChartCard`, **`AuditTimeline`** (**revamped 2026-09-05** — the unified, systemized audit log engine across ticket details, case details, and simulation sandbox: strict chronological sorter, first-class customer action badges, 7 category themes with count-badged filter pills, and inline cards for Payment Links, Mandate Renewals, Captured receipts, and PTP deadlines), `DetailDrawer`, `SimilarCases` (RAG panel), `VoiceCallDrawer`, `PTPModal`, `SequencerTimeline`, `TicketDrawer` (embeds `AuditTimeline`), `TicketActionModals`, `TicketPills`, `ReviewerSignIn`, `Feedback`, **`SimulateSession`** (see dedicated row below). |
| `src/components/SimulateSession.tsx` | **Rewritten 2026-09-05**: Liquid-glass 4-column layout (Transcripts / Agent Event Logs / phone mockup / Controls & Actions). Left columns: smartphone chat/call mockup with live voice/text interaction, takeover toggles, and barge-in support; structured transcripts and **Unified Audit & Event Trail** embedding `AuditTimeline` — pre-loads the case's historical DB decision trail and live-appends customer actions (link clicks, OTP entries, customer replies, silence) and agent decisions in strict chronological order. **Controls & Actions panel reworked (2026-09-05):** removed the redundant "Tester Input" box and the "Simulate Customer Actions" button group (the dead `logAction` no-op stub and its ~10 call sites also removed — `logSimulatedEvent` was always the real logging path); the "AI Simulation Engine" card is now one vertical stack in order Next Turn → Auto-Run → Out-of-Scope Query → Force Human Escalation → Record Promise to Pay (PTP). **PTP redesigned 2026-09-05 (S10, bugfix):** `ticketStatus` is now `'none'\|'ptp_pending'\|'human_review'\|'recovered'` — a Promise-to-Pay is its own "Awaiting Settlement" track, no longer conflated with human review (previously the banner said "Routed to Human Review" the instant a PTP was recorded, and a backend bug could immediately re-escalate it same-turn). `isActionable` (`outcome==='ongoing'||'ptp_promised'`) now gates Next Turn/Auto-Run/the chat input/PTP button — a PTP is a wait, not a stop, so the tester can keep advancing turns/days to watch it resolve (payment) or go overdue; only a genuinely terminal outcome (resolved/escalated/halted) locks the conversation. `applyOutcome` logs `ptp_recorded` (not "ticket opened") when a promise starts, `ptp_broken` (not generic `escalation_triggered`) when a PTP specifically breaks, and `ticket_closed_recovered` on payment. `send`/`advance`/`playToResolution` now handle a `suppressed`/null-turn response (the backend's reminder-cadence guard) by skipping playback of a phantom duplicate bubble instead of crashing on a null turn, and `playToResolution`'s loop no longer stops on `ptp_promised` (only on a truly terminal outcome). Payment/mandate links inside any turn's text (`LINK_PATTERN`, matches `rzp.io`/`razorpay.me`) render as clickable buttons (`renderMessageText`) that open a new **embedded fake-checkout screen** swapped in for the WhatsApp body (`phoneView: 'chat'\|'checkout'`) — masked amount/customer header plus a tester-picked mistake list (`CHECKOUT_MISTAKE_OPTIONS`: succeed / wrong OTP / wrong email-password / press back / insufficient balance), each calling `handleCompletePayment(forcedReason)` → `dataSource.simulatePlaygroundPayment(..., forcedReason)`, with a "‹ Back to WhatsApp" bail-out that makes no API call. Failure reasons are labeled via `FAILURE_REASON_LABEL` in the audit trail (e.g. "Failed: Insufficient Balance"). **`begin()` now always requests `channel: 'message'`** from `startPlayground` (was: no channel passed, letting the backend's `pick_channel(event)` auto-select call vs. WhatsApp by root cause) — the embedded checkout and reworked panel only exist on the WhatsApp rail, so a call-mapped case (`insufficient_funds`, `card_declined`, etc.) would otherwise open on the voice-call screen with none of it available. |
| `src/pages/*` | `Overview` (KPI tiles + charts), `Queue` (at-risk table + decision drawer), `Recovery` (analytics), `Exceptions` (fraud-cluster alert + exception table + CSV export), `Attention` (priority-ordered human review queue), `Playground` (case picker page — select a case and mode, then hands off to `SimulateSession`; **gained a "Simulation settings" `Card` 2026-09-05** — a data-source toggle, "Synthetic seed batch" (default) vs "Razorpay test-mode records only" filtering the case list to events whose `payment_link_id` starts with `plink_`; disabled with an explanatory note when no such events exist in the current dataset), **`PayCheckout`** (new 2026-09-05 — standalone `/pay/:token` page, no `AppShell` chrome; fetches the link via `getPaymentPage`, simulates an OTP-entry step, calls `attemptPayment` on submit, shows the failure reason with a bounded retry, a terminal "contact support" state past `MAX_ATTEMPTS`/HTTP 409). |
| `src/lib/*`, `src/charts/series.ts`, `src/hooks/useAsync.ts` | `format.ts` (Indian ₹ grouping), `csv.ts`, `session.ts` (reviewer work-email in `localStorage` — attribution, **not** auth), chart series colours + `PRIORITY_COLOR` / `TICKET_STATUS_COLOR`, async loading hook. |
| `tsconfig.app.json` | + `resolveJsonModule` (fixtures import). `package.json` + `react-router-dom`. |
| `tsconfig*.json`, `.oxlintrc.json`, `index.html`, `public/*` | Vite/TS defaults. |
| `.env.example` | `VITE_API_BASE_URL=` (blank in dev). |
| `.env` | **`VITE_DATA_SOURCE=live`** — created to fix Sarvam TTS (the missing file caused the data source to default to `"fixtures"`, which never calls the backend). **Edit requires frontend dev-server restart.** Not committed (`.gitignore`). |

---

## 4. `app/config.py`

| Symbol | Kind | Notes |
|---|---|---|
| `Settings` | `pydantic_settings.BaseSettings` | `env_file=".env"`, `extra="ignore"`. Fields: `database_url`, `test_database_url`, `frontend_origin`; **LLM (all optional):** `llm_provider`, `anthropic_api_key`/`anthropic_model`, `openrouter_api_key`/`openrouter_model`/`openrouter_base_url`, `openai_api_key`/`openai_model`/`openai_embed_model`/`openai_base_url`; **RAG:** `rag_enabled` (`True`), `rag_top_k` (`5`), `rag_bucket_cap` (`200`), `rag_dedup_distance` (`0.05`); `razorpay_key_id/secret/webhook_secret`; **payment-capture engine:** `use_real_razorpay_payment_links` (`False` by default — the fake gateway is used even when both Razorpay keys are configured; must be explicitly opted into, since Razorpay's test mode caps a business account at 30 payment links total and auto-attempting once that's hit just silently falls back anyway), `payment_engine_base_url` (default `http://localhost:5173`, builds `{base}/pay/{token}` for the fake gateway), `fake_gateway_success_rate` (`0.65`, global default — root-cause-specific rates still come from `recovery.SUCCESS_RATES`). Each from the same-named env var. |
| `get_settings()` | function, `@lru_cache` | Returns the process-wide `Settings` singleton. |

---

## 5. `app/main.py` — FastAPI app

| Symbol | Kind | Notes |
|---|---|---|
| `settings` | module global | `get_settings()` |
| `lifespan(app)` | async context manager | On startup calls `store.init_db(settings.database_url)` (CREATE TABLE IF NOT EXISTS). |
| `app` | `FastAPI` | `title="AI Revenue Recovery"`, `version="0.1.0"`, `lifespan=lifespan`. |
| CORS | middleware | `allow_origins=[settings.frontend_origin]`, all methods/headers. |
| `health()` | `GET /health` | `→ {"status": "ok"}` |

**Endpoint inventory**

| Method | Path | Handler | Response | Status |
|---|---|---|---|---|
| GET | `/health` | `health` | `{"status":"ok"}` | done |
| GET | `/docs`, `/redoc`, `/openapi.json` | FastAPI built-in | Swagger / ReDoc | done |
| GET | `/api/events` | `routes.list_events` | `{events: EventRead[], count: int}` | **done** |
| GET | `/api/events/{event_id}/audit` | `routes.event_audit` | `{event: EventRead, trail: AuditRead[]}` — 404 if unknown | **done** |
| GET | `/api/events/{event_id}/similar` | `routes.event_similar` | `{event_id, similar: SimilarCase[]}` — RAG nearest cases; `[]` when KB/embeddings off; 404 if unknown | **done** |
| GET | `/api/events/{event_id}/voice` | `routes.event_voice_script` | `{event_id, script: VoiceScript}` — Hinglish call dialogue & WhatsApp copy | **done (Direction 6)** |
| GET | `/api/events/{event_id}/voice/audio` | `routes.event_voice_audio` | `{event_id, available, provider, audio_format, sample_rate, audio: [{index, speaker, audio_base64}]}` — Sarvam TTS clips; `available:false` + `audio:[]` with no `SARVAM_API_KEY` or on provider error; 404 if unknown | **done (Direction 6)** |
| GET | `/api/events/{event_id}/sequencer` | `routes.event_retry_sequencer` | `{event_id, rail, schedule: RetryStep[]}` — Mandate retry schedule | **done (Direction 5)** |
| GET | `/api/tickets` | `routes.list_tickets` | `{tickets: TicketRead[], count, open_count, under_review_count}` — the human review queue, priority desc then oldest first. Optional `?status=open` filter | **done** |
| GET | `/api/tickets/{ticket_id}` | `routes.get_ticket` | `{ticket: TicketRead, event: EventRead \| null, trail: AuditRead[]}` — everything a reviewer needs in one call; 404 if unknown | **done** |
| POST | `/api/tickets/{ticket_id}/assign` | `routes.assign_ticket` | body `{employee_email}` → `{status: "ok", ticket: TicketRead}`; 404 unknown, **409** if already taken or closed | **done** |
| POST | `/api/tickets/{ticket_id}/resolve` | `routes.resolve_ticket` | body `{employee_email, outcome, note, recovered_amount?}` → `{status: "ok", ticket: TicketRead}`; 404 unknown, **409** on a guard violation (not under review, bad outcome, empty note, amount above what is still at risk) | **done** |
| POST | `/api/events/{event_id}/raise-question` | `routes.raise_customer_question` | body `{question, channel?, employee_email?}` → `{status: "ok", ticket: TicketRead}`; 404 unknown event, 422 empty question / bad channel | **done** |
| POST | `/api/events/{event_id}/ptp` | `routes.record_event_ptp` | `{status: "ok", event: EventRead}` — Schedule Promise-to-Pay date | **done (Direction 7)** |
| POST | `/api/events/{event_id}/playground/start` | `routes.playground_start` | body `{mode: "custom"\|"ai"\|"interactive"\|"auto", channel?}` (default `"custom"`; legacy names still accepted and echoed back verbatim) → `{mode, channel, ticket_ref, persona, opening_turn, outcome, history, sim_state}` — opens a sandboxed rehearsal, never writes to store; 404 if unknown event | **done** |
| POST | `/api/events/{event_id}/playground/message` | `routes.playground_message` | body `{history, message, channel, speaker?: "customer"\|"agent", sim_state?, outcome?}` → `{turn, outcome, reasoning, history, sim_state, escalation?}` — `speaker="customer"` (default): tester's line → agent reply; `speaker="agent"`: a human takes over the Resolver, `outcome` trusted as-supplied. Stateless (history + sim_state resent each call) | **done** |
| POST | `/api/events/{event_id}/playground/advance` | `routes.playground_advance` | body `{history, channel, sim_state?}` → `{customer_turn, agent_turn, outcome, reasoning, history, sim_state, escalation?, no_response}` — `"ai"` mode: one Customer turn + one Agent turn (or a simulated non-response), two distinct LLM calls | **done** |
| POST | `/api/events/{event_id}/playground/pay` | `routes.playground_pay` | body `{history, channel, sim_state?, forced_reason?}` → `{turn, outcome, reasoning, history, sim_state, payment_id, amount, captured, reason, escalation?}` — calls `playground.click_payment_link`. `forced_reason` omitted: unchanged weighted random roll via pure `payment.resolve_fake_capture` (never `apply_capture`) — `wrong_otp`/`insufficient_funds`/`user_cancelled`/`success`. `forced_reason` set (`"success"`\|`"wrong_otp"`\|`"wrong_password"`\|`"user_cancelled"`\|`"insufficient_funds"`): the tester's explicit pick at the embedded checkout screen, built locally in `playground.py` without calling `payment.resolve_fake_capture` — `wrong_password` is a playground-only reason, never added to `payment.py`'s `CaptureResult` vocabulary. `insufficient_funds` never escalates: it sets `sim_state.salary_reminder_day = sim_day + 5` (sandbox stand-in for `recovery.SALARY_WINDOW_DAY`) and keeps `outcome="ongoing"` | **done** |
| POST | `/api/pipeline/run` | `routes.pipeline_run` | `{metrics: MetricsBlock, ran_at: str}` — query params `reset`, `count`, `seed` | **done** |
| GET | `/api/metrics` | `routes.get_metrics` | `MetricsBlock` (computed from current DB state, incl. `ptp_metrics`). **Playground sessions never affect this value.** | **done** |
| POST | `/webhooks/razorpay` | `listener.razorpay_webhook` | 503 no secret · 401 bad signature · 200 `{status: accepted\|ignored\|captured, …}` — now also handles `payment.captured`/`payment_link.paid` capture confirmations | **done, step 9** |
| GET | `/api/pay/{token}` | `payment_routes.get_payment_page` | `{token, event_id, customer_name (masked), amount, currency, payment_link_status, attempts_made, attempts_remaining}` — 404 unknown token | **done** |
| POST | `/api/pay/{token}/attempt` | `payment_routes.attempt_payment` | `{captured: bool, reason, attempts_remaining}` — a real DB write via `payment.resolve_fake_capture` + `apply_capture`; 404 unknown token, **409** past 3 attempts (`{status:"error", reason:"max_attempts_exceeded", attempts_remaining:0}`) | **done** |

`main.py` mounts `app.api.router` (prefix `/api`). `EventRead` / `AuditRead`
serialise money as decimal strings (matches `fixtures.json`).

### 5.1 Frozen API response contract (Phase A)

Full shapes and the `MetricsBlock` definition live in
`backend/app/agents/AGENTS_CONTRACT.md` §8; a realistic sample of each is
committed at `frontend/src/api/fixtures.json` (keys `events`, `eventAudit`,
`pipelineRun`, `metrics`). `MetricsBlock` = the plan.md §7 metric block:
`total_at_risk`, `total_recovered`, `overall_recovery_rate`, `event_count`,
`by_root_cause[]`, `by_intervention[]` (each carries `at_risk` + `recovered`
decimal strings so ₹-recovered-by-intervention is available per plan.md §7),
`avg_hours_to_recovery`, `status_breakdown{}`, `exceptions[]` (complete honest
list — never truncated), `fraud_cluster{}`. All money fields are decimal
strings; rates are floats 0–1. Produced by `audit.compute_metrics(session)`;
`audit.run()` additionally writes the one `batch_metrics` audit row. Contract
Q&A resolutions are logged in `AGENTS_CONTRACT.md` §13 (payment-capture engine
+ Playground `sim_state` additions: §11/§12, resolved questions P1-P8/S1-S7).

---

## 6. `app/db/store.py` — controlled vocabulary (enums)

All are `enum.StrEnum` (members compare/serialize as plain strings).

| Enum | Members (value) |
|---|---|
| `EventType` | `failed_payment`, `abandoned_checkout`, `overdue_invoice`, `expired_mandate` |
| `EventStatus` | `detected` → `diagnosed` → `action_taken` → `recovered` \| `exception` \| `flagged` |
| `Agent` | `detection`, `diagnosis`, `recovery`, `triage`, `audit`, `human` — `human` is a real employee acting on a review ticket; their decisions are attributed to them, not laundered through an agent. |
| `RootCause` | `insufficient_funds`, `expired_instrument`, `bank_downtime`, `auth_failure`, `card_declined`, `checkout_abandoned`, `invoice_forgotten`, `suspected_fraud`, `unknown` — Diagnosis Agent output; one Recovery intervention each (see `backend/app/agents/AGENTS_CONTRACT.md` §2). DB column `root_cause` stays `str \| None`; the enum types `EventUpdate.root_cause`. |
| `PTPStatus` | `none`, `promised`, `honored`, `broken` |
| `TicketStatus` | `open` → `under_review` → `resolved` \| `unresolved`. Closed is closed — a later pipeline run never reopens a ticket. |
| `TicketReason` | `suspected_fraud`, `customer_question`, `awaiting_approval`, `exception_no_error`, `invoice_handoff`, `stalled_no_response`, `other` — why the automation handed the case to a person. Priority bases in `app/agents/triage.PRIORITY_BASE`. |
| `PaymentLinkStatus` | `none` → `created` → `awaiting_capture` → `captured` \| `failed` \| `expired` — the unified payment-capture engine's (`app/agents/payment.py`) lifecycle. `EventStatus.RECOVERED` is set only when this reaches `captured`, via `payment.apply_capture` — never from dispatch logic or conversation text (see `AGENTS_CONTRACT.md` §11). |

---

## 7. `app/db/store.py` — table models (persistence)

### `Event` → table `events`

| Column | Type | Default | Notes |
|---|---|---|---|
| `event_id` | `str` | — | **PK** |
| `event_type` | `str` | — | indexed; one of `EventType` |
| `customer_id` | `str` | — | |
| `amount` | `Decimal` | — | `NUMERIC(14,2)` — money at risk |
| `currency` | `str` | `"INR"` | |
| `customer_name` | `str \| None` | `None` | synthetic full name (Faker). Used as the Playground persona display name. Never real PII. |
| `customer_phone` | `str \| None` | `None` | synthetic +91 mobile number. Shown **masked** in `DetailDrawer` (last 4 digits visible). |
| `customer_bank_account` | `str \| None` | `None` | synthetic bank account number. Shown **masked** in `DetailDrawer`. |
| `customer_upi_vpa` | `str \| None` | `None` | synthetic UPI VPA (e.g. `name@okhdfcbank`). Shown unmasked — not sensitive enough to mask. |
| `raw_failure_reason` | `str \| None` | `None` | gateway's words, pre-diagnosis |
| `attempts_so_far` | `int` | `0` | stopping-rule counter |
| `days_overdue` | `int` | `0` | for B2B invoices |
| `created_at` | `datetime` (tz-aware) | `_utcnow()` | `TIMESTAMPTZ` |
| `updated_at` | `datetime` (tz-aware) | `_utcnow()` | bumped on every `update_event` |
| `status` | `str` | `detected` | indexed; one of `EventStatus` |
| `root_cause` | `str \| None` | `None` | filled by Diagnosis Agent |
| `diagnosis_confidence` | `float \| None` | `None` | 0.0–1.0 |
| `recovered_amount` | `Decimal` | `0` | `NUMERIC(14,2)` — the honest **total** |
| `human_recovered_amount` | `Decimal` | `0` | `NUMERIC(14,2)` — of the total, how much a human brought in closing a review ticket. AI-recovered is derived as `recovered_amount - human_recovered_amount`. |
| `promised_date` | `datetime \| None` | `None` | `TIMESTAMPTZ` — Promise-to-Pay (Direction 7) |
| `ptp_status` | `str` | `none` | indexed; one of `PTPStatus` |
| `retry_schedule` | `list[dict] \| None` | `None` | `JSONB` — Mandate Retry Sequencer plan (Direction 5) |
| `payment_link_id` | `str \| None` | `None` | unified payment-capture engine (`app/agents/payment.py`): Razorpay `plink_...` id, or a `fake_...` token when no Razorpay keys are configured |
| `payment_link_url` | `str \| None` | `None` | shown to the customer / used by the `/pay/:token` checkout page |
| `payment_link_status` | `str` | `none` | indexed; one of `PaymentLinkStatus`. **Orthogonal to `ptp_status`** — an event can have an active promise and an awaiting link at once. `EventStatus.RECOVERED` is set only when this reaches `captured`, and only via `payment.apply_capture` |
| `payment_link_sent_at` | `datetime \| None` | `None` | `TIMESTAMPTZ` |
| `payment_capture_source` | `str \| None` | `None` | `"razorpay_webhook"` \| `"fake_gateway"` \| `None` — audit transparency for how a capture was confirmed |
| `customer_fake_balance` | `Decimal \| None` | `None` | `NUMERIC(14,2)` — synthetic bank balance (`app/data/generate.py`); the fake gateway forces `insufficient_funds` when this is below `amount` |

### `Ticket` → table `tickets`

One unit of work for a human reviewer. Opened by `app/agents/triage.py`.

| Column | Type | Default | Notes |
|---|---|---|---|
| `ticket_id` | `str` | — | **PK**, `tkt_NNNN` (sequential via `next_ticket_id`) |
| `event_id` | `str` | — | **FK → events.event_id**, indexed |
| `reason` | `str` | — | indexed; one of `TicketReason` |
| `priority` | `int` | `0` | indexed; higher = more urgent. `PRIORITY_BASE[reason] + min(15, amount/5000)` |
| `status` | `str` | `open` | indexed; one of `TicketStatus` |
| `summary` | `str` | — | plain-English "why a human is needed", generated by `triage._summarize` |
| `detail` | `str \| None` | `None` | extra context — e.g. the customer's question verbatim |
| `assigned_employee_email` | `str \| None` | `None` | who took it |
| `assigned_at` | `datetime \| None` | `None` | `TIMESTAMPTZ` |
| `resolution_note` | `str \| None` | `None` | what the human actually did; copied verbatim into the audit row's `reasoning` |
| `resolution_outcome` | `str \| None` | `None` | `resolved` \| `unresolved` |
| `recovered_amount` | `Decimal` | `0` | `NUMERIC(14,2)` — money this resolution brought in |
| `created_at` / `updated_at` | `datetime` (tz-aware) | `_utcnow()` | `updated_at` bumped on every `update_ticket` |

### `AuditLog` → table `audit_log`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | `int` | identity | **PK**, autoincrement |
| `event_id` | `str` | — | **FK → events.event_id**, indexed |
| `agent` | `str` | — | one of `Agent` |
| `action` | `str` | — | e.g. `classified_root_cause` |
| `reasoning` | `str` | — | human-readable justification (never empty) |
| `payload` | `dict \| None` | `None` | `JSONB` — round-trips as a dict |
| `timestamp` | `datetime` (tz-aware) | `_utcnow()` | `TIMESTAMPTZ` |

### `ResolvedCase` → table `resolved_cases` (RAG knowledge base)

Created **only** when the target Postgres has the `vector` extension
(`store.VECTOR_ENABLED`); otherwise skipped and `app/rag.py` is a no-op.

| Column | Type | Notes |
|---|---|---|
| `id` | `int` | **PK** |
| `event_id` | `str` | indexed; source event (or `ref_NN` for seeded reference cases) |
| `event_type` | `str` | indexed; retrieval is filtered by this |
| `raw_failure_reason` | `str \| None` | |
| `case_text` | `str` | the exact text that was embedded |
| `root_cause` | `str` | indexed; the label |
| `confidence` | `float` | diagnosis confidence when captured (1.0 for reference) |
| `source` | `str` | `pipeline` \| `reference` |
| `created_at` | `datetime` (tz-aware) | `TIMESTAMPTZ` |
| `embedding` | `vector(384)` | pgvector; **HNSW index** `ix_resolved_cases_embedding_hnsw` (`vector_cosine_ops`, m=16, ef_construction=64) |

---

## 8. `app/db/store.py` — Pydantic schema models (validation + API shapes)

Shared config `_STRICT = ConfigDict(extra="forbid", use_enum_values=True, validate_default=True)`.

| Model | Base | Role | Key rules |
|---|---|---|---|
| `EventCreate` | `SQLModel` | input to `insert_event`; future `POST /api/events` body | `event_id`/`customer_id` `min_length=1`; `event_type: EventType`; `amount` `gt=0`, `max_digits=14`; `currency` exactly 3 chars → upper-cased; `attempts_so_far`/`days_overdue` `ge=0`; `status: EventStatus = detected`; `created_at: datetime \| None = None` (optional backdate — the synthetic generator sets it; omitted → table default `_utcnow`). Validators: `_upper` (currency), `_round_money` (quantise amount to `0.01`). |
| `EventUpdate` | `SQLModel` | partial patch for `update_event` | every field `Optional`; `extra="forbid"` rejects unknown keys; `root_cause: RootCause \| None` (bad value → `ValidationError`); `diagnosis_confidence` `ge=0,le=1`; `recovered_amount` `ge=0`; money quantised. Consumed via `model_dump(exclude_unset=True)`. |
| `EventRead` | `SQLModel` | response shape for `GET /api/events` | mirrors all `events` columns. |
| `AuditCreate` | `SQLModel` | input to `log_action` | `event_id`/`action`/`reasoning` `min_length=1`; `agent: Agent`; `payload: dict \| None`. |
| `AuditRead` | `SQLModel` | response shape for audit endpoints | mirrors all `audit_log` columns. |
| `TicketCreate` | `SQLModel` | input to `insert_ticket` | `ticket_id`/`event_id`/`summary` `min_length=1`; `reason: TicketReason`; `priority` `ge=0`; `status: TicketStatus = open`; `detail: str \| None`. |
| `TicketUpdate` | `SQLModel` | partial patch for `update_ticket` | every field `Optional`; `extra="forbid"`; `recovered_amount` `ge=0` and quantised. Consumed via `model_dump(exclude_unset=True)`. |
| `TicketRead` | `SQLModel` | response shape for the `/api/tickets` surfaces | mirrors all `tickets` columns. |

`ValidationError` is a subclass of `ValueError`.

---

## 9. `app/db/store.py` — functions

| Function | Signature | Returns | Notes |
|---|---|---|---|
| `_utcnow()` | `() -> datetime` | tz-aware UTC now | private |
| `get_engine(database_url=None)` | | SQLAlchemy `Engine` | caches a singleton for the default URL; an explicit URL returns a fresh engine |
| `get_session(database_url=None)` | | `Session` | new unit-of-work |
| `init_db(database_url=None)` | | `None` | `SQLModel.metadata.create_all` — idempotent |
| `reset_db(database_url=None)` | | `None` | `drop_all` + `create_all` — fresh slate |
| `insert_event(session, data=None, /, **kwargs)` | `data: EventCreate \| None` | `Event` | validates via `EventCreate` (pre-built or from kwargs), `add`+`commit`+`refresh`. If `created_at` is supplied it is honoured and `updated_at` is set to match; otherwise both fall to the table default. |
| `update_event(session, event_id, data=None, /, **fields)` | `data: EventUpdate \| None` | `Event` | `model_dump(exclude_unset=True)` → `setattr` each; bumps `updated_at`; missing event → `KeyError`; unknown key / bad value → `ValidationError` |
| `get_event(session, event_id)` | | `Event \| None` | by PK |
| `get_events_by_status(session, status)` | `status: str \| Iterable[str]` | `list[Event]` | `WHERE status IN (...)`, ordered by `created_at` |
| `all_events(session)` | | `list[Event]` | ordered by `created_at` |
| `log_action(session, data=None, /, **kwargs)` | `data: AuditCreate \| None` | `int` (new row id) | the ONLY way to write the audit trail; FK-checked (phantom `event_id` → `IntegrityError`) |
| `get_audit_trail(session, event_id=None)` | | `list[AuditLog]` | whole batch or one event, ordered by `id` |
| `next_ticket_id(session)` | | `str` | next free `tkt_NNNN`, sequential so the queue reads chronologically |
| `insert_ticket(session, data=None, /, **kwargs)` | `data: TicketCreate \| None` | `Ticket` | validates via `TicketCreate`; FK-checked (phantom `event_id` → `IntegrityError`) |
| `update_ticket(session, ticket_id, data=None, /, **fields)` | `data: TicketUpdate \| None` | `Ticket` | `model_dump(exclude_unset=True)` → `setattr`; bumps `updated_at`; missing ticket → `KeyError` |
| `get_ticket(session, ticket_id)` | | `Ticket \| None` | by PK |
| `get_tickets(session, status=None)` | `status: str \| Iterable[str] \| None` | `list[Ticket]` | **the review queue** — ordered `priority DESC, created_at ASC` |
| `tickets_for_event(session, event_id)` | | `list[Ticket]` | full history for one case, open and closed |
| `open_ticket_for_event(session, event_id)` | | `Ticket \| None` | any not-yet-closed ticket; how Triage stays idempotent |
| `add_resolved_case(session, *, event_id, event_type, raw_failure_reason, case_text, root_cause, embedding, confidence=1.0, source="pipeline")` | | `ResolvedCase` | insert one labelled case into the RAG KB; raises if pgvector off |
| `nearest_resolved_cases(session, embedding, *, k=5, event_type=None)` | | `list[(ResolvedCase, distance)]` | **the only vector search in the codebase** — cosine distance via the HNSW index, ascending; `[]` when pgvector off |
| `resolved_case_count(session, *, root_cause=None, event_type=None)` | | `int` | KB size, optionally per bucket |
| `trim_resolved_bucket(session, *, root_cause, event_type, cap)` | | `int` | delete oldest rows in a bucket beyond `cap`; returns count removed |
| `_enable_vector(engine)` | | `bool` | `CREATE EXTENSION IF NOT EXISTS vector`; sets `VECTOR_ENABLED` (called by `init_db`/`reset_db`) |
| `main` (`__name__=="__main__"`) | | | `init_db()` + print |

Module constants: `DEFAULT_DATABASE_URL`, `MONEY = Decimal("0.01")`,
`TICKET_CLOSED_STATUSES = (resolved, unresolved)`.

---

## 10. `app/data/generate.py` — synthetic data generator

**Constants**

| Name | Value / meaning |
|---|---|
| `RAZORPAY_FAILURE_REASONS` | `dict[EventType, list[str\|None]]` — real Razorpay test-mode failed-card-payment codes (verified 2026-09-03 against `razorpay.com/docs/payments/payments/test-card-details`): `insufficient_fund`, `card_expired`, `authentication_failed`, `payment_timed_out`, `card_declined`, `card_number_invalid`, `bank_not_available`, `gateway_technical_error` (failed_payment); `mandate_creation_expired/failed` (expired_mandate); `None` for abandoned_checkout & overdue_invoice |
| `_TYPE_WEIGHTS` | 45 % failed_payment, 20 % abandoned_checkout, 20 % overdue_invoice, 15 % expired_mandate |
| `SILENT_ID_PREFIX` / `SILENT_COUNT` | `silent_` / `2` — `build_silent_failures()` adds failed payments with **no** `raw_failure_reason`. Gateways really do return a bare failure; Detection finds no failure signal → `exception` with no root cause → Triage opens an `exception_no_error` ticket. |
| `_MIN_AMOUNT` / `_MAX_AMOUNT` | `₹200` / `₹50000` |
| `CSV_PATH` | `backend/data/synthetic_events.csv` |
| `FRAUD_REASON` | `card_declined` |
| `FRAUD_AMOUNT_LOW` / `_HIGH` | `₹4980` / `₹5020` |
| `FRAUD_ID_PREFIX` | `fraud_` |
| `BATCH_SPAN_DAYS` | `14` — batch `created_at` is backdated/spread over this window (gives the Diagnosis fraud check a real time axis) |
| `FRAUD_WINDOW_MINUTES` | `40` — the seeded fraud cluster falls inside one sub-60-minute window |
| `FRAUD_DAYS_AGO` | `3` — where in the span the cluster sits |

**Functions**

| Function | Signature | Returns | Notes |
|---|---|---|---|
| `_money(value)` | `float -> Decimal` | 2-dp Decimal via `str()` (avoids float-binary expansion that breaks `max_digits`) |
| `_rupees(rng)` | `random.Random -> Decimal` | log-normal amount, clamped to [200, 50000] |
| `_pick_type(rng)` | `-> EventType` | weighted choice |
| `_epoch()` | `-> datetime` | tz-aware "now" the backdating span ends at; taken once per build |
| `build_batch(count=70, seed=42)` | `-> list[EventCreate]` | deterministic (ids/amounts/types); each record a validated `EventCreate`; `event_id = evt_NNN`; `created_at` spread over `BATCH_SPAN_DAYS` |
| `build_fraud_cluster(size=4, seed=42)` | `-> list[EventCreate]` | all `failed_payment`, same `card_declined` reason, amounts in a ±₹40 band, `attempts_so_far` 2–3, distinct customers, all `created_at` inside one `FRAUD_WINDOW_MINUTES` window ~`FRAUD_DAYS_AGO` back, `event_id = fraud_NN` |
| `_to_frame(records)` | `-> pandas.DataFrame` | one row per record (`model_dump`) |
| `generate(count=70, seed=42, reset=True, database_url=None)` | `-> list[str]` | build batch + cluster, optional `reset_db`, `insert_event` each, write CSV, return event_ids |
| `_summary(records)` | `-> str` | count-by-type + total ₹ + fraud ids |
| `main()` | | | argparse CLI: `--count`, `--seed`, `--reset/--no-reset` |

**CLI**

```
uv run python -m app.data.generate --count 70 --seed 42 --reset
```
Example output: `74 events, total at risk Rs 199,558.65` + per-type counts +
`fraud cluster: ['fraud_00','fraud_01','fraud_02','fraud_03']`.

---

## 11. Commands / runbook

| Task | Command | From |
|---|---|---|
| Run full stack (DB + Backend + Frontend) | `docker compose up -d --build` (Dashboard `:3000`, API `:8000`, DB `:5432`) | repo root |
| Start Postgres only (pgvector) | `docker compose up -d db` | repo root |
| Stop containers | `docker compose down` (`-v` wipes the volume → re-seed) | repo root |
| _(No-Docker fallback — RAG disabled)_ | `powershell -ExecutionPolicy Bypass -File scripts\pg.ps1 install` then `… start` | repo root |
| Install backend deps | `uv sync` | `backend/` |
| Create local env | `cp .env.example .env` | `backend/` |
| Init schema manually | `uv run python -m app.db.store` | `backend/` |
| Seed synthetic batch | `uv run python -m app.data.generate --reset` | `backend/` |
| Run the full pipeline | `uv run python -m app.pipeline --reset` (add `--json` for the raw MetricsBlock) | `backend/` |
| Run API (dev) | `uv run uvicorn app.main:app --reload` → `:8000/docs` | `backend/` |
| Ingest live Razorpay test-mode webhooks | set `RAZORPAY_WEBHOOK_SECRET` in `.env`; expose `:8000` (e.g. `ngrok http 8000`); register `<url>/webhooks/razorpay` in the Razorpay **test-mode** dashboard | `backend/` |
| Dashboard against live API | set `VITE_DATA_SOURCE=live` in `frontend/.env`, run backend + `npm run dev` | `frontend/` |
| Run tests | `uv run pytest -q` | `backend/` |
| Install frontend deps | `npm install` | `frontend/` |
| Run frontend (dev) | `npm run dev` → `:5173` | `frontend/` |
| Build frontend | `npm run build` | `frontend/` |

---

## 12. Test inventory

| Suite | Count | Needs Postgres | Covers |
|---|---|---|---|
| `test_store.py` — DDL & CRUD | 22 | yes (skip if down) | all three tables exist, insert/read defaults, update lifecycle + `updated_at`, backdated `created_at` insert, `RootCause` enum enforcement on `update_event`, status queries (single/multi), audit trail + JSONB round-trip, FK enforcement, `reset_db`; **tickets**: insert defaults, sequential ids, priority-then-age ordering, `open_ticket_for_event` ignores closed work but history survives, `update_ticket` bumps `updated_at` + `KeyError`, FK to a real event, `human_recovered_amount` default + quantise |
| `test_store.py` — schema layer | 6 | no | `EventCreate` bounds & rejections, normalisation (currency upper, money quantise, enum→str), `EventUpdate` `extra="forbid"` + confidence bound, `AuditCreate` non-empty reasoning, prebuilt-schema path, `TicketCreate`/`TicketUpdate` strictness (bad enum, empty summary, unknown key, negative amount) |
| `test_generate.py` | 10 | 1 of 10 | size/coverage, validity, amount & days_overdue bounds, no-gateway-reason invariant, `created_at` spread over the span, fraud cluster inside one sub-60-min window, determinism, fraud-cluster signature, **silent failures have no error code**, DB seeding |
| `test_triage.py` | 19 | yes | one ticket per unfinished case (recovered cases get none) and the right reason for each of the five paths; queue ordered most-urgent-first with `stalled_no_response` last; priority is reason-first then amount; idempotent + never reopens closed work; `opened_review_ticket` audit row; assign moves to under_review + one-owner guard + unknown/blank-email guards; resolve records the note as the audit `reasoning`; `unresolved` is a first-class outcome; human recovery credited to `human_recovered_amount` and flips a fully-recovered event; partial recovery leaves the case open-ended; can't recover more than was at risk; every resolve guard; `raise_customer_question` records the question verbatim and outranks a stalled retry; its guards; ticket metrics over a mixed queue and an empty one |
| `test_detection.py` | 12 | yes | `classify` verdict table, flag vs route-to-exception, net `amount_at_risk`, idempotency, only-touches-detected |
| `test_diagnosis.py` | 26 | yes | rules map (12 params), event-type fallback, low-confidence → Claude (monkeypatched), no-key degrade, fraud-cluster flag + signature, ordinary same-reason not flagged, idempotency |
| `test_recovery.py` | 29 | yes | per-intervention routes (7 params), salary-window retry, bank backoff, max-attempts halt, escalation cap (never stage 4), human-approval gate (executed vs not, boundary), cooldown delay, suspected-fraud refusal, never-reads-flagged, template + Claude draft, idempotency |
| `test_audit.py` | 11 | yes (dedicated `revrec_test_aud`) | totals + money-based overall rate, all-six status keys, by-root-cause enum order, by-intervention `at_risk`/`recovered`, avg hours, complete exception list + all reason-derivation paths, fraud cluster, determinism, one `batch_metrics` row, no event mutation, empty batch |
| `test_pipeline.py` | 6 | yes | reset→generate→run: every event terminal, fraud cluster `flagged` + not recovered, metrics over full batch, exception list populated with reasons, rerunnable/stable, `batch_metrics` row written |
| `test_rag.py` | 10 | yes (needs pgvector) | vector extension present, degrade path when embeddings off, reference-case seeding idempotent, retrieve filtered by type + sorted, add/nearest round-trip, dedup-on-insert, skip unknown/low-confidence/fraud, bucket-cap trims oldest, `RevRecEmbeddings` wrapper, Diagnosis feeds RAG context into the LLM prompt |
| `test_api.py` | 12 | yes (needs pgvector) | one module-scoped real pipeline run; `/health`, `/api/events`, `/api/events/{id}/audit` + 404, `MetricsBlock` shape **incl. `ai_recovered + human_recovered == total_recovered`**, `POST /api/pipeline/run`, `/api/events/{id}/similar` + 404; **tickets**: priority-ordered list + status filter + fraud on top, detail carries event + trail + 404, assign→409 double-assign→resolve unresolved with a `human` audit row, resolving with money moves `human_recovered` and leaves `ai_recovered` untouched, guards (409 resolve-before-assign, 404 unknown, 409 over-recovery), `raise-question` opens a `customer_question` ticket + 404/422 |
| `test_webhooks.py` | 12 | 5 need Postgres | `verify_signature` roundtrip/tamper; `razorpay_event_to_eventcreate` per event type + paise→₹ + non-PII customer key + success/unknown/zero → `None`; endpoint: signed `payment.failed` inserts a `detected` event + `ingested_webhook_event` row, 401 bad signature, 503 no secret, ignores success events, idempotent on redelivery |
| `test_llm.py` | **8** | no | provider auto-detect priority (anthropic→openrouter→openai), explicit `LLM_PROVIDER` override, `available()` / `model_label()`, `LLMUnavailable` when no key; **`chat_turns()`**: available gate, correct multi-turn dispatch (provider turns, max_tokens), `LLMUnavailable` without a key, OpenRouter explicit-override path |
| `test_playground.py` | **50** | some need Postgres | `pick_channel` mapping (10 params); persona masks phone/bank, exposes upi_vpa, flags business; offline fallback reaches `resolved`/`escalated`/`halted` in both modes; LLM path (monkeypatched): distinct system prompts, first turn `role=user`, two distinct prompts in auto mode, disposition varies by root cause, malformed JSON degrades, provider error degrades; **sandboxing**: row-count before/after unchanged for interactive + auto full sessions. **2026-09-05 (`forced_reason`, 13 new):** one test per `forced_reason` value (`success`/`wrong_otp`/`wrong_password`/`user_cancelled`/`insufficient_funds`) asserting `captured`/`reason`/reply text; `forced_reason=None` regression test (unchanged random-roll path); insufficient-funds after 5+ attempts stays `ongoing` with no escalation key; `inspect.signature` guard that `click_payment_link` has no `session` param |
| `test_api.py` | **16** | yes (needs pgvector) | one module-scoped pipeline run; `/health`, `/api/events`, audit + 404, `MetricsBlock` shape incl. `ai_recovered + human_recovered == total_recovered`, pipeline run endpoint, similar + 404; ticket queue: priority-ordered + status filter + fraud on top, detail + 404, assign→resolve with a `human` audit row, money split guards; `raise-question`; **playground**: `start` interactive + auto mode, `message` reaches an outcome, `advance` produces customer+agent turns, **sandboxing: DB row counts + `MetricsBlock` byte-identical before and after a full simulated session** |

Current run against the pgvector container: **226 collected** (`uv run pytest -q`
from `backend/`). New tests: 34 new (26 playground + 8 llm extended) + 4 new API
playground tests. All 34 new tests pass. Run in chunks on low-RAM boxes — the
batch-reseeding pipeline tests can OOM a single process. `test_rag.py` /
`test_api.py` need pgvector.
With Postgres stopped: ~32 passed, the rest skipped.

---

## 13. Build status vs CLAUDE.md Section 9

| Step | Deliverable | Status |
|---|---|---|
| 1 | `store.py` shared event store | ✅ done (SQLModel + Pydantic on Postgres) |
| 2 | synthetic data generator | ✅ done (`app/data/generate.py`) |
| 3 | `agents/detection.py` | ✅ done (12 tests) |
| 4 | `agents/diagnosis.py` (+ fraud triage) | ✅ done (26 tests) |
| 5 | `agents/recovery.py` (+ stopping rules) | ✅ done (29 tests) |
| 6 | `agents/audit.py` (metrics) | ✅ done (11 tests) |
| 7 | `pipeline.py` (single entrypoint) | ✅ done (`app/pipeline.py` + 6 integration tests) |
| 8 | dashboard | ✅ built + browser-verified on live API; RAG "Similar past cases" panel added |
| — | multi-provider LLM (`app/llm.py`) + **RAG knowledge base** (`app/rag.py`, pgvector HNSW) wired into Diagnosis | ✅ done (not a numbered step; plan.md §12) |
| 9 | `webhooks/listener.py` | ✅ done (`app/webhooks/listener.py`, `POST /webhooks/razorpay`, 12 tests) — signed test-mode Razorpay events → `EventCreate` → same pipeline |
| 10 | `readme.md` (submission README + "what broke") + `architecture.md` | ✅ done |
| — | **Simulate / Playground** (`app/agents/playground.py`) + synthetic contact data + Sarvam TTS fix | ✅ done (plan.md §12; 34 new tests) |
| — | **Payment-capture integrity fix + Playground redesign** (`app/agents/payment.py` new, `recovery.py._resolve_outcome` rewrite, `playground.py` rewrite, `/pay/:token` router, webhook capture wiring) | ✅ done (plan.md §14; new `test_payment.py` + extended `test_playground.py` + `_no_real_razorpay` conftest fixture) |
| — | **Systemized Unified Audit Log & Customer Action Trail** (`AuditTimeline.tsx` unified component, customer actions as first-class events, strict chronological sorting, category filter bar, inline cards) | ✅ done (plan.md §15) |

**Deviations from CLAUDE.md** (approved by the owner): Postgres instead of
SQLite; `uv` instead of `pip`/`requirements.txt`; a FastAPI + React monorepo
(`backend/`, `frontend/`) instead of a single Streamlit app — Streamlit dropped.

---

## 14. Known issues / notes

- **Postgres runs as the `pgvector/pgvector:pg17` Docker container** (`docker
  compose up -d`). Docker Desktop + WSL2 work on this machine — the earlier
  "Docker unavailable, Win 11 Home has no Hyper-V" note was wrong. Data lives in
  the `revrec_pgdata` volume; `down -v` wipes it (then re-seed).
- `scripts/pg.ps1` (zonky embedded PG 17) remains as a no-Docker fallback. It
  has **no extensions**, so `store.VECTOR_ENABLED` is `False` there and the RAG
  layer (`app/rag.py`) is a no-op — Diagnosis still works, just without
  retrieval.
- Container auth: `revrec`/`revrec` (password). Never expose port 5432.
- RAG embeddings: with no `OPENAI_API_KEY`, the local `fastembed` model
  (`all-MiniLM-L6-v2`, ~90 MB) downloads once to `%TEMP%\fastembed_cache` on
  first use. Tests never trigger it (`_offline_embeddings` autouse fixture).
- A stale `VIRTUAL_ENV` env var may point at a deleted root `.venv` — harmless,
  `uv` ignores it.
- Schema changes are not migrated (no Alembic yet); `reset_db` (or
  `pg.ps1`-nothing / just re-run the generator with `--reset`) is the current
  way to apply model changes.
- `tests/test_store.py::test_reset_db_clears_everything` must `session.close()`
  before `reset_db` — on Postgres a live session's locks block `DROP TABLE`.
- **Sarvam TTS not working?** The most common cause: `frontend/.env` is missing
  (it's in `.gitignore`). Create `frontend/.env` with `VITE_DATA_SOURCE=live` and
  restart the dev server. Also, `get_settings()` is `@lru_cache`d — restart the
  **backend** after any `.env` edit too.
- **Simulate / Playground works offline** (no LLM key needed) via the deterministic
  fallback in `playground.py`. To see live LLM personas, set any LLM key in
  `backend/.env` and restart the backend.

