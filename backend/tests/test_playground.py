"""Tests for the Simulate / Playground agent (app/agents/playground.py).

Run from backend/:  uv run pytest -q tests/test_playground.py

No DB session is needed for most of these -- the module is stateless and
read-only against the store, taking an already-constructed `Event`. The
sandboxing-guarantee tests use the `session` fixture specifically to prove
that a full session, in either mode, never touches events/tickets/audit_log.
"""

import re
from decimal import Decimal

import pytest

from app.agents import playground as pg
from app.config import Settings
from app.db import store
from app.db.store import Event, EventType, RootCause


def _event(**overrides) -> Event:
    defaults = dict(
        event_id="evt_pg1",
        event_type=EventType.FAILED_PAYMENT,
        customer_id="cust_1",
        amount=Decimal("1500.00"),
        customer_name="Aryan Maharaj",
        customer_phone="+917890779946",
        customer_bank_account="41414442605456",
        customer_upi_vpa="aryanm@okhdfcbank",
        root_cause=RootCause.INSUFFICIENT_FUNDS,
    )
    defaults.update(overrides)
    return Event(**defaults)


_NO_LLM = Settings(
    anthropic_api_key=None, openrouter_api_key=None, openai_api_key=None,
    sarvam_api_key=None,  # keep these tests offline -- no live TTS calls either
)


# --- pick_channel ------------------------------------------------------

@pytest.mark.parametrize(
    "root_cause,expected",
    [
        (RootCause.INSUFFICIENT_FUNDS, "call"),
        (RootCause.EXPIRED_INSTRUMENT, "call"),
        (RootCause.BANK_DOWNTIME, "call"),
        (RootCause.AUTH_FAILURE, "call"),
        (RootCause.CARD_DECLINED, "call"),
        (RootCause.SUSPECTED_FRAUD, "call"),
        (RootCause.CHECKOUT_ABANDONED, "message"),
        (RootCause.INVOICE_FORGOTTEN, "message"),
        (RootCause.UNKNOWN, "message"),
        (None, "message"),
    ],
)
def test_pick_channel_mapping(root_cause, expected):
    assert pg.pick_channel(_event(root_cause=root_cause)) == expected


# --- persona -------------------------------------------------------------

def test_persona_masks_contact_details():
    persona = pg.build_persona(_event())
    assert persona["name"] == "Aryan Maharaj"
    assert persona["phone_masked"].endswith("9946")
    assert "•" in persona["phone_masked"]
    assert persona["bank_account_masked"].endswith("5456")  # last 4 digits of 41414442605456
    assert "•" in persona["bank_account_masked"]
    assert persona["upi_vpa"] == "aryanm@okhdfcbank"
    assert persona["is_business"] is False


def test_persona_flags_overdue_invoice_as_business():
    persona = pg.build_persona(_event(event_type=EventType.OVERDUE_INVOICE, root_cause=RootCause.INVOICE_FORGOTTEN))
    assert persona["is_business"] is True
    assert "accounts-payable" in persona["disposition"] or "business" in persona["disposition"]


def test_persona_never_exposes_raw_bank_account():
    persona = pg.build_persona(_event())
    assert "41414442605456" not in str(persona)


# --- deterministic offline fallback (no LLM key) --------------------------

def test_start_session_works_without_an_llm_key():
    session = pg.start_session(_event(), mode="interactive", settings=_NO_LLM)
    assert session["mode"] == "interactive"
    assert session["channel"] == "call"
    assert session["ticket_ref"].startswith("SIM-")
    assert session["opening_turn"]["speaker"] == "agent"
    assert session["opening_turn"]["text"]
    assert session["outcome"] == "ongoing"
    assert session["history"] == [session["opening_turn"]]


def test_interactive_fallback_reaches_ptp(monkeypatch):
    event = _event()
    session = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", "call",
        settings=_NO_LLM,
    )
    assert result["outcome"] == "ptp_promised"
    assert result["turn"]["speaker"] == "agent"
    assert result["history"][-1] == result["turn"]
    assert result["history"][-2] == {"speaker": "customer", "text": "Haan theek hai, main abhi pay karta hoon"}

    # Now simulate customer clicking link and completing payment -- routed
    # through the (monkeypatched, pure) payment engine, never an
    # unconditional instant success.
    def _fake_resolve(evt, link_id, *, settings, attempt=1):
        return {"captured": True, "reason": "captured", "amount": evt.amount}

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _fake_resolve)
    paid = pg.simulate_payment(event, result["history"], "call", settings=_NO_LLM)
    assert paid["outcome"] == "resolved"
    assert "pay_sim_" in paid["payment_id"]
    assert paid["history"][-1] == paid["turn"]


def test_interactive_fallback_escalates_on_fraud_dispute():
    event = _event()
    session = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Ye fraud hai, maine kuch nahi kiya", "call", settings=_NO_LLM,
    )
    assert result["outcome"] == "escalated"


