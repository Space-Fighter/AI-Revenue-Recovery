// Typed shapes for the frozen API contract (AGENTS_CONTRACT.md §8, documentation.md §5).
// All money fields are decimal strings; rates are floats 0-1.

export type EventStatus =
  | 'detected'
  | 'diagnosed'
  | 'action_taken'
  | 'recovered'
  | 'exception'
  | 'flagged'

export type RootCause =
  | 'insufficient_funds'
  | 'expired_instrument'
  | 'bank_downtime'
  | 'auth_failure'
  | 'card_declined'
  | 'checkout_abandoned'
  | 'invoice_forgotten'
  | 'suspected_fraud'
  | 'unknown'

export type AgentName =
  | 'detection'
  | 'diagnosis'
  | 'recovery'
  | 'triage'
  | 'audit'
  | 'human' // a real employee acting on a review ticket

export type PTPStatus = 'none' | 'promised' | 'honored' | 'broken'

export interface EventRead {
  event_id: string
  event_type: string
  customer_id: string
  amount: string
  currency: string
  /** Synthetic — Razorpay's test mode has no customer/contact simulator; the
   * generator invents these, same posture as customer_id. Never real PII. */
  customer_name?: string | null
  customer_phone?: string | null
  customer_bank_account?: string | null
  customer_upi_vpa?: string | null
  raw_failure_reason: string | null
  attempts_so_far: number
  days_overdue: number
  created_at: string
  updated_at: string
  status: EventStatus
  root_cause: RootCause | null
  diagnosis_confidence: number | null
  recovered_amount: string
  /** Of `recovered_amount`, how much a human brought in working a review ticket. */
  human_recovered_amount?: string
  promised_date?: string | null
  ptp_status?: PTPStatus
  retry_schedule?: Array<Record<string, unknown>> | null
  /** `plink_...` = a real Razorpay test-mode Payment Link; `fake_...` = the
   * fake gateway (no Razorpay test-mode keys configured for this run). */
  payment_link_id?: string | null
  payment_link_status?: string
}

export interface AuditRead {
  id: number
  event_id: string
  agent: AgentName
  action: string
  reasoning: string
  payload: unknown
  timestamp: string
}

export interface EventsResponse {
  count: number
  events: EventRead[]
}

export interface EventAuditResponse {
  event: EventRead
  trail: AuditRead[]
}

export interface SimilarCase {
  event_id: string
  event_type: string
  raw_failure_reason: string | null
  case_text: string
  root_cause: RootCause
  source: string // "pipeline" | "reference"
  similarity: number // cosine similarity 0..1
}

export interface EventSimilarResponse {
  event_id: string
  similar: SimilarCase[]
}

export interface DialogueTurn {
  speaker: string
  text: string
  emotion?: string
}

export interface VoiceScript {
  script_summary: string
  dialogue_turns: DialogueTurn[]
  estimated_duration_sec: number
  whatsapp_followup_hinglish: string
}

export interface EventVoiceResponse {
  event_id: string
  script: VoiceScript
}

// --- human review queue (backend: app/agents/triage.py) --------------------

export type TicketStatus = 'open' | 'under_review' | 'resolved' | 'unresolved'

export type TicketReason =
  | 'suspected_fraud'
  | 'customer_question'
  | 'awaiting_approval'
  | 'exception_no_error'
  | 'invoice_handoff'
  | 'stalled_no_response'
  | 'other'

export interface TicketRead {
  ticket_id: string
  event_id: string
  reason: TicketReason
  /** Higher = more urgent. Bands: >=85 critical, >=60 high, >=40 medium, else low. */
  priority: number
  status: TicketStatus
  summary: string
  detail: string | null
  assigned_employee_email: string | null
  assigned_at: string | null
  resolution_note: string | null
  resolution_outcome: 'resolved' | 'unresolved' | null
  recovered_amount: string
  created_at: string
  updated_at: string
}

