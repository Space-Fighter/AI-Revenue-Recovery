"""Simulate / Playground — a live, sandboxed rehearsal of a recovery outreach.

The four core agents plus Triage handle the *real* batch. This module answers
a different question: **can a person actually probe the AI and see how it
responds?** The existing Hinglish Voice script (``app/agents/voice.py``) is a
prerecorded transcript — one LLM call writes an entire scripted dialogue up
front, which is why it always reads the same way for a given case. Here, two
independently-prompted chat roles carry on a real turn-by-turn conversation:

* the **Resolver** — the Recovery Agent persona, grounded in the case's real
  amount / root cause / stopping rules, always the one deciding whether the
  conversation is ``resolved`` / ``escalated`` / ``halted``.
* the **Customer / Business** — a synthetic counterparty persona (an
  individual for B2C cases, an accounts-payable contact for B2B invoices),
  either played by a human tester or by a second LLM call with its own
  system prompt.

Modes: ``"custom"`` (tester always plays the customer) and ``"ai"`` (two AIs
converse) — legacy ``"interactive"``/``"auto"`` strings are accepted and
mapped internally (see AGENTS_CONTRACT.md §12/§13 S5). Either role can be
taken over by a human tester via ``sim_state.controlled_by``.

**This module is stateless and read-only against the store.** Every function
takes an already-fetched ``Event`` and a ``history`` list (plus an optional
``sim_state`` game-clock/escalation dict) the caller passes back in; nothing
here calls ``insert_ticket``, ``update_event``, or ``log_action``. That is
what makes the session a safe rehearsal: a judge play-testing "yes I'll pay"
can never move the real ``events``/``tickets`` tables or the batch's
``MetricsBlock`` — see AGENTS_CONTRACT.md §12 and plan.md §12.

Public API:
    pick_channel(event) -> "call" | "message"
    build_persona(event) -> dict                    # display context
    start_session(event, *, mode, channel=None, settings=None) -> dict
    send_message(event, history, message, channel, *, speaker=None,
                 sim_state=None, settings=None, outcome=None) -> dict
    advance_conversation(event, history, channel, *, sim_state=None,
                         settings=None) -> dict
    click_payment_link(event, history, channel="call", *, sim_state=None,
                       settings=None, forced_reason=None) -> dict
    simulate_payment = click_payment_link   # deprecated alias, S5

``click_payment_link``'s optional ``forced_reason`` (S9) lets a tester-driven
fake-checkout screen pick the outcome explicitly ("success" | "wrong_otp" |
"wrong_password" | "user_cancelled" | "insufficient_funds") instead of the
random weighted roll; ``forced_reason=None`` (default) is byte-for-byte the
existing ``payment.resolve_fake_capture``-driven behavior.
"""

from __future__ import annotations

import json
import random
import types
from typing import Any, Literal

from app import llm
from app.agents import voice_tts
from app.agents.recovery import (
    HUMAN_APPROVAL_THRESHOLD_INR,
    MAX_ESCALATION_STAGE,
    MAX_RETRY_ATTEMPTS,
)
from app.agents.recovery import _stable_hash as _recovery_stable_hash
from decimal import Decimal

from app.config import Settings, get_settings
from app.db.store import MONEY, Event, RootCause

# payment.py is being built in parallel (payment-engine builder). Import
# defensively so this module still loads (and every existing test still
# collects) if it isn't merged yet -- tests monkeypatch `pg.payment.*`
# regardless of which path is taken here.
try:
    from app.agents import payment  # type: ignore
except Exception:  # pragma: no cover - only hit before payment.py lands
    payment = types.ModuleType("app.agents.payment")

    def _unavailable_resolve_fake_capture(event, link_id, *, settings, attempt=1):
        raise RuntimeError("app.agents.payment.resolve_fake_capture is not available yet")

    def _unavailable_apply_capture(*args, **kwargs):
        raise RuntimeError("app.agents.payment.apply_capture is not available yet")

    payment.resolve_fake_capture = _unavailable_resolve_fake_capture  # type: ignore[attr-defined]
    payment.apply_capture = _unavailable_apply_capture  # type: ignore[attr-defined]

Mode = Literal["interactive", "auto", "custom", "ai"]
Channel = Literal["call", "message"]
Outcome = Literal["ongoing", "ptp_promised", "resolved", "escalated", "halted"]
Speaker = Literal["agent", "customer"]

_VALID_OUTCOMES = ("ongoing", "ptp_promised", "resolved", "escalated", "halted")

# --- mode aliasing (S5) ------------------------------------------------

_MODE_ALIASES = {"interactive": "custom", "auto": "ai"}


def _normalize_mode(mode: str) -> str:
    return _MODE_ALIASES.get(mode, mode)


# root_cause -> channel. Payment-failure causes suit a phone call (higher
# urgency, needs a real-time yes/no); nudges and B2B chasers suit a message.
# Mirrors the plain intervention-selection style already in recovery.py.
_CALL_CAUSES = {
    RootCause.INSUFFICIENT_FUNDS,
    RootCause.EXPIRED_INSTRUMENT,
    RootCause.BANK_DOWNTIME,
    RootCause.AUTH_FAILURE,
    RootCause.CARD_DECLINED,
    RootCause.SUSPECTED_FRAUD,  # a verification call, not a nudge
}

# root_cause -> a short character sketch for the Customer/Business persona,
# so different cases produce genuinely different conversations rather than a
# handful of templates repeating.
_DISPOSITIONS: dict[str, str] = {
    RootCause.INSUFFICIENT_FUNDS: "cooperative but a little embarrassed; short on cash until salary lands",
    RootCause.EXPIRED_INSTRUMENT: "willing but confused about how to update payment details",
    RootCause.BANK_DOWNTIME: "mildly annoyed, assumes it's a technical glitch on your side",
    RootCause.AUTH_FAILURE: "unsure what went wrong, needs simple guidance",
    RootCause.CARD_DECLINED: "a bit defensive, doesn't want to admit the card might be maxed out",
    RootCause.CHECKOUT_ABANDONED: "distracted, was comparing prices and got interrupted",
    RootCause.INVOICE_FORGOTTEN: "a business accounts-payable contact — busy, procedural, wants written confirmation",
    RootCause.SUSPECTED_FRAUD: "evasive, gives inconsistent details, doesn't recognise the transaction",
    RootCause.UNKNOWN: "neutral, waiting to hear what this is about",
}