def test_interactive_fallback_never_loops_forever():
    """After a few ambiguous turns the deterministic fallback hands off rather
    than looping -- an offline demo must still reach a real conclusion."""
    event = _event()
    history = pg.start_session(event, mode="interactive", settings=_NO_LLM)["history"]
    outcome = "ongoing"
    for _ in range(6):
        result = pg.send_message(event, history, "hmm not sure", "call", settings=_NO_LLM)
        history = result["history"]
        outcome = result["outcome"]
        if outcome != "ongoing":
            break
    assert outcome != "ongoing"


def test_auto_mode_fallback_produces_both_turns():
    event = _event()
    history = pg.start_session(event, mode="auto", settings=_NO_LLM)["history"]
    result = pg.advance_conversation(event, history, "call", settings=_NO_LLM)
    assert result["customer_turn"]["speaker"] == "customer"
    assert result["agent_turn"]["speaker"] == "agent"
    assert result["history"] == [*history, result["customer_turn"], result["agent_turn"]]


def test_auto_mode_fallback_reaches_a_terminal_outcome():
    event = _event()
    session = pg.start_session(event, mode="auto", settings=_NO_LLM)
    history = session["history"]
    st = session["sim_state"]
    outcome = "ongoing"
    for _ in range(20):
        result = pg.advance_conversation(event, history, "call", sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]
        outcome = result["outcome"]
        if outcome != "ongoing":
            break
    assert outcome != "ongoing"


# --- LLM path (monkeypatched, no network) ---------------------------------

def test_interactive_uses_distinct_agent_prompt(monkeypatch):
    """The Agent persona is a real chat_turns() call with its own system prompt."""
    event = _event()
    captured = {}

    def _fake_chat(system, user, *, settings, max_tokens=512):
        return "opening line"

    def _fake_chat_turns(system, turns, *, settings, max_tokens=400):
        captured["system"] = system
        captured["turns"] = turns
        return '{"reply": "Theek hai, main samajh gaya", "outcome": "resolved", "reasoning": "customer agreed"}'

    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", _fake_chat)
    monkeypatch.setattr(pg.llm, "chat_turns", _fake_chat_turns)

    session = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    result = pg.send_message(event, session["history"], "Haan pay kar dunga", "call", settings=_NO_LLM)

    assert result["turn"]["text"] == "Theek hai, main samajh gaya"
    assert result["outcome"] == "resolved"
    assert result["reasoning"] == "customer agreed"
    assert "Recovery Agent" in captured["system"]
    # first turn sent to the provider must be role=user (the opening line was
    # dropped) -- Anthropic requires the conversation to start with "user"
    assert captured["turns"][0]["role"] == "user"


def test_auto_mode_calls_two_distinctly_prompted_llms(monkeypatch):
    event = _event()
    system_prompts_seen = []

    def _fake_chat(system, user, *, settings, max_tokens=512):
        return "opening line"

    def _fake_chat_turns(system, turns, *, settings, max_tokens=400):
        system_prompts_seen.append(system)
        if "Recovery Agent" in system:
            return '{"reply": "Agent line", "outcome": "ongoing", "reasoning": ""}'
        return "Customer line"

    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", _fake_chat)
    monkeypatch.setattr(pg.llm, "chat_turns", _fake_chat_turns)

    history = pg.start_session(event, mode="auto", settings=_NO_LLM)["history"]
    result = pg.advance_conversation(event, history, "call", settings=_NO_LLM)

    assert result["customer_turn"]["text"] == "Customer line"
    assert result["agent_turn"]["text"] == "Agent line"
    # two genuinely different system prompts were used, one per persona
    assert len(system_prompts_seen) == 2
    assert system_prompts_seen[0] != system_prompts_seen[1]


def test_customer_disposition_varies_by_root_cause(monkeypatch):
    seen = []
    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening")

    def _fake_chat_turns(system, turns, *, settings, max_tokens=400):
        if "Recovery Agent" not in system:
            seen.append(system)
        return '{"reply": "x", "outcome": "ongoing", "reasoning": ""}'

    monkeypatch.setattr(pg.llm, "chat_turns", _fake_chat_turns)

    for rc in (RootCause.INSUFFICIENT_FUNDS, RootCause.SUSPECTED_FRAUD, RootCause.INVOICE_FORGOTTEN):
        event = _event(root_cause=rc, event_type=(
            EventType.OVERDUE_INVOICE if rc == RootCause.INVOICE_FORGOTTEN else EventType.FAILED_PAYMENT
        ))
        history = pg.start_session(event, mode="auto", settings=_NO_LLM)["history"]
        pg.advance_conversation(event, history, pg.pick_channel(event), settings=_NO_LLM)

    assert len(set(seen)) == 3  # three distinct root causes -> three distinct prompts


