import React, { useEffect, useRef, useState } from 'react'
import { dataSource } from '../api/dataSource'
import { formatINR } from '../lib/format'
import { getAuditCategory, labelRootCause } from '../api/actionLabels'
import { useLiquidGlass } from '../lib/liquidGlass'
import { AuditTimeline, type UnifiedAuditNode } from './AuditTimeline'
import type {
  AgentName,
  AuditRead,
  PlaygroundChannel,
  PlaygroundEscalation,
  PlaygroundMode,
  PlaygroundOutcome,
  PlaygroundPersona,
  PlaygroundSimState,
  PlaygroundTurn,
} from '../api/types'

interface Props {
  eventId: string
  isOpen: boolean
  onClose: () => void
}

type Phase = 'setup' | 'connecting' | 'live' | 'ended'

const OUTCOME_LABEL: Record<PlaygroundOutcome, string> = {
  ongoing: 'In progress',
  ptp_promised: 'Promise to Pay Recorded · Awaiting Payment Settlement',
  resolved: 'Verified Resolved · Payment Captured (Revenue Recovered)',
  escalated: 'Escalated to Human Review (/attention)',
  halted: 'Halted · Security / Risk Check',
}

const cleanTurnText = (raw: string | undefined | null): string => {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed.reply === 'string') return parsed.reply
      if (parsed && typeof parsed.text === 'string') return parsed.text
      if (parsed && typeof parsed.message === 'string') return parsed.message
    } catch {
      // ignore
    }
  }
  return raw
}

const renderRootCauseBadge = (persona: PlaygroundPersona | null) => {
  if (!persona) return null
  const rc = persona.root_cause || ''
  let label = labelRootCause(persona.root_cause)
  let icon = '🏷️'
  if (rc === 'invoice_forgotten' || persona.is_business) {
    label = 'Forgotten Invoice (B2B)'
    icon = '📄'
  } else if (rc === 'insufficient_funds') {
    label = 'Insufficient Funds'
    icon = '⏳'
  } else if (rc === 'bank_downtime') {
    label = 'Bank Downtime'
    icon = '🏦'
  } else if (rc === 'expired_instrument') {
    label = 'Expired Instrument'
    icon = '💳'
  } else if (rc === 'auth_failure') {
    label = 'Auth / OTP Failed'
    icon = '🔐'
  } else if (rc === 'card_declined') {
    label = 'Card Declined'
    icon = '🚫'
  } else if (rc === 'checkout_abandoned') {
    label = 'Abandoned Checkout'
    icon = '🛒'
  } else if (rc === 'suspected_fraud') {
    label = 'Suspected Fraud'
    icon = '🛡️'
  }

  return (
    <span className="px-3 py-1 rounded-full text-xs font-semibold bg-violet-500/20 text-violet-200 border border-violet-500/40 shadow-sm flex items-center gap-1.5">
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  )
}

const renderOutcomeBadge = (outcome: PlaygroundOutcome) => {
  switch (outcome) {
    case 'resolved':
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          Recovered
        </span>
      )
    case 'ptp_promised':
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm flex items-center gap-1.5 animate-pulse">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          Promise to Pay (PTP)
        </span>
      )
    case 'escalated':
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-rose-400" />
          Escalated to Human
        </span>
      )
    case 'halted':
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-purple-400" />
          Halted (Risk Check)
        </span>
      )
    case 'ongoing':
    default:
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
          Active Recovery Outreach
        </span>
      )
  }
}

const renderRemindersMetric = (outcome: PlaygroundOutcome, simState: PlaygroundSimState | null) => {
  const remindersScheduled = outcome === 'ptp_promised' ? 1 : simState?.sim_day && simState.sim_day > 1 ? Math.min(3, simState.sim_day) : 1
  const maxReminders = 3
  const remaining = Math.max(0, maxReminders - remindersScheduled)

  return (
    <span
      className="px-3 py-1 rounded-full font-mono text-xs font-medium bg-blue-500/15 text-blue-200 border border-blue-500/35 shadow-sm flex items-center gap-1.5"
      title="Outbound automated reminder nudges cap: Max 3 messages with 24h cooldown. Interactive conversation replies to customer incoming messages are unmetered."
    >
      <span>📬</span>
      <span>
        Reminders Cap: <strong className="text-white font-bold">{remindersScheduled}/{maxReminders}</strong> ({remaining} left)
      </span>
      <span className="text-[10px] text-blue-300/80 hidden sm:inline">(Replies unmetered)</span>
    </span>
  )
}

const ESCALATION_REASON_LABEL: Record<string, string> = {
  customer_requested_human: 'Customer explicitly asked for a human',
  out_of_scope: 'Request is outside the agent’s bounded authority',
  max_attempts_exceeded: 'Stopping rule reached — max attempts/escalation stage',
}

type TurnWithAudio = PlaygroundTurn & { audio_base64?: string }

interface SpeechRecognitionResultItem {
  transcript: string
}

interface SpeechRecognitionResult {
  [index: number]: SpeechRecognitionResultItem
  length: number
}

interface SpeechRecognitionResults {
  [index: number]: SpeechRecognitionResult
  length: number
}

interface SpeechRecognitionEvent {
  resultIndex: number
  results: SpeechRecognitionResults
}

interface SpeechRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: () => void
  onresult: (event: SpeechRecognitionEvent) => void
  onerror: (event: { error: string }) => void
  onend: () => void
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