export interface TicketsResponse {
  tickets: TicketRead[]
  count: number
  open_count: number
  under_review_count: number
}

export interface TicketDetailResponse {
  ticket: TicketRead
  event: EventRead | null
  trail: AuditRead[]
}

export interface TicketMutationResponse {
  status: string
  ticket: TicketRead
}

export interface TicketMetrics {
  total: number
  open: number
  under_review: number
  resolved: number
  unresolved: number
  needs_attention: number
  by_reason: Record<TicketReason, number>
  oldest_open_hours: number
  resolution_rate: number
  human_recovered: string
}

export interface VoiceAudioClip {
  index: number
  speaker: string
  audio_base64: string
}

export interface EventVoiceAudioResponse {
  event_id: string
  available: boolean
  provider: string
  audio_format: string
  sample_rate: number
  audio: VoiceAudioClip[]
  /** Why `available` is false — e.g. "no SARVAM_API_KEY configured". Null when available. */
  reason?: string | null
}

export interface RetryStep {
  step_number: number
  rail: string
  scheduled_time: string
  action: string
  channel: string
  pre_debit_notification: boolean
  expected_recovery_prob: number
  rationale: string
  compliance_tag: string
}

export interface EventSequencerResponse {
  event_id: string
  rail: string
  schedule: RetryStep[]
}

export interface ByRootCause {
  root_cause: RootCause
  at_risk: string
  recovered: string
  count: number
  recovered_count: number
  recovery_rate: number
}

export interface ByIntervention {
  intervention: string
  count: number
  recovered_count: number
  recovery_rate: number
  at_risk: string
  recovered: string
}

export interface ExceptionRow {
  event_id: string
  event_type: string
  amount: string
  root_cause: RootCause | null
  reason: string
}

export interface FraudCluster {
  flagged_event_ids: string[]
  reason: string
}

export interface PTPMetrics {
  total_ptp_recorded: number
  total_honored: number
  total_broken: number
  active_promised: number
  honor_rate: number
  amount_recovered_ptp: string
}

export interface MetricsBlock {
  total_at_risk: string
  /** The honest total. `ai_recovered + human_recovered` always equals this. */
  total_recovered: string
  ai_recovered?: string
  human_recovered?: string
  overall_recovery_rate: number
  event_count: number
  by_root_cause: ByRootCause[]
  by_intervention: ByIntervention[]
  avg_hours_to_recovery: number
  status_breakdown: Record<EventStatus, number>
  exceptions: ExceptionRow[]
  fraud_cluster: FraudCluster
  ptp_metrics?: PTPMetrics
  tickets?: TicketMetrics
}

// --- Public payment-link checkout (backend: app/api/payment_routes.py) -----
// A real customer lands here from an SMS/WhatsApp link. No dashboard chrome.

export interface PaymentPageResponse {
  token: string
  event_id: string
  customer_name: string
  amount: string
  currency: string
  payment_link_status: string
  attempts_made: number
  attempts_remaining: number
}

export type PaymentAttemptFailureReason = 'wrong_otp' | 'insufficient_funds' | 'user_cancelled'

export interface PaymentAttemptResponse {
  captured: boolean
  reason: PaymentAttemptFailureReason | 'captured' | 'already_captured'
  attempts_remaining: number
}

export interface PaymentAttemptExhaustedResponse {
  status: 'error'
  reason: 'max_attempts_exceeded'
  attempts_remaining: 0
}

export interface PipelineRunResponse {
  ran_at: string
  metrics: MetricsBlock
}

// --- Simulate / Playground (backend: app/agents/playground.py) -------------
// A sandboxed rehearsal: talk to the AI live and see how it actually
// responds, instead of only reading the prerecorded call/WhatsApp transcript.
// Writes nothing to the real events/tickets tables and never touches
// MetricsBlock — every screen here is labeled as a rehearsal.