def test_malformed_llm_json_degrades_to_fallback(monkeypatch):
    """A bad/partial LLM response must never raise -- same contract as voice.py."""
    event = _event()
    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening")
    monkeypatch.setattr(pg.llm, "chat_turns", lambda *a, **k: "not json at all")

    session = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    result = pg.send_message(event, session["history"], "haan theek hai", "call", settings=_NO_LLM)
    assert result["outcome"] in ("ongoing", "resolved")  # fallback text used, never raises
    assert result["turn"]["text"]


def test_llm_call_raising_degrades_to_fallback(monkeypatch):
    event = _event()
    monkeypatch.setattr(pg.llm, "available", lambda s: True)

    def _boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(pg.llm, "chat", _boom)
    monkeypatch.setattr(pg.llm, "chat_turns", _boom)

    session = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    assert session["opening_turn"]["text"]  # fell back to the deterministic opening
    result = pg.send_message(event, session["history"], "haan", "call", settings=_NO_LLM)
    assert result["turn"]["text"]


# --- sandboxing guarantee ---------------------------------------------------
# The single most important property of this module: a rehearsal, in either
# mode, must never touch the real events / tickets / audit_log tables.

def _snapshot(session):
    return (
        len(store.all_events(session)),
        len(store.get_tickets(session)),
        len(store.get_audit_trail(session)),
    )


def test_interactive_session_never_writes_to_the_store(session):
    store.insert_event(
        session, event_id="evt_sim1", event_type=store.EventType.FAILED_PAYMENT,
        customer_id="c1", amount=Decimal("500.00"),
    )
    store.update_event(session, "evt_sim1", root_cause=store.RootCause.INSUFFICIENT_FUNDS)
    event = store.get_event(session, "evt_sim1")
    before = _snapshot(session)

    s = pg.start_session(event, mode="interactive", settings=_NO_LLM)
    history = s["history"]
    for msg in ("kya hua?", "haan theek hai main pay kar dunga"):
        result = pg.send_message(event, history, msg, s["channel"], settings=_NO_LLM)
        history = result["history"]

    assert _snapshot(session) == before


def test_auto_session_never_writes_to_the_store(session):
    store.insert_event(
        session, event_id="evt_sim2", event_type=store.EventType.OVERDUE_INVOICE,
        customer_id="c2", amount=Decimal("9000.00"),
    )
    store.update_event(session, "evt_sim2", root_cause=store.RootCause.INVOICE_FORGOTTEN)
    event = store.get_event(session, "evt_sim2")
    before = _snapshot(session)

    s = pg.start_session(event, mode="auto", settings=_NO_LLM)
    history = s["history"]
    for _ in range(4):
        result = pg.advance_conversation(event, history, s["channel"], settings=_NO_LLM)
        history = result["history"]
        if result["outcome"] != "ongoing":
            break

    assert _snapshot(session) == before


# --- modes / legacy aliases / controlled_by --------------------------------

def test_legacy_mode_strings_map_to_new_names():
    session = pg.start_session(_event(), mode="interactive", settings=_NO_LLM)
    assert session["mode"] == "interactive"  # raw value preserved at the top level
    assert session["sim_state"]["mode"] == "custom"

    session2 = pg.start_session(_event(), mode="auto", settings=_NO_LLM)
    assert session2["sim_state"]["mode"] == "ai"


def test_default_controlled_by_per_mode():
    custom = pg._default_sim_state("custom")
    assert custom["controlled_by"] == {"agent": "ai", "customer": "human"}
    ai = pg._default_sim_state("ai")
    assert ai["controlled_by"] == {"agent": "ai", "customer": "ai"}


def test_sim_state_absent_degrades_to_turn1_defaults():
    """A caller that doesn't pass sim_state (every pre-existing test) still
    works at turn-1 semantics."""
    filled = pg._fill_sim_state(None, mode="custom")
    assert filled["sim_day"] == 1
    assert filled["attempts_so_far"] == 0
    assert filled["outstanding_asks"] == []


def test_sim_state_partial_old_shape_fills_missing_keys():
    """S3: an old frontend session dict missing new keys degrades gracefully."""
    partial = {"mode": "custom", "attempts_so_far": 2}
    filled = pg._fill_sim_state(partial, mode="custom")
    assert filled["attempts_so_far"] == 2
    assert filled["sim_day"] == 1
    assert filled["capture_attempts"] == 0
    assert "outstanding_asks" in filled


def test_human_takeover_of_agent_role_trusts_explicit_outcome():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Main manually confirm karta hoon, sab theek hai.", "call",
        speaker="agent", outcome="resolved", settings=_NO_LLM,
    )
    assert result["outcome"] == "resolved"
    assert result["turn"]["text"] == "Main manually confirm karta hoon, sab theek hai."
    assert result["history"][-1]["speaker"] == "agent"


# --- response-probability determinism --------------------------------------

def test_customer_response_roll_is_deterministic_per_event_and_turn():
    a1 = pg._roll_customer_response("evt_det1", 3, 0.7)
    a2 = pg._roll_customer_response("evt_det1", 3, 0.7)
    assert a1 == a2  # same inputs -> same roll, every time

    # different turn indices / event ids are free to differ, but must still
    # be individually reproducible.
    b1 = pg._roll_customer_response("evt_det1", 7, 0.7)
    b2 = pg._roll_customer_response("evt_det1", 7, 0.7)
    assert b1 == b2


