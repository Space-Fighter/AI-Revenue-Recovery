// Plain-business-English labels — mirror Razorpay's Agent Studio tone (plan.md §11).
// No ML jargon, no raw enum strings shown to a user.

import type {
  AgentName,
  EventStatus,
  RootCause,
  TicketReason,
  TicketStatus,
} from './types'

export const AGENT_LABEL: Record<AgentName, string> = {
  detection: 'Detection',
  diagnosis: 'Diagnosis',
  recovery: 'Recovery',
  triage: 'Triage',
  audit: 'Reporting',
  human: 'Human reviewer',
}

export const STATUS_LABEL: Record<EventStatus, string> = {
  detected: 'Detected',
  diagnosed: 'Diagnosed',
  action_taken: 'Action taken',
  recovered: 'Recovered',
  exception: "Couldn't recover",
  flagged: 'Halted — do not retry',
}

export const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  insufficient_funds: 'Insufficient funds',
  expired_instrument: 'Expired card or mandate',
  bank_downtime: 'Bank downtime',
  auth_failure: 'Authentication failed',
  card_declined: 'Card declined',
  checkout_abandoned: 'Checkout abandoned',
  invoice_forgotten: 'Invoice forgotten',
  suspected_fraud: 'Suspected fraud',
  unknown: 'Unclassified',
}

export const INTERVENTION_LABEL: Record<string, string> = {
  scheduled_retry: 'Scheduled retry',
  sent_reauth_link: 'Re-authorization link',
  suggested_alternate_method: 'Suggested another method',
  prompted_guided_retry: 'Guided retry prompt',
  sent_nudge: 'Personalized nudge',
  escalation_stage_advanced: 'Invoice escalation ladder',
}

export const ACTION_LABEL: Record<string, string> = {
  flagged_at_risk: 'Confirmed at risk',
  routed_to_exception: 'Routed to exceptions',
  classified_root_cause: 'Identified the root cause',
  llm_classified_root_cause: 'Identified the root cause (assisted)',
  halted_fraud_cluster: 'Halted — matches a fraud cluster',
  intervention_selected: 'Chose a recovery approach',
  scheduled_retry: 'Scheduled a retry',
  sent_reauth_link: 'Sent a re-authorization link',
  suggested_alternate_method: 'Suggested another payment method',
  prompted_guided_retry: 'Prompted a guided retry',
  sent_nudge: 'Sent a nudge',
  escalation_stage_advanced: 'Advanced the escalation ladder',
  awaiting_human_approval: 'Waiting on human approval',
  halted_stopping_rule: 'Stopped — a safety rule was reached',
  marked_recovered: 'Marked recovered',
  batch_metrics: 'Computed batch metrics',
  opened_review_ticket: 'Opened a review ticket',
  assigned_review_ticket: 'Taken for human review',
  resolved_review_ticket: 'Closed by a human reviewer',
  human_recovered: 'Recovered by a human',
  raised_customer_question: 'Customer asked something we cannot answer',
  ptp_recorded: 'Recorded a promise to pay',
  ptp_honored: 'Promise to pay honoured',
  ptp_broken: 'Promise to pay broken',
  ptp_paused_escalation: 'Escalation paused for Promise-to-Pay',
  ingested_webhook_event: 'Ingested a Razorpay webhook',
  // --- payment engine actions ---
  payment_link_sent: 'Generated & sent payment link',
  payment_captured: 'Payment captured & verified ✓',
  payment_capture_failed: 'Payment capture failed',
  // --- customer actions (first-class audit items) ---
  customer_responded: 'Customer replied to outreach',
  customer_voice_turn: 'Customer spoke during voice call',
  customer_silence: 'Customer did not respond (silence)',
  payment_link_clicked: 'Customer clicked payment link',
  customer_otp_submitted: 'Customer entered checkout OTP',
  customer_cancelled_payment: 'Customer dismissed payment screen',
  customer_requested_human: 'Customer requested a human agent',
  customer_promised_to_pay: 'Customer agreed to Promise-to-Pay',
  // --- simulation & orchestration actions ---
  simulation_started: 'Simulation session initialized',
  channel_switched: 'Switched outreach channel',
  escalation_triggered: 'Escalated to human review queue',
}

export type AuditCategory =
  | 'payment'
  | 'customer'
  | 'intervention'
  | 'diagnosis'
  | 'commitment'
  | 'safety'
  | 'human'
  | 'simulation'

export interface CategoryTheme {
  label: string
  icon: string
  badgeBg: string
  badgeText: string
  borderColor: string
  bgSoft: string
  markerColor: string
}

