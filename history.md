# History — AI Revenue Recovery

Running changelog. Newest entry first. Each entry is a short brief; the full
reference lives in [documentation.md](documentation.md) and
[architecture.md](architecture.md).

## 2026-09-05 — Simulate tab: PTP escalation bugfix + reminder cadence

- **Did:** The user pasted a live rehearsal transcript and caught a real bug
  by hand: the agent logged "Promise-to-Pay recorded" and the very next line
  was "Escalated to human review queue: max attempts exceeded" — a customer
  who'd just agreed to pay was silently re-escalated in the same turn, purely
  because `_resolve_escalation_reason` checked the attempts/escalation-stage
  ceiling with no regard for what the outcome already was that turn. Also
  flagged: the same failure message ("aapne payment cancel kar diya") sent
  twice back-to-back with identical timestamps (no reminder-spam guard); the
  `insufficient_funds` reschedule said "Day 8" instead of a real date; and
  once a PTP was recorded, Next Turn/Auto-Run went dead (`outcome!=='ongoing'`
  disabled them), so there was no way to ever see a promise resolve or go
  overdue. Dispatched `simulation-engine-builder` for
  `backend/app/agents/playground.py`: (1) `_resolve_escalation_reason` now
  never fires the attempts ceiling when `base_outcome` is `ptp_promised`/
  `resolved`; (2) a full PTP state machine (`ptp_active`/`ptp_target_day`/
  `ptp_target_date_label`, `_activate_ptp_if_needed`/`_apply_turn_state_machine`)
  decouples a promise from the generic attempts ladder entirely — while
  active, escalation can only come from `ptp_overdue` (promised date passes
  unpaid), `ptp_payment_failed` (a `click_payment_link` attempt while
  outstanding fails — composes with `forced_reason`), or an explicit human
  request; researched the real `app/agents/ptp.py` design first
  (`PROMISED→HONORED|BROKEN`, broken = overdue past a 24h grace period) to
  confirm a promise is meant to pause escalation, not accelerate it; (3) real
  calendar-style dates (`_ordinal`/`_format_calendar_date`, reusing
  `recovery._next_salary_window` for the salary reschedule) replace all
  `"Day N"` customer-facing text; (4) a reminder-cadence gate
  (`reminder_cta`/`reminder_days`, `_classify_reminder_cta`/`_reminder_gate`)
  suppresses an identical same-day reminder and escalates as
  `reminders_exhausted` past 3 distinct days, resetting on a genuinely
  different ask — `send_message`/`advance_conversation` can now return
  `{"suppressed": true, "turn"/"agent_turn": None}`. Frontend
  (`SimulateSession.tsx`): `ticketStatus` split `'ptp_pending'` (its own
  "Awaiting Settlement" banner) from `'human_review'` (only reached via a real
  escalation now); new `isActionable` (`outcome==='ongoing'||'ptp_promised'`)
  gates Next Turn/Auto-Run/chat input/the PTP button so the tester can watch a
  promise play out instead of the session going dead the instant it's
  recorded; `send`/`advance`/`playToResolution` handle the new
  `suppressed`/null-turn shape instead of crashing on it.
- **Verified:** Researched the real `ptp.py`/`TicketReason`/`recovery.py`
  salary-window design first (no PTP-specific ticket reason exists today, no
  dedicated PTP dashboard section exists in the real app either, real
  salary-window dates are raw ISO timestamps with no human formatting) so the
  sandbox redesign's terminology and escalation timing genuinely mirrors
  the real product's intent rather than inventing new semantics.
- **Docs:** `AGENTS_CONTRACT.md` §12/§13 (new entry S10), `documentation.md`
  (`playground.py` and `SimulateSession.tsx` rows, top changelog),
  `architecture.md` (§6.2 corrected sequence diagram, §7 component row, §8
  five new/updated decision rows, top changelog), `plan.md` §12 — all updated
  in this pass.
- **Tests:** `uv run pytest tests/test_playground.py tests/test_api.py -q` →
  all green (64 in `test_playground.py`, 15 new). `npx tsc -b` / `npm run
  build` (frontend) both clean.
- **Next:** Flagged by the builder agent and worth knowing: the reminder-cadence
  gate's `reminders_exhausted` (4th distinct day) and the generic attempts
  ceiling (`MAX_RETRY_ATTEMPTS=3`) are independent counters that both advance
  once per non-PTP turn — in a typical one-exchange-per-day conversation the
  attempts ceiling will usually fire first, so `reminders_exhausted` is fully
  correct and unit-tested but rarely the *first* reason to trigger in
  practice. Not a bug, just worth knowing if a demo run doesn't visibly hit
  it. Still not done: an actual manual click-through in a running dev server
  watching a PTP go all the way to overdue.

---

## 2026-09-05 — Simulate tab Controls & Actions rework