# --- multi-day game clock ---------------------------------------------------

def test_in_scope_multi_question_exchange_does_not_advance_the_clock():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    st = session["sim_state"]
    day_before = st["sim_day"]
    msg = "GST invoice chahiye, aur ye bhi bataiye ki fail kyu hua tha?"
    result = pg.send_message(event, session["history"], msg, session["channel"], sim_state=st, settings=_NO_LLM)
    assert result["sim_state"]["sim_day"] == day_before  # no natural pause -> no day advance


def test_explicit_deferral_advances_the_clock():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    st = session["sim_state"]
    day_before = st["sim_day"]
    result = pg.send_message(
        event, session["history"], "Kal baat karte hain, abhi busy hoon.", session["channel"],
        sim_state=st, settings=_NO_LLM,
    )
    assert result["sim_state"]["sim_day"] == day_before + 1
    assert result["sim_state"]["exchanges_today"] == 0


def test_no_response_turn_is_a_distinct_shape_and_advances_the_clock(monkeypatch):
    event = _event()
    session = pg.start_session(event, mode="ai", settings=_NO_LLM)
    st = session["sim_state"]
    monkeypatch.setattr(pg, "_roll_customer_response", lambda *a, **k: False)
    day_before = st["sim_day"]
    result = pg.advance_conversation(event, session["history"], session["channel"], sim_state=st, settings=_NO_LLM)
    assert result["no_response"] is True
    assert "customer_turn" not in result or result["customer_turn"] is None
    # a distinct outcome shape, not a chat bubble -- no agent/customer turn
    # was added, only an internal "system" marker so a repeated silence roll
    # doesn't hash to the same seed forever.
    assert all(h["speaker"] != "customer" for h in result["history"][len(session["history"]):])
    assert all(h["speaker"] != "agent" for h in result["history"][len(session["history"]):])
    assert result["sim_state"]["sim_day"] == day_before + 1


# --- escalation: two distinct structured triggers ---------------------------

def test_human_demand_escalates_immediately_regardless_of_attempts():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Mujhe kisi real insaan se baat karni hai, human agent chahiye.",
        session["channel"], settings=_NO_LLM,
    )
    assert result["outcome"] == "escalated"
    assert "escalation" in result
    esc = result["escalation"]
    assert esc["reason"] == "customer_requested_human"
    assert esc["attempts_so_far"] == 1  # immediate -- did not need to exhaust attempts
    assert "root_cause" in esc and "conversation_summary" in esc
    assert esc["last_customer_message"].startswith("Mujhe")


def test_exhausted_attempts_escalates_with_max_attempts_reason():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    history = session["history"]
    st = session["sim_state"]
    result = None
    for _ in range(pg.MAX_RETRY_ATTEMPTS + 1):
        result = pg.send_message(event, history, "hmm not sure", session["channel"], sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]
        if result["outcome"] == "escalated":
            break
    assert result["outcome"] == "escalated"
    assert result["escalation"]["reason"] in ("max_attempts_exceeded", "out_of_scope")
    assert result["escalation"]["attempts_so_far"] >= pg.MAX_RETRY_ATTEMPTS


# --- outstanding_asks --------------------------------------------------

def test_outstanding_asks_populate_and_clear():
    st = pg._default_sim_state("custom")
    pg._track_asks(st, "Please GST invoice bhi bhejo, aur WhatsApp pe bhi bhejna.")
    assert "wants a GST invoice" in st["outstanding_asks"]
    assert "wants the link resent via WhatsApp" in st["outstanding_asks"]

    pg._clear_addressed_asks(st, "Theek hai, GST invoice email par bhej diya hai.")
    assert "wants a GST invoice" not in st["outstanding_asks"]
    assert "wants the link resent via WhatsApp" in st["outstanding_asks"]  # not yet addressed


# --- anti-repetition (deterministic fallback) -------------------------------

def test_deterministic_fallback_never_repeats_last_reply_verbatim():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    history = session["history"]
    st = session["sim_state"]
    seen_replies = []
    for _ in range(4):
        result = pg.send_message(event, history, "hmm accha", session["channel"], sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]
        seen_replies.append(result["turn"]["text"])
        if result["outcome"] != "ongoing":
            break
    # no two consecutive agent replies were byte-identical
    assert all(seen_replies[i] != seen_replies[i + 1] for i in range(len(seen_replies) - 1))


# --- click_payment_link / sandboxing of the payment engine ------------------