export const CATEGORY_THEME: Record<AuditCategory, CategoryTheme> = {
  payment: {
    label: 'Payments & Checkouts',
    icon: '💳',
    badgeBg: 'bg-emerald-500/20',
    badgeText: 'text-emerald-300',
    borderColor: 'border-emerald-500/40',
    bgSoft: 'bg-emerald-950/25',
    markerColor: '#10b981',
  },
  customer: {
    label: 'Customer Actions',
    icon: '👤',
    badgeBg: 'bg-amber-500/20',
    badgeText: 'text-amber-300',
    borderColor: 'border-amber-500/40',
    bgSoft: 'bg-amber-950/25',
    markerColor: '#f59e0b',
  },
  intervention: {
    label: 'Interventions & Outreach',
    icon: '⚡',
    badgeBg: 'bg-purple-500/20',
    badgeText: 'text-purple-300',
    borderColor: 'border-purple-500/40',
    bgSoft: 'bg-purple-950/25',
    markerColor: '#a855f7',
  },
  diagnosis: {
    label: 'Diagnosis & Detection',
    icon: '🔍',
    badgeBg: 'bg-sky-500/20',
    badgeText: 'text-sky-300',
    borderColor: 'border-sky-500/40',
    bgSoft: 'bg-sky-950/25',
    markerColor: '#0ea5e9',
  },
  commitment: {
    label: 'Promises & Commitments',
    icon: '🤝',
    badgeBg: 'bg-teal-500/20',
    badgeText: 'text-teal-300',
    borderColor: 'border-teal-500/40',
    bgSoft: 'bg-teal-950/25',
    markerColor: '#14b8a6',
  },
  safety: {
    label: 'Safety & Halts',
    icon: '🛡️',
    badgeBg: 'bg-rose-500/20',
    badgeText: 'text-rose-300',
    borderColor: 'border-rose-500/40',
    bgSoft: 'bg-rose-950/25',
    markerColor: '#ef4444',
  },
  human: {
    label: 'Human Review',
    icon: '🧑‍💼',
    badgeBg: 'bg-orange-500/20',
    badgeText: 'text-orange-300',
    borderColor: 'border-orange-500/40',
    bgSoft: 'bg-orange-950/25',
    markerColor: '#f97316',
  },
  simulation: {
    label: 'Sandbox Simulation',
    icon: '🧪',
    badgeBg: 'bg-indigo-500/20',
    badgeText: 'text-indigo-300',
    borderColor: 'border-indigo-500/40',
    bgSoft: 'bg-indigo-950/25',
    markerColor: '#6366f1',
  },
}

export function getAuditCategory(action: string, agent?: string): AuditCategory {
  if (
    agent === 'customer' ||
    action.startsWith('customer_') ||
    action === 'payment_link_clicked'
  ) {
    return 'customer'
  }
  if (
    action === 'payment_link_sent' ||
    action === 'payment_captured' ||
    action === 'payment_capture_failed' ||
    action === 'sent_reauth_link' ||
    action === 'marked_recovered'
  ) {
    return 'payment'
  }
  if (
    action === 'halted_fraud_cluster' ||
    action === 'halted_stopping_rule' ||
    action === 'routed_to_exception' ||
    action === 'awaiting_human_approval' ||
    action === 'escalation_triggered'
  ) {
    return 'safety'
  }
  if (
    action === 'ptp_recorded' ||
    action === 'ptp_honored' ||
    action === 'ptp_broken' ||
    action === 'ptp_paused_escalation'
  ) {
    return 'commitment'
  }
  if (
    action === 'opened_review_ticket' ||
    action === 'assigned_review_ticket' ||
    action === 'resolved_review_ticket' ||
    action === 'human_recovered' ||
    action === 'raised_customer_question' ||
    agent === 'human' ||
    agent === 'triage'
  ) {
    return 'human'
  }
  if (
    action === 'flagged_at_risk' ||
    action === 'classified_root_cause' ||
    action === 'llm_classified_root_cause' ||
    action === 'ingested_webhook_event' ||
    agent === 'detection' ||
    agent === 'diagnosis'
  ) {
    return 'diagnosis'
  }
  if (
    action === 'simulation_started' ||
    action === 'channel_switched' ||
    agent === 'simulation'
  ) {
    return 'simulation'
  }
  return 'intervention'
}


// --- human review queue ---

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  under_review: 'Under review',
  resolved: 'Resolved',
  unresolved: "Couldn't resolve",
}

export const TICKET_REASON_LABEL: Record<TicketReason, string> = {
  suspected_fraud: 'Suspected fraud',
  customer_question: 'Customer question',
  awaiting_approval: 'Needs approval',
  exception_no_error: 'No error on file',
  invoice_handoff: 'Invoice handoff',
  stalled_no_response: 'Stalled, no response',
  other: 'Needs a decision',
}

/** Priority bands mirror app/agents/triage.PRIORITY_BANDS. */
export type PriorityBand = 'critical' | 'high' | 'medium' | 'low'

export const priorityBand = (priority: number): PriorityBand =>
  priority >= 85 ? 'critical' : priority >= 60 ? 'high' : priority >= 40 ? 'medium' : 'low'

export const PRIORITY_BAND_LABEL: Record<PriorityBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const labelTicketReason = (r: TicketReason): string =>
  TICKET_REASON_LABEL[r] ?? r.replace(/_/g, ' ')

export const labelAction = (action: string): string =>
  ACTION_LABEL[action] ?? action.replace(/_/g, ' ')

export const labelRootCause = (rc: RootCause | null): string =>
  rc ? ROOT_CAUSE_LABEL[rc] ?? rc : 'Not yet diagnosed'

export const labelIntervention = (i: string): string =>
  INTERVENTION_LABEL[i] ?? i.replace(/_/g, ' ')

export const EVENT_TYPE_LABEL: Record<string, string> = {
  failed_payment: 'Failed payment',
  overdue_invoice: 'Overdue invoice',
  abandoned_checkout: 'Abandoned checkout',
  expired_mandate: 'Expired mandate',
}

export const labelEventType = (t: string): string =>
  EVENT_TYPE_LABEL[t] ?? t.replace(/_/g, ' ')