- **Did:** Fixed the Simulate tab's right-hand "Controls & Actions" panel
  (`frontend/src/components/SimulateSession.tsx`), per user-reported UX
  drift: removed the redundant "Tester Input" box (duplicated the live
  WhatsApp chat input) and the "Simulate Customer Actions" button group (two
  canned-string buttons plus a "Click Link & Pay" button that was disabled
  exactly when it was needed, post-PTP); deleted the dead `logAction` no-op
  stub and its ~10 call sites (the real logging path, `logSimulatedEvent`,
  was always separate). Rebuilt the "AI Simulation Engine" card as one
  vertical stack: Next Turn → Auto-Run → Out-of-Scope Query → Force Human
  Escalation → Record Promise to Pay (PTP). PTP now behaves like a real
  triage hand-off — a `ticketStatus` state (`'none'|'ptp_human_review'|'recovered'`)
  shows a banner and disables the AI-engine buttons while the case is "with a
  human," clearing to "recovered" once the customer later pays. Payment/mandate
  links in any turn's text are now clickable (`renderMessageText` + `LINK_PATTERN`)
  and open a new embedded fake-checkout screen swapped in for the WhatsApp
  body (`phoneView: 'chat'|'checkout'`) — masked amount/customer header plus a
  tester-picked mistake list (succeed / wrong OTP / wrong email-password /
  press back / insufficient balance), with a "‹ Back to WhatsApp" bail-out
  that makes no API call. Backend: dispatched `simulation-engine-builder` for
  `backend/app/agents/playground.py` — added `click_payment_link(...,
  forced_reason=None)`; `None` keeps the exact original random-roll behavior
  via `payment.resolve_fake_capture` (regression-guarded); a tester-picked
  value builds the `CaptureResult` locally (`wrong_password` is playground-only,
  never added to `payment.py`'s frozen vocabulary); `insufficient_funds` never
  escalates — it sets `sim_state.salary_reminder_day = sim_day + 5` (sandbox
  stand-in for `recovery.SALARY_WINDOW_DAY`) and states the rescheduled day in
  the reply. Wired `forced_reason` through `routes.py`'s `PlaygroundPayRequest`
  and the frontend `types.ts`/`client.ts`/`dataSource.ts` (including the
  offline-fixture path). `payment.py`, `payment_routes.py`, and `PayCheckout.tsx`
  (the real DB-writing `/pay/:token` flow) were not touched.
- **Verified:** No new Razorpay API surface — this is a sandboxed rehearsal
  feature reusing already-verified test-mode failure reasons; no fresh source
  re-check needed. `AGENTS_CONTRACT.md` §12/§13 updated with new decision-log
  entry S9 by the builder agent.
- **Docs:** `documentation.md` (Playground endpoint row, `playground.py` file
  row, `SimulateSession.tsx`/`types.ts`/`dataSource.ts` rows, test inventory,
  top changelog) and `architecture.md` (§6.2 new sequence diagram, §7
  component row, §8 three new design-decision rows, top changelog) both
  updated in this pass; `plan.md` §12 got a matching dated entry.
- **Tests:** `uv run pytest tests/test_playground.py tests/test_api.py -q` →
  66 passed. `npx tsc -b` and `npm run build` (frontend) both clean.
- **Next:** Manually walk the golden path in a running dev server (Next
  Turn/Auto-Run to a payment link → click it → try each mistake option →
  successfully pay → confirm ticket-status banner clears) — not yet done this
  session, only automated tests + type-checks were run.
- **Follow-up same day:** user opened a call-mapped case (root cause
  `insufficient_funds` etc. route to voice call via `pick_channel`) and got
  the voice-call screen instead of WhatsApp — not a regression from this
  session's work, but the new embedded-checkout/panel rework only exists on
  the message rail. Fixed by having `SimulateSession.tsx`'s `begin()` always
  request `channel: 'message'` explicitly from `startPlayground`, overriding
  the root-cause auto-pick for the Simulate tab. Call-mode UI code is left in
  place (untouched, just unreachable via the Simulate tab now) in case it's
  wanted back later.

---

## 2026-09-05 — Systemized Unified Audit Log & Customer Action Trail

- **Did:** Unified the AI pipeline decision trail and simulation event logs into one standardized, systemized, color-coded audit log component (`frontend/src/components/AuditTimeline.tsx`), deployed consistently across Ticket Details (`TicketDrawer.tsx`), Case Details (`DetailDrawer.tsx`), and the Simulation Sandbox (`SimulateSession.tsx` Column 2):
  - **First-Class Customer Actions (`👤 Customer`)**: Customer actions (clicking payment links, viewing fake checkout page, submitting OTPs, typing replies, speaking on call, agreeing to Promise-to-Pay, or silence) are now recorded as explicit first-class audit events in the log.
  - **Strict Chronological Ordering**: Unified sorting engine parses ISO UTC timestamps and simulation game clock offsets into a monotonic `sortKey`, guaranteeing historical batch decisions and live customer interactions are woven together in exact occurrence order.
  - **Semantic Color Coding & Category Filter Bar**: Categorizes all events into 7 distinct visual themes (Payments 💳 with Emerald/Cyan badges, Customer Actions 👤 with Warm Amber cards, Interventions ⚡ with Purple pills, Diagnosis 🔍 with Sky Blue, Commitments 🤝 with Teal, Safety & Halts 🛡️ with Crimson alerts, Human Review 🧑‍💼 with Orange tags, and Sandbox 🧪 markers). Category filter pills at the top allow instantaneous filtering by event type with live item count badges.
  - **Specialized Inline Event Cards**: Clickable Payment Link cards (with link ID, token URL button, amount), Mandate Renewal & Re-auth cards, glowing verified Payment Captured cards with receipt amounts, and Promise-to-Pay commitment deadline cards.
  - **SimulateSession Revamp**: Column 2 ("Unified Audit & Event Trail") pre-loads the event's historical DB decision trail and seamlessly appends live simulation events in real time.

---

## 2026-09-05 — Payment-capture integrity fix + Playground redesign

- **Did:** A second AI agent's follow-on Playground work had left
  `recovery.py._resolve_outcome` marking `status="recovered"` via a hard-coded
  coin flip (`_stable_hash(event_id) % 100 < p`) with **no payment capture,
  conversation outcome, or PTP behind it** — the user caught this by hand as a
  genuine "we could lose the hackathon" risk (a judge could see "recovered"
  events with nothing behind them). Fixed with a team-lead + 2-builder round:
  - **New `backend/app/agents/payment.py`** (payment-engine-builder) — the
    single unified capture engine. `create_payment_link` (real Razorpay
    test-mode `POST /v1/payment_links` when `RAZORPAY_KEY_ID`/`SECRET` are
    configured, else a deterministic `fake_{event_id}` link; any HTTP failure
    degrades silently to the fake path); `resolve_fake_capture` (**pure**, no
    session/DB access, reuses `recovery.SUCCESS_RATES`/`_stable_hash`,
    hash-salted on `f"{event_id}:{link_id}:{attempt}"` so a bounded retry can
    genuinely vary — this exact bug, a retry replaying the identical failure
    forever, was caught and fixed during the Phase B0 plan review before any
    code was written); `apply_capture` — **the only place `Event.status`
    becomes `RECOVERED` from a capture**, always logging with
    `agent=Agent.RECOVERY`. New `PaymentLinkStatus` enum + 6 `Event` columns.
  - **`app/webhooks/listener.py`** wired to consume `payment.captured`/
    `payment_link.paid` via a new `CAPTURE_EVENTS` entity-key map, idempotent
    against redelivery.
  - **New `app/api/payment_routes.py`** — `/pay/:token` fake-checkout surface
    (`GET` display data, `POST .../attempt` a real DB write via
    `resolve_fake_capture`+`apply_capture`, bounded to 3 attempts, **HTTP 409**
    past that), mounted in `main.py` by team-lead.
  - **`recovery.py._resolve_outcome` rewritten by team-lead personally** (the
    single highest-stakes edit in this round) — sends a payment link and
    stamps it onto the event; a real Razorpay link stays
    `action_taken`/`AWAITING_CAPTURE` (async webhook); a fake link resolves
    synchronously inline (no live human to click it in a batch run). A
    `marked_recovered` echo is kept for `audit.compute_metrics`'s
    `avg_hours_to_recovery` (fake-gateway path only — documented as such).
  - **`app/agents/playground.py` fully rewritten** (simulation-engine-builder)
    — `"custom"`/`"ai"` modes (legacy `"interactive"`/`"auto"` still accepted)
    with either-side takeover via `sim_state.controlled_by`; a multi-day game
    clock (`sim_day`/`sim_hour`/`exchanges_today`) that advances on a natural
    pause (silence, explicit deferral, cadence) never a raw message-count cap;
    two distinct structured escalation triggers
    (`customer_requested_human` vs `out_of_scope`/`max_attempts_exceeded`,
    reusing `recovery.py`'s real stopping-rule constants); `outstanding_asks`
    tracking + anti-repetition fixes for the deterministic no-LLM fallback
    (the actual source of the previously-reported verbatim-repeat bug);
    `click_payment_link` (renamed from `simulate_payment`, alias kept) calls
    the pure `resolve_fake_capture` and **never** `apply_capture` — proven by
    a spy/mock test asserting zero calls.
  - **`routes.py`** playground endpoints migrated to the new mode default
    (`"custom"`) + `sim_state`/`speaker`/`outcome` request fields and
    `sim_state`/`escalation`/`no_response` response fields; legacy mode
    strings still accepted at the HTTP layer for backward compatibility.
  - **A real operational hazard was found and fixed mid-pass:** this dev
    machine's `.env` has live Razorpay test-mode keys configured, and
    `pipeline.run()` already defaults to `get_settings()` — without a fix,
    every full-pipeline test run would call the real Payment Links API for
    each diagnosed event, burn the 30-test-link quota, and leave most events
    non-terminal (`AWAITING_CAPTURE`). Fixed with a new autouse
    `_no_real_razorpay` fixture in `tests/conftest.py` (same isolation posture
    as the existing `_offline_embeddings` fixture).
  - Fixed two now-outdated `test_api.py` assertions that assumed the old
    always-succeeds payment simulation: `test_playground_interactive_message_reaches_an_outcome`
    now asserts the full `{captured, reason, outcome, payment_id}` contract for
    either branch instead of hard-coding `outcome=="resolved"`;
    `test_playground_never_touches_the_real_store_or_metrics` excludes
    `tickets.oldest_open_hours` (a genuine wall-clock-derived metric, not a
    store mutation) from its strict equality check.
  - **Frontend, two passes, both verified on disk (not just self-reported):**
    pass 1 — liquid-glass restyle of `SimulateSession.tsx`/`VoiceCallDrawer.tsx`
    (emoji/gradients/`hover:scale-*` removed), new standalone `PayCheckout.tsx`
    page (`/pay/:token`, restructured `App.tsx` so it renders outside
    `AppShell`), a "Simulation settings" data-source toggle on `Playground.tsx`
    (filters to `payment_link_id` starting `plink_`), and `sim_state`/
    `escalation`/`no_response`/payment types threaded through `types.ts`/
    `dataSource.ts`/`client.ts`. Pass 2 — the user hand-drew two wireframe
    sketches mid-session describing a structure pass 1 hadn't fully captured:
    `SimulateSession.tsx`'s live view rebuilt as a **two-column layout**
    (drawer widened to `max-w-5xl`) — phone-style chat/call mockup on the left
    with a "Take over this simulation" + "View Transcripts" control pairing at
    its top, and an always-visible structured, timestamped transcript-log
    panel on the right with three named sub-panels (Messaging Transcript, Call
    Transcript, Customer Actions) — critically, `click_payment_link` outcomes
    now log as distinct timestamped Customer Actions entries instead of being
    folded into chat bubbles. A stray `setState`-in-effect lint warning in
    `PayCheckout.tsx` was fixed directly (redundant `setStep('loading')` next
    to the state's own initial value). `npm run build` + `npm run lint` both
    clean after each pass, re-verified independently.
- **Verified:** Razorpay Payment Links API shape re-confirmed via WebFetch this
  session (`POST /v1/payment_links`, amount in paise, `reference_id` ≤ 40
  chars, `notes` ≤ 15 pairs/256 chars, response `id` prefixed `plink_...`,
  `status` ∈ {created, paid, expired, cancelled, partially_paid}) — matches
  the plan exactly; test-mode `payment_link.paid` webhooks are a genuine,
  documented Razorpay capability, not invented. Backend: a clean, non-concurrent
  full `uv run pytest -q` run confirmed 256 passed / 9 failed, all 9 failures
  pre-existing pgvector-unavailable cases in `test_rag.py` (this session's
  Postgres is the embedded `scripts/pg.ps1` fallback, no `vector` extension) —
  unrelated to this round's changes. Frontend: final `npm run build` + `npm run
  lint` both clean.
- **Docs:** `AGENTS_CONTRACT.md` §11 (payment engine), §12 (Playground
  `sim_state`), §13 (P1-P8/S1-S7 resolved questions); `plan.md` §5/§12;
  `architecture.md` §2 (pipeline diagram gains the `PAY` node), §4 (ERD), §5.2
  (new payment-link lifecycle diagram), §6.2 (Simulate sequence redesign
  note), §7 (2 new component rows), §8 (7 new design-decision entries —
  4 backend + 3 frontend); `documentation.md` §3.3, §3.4, §3.5, §4, §5, §13.
- **Next:** verify the real-Razorpay webhook path by hand against a live
  test-mode account (test-mode webhook simulator or a hand-crafted signed
  `payment_link.paid` payload) — not exercised by the automated test suite by
  design (`_no_real_razorpay`); consider code-splitting the frontend bundle
  (Vite warns the main chunk is >500 kB post-minification, pre-existing, not
  a regression from this round); pitch video.
- **Same-day follow-up — fake gateway made the default even with Razorpay
  keys configured (P9):** manual verification against the user's real
  test-mode account immediately surfaced the exact live consequence of the
  30-link-per-business test-mode cap: their account had already exhausted it,
  so every `create_payment_link` call was failing with `429
  RATE_LIMIT_EXCEEDED` and silently falling back to the fake gateway anyway —
  correct behaviour per the "never raise" contract, but confusing (no visible
  signal that the real path was ever attempted). Added
  `settings.use_real_razorpay_payment_links` (default `False`) and
  `payment._should_use_real_razorpay(settings)` — the real API is now only
  attempted when both keys are configured **and** this flag is explicitly
  set; otherwise `create_payment_link` goes straight to the fake link, no
  attempt made. Updated `AGENTS_CONTRACT.md` (P9), `.env.example`, and
  `documentation.md`'s config table; added
  `test_should_use_real_razorpay_requires_explicit_opt_in` and
  `test_create_payment_link_never_calls_real_api_when_opt_in_is_false` to
  `test_payment.py` (25/25 passing), and retrofitted the 3 existing
  real-path tests with the new opt-in flag.

---

## 2026-09-04 — Liquid Glass Display: Apple-Style Refraction for Side Windows (Ticket & Case Drawers)

- **Did:**
  - **Liquid Glass Display Engine:** Activated `.claude/skills/frontend/liquid-glass/` by creating `frontend/src/lib/liquidGlass.ts` with typed SVG displacement map generation, chromatic aberration (`scale=-112`, `chroma=6`, `border=0.05`), `color-interpolation-filters="sRGB"`, and a clean `useLiquidGlass(ref, options)` React hook.
  - **Ticket Drawer (`TicketDrawer.tsx`):** Upgraded the side window that opens when clicking a ticket on `/attention` with the complete Liquid Glass recipe: translucent glass gradient (`liquid-glass-drawer`), specular top & edge highlights, left glass rim border, nested `liquid-glass-card` tiles for event summaries and resolution notes, and luminous reviewer action buttons.
  - **Detail Drawer (`DetailDrawer.tsx`):** Applied identical liquid glass display styling to the decision trail side drawer on the queue and overview pages.
  - **CSS Styling (`index.css`):** Added reusable `.liquid-glass-drawer`, `.liquid-glass-card`, and `.liquid-glass-pill` tokens with automatic frosted blur fallback for non-Chromium browsers.
  - **Build & Lint:** `npm run lint` (`oxlint`) passed with 0 warnings and 0 errors; `npm run build` (`tsc -b && vite build`) passed cleanly.

---

## 2026-09-04 — Duplex Voice Call: Human Barge-in / Interruptibility & Live Microphone

- **Did:**
  - **Human Barge-in / Interruptibility:** Upgraded the Voice Call simulation to feel like a real duplex phone call. If the AI agent is speaking and the human interrupts (via clicking the prominent `✋ Interrupt Agent` button, speaking into the microphone, typing, focusing the input box, or clicking a quick reply chip), the agent's audio playback (both Sarvam neural WAV and browser SpeechSynthesis) is **instantly silenced**.
  - **Live Microphone Input (Web Speech API):** Added zero-config speech recognition (`SpeechRecognition` / `webkitSpeechRecognition`) supporting Indian English and Hindi (`hi-IN`). Users can speak directly into their microphone hands-free; the speech is transcribed in real-time and interrupts the AI immediately.
  - **Autonomous Mode Takeover:** Added instant `✋ Interrupt & Take Over Call` during two-AI conversations (`mode="auto"`), immediately aborting the autoplay loop, silencing the AI audio, and handing call control to the human reviewer.
  - **Visual Call Cues:** Added real-time dynamic states (`🎙️ Listening to you...`, `⚡ You interrupted Priya`, audio visualizer reacting to both AI speaking and user microphone activity).
  - **Build & Lint:** `npm run lint` 0 errors, `npm run build` clean.

---

## 2026-09-04 — Promise-to-Pay (PTP) State Machine Enforcement & Simulated Payment Webhook

- **Did:**
  - **Fintech PTP Integrity:** Fixed premature case resolution in Simulate/Playground. In line with Razorpay standards, when a customer verbally agrees to pay, commits to a date, or requests a payment link, funds have not yet settled. Marked outcome as `ptp_promised` instead of `resolved`, scheduling up to 3 automated reminders with a 24h cooldown before human escalation.
  - **Real Payment Capture Gate:** Status only transitions to `resolved` when money is captured. Added `simulate_payment()` in `backend/app/agents/playground.py` and `POST /api/events/{event_id}/playground/pay` in `backend/app/api/routes.py` to simulate the customer clicking the link and completing payment (Razorpay `payment.captured` webhook).
  - **Frontend UI & Audio Polish:** Updated `SimulateSession.tsx` with dedicated PTP interactive banners and WhatsApp Payment Link cards in both Call and Message modes. Added action button: `⚡ Customer Clicks Link & Completes Payment (Simulate Webhook)` which transitions state to `resolved` and generates a verifiable Razorpay Transaction ID (`pay_sim_...`). Added `isCustomerSpeaking` state and audio avatar indicators so Customer AI voice playback is clearly indicated in the UI.
  - **Tests & Build:** Verified with 26 playground unit tests, updated `test_api.py`, frontend type check and production build (`npm run build`). All green.

---

## 2026-09-04 — Simulate / Playground + Sarvam TTS fix + synthetic contact data

- **Did:** Added `app/agents/playground.py` — a stateless, sandboxed rehearsal
  agent that lets a judge (or dev) take the role of the customer and chat with
  the AI Recovery Agent live (`interactive` mode), or watch two AI personas
  (Resolver + Customer/Business) converse automatically (`auto` mode). Two
  independently-prompted `chat_turns()` calls react turn-by-turn to the real
  transcript; each persona only sees its own side's conversation so neither
  writes the other's lines. Added `chat_turns()` to `app/llm.py`. Three new
  API routes: `POST /events/{id}/playground/start|message|advance`. Frontend:
  `src/components/SimulateSession.tsx` (chat UI), `src/pages/Playground.tsx`
  (case picker), `⚡ Simulate` button wired into `DetailDrawer.tsx`, nav item
  in `AppShell.tsx`. Sandboxing is the core contract — `playground.py` never
  calls `insert_ticket`, `update_event`, or `log_action`; the history list lives
  in the browser; `/api/metrics` is byte-identical before and after any session.
  Verified by 26 new tests (`test_playground.py`) + 4 new API endpoint tests.
- **Fixed Sarvam TTS:** Root cause was `frontend/.env` missing — `VITE_DATA_SOURCE`
  defaulted to `"fixtures"`, which never calls the backend. Created
  `frontend/.env` with `VITE_DATA_SOURCE=live`. Added `reason` field to
  `voice_tts.synthesize_script` return dict and a startup log line in `main.py`
  for easier diagnosability.
- **Added synthetic contact data:** `customer_name`, `customer_phone`,
  `customer_bank_account`, `customer_upi_vpa` columns on `Event` /
  `EventCreate` / `EventRead`, generated by `_fake_contact()` in `generate.py`
  via Faker. Razorpay test-mode has no customer/contact simulator (verified).
  Phone + bank shown masked in `DetailDrawer`; UPI VPA shown unmasked.
- **Tests:** 34 new tests pass (`test_playground.py` 26, extended `test_llm.py`
  8 total). 226 collected total.
- **Docs:** `architecture.md` (Last updated, §4 ERD 4 new columns, §6.2 Simulate
  sequence diagram, §7 Playground component row, §8 four new design decisions),
  `documentation.md` (Last updated, §3.3 backend + frontend file tables, §3.4
  tests, §5 endpoint table 3 new routes + MetricsBlock note, §7 Event 4 new
  columns, §12 test inventory + Known issues), `plan.md` §12 (two new approved
  deviations), `readme.md` (§F Simulate section + curl examples), `history.md`.

---

## 2026-09-04 — Urgent Human Attention: priority-ordered review tickets

- **Did:** Built past plan.md §6's "auto-flag for human review" / "simulate as
  an audit-log flag, not a UI, if time is short" into a real, bounded workflow.
  Backend: `tickets` table + `TicketStatus`/`TicketReason` enums + `Agent.HUMAN`
  + `Event.human_recovered_amount` (`app/db/store.py`); new
  `app/agents/triage.py` (pipeline stage between Recovery and Audit — opens one
  priority-scored ticket per `flagged`/`exception` event with none, idempotent;
  `assign_ticket` / `resolve_ticket` / `raise_customer_question` for the three
  human actions, each writing `agent="human"` to the audit trail with the
  reviewer's own note as the `reasoning`); 5 new routes in `app/api/routes.py`
  (`GET /api/tickets`, `GET /api/tickets/{id}`, `POST
  /api/tickets/{id}/assign`, `POST /api/tickets/{id}/resolve`, `POST
  /api/events/{id}/raise-question`); `audit.compute_metrics` gains
  `ai_recovered`/`human_recovered`/`tickets`; `app/data/generate.py` gains
  `build_silent_failures` (the "exception with no error code" case). Frontend:
  `/attention` page, `TicketDrawer`, `TicketActionModals`
  (Assign/Resolve/RaiseQuestion), `ReviewerSignIn` + `lib/session.ts`
  (work-email attribution, not auth), `VoiceCallDrawer` gained a "customer
  asked something we can't answer" escalation button, Overview KPI split.
  Fixed a pre-existing bug where `DetailDrawer`'s PTP `onSuccess` discarded its
  refetch. 33 new backend tests (19 triage, 8 store, 6 API) — 190 total.
  Frontend build + lint clean. Maps to plan.md §6/§9.
- **Design call — "tried 3×, no response":** not an automation failure (the
  stopping rule did its job), but still lost revenue a human may choose to
  chase personally — compliant because a person is now deciding, and it's
  logged. Ticketed at the **lowest** priority band so it never crowds out
  fraud, approval, or a waiting customer.
- **Verified:** buildathon page — "compliant escalation, stopping rules, and
  an audit trail" (exact wording, no change since last check); Agent Studio
  launch page — neither mentions human review, so this is a deliberate,
  documented extension, and it mirrors Razorpay's own Subscription Recovery
  Agent pairing automation with a human channel.
- **Docs:** architecture.md (§1 summary, §2 pipeline diagram + Triage node +
  human loop-back, §4 ERD `tickets` table, §5 lifecycle + new §5.1 ticket state
  diagram, §6 sequence + new §6.1 human-review sequence, §7 component row, §8
  eleven new decision-log rows), documentation.md (file table, DB reference,
  endpoint table, enums, functions, generator constants, test inventory,
  frontend file table), `AGENTS_CONTRACT.md` (owner amendment: Triage stage,
  action registry, priority constants §4a, payload shapes, endpoint list,
  `MetricsBlock`/`TicketRead` samples), plan.md (§6 note + §12 deviation),
  readme.md (the-bar table row, directions note, curl examples, judge guide).
- **Next:** pitch video; optional live-API browser pass of `/attention` with a
  real reviewer session.

---

## 2026-09-04 — Hinglish Voice Recovery: real neural TTS via Sarvam AI

- **Did:** Replaced the browser `SpeechSynthesis` voice (robotic, poor Hinglish)
  with Sarvam AI `bulbul:v3` neural TTS. New `backend/app/agents/voice_tts.py`
  (`synthesize_script` / `synthesize_turn`, `available` gate; distinct `priya`
  agent + `rahul` customer voices), new endpoint `GET
  /api/events/{id}/voice/audio` in `app/api/routes.py`, config keys
  `SARVAM_API_KEY` / `SARVAM_TTS_*` in `app/config.py` + `.env.example`.
  Frontend: `client.getVoiceAudio` / `dataSource.getVoiceAudio`,
  `EventVoiceAudioResponse` type, `VoiceCallDrawer.tsx` now plays per-turn WAV
  clips and degrades to the browser voice when Sarvam is unavailable. 3 new
  tests in `test_voice.py` (149 backend). Maps to Direction 6.
- **Verified:** Sarvam TTS API (docs.sarvam.ai) — endpoint
  `POST https://api.sarvam.ai/text-to-speech`, `api-subscription-key` header,
  `target_language_code` / `speaker` / `model` fields, `bulbul:v3` speaker list,
  base64 `audios[]` response, 1500-char cap. plan.md §11: Razorpay's own
  Subscription Recovery Agent pairs recovery logic with a dedicated voice vendor
  — same pattern.
- **Docs:** architecture.md (Last updated + component table row), documentation.md
  (Last updated, file table, endpoint table, config keys, tests, dataSource),
  plan.md §12 deviation, AGENTS_CONTRACT.md endpoint list, readme.md Direction 6
  + curl.
- **Next:** pitch video; optional live-API browser pass of the voice player with a
  real `SARVAM_API_KEY`.

---

## 2026-09-04 — Full Coverage of Buildathon Directions: Mandate Sequencer, Hinglish Voice, and Promise-to-Pay (PTP)

- **Did:**
  - **Direction 5 (Mandate Retry Sequencer):** `app/agents/sequencer.py` — rail-aware (UPI AutoPay / e-NACH / Tokenized Cards), salary-cycle optimized multi-step retry schedule enforcing NPCI 3-attempt limits.
  - **Direction 6 (Hinglish Voice Recovery Agent):** `app/agents/voice.py` + `frontend/src/components/VoiceCallDrawer.tsx` — culturally natural code-switched Hinglish multi-turn call scripts with browser audio speech synthesis and WhatsApp follow-up copy.
  - **Direction 7 (Promise-to-Pay Tracker):** `app/agents/ptp.py` + `frontend/src/components/PTPModal.tsx` — customer commitment state machine (`promised` → `honored`/`broken`), escalation pausing, 24h grace period evaluation, and PTP reliability metrics.
  - **API & UI Integration:** Added `/api/events/{id}/voice`, `/api/events/{id}/sequencer`, `POST /api/events/{id}/ptp`, and integrated them into the React dashboard decision drawer and at-risk queue.
  - **Tests:** Added `test_sequencer.py`, `test_voice.py`, `test_ptp.py` (7 tests). **All 147 backend tests green**, frontend build/oxlint 0 errors.
- **Docs:** `documentation.md`, `architecture.md`, `readme.md`, this entry.
- **Next:** Push changes; pitch video recording.

---

## 2026-09-04 — Multi-Stage Dockerfiles & GitHub Actions CD (GHCR)

- **Did:** 
  - `backend/Dockerfile` (`ghcr.io/astral-sh/uv:0.5.24-python3.11-bookworm-slim` multi-stage builder → `python:3.11-slim` runtime + curl healthcheck on `:8000/health`) + `backend/.dockerignore`.
  - `frontend/Dockerfile` (`node:20-alpine` builder → `nginx:alpine-slim` runtime on port 80) + `frontend/nginx.conf` (SPA routing + reverse proxy to `/api/`, `/health`, `/webhooks/`) + `frontend/.dockerignore`.
  - `docker-compose.yml` updated to full-stack orchestration (`db` + `backend` + `frontend` on `:3000`, `:8000`, `:5432`) with backward-compatible single service commands.
  - `.github/workflows/cd.yml` — automated container build & push to GitHub Container Registry (`ghcr.io`) using Docker Buildx and GitHub Actions layer caching (`type=gha`), triggering on `push` to `main`, release tags (`v*`), and manual dispatch.
- **Docs:** `readme.md` (CD badge & full-stack docker run commands), `documentation.md` (file references, commands, updated status), `architecture.md` (runtime topology & tech stack), this entry.
- **Next:** push to repository; verify CI and CD runs on GitHub Actions; record pitch video.

---

## 2026-09-04 — GitHub Actions CI

- **Did:** `.github/workflows/ci.yml`. **backend** job — `pgvector/pgvector:pg17`
  service container (health-checked), `astral-sh/setup-uv` + `uv sync --frozen`,
  a step that `CREATE DATABASE revrec_test`, then two pytest steps
  (`--ignore=tests/test_pipeline.py`, then the pipeline suite alone — matches
  the low-RAM two-chunk pattern and surfaces fast failures first).
  **frontend** job — `npm ci` → `npm run lint` → `npm run build`. Triggers:
  push to `main`, all PRs, manual; `concurrency` cancels superseded runs. No
  secrets — every LLM/embedding call is mocked in the suite. CI badge added to
  the README. Removed a stale `TEST_DATABASE_URL=…revrec_test_aud` line from a
  test_audit.py docstring.
- **Docs:** readme.md (badge + CI note), documentation.md (file ref + Last
  updated), this entry.
- **Next:** confirm the first CI run is green after push; pitch video.

---

## 2026-09-04 — Razorpay test-mode webhook listener (build-order step 9)

- **Did:** `app/webhooks/listener.py` + `POST /webhooks/razorpay` (mounted in
  `main.py`). `verify_signature()` — HMAC-SHA256 over the raw body keyed by
  `RAZORPAY_WEBHOOK_SECRET`, constant-time (per
  razorpay.com/docs/webhooks/validate-test). `razorpay_event_to_eventcreate()`
  maps `payment.failed` → `failed_payment`, `payment_link.expired` →
  `abandoned_checkout`, `invoice.expired` → `overdue_invoice`,
  `subscription.halted`/`.pending` → `expired_mandate`/`failed_payment`;
  paise→₹; real `cust_...` ids kept, emails/phones hashed (no PII); success /
  unknown / zero-amount → ignored. Signed at-risk event → `insert_event` as
  `detected` + one `ingested_webhook_event` audit row; the existing pipeline
  runs on it unchanged. Idempotent (dedup by event id — Razorpay retries).
  `test_webhooks.py` (12). **146 backend tests green.**
- **Verified:** Razorpay webhooks docs — `X-Razorpay-Signature` header,
  HMAC-SHA256 of the raw body; top-level payload fields (`entity`, `event`,
  `contains`, `payload`, `created_at`); `payment.failed` / `payment.captured` /
  `order.paid` event names. Amounts in paise (Razorpay convention).
- **Docs:** plan.md §9 (all steps done) + §12; AGENTS_CONTRACT.md §3
  (`ingested_webhook_event`); architecture.md (event sources, `WH` node → done,
  component table); documentation.md (file ref, endpoint, test inventory,
  runbook, build status); readme.md; this entry.
- **Next:** pitch video; optional browser pass of the RAG + webhook flow.

---

## 2026-09-04 — RAG knowledge base (pgvector + HNSW) for the Diagnosis Agent

- **Did:**
  - **Infra:** discovered Docker Desktop + WSL2 actually work here (the docs
    saying otherwise were wrong). Switched Postgres from the embedded binary to
    the `pgvector/pgvector:pg17` container (`docker-compose.yml`,
    `scripts/init-db.sql` creates the test DBs + `CREATE EXTENSION vector`).
    `scripts/pg.ps1` kept as a no-Docker fallback (RAG disabled there).
  - **`app/llm.py`:** added `embed()` — OpenAI `text-embedding-3-small`
    (`dimensions=384`) if `OPENAI_API_KEY`, else local `fastembed`
    (`all-MiniLM-L6-v2`, 384-d), else `LLMUnavailable`. Plus
    `embeddings_available` / `resolve_embed_provider` / `embed_label`.
  - **`store.py`:** `ResolvedCase` table (`vector(384)` + HNSW cosine index),
    `add_resolved_case` / `nearest_resolved_cases` / `resolved_case_count` /
    `trim_resolved_bucket`; `_enable_vector` sets `VECTOR_ENABLED` and the
    table is skipped when pgvector is absent.
  - **`app/rag.py`:** `retrieve_similar` (embed → nearest → few-shot block),
    `seed_reference_cases` (~20 canonical examples, first run), 
    `index_resolved_cases` (append confidently-classified events; dedup +
    per-bucket cap), `RevRecEmbeddings` (LangChain `Embeddings` wrapper).
  - **`diagnosis.py`:** `run()` retrieves similar cases before the LLM
    fallback and passes them as `rag_context`; payload gains `rag_examples` +
    `similar_case_ids`.
  - **`pipeline.py`:** seed KB before Diagnosis, grow it after Audit.
  - **API:** `GET /api/events/{id}/similar`. **Frontend:** `SimilarCases`
    panel in the decision-trail drawer; `getSimilar` in the data-source
    adapter; `SimilarCase` / `EventSimilarResponse` types.
  - **Tests:** `test_rag.py` (10), `test_api.py` (6); `_offline_embeddings`
    autouse fixture keeps the real model out of the suite; fixed a
    `reset_db` table-ordering bug surfaced by the new table. **134 green.**
  - Deps: `pgvector`, `fastembed`, `numpy`, `langchain-core`.
  - **Not done:** LangGraph (pipeline stays a linear state machine), FAISS /
    dedicated vector store (premature at demo scale), `langchain-postgres`
    PGVector (opaque tables, breaks the store.py-only rule).
- **Verified:** real end-to-end run with `fastembed` — a novel phrasing
  ("the customers bank was completely unreachable during the charge") retrieved
  `bank_downtime` as the top match (0.89). No public source names Razorpay's
  own vector DB; pgvector is the defensible, right-sized choice and we don't
  claim otherwise in the pitch.
- **Docs:** plan.md §12 (RAG deviation + Docker correction); CLAUDE.md
  (commands + gotchas); architecture.md (pipeline diagram, ERD, topology,
  decision log, tech stack); documentation.md (§2/§3/§4/§5/§6/§7/§9/§12/§13 +
  runbook + known issues); AGENTS_CONTRACT.md §5/§8; this entry.
- **Next:** browser pass of the RAG panel on live API; step 9 webhook listener;
  pitch video.

---

## 2026-09-04 — Provider-agnostic LLM (Anthropic / OpenRouter / OpenAI)

- **Did:** New `backend/app/llm.py` — `chat()` / `available()` / `resolve_provider()`
  / `model_label()`. Providers auto-detected `anthropic → openrouter → openai`
  (or forced with `LLM_PROVIDER`); OpenRouter + OpenAI over the OpenAI-compatible
  REST endpoint via `httpx`, Anthropic via its SDK; OpenRouter default model is
  `anthropic/claude-3.7-sonnet`. `diagnosis.claude_classify` and
  `recovery._claude_draft` now route through it — same function names (tests
  still monkeypatch them), same offline fallbacks. `config.py` gained the
  `openrouter_*` / `openai_*` / `llm_provider` settings; `httpx` moved to runtime
  deps. `tests/test_llm.py` (+5). **118 backend tests green.**
- **Why:** the user has an OpenRouter key, not an Anthropic one.
- **Docs:** `AGENTS_CONTRACT.md` §5; documentation.md §3.2/§3.3/§4/§12;
  architecture.md tech-stack + decision log; plan.md §12; `.env.example`.
- **Next:** open the PR (branch pushed; `gh` not installed on this box).

---

## 2026-09-04 — Phase B + C: built and integrated the four-agent pipeline (steps 3–8)

- **Did:** Five builders (parallel, isolated test DBs) implemented against the
  frozen contract; team-lead reviewed each diff and merged.
  - `app/agents/detection.py` (12 tests), `diagnosis.py` (26), `recovery.py`
    (29), `audit.py` (11); wired `app/agents/__init__.py`.
  - `app/pipeline.py` — `run()` chains DET→DIA→REC→AUD, returns the MetricsBlock;
    argparse CLI. `tests/test_pipeline.py` (6): every event terminal, fraud
    cluster flagged + not recovered, metrics over the full batch, honest
    exception list.
  - `app/api/routes.py` — `/api/events`, `/api/events/{id}/audit`, `/api/metrics`,
    `/api/pipeline/run`; mounted in `main.py`. Smoke-tested via `TestClient`.
  - `frontend/src/api/fixtures.json` regenerated from a real seed-42 run (74
    events, 40 exceptions); React dashboard pages (`Overview` / `Queue` /
    `Recovery` / `Exceptions`) built against it via a `dataSource.ts` adapter
    (`VITE_DATA_SOURCE=live` flips to `/api`). `npm run build` + `lint` clean.
  - Generator now backdates `created_at` over 14 days with the fraud cluster in
    one 40-min window (restores the ≤60-min clause in the fraud signature);
    `EventCreate.created_at` optional, `insert_event` honours it.
  - Merge-time contract refinements in `AGENTS_CONTRACT.md` §10: audit derives
    the exception reason from `awaiting_human_approval`; R7 (stage-3 handoff →
    exception).
  - **113 backend tests green** (run in chunks — the batch-reseeding pipeline
    tests OOM a single process on this box).
- **Verified:** Razorpay test-card-details error codes (generator), Agent Studio
  tone (Recovery outreach templates), buildathon "the bar" (metrics block +
  honest exception list + stopping rules + audit trail all present).
- **Docs:** documentation.md §3/§5/§5.1/§12/§13 + runbook; architecture.md §2
  (nodes → done), §7, §8 decision log; plan.md §9 status + §12; this entry.
- **Then (same session):** step 10 done — rewrote `readme.md` as the submission
  README (the-bar mapping, root-cause→intervention table, fraud-cluster demo
  moment, run instructions + example output, "what broke / what we'd do next").
  Committed steps 3–8 as six logical commits on `feat/four-agent-pipeline`.
  API-level end-to-end verified (all four endpoints return correct live pipeline
  data through the Vite proxy); browser DOM pass still owed.
- **Next:** step 9 (Razorpay webhook listener, stretch); browser DOM pass of the
  dashboard on the live API; pitch video.

---

## 2026-09-03 — Phase A: froze the cross-agent contract (pipeline steps 3–6)

- **Did:** Started the agent-team build of plan.md §9 steps 3–8. Added
  `RootCause` `StrEnum` (9 members) to `backend/app/db/store.py` and typed
  `EventUpdate.root_cause: RootCause | None` (DB column unchanged). Corrected
  `app/data/generate.py` `raw_failure_reason` codes to real Razorpay test-mode
  strings and re-seeded. Wrote `backend/app/agents/AGENTS_CONTRACT.md` (frozen
  per-stage I/O, root-cause→intervention map, audit `action` registry,
  stopping-rule constants, fraud-cluster signature, audit `payload` shapes,
  Claude-usage rules, API response contract, file boundaries). Committed
  `frontend/src/api/fixtures.json` (sample of every API shape). Updated
  `test_store.py` (+1 test, 26 pass).
- **Verified:** buildathon page (Track 03 text + "the bar" unchanged); Agent
  Studio launch page (agent tone: plain business English, e.g. "Hi, I noticed
  you left the headphones in your cart…"; note a 4th agent, Cashflow Forecaster,
  now listed); test-card-details doc (real failed-payment codes —
  `insufficient_fund`, `authentication_failed`, `payment_timed_out`,
  `card_number_invalid`, `card_declined`, `gateway_technical_error`).
- **Docs:** documentation.md §3/§5/§5.1/§6/§8/§10/§12/§13; architecture.md
  §4 ERD + §8 decision log; plan.md §12 (failure-code correction) + status;
  this entry.
- **Next:** Phase B0 — spawn the five builders in plan-only mode, consolidate
  their plans, report to the user for the second sign-off gate.

---

## 2026-09-03 — Merged the four frontend skills into one `frontend` skill

- **Did:** Combined `scroll-craft`, `liquid-glass`, `glass-scroll-3d`, and
  `revrec-dashboard` into a single `.claude/skills/frontend/` skill with a new
  router `SKILL.md` (four modes + routing rules). Each former skill moved to
  `.claude/skills/frontend/<name>/` (`git mv`, history preserved) with its
  `SKILL.md` renamed to `GUIDE.md`; all bundled `engine/`, `scripts/`,
  `references/`, `templates/`, `demo/` files kept in place. Repointed
  cross-references: `glass-scroll-3d` and `revrec-dashboard` guides now cite
  `../scroll-craft/GUIDE.md` / `../liquid-glass/GUIDE.md` as sibling dirs instead
  of "the X skill". Tooling/process only — no plan.md §9 build-order step.
- **Verified:** No external Razorpay lookup needed (no product/API surface
  touched).
- **Docs:** documentation.md §3.1 + header bumped. architecture.md unchanged
  (no diagram touches this). No plan.md §12 deviation.
- **Next:** Resume build-order step 3 — `backend/app/agents/detection.py`.

---

## 2026-09-03 — Added the `build-workflow` skill; absorbed `razorpay-source-check`

- **Did:** Created `.claude/skills/build-workflow/SKILL.md` — a mandatory
  per-task workflow wrapper enforcing the order: (0) check out and update
  `plan.md` every task, (1) verify against real Razorpay sources — the full
  link list + "how to use the sources" from the old `razorpay-source-check`
  skill are now embedded here as Step 1, (2) keep `architecture.md` data-flow +
  Mermaid diagrams and decision log current *in the same change*, (3) update
  `documentation.md` when done, (4) append a dated brief to `history.md`.
  Deleted `.claude/skills/razorpay-source-check/` (`git rm`) and repointed all
  references: `CLAUDE.md`, `plan.md` §0, `readme.md` §0, `glass-scroll-3d`
  SKILL.md, `documentation.md` §3.1. Created this `history.md`. Tooling/process
  only — no plan.md §9 build-order step.
- **Verified:** No external Razorpay lookup needed (no product/API surface
  touched).
- **Docs:** documentation.md §3.1 + header bumped. architecture.md unchanged.
  No plan.md §12 deviation.
- **Next:** Resume build-order step 3 — `backend/app/agents/detection.py`.