_MASK_TAIL = 4


def _mask(value: str | None) -> str | None:
    if not value:
        return None
    tail = value[-_MASK_TAIL:]
    return f"{'•' * max(len(value) - _MASK_TAIL, 4)}{tail}"


def pick_channel(event: Event) -> Channel:
    """Which outreach channel this case would realistically use."""
    return "call" if event.root_cause in _CALL_CAUSES else "message"


def _disposition_for(event: Event) -> str:
    rc = event.root_cause or RootCause.UNKNOWN.value
    return _DISPOSITIONS.get(rc, _DISPOSITIONS[RootCause.UNKNOWN])


def build_persona(event: Event) -> dict[str, Any]:
    """The display context shown before a session starts and fed into both
    system prompts. Every contact field is synthetic (see app/data/generate.py)."""
    is_business = str(event.event_type) == "overdue_invoice"
    return {
        "name": event.customer_name or event.customer_id,
        "phone_masked": _mask(event.customer_phone),
        "bank_account_masked": _mask(event.customer_bank_account),
        "upi_vpa": event.customer_upi_vpa,
        "amount": str(event.amount),
        "root_cause": str(event.root_cause) if event.root_cause else None,
        "event_type": str(event.event_type),
        "is_business": is_business,
        "disposition": _disposition_for(event),
    }


# --- sim_state (AGENTS_CONTRACT.md §12, frozen shape) -----------------------

CUSTOMER_RESPONSE_PROBABILITY = 0.7
SAME_DAY_EXCHANGE_CAP = 20  # circuit breaker only -- never expected to fire


def _default_controlled_by(mode: str) -> dict[str, str]:
    if mode == "custom":
        return {"agent": "ai", "customer": "human"}
    return {"agent": "ai", "customer": "ai"}


def _default_sim_state(mode: str) -> dict[str, Any]:
    norm = _normalize_mode(mode)
    return {
        "mode": norm,
        "controlled_by": _default_controlled_by(norm),
        "sim_day": 1,
        "sim_hour": 9,
        "exchanges_today": 0,
        "attempts_so_far": 0,
        "escalation_stage": 0,
        "customer_last_responded_day": 1,
        "customer_response_probability": CUSTOMER_RESPONSE_PROBABILITY,
        "outstanding_asks": [],
        "last_reply_text": None,
        "capture_attempts": 0,
        # 0 = "not scheduled". Sandbox stand-in for recovery.SALARY_WINDOW_DAY:
        # this file has no calendar, only a relative sim_day counter, so an
        # insufficient-funds failure reschedules a reminder `sim_day + 5`
        # rather than targeting a real day-of-month (S9).
        "salary_reminder_day": 0,
    }


def _fill_sim_state(sim_state: dict[str, Any] | None, mode: str) -> dict[str, Any]:
    """Absent/partial `sim_state` (including a partially-old shape, S3) always
    degrades to safe turn-1 defaults for whatever keys are missing."""
    defaults = _default_sim_state(mode)
    if not sim_state:
        return defaults
    merged = {**defaults, **sim_state}
    merged["controlled_by"] = {
        **defaults["controlled_by"],
        **(sim_state.get("controlled_by") or {}),
    }
    merged["outstanding_asks"] = list(sim_state.get("outstanding_asks") or [])
    return merged


def _advance_day(sim_state: dict[str, Any]) -> None:
    sim_state["sim_day"] += 1
    sim_state["sim_hour"] = 9
    sim_state["exchanges_today"] = 0


def _advance_day_for_silence(sim_state: dict[str, Any]) -> None:
    sim_state["customer_response_probability"] = max(
        0.1, round(sim_state["customer_response_probability"] - 0.1, 4)
    )
    _advance_day(sim_state)


def _bump_clock(sim_state: dict[str, Any], *, natural_pause: bool) -> None:
    """Advance the clock on a natural pause (explicit deferral, or the
    circuit breaker); otherwise just move the cadence forward within the same
    day. Never a raw message-count cap."""
    sim_state["exchanges_today"] += 1
    if natural_pause or sim_state["exchanges_today"] >= SAME_DAY_EXCHANGE_CAP:
        _advance_day(sim_state)
    else:
        sim_state["sim_hour"] = min(23, sim_state["sim_hour"] + 1)


def _register_response(sim_state: dict[str, Any]) -> None:
    """Recent same-day response raises the next response probability."""
    sim_state["customer_last_responded_day"] = sim_state["sim_day"]
    sim_state["customer_response_probability"] = min(
        0.95, round(sim_state["customer_response_probability"] + 0.15, 4)
    )


def _roll_customer_response(event_id: str, turn_index: int, probability: float) -> bool:
    """Deterministic per (event_id, turn_index) roll -- reproducible in
    tests. Reuses recovery._stable_hash (imported, never redefined)."""
    roll = _recovery_stable_hash(f"{event_id}:resp:{turn_index}") % 100
    return roll < round(probability * 100)


# --- outstanding-asks keyword-pattern map (S1, builder's own latitude) -----

_ASK_PATTERNS: dict[str, tuple[str, ...]] = {
    "wants a GST invoice": ("gst", "tax invoice", "invoice chahiye", "bill chahiye", "invoice bhejo"),
    "wants the link resent via WhatsApp": ("whatsapp",),
    "wants the link resent via email": (
        "email pe", "email par", "email bhej", "mail kar", "send it to my email", "mail bhej",
    ),
    "wants a callback": ("call back", "callback", "phone karo", "call me later"),
    "wants more detail": (
        "more detail", "explain more", "samjhao thoda", "elaborate", "detail chahiye", "samjhaiye",
    ),
}


