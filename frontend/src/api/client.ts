import type {
  EventAuditResponse,
  EventRead,
  EventSequencerResponse,
  EventSimilarResponse,
  EventsResponse,
  EventVoiceResponse,
  EventVoiceAudioResponse,
  MetricsBlock,
  PaymentAttemptExhaustedResponse,
  PaymentAttemptResponse,
  PaymentPageResponse,
  PipelineRunResponse,
  TicketDetailResponse,
  TicketMutationResponse,
  TicketsResponse,
  PlaygroundAdvanceResponse,
  PlaygroundChannel,
  PlaygroundMessageResponse,
  PlaygroundMode,
  PlaygroundPayResponse,
  PlaygroundSimState,
  PlaygroundSpeaker,
  PlaygroundStartResponse,
  PlaygroundTurn,
} from './types'

const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  listEvents: () => request<EventsResponse>('/api/events'),
  getAuditTrail: (id: string) =>
    request<EventAuditResponse>(`/api/events/${encodeURIComponent(id)}/audit`),
  getSimilar: (id: string) =>
    request<EventSimilarResponse>(`/api/events/${encodeURIComponent(id)}/similar`),
  getVoiceScript: (id: string) =>
    request<EventVoiceResponse>(`/api/events/${encodeURIComponent(id)}/voice`),
  getVoiceAudio: (id: string) =>
    request<EventVoiceAudioResponse>(`/api/events/${encodeURIComponent(id)}/voice/audio`),
  getSequencerSchedule: (id: string) =>
    request<EventSequencerResponse>(`/api/events/${encodeURIComponent(id)}/sequencer`),
  recordPTP: (id: string, promisedDate: string, notes?: string) =>
    request<{ status: string; event: EventRead }>(`/api/events/${encodeURIComponent(id)}/ptp`, {
      method: 'POST',
      body: JSON.stringify({ promised_date: promisedDate, notes }),
    }),
  // --- human review queue ---
  listTickets: (status?: string) =>
    request<TicketsResponse>(
      `/api/tickets${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  getTicket: (id: string) =>
    request<TicketDetailResponse>(`/api/tickets/${encodeURIComponent(id)}`),
  assignTicket: (id: string, employeeEmail: string) =>
    request<TicketMutationResponse>(
      `/api/tickets/${encodeURIComponent(id)}/assign`,
      { method: 'POST', body: JSON.stringify({ employee_email: employeeEmail }) },
    ),
  resolveTicket: (
    id: string,
    body: {
      employee_email: string
      outcome: 'resolved' | 'unresolved'
      note: string
      recovered_amount?: string | null
    },
  ) =>
    request<TicketMutationResponse>(
      `/api/tickets/${encodeURIComponent(id)}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  raiseQuestion: (
    eventId: string,
    body: { question: string; channel?: string; employee_email?: string | null },
  ) =>
    request<TicketMutationResponse>(
      `/api/events/${encodeURIComponent(eventId)}/raise-question`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // --- Simulate / Playground (sandboxed rehearsal) ---
  startPlayground: (eventId: string, mode: PlaygroundMode, channel?: PlaygroundChannel) =>
    request<PlaygroundStartResponse>(
      `/api/events/${encodeURIComponent(eventId)}/playground/start`,
      { method: 'POST', body: JSON.stringify({ mode, channel }) },
    ),
  sendPlaygroundMessage: (
    eventId: string,
    history: PlaygroundTurn[],
    message: string,
    channel: string,
    opts?: { speaker?: PlaygroundSpeaker; outcome?: string; sim_state?: PlaygroundSimState },
  ) =>
    request<PlaygroundMessageResponse>(
      `/api/events/${encodeURIComponent(eventId)}/playground/message`,
      {
        method: 'POST',
        body: JSON.stringify({
          history,
          message,
          channel,
          speaker: opts?.speaker,
          outcome: opts?.outcome,
          sim_state: opts?.sim_state,
        }),
      },
    ),
  advancePlayground: (
    eventId: string,
    history: PlaygroundTurn[],
    channel: string,
    simState?: PlaygroundSimState,
  ) =>
    request<PlaygroundAdvanceResponse>(
      `/api/events/${encodeURIComponent(eventId)}/playground/advance`,
      { method: 'POST', body: JSON.stringify({ history, channel, sim_state: simState }) },
    ),
  simulatePlaygroundPayment: (
    eventId: string,
    history: PlaygroundTurn[],
    channel: string,
    simState?: PlaygroundSimState,
  ) =>
    request<PlaygroundPayResponse>(
      `/api/events/${encodeURIComponent(eventId)}/playground/pay`,
      { method: 'POST', body: JSON.stringify({ history, channel, sim_state: simState }) },
    ),

  getMetrics: () => request<MetricsBlock>('/api/metrics'),
  runPipeline: () =>
    request<PipelineRunResponse>('/api/pipeline/run', { method: 'POST' }),

  // --- public payment-link checkout (/pay/:token, no dashboard chrome) ---
  getPaymentPage: (token: string) =>
    request<PaymentPageResponse>(`/api/pay/${encodeURIComponent(token)}`),
  attemptPayment: async (
    token: string,
  ): Promise<PaymentAttemptResponse | PaymentAttemptExhaustedResponse> => {
    const res = await fetch(`${BASE}/api/pay/${encodeURIComponent(token)}/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    // 409 = attempts exhausted; a real, documented terminal state, not an error.
    if (res.status === 409) {
      return (await res.json()) as PaymentAttemptExhaustedResponse
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${res.status} ${res.statusText}: ${body}`)
    }
    return (await res.json()) as PaymentAttemptResponse
  },
}
