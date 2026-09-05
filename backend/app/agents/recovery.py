"""Recovery Agent — build-order step 5.

Third stage of the AI Revenue Recovery pipeline. Reads events the Diagnosis
Agent left at ``status="diagnosed"`` (and *only* those — it never reads
``flagged``) and, for each one, runs the single bounded intervention that maps
to its ``root_cause`` (AGENTS_CONTRACT.md §2).

Every event walks the same skeleton:

    update_event(status="action_taken")
      -> ``intervention_selected`` audit row
      -> the intervention handler (which may schedule a retry, draft outreach,
         advance an escalation stage, or hit a stopping rule)
      -> a terminal audit row + status ``recovered`` | ``exception``
         (or ``flagged`` for the defensive suspected-fraud refusal, R1).

Guardrails (AGENTS_CONTRACT.md §4 / §10) are enforced by the handlers:

* ``MAX_RETRY_ATTEMPTS``      — too many attempts -> ``halted_stopping_rule`` -> exception
* ``MAX_ESCALATION_STAGE``    — the invoice ladder never advances past stage 3
* ``COOLDOWN_HOURS``          — a second contact to the same customer is only
  *delayed*, never turned into an exception
* ``HUMAN_APPROVAL_THRESHOLD_INR`` — a discount offer or an escalation on an
  amount strictly above the threshold is logged as ``awaiting_human_approval``
  and **not executed**

**"Recovered" is gated on a real payment capture (AGENTS_CONTRACT.md §11),
never a bare coin flip or a conversation outcome.** Every intervention that
reaches ``_resolve_outcome`` sends a payment link via
``app.agents.payment.create_payment_link`` — a real Razorpay test-mode link
when ``RAZORPAY_KEY_ID``/``SECRET`` are configured, else a deterministic fake
one — and stamps it onto the event (``payment_link_id/url/status=
AWAITING_CAPTURE``). A **real** link genuinely waits for an async webhook
(``app/webhooks/listener.py``) to call ``payment.apply_capture``; the event
stays ``action_taken``/``AWAITING_CAPTURE`` until then, which is honest, not a
bug, if this is an offline demo run. A **fake** link has no live human to
click it in a batch run, so ``_resolve_outcome`` immediately calls
``payment.resolve_fake_capture`` + ``payment.apply_capture`` inline —
explicitly modeled as "the gateway resolves for the synthetic customer," the
only place ``Event.status`` becomes ``RECOVERED`` from a capture. This
replaces the previous per-event ``_stable_hash`` coin flip that set
``RECOVERED`` directly with no capture behind it at all (see plan.md's
2026-09-05 "payment-capture integrity fix" entry). ``_stable_hash`` /
``SUCCESS_RATES`` still live here — ``payment.py`` imports them (never
duplicates) for its own deterministic capture roll. Nothing sleeps — every
timestamp is an offset from ``event.updated_at``.

Persistence goes only through ``app.db.store``. Claude is used only to draft
outreach copy and is isolated behind ``_claude_draft`` (monkeypatched in tests);
with no API key the deterministic templates are used instead.

Public API:
    run(session, *, settings=None) -> list[str]              # every event_id examined
    draft_outreach(intervention, event, *, settings) -> str  # never raises
    _stable_hash(event_id) -> int                            # imported by app.agents.payment
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from app import llm
from app.db import store
from app.db.store import Agent, EventStatus, MONEY, PaymentLinkStatus

# NOTE: `app.agents.payment` is imported lazily inside `_resolve_outcome`
# (not at module level) -- it imports `SUCCESS_RATES`/`_stable_hash` FROM this
# module, so a top-level `import payment` here would be a circular import at
# load time.

RECOVERY = Agent.RECOVERY

# --- stopping-rule constants (AGENTS_CONTRACT.md §4) ----------------------
MAX_RETRY_ATTEMPTS = 3
MAX_ESCALATION_STAGE = 3
COOLDOWN_HOURS = 24
HUMAN_APPROVAL_THRESHOLD_INR = Decimal("5000")
SALARY_WINDOW_DAY = 1
RETRY_BACKOFF_HOURS = 6

# --- deterministic recovery outcome (AGENTS_CONTRACT.md §7) --------------
SUCCESS_RATES: dict[str, int] = {
    "insufficient_funds": 70,
    "expired_instrument": 55,
    "bank_downtime": 75,
    "auth_failure": 60,
    "card_declined": 20,
    "checkout_abandoned": 40,
    "invoice_forgotten": 50,
}
HOURS_TO_RECOVERY: dict[str, float] = {
    "insufficient_funds": 72.0,
    "expired_instrument": 36.0,
    "bank_downtime": 6.0,
    "auth_failure": 24.0,
    "card_declined": 48.0,
    "checkout_abandoned": 24.0,
    "invoice_forgotten": 48.0,
}

# root_cause -> the one intervention (audit action string) it routes to
INTERVENTIONS: dict[str, str] = {
    "insufficient_funds": "scheduled_retry",
    "expired_instrument": "sent_reauth_link",
    "bank_downtime": "suggested_alternate_method",
    "auth_failure": "prompted_guided_retry",
    "card_declined": "scheduled_retry",
    "checkout_abandoned": "sent_nudge",
    "invoice_forgotten": "escalation_stage_advanced",
}

STAGE_NAMES = {1: "reminder", 2: "formal_notice", 3: "human_handoff"}


# --- small pure helpers -------------------------------------------------

def _q(amount: Any) -> Decimal:
    return Decimal(str(amount or 0)).quantize(MONEY)


def _stable_hash(event_id: str) -> int:
    """PYTHONHASHSEED-independent hash for the deterministic recovery outcome."""
    return int.from_bytes(hashlib.sha256(event_id.encode()).digest()[:8], "big")


def _channel(amount: Any) -> str:
    return "sms" if _q(amount) < Decimal("2000") else "email"


def _next_salary_window(dt: datetime) -> datetime:
    """First ``SALARY_WINDOW_DAY`` of the month after *dt* (09:00)."""
    year, month = dt.year, dt.month
    if month == 12:
        year, month = year + 1, 1
    else:
        month += 1
    return dt.replace(
        year=year, month=month, day=SALARY_WINDOW_DAY,
        hour=9, minute=0, second=0, microsecond=0,
    )


# --- outreach drafting -------------------------------------------------

def _template_outreach(intervention: str, event: Any) -> str:
    name = getattr(event, "customer_id", None) or "there"
    amount = _q(getattr(event, "amount", 0))
    templates = {
        "sent_nudge": (
            f"Hi {name}, I noticed you left your payment unfinished. Would you "
            f"like a secure payment link to complete it? Happy to help."
        ),
        "sent_reauth_link": (
            f"Hi {name}, it looks like the card or auto-pay mandate on your "
            f"account has expired. Here is a secure link to re-authorise your "
            f"payment method."
        ),
        "suggested_alternate_method": (
            f"Hi {name}, your bank seems to be having a temporary issue. You "
            f"could try a different payment method, or we can retry the charge "
            f"for you shortly."
        ),
        "prompted_guided_retry": (
            f"Hi {name}, your last payment did not clear the verification step. "
            f"Let's try again - here is a fresh link and we'll guide you through it."
        ),
        "scheduled_retry": (
            f"Hi {name}, we could not collect your payment of {amount}. We will "
            f"retry it for you automatically and keep you posted."
        ),
        "escalation_stage_1": (
            f"Hi {name}, a friendly reminder that your invoice for {amount} is "
            f"now overdue. Here is a secure link to pay it."
        ),
        "escalation_stage_2": (
            f"Hi {name}, this is a formal notice that your invoice for {amount} "
            f"remains unpaid. Please arrange payment at your earliest convenience."
        ),
        "escalation_stage_3": (
            f"Hi {name}, we have been unable to collect payment for your overdue "
            f"invoice for {amount}. Our team will contact you personally to help "
            f"resolve this."
        ),
    }
    return templates.get(
        intervention,
        f"Hi {name}, we're following up about your pending payment of {amount}. "
        f"We're here to help you complete it.",
    )


def _claude_draft(intervention: str, event: Any, *, settings: Any) -> str:
    """Draft outreach copy with the configured LLM (Anthropic / OpenRouter /
    OpenAI — see ``app.llm``). Isolated so tests can monkeypatch it.

    Mirrors Razorpay Agent Studio's plain business English: re-engage the
    customer with a personalized nudge, no ML jargon, first person, warm.
    """
    prompt = (
        "Write one short, friendly customer message (2-3 sentences, plain "
        "business English, first person, no jargon) to re-engage a customer "
        "and help them complete a payment. Mirror Razorpay Agent Studio tone: "
        "a personalized nudge, offer a secure payment link, be helpful not "
        f"pushy. Context: intervention={intervention}, "
        f"amount={_q(getattr(event, 'amount', 0))}, "
        f"customer={getattr(event, 'customer_id', 'customer')}. "
        'Start with "Hi <customer>,". Return only the message text.'
    )
    return llm.chat(None, prompt, settings=settings, max_tokens=256).strip()


def draft_outreach(intervention: str, event: Any, *, settings: Any = None) -> str:
    """Return outreach copy for *intervention*. Never raises.

    Uses the configured LLM (via ``_claude_draft``) only when a provider key is
    set; otherwise (and on any error) falls back to the deterministic template
    so tests and offline runs work.
    """
    if settings is not None and llm.available(settings):
        try:
            text = _claude_draft(intervention, event, settings=settings)
            if text and text.strip():
                return text.strip()
        except Exception:
            pass
    return _template_outreach(intervention, event)


# --- audit-row helpers ------------------------------------------------

def _cooldown_adjust(
    session: store.Session,
    cust_map: dict[str, str],
    customer_id: str,
    desired: datetime,
) -> datetime:
    """Push *desired* out so it is at least COOLDOWN_HOURS after the most recent
    prior contact/retry to the same customer this run (R5 — only delays)."""
    latest: datetime | None = None
    for row in store.get_audit_trail(session):
        payload = row.payload or {}
        ts = payload.get("contact_at") or payload.get("retry_at")
        if not ts or cust_map.get(row.event_id) != customer_id:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if latest is None or dt > latest:
            latest = dt
    if latest is not None and desired - latest < timedelta(hours=COOLDOWN_HOURS):
        return latest + timedelta(hours=COOLDOWN_HOURS)
    return desired


def _halt(session: store.Session, event: Any, rule: str) -> None:
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="halted_stopping_rule",
        reasoning=(
            f"Stopping rule '{rule}' fired for {event.event_id} "
            f"(attempts so far: {event.attempts_so_far}); no further recovery "
            f"action will be taken and the event is routed to exception."
        ),
        payload={"rule": rule, "attempts_so_far": event.attempts_so_far},
    )
    store.update_event(session, event.event_id, status=EventStatus.EXCEPTION)


def _await_approval(session: store.Session, event: Any, *, proposed_action: str) -> None:
    amount = _q(event.amount)
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="awaiting_human_approval",
        reasoning=(
            f"{proposed_action} on {amount} is strictly above the human-approval "
            f"threshold of {HUMAN_APPROVAL_THRESHOLD_INR}; flagged for human "
            f"review and NOT executed."
        ),
        payload={
            "amount": str(amount),
            "threshold": str(HUMAN_APPROVAL_THRESHOLD_INR),
            "proposed_action": proposed_action,
            "awaiting_human_approval": True,
        },
    )
    store.update_event(session, event.event_id, status=EventStatus.EXCEPTION)


def _resolve_outcome(
    session: store.Session, event: Any, rc: str, settings: Any = None,
) -> None:
    """Payment-capture-gated recovered / exception decision
    (AGENTS_CONTRACT.md §11) — replaces the old ``_stable_hash`` coin flip.
    ``Event.status`` becomes ``RECOVERED`` only via ``payment.apply_capture``,
    never directly here.

    Sends a payment link (real Razorpay test-mode when configured, else a
    deterministic fake one) and stamps it onto the event. A real link stays
    ``action_taken``/``AWAITING_CAPTURE`` — it genuinely waits for an async
    webhook. A fake link has no live human to click it in a batch run, so it
    resolves synchronously right here (explicitly modeled as "the gateway
    resolves for the synthetic customer").
    """
    from app.agents import payment  # lazy: avoids a circular import (payment
    # imports SUCCESS_RATES/_stable_hash from this module at load time)

    link = payment.create_payment_link(session, event, settings=settings)
    store.update_event(
        session, event.event_id,
        payment_link_id=link["link_id"],
        payment_link_url=link["link_url"],
        payment_link_status=PaymentLinkStatus.AWAITING_CAPTURE,
        payment_link_sent_at=datetime.now(timezone.utc),
    )
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="payment_link_sent",
        reasoning=(
            f"Sent a {link['source']} payment link to customer "
            f"{event.customer_id} for {_q(event.amount)} via the "
            f"{INTERVENTIONS[rc]} intervention."
        ),
        payload={
            "link_id": link["link_id"],
            "link_url": link["link_url"],
            "source": link["source"],
        },
    )

    if link["source"] != "fake_gateway":
        # A real Razorpay link genuinely waits for an async webhook
        # (app/webhooks/listener.py calls payment.apply_capture when it
        # arrives). Staying action_taken/AWAITING_CAPTURE here is the honest
        # state for an offline demo run where no webhook ever fires.
        return

    refreshed = store.get_event(session, event.event_id) or event
    capture = payment.resolve_fake_capture(
        refreshed, link["link_id"], settings=settings, attempt=1,
    )
    payment.apply_capture(session, refreshed, capture, source="fake_gateway")

    if capture["captured"]:
        amount = _q(capture["amount"])
        # `apply_capture` already set status=RECOVERED and logged
        # `payment_captured` — this is a metrics-facing echo only, kept
        # because `audit.compute_metrics`'s `avg_hours_to_recovery` reads
        # this specific action/payload key (AGENTS_CONTRACT.md §11 dual-log
        # note), never a second status write.
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="marked_recovered",
            reasoning=(
                f"Recovered {amount} for customer {event.customer_id} via the "
                f"{INTERVENTIONS[rc]} intervention "
                f"(~{HOURS_TO_RECOVERY[rc]:.0f}h simulated)."
            ),
            payload={
                "recovered_amount": str(amount),
                "simulated_hours_to_recovery": float(HOURS_TO_RECOVERY[rc]),
            },
        )
    else:
        # `apply_capture` already logged `payment_capture_failed` with the
        # gateway's own reason; Recovery still owns the status decision on a
        # failed capture (exception vs. a future bounded retry).
        store.update_event(session, event.event_id, status=EventStatus.EXCEPTION)
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="routed_to_exception",
            reasoning=(
                f"The {INTERVENTIONS[rc]} intervention for customer "
                f"{event.customer_id} failed to capture payment "
                f"({capture['reason']}); giving up honestly."
            ),
            payload={"reason": capture["reason"]},
        )


# --- intervention handlers ------------------------------------------

def _handle_retry(
    session: store.Session, event: Any, rc: str, anchor: datetime,
    cust_map: dict[str, str], settings: Any = None,
) -> None:
    if event.attempts_so_far >= MAX_RETRY_ATTEMPTS:
        _halt(session, event, "max_retry_attempts")
        return
    if rc == "insufficient_funds":
        retry_at = _next_salary_window(anchor)
    else:  # card_declined — one cautious short-delay retry
        retry_at = anchor + timedelta(hours=RETRY_BACKOFF_HOURS)
    retry_at = _cooldown_adjust(session, cust_map, event.customer_id, retry_at)
    attempt = event.attempts_so_far + 1
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="scheduled_retry",
        reasoning=(
            f"Scheduled bounded retry #{attempt} for customer "
            f"{event.customer_id} at {retry_at.isoformat()} "
            f"(root cause: {rc})."
        ),
        payload={"retry_at": retry_at.isoformat(), "attempt": attempt},
    )
    store.update_event(session, event.event_id, attempts_so_far=attempt)
    _resolve_outcome(session, event, rc, settings)


def _handle_outreach(
    session: store.Session, event: Any, rc: str, anchor: datetime,
    settings: Any, cust_map: dict[str, str],
) -> None:
    if event.attempts_so_far >= MAX_RETRY_ATTEMPTS:
        _halt(session, event, "max_retry_attempts")
        return
    intervention = INTERVENTIONS[rc]
    message = draft_outreach(intervention, event, settings=settings)
    base = anchor + timedelta(hours=RETRY_BACKOFF_HOURS) if rc == "bank_downtime" else anchor
    contact_at = _cooldown_adjust(session, cust_map, event.customer_id, base)
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action=intervention,
        reasoning=(
            f"Sent {intervention} outreach to customer {event.customer_id} "
            f"(contact at {contact_at.isoformat()}, root cause: {rc})."
        ),
        payload={
            "message": message,
            "channel": _channel(event.amount),
            "contact_at": contact_at.isoformat(),
        },
    )
    store.update_event(
        session, event.event_id, attempts_so_far=event.attempts_so_far + 1
    )
    _resolve_outcome(session, event, rc, settings)


def _handle_nudge(
    session: store.Session, event: Any, anchor: datetime,
    settings: Any, cust_map: dict[str, str],
) -> None:
    if event.attempts_so_far >= MAX_RETRY_ATTEMPTS:
        _halt(session, event, "max_retry_attempts")
        return
    message = draft_outreach("sent_nudge", event, settings=settings)
    contact_at = _cooldown_adjust(session, cust_map, event.customer_id, anchor)
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="sent_nudge",
        reasoning=(
            f"Sent a personalized checkout-abandonment nudge to customer "
            f"{event.customer_id} (contact at {contact_at.isoformat()})."
        ),
        payload={
            "message": message,
            "channel": _channel(event.amount),
            "contact_at": contact_at.isoformat(),
        },
    )
    store.update_event(
        session, event.event_id, attempts_so_far=event.attempts_so_far + 1
    )
    if _q(event.amount) > HUMAN_APPROVAL_THRESHOLD_INR:
        _await_approval(
            session, event,
            proposed_action="bounded discount offer on abandoned checkout",
        )
        return
    _resolve_outcome(session, event, "checkout_abandoned", settings)


def _handle_escalation(
    session: store.Session, event: Any, anchor: datetime,
    settings: Any, cust_map: dict[str, str],
) -> None:
    stage = event.attempts_so_far + 1
    if stage > MAX_ESCALATION_STAGE:
        _halt(session, event, "max_escalation_stage")
        return
    stage_name = STAGE_NAMES[stage]
    amount = _q(event.amount)
    if stage >= 2 and amount > HUMAN_APPROVAL_THRESHOLD_INR:
        _await_approval(
            session, event,
            proposed_action=f"invoice escalation to stage {stage} ({stage_name})",
        )
        return
    message = draft_outreach(f"escalation_stage_{stage}", event, settings=settings)
    contact_at = _cooldown_adjust(session, cust_map, event.customer_id, anchor)
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="escalation_stage_advanced",
        reasoning=(
            f"Advanced the overdue-invoice escalation for customer "
            f"{event.customer_id} to stage {stage} ({stage_name})."
        ),
        payload={
            "stage": stage,
            "stage_name": stage_name,
            "message": message,
            "channel": _channel(event.amount),
            "contact_at": contact_at.isoformat(),
        },
    )
    store.update_event(session, event.event_id, attempts_so_far=stage)
    if stage == MAX_ESCALATION_STAGE:
        store.update_event(session, event.event_id, status=EventStatus.EXCEPTION)
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="routed_to_exception",
            reasoning=(
                "Escalation reached stage 3 (human handoff); automated recovery "
                "stops here and a human takes over."
            ),
            payload={"reason": "escalated to human handoff, automated recovery stops"},
        )
        return
    _resolve_outcome(session, event, "invoice_forgotten", settings)


# --- per-event orchestration --------------------------------------

def _process_event(
    session: store.Session, event: Any, settings: Any, cust_map: dict[str, str]
) -> None:
    rc = event.root_cause or "unknown"
    anchor = event.updated_at

    # R1 — defensive: a suspected-fraud event should never reach 'diagnosed'.
    if rc == "suspected_fraud":
        store.update_event(session, event.event_id, status=EventStatus.FLAGGED)
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="halted_stopping_rule",
            reasoning=(
                "Recovery refuses to act on a suspected-fraud event; leaving it "
                "flagged for human review."
            ),
            payload={"rule": "suspected_fraud_refusal"},
        )
        return

    from app.agents.sequencer import plan_retry_sequence
    from app.db.store import PTPStatus

    # Attach intelligent retry schedule
    schedule = plan_retry_sequence(event)
    store.update_event(session, event.event_id, status=EventStatus.ACTION_TAKEN, retry_schedule=schedule)

    # If customer has an active promise-to-pay, respect the commitment window
    if getattr(event, "ptp_status", None) == PTPStatus.PROMISED:
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="ptp_paused_escalation",
            reasoning=f"Active Promise-to-Pay window in effect until {event.promised_date}. Automated contact paused.",
            payload={"promised_date": event.promised_date.isoformat() if event.promised_date else None},
        )
        return

    if rc not in INTERVENTIONS:
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="intervention_selected",
            reasoning=(
                f"Root cause {rc!r} has no recovery intervention; routing "
                f"straight to exception."
            ),
            payload={"root_cause": rc, "intervention": "routed_to_exception"},
        )
        store.update_event(session, event.event_id, status=EventStatus.EXCEPTION)
        store.log_action(
            session,
            event_id=event.event_id,
            agent=RECOVERY,
            action="routed_to_exception",
            reasoning="Gave up honestly: unclassified root cause, nothing to act on.",
            payload={"reason": "unclassified root cause"},
        )
        return

    intervention = INTERVENTIONS[rc]
    store.log_action(
        session,
        event_id=event.event_id,
        agent=RECOVERY,
        action="intervention_selected",
        reasoning=(
            f"Routed {rc} for customer {event.customer_id} to the "
            f"{intervention} intervention."
        ),
        payload={"root_cause": rc, "intervention": intervention},
    )

    if rc in ("insufficient_funds", "card_declined"):
        _handle_retry(session, event, rc, anchor, cust_map, settings)
    elif rc in ("expired_instrument", "bank_downtime", "auth_failure"):
        _handle_outreach(session, event, rc, anchor, settings, cust_map)
    elif rc == "checkout_abandoned":
        _handle_nudge(session, event, anchor, settings, cust_map)
    elif rc == "invoice_forgotten":
        _handle_escalation(session, event, anchor, settings, cust_map)


def run(session: store.Session, *, settings: Any = None) -> list[str]:
    """Run one bounded recovery intervention for every event at
    ``status="diagnosed"``. Returns the id of every event examined.

    Idempotent: processed events leave ``diagnosed`` immediately, so a second
    run finds nothing.
    """
    cust_map = {e.event_id: e.customer_id for e in store.all_events(session)}
    examined: list[str] = []
    for event in store.get_events_by_status(session, EventStatus.DIAGNOSED.value):
        examined.append(event.event_id)
        _process_event(session, event, settings, cust_map)
    return examined