def _track_asks(sim_state: dict[str, Any], message: str) -> None:
    text = message.lower()
    for label, keywords in _ASK_PATTERNS.items():
        if label in sim_state["outstanding_asks"]:
            continue
        if any(k in text for k in keywords):
            sim_state["outstanding_asks"].append(label)


def _clear_addressed_asks(sim_state: dict[str, Any], agent_reply_text: str) -> None:
    text = agent_reply_text.lower()
    remaining = []
    for label in sim_state["outstanding_asks"]:
        keywords = _ASK_PATTERNS.get(label, ())
        if any(k in text for k in keywords):
            continue  # addressed this turn
        remaining.append(label)
    sim_state["outstanding_asks"] = remaining


# --- explicit human-request / deferral detection ----------------------------

_HUMAN_REQUEST_PATTERNS = (
    "human se baat", "real person", "real insaan", "talk to a human", "talk to a person",
    "manager se baat", "supervisor", "connect me to a human", "escalate to human",
    "insaan se baat", "human agent chahiye", "koi insaan", "baat karao kisi insaan se",
)

_DEFERRAL_PATTERNS = (
    "kal", "tomorrow", "baad me", "baad mein", "call me later", "next week",
    "agle hafte", "abhi busy", "thodi der baad", "later today", "i'll check tomorrow",
    "check kar ke batata hoon",
)


def _matches_any(text: str, patterns: tuple[str, ...]) -> bool:
    t = text.lower()
    return any(p in t for p in patterns)


# --- structured escalation handoff ------------------------------------------


def _summarize_conversation(
    history: list[dict[str, str]], sim_state: dict[str, Any], settings: Settings
) -> str:
    asks = sim_state.get("outstanding_asks") or []
    if llm.available(settings):
        try:
            transcript = "\n".join(f"{h['speaker']}: {h['text']}" for h in history[-10:])
            summary = llm.chat(
                "Summarize this customer-recovery rehearsal conversation in one short, "
                "plain-English sentence for a human reviewer who has not read the transcript.",
                transcript,
                settings=settings,
                max_tokens=80,
            ).strip()
            if summary:
                return summary
        except Exception:
            pass
    asks_note = f"; outstanding: {', '.join(asks)}" if asks else ""
    return f"{len(history)}-turn rehearsal conversation, no resolution reached{asks_note}."


def _build_escalation(
    event: Event,
    sim_state: dict[str, Any],
    history: list[dict[str, str]],
    reason: str,
    settings: Settings | None = None,
) -> dict[str, Any]:
    s = settings or get_settings()
    last_customer_message = next(
        (h["text"] for h in reversed(history) if h["speaker"] == "customer"), ""
    )
    return {
        "reason": reason,
        "outstanding_asks": list(sim_state.get("outstanding_asks") or []),
        "last_customer_message": last_customer_message,
        "root_cause": str(event.root_cause) if event.root_cause else None,
        "attempts_so_far": sim_state.get("attempts_so_far", 0),
        "conversation_summary": _summarize_conversation(history, sim_state, s),
    }


def _resolve_escalation_reason(
    *, human_requested: bool, sim_state: dict[str, Any], base_outcome: str
) -> str | None:
    """The two distinct escalation triggers, in priority order: an explicit
    human demand always wins regardless of attempt count; otherwise the real
    stopping-rule ceilings (imported, never redefined); otherwise a plain
    'agent decided it's out of scope' escalation."""
    if human_requested:
        return "customer_requested_human"
    if (
        sim_state["attempts_so_far"] >= MAX_RETRY_ATTEMPTS
        or sim_state["escalation_stage"] >= MAX_ESCALATION_STAGE
    ):
        return "max_attempts_exceeded"
    if base_outcome == "escalated":
        return "out_of_scope"
    return None


# --- system prompts --------------------------------------------------------


def _agent_system_prompt(
    event: Event, persona: dict[str, Any], channel: Channel, sim_state: dict[str, Any] | None = None
) -> str:
    medium = "a phone call" if channel == "call" else "a WhatsApp message exchange"
    counterparty = "a business accounts-payable contact" if persona["is_business"] else "the customer"
    asks = (sim_state or {}).get("outstanding_asks") or []
    asks_note = (
        f" The customer still has these unaddressed asks -- address them explicitly this turn: "
        f"{', '.join(asks)}."
        if asks
        else ""
    )
    return (
        f"You are the Razorpay Recovery Agent, speaking with {counterparty} over {medium}. "
        f"This is a REHEARSAL for testing purposes, not a real customer interaction. "
        f"Case: {persona['event_type']} of Rs {persona['amount']}, root cause "
        f"{persona['root_cause'] or 'unknown'}. "
        "Speak in natural, warm Hinglish (Hindi in Roman script mixed with English business terms), "
        "concise, never robotic. Never repeat a previous line of yours verbatim -- vary your phrasing "
        f"every turn.{asks_note} "
        "STRICT BOUNDED AUTHORITY & CONTEXT RULES: "
        "- You ONLY have context for this specific pending/failed recovery payment of Rs {persona['amount']}. "
        "- You DO NOT have authority or context for discounts, coupon codes, amount changes, past refunds, order status, deliveries, product quality, or general support issues. "
        "- NEVER offer discounts, promo codes, or fee waivers under any circumstances. "
        "- CRITICAL RULE: If the customer asks for ANYTHING outside this specific payment recovery (e.g. discounts, past refunds, delivery tracking, product issues, complaints) or anything you do not have context of, you MUST reply stating that you do not have context of what they asked and ask if you should escalate to a human supervisor: "
        "'Mere paas is request ka context / authority nahi hai. Kya main is case ko human supervisor ko escalate kar doon?' (or in English: 'I do not have context of what you have asked. Should I escalate this to a human?') and mark outcome as 'escalated'. "
        "- If the customer explicitly asks for a human, supervisor, or manager -> outcome 'escalated'. "
        "- If the other side is hostile, fraudulent, or suspicious -> outcome 'halted'. "
        "- If the customer agrees to pay, commits to a date, or asks for a payment link on WhatsApp/SMS: provide the secure Razorpay payment link (https://rzp.io/i/rec_{persona.get('amount', 0)}) and mark outcome as 'ptp_promised' (Promise to Pay recorded). "
        "- Only mark 'resolved' if they confirm they have completed payment or paid. Otherwise 'ongoing'. "
        "Reply with ONLY a JSON object: "
        '{"reply": "<your next line>", "outcome": "ongoing"|"ptp_promised"|"resolved"|"escalated"|"halted", '
        '"reasoning": "<one short sentence, why this outcome>"}.'
    )


