// Single data-access layer for the dashboard.
//
// Phase A/B: reads the frozen sample payloads in fixtures.json.
// Phase C: set VITE_DATA_SOURCE=live in the environment and every call is
// served by the real FastAPI client (src/api/client.ts) instead — no component
// change required. This is the one switch the team-lead flips.

import fixturesJson from './fixtures.json'
import { api } from './client'
import type {
  EventAuditResponse,
  EventRead,
  EventSimilarResponse,
  EventsResponse,
  ForcedPaymentReason,
  MetricsBlock,
  PaymentAttemptExhaustedResponse,
  PaymentAttemptResponse,
  PaymentPageResponse,
  PipelineRunResponse,
  PlaygroundAdvanceResponse,
  PlaygroundChannel,
  PlaygroundMessageResponse,
  PlaygroundMode,
  PlaygroundOutcome,
  PlaygroundPayResponse,
  PlaygroundSimState,
  PlaygroundSpeaker,
  PlaygroundStartResponse,
  PlaygroundTurn,
  TicketDetailResponse,
  TicketRead,
  TicketsResponse,
} from './types'

const SOURCE = (import.meta.env.VITE_DATA_SOURCE ?? 'fixtures').toLowerCase()
export const IS_LIVE = SOURCE === 'live' || SOURCE === 'api'

interface FixturesShape {
  events: EventsResponse
  eventAudit: EventAuditResponse
  eventSimilar: EventSimilarResponse
  pipelineRun: PipelineRunResponse
  metrics: MetricsBlock
  tickets: TicketsResponse
  ticketDetail: TicketDetailResponse
}

const fx = fixturesJson as unknown as FixturesShape

// Simulate a network hop so loading/skeleton states are exercised in fixture mode.
const settle = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 120))

// Fixture-mode tickets are held in memory and DO persist for the session, unlike
// the read-only event fixtures. The review workflow is a sequence -- take a
// ticket, then resolve it -- so a demo where the first step silently reverts
// would misrepresent how the feature behaves against the live API.
const ticketsMem: TicketRead[] = fx.tickets.tickets.map((t) => ({ ...t }))

const ticketsResponse = (): TicketsResponse => ({
  tickets: [...ticketsMem].sort(
    (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at),
  ),
  count: ticketsMem.length,
  open_count: ticketsMem.filter((t) => t.status === 'open').length,
  under_review_count: ticketsMem.filter((t) => t.status === 'under_review').length,
})

const patchTicket = (id: string, patch: Partial<TicketRead>): TicketRead => {
  const i = ticketsMem.findIndex((t) => t.ticket_id === id)
  if (i < 0) throw new Error(`no such ticket: ${id}`)
  ticketsMem[i] = { ...ticketsMem[i], ...patch, updated_at: new Date().toISOString() }
  return ticketsMem[i]
}

// --- fixture-mode Simulate / Playground -------------------------------
// A lightweight mirror of the backend's deterministic (no-LLM-key) fallback
// in app/agents/playground.py, so the feature demos end-to-end without a
// live backend. Same sandboxing property trivially holds: nothing here
// touches fx.events or any other fixture data.

const _CALL_CAUSES = new Set([
  'insufficient_funds', 'expired_instrument', 'bank_downtime',
  'auth_failure', 'card_declined', 'suspected_fraud',
])

const _mask = (value: string | null | undefined): string | null => {
  if (!value) return null
  const tail = value.slice(-4)
  return `${'•'.repeat(Math.max(value.length - 4, 4))}${tail}`
}

const fixtureChannel = (event: EventRead): PlaygroundChannel =>
  event.root_cause && _CALL_CAUSES.has(event.root_cause) ? 'call' : 'message'

const fixtureEvent = (id: string): EventRead =>
  fx.events.events.find((e) => e.event_id === id) ?? fx.events.events[0]

const fixturePersona = (event: EventRead) => ({
  name: event.customer_name ?? event.customer_id,
  phone_masked: _mask(event.customer_phone),
  bank_account_masked: _mask(event.customer_bank_account),
  upi_vpa: event.customer_upi_vpa ?? null,
  amount: event.amount,
  root_cause: event.root_cause,
  event_type: event.event_type,
  is_business: event.event_type === 'overdue_invoice',
  disposition: 'cooperative',
})