export const SimulateSession: React.FC<Props> = ({ eventId, isOpen, onClose }) => {
  const [phase, setPhase] = useState<Phase>('connecting')
  const [mode, setMode] = useState<PlaygroundMode>('ai')
  const [channel, setChannel] = useState<PlaygroundChannel>('call')
  const [ticketRef, setTicketRef] = useState('')
  const [persona, setPersona] = useState<PlaygroundPersona | null>(null)
  const [history, setHistory] = useState<PlaygroundTurn[]>([])
  const [outcome, setOutcome] = useState<PlaygroundOutcome>('ongoing')
  const [reasoning, setReasoning] = useState('')
  const [simState, setSimState] = useState<PlaygroundSimState | null>(null)
  const [escalation, setEscalation] = useState<PlaygroundEscalation | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null)
  const [callDuration, setCallDuration] = useState(0)
  const [isListening, setIsListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [baseTrail, setBaseTrail] = useState<AuditRead[]>([])
  const [simulatedEvents, setSimulatedEvents] = useState<UnifiedAuditNode[]>([])

  const drawerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const cancelSpeechRef = useRef<(() => void) | null>(null)
  const autoPlayAbortRef = useRef(false)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const actionSeqRef = useRef(0)
  const finalSilenceLoggedRef = useRef(false)

  // Fetch the case's historical decision audit trail on modal open
  useEffect(() => {
    if (!isOpen || !eventId) {
      setBaseTrail([])
      setSimulatedEvents([])
      return
    }
    dataSource
      .getEventAudit(eventId)
      .then((res) => {
        setBaseTrail(res.trail || [])
      })
      .catch(() => {
        setBaseTrail([])
      })
  }, [isOpen, eventId])

  const turnTimestampsRef = useRef<Map<number, string>>(new Map())

  const recordTurnTimestamp = (index: number, day: number, hour: number, minuteOffset = 0) => {
    if (!turnTimestampsRef.current.has(index)) {
      const min = ((minuteOffset) % 60).toString().padStart(2, '0')
      const hr = (hour % 24).toString().padStart(2, '0')
      const ts = `Day ${day} · ${hr}:${min}`
      turnTimestampsRef.current.set(index, ts)
      return ts
    }
    return turnTimestampsRef.current.get(index)!
  }

  // Immutable per-turn timestamp — once assigned, never shifts when sim_day advances
  const turnTimestamp = (index: number) => {
    if (turnTimestampsRef.current.has(index)) {
      return turnTimestampsRef.current.get(index)!
    }
    const day = simState ? simState.sim_day : 1
    const hour = simState ? simState.sim_hour : 9
    return recordTurnTimestamp(index, day, hour, (index * 7) % 60)
  }

  const logAction = (_label: string) => {
    // Keep function signature for any remaining legacy callers
  }

  const logSimulatedEvent = (
    agent: AgentName | 'customer' | 'simulation',
    action: string,
    reasoning: string,
    extra?: UnifiedAuditNode['extra'],
    payload?: Record<string, unknown>
  ) => {
    const seq = actionSeqRef.current++
    const day = simState ? simState.sim_day : 1
    const hour = simState ? simState.sim_hour : 9
    const minute = ((seq * 7) % 60).toString().padStart(2, '0')
    const hr = ((hour + Math.floor((seq * 7) / 60)) % 24).toString().padStart(2, '0')
    const ts = `Day ${day} · ${hr}:${minute}`

    // Base sortKey guarantees simulation events come after historical store events
    const baseMaxSortKey =
      baseTrail.length > 0
        ? Math.max(...baseTrail.map((t) => new Date(t.timestamp).getTime() || 0))
        : 1700000000000
    const sortKey =
      baseMaxSortKey + day * 86400000 + hour * 3600000 + seq * 60000

    const node: UnifiedAuditNode = {
      id: `sim-${Date.now()}-${seq}`,
      timestamp: ts,
      sortKey,
      agent,
      action,
      reasoning,
      category: getAuditCategory(action, agent),
      payload,
      extra,
      isSimulated: true,
    }

    setSimulatedEvents((prev) => [...prev, node])
  }

  useLiquidGlass(drawerRef, { scale: -112, chroma: 6, border: 0.05, blur: 4 }, isOpen)

  useEffect(() => {
    setSpeechSupported(!!getSpeechRecognition())
  }, [])

  // Call timer
  useEffect(() => {
    if (phase !== 'live' || channel !== 'call') {
      setCallDuration(0)
      return
    }
    const timer = setInterval(() => setCallDuration((d) => d + 1), 1000)
    return () => clearInterval(timer)
  }, [phase, channel])

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  // Instant Barge-in: Cut off agent voice instantly when human speaks, types, or interrupts
  const interruptSpeech = () => {
    autoPlayAbortRef.current = true
    if (cancelSpeechRef.current) {
      cancelSpeechRef.current()
    } else {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel()
      }
      setSpeakingIndex(null)
    }
  }

  const startListening = () => {
    interruptSpeech()

    const SpeechRec = getSpeechRecognition()
    if (!SpeechRec) {
      setError('Speech recognition is not available in this browser. Please type your reply.')
      return
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch {
          // ignore
        }
      }

      const rec = new SpeechRec()
      rec.continuous = false
      rec.interimResults = true
      rec.lang = 'hi-IN'

      rec.onstart = () => {
        setIsListening(true)
        setError(null)
      }

      rec.onresult = (e: SpeechRecognitionEvent) => {
        let transcript = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const item = e.results[i]?.[0]
          if (item?.transcript) {
            transcript += item.transcript
          }
        }
        if (transcript) {
          setInput(transcript)
        }
      }

      rec.onerror = (e: { error: string }) => {
        setIsListening(false)
        if (e.error === 'not-allowed') {
          setError('Microphone access was denied. Please allow microphone permissions or type your message.')
        } else if (e.error !== 'no-speech') {
          console.warn('Speech recognition warning:', e.error)
        }
      }

      rec.onend = () => {
        setIsListening(false)
      }

      recognitionRef.current = rec
      rec.start()
    } catch (err) {
      console.warn('Speech recognition start failed:', err)
      setIsListening(false)
    }
  }

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore
      }
    }
    setIsListening(false)
  }

  const reset = () => {
    setPhase('connecting')
    setMode('ai')
    setPersona(null)
    setHistory([])
    setOutcome('ongoing')
    setReasoning('')
    setSimState(null)
    setEscalation(null)
    setInput('')
    setError(null)
    setCallDuration(0)
    setIsListening(false)
    setSimulatedEvents([])
    actionSeqRef.current = 0
    finalSilenceLoggedRef.current = false
    autoPlayAbortRef.current = true
    turnTimestampsRef.current.clear()
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {
        // ignore
      }
      recognitionRef.current = null
    }
    if (cancelSpeechRef.current) {
      cancelSpeechRef.current()
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
  }

  useEffect(() => {
    if (isOpen && eventId) {
      reset()
      begin()
    } else {
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, eventId])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const playTurnVoice = (turn: TurnWithAudio, index: number, onEnd?: () => void) => {
    // Voice audio is strictly for phone calls — WhatsApp messages are text-only with zero voice
    if (channel !== 'call') {
      setSpeakingIndex(null)
      onEnd?.()
      return
    }

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      cancelSpeechRef.current = null
      setSpeakingIndex(null)
      onEnd?.()
    }

    cancelSpeechRef.current = () => {
      if (finished) return
      finished = true
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel()
      }
      setSpeakingIndex(null)
      onEnd?.()
    }

    if (turn.audio_base64) {
      if (audioRef.current) {
        audioRef.current.pause()
      }
      const el = new Audio(`data:audio/wav;base64,${turn.audio_base64}`)
      audioRef.current = el
      setSpeakingIndex(index)
      el.onended = finish
      el.onerror = finish
      el.play().catch(finish)
      return
    }

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(turn.text)
      utterance.rate = 1.0
      utterance.pitch = turn.speaker === 'agent' ? 1.05 : 0.85
      setSpeakingIndex(index)
      utterance.onend = finish
      utterance.onerror = finish
      window.speechSynthesis.speak(utterance)
      return
    }

    finish()
  }

  const playTurnVoiceAsync = (turn: TurnWithAudio, index: number): Promise<void> => {
    if (channel !== 'call') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      playTurnVoice(turn, index, resolve)
    })
  }

  const begin = async () => {
    setPhase('connecting')
    setError(null)
    finalSilenceLoggedRef.current = false
    turnTimestampsRef.current.clear()
    try {
      const res = await dataSource.startPlayground(eventId, mode)
      setChannel(res.channel)
      setTicketRef(res.ticket_ref)
      setPersona(res.persona)
      const day = res.sim_state?.sim_day ?? 1
      const hour = res.sim_state?.sim_hour ?? 9
      recordTurnTimestamp(0, day, hour, 0)
      setHistory(res.history)
      setOutcome(res.outcome)
      setSimState(res.sim_state ?? null)
      setPhase('live')
      logAction(
        `${res.channel === 'call' ? 'Call connected' : 'WhatsApp chat opened'} with ${res.persona.name}`,
      )
      logSimulatedEvent(
        'simulation',
        'simulation_started',
        `Initialized sandbox recovery simulation on ${res.channel === 'call' ? 'voice call' : 'WhatsApp message'} rail with ${res.persona.name}`,
        { rail: res.channel, status: mode },
      )
      playTurnVoice(res.opening_turn as TurnWithAudio, 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the simulation')
      setPhase('setup')
    }
  }

  const applyOutcome = (
    next: PlaygroundOutcome,
    why: string,
    nextSimState?: PlaygroundSimState,
    nextEscalation?: PlaygroundEscalation,
  ) => {
    if (next !== outcome) {
      if (next === 'ptp_promised') {
        logAction('Promise to Pay recorded — payment link generated & sent')
        logSimulatedEvent(
          'customer',
          'customer_promised_to_pay',
          'Customer committed to settlement date; payment link generated & sent',
          { promisedDate: simState ? `Day ${simState.sim_day + 2}` : 'Upcoming cycle' },
        )
      } else if (next === 'escalated') {
        logAction('Escalated to human review (/attention)')
        logSimulatedEvent(
          'triage',
          'escalation_triggered',
          `Escalated to human review queue: ${nextEscalation?.reason ? nextEscalation.reason.replace(/_/g, ' ') : why}`,
          undefined,
          nextEscalation ? { reason: nextEscalation.reason, summary: nextEscalation.conversation_summary } : undefined,
        )
      } else if (next === 'halted') {
        logAction('Halted — security / risk check triggered')
        logSimulatedEvent(
          'recovery',
          'halted_stopping_rule',
          `Safety rule triggered: ${why}`,
        )
      } else if (next === 'resolved') {
        logAction('Payment verified — case marked resolved')
      }
    }
    setOutcome(next)
    setReasoning(why)
    if (nextSimState) setSimState(nextSimState)
    setEscalation(nextEscalation ?? null)
    if (next !== 'ongoing' && next !== 'ptp_promised') {
      setPhase('ended')
    }
  }

  const toggleTakeover = (role: 'agent' | 'customer') => {
    const current = simState?.controlled_by[role]
    if (current) {
      const goingHuman = current !== 'human'
      logAction(`${goingHuman ? 'Human took over as' : 'AI resumed control as'} ${role}`)
      logSimulatedEvent(
        'simulation',
        'channel_switched',
        `${goingHuman ? 'Human reviewer' : 'AI model'} assumed direct control of ${role}`,
      )
    }
    setSimState((st) => {
      if (!st) return st
      const cur = st.controlled_by[role]
      return {
        ...st,
        controlled_by: { ...st.controlled_by, [role]: cur === 'human' ? 'ai' : 'human' },
      }
    })
    interruptSpeech()
  }

  const isHumanCustomer = simState?.controlled_by.customer === 'human'

  const handleCompletePayment = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const currentDay = simState?.sim_day ?? 1
    const currentHour = simState?.sim_hour ?? 9
    const prevLen = history.length

    // Log customer action: clicked payment link & submitted OTP
    logSimulatedEvent(
      'customer',
      'payment_link_clicked',
      `Customer clicked payment link for ${formatINR(persona?.amount ?? 0)}`,
      { linkId: `sim_${eventId}`, amount: persona?.amount },
    )
    logSimulatedEvent(
      'customer',
      'customer_otp_submitted',
      'Customer entered OTP verification code on checkout page',
    )

    try {
      const res = await dataSource.simulatePlaygroundPayment(
        eventId,
        history,
        channel,
        simState ?? undefined,
      )
      recordTurnTimestamp(prevLen, currentDay, currentHour, 8)
      setHistory(res.history)
      playTurnVoice(res.turn as TurnWithAudio, res.history.length - 1)
      logAction(
        res.captured
          ? `Payment link clicked → captured ✓ (${res.payment_id ?? 'txn'})`
          : `Payment attempt failed: ${res.reason ?? 'unknown reason'}`,
      )
      if (res.captured) {
        logSimulatedEvent(
          'recovery',
          'payment_captured',
          `Payment of ${formatINR(persona?.amount ?? 0)} captured & verified via fake gateway. Revenue recovered.`,
          { amount: persona?.amount, source: 'fake_gateway', status: 'captured' },
        )
      } else {
        logSimulatedEvent(
          'recovery',
          'payment_capture_failed',
          `Payment capture attempt failed: ${res.reason ?? 'declined by issuing bank'}.`,
          { status: 'failed' },
        )
      }
      setOutcome('resolved')
      setReasoning(res.reasoning)
      if (res.sim_state) setSimState(res.sim_state)
      setPhase('ended')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete simulated payment')
    } finally {
      setBusy(false)
    }
  }

  const send = async (overrideMessage?: string) => {
    const message = (overrideMessage ?? input).trim()
    if (!message || busy) return
    finalSilenceLoggedRef.current = false
    interruptSpeech()
    if (isListening) stopListening()
    setBusy(true)
    setError(null)
    const currentDay = simState?.sim_day ?? 1
    const currentHour = simState?.sim_hour ?? 9
    const prevLen = history.length
    try {
      recordTurnTimestamp(prevLen, currentDay, currentHour, 1)
      logSimulatedEvent(
        'customer',
        'customer_responded',
        `Customer message: "${message}"`,
        { customerText: message },
      )
      const res = await dataSource.sendPlaygroundMessage(eventId, history, message, channel, {
        speaker: 'customer',
        sim_state: simState ?? undefined,
      })
      recordTurnTimestamp(prevLen + 1, currentDay, currentHour, 4)
      setHistory(res.history)
      setInput('')
      playTurnVoice(res.turn as TurnWithAudio, res.history.length - 1)
      const agentText = cleanTurnText(res.turn?.text)
      if (agentText) {
        logSimulatedEvent(
          'recovery',
          'sent_nudge',
          `Recovery agent replied: "${agentText}"`,
        )
      }
      applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent could not reply')
    } finally {
      setBusy(false)
    }
  }

  const advance = async () => {
    if (busy) return
    autoPlayAbortRef.current = false
    setBusy(true)
    setError(null)
    const currentDay = simState?.sim_day ?? 1
    const currentHour = simState?.sim_hour ?? 9
    const prevLen = history.length
    try {
      const res = await dataSource.advancePlayground(eventId, history, channel, simState ?? undefined)
      
      if (res.no_response) {
        recordTurnTimestamp(prevLen, currentDay, currentHour, 7)
        setHistory(res.history)
        if (res.sim_state) setSimState(res.sim_state)
        logAction('Customer did not respond this turn (simulated silence)')

        const nextDay = res.sim_state?.sim_day ?? (currentDay + 1)
        const attemptsSoFar = res.sim_state?.attempts_so_far ?? 0
        const isRemindersFinished = nextDay >= 3 || attemptsSoFar >= 3 || res.outcome === 'escalated'

        if (isRemindersFinished && !finalSilenceLoggedRef.current) {
          finalSilenceLoggedRef.current = true
          logSimulatedEvent(
            'customer',
            'customer_silence',
            'Customer did not respond after all automated reminders (Day 1–3) · Reminders exhausted; routed to human review',
          )
        }
        applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)
        setBusy(false)
        return
      }

      recordTurnTimestamp(prevLen, currentDay, currentHour, 2)
      recordTurnTimestamp(prevLen + 1, currentDay, currentHour, 5)

      setHistory(res.history)
      if (res.sim_state) setSimState(res.sim_state)

      const customerIdx = res.history.length - 2
      const agentIdx = res.history.length - 1

      const customerText = cleanTurnText(res.customer_turn?.text)
      if (customerText) {
        logSimulatedEvent(
          'customer',
          channel === 'call' ? 'customer_voice_turn' : 'customer_responded',
          `Customer ${channel === 'call' ? 'spoke on call' : 'replied'}: "${customerText}"`,
          { customerText },
        )
      }
      const agentText = cleanTurnText(res.agent_turn?.text)
      if (agentText) {
        logSimulatedEvent(
          'recovery',
          'sent_nudge',
          `Agent outreach turn: "${agentText}"`,
        )
      }

      playTurnVoice(res.customer_turn as TurnWithAudio, customerIdx, () => {
        if (autoPlayAbortRef.current) return
        setTimeout(() => {
          if (autoPlayAbortRef.current) return
          playTurnVoice(res.agent_turn as TurnWithAudio, agentIdx, () => {
            if (autoPlayAbortRef.current) return
            applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)
          })
        }, 400)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The conversation could not advance')
    } finally {
      setBusy(false)
    }
  }

  const playToResolution = async () => {
    let current = history
    let st = simState ?? undefined
    autoPlayAbortRef.current = false
    setBusy(true)
    setError(null)
    try {
      for (let i = 0; i < 6; i++) {
        if (autoPlayAbortRef.current) break
        const currentDay = st?.sim_day ?? 1
        const currentHour = st?.sim_hour ?? 9
        const prevLen = current.length
        const res = await dataSource.advancePlayground(eventId, current, channel, st)
        if (autoPlayAbortRef.current) break

        if (res.no_response) {
          recordTurnTimestamp(prevLen, currentDay, currentHour, 7)
          current = res.history
          st = res.sim_state ?? st
          setHistory(res.history)
          if (res.sim_state) setSimState(res.sim_state)
          logAction('Customer did not respond this turn (simulated silence)')

          const nextDay = st?.sim_day ?? (currentDay + 1)
          const attemptsSoFar = st?.attempts_so_far ?? 0
          const isRemindersFinished = nextDay >= 3 || attemptsSoFar >= 3 || res.outcome === 'escalated'

          if (isRemindersFinished && !finalSilenceLoggedRef.current) {
            finalSilenceLoggedRef.current = true
            logSimulatedEvent(
              'customer',
              'customer_silence',
              'Customer did not respond after all automated reminders (Day 1–3) · Reminders exhausted; routed to human review',
            )
            applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)
            break
          }
          applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)
          continue
        }

        recordTurnTimestamp(prevLen, currentDay, currentHour, 2)
        recordTurnTimestamp(prevLen + 1, currentDay, currentHour, 5)

        current = res.history
        st = res.sim_state ?? st
        setHistory(res.history)
        if (res.sim_state) setSimState(res.sim_state)

        const customerIdx = res.history.length - 2
        const agentIdx = res.history.length - 1

        const customerText = cleanTurnText(res.customer_turn?.text)
        if (customerText) {
          logSimulatedEvent(
            'customer',
            channel === 'call' ? 'customer_voice_turn' : 'customer_responded',
            `Customer ${channel === 'call' ? 'spoke on call' : 'replied'}: "${customerText}"`,
            { customerText },
          )
        }
        const agentText = cleanTurnText(res.agent_turn?.text)
        if (agentText) {
          logSimulatedEvent(
            'recovery',
            'sent_nudge',
            `Agent outreach turn: "${agentText}"`,
          )
        }

        await playTurnVoiceAsync(res.customer_turn as TurnWithAudio, customerIdx)
        if (autoPlayAbortRef.current) break
        await new Promise((r) => setTimeout(r, 400))
        if (autoPlayAbortRef.current) break

        await playTurnVoiceAsync(res.agent_turn as TurnWithAudio, agentIdx)
        if (autoPlayAbortRef.current) break
        applyOutcome(res.outcome, res.reasoning, res.sim_state, res.escalation)

        if (res.outcome !== 'ongoing') break
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The conversation could not advance')
    } finally {
      setBusy(false)
    }
  }

  if (!isOpen) return null

  const isCall = channel === 'call'
  const isAiMode = mode === 'ai' || mode === 'auto'

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 backdrop-blur-md animate-fade-in p-0 md:p-2 lg:p-3">
      <div
        ref={drawerRef}
        className="w-full h-full max-w-none liquid-glass-drawer flex flex-col shadow-2xl overflow-hidden text-slate-100 rounded-none md:rounded-2xl border border-white/15 bg-slate-950/95"
      >
        {/* Header */}
        <div className="px-6 py-3.5 border-b border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="px-2.5 py-1.5 rounded-xl liquid-glass-pill text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              {isCall ? 'Call' : 'Chat'}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-white">
                  Recovery Agent Simulation
                </h2>
                <span className="text-xs font-mono font-medium px-2.5 py-0.5 rounded-full liquid-glass-pill text-slate-300">
                  SANDBOX
                </span>
                {simState && (
                  <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 shadow-sm">
                    Day {simState.sim_day} · {simState.sim_hour.toString().padStart(2, '0')}:00
                  </span>
                )}
                {renderRootCauseBadge(persona)}
                {renderOutcomeBadge(outcome)}
                {renderRemindersMetric(outcome, simState)}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {ticketRef ? `${ticketRef} · ` : ''}Case {eventId}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>

        {/* Rehearsal Sandbox Notice */}
        <div className="px-6 py-2.5 border-b border-white/[0.06] flex items-center justify-between flex-wrap gap-2 text-xs text-slate-300">
          <div className="flex items-center gap-2 flex-wrap">
            <span>
              <strong className="text-white font-semibold">Rehearsal Sandbox:</strong> AI vs AI simulation with interactive human controls and custom input enabled.
            </span>
            <span className="text-slate-400">
              • Policy: <span className="text-slate-200 font-medium">Max 3 automated reminders (24h cooldown)</span> · Customer chat replies are unmetered.
            </span>
          </div>
          {phase === 'live' && isCall && (
            <span className="font-mono text-sm text-emerald-400 font-bold flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              {formatTimer(callDuration)}
            </span>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-3 px-3.5 py-2 rounded-xl liquid-glass-card border-red-500/30 text-xs text-red-300 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 hover:bg-white/10 rounded p-1">
              Dismiss
            </button>
          </div>
        )}

        {/* Phase 1: Connecting Spinner */}
        {phase === 'connecting' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16">
            <div className="w-16 h-16 rounded-full border-4 border-white/10 border-t-indigo-400 animate-spin" />
            <div className="text-center">
              <p className="text-sm font-medium text-white">
                Connecting recovery simulation...
              </p>
              <p className="text-xs text-slate-400 mt-1">Generating customer persona & initializing dialogue</p>
            </div>
          </div>
        )}

        {/* Phase 3 & 4: Active Session (Live or Ended) */}
        {(phase === 'live' || phase === 'ended') && persona && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Persona Summary Mini-Card */}
            <div className="px-6 py-2.5 border-b border-white/[0.06] flex items-center justify-between text-[11px] text-slate-400">
              <div className="flex items-center gap-3">
                <span className="text-slate-200 font-medium">{persona.name}</span>
                <span>&middot;</span>
                <span>{persona.phone_masked || persona.upi_vpa}</span>
                <span>&middot;</span>
                <span className="text-amber-300 font-medium">{formatINR(persona.amount)}</span>
              </div>
              <span className="text-slate-400">{labelRootCause(persona.root_cause)}</span>
            </div>

            {/* Outstanding asks strip */}
            {simState && simState.outstanding_asks.length > 0 && (
              <div className="px-6 py-2 border-b border-white/[0.06] flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-slate-500">Still waiting on:</span>
                {simState.outstanding_asks.map((ask) => (
                  <span key={ask} className="px-2 py-0.5 rounded-full liquid-glass-pill text-slate-300">
                    {ask}
                  </span>
                ))}
              </div>
            )}

            {/* MAIN CONTENT AREA — 4-COLUMN REVAMPED LAYOUT:
                Col 1 (Extreme Left): Transcripts
                Col 2 (Left-Center): Agent Event Logs & Decision Trail
                Col 3 (Center): Smartphone Screen (WhatsApp / Phone Call Frame)
                Col 4 (Absolute Right): Simulation Controls & Customer Actions */}
            <div className="flex-1 overflow-y-auto p-4 lg:p-6 flex flex-col xl:flex-row gap-5 items-stretch justify-between">

              {/* ========================================================= */}
              {/* COLUMN 1: TRANSCRIPTS (EXTREME LEFT-HAND SIDE)            */}
              {/* ========================================================= */}
              <div className="w-full xl:w-[25%] 2xl:w-[24%] shrink-0 flex flex-col gap-3 rounded-2xl">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white uppercase tracking-wider">💬 Transcripts</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full liquid-glass-pill text-emerald-300 font-mono">
                      TIMESTAMPS
                    </span>
                  </div>
                </div>

                {/* MESSAGING TRANSCRIPT */}
                <div className="liquid-glass-card p-3.5 flex flex-col gap-2 rounded-2xl flex-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-300 flex items-center justify-between pb-1 border-b border-white/[0.06]">
                    <span>Messaging Transcript</span>
                    <span className="text-[10px] font-mono text-slate-400">WhatsApp Rail</span>
                  </div>
                  {channel === 'message' && history.length > 0 ? (
                    <div className="flex flex-col gap-2.5 max-h-[340px] xl:max-h-[360px] overflow-y-auto pr-1">
                      {history.map((turn, i) => {
                        if ((turn.speaker as string) === 'system') {
                          return (
                            <div key={i} className="text-xs text-slate-400 italic bg-white/[0.02] p-1.5 rounded-lg border border-dashed border-slate-700">
                              <span className="font-mono font-bold text-slate-300 mr-2">{turnTimestamp(i)}</span> — {cleanTurnText(turn.text)}
                            </div>
                          )
                        }
                        const isAgent = turn.speaker === 'agent'
                        return (
                          <div key={i} className="text-xs leading-relaxed p-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className={isAgent ? 'text-indigo-300 font-semibold' : 'text-amber-300 font-semibold'}>
                                {isAgent ? 'Razorpay Support' : persona.name}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400">{turnTimestamp(i)}</span>
                            </div>
                            <span className="text-slate-200">{cleanTurnText(turn.text)}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 italic py-2">
                      {isCall ? 'Session active on voice call rail.' : 'No message turns yet.'}
                    </p>
                  )}
                </div>

                {/* CALL TRANSCRIPT */}
                <div className="liquid-glass-card p-3.5 flex flex-col gap-2 rounded-2xl flex-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-300 flex items-center justify-between pb-1 border-b border-white/[0.06]">
                    <span>Call Transcript</span>
                    <span className="text-[10px] font-mono text-slate-400">Voice Rail</span>
                  </div>
                  {channel === 'call' && history.length > 0 ? (
                    <div className="flex flex-col gap-2.5 max-h-[340px] xl:max-h-[360px] overflow-y-auto pr-1">
                      {history.map((turn, i) => {
                        if ((turn.speaker as string) === 'system') {
                          return (
                            <div key={i} className="text-xs text-slate-400 italic bg-white/[0.02] p-1.5 rounded-lg border border-dashed border-slate-700">
                              <span className="font-mono font-bold text-slate-300 mr-2">{turnTimestamp(i)}</span> — {cleanTurnText(turn.text)}
                            </div>
                          )
                        }
                        const isAgent = turn.speaker === 'agent'
                        const isSpeaking = speakingIndex === i
                        return (
                          <div key={i} className={`text-xs leading-relaxed p-1.5 rounded-lg bg-white/[0.02] border ${isSpeaking ? 'border-indigo-400/50 bg-indigo-950/20' : 'border-white/[0.04]'}`}>
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className={isAgent ? 'text-indigo-300 font-semibold' : 'text-amber-300 font-semibold'}>
                                {isAgent ? 'Resolver (Agent)' : persona.is_business ? 'Business Contact' : persona.name}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400">{turnTimestamp(i)}</span>
                            </div>
                            <span className="text-slate-200">{cleanTurnText(turn.text)}</span>
                            {isSpeaking && <span className="ml-1.5 text-emerald-400 text-xs font-semibold animate-pulse">🔊 Speaking</span>}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 italic py-2">
                      {!isCall ? 'Session active on WhatsApp message rail.' : 'No call turns yet.'}
                    </p>
                  )}
                </div>
              </div>

              {/* ========================================================= */}
              {/* COLUMN 2: EVENT LOGS OF THE AGENT & DECISION TRAIL         */}
              {/* ========================================================= */}
              <div className="w-full xl:w-[24%] shrink-0 flex flex-col gap-3">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white uppercase tracking-wider">⚡ Agent Event Logs</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full liquid-glass-pill text-indigo-300 font-mono">
                      DECISION TRAIL
                    </span>
                  </div>
                </div>

                {/* Unified Systemized Audit Log & Customer Action Trail */}
                <div className="liquid-glass-card p-3.5 flex flex-col gap-2 rounded-2xl flex-1 max-h-[440px] xl:max-h-[480px] overflow-y-auto">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-300 flex items-center justify-between pb-1 border-b border-white/[0.06]">
                    <div className="flex items-center gap-1.5">
                      <span>Unified Audit &amp; Event Trail</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                        CHRONOLOGICAL
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {baseTrail.length + simulatedEvents.length} events
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 -mt-1 leading-relaxed">
                    Strict chronological log of all historical agent decisions, payment links, and live customer interactions.
                  </p>
                  <div className="mt-1">
                    <AuditTimeline
                      trail={baseTrail}
                      simulatedEvents={simulatedEvents}
                      filterEnabled={true}
                    />
                  </div>
                </div>

                {/* Escalation Handoff Banner (if escalated) */}
                {escalation && (
                  <div className="p-3.5 rounded-2xl liquid-glass-card border-rose-500/30 text-xs">
                    <p className="font-bold text-xs text-rose-300 mb-1">
                      🚨 Escalated: {ESCALATION_REASON_LABEL[escalation.reason] ?? escalation.reason}
                    </p>
                    <p className="text-[11px] text-slate-300 leading-relaxed mb-2">{escalation.conversation_summary}</p>
                    <p className="text-[10px] text-slate-400">Stopping Rule: Routed to /attention urgent review</p>
                  </div>
                )}

                {/* Resolution Milestone Card (if resolved/PTP) */}
                {outcome !== 'ongoing' && (
                  <div className="p-3.5 rounded-2xl liquid-glass-card text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">{OUTCOME_LABEL[outcome]}</span>
                    </div>
                    {reasoning && <p className="text-[11px] opacity-90 leading-relaxed text-slate-300">{reasoning}</p>}
                  </div>
                )}
              </div>

              {/* ========================================================= */}
              {/* COLUMN 3: USER'S SCREEN WITH SMARTPHONE FRAME (WHATSAPP/CALL) */}
              {/* ========================================================= */}
              <div className="w-full xl:w-[28%] 2xl:w-[27%] shrink-0 flex flex-col items-center justify-start h-full">
                {/* Smartphone Device Mockup Chassis (Elongated) */}
                <div className="w-full max-w-[390px] rounded-[48px] border-[8px] border-slate-800 bg-[#0b141a] shadow-2xl overflow-hidden flex flex-col h-[calc(100vh-140px)] min-h-[760px] max-h-[920px] relative ring-1 ring-white/15">
                  
                  {/* Smartphone Top Bezel & Status Bar */}
                  <div className="pt-2 pb-1.5 px-5 bg-[#111b21] flex items-center justify-between text-[11px] font-semibold text-slate-300 shrink-0">
                    <span className="font-mono">
                      {simState ? `${simState.sim_hour.toString().padStart(2, '0')}:00` : '09:41'}
                    </span>
                    {/* Top Dynamic Island / Speaker Pill */}
                    <div className="w-20 h-4 bg-black rounded-full flex items-center justify-center gap-1.5 shadow-inner">
                      <span className="w-2 h-2 rounded-full bg-slate-900 border border-slate-700" />
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-800" />
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span>5G</span>
                      <span>📶</span>
                      <span>🔋</span>
                    </div>
                  </div>

                  {/* Channel: Voice Call Screen inside Smartphone */}
                  {isCall ? (
                    <div className="flex-1 flex flex-col justify-between p-4 bg-gradient-to-b from-[#111b21] to-[#0b141a] overflow-y-auto">
                      <div className="flex flex-col items-center text-center mt-4">
                        {(() => {
                          const activeSpeaker = speakingIndex !== null && history[speakingIndex] ? history[speakingIndex].speaker : null
                          return (
                            <>
                              <div className="w-20 h-20 rounded-full flex items-center justify-center text-base font-bold border transition-colors mb-3 shadow-lg ${
                                speakingIndex !== null
                                  ? activeSpeaker === 'customer'
                                    ? 'border-amber-400/60 bg-amber-500/10 text-amber-200 ring-4 ring-amber-500/20'
                                    : 'border-indigo-400/60 bg-indigo-500/10 text-indigo-200 ring-4 ring-indigo-500/20'
                                  : 'border-white/10 bg-white/5 text-slate-300'
                              }">
                                {activeSpeaker === 'customer' ? 'CUST' : 'RZ'}
                              </div>

                              <h3 className="text-base font-bold text-white">
                                {activeSpeaker === 'agent' ? 'Razorpay Recovery' : persona.name}
                              </h3>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {activeSpeaker === 'agent' ? 'AI Voice Assistant (Priya)' : `${persona.phone_masked || '+91 ••••••••••'}`}
                              </p>

                              <div className="mt-3">
                                <span className="px-3 py-1 rounded-full bg-white/10 text-xs font-mono font-medium text-slate-200 flex items-center gap-1.5">
                                  <span className={`w-2 h-2 rounded-full ${phase === 'ended' ? 'bg-slate-500' : 'bg-emerald-400 animate-pulse'}`} />
                                  {phase === 'ended' ? 'Call Ended' : formatTimer(callDuration)}
                                </span>
                              </div>
                            </>
                          )
                        })()}

                        {/* Live audio frequency wave */}
                        {phase === 'live' && (
                          <div className="flex items-center gap-1 h-6 mt-6">
                            {[12, 24, 16, 28, 20, 32, 18, 26, 14].map((h, i) => (
                              <span
                                key={i}
                                className={`w-1 rounded-full transition-all duration-200 ${
                                  speakingIndex !== null ? 'bg-indigo-400 animate-pulse' : 'bg-white/20'
                                }`}
                                style={{
                                  height: speakingIndex !== null ? `${h}px` : '6px',
                                  animationDelay: `${i * 80}ms`,
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Call dialogue preview */}
                      {history.length > 0 && (() => {
                        const currentTurn = speakingIndex !== null && history[speakingIndex] ? history[speakingIndex] : history[history.length - 1]
                        const isAgent = currentTurn.speaker === 'agent'
                        return (
                          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-700/60 text-slate-200 text-xs my-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 text-slate-400">
                              {isAgent ? 'Resolver Spoken:' : `${persona.name} Spoken:`}
                            </div>
                            <p className="leading-relaxed">{cleanTurnText(currentTurn.text)}</p>
                          </div>
                        )
                      })()}
                    </div>
                  ) : (
                    /* Channel: WhatsApp Screen inside Smartphone */
                    <div className="flex-1 flex flex-col bg-[#0b141a] overflow-hidden">
                      {/* WhatsApp App Header */}
                      <div className="px-3 py-2 bg-[#202c33] border-b border-[#2a3942] flex items-center justify-between shrink-0">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-[#00a884] flex items-center justify-center text-white font-bold text-xs shadow-sm">
                            RZ
                          </div>
                          <div>
                            <div className="flex items-center gap-1">
                              <span className="font-semibold text-white text-xs">Razorpay Recovery</span>
                              <span className="text-emerald-400 text-xs">&#10003;</span>
                            </div>
                            <p className="text-[9px] text-emerald-400">Official Business Account</p>
                          </div>
                        </div>
                        <span className="text-[9px] text-slate-400 bg-slate-800 px-2 py-0.5 rounded">WhatsApp</span>
                      </div>

                      {/* WhatsApp Messages Body */}
                      <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-2.5 min-h-0">
                        <div className="self-center px-2.5 py-1 rounded-md bg-[#182229] border border-[#222e35] text-[9px] text-[#ffd279] text-center max-w-[260px] shadow-sm">
                          Messages are end-to-end encrypted for payment security.
                        </div>

                        {history.map((turn, i) => {
                          if ((turn.speaker as string) === 'system') {
                            return (
                              <div key={i} className="self-center px-2.5 py-1 rounded-md border border-dashed border-slate-600 text-[10px] text-slate-400 italic">
                                <span className="font-mono font-bold text-slate-300 mr-1.5">{turnTimestamp(i)}</span> — {cleanTurnText(turn.text)}
                              </div>
                            )
                          }
                          const isAgent = turn.speaker === 'agent'
                          return (
                            <div
                              key={i}
                              className={`max-w-[85%] rounded-xl px-3 py-2 text-xs shadow-md leading-relaxed ${
                                isAgent
                                  ? 'self-start bg-[#202c33] text-[#e9edef] rounded-tl-none border border-[#2a3942]'
                                  : 'self-end bg-[#005c4b] text-[#e9edef] rounded-tr-none'
                              }`}
                            >
                              <div className="text-[10px] font-semibold text-emerald-400 mb-0.5">
                                {isAgent ? 'Razorpay Support' : persona.name}
                              </div>
                              <p className="text-xs leading-relaxed">{cleanTurnText(turn.text)}</p>
                              <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] font-mono font-medium text-slate-300">
                                <span>{turnTimestamp(i)}</span>
                                {!isAgent && <span className="text-sky-400 font-bold">&#10003;&#10003;</span>}
                              </div>
                            </div>
                          )
                        })}

                        {(outcome === 'ptp_promised' || outcome === 'resolved') && (
                          <div
                            className={`self-start max-w-[90%] rounded-xl p-3 border shadow-xl text-left mt-1 ${
                              outcome === 'resolved'
                                ? 'bg-gradient-to-br from-[#0c2a20] to-[#081b14] border-emerald-500/70'
                                : 'bg-gradient-to-br from-[#242114] to-[#16140b] border-amber-500/70'
                            }`}
                          >
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-700/50">
                              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                                <span className={`w-2 h-2 rounded-full ${outcome === 'resolved' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
                                Payment Request
                              </span>
                              <span
                                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                                  outcome === 'resolved' ? 'text-emerald-300 bg-emerald-950/60' : 'text-amber-300 bg-amber-950/60'
                                }`}
                              >
                                {outcome === 'resolved' ? 'PAID & CAPTURED' : 'PTP RECORDED'}
                              </span>
                            </div>
                            <div className="py-2">
                              <div className="text-[11px] text-slate-300">Amount:</div>
                              <div className="text-base font-bold text-white tracking-wide">{formatINR(persona.amount)}</div>
                            </div>
                            <div className="pt-1.5 border-t border-slate-700/40 flex items-center justify-between gap-1">
                              <span className="text-[10px] text-slate-400">
                                {outcome === 'resolved' ? 'Receipt Captured' : 'Awaiting Payment'}
                              </span>
                              {outcome === 'ptp_promised' ? (
                                <button
                                  onClick={handleCompletePayment}
                                  disabled={busy}
                                  className="text-[11px] bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold px-2.5 py-1 rounded shadow cursor-pointer transition-colors"
                                >
                                  Click Link &amp; Pay
                                </button>
                              ) : (
                                <span className="text-[11px] text-emerald-400 font-bold">
                                  ✓ Paid
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        <div ref={transcriptEndRef} />
                      </div>

                      {/* WhatsApp Chat Input Bar inside Phone Screen */}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          send()
                        }}
                        className="p-2.5 bg-[#202c33] border-t border-[#2a3942] flex items-center gap-2 shrink-0"
                      >
                        <input
                          type="text"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder="Type a message to agent..."
                          disabled={busy || outcome !== 'ongoing'}
                          className="flex-1 px-3.5 py-2 rounded-full bg-[#2a3942] text-white text-xs placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                        {speechSupported && (
                          <button
                            type="button"
                            onClick={isListening ? stopListening : startListening}
                            disabled={busy || outcome !== 'ongoing'}
                            className={`p-2 rounded-full text-xs font-bold transition-colors cursor-pointer shrink-0 ${
                              isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-[#2a3942] text-slate-300 hover:text-white'
                            }`}
                            title={isListening ? 'Stop recording' : 'Voice input'}
                          >
                            🎤
                          </button>
                        )}
                        <button
                          type="submit"
                          disabled={busy || !input.trim() || outcome !== 'ongoing'}
                          className="w-8 h-8 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white flex items-center justify-center disabled:opacity-40 cursor-pointer shrink-0 transition-all shadow"
                          title="Send message"
                        >
                          <svg className="w-4 h-4 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                          </svg>
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Bottom Mobile Home Indicator Bar */}
                  <div className="py-2 bg-[#111b21] flex justify-center items-center shrink-0 border-t border-[#1e2a30]">
                    <div className="w-28 h-1 bg-slate-600 rounded-full" />
                  </div>
                </div>
              </div>

              {/* ========================================================= */}
              {/* COLUMN 4: CONTROLS & ACTIONS (ABSOLUTE RIGHT-HAND SIDE)     */}
              {/* ========================================================= */}
              <div className="w-full xl:w-[26%] shrink-0 flex flex-col gap-3">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white uppercase tracking-wider">🎮 Controls &amp; Actions</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full liquid-glass-pill text-purple-300 font-mono">
                      INTERACTIVE
                    </span>
                  </div>
                </div>

                {/* Mode & Takeover header */}
                <div className="p-3 rounded-xl liquid-glass-card flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="font-semibold text-white">
                      {isAiMode && !isHumanCustomer ? '🤖 AI vs AI Simulation' : '👤 Human Tester Mode'}
                    </span>
                  </div>
                  {isAiMode && (
                    <button
                      type="button"
                      onClick={() => toggleTakeover('customer')}
                      className="px-2.5 py-1 rounded-lg liquid-glass-pill text-[10px] font-semibold text-amber-300 hover:text-white transition-colors cursor-pointer"
                    >
                      {isHumanCustomer ? 'Resume AI' : 'Take over as Customer'}
                    </button>
                  )}
                </div>

                {/* AI Simulation Controls (if AI vs AI mode) */}
                {isAiMode && !isHumanCustomer ? (
                  <div className="p-3.5 rounded-2xl liquid-glass-card flex flex-col gap-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-purple-300 flex items-center justify-between">
                      <span>AI Simulation Engine</span>
                      <span className="text-[10px] font-mono text-slate-400">Two AI Agents</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={advance}
                        disabled={busy || outcome !== 'ongoing'}
                        className="flex-1 py-2.5 px-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold text-xs transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <span>▶</span>
                        <span>{busy ? 'Simulating...' : 'Next Turn'}</span>
                      </button>
                      <button
                        onClick={playToResolution}
                        disabled={busy || outcome !== 'ongoing'}
                        className="py-2.5 px-3 rounded-xl bg-purple-900/60 hover:bg-purple-800/60 border border-purple-500/40 disabled:opacity-40 text-purple-200 font-semibold text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <span>⚡</span>
                        <span>Auto-Run</span>
                      </button>
                    </div>

                    <div className="flex flex-col gap-1.5 mt-0.5">
                      <button
                        type="button"
                        onClick={() => send('I want to talk to a human supervisor right now.')}
                        disabled={busy || outcome !== 'ongoing'}
                        className="py-2 px-3 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/40 text-rose-300 text-xs font-medium transition-colors text-left flex items-center justify-between cursor-pointer disabled:opacity-40"
                      >
                        <span>🚨 Force Human Escalation</span>
                        <span className="text-[10px] opacity-75">Test Handoff</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => send('Can you give me a 50% discount code?')}
                        disabled={busy || outcome !== 'ongoing'}
                        className="py-2 px-3 rounded-lg bg-amber-950/40 hover:bg-amber-900/50 border border-amber-500/40 text-amber-300 text-xs font-medium transition-colors text-left flex items-center justify-between cursor-pointer disabled:opacity-40"
                      >
                        <span>⚠️ Out-of-Scope Query</span>
                        <span className="text-[10px] opacity-75">Test Guardrail</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Interactive Customer Actions */}
                <div className="p-3.5 rounded-2xl liquid-glass-card flex flex-col gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                    Simulate Customer Actions
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={handleCompletePayment}
                      disabled={busy || outcome !== 'ongoing'}
                      className="p-2.5 rounded-xl bg-emerald-950/50 hover:bg-emerald-900/60 border border-emerald-500/50 text-left transition-all cursor-pointer disabled:opacity-50"
                    >
                      <div className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                        <span>💳</span>
                        <span>Click Link &amp; Pay (Webhook)</span>
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5">
                        Simulates payment capture &amp; verified resolution.
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        interruptSpeech()
                        logAction('Customer action: Promised to pay on salary credit date (10th)')
                        send('Haan main pakka 10th ko salary credit aane par pay kar dunga, please abhi remind mat karna.')
                      }}
                      disabled={busy || outcome !== 'ongoing'}
                      className="p-2.5 rounded-xl bg-amber-950/50 hover:bg-amber-900/60 border border-amber-500/50 text-left transition-all cursor-pointer disabled:opacity-50"
                    >
                      <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                        <span>🤝</span>
                        <span>Record Promise to Pay (PTP)</span>
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5">
                        Sets 24h cooldown &amp; 3 auto-reminders.
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        interruptSpeech()
                        logAction('Customer action: Requested alternate payment method')
                        send('Mere card se issue aa raha hai, kya aap mujhe fresh UPI payment link bhej sakte ho?')
                      }}
                      disabled={busy || outcome !== 'ongoing'}
                      className="p-2.5 rounded-xl bg-indigo-950/50 hover:bg-indigo-900/60 border border-indigo-500/50 text-left transition-all cursor-pointer disabled:opacity-50"
                    >
                      <div className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                        <span>🔄</span>
                        <span>Retry Alternate Method (UPI)</span>
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5">
                        Tests fallback rail generation.
                      </div>
                    </button>
                  </div>
                </div>

                {/* Customer Input & Quick Response (Always available for tester) */}
                <div className="p-3.5 rounded-2xl liquid-glass-card flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-purple-300 flex items-center gap-1.5">
                      <span>💬 Tester Input</span>
                      <span className="text-[10px] text-slate-400 font-normal">(Prompt Agent)</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Input whatever you want to test how the recovery agent handles questions or objections:
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[
                      'Kyu fail hua tha?',
                      'Haan payment link bhej do',
                      'Main baad mein pay karunga',
                      'Mujhe discount chahiye',
                      'Supervisor se baat karao',
                    ].map((chip) => (
                      <button
                        key={chip}
                        onClick={() => {
                          interruptSpeech()
                          send(chip)
                        }}
                        disabled={busy || outcome !== 'ongoing'}
                        className="px-2 py-1 rounded-lg liquid-glass-pill text-[11px] text-slate-200 hover:bg-white/10 cursor-pointer disabled:opacity-50"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      send()
                    }}
                    className="flex items-end gap-1.5 mt-1"
                  >
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      rows={2}
                      placeholder="Type whatever you want to input to the agent..."
                      disabled={busy || outcome !== 'ongoing'}
                      className="flex-1 px-2.5 py-1.5 rounded-xl liquid-glass-card text-white text-xs focus:outline-none resize-none placeholder-slate-400"
                    />
                    {speechSupported && (
                      <button
                        type="button"
                        onClick={isListening ? stopListening : startListening}
                        disabled={busy || outcome !== 'ongoing'}
                        className={`p-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shrink-0 ${
                          isListening ? 'bg-red-500/80 text-white animate-pulse' : 'bg-slate-850 text-slate-300 hover:bg-slate-700'
                        }`}
                        title={isListening ? 'Stop recording' : 'Speak customer reply'}
                      >
                        🎤
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={busy || !input.trim() || outcome !== 'ongoing'}
                      className="px-3 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      Send
                    </button>
                  </form>
                </div>

                {phase === 'ended' && (
                  <button
                    onClick={reset}
                    className="w-full py-2.5 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors cursor-pointer shadow-lg"
                  >
                    Simulate Another Scenario
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