def _customer_system_prompt(
    event: Event, persona: dict[str, Any], channel: Channel, sim_state: dict[str, Any] | None = None
) -> str:
    medium = "a phone call" if channel == "call" else "a WhatsApp chat"
    role = "a business's accounts-payable contact" if persona["is_business"] else "a Razorpay customer"
    return (
        f"You are {persona['name']}, {role}, on {medium} with Razorpay's recovery agent about a "
        f"{persona['event_type']} of Rs {persona['amount']}. "
        f"Your disposition: {persona['disposition']}. "
        "Speak in natural, casual Hinglish (Hindi in Roman script mixed with English), short lines, "
        "like a real person texting or talking, not a script. Never repeat a previous line of yours "
        "verbatim -- vary your phrasing. "
        "You may realistically ask for more detail or explanation, ask that the payment link be sent "
        "via a specific channel (e.g. WhatsApp or email), ask about a GST invoice, push back, or "
        "occasionally not have much to add -- not every reply has to move the conversation forward. "
        "React to what the agent just said; don't repeat yourself. After a few exchanges, reach a "
        "natural conclusion (agree, ask to escalate to a human, or push back) rather than dragging on "
        "forever. If you genuinely want a human instead of the AI agent, say so explicitly. "
        "Reply with ONLY your next line of dialogue as plain text — no JSON, no quotes, no labels."
    )


def _opening_instruction(persona: dict[str, Any], channel: Channel) -> str:
    medium = "Open the call" if channel == "call" else "Open the WhatsApp message"
    return f"{medium}. Greet {persona['name']} by name and explain briefly why you're reaching out."


# --- JSON / text parsing (voice.py's fenced-JSON-with-fallback pattern) ---


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```json"):
        t = t[7:]
    if t.startswith("```"):
        t = t[3:]
    if t.endswith("```"):
        t = t[:-3]
    return t.strip()


def _parse_agent_reply(text: str, fallback_reply: str) -> dict[str, Any]:
    try:
        data = json.loads(_strip_fences(text))
        reply = str(data.get("reply", "")).strip()
        outcome = str(data.get("outcome", "ongoing")).strip().lower()
        if outcome not in _VALID_OUTCOMES:
            outcome = "ongoing"
        reasoning = str(data.get("reasoning", "")).strip()
        if reply:
            return {"reply": reply, "outcome": outcome, "reasoning": reasoning}
    except Exception:
        pass
    return {"reply": fallback_reply, "outcome": "ongoing", "reasoning": ""}


# --- provider-turn conversion ----------------------------------------------


def _to_provider_turns(
    history: list[dict[str, str]], self_speaker: str
) -> list[dict[str, str]]:
    """`history` (chronological, {"speaker","text"}) from `self_speaker`'s own
    point of view: its own lines are "assistant", the other side's are "user".
    Drops a leading "assistant" turn (this speaker's own opening line, if
    present) -- Anthropic requires the conversation to start with "user"."""
    turns = [
        {"role": "assistant" if h["speaker"] == self_speaker else "user", "content": h["text"]}
        for h in history
    ]
    while turns and turns[0]["role"] == "assistant":
        turns.pop(0)
    return turns


# --- deterministic offline fallback ----------------------------------------
# No LLM key configured -> the feature must still run to a real conclusion,
# same "never raises, always degrades" contract as every other agent here.

_ROOT_CAUSE_EXPLANATIONS: dict[str, str] = {
    RootCause.INSUFFICIENT_FUNDS: "Aapke bank account mein transaction ke waqt insufficient balance tha, is wajah se bank ne request decline kar di thi.",
    RootCause.EXPIRED_INSTRUMENT: "Aapka registered card ya autopay mandate expire ho chuka hai, isliye automatic charge fail ho gaya.",
    RootCause.BANK_DOWNTIME: "Aapke bank ke server mein temporary technical downtime tha, is wajah se gateway timeout ho gaya.",
    RootCause.AUTH_FAILURE: "OTP verification ya 3D Secure bank authentication timeout ho gaya tha.",
    RootCause.CARD_DECLINED: "Aapke card issuing bank ne security limits ya online payment permissions ki wajah se transaction decline kiya tha.",
    RootCause.CHECKOUT_ABANDONED: "Aap checkout page par the par payment capture hone se pehle browser session close/drop ho gaya tha.",
    RootCause.INVOICE_FORGOTTEN: "Aapki B2B invoice due date cross ho chuki hai aur system mein unpaid mark hui hai.",
    RootCause.SUSPECTED_FRAUD: "Kuch unusual activity patterns detect hone par payment risk check par hold ho gayi thi.",
    RootCause.UNKNOWN: "Payment gateway par ek temporary error aaya tha aur transaction verify nahi ho paya.",
}