// 'custom'/'ai' are the current names; 'interactive'/'auto' are legacy
// aliases still accepted by the backend (AGENTS_CONTRACT.md §12/§13 S5) —
// prefer sending 'custom'/'ai' going forward.
export type PlaygroundMode = 'custom' | 'ai' | 'interactive' | 'auto'
export type PlaygroundChannel = 'call' | 'message'
export type PlaygroundOutcome = 'ongoing' | 'ptp_promised' | 'resolved' | 'escalated' | 'halted'
export type PlaygroundSpeaker = 'agent' | 'customer'

export interface PlaygroundTurn {
  speaker: PlaygroundSpeaker
  text: string
}

// Round-tripped verbatim: resend the exact object received in the next
// request's body (AGENTS_CONTRACT.md §12, frozen shape).
export interface PlaygroundSimState {
  mode: 'custom' | 'ai'
  controlled_by: { agent: 'ai' | 'human'; customer: 'ai' | 'human' }
  sim_day: number
  sim_hour: number
  exchanges_today: number
  attempts_so_far: number
  escalation_stage: number
  customer_last_responded_day: number
  customer_response_probability: number
  outstanding_asks: string[]
  last_reply_text: string | null
  capture_attempts: number
  /** 0 = not scheduled. Sandbox stand-in for `recovery.SALARY_WINDOW_DAY` — a
   * relative sim_day the agent has promised to remind the customer again on,
   * set after an `insufficient_funds` checkout failure (never escalates). */
  salary_reminder_day?: number
}

/** Tester-picked outcome at the embedded fake-checkout screen. `undefined`
 * keeps the backend's existing random-roll fake-gateway behavior. */
export type ForcedPaymentReason =
  | 'success'
  | 'wrong_otp'
  | 'wrong_password'
  | 'user_cancelled'
  | 'insufficient_funds'

export type PlaygroundEscalationReason =
  | 'customer_requested_human'
  | 'out_of_scope'
  | 'max_attempts_exceeded'

export interface PlaygroundEscalation {
  reason: PlaygroundEscalationReason
  outstanding_asks: string[]
  last_customer_message: string
  root_cause: RootCause | null
  attempts_so_far: number
  conversation_summary: string
}

export interface PlaygroundPersona {
  name: string
  phone_masked: string | null
  bank_account_masked: string | null
  upi_vpa: string | null
  amount: string
  root_cause: RootCause | null
  event_type: string
  is_business: boolean
  disposition: string
}

export interface PlaygroundStartResponse {
  mode: PlaygroundMode
  channel: PlaygroundChannel
  /** Cosmetic rehearsal-ticket reference (e.g. "SIM-A1B2345") — never a real ticket row. */
  ticket_ref: string
  persona: PlaygroundPersona
  opening_turn: PlaygroundTurn
  outcome: PlaygroundOutcome
  history: PlaygroundTurn[]
  sim_state?: PlaygroundSimState
}

export interface PlaygroundMessageResponse {
  turn: PlaygroundTurn
  outcome: PlaygroundOutcome
  reasoning: string
  history: PlaygroundTurn[]
  sim_state?: PlaygroundSimState
  escalation?: PlaygroundEscalation
}

export interface PlaygroundAdvanceResponse {
  /** `no_response: true` -> a simulated "customer didn't reply this turn";
   * render as a greyed placeholder row, not a chat bubble. */
  no_response?: boolean
  customer_turn: PlaygroundTurn | null
  agent_turn: PlaygroundTurn | null
  outcome: PlaygroundOutcome
  reasoning: string
  history: PlaygroundTurn[]
  sim_state?: PlaygroundSimState
  escalation?: PlaygroundEscalation
}

export interface PlaygroundPayResponse {
  turn: PlaygroundTurn
  outcome: PlaygroundOutcome
  reasoning: string
  history: PlaygroundTurn[]
  payment_id: string | null
  amount: string
  sim_state?: PlaygroundSimState
  captured?: boolean
  reason?: string
  escalation?: PlaygroundEscalation
}