def test_click_payment_link_calls_resolve_fake_capture_never_apply_capture(monkeypatch):
    event = _event()
    calls = {"resolve": 0, "apply": 0}

    def _fake_resolve(evt, link_id, *, settings, attempt=1):
        calls["resolve"] += 1
        assert link_id.startswith("sim_")
        assert attempt == 1
        return {"captured": False, "reason": "wrong_otp", "amount": evt.amount}

    def _fake_apply(*a, **k):
        calls["apply"] += 1
        raise AssertionError("apply_capture must never be called from playground.py")

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _fake_resolve)
    monkeypatch.setattr(pg.payment, "apply_capture", _fake_apply)

    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(event, session["history"], "call", settings=_NO_LLM)

    assert calls["resolve"] == 1
    assert calls["apply"] == 0
    assert result["captured"] is False
    assert result["outcome"] == "ongoing"
    assert result["sim_state"]["capture_attempts"] == 1


def test_click_payment_link_increments_capture_attempts_and_escalates_after_three(monkeypatch):
    event = _event()

    def _always_fails(evt, link_id, *, settings, attempt=1):
        return {"captured": False, "reason": "wrong_otp", "amount": evt.amount}

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _always_fails)

    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    st = session["sim_state"]
    history = session["history"]
    result = None
    for _ in range(3):
        result = pg.click_payment_link(event, history, "call", sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]

    assert st["capture_attempts"] == 3
    assert result["outcome"] == "escalated"
    assert result["escalation"]["reason"] == "max_attempts_exceeded"


def test_click_payment_link_success_never_unconditional(monkeypatch):
    """A capture attempt that fails must be rendered honestly, not silently
    turned into an instant 'resolved'."""
    event = _event()

    def _fake_resolve(evt, link_id, *, settings, attempt=1):
        return {"captured": False, "reason": "user_cancelled", "amount": evt.amount}

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _fake_resolve)
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(event, session["history"], "call", settings=_NO_LLM)
    assert result["outcome"] != "resolved"
    assert result["captured"] is False
    assert result["payment_id"] is None


# --- click_payment_link forced_reason (tester-driven fake checkout, S9) -----

def test_click_payment_link_forced_reason_none_uses_resolve_fake_capture(monkeypatch):
    """Regression guard: omitting forced_reason (or passing None explicitly)
    is byte-for-byte the existing random-roll path -- resolve_fake_capture is
    still the source of truth."""
    event = _event()
    calls = {"n": 0}

    def _fake_resolve(evt, link_id, *, settings, attempt=1):
        calls["n"] += 1
        return {"captured": False, "reason": "wrong_otp", "amount": evt.amount}

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _fake_resolve)
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(
        event, session["history"], "call", settings=_NO_LLM, forced_reason=None
    )
    assert calls["n"] == 1
    assert result["reason"] == "wrong_otp"


def test_click_payment_link_forced_success(monkeypatch):
    event = _event()

    def _boom(*a, **k):
        raise AssertionError("resolve_fake_capture must not be called when forced_reason is set")

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _boom)
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(
        event, session["history"], "call", settings=_NO_LLM, forced_reason="success"
    )
    assert result["captured"] is True
    assert result["reason"] == "captured"
    assert result["outcome"] == "resolved"
    assert result["payment_id"] is not None
    assert "pay_sim_" in result["payment_id"]


def test_click_payment_link_forced_wrong_otp(monkeypatch):
    event = _event()
    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not be called")),
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(
        event, session["history"], "call", settings=_NO_LLM, forced_reason="wrong_otp"
    )
    assert result["captured"] is False
    assert result["reason"] == "wrong_otp"
    assert result["outcome"] == "ongoing"
    assert "OTP" in result["turn"]["text"]


def test_click_payment_link_forced_wrong_password(monkeypatch):
    event = _event()
    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not be called")),
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(
        event, session["history"], "call", settings=_NO_LLM, forced_reason="wrong_password"
    )
    assert result["captured"] is False
    assert result["reason"] == "wrong_password"
    assert result["outcome"] == "ongoing"
    assert "login" in result["turn"]["text"].lower() or "password" in result["turn"]["text"].lower()


def test_click_payment_link_forced_user_cancelled(monkeypatch):
    event = _event()
    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not be called")),
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.click_payment_link(
        event, session["history"], "call", settings=_NO_LLM, forced_reason="user_cancelled"
    )
    assert result["captured"] is False
    assert result["reason"] == "user_cancelled"
    assert result["outcome"] == "ongoing"


def test_click_payment_link_forced_insufficient_funds_mentions_rescheduled_day(monkeypatch):
    """S10: the customer-facing message shows a real calendar-style date
    (e.g. "1st October"), never the raw "Day N" wording -- `sim_day` stays an
    internal relative gating counter only."""
    event = _event()
    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not be called")),
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    st = session["sim_state"]
    day_before = st["sim_day"]
    result = pg.click_payment_link(
        event, session["history"], "call", sim_state=st, settings=_NO_LLM,
        forced_reason="insufficient_funds",
    )
    assert result["captured"] is False
    assert result["reason"] == "insufficient_funds"
    assert result["outcome"] == "ongoing"
    expected_day = day_before + 5
    assert result["sim_state"]["salary_reminder_day"] == expected_day
    assert result["sim_state"]["salary_reminder_date_label"]
    assert not re.search(r"\bDay \d+\b", result["turn"]["text"])
    assert re.search(r"[A-Z][a-z]+", result["turn"]["text"])  # a month name is present
    assert result["sim_state"]["salary_reminder_date_label"] in result["turn"]["text"]