_FRAUD_WORDS = {"fraud", "scam", "nahi kiya", "wrong", "block", "galat", "hacked", "police"}
_UPSET_WORDS = {"angry", "gussa", "complaint", "manager", "escalate", "bad service", "consumer court"}
_OUT_OF_SCOPE_WORDS = {
    "discount", "coupon", "promo", "sasta", "kam karo", "waive", "reduce", "cashback", "off chahiye",
    "refund", "pichla refund", "return", "delivery", "shipment", "courier", "order status",
    "cancel order", "damaged", "defective", "broken", "complaint", "legal", "court",
}
_QUESTION_WORDS = {"kyu", "why", "kaise", "reason", "kya hua", "fail", "problem", "issue", "batao", "bataiye", "detail", "explain", "samjhao"}
_AGREE_PHRASES = {"pay kar", "link bhej", "bhej do", "bhejo", "kar deta hoon", "karta hoon", "kar dunga", "ready to pay", "sure send", "yes send", "send link", "paid", "payment kar"}

# alternate phrasings for the deterministic fallback's two most-repeatable
# lines (the generic "keep waiting" nudge and the stalled hand-off) -- the
# no-LLM path has zero history awareness otherwise, which is exactly what
# caused verbatim repetition before this rewrite.
_DEFAULT_REPLY_VARIANTS = [
    "Samajh sakta hoon {name} ji. Aapka Rs {amount} ka payment pending hai. Kya aap abhi UPI ya card se retry karna chahenge?",
    "Koi baat nahi {name} ji, jab bhi convenient ho Rs {amount} wala payment complete kar dijiye -- main link dobara bhi bhej sakta hoon.",
    "{name} ji, samajhta hoon thoda busy honge. Rs {amount} ka matter hai, chahein to main abhi ek fresh payment link bhej doon?",
]

_STALLED_VARIANTS = [
    "Koi baat nahi {name} ji, main is case ko human review queue mein daal deta hoon taaki hamari accounts team aapse call par connect kar sake.",
    "Theek hai {name} ji, is baat ko main apni senior team tak forward kar raha hoon jo directly aapse baat karegi.",
]


def _alternate_phrasing(reply_text: str, persona: dict[str, Any], turn_index: int) -> str:
    variants = [v.format(name=persona["name"], amount=persona["amount"]) for v in _DEFAULT_REPLY_VARIANTS]
    for v in variants:
        if v != reply_text:
            return v
    return variants[turn_index % len(variants)]


def _fallback_agent_reply(
    persona: dict[str, Any], message: str, turn_index: int, sim_state: dict[str, Any] | None = None
) -> dict[str, Any]:
    text = message.lower().strip()

    # 1. Fraud or security dispute -> escalate immediately to human review
    if any(w in text for w in _FRAUD_WORDS):
        return {
            "reply": f"Samajh gaya {persona['name']} ji. Main is transaction ko turant hold par daalkar human fraud verification team ko escalate kar raha hoon.",
            "outcome": "escalated",
            "reasoning": "Customer disputes transaction / suspects fraud; halted for human review.",
        }

    # 2. Hostile / Manager demand -> escalate
    if any(w in text for w in _UPSET_WORDS):
        return {
            "reply": f"Bilkul {persona['name']} ji, main is case ko senior review team ko forward kar raha hoon jo aapse directly connect karenge.",
            "outcome": "escalated",
            "reasoning": "Customer requested human supervisor / expressed dissatisfaction.",
        }

    # 3. Out-of-scope query (discounts, refunds, delivery, etc.) -> explicit no-context + escalate offer
    if any(w in text for w in _OUT_OF_SCOPE_WORDS):
        return {
            "reply": f"Mere paas is request ka context / authority nahi hai. Kya main is case ko human supervisor / support team ko escalate kar doon?",
            "outcome": "escalated",
            "reasoning": "Out-of-scope inquiry (no context for discounts, refunds, or delivery); offering human escalation.",
        }

    # 4. Questions asking why it failed / inquiry ("kyu hua", "fail kyu hua", "why")
    has_question = any(w in text for w in _QUESTION_WORDS) or "?" in text
    if has_question:
        rc = persona.get("root_cause") or RootCause.UNKNOWN
        explanation = _ROOT_CAUSE_EXPLANATIONS.get(rc, "Gateway par temporary network error aaya tha.")
        return {
            "reply": f"{explanation} Kya main aapko ek secure Razorpay payment link bhej doon taaki aap ise easily settle kar sakein?",
            "outcome": "ongoing",
            "reasoning": f"Explained failure root cause ({rc}) in response to customer inquiry.",
        }

    # 5. Genuine agreement to pay / proceed -> Promise to Pay (PTP)
    has_agreement = any(p in text for p in _AGREE_PHRASES) or (
        text in {"haan", "yes", "theek hai", "ok", "okay", "sure", "done"} and not has_question
    )
    if has_agreement:
        return {
            "reply": f"Shukriya {persona['name']} ji! Maine Rs {persona['amount']} ka secure Razorpay payment link bhej diya hai: https://rzp.io/i/rec_{persona.get('amount', 0)}. Aapka Promise-to-Pay log ho gaya hai. Link par click karke payment complete karte hi receipt mil jayegi.",
            "outcome": "ptp_promised",
            "reasoning": "Customer committed to pay; Payment Link dispatched; Promise-to-Pay recorded (max 3 reminders scheduled).",
        }

    # 6. Stalled without resolution after multiple turns
    if turn_index >= 3:
        idx = turn_index % len(_STALLED_VARIANTS)
        reply = _STALLED_VARIANTS[idx].format(name=persona["name"], amount=persona["amount"])
        return {
            "reply": reply,
            "outcome": "escalated",
            "reasoning": "No resolution reached after multi-turn exchange; handing off to human queue.",
        }

    idx = turn_index % len(_DEFAULT_REPLY_VARIANTS)
    return {
        "reply": _DEFAULT_REPLY_VARIANTS[idx].format(name=persona["name"], amount=persona["amount"]),
        "outcome": "ongoing",
        "reasoning": "",
    }