const fixtureOpening = (event: EventRead): string => {
  const persona = fixturePersona(event)
  return `Namaste ${persona.name} ji! Aapka Rs ${persona.amount} ka ${persona.event_type.replace(/_/g, ' ')} pending hai. Kya hum iske baare mein baat kar sakte hain?`
}

const fixtureAgentReply = (
  name: string,
  message: string,
  turnIndex: number,
): { reply: string; outcome: PlaygroundOutcome; reasoning: string } => {
  const text = message.toLowerCase().trim()
  if (/fraud|scam|nahi kiya|galat|block|hacked/.test(text)) {
    return {
      reply: `Samajh gaya ${name} ji, main isse turant ek human reviewer ko bhej raha hoon.`,
      outcome: 'escalated',
      reasoning: 'Customer disputes the transaction; needs human verification.',
    }
  }
  if (/angry|gussa|complaint|manager|escalate|bad service/.test(text)) {
    return {
      reply: 'Bilkul, main ise human team ko forward kar deta hoon jo aapki behtar madad kar payenge.',
      outcome: 'escalated',
      reasoning: "Customer asked for a person / pushed back beyond the agent's bounded authority.",
    }
  }
  const hasQuestion = /kyu|why|kaise|reason|kya hua|fail|problem|issue|batao|bataiye|detail|explain/.test(text) || text.includes('?')
  if (hasQuestion) {
    return {
      reply: 'Payment process hone ke dauraan bank network issue ya session timeout ho gaya tha. Kya main aapko ek fresh payment link bhej doon taaki aap ise easily complete kar sakein?',
      outcome: 'ongoing',
      reasoning: 'Explained failure reason in response to customer question.',
    }
  }
  const hasAgreement = /pay kar|link bhej|bhej do|bhejo|kar deta hoon|karta hoon|kar dunga|ready to pay|sure send|yes send|send link|paid/.test(text) ||
    (!hasQuestion && /^(haan|yes|theek hai|ok|okay|sure|done)$/.test(text))
  if (hasAgreement) {
    return {
      reply: `Shukriya ${name} ji! Maine secure Razorpay payment link send kar diya hai: https://rzp.io/i/rec_pay. Aapka Promise-to-Pay schedule ho gaya hai. Link se pay karte hi receipt mil jayegi.`,
      outcome: 'ptp_promised',
      reasoning: 'Customer agreed to pay; Payment Link dispatched; Promise-to-Pay recorded.',
    }
  }
  if (turnIndex >= 3) {
    return {
      reply: 'Koi baat nahi, main is case ko human review ke liye bhej deta hoon taaki hum aapki sahi madad kar sakein.',
      outcome: 'escalated',
      reasoning: 'No clear resolution after a few exchanges; handing off rather than looping.',
    }
  }
  return {
    reply: `Samajh sakta hoon ${name} ji. Kya main aapko turant ek payment link bhej doon?`,
    outcome: 'ongoing',
    reasoning: '',
  }
}

const _normalizeMode = (mode: PlaygroundMode): 'custom' | 'ai' =>
  mode === 'interactive' ? 'custom' : mode === 'auto' ? 'ai' : mode

const fixtureDefaultSimState = (mode: PlaygroundMode): PlaygroundSimState => {
  const norm = _normalizeMode(mode)
  return {
    mode: norm,
    controlled_by: norm === 'custom' ? { agent: 'ai', customer: 'human' } : { agent: 'ai', customer: 'ai' },
    sim_day: 1,
    sim_hour: 9,
    exchanges_today: 0,
    attempts_so_far: 0,
    escalation_stage: 0,
    customer_last_responded_day: 1,
    customer_response_probability: 0.7,
    outstanding_asks: [],
    last_reply_text: null,
    capture_attempts: 0,
  }
}

const fixtureFillSimState = (sim_state: PlaygroundSimState | undefined, mode: PlaygroundMode): PlaygroundSimState => {
  const defaults = fixtureDefaultSimState(mode)
  if (!sim_state) return defaults
  return {
    ...defaults,
    ...sim_state,
    controlled_by: { ...defaults.controlled_by, ...(sim_state.controlled_by ?? {}) },
    outstanding_asks: [...(sim_state.outstanding_asks ?? [])],
  }
}