def test_click_payment_link_insufficient_funds_never_escalates_after_many_attempts(monkeypatch):
    event = _event()

    def _always_insufficient(evt, link_id, *, settings, attempt=1):
        return {"captured": False, "reason": "insufficient_funds", "amount": evt.amount}

    monkeypatch.setattr(pg.payment, "resolve_fake_capture", _always_insufficient)
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    st = session["sim_state"]
    history = session["history"]
    result = None
    for _ in range(5):
        result = pg.click_payment_link(event, history, "call", sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]

    assert st["capture_attempts"] == 5
    assert result["outcome"] == "ongoing"
    assert "escalation" not in result


def test_click_payment_link_has_no_session_parameter():
    """Keeps guarding the pure/stateless contract (S2) -- this module must
    never gain a `session` param."""
    import inspect

    params = inspect.signature(pg.click_payment_link).parameters
    assert "session" not in params


# --- S10: calendar-style dates -----------------------------------------

def test_ordinal_formatting():
    assert pg._ordinal(1) == "1st"
    assert pg._ordinal(2) == "2nd"
    assert pg._ordinal(3) == "3rd"
    assert pg._ordinal(4) == "4th"
    assert pg._ordinal(11) == "11th"
    assert pg._ordinal(12) == "12th"
    assert pg._ordinal(13) == "13th"
    assert pg._ordinal(21) == "21st"
    assert pg._ordinal(22) == "22nd"
    assert pg._ordinal(23) == "23rd"


# --- S10: escalation must never clobber a same-turn PTP/resolved outcome ---

def test_resolve_escalation_reason_never_overrides_ptp_or_resolved():
    st = pg._default_sim_state("custom")
    st["attempts_so_far"] = pg.MAX_RETRY_ATTEMPTS
    st["escalation_stage"] = pg.MAX_ESCALATION_STAGE
    assert pg._resolve_escalation_reason(
        human_requested=False, sim_state=st, base_outcome="ptp_promised"
    ) is None
    assert pg._resolve_escalation_reason(
        human_requested=False, sim_state=st, base_outcome="resolved"
    ) is None
    assert pg._resolve_escalation_reason(
        human_requested=False, sim_state=st, base_outcome="ongoing"
    ) == "max_attempts_exceeded"
    # an explicit human demand still always wins
    assert pg._resolve_escalation_reason(
        human_requested=True, sim_state=st, base_outcome="ptp_promised"
    ) == "customer_requested_human"


def test_agreement_on_turn_that_would_exceed_attempts_stays_ptp_promised():
    """S10 bugfix: a customer agreeing to pay on their Nth turn, where N
    would previously have triggered max_attempts_exceeded, must stay
    ptp_promised, not get clobbered into escalated same-turn."""
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    history = session["history"]
    st = session["sim_state"]
    for _ in range(pg.MAX_RETRY_ATTEMPTS - 1):
        result = pg.send_message(event, history, "hmm accha", session["channel"], sim_state=st, settings=_NO_LLM)
        history = result["history"]
        st = result["sim_state"]
        assert result["outcome"] == "ongoing"
    assert st["attempts_so_far"] == pg.MAX_RETRY_ATTEMPTS - 1

    result = pg.send_message(
        event, history, "Haan theek hai, main abhi pay karta hoon", session["channel"],
        sim_state=st, settings=_NO_LLM,
    )
    assert result["outcome"] == "ptp_promised"
    assert "escalation" not in result
    assert result["sim_state"]["ptp_active"] is True


# --- S10: Promise-to-Pay is its own state machine, decoupled from the ladder -

def test_ptp_active_persists_across_ordinary_turns_without_auto_escalation():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", session["channel"],
        settings=_NO_LLM,
    )
    assert result["outcome"] == "ptp_promised"
    st = result["sim_state"]
    assert st["ptp_active"] is True
    assert st["ptp_target_day"] > st["sim_day"]
    assert st["ptp_target_date_label"]
    history = result["history"]
    for _ in range(5):
        result = pg.send_message(
            event, history, "Haan bilkul, pay kar dunga jaldi", session["channel"],
            sim_state=st, settings=_NO_LLM,
        )
        history = result["history"]
        st = result["sim_state"]
        assert result["outcome"] == "ptp_promised"
        assert st["ptp_active"] is True
        assert "escalation" not in result


def test_ptp_overdue_escalates_when_target_day_reached_unpaid():
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", session["channel"],
        settings=_NO_LLM,
    )
    st = result["sim_state"]
    assert st["ptp_active"] is True
    st["sim_day"] = st["ptp_target_day"]  # the promise is now overdue, nothing paid

    result2 = pg.send_message(
        event, result["history"], "abhi tak nahi kar paya", session["channel"], sim_state=st, settings=_NO_LLM,
    )
    assert result2["outcome"] == "escalated"
    assert result2["escalation"]["reason"] == "ptp_overdue"
    assert result2["sim_state"]["ptp_active"] is False