def _fallback_customer_reply(persona: dict[str, Any], turn_index: int) -> str:
    lines = [
        "Haan bataiye, transaction fail kyu hua tha?",
        "Achha theek hai, ab samajh aaya. Kya aap link bhej sakte hain?",
        "Haan theek hai, main abhi payment link se pay kar deta hoon.",
    ]
    return lines[min(turn_index, len(lines) - 1)]


def _fallback_opening(persona: dict[str, Any], channel: Channel) -> str:
    greeting = "Namaste" if not persona["is_business"] else "Namaste, Razorpay Recovery se bol raha hoon"
    medium_desc = "call" if channel == "call" else "WhatsApp notification"
    return (
        f"{greeting} {persona['name']} ji! Yeh aapke Rs {persona['amount']} ke "
        f"{persona['event_type'].replace('_', ' ')} ke regarding {medium_desc} hai. Kya hum iske baare mein 2 minute baat kar sakte hain?"
    )


# --- optional Sarvam speech for "call" channel ------------------------------


def _speak(text: str, speaker: str, channel: Channel, settings: Settings) -> str | None:
    """Base64 WAV for one line, or None. Never raises -- same degrade-gracefully
    contract as everywhere else Sarvam is used (app/agents/voice_tts.py)."""
    if channel != "call" or not voice_tts.available(settings):
        return None
    try:
        return voice_tts.synthesize_turn(text, speaker, settings=settings)
    except voice_tts.SarvamTTSError:
        return None


def _with_audio(turn: dict[str, Any], channel: Channel, settings: Settings) -> dict[str, Any]:
    clip = _speak(turn["text"], "Agent" if turn["speaker"] == "agent" else "Customer", channel, settings)
    if clip:
        turn = {**turn, "audio_base64": clip}
    return turn


# --- ticket reference (cosmetic only -- never a DB row) ---------------------


def _ticket_ref(event: Event) -> str:
    suffix = event.event_id[-4:].upper().replace("_", "")
    return f"SIM-{suffix}{random.randint(100, 999)}"


# --- public API --------------------------------------------------------