const _ASK_PATTERNS: Record<string, string[]> = {
  'wants a GST invoice': ['gst', 'tax invoice', 'invoice chahiye', 'bill chahiye'],
  'wants the link resent via WhatsApp': ['whatsapp'],
  'wants the link resent via email': ['email pe', 'email par', 'email bhej', 'mail kar'],
  'wants a callback': ['call back', 'callback', 'phone karo', 'call me later'],
  'wants more detail': ['more detail', 'explain more', 'samjhao thoda', 'elaborate'],
}

const fixtureTrackAsks = (asks: string[], message: string): string[] => {
  const text = message.toLowerCase()
  const next = [...asks]
  for (const [label, keywords] of Object.entries(_ASK_PATTERNS)) {
    if (next.includes(label)) continue
    if (keywords.some((k) => text.includes(k))) next.push(label)
  }
  return next
}

const fixtureCustomerReply = (turnIndex: number): string => {
  const lines = [
    'Haan bataiye, kya baat hai?',
    'Achha theek hai, thoda samajh nahi aaya, aap detail mein bata sakte hain?',
    'Theek hai, mujhe lagta hai main abhi pay kar sakta hoon.',
  ]
  return lines[Math.min(turnIndex, lines.length - 1)]
}

export const dataSource = {
  isLive: IS_LIVE,

  async getEvents(): Promise<EventsResponse> {
    if (IS_LIVE) return api.listEvents()
    return settle(fx.events)
  },

  async getMetrics(): Promise<MetricsBlock> {
    if (IS_LIVE) return api.getMetrics()
    return settle(fx.metrics)
  },

  async getEventAudit(id: string): Promise<EventAuditResponse> {
    if (IS_LIVE) return api.getAuditTrail(id)
    const canned = fx.eventAudit
    if (canned.event.event_id === id) return settle(canned)
    // Fixture only ships one trail; synthesize an honest empty trail for the rest
    // so non-terminal / un-audited events still render in the drawer.
    const events = fx.events.events
    const event = events.find((e) => e.event_id === id) ?? canned.event
    return settle({ event, trail: [] })
  },

  async getSimilar(id: string): Promise<EventSimilarResponse> {
    if (IS_LIVE) return api.getSimilar(id)
    // fixture ships one sample; other events get an honest empty list
    if (fx.eventSimilar?.event_id === id) return settle(fx.eventSimilar)
    return settle({ event_id: id, similar: [] })
  },

  async getVoiceScript(id: string) {
    if (IS_LIVE) return api.getVoiceScript(id)
    return settle({
      event_id: id,
      script: {
        script_summary: 'Hinglish conversational recovery call dialogue',
        dialogue_turns: [
          { speaker: 'Agent', text: 'Namaste ji! Razorpay Support se bol rahe hain aapke pending payment ke regarding.', emotion: 'polite' },
          { speaker: 'Customer', text: 'Haan ji, main check karta hoon.', emotion: 'receptive' },
          { speaker: 'Agent', text: 'Aapko instant WhatsApp link send kar diya gaya hai. Thank you!', emotion: 'helpful' },
        ],
        estimated_duration_sec: 35,
        whatsapp_followup_hinglish: `Namaste ji! Aapka transaction complete karne ke liye direct payment link: https://rzp.io/pay/${id}`,
      },
    })
  },

  async getVoiceAudio(id: string) {
    if (IS_LIVE) return api.getVoiceAudio(id)
    // No TTS provider in fixture mode — dashboard uses the browser voice.
    return settle({
      event_id: id,
      available: false,
      provider: 'sarvam',
      audio_format: 'wav',
      sample_rate: 22050,
      audio: [],
    })
  },

  async getSequencerSchedule(id: string) {
    if (IS_LIVE) return api.getSequencerSchedule(id)
    return settle({
      event_id: id,
      rail: 'upi_autopay',
      schedule: [
        {
          step_number: 1,
          rail: 'upi_autopay',
          scheduled_time: new Date().toISOString(),
          action: 'salary_window_debit',
          channel: 'whatsapp_and_sms',
          pre_debit_notification: true,
          expected_recovery_prob: 0.75,
          rationale: 'Scheduled debit aligned with expected salary credit window',
          compliance_tag: 'NPCI_CIRCULAR_2024_PTP',
        },
      ],
    })
  },

  async recordPTP(id: string, promisedDate: string, notes?: string) {
    if (IS_LIVE) return api.recordPTP(id, promisedDate, notes)
    return settle({
      status: 'ok',
      event: {
        ...(fx.events.events.find((e) => e.event_id === id) ?? fx.eventAudit.event),
        promised_date: promisedDate,
        ptp_status: 'promised' as const,
      },
    })
  },

  // --- human review queue ---

  async getTickets(status?: string): Promise<TicketsResponse> {
    if (IS_LIVE) return api.listTickets(status)
    const all = ticketsResponse()
    if (!status) return settle(all)
    const tickets = all.tickets.filter((t) => t.status === status)
    return settle({ ...all, tickets, count: tickets.length })
  },

  async getTicket(id: string): Promise<TicketDetailResponse> {
    if (IS_LIVE) return api.getTicket(id)
    const ticket = ticketsMem.find((t) => t.ticket_id === id)
    if (!ticket) return settle(fx.ticketDetail)
    // the fixture ships one full trail; other tickets reuse their event's
    const canned = fx.ticketDetail
    const event =
      fx.events.events.find((e) => e.event_id === ticket.event_id) ?? canned.event
    return settle({
      ticket,
      event,
      trail: canned.ticket.event_id === ticket.event_id ? canned.trail : [],
    })
  },

  async assignTicket(id: string, employeeEmail: string) {
    if (IS_LIVE) return api.assignTicket(id, employeeEmail)
    const current = ticketsMem.find((t) => t.ticket_id === id)
    if (current && current.status !== 'open') {
      throw new Error(`ticket ${id} is ${current.status}, not open`)
    }
    return settle({
      status: 'ok',
      ticket: patchTicket(id, {
        status: 'under_review',
        assigned_employee_email: employeeEmail,
        assigned_at: new Date().toISOString(),
      }),
    })
  },

  async resolveTicket(
    id: string,
    body: {
      employee_email: string
      outcome: 'resolved' | 'unresolved'
      note: string
      recovered_amount?: string | null
    },
  ) {
    if (IS_LIVE) return api.resolveTicket(id, body)
    return settle({
      status: 'ok',
      ticket: patchTicket(id, {
        status: body.outcome,
        resolution_outcome: body.outcome,
        resolution_note: body.note,
        recovered_amount: body.recovered_amount ?? '0.00',
      }),
    })
  },

  async raiseQuestion(
    eventId: string,
    body: { question: string; channel?: string; employee_email?: string | null },
  ) {
    if (IS_LIVE) return api.raiseQuestion(eventId, body)
    const now = new Date().toISOString()
    const ticket: TicketRead = {
      ticket_id: `tkt_${String(ticketsMem.length + 1).padStart(4, '0')}`,
      event_id: eventId,
      reason: 'customer_question',
      priority: 80,
      status: 'open',
      summary: 'Customer asked something the AI could not answer.',
      detail: body.question,
      assigned_employee_email: null,
      assigned_at: null,
      resolution_note: null,
      resolution_outcome: null,
      recovered_amount: '0.00',
      created_at: now,
      updated_at: now,
    }
    ticketsMem.push(ticket)
    return settle({ status: 'ok', ticket })
  },

  // --- Simulate / Playground (sandboxed rehearsal) ---

  async startPlayground(
    eventId: string,
    mode: PlaygroundMode,
    channel?: PlaygroundChannel,
  ): Promise<PlaygroundStartResponse> {
    if (IS_LIVE) return api.startPlayground(eventId, mode, channel)
    const event = fixtureEvent(eventId)
    const opening: PlaygroundTurn = { speaker: 'agent', text: fixtureOpening(event) }
    const sim_state = fixtureDefaultSimState(mode)
    sim_state.last_reply_text = opening.text
    return settle({
      mode,
      channel: channel ?? fixtureChannel(event),
      ticket_ref: `SIM-${eventId.slice(-4).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`,
      persona: fixturePersona(event),
      opening_turn: opening,
      outcome: 'ongoing',
      history: [opening],
      sim_state,
    })
  },

  async sendPlaygroundMessage(
    eventId: string,
    history: PlaygroundTurn[],
    message: string,
    _channel: string,
    opts?: { speaker?: PlaygroundSpeaker; outcome?: string; sim_state?: PlaygroundSimState },
  ): Promise<PlaygroundMessageResponse> {
    if (IS_LIVE) return api.sendPlaygroundMessage(eventId, history, message, _channel, opts)
    const event = fixtureEvent(eventId)
    const persona = fixturePersona(event)
    const speaker = opts?.speaker ?? 'customer'
    const withSpeaker: PlaygroundTurn[] = [...history, { speaker, text: message }]

    if (speaker === 'agent') {
      // Human took over the Resolver role — trust the declared outcome as-supplied.
      const st = fixtureFillSimState(opts?.sim_state, opts?.sim_state?.mode ?? 'custom')
      st.last_reply_text = message
      const finalOutcome = (opts?.outcome as PlaygroundOutcome) ?? 'ongoing'
      const result: PlaygroundMessageResponse = {
        turn: { speaker: 'agent', text: message },
        outcome: finalOutcome,
        reasoning: 'human agent override (outcome supplied by the human reviewer)',
        history: withSpeaker,
        sim_state: st,
      }
      if (finalOutcome === 'escalated') {
        result.escalation = {
          reason: 'out_of_scope',
          outstanding_asks: st.outstanding_asks,
          last_customer_message: [...history].reverse().find((h) => h.speaker === 'customer')?.text ?? '',
          root_cause: event.root_cause,
          attempts_so_far: st.attempts_so_far,
          conversation_summary: `${withSpeaker.length}-turn rehearsal conversation; human reviewer closed it out.`,
        }
      }
      return settle(result)
    }

    const st = fixtureFillSimState(opts?.sim_state, opts?.sim_state?.mode ?? 'custom')
    st.outstanding_asks = fixtureTrackAsks(st.outstanding_asks, message)
    const turnIndex = withSpeaker.filter((h) => h.speaker === 'customer').length
    const result = fixtureAgentReply(persona.name, message, turnIndex)
    st.attempts_so_far += 1
    st.last_reply_text = result.reply
    const turn: PlaygroundTurn = { speaker: 'agent', text: result.reply }
    const newHistory = [...withSpeaker, turn]
    const out: PlaygroundMessageResponse = {
      turn,
      outcome: result.outcome,
      reasoning: result.reasoning,
      history: newHistory,
      sim_state: st,
    }
    if (result.outcome === 'escalated') {
      out.escalation = {
        reason: /human|manager|supervisor/.test(message.toLowerCase())
          ? 'customer_requested_human'
          : st.attempts_so_far >= 3
          ? 'max_attempts_exceeded'
          : 'out_of_scope',
        outstanding_asks: st.outstanding_asks,
        last_customer_message: message,
        root_cause: event.root_cause,
        attempts_so_far: st.attempts_so_far,
        conversation_summary: `${newHistory.length}-turn rehearsal conversation, no resolution reached.`,
      }
    }
    return settle(out)
  },

  async advancePlayground(
    eventId: string,
    history: PlaygroundTurn[],
    _channel: string,
    simState?: PlaygroundSimState,
  ): Promise<PlaygroundAdvanceResponse> {
    if (IS_LIVE) return api.advancePlayground(eventId, history, _channel, simState)
    const event = fixtureEvent(eventId)
    const persona = fixturePersona(event)
    const st = fixtureFillSimState(simState, simState?.mode ?? 'ai')
    const turnIndex = history.filter((h) => h.speaker === 'customer').length
    const customerTurn: PlaygroundTurn = { speaker: 'customer', text: fixtureCustomerReply(turnIndex) }
    const withCustomer = [...history, customerTurn]
    st.outstanding_asks = fixtureTrackAsks(st.outstanding_asks, customerTurn.text)
    const result = fixtureAgentReply(persona.name, customerTurn.text, turnIndex + 1)
    st.attempts_so_far += 1
    st.last_reply_text = result.reply
    const agentTurn: PlaygroundTurn = { speaker: 'agent', text: result.reply }
    const newHistory = [...withCustomer, agentTurn]
    const out: PlaygroundAdvanceResponse = {
      no_response: false,
      customer_turn: customerTurn,
      agent_turn: agentTurn,
      outcome: result.outcome,
      reasoning: result.reasoning,
      history: newHistory,
      sim_state: st,
    }
    if (result.outcome === 'escalated') {
      out.escalation = {
        reason: st.attempts_so_far >= 3 ? 'max_attempts_exceeded' : 'out_of_scope',
        outstanding_asks: st.outstanding_asks,
        last_customer_message: customerTurn.text,
        root_cause: event.root_cause,
        attempts_so_far: st.attempts_so_far,
        conversation_summary: `${newHistory.length}-turn rehearsal conversation, no resolution reached.`,
      }
    }
    return settle(out)
  },

  async simulatePlaygroundPayment(
    eventId: string,
    history: PlaygroundTurn[],
    channel: string,
    simState?: PlaygroundSimState,
    forcedReason?: ForcedPaymentReason,
  ): Promise<PlaygroundPayResponse> {
    if (IS_LIVE) {
      return api.simulatePlaygroundPayment(eventId, history, channel, simState, forcedReason)
    }
    const event = fixtureEvent(eventId)
    const persona = fixturePersona(event)
    const st = fixtureFillSimState(simState, simState?.mode ?? 'custom')
    st.capture_attempts += 1

    if (forcedReason && forcedReason !== 'success') {
      const FAILURE_TEXT: Record<Exclude<ForcedPaymentReason, 'success'>, string> = {
        wrong_otp: 'OTP verification galat ho gaya, payment complete nahi hua. Agli baar phone par aaya sahi 6-digit OTP dhyan se daalein.',
        wrong_password: 'Aapke login credentials galat the, isliye payment complete nahi hua. Apna Razorpay/bank login verify karke dobara try karein.',
        user_cancelled: 'Lagta hai payment complete hone se pehle hi aap back aa gaye. Is baar link khol kar OTP step tak process poora karein.',
        insufficient_funds: '',
      }
      let text = FAILURE_TEXT[forcedReason]
      if (forcedReason === 'insufficient_funds') {
        st.salary_reminder_day = st.sim_day + 5
        text = `Filhaal aapke account mein balance kam hai. Main aapko salary credit ke around, Day ${st.salary_reminder_day}, dobara reminder bhejunga.`
      }
      const turn: PlaygroundTurn = { speaker: 'agent', text }
      return settle({
        turn,
        outcome: 'ongoing' as PlaygroundOutcome,
        reasoning:
          forcedReason === 'insufficient_funds'
            ? `Payment failed: insufficient funds; rescheduled reminder to sim day ${st.salary_reminder_day}, no escalation.`
            : `Payment attempt failed: ${forcedReason} (tester-selected at checkout).`,
        history: [...history, turn],
        payment_id: null,
        amount: persona.amount,
        sim_state: st,
        captured: false,
        reason: forcedReason,
      })
    }

    const txId = `pay_sim_${eventId.slice(-4)}${Math.floor(Math.random() * 900 + 100)}`
    const turn: PlaygroundTurn = {
      speaker: 'agent',
      text: `Payment of Rs ${persona.amount} received successfully! Razorpay Transaction ID: ${txId}. Receipt generated. Case marked RESOLVED.`,
    }
    return settle({
      turn,
      outcome: 'resolved',
      reasoning: `Customer completed payment via Razorpay link (webhook payment.captured: ${txId}). Verified revenue recovery.`,
      history: [...history, turn],
      payment_id: txId,
      amount: persona.amount,
      sim_state: st,
      captured: true,
      reason: 'captured',
    })
  },

  async runPipeline(): Promise<PipelineRunResponse> {
    if (IS_LIVE) return api.runPipeline()
    return settle(fx.pipelineRun)
  },

  // --- public payment-link checkout (/pay/:token) ---

  async getPaymentPage(token: string): Promise<PaymentPageResponse> {
    if (IS_LIVE) return api.getPaymentPage(token)
    const event = fx.events.events.find((e) => e.payment_link_id === token)
    if (!event) throw new Error(`no such payment link: ${token}`)
    return settle({
      token,
      event_id: event.event_id,
      customer_name: event.customer_name ?? event.customer_id,
      amount: event.amount,
      currency: event.currency,
      payment_link_status: event.payment_link_status ?? 'awaiting_capture',
      attempts_made: 0,
      attempts_remaining: 3,
    })
  },

  async attemptPayment(
    token: string,
  ): Promise<PaymentAttemptResponse | PaymentAttemptExhaustedResponse> {
    if (IS_LIVE) return api.attemptPayment(token)
    // Fixture mode has no server-side attempt counter; simulate a single
    // successful capture so the page's happy path can be exercised offline.
    return settle({ captured: true, reason: 'captured', attempts_remaining: 2 })
  },
}