def test_click_payment_link_failure_while_ptp_active_escalates_ptp_payment_failed(monkeypatch):
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", session["channel"],
        settings=_NO_LLM,
    )
    st = result["sim_state"]
    assert st["ptp_active"] is True

    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda evt, link_id, *, settings, attempt=1: {"captured": False, "reason": "wrong_otp", "amount": evt.amount},
    )
    failed = pg.click_payment_link(event, result["history"], "call", sim_state=st, settings=_NO_LLM)
    assert failed["outcome"] == "escalated"
    assert failed["escalation"]["reason"] == "ptp_payment_failed"
    assert failed["sim_state"]["ptp_active"] is False


def test_click_payment_link_forced_failure_while_ptp_active_also_escalates():
    """forced_reason must compose with the PTP-outstanding check exactly like
    a randomly-rolled failure would (S10 composes with S9's forced_reason)."""
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", session["channel"],
        settings=_NO_LLM,
    )
    st = result["sim_state"]
    failed = pg.click_payment_link(
        event, result["history"], "call", sim_state=st, settings=_NO_LLM, forced_reason="user_cancelled",
    )
    assert failed["outcome"] == "escalated"
    assert failed["escalation"]["reason"] == "ptp_payment_failed"
    assert failed["sim_state"]["ptp_active"] is False


def test_click_payment_link_success_while_ptp_active_clears_it_without_escalating(monkeypatch):
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Haan theek hai, main abhi pay karta hoon", session["channel"],
        settings=_NO_LLM,
    )
    st = result["sim_state"]
    assert st["ptp_active"] is True

    monkeypatch.setattr(
        pg.payment, "resolve_fake_capture",
        lambda evt, link_id, *, settings, attempt=1: {"captured": True, "reason": "captured", "amount": evt.amount},
    )
    paid = pg.click_payment_link(event, result["history"], "call", sim_state=st, settings=_NO_LLM)
    assert paid["outcome"] == "resolved"
    assert "escalation" not in paid
    assert paid["sim_state"]["ptp_active"] is False


# --- S10: reminder-cadence gate (pre-PTP nudge ladder only) -----------------

def test_reminder_cadence_gate_suppresses_same_day_duplicate():
    st = pg._default_sim_state("custom")
    assert pg._reminder_gate(st, "generic_nudge", 1) == "send"
    assert pg._reminder_gate(st, "generic_nudge", 1) == "suppress_same_day"


def test_reminder_cadence_gate_exhausts_after_four_distinct_days():
    st = pg._default_sim_state("custom")
    assert pg._reminder_gate(st, "generic_nudge", 1) == "send"
    assert pg._reminder_gate(st, "generic_nudge", 2) == "send"
    assert pg._reminder_gate(st, "generic_nudge", 3) == "send"
    assert pg._reminder_gate(st, "generic_nudge", 4) == "exhausted"


def test_reminder_cadence_gate_resets_on_different_cta():
    st = pg._default_sim_state("custom")
    assert pg._reminder_gate(st, "generic_nudge", 1) == "send"
    assert pg._reminder_gate(st, "generic_nudge", 2) == "send"
    assert pg._reminder_gate(st, "send_payment_link", 2) == "send"  # a genuinely different ask resets
    assert st["reminder_cta"] == "send_payment_link"
    assert st["reminder_days"] == [2]


def test_apply_turn_state_machine_suppresses_same_day_duplicate_reminder():
    st = pg._default_sim_state("custom")
    reply = {"reply": "Koi baat nahi, jab convenient ho payment kar dijiye.", "outcome": "ongoing", "reasoning": ""}
    st["sim_day"] = 1
    _, escalation_reason, suppressed = pg._apply_turn_state_machine(st, human_requested=False, result=dict(reply))
    assert escalation_reason is None
    assert suppressed is False

    st["attempts_so_far"] = 0
    st["escalation_stage"] = 0
    _, escalation_reason2, suppressed2 = pg._apply_turn_state_machine(st, human_requested=False, result=dict(reply))
    assert suppressed2 is True
    assert escalation_reason2 is None


def test_apply_turn_state_machine_reminder_exhaustion_escalates():
    st = pg._default_sim_state("custom")
    reply = {"reply": "Koi baat nahi, jab convenient ho payment kar dijiye.", "outcome": "ongoing", "reasoning": ""}
    for day in (1, 2, 3):
        st["sim_day"] = day
        st["attempts_so_far"] = 0
        st["escalation_stage"] = 0
        _, escalation_reason, suppressed = pg._apply_turn_state_machine(st, human_requested=False, result=dict(reply))
        assert escalation_reason is None
        assert suppressed is False

    st["sim_day"] = 4
    st["attempts_so_far"] = 0
    st["escalation_stage"] = 0
    result, escalation_reason, suppressed = pg._apply_turn_state_machine(st, human_requested=False, result=dict(reply))
    assert escalation_reason == "reminders_exhausted"
    assert result["outcome"] == "escalated"
    assert suppressed is False