def start_session(
    event: Event,
    *,
    mode: Mode,
    channel: Channel | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Open a rehearsal session. Never writes to the store."""
    s = settings or get_settings()
    active_channel = channel if channel in ("call", "message") else pick_channel(event)
    persona = build_persona(event)
    sim_state = _default_sim_state(mode)

    opening_text = _fallback_opening(persona, active_channel)
    outcome: Outcome = "ongoing"
    if llm.available(s):
        try:
            raw = llm.chat(
                _agent_system_prompt(event, persona, active_channel),
                _opening_instruction(persona, active_channel),
                settings=s,
                max_tokens=200,
            )
            parsed = _parse_agent_reply(raw, opening_text)
            opening_text = parsed.get("reply") or opening_text
            outcome = parsed.get("outcome", "ongoing")
        except Exception:
            pass

    opening_turn = {"speaker": "agent", "text": opening_text}
    sim_state["last_reply_text"] = opening_text
    return {
        "mode": mode,
        "channel": active_channel,
        "ticket_ref": _ticket_ref(event),
        "persona": persona,
        # audio only on the turn shown to the caller right now; `history`
        # (resent on every later call) stays plain text -- no point paying to
        # regenerate/re-transmit audio for lines already spoken.
        "opening_turn": _with_audio(opening_turn, active_channel, s),
        "outcome": outcome,
        "history": [opening_turn],
        "sim_state": sim_state,
    }


def send_message(
    event: Event,
    history: list[dict[str, str]],
    message: str,
    channel: Channel,
    *,
    speaker: Speaker | None = None,
    sim_state: dict[str, Any] | None = None,
    settings: Settings | None = None,
    outcome: Outcome | None = None,
) -> dict[str, Any]:
    """`speaker="customer"` (default, back-compat): the tester's own line as
    the customer, then one Agent turn (LLM or deterministic fallback).

    `speaker="agent"` (S6): a human has taken over the Resolver role --
    `message` is that human's own line, and `outcome` (if given) is trusted
    as-supplied, never inferred from the human's freeform text.
    """
    s = settings or get_settings()
    persona = build_persona(event)
    st = _fill_sim_state(sim_state, mode=(sim_state or {}).get("mode", "custom"))
    active_speaker: Speaker = speaker or "customer"
    new_history = [*history, {"speaker": active_speaker, "text": message}]

    if active_speaker == "agent":
        final_outcome = outcome if outcome in _VALID_OUTCOMES else "ongoing"
        st["last_reply_text"] = message
        agent_turn = new_history[-1]
        result: dict[str, Any] = {
            "turn": _with_audio(agent_turn, channel, s),
            "outcome": final_outcome,
            "reasoning": "human agent override (outcome supplied by the human reviewer)",
            "history": new_history,
            "sim_state": st,
        }
        if final_outcome == "escalated":
            reason = _resolve_escalation_reason(
                human_requested=False, sim_state=st, base_outcome=final_outcome
            ) or "out_of_scope"
            result["escalation"] = _build_escalation(event, st, new_history, reason, s)
        return result

    # speaker == "customer" ---------------------------------------------
    turn_index = sum(1 for h in new_history if h["speaker"] == "customer")
    _track_asks(st, message)
    human_requested = _matches_any(message, _HUMAN_REQUEST_PATTERNS)
    is_deferral = _matches_any(message, _DEFERRAL_PATTERNS)

    result = _fallback_agent_reply(persona, message, turn_index, st)
    if llm.available(s):
        try:
            turns = _to_provider_turns(new_history, self_speaker="agent")
            raw = llm.chat_turns(
                _agent_system_prompt(event, persona, channel, st), turns, settings=s
            )
            result = _parse_agent_reply(raw, result["reply"])
        except Exception:
            pass

    st["attempts_so_far"] += 1
    if st["escalation_stage"] < MAX_ESCALATION_STAGE:
        st["escalation_stage"] += 1

    escalation_reason = _resolve_escalation_reason(
        human_requested=human_requested, sim_state=st, base_outcome=result["outcome"]
    )
    if escalation_reason:
        result = {**result, "outcome": "escalated"}

    reply_text = result["reply"]
    if reply_text == st.get("last_reply_text"):
        reply_text = _alternate_phrasing(reply_text, persona, turn_index)
    st["last_reply_text"] = reply_text
    _clear_addressed_asks(st, reply_text)

    _bump_clock(st, natural_pause=is_deferral)

    agent_turn = {"speaker": "agent", "text": reply_text}
    new_history.append(agent_turn)
    out = {
        "turn": _with_audio(agent_turn, channel, s),
        "outcome": result["outcome"],
        "reasoning": result["reasoning"],
        "history": new_history,
        "sim_state": st,
    }
    if escalation_reason:
        out["escalation"] = _build_escalation(event, st, new_history, escalation_reason, s)
    return out


def advance_conversation(
    event: Event,
    history: list[dict[str, str]],
    channel: Channel,
    *,
    sim_state: dict[str, Any] | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Auto ("ai") mode: one Customer turn, then one Agent turn -- two
    distinctly prompted LLM calls, each reacting to the real transcript so
    far. A deterministic per-turn roll may produce "no response" instead --
    a distinct turn shape (see AGENTS_CONTRACT.md §12), not a chat bubble."""
    s = settings or get_settings()
    persona = build_persona(event)
    st = _fill_sim_state(sim_state, mode=(sim_state or {}).get("mode", "ai"))
    turn_index = sum(1 for h in history if h["speaker"] == "customer") + 1
    # The response roll is seeded on total history length (not just the
    # customer-turn count) so a repeated no-response doesn't hash to the same
    # seed forever when a caller doesn't round-trip `sim_state` between calls
    # -- each no-response appends a non-chat marker (below) precisely so the
    # next roll's seed genuinely advances.
    roll_seed = len(history)

    responded = _roll_customer_response(
        event.event_id, roll_seed, st["customer_response_probability"]
    )
    if not responded:
        _advance_day_for_silence(st)
        marker = {"speaker": "system", "text": "(customer did not respond this turn)"}
        return {
            "no_response": True,
            "customer_turn": None,
            "agent_turn": None,
            "outcome": "ongoing",
            "reasoning": "customer did not respond this turn (simulated silence)",
            "history": [*history, marker],
            "sim_state": st,
        }

    _register_response(st)

    customer_text = _fallback_customer_reply(persona, turn_index)
    if llm.available(s):
        try:
            turns = _to_provider_turns(history, self_speaker="customer")
            reply = llm.chat_turns(
                _customer_system_prompt(event, persona, channel, st), turns, settings=s,
                max_tokens=200,
            ).strip()
            if reply:
                customer_text = reply
        except Exception:
            pass

    customer_turn = {"speaker": "customer", "text": customer_text}
    history_with_customer = [*history, customer_turn]
    _track_asks(st, customer_text)
    human_requested = _matches_any(customer_text, _HUMAN_REQUEST_PATTERNS)
    is_deferral = _matches_any(customer_text, _DEFERRAL_PATTERNS)

    agent_result = _fallback_agent_reply(persona, customer_text, turn_index, st)
    if llm.available(s):
        try:
            turns = _to_provider_turns(history_with_customer, self_speaker="agent")
            raw = llm.chat_turns(
                _agent_system_prompt(event, persona, channel, st), turns, settings=s
            )
            agent_result = _parse_agent_reply(raw, agent_result["reply"])
        except Exception:
            pass

    st["attempts_so_far"] += 1
    if st["escalation_stage"] < MAX_ESCALATION_STAGE:
        st["escalation_stage"] += 1

    escalation_reason = _resolve_escalation_reason(
        human_requested=human_requested, sim_state=st, base_outcome=agent_result["outcome"]
    )
    if escalation_reason:
        agent_result = {**agent_result, "outcome": "escalated"}

    reply_text = agent_result["reply"]
    if reply_text == st.get("last_reply_text"):
        reply_text = _alternate_phrasing(reply_text, persona, turn_index)
    st["last_reply_text"] = reply_text
    _clear_addressed_asks(st, reply_text)

    _bump_clock(st, natural_pause=is_deferral)

    agent_turn = {"speaker": "agent", "text": reply_text}
    new_history = [*history_with_customer, agent_turn]
    out = {
        # auto mode speaks BOTH voices when the channel is a call, via
        # sarvam_tts_speaker_agent / _customer -- sounds like the old
        # prerecorded two-voice transcript, just generated live.
        "no_response": False,
        "customer_turn": _with_audio(customer_turn, channel, s),
        "agent_turn": _with_audio(agent_turn, channel, s),
        "outcome": agent_result["outcome"],
        "reasoning": agent_result["reasoning"],
        "history": new_history,
        "sim_state": st,
    }
    if escalation_reason:
        out["escalation"] = _build_escalation(event, st, new_history, escalation_reason, s)
    return out


# --- payment-link click (never touches the real store, never captures for real) --

def _q(amount: Any) -> Decimal:
    """Same rounding convention as payment.py's own `_q` (quantize to paise)
    -- kept local so this module never imports a private helper across the
    package boundary; the two must stay byte-for-byte equivalent."""
    return Decimal(str(amount or 0)).quantize(MONEY)


# cause + fix, same natural Hinglish tone as _ROOT_CAUSE_EXPLANATIONS /
# _fallback_agent_reply. `insufficient_funds` deliberately has no generic
# "try again" fix here -- it gets a salary-day reschedule message instead,
# built inline in click_payment_link (point 3, S9).
_CAPTURE_FAILURE_TEXT: dict[str, str] = {
    "wrong_otp": (
        "OTP galat enter ho gaya isliye payment complete nahi hua. Agli baar apne phone par "
        "aaya hua sahi 6-digit OTP dalein, phir se try karte hain?"
    ),
    "wrong_password": (
        "Aapka Razorpay/bank login ya password galat tha, isliye payment OTP step tak pahunchne "
        "se pehle hi fail ho gaya. Ek baar apna login verify karke dobara try kijiye."
    ),
    "user_cancelled": (
        "Lagta hai aapne payment beech mein hi cancel/back kar diya tha, isliye transaction complete "
        "nahi hua. Is baar link dobara kholiye aur OTP step tak poora complete kariye, beech mein back mat kijiye."
    ),
    "insufficient_funds": "Account mein is waqt insufficient balance hai, payment complete nahi ho paya.",
}


def click_payment_link(
    event: Event,
    history: list[dict[str, str]],
    channel: Channel = "call",
    *,
    sim_state: dict[str, Any] | None = None,
    settings: Settings | None = None,
    forced_reason: str | None = None,
) -> dict[str, Any]:
    """Simulates the customer clicking the payment link. By default
    (`forced_reason=None`) calls the PURE, imported `payment.resolve_fake_capture`
    (never `payment.apply_capture` -- that writes to the DB and would break
    the sandboxing guarantee) and renders wrong_otp / insufficient_funds /
    user_cancelled / success -- weighted, never an unconditional instant
    "resolved". This is a hard regression guard: existing callers that never
    pass `forced_reason` see byte-for-byte unchanged behavior.

    `forced_reason` (S9) lets a tester-driven fake-checkout screen pick the
    outcome explicitly instead of the random roll: one of "success",
    "wrong_otp", "wrong_password" (a playground-only reason, never added to
    payment.py's CaptureResult vocabulary), "user_cancelled",
    "insufficient_funds". Any other value is treated the same as None
    (unforced/random). When set, `payment.resolve_fake_capture` is skipped
    entirely and a CaptureResult-shaped dict is built locally with the same
    `_q` paise-rounding convention `resolve_fake_capture` uses, so downstream
    code sees an identical shape either way.

    `insufficient_funds` never escalates regardless of attempt count -- it
    reschedules a salary-day reminder instead (see the branch below, S9)."""
    s = settings or get_settings()
    persona = build_persona(event)
    st = _fill_sim_state(sim_state, mode=(sim_state or {}).get("mode", "custom"))

    attempt = st["capture_attempts"] + 1
    link_id = f"sim_{event.event_id}"  # playground-owned prefix (S4) -- never persisted

    forced = forced_reason if forced_reason in (
        "success", "wrong_otp", "wrong_password", "user_cancelled", "insufficient_funds",
    ) else None

    if forced == "success":
        capture: dict[str, Any] = {"captured": True, "reason": "captured", "amount": _q(event.amount)}
    elif forced is not None:
        capture = {"captured": False, "reason": forced, "amount": _q(event.amount)}
    else:
        capture = payment.resolve_fake_capture(event, link_id, settings=s, attempt=attempt)
    st["capture_attempts"] = attempt

    captured = bool(capture["captured"])
    reason = capture["reason"]
    amount = capture["amount"]

    if captured:
        tx_id = f"pay_sim_{event.event_id[-6:].replace('_', '')}{random.randint(100, 999)}"
        reply_text = (
            f"Payment of Rs {amount} received successfully! "
            f"Razorpay Transaction ID: {tx_id}. Receipt generated. Case marked RESOLVED."
        )
        outcome = "resolved"
        reasoning = (
            f"Customer completed payment via the rehearsal payment link "
            f"(fake gateway capture, attempt {attempt}, link {link_id})."
        )
        payment_id: str | None = tx_id
    elif reason == "insufficient_funds":
        # Carve-out (S9): insufficient funds never escalates no matter how
        # many attempts -- instead we schedule a salary-day reminder. sim_day
        # is a relative counter, not a calendar date, so `+5` is a bounded,
        # deterministic sandbox approximation of recovery.SALARY_WINDOW_DAY.
        st["salary_reminder_day"] = st["sim_day"] + 5
        reply_text = (
            f"{_CAPTURE_FAILURE_TEXT['insufficient_funds']} Filhaal aapke account mein balance kam "
            f"hai. Main aapko salary credit ke around, Day {st['salary_reminder_day']}, dobara "
            f"reminder bhejunga."
        )
        outcome = "ongoing"
        reasoning = (
            f"Payment failed: insufficient funds; rescheduled reminder to sim day "
            f"{st['salary_reminder_day']} (salary-credit-window analogue), no escalation."
        )
        payment_id = None
        _advance_day(st)
    else:
        reply_text = _CAPTURE_FAILURE_TEXT.get(
            reason, "Payment link attempt fail ho gaya, ek baar phir try karte hain."
        )
        payment_id = None
        if attempt >= 3:
            outcome = "escalated"
            reasoning = f"Payment link failed 3 times ({reason}); handing off, capture attempts exhausted."
        else:
            outcome = "ongoing"
            reasoning = f"Payment link click failed: {reason} (attempt {attempt})."

    confirmation_turn = {"speaker": "agent", "text": reply_text}
    new_history = [*history, confirmation_turn]
    st["last_reply_text"] = reply_text

    result = {
        "turn": _with_audio(confirmation_turn, channel, s),
        "outcome": outcome,
        "reasoning": reasoning,
        "history": new_history,
        "payment_id": payment_id,
        "amount": str(amount),
        "captured": captured,
        "reason": reason,
        "sim_state": st,
    }
    if outcome == "escalated":
        result["escalation"] = _build_escalation(event, st, new_history, "max_attempts_exceeded", s)
    return result


# deprecated alias (S5) -- routes.py migrates to click_payment_link in Phase C
simulate_payment = click_payment_link