# --- S11: clear-agreement override + narrowed identity/bot detection -------

def test_clear_agreement_overrides_llm_ongoing_outcome_in_send_message(monkeypatch):
    """A real transcript bug: the customer said an unambiguous 'okay' but the
    LLM's own outcome judgment stayed 'ongoing' -- the deterministic backstop
    must force ptp_promised regardless."""
    event = _event()
    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening line")
    monkeypatch.setattr(
        pg.llm, "chat_turns",
        lambda *a, **k: '{"reply": "Theek hai, sochta hoon.", "outcome": "ongoing", "reasoning": "customer non-committal"}',
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(event, session["history"], "okay", session["channel"], settings=_NO_LLM)
    assert result["outcome"] == "ptp_promised"
    assert result["sim_state"]["ptp_active"] is True


def test_clear_agreement_overrides_llm_ongoing_outcome_in_advance_conversation(monkeypatch):
    event = _event()
    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening line")

    def _fake_chat_turns(system, turns, *, settings, max_tokens=400):
        if "Recovery Agent" in system:
            return '{"reply": "Theek hai, sochta hoon.", "outcome": "ongoing", "reasoning": ""}'
        return "yes"

    monkeypatch.setattr(pg.llm, "chat_turns", _fake_chat_turns)
    history = pg.start_session(event, mode="ai", settings=_NO_LLM)["history"]
    result = pg.advance_conversation(event, history, "call", settings=_NO_LLM)
    assert result["outcome"] == "ptp_promised"
    assert result["sim_state"]["ptp_active"] is True


def test_agreement_override_does_not_fire_on_a_question(monkeypatch):
    """'yes, but why did it fail?' must NOT be forced into ptp_promised even
    via the override -- the question guard holds."""
    event = _event()
    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening line")
    monkeypatch.setattr(
        pg.llm, "chat_turns",
        lambda *a, **k: '{"reply": "Explaining the failure.", "outcome": "ongoing", "reasoning": ""}',
    )
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "yes, but why did it fail?", session["channel"], settings=_NO_LLM,
    )
    assert result["outcome"] == "ongoing"


def test_agreement_override_never_applies_to_human_takeover(monkeypatch):
    """speaker='agent' with an explicitly-supplied outcome must not be
    touched by the clear-agreement override."""
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "okay", session["channel"],
        speaker="agent", outcome="ongoing", settings=_NO_LLM,
    )
    assert result["outcome"] == "ongoing"


def test_fallback_identity_question_gets_honest_answer_not_recycled_explanation():
    """LLM unavailable: 'Are you a bot?' must not return the recycled
    root-cause explanation text, and must stay 'ongoing'."""
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "Are you a bot?", session["channel"], settings=_NO_LLM,
    )
    assert result["outcome"] == "ongoing"
    rc = event.root_cause
    explanation = pg._ROOT_CAUSE_EXPLANATIONS.get(rc, "")
    assert explanation not in result["turn"]["text"]
    assert "Recovery Assistant" in result["turn"]["text"] or "bot" in result["turn"]["text"].lower() or "automated" in result["turn"]["text"].lower()


def test_fallback_genuine_failure_question_still_gets_root_cause_explanation():
    """Existing question-detection behavior for genuine failure questions
    stays unchanged."""
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)
    result = pg.send_message(
        event, session["history"], "kyu fail hua?", session["channel"], settings=_NO_LLM,
    )
    assert result["outcome"] == "ongoing"
    explanation = pg._ROOT_CAUSE_EXPLANATIONS.get(event.root_cause, "")
    assert explanation in result["turn"]["text"]


def test_send_message_suppresses_duplicate_reminder_same_day(monkeypatch):
    event = _event()
    session = pg.start_session(event, mode="custom", settings=_NO_LLM)

    monkeypatch.setattr(pg.llm, "available", lambda s: True)
    monkeypatch.setattr(pg.llm, "chat", lambda *a, **k: "opening line")
    monkeypatch.setattr(
        pg.llm, "chat_turns",
        lambda *a, **k: '{"reply": "Koi baat nahi, jab convenient ho payment kar dijiye.", "outcome": "ongoing", "reasoning": ""}',
    )

    result1 = pg.send_message(
        event, session["history"], "hmm accha", session["channel"],
        sim_state=session["sim_state"], settings=_NO_LLM,
    )
    assert result1.get("suppressed") is not True
    assert result1["outcome"] == "ongoing"

    result2 = pg.send_message(
        event, result1["history"], "hmm accha", session["channel"],
        sim_state=result1["sim_state"], settings=_NO_LLM,
    )
    assert result2.get("suppressed") is True
    assert result2["turn"] is None
    assert result2["outcome"] == "ongoing"
