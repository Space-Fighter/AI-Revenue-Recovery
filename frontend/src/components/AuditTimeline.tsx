import { useMemo, useState } from 'react'
import type { AuditRead, AgentName } from '../api/types'
import {
  AGENT_LABEL,
  CATEGORY_THEME,
  getAuditCategory,
  labelAction,
  type AuditCategory,
} from '../api/actionLabels'
import { formatDateTime, formatINR } from '../lib/format'
import { PayloadViewer } from './PayloadViewer'
import { EmptyState } from './Feedback'

export interface UnifiedAuditNode {
  id: string | number
  timestamp: string
  sortKey: number
  agent: AgentName | 'customer' | 'simulation'
  action: string
  reasoning: string
  payload?: Record<string, unknown> | null
  category: AuditCategory
  isSimulated?: boolean
  extra?: {
    linkUrl?: string
    linkId?: string
    amount?: number | string
    status?: string
    source?: string
    rail?: string
    promisedDate?: string
    customerText?: string
    reason?: string
  }
}

export interface AuditTimelineProps {
  trail?: AuditRead[]
  simulatedEvents?: UnifiedAuditNode[]
  filterEnabled?: boolean
  compact?: boolean
  emptyMessage?: string
}

function normalizeAuditRead(read: AuditRead): UnifiedAuditNode {
  const payload = (read.payload && typeof read.payload === 'object' ? read.payload : null) as Record<string, unknown> | null
  const dt = new Date(read.timestamp)
  const sortKey = isNaN(dt.getTime()) ? Number(read.id) || Date.now() : dt.getTime()
  const category = getAuditCategory(read.action, read.agent)

  return {
    id: read.id,
    timestamp: read.timestamp,
    sortKey,
    agent: read.agent,
    action: read.action,
    reasoning: read.reasoning,
    payload,
    category,
    isSimulated: false,
    extra: {
      linkUrl: typeof payload?.link_url === 'string' ? payload.link_url : undefined,
      linkId: typeof payload?.link_id === 'string' ? payload.link_id : undefined,
      amount: payload?.amount != null ? String(payload.amount) : payload?.recovered_amount != null ? String(payload.recovered_amount) : undefined,
      source: typeof payload?.source === 'string' ? payload.source : undefined,
      promisedDate: typeof payload?.promised_date === 'string' ? payload.promised_date : undefined,
    },
  }
}

function EventCard({ node }: { node: UnifiedAuditNode }) {
  const { action, payload, extra } = node

  // 1. Payment Link Card (sent or clicked)
  if (action === 'payment_link_sent' || action === 'payment_link_clicked') {
    const isClicked = action === 'payment_link_clicked'
    const linkUrl = extra?.linkUrl || (payload?.link_url as string) || (payload?.url as string)
    const linkId = extra?.linkId || (payload?.link_id as string) || (payload?.id as string)
    const amount = extra?.amount || (payload?.amount as string | number)

    return (
      <div className="mt-2 p-2.5 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-xs flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-cyan-300">
            <span>🔗</span>
            <span>{isClicked ? 'Payment Link Clicked by Customer' : 'Payment Link Dispatched'}</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
            {isClicked ? 'CUSTOMER OPENED' : 'AWAITING CAPTURE'}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] text-slate-300">
          {linkId && (
            <span className="font-mono text-slate-400">
              ID: <strong className="text-slate-200">{linkId}</strong>
            </span>
          )}
          {amount != null && (
            <span className="font-semibold text-emerald-400">
              Amount: {formatINR(amount)}
            </span>
          )}
        </div>
        {linkUrl && (
          <div className="pt-1 border-t border-cyan-500/20 flex items-center justify-between">
            <span className="text-[10px] font-mono text-slate-400 truncate max-w-[200px]">
              {linkUrl}
            </span>
            <a
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-cyan-400 hover:text-cyan-200 underline font-semibold flex items-center gap-1"
            >
              Open Checkout Link ↗
            </a>
          </div>
        )}
      </div>
    )
  }

  // 2. Mandate Renewal / Re-auth Link Card
  if (action === 'sent_reauth_link') {
    const linkUrl = extra?.linkUrl || (payload?.link_url as string)
    return (
      <div className="mt-2 p-2.5 rounded-xl bg-purple-950/30 border border-purple-500/30 text-xs flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-purple-300">
            <span>🔄</span>
            <span>Mandate Renewal &amp; Re-authorization</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">
            MANDATE RE-AUTH
          </span>
        </div>
        <p className="text-[11px] text-slate-300">
          Sent customer re-authorization link to replace expired card/mandate token.
        </p>
        {linkUrl && (
          <a
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-purple-300 hover:text-white underline font-mono truncate"
          >
            {linkUrl} ↗
          </a>
        )}
      </div>
    )
  }

  // 3. Payment Captured Card
  if (action === 'payment_captured') {
    const recoveredAmount = extra?.amount || (payload?.recovered_amount as string | number)
    const source = extra?.source || (payload?.source as string)

    return (
      <div className="mt-2 p-2.5 rounded-xl bg-emerald-950/35 border border-emerald-500/40 text-xs flex flex-col gap-1.5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-bold text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>✓ Payment Verified &amp; Captured</span>
          </div>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/30">
            STATUS: RECOVERED
          </span>
        </div>
        <div className="flex items-center justify-between text-xs mt-0.5">
          <span className="text-slate-300">
            Source:{' '}
            <strong className="text-white capitalize">
              {source ? source.replace(/_/g, ' ') : 'Gateway'}
            </strong>
          </span>
          {recoveredAmount != null && (
            <span className="font-extrabold text-sm text-emerald-400">
              +{formatINR(recoveredAmount)}
            </span>
          )}
        </div>
      </div>
    )
  }

  // 4. Payment Capture Failed Card
  if (action === 'payment_capture_failed') {
    const reason = (payload?.reason as string) || node.reasoning
    return (
      <div className="mt-2 p-2.5 rounded-xl bg-rose-950/35 border border-rose-500/40 text-xs flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-rose-300">
            <span>✕</span>
            <span>Payment Capture Attempt Failed</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">
            ATTEMPT FAILED
          </span>
        </div>
        <p className="text-[11px] text-slate-300 mt-0.5 font-mono">
          Reason: <span className="text-rose-200 font-semibold">{reason}</span>
        </p>
      </div>
    )
  }

  // 5. Customer Action Details (Message / Voice / OTP / Silence)
  if (node.category === 'customer') {
    const customerText = extra?.customerText || (payload?.message as string) || (payload?.text as string)
    const isSilence = action === 'customer_silence'
    const isOtp = action === 'customer_otp_submitted'
    const isHumanReq = action === 'customer_requested_human'

    return (
      <div className="mt-2 p-2.5 rounded-xl bg-amber-950/30 border border-amber-500/35 text-xs flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-bold text-amber-300">
            <span>👤</span>
            <span>Customer Interaction</span>
          </div>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/25">
            {isSilence ? 'SILENCE' : isOtp ? 'OTP SUBMITTED' : isHumanReq ? 'HUMAN REQUEST' : 'CUSTOMER TURN'}
          </span>
        </div>
        {customerText && (
          <blockquote className="text-[11px] italic text-slate-200 pl-2 border-l-2 border-amber-400/50 my-0.5 leading-relaxed">
            &ldquo;{customerText}&rdquo;
          </blockquote>
        )}
      </div>
    )
  }

  // 6. Promise-to-Pay (PTP) Commitment Card
  if (action === 'ptp_recorded' || action === 'ptp_paused_escalation' || action === 'customer_promised_to_pay') {
    const promisedDate = extra?.promisedDate || (payload?.promised_date as string)
    return (
      <div className="mt-2 p-2.5 rounded-xl bg-teal-950/30 border border-teal-500/35 text-xs flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-teal-300">
            <span>🤝</span>
            <span>Promise-to-Pay Commitment</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-teal-500/15 text-teal-300 border border-teal-500/25">
            PTP ACTIVE
          </span>
        </div>
        {promisedDate && (
          <div className="text-[11px] text-slate-300">
            Promised Settlement Date: <strong className="text-teal-200">{formatDateTime(promisedDate)}</strong>
          </div>
        )}
        <p className="text-[10px] text-slate-400">
          Automated outreach paused until commitment deadline.
        </p>
      </div>
    )
  }

  // 7. Fraud / Safety Halt Alert
  if (action === 'halted_fraud_cluster' || action === 'halted_stopping_rule') {
    return (
      <div className="mt-2 p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/50 text-xs flex flex-col gap-1">
        <div className="flex items-center gap-1.5 font-bold text-rose-300">
          <span>🛑</span>
          <span>Safety Rule Triggered — Recovery Halted</span>
        </div>
        <p className="text-[11px] text-slate-300 mt-0.5 leading-relaxed">
          {node.reasoning}
        </p>
      </div>
    )
  }

  return null
}

function TimelineNode({
  node,
  last,
}: {
  node: UnifiedAuditNode
  last: boolean
}) {
  const [openPayload, setOpenPayload] = useState(false)
  const theme = CATEGORY_THEME[node.category] ?? CATEGORY_THEME.intervention
  const hasPayload =
    node.payload != null &&
    typeof node.payload === 'object' &&
    Object.keys(node.payload).length > 0

  const agentLabel =
    node.agent === 'customer'
      ? 'Customer'
      : node.agent === 'simulation'
      ? 'Simulation'
      : AGENT_LABEL[node.agent as AgentName] ?? node.agent

  return (
    <li className="relative pl-6">
      {!last && (
        <span
          className="absolute left-[7px] top-4 bottom-0 w-px bg-white/10"
          aria-hidden
        />
      )}
      <span
        className="absolute left-0.5 top-2 h-2.5 w-2.5 rounded-full ring-2 ring-slate-950 transition-all shadow-sm"
        style={{ background: theme.markerColor }}
        aria-hidden
      />
      <div className="pb-5">
        <div className="flex flex-wrap items-center gap-2">
          {/* Agent Badge */}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
              node.agent === 'customer'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'bg-white/10 text-slate-200 border border-white/15'
            }`}
          >
            <span>{theme.icon}</span>
            <span>{agentLabel}</span>
          </span>

          {/* Category Pill */}
          <span
            className={`rounded-full px-2 py-0.2 text-[10px] font-medium border ${theme.badgeBg} ${theme.badgeText} ${theme.borderColor}`}
          >
            {theme.label}
          </span>

          {/* Action Title */}
          <span className="text-xs font-bold text-slate-100">
            {labelAction(node.action)}
          </span>

          {/* Simulated / Sandbox tag */}
          {node.isSimulated && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
              SANDBOX
            </span>
          )}

          {/* Timestamp */}
          <span className="ml-auto text-[11px] font-mono text-slate-400">
            {node.timestamp.includes('T') ? formatDateTime(node.timestamp) : node.timestamp}
          </span>
        </div>

        {/* Reasoning explanation */}
        <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
          {node.reasoning}
        </p>

        {/* Specialized Event Card (Payment Link, Mandate Renewal, Captured, etc.) */}
        <EventCard node={node} />

        {/* Technical Payload Viewer */}
        {hasPayload && (
          <div className="mt-1.5">
            <button
              type="button"
              className="text-[10px] font-mono text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              onClick={() => setOpenPayload((o) => !o)}
            >
              {openPayload ? '▼ Hide technical payload' : '▶ Show payload data'}
            </button>
            {openPayload && (
              <div className="mt-1">
                <PayloadViewer payload={node.payload} />
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export function AuditTimeline({
  trail = [],
  simulatedEvents = [],
  filterEnabled = true,
  emptyMessage,
}: AuditTimelineProps) {
  const [activeCategory, setActiveCategory] = useState<AuditCategory | 'all'>('all')

  // Merge and sort in STRICT CHRONOLOGICAL ORDER, deduplicating repeated customer_silence
  const allEvents = useMemo(() => {
    const baseNodes = trail.map(normalizeAuditRead)
    const combined = [...baseNodes, ...simulatedEvents]

    // Sort strictly by sortKey (epoch ms or sequence)
    const sorted = combined.sort((a, b) => a.sortKey - b.sortKey)

    // Deduplicate repeated customer_silence nodes, keeping only the single terminal notice
    let hasSilence = false
    const deduped: UnifiedAuditNode[] = []
    for (const node of sorted) {
      if (node.action === 'customer_silence') {
        if (hasSilence) continue
        hasSilence = true
      }
      deduped.push(node)
    }
    return deduped
  }, [trail, simulatedEvents])

  // Count items per category
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allEvents.length }
    for (const e of allEvents) {
      counts[e.category] = (counts[e.category] || 0) + 1
    }
    return counts
  }, [allEvents])

  const filteredEvents = useMemo(() => {
    if (activeCategory === 'all') return allEvents
    return allEvents.filter((e) => e.category === activeCategory)
  }, [allEvents, activeCategory])

  if (allEvents.length === 0) {
    return (
      <EmptyState
        title="No decision trail yet"
        hint={
          emptyMessage ||
          'This case has not been through the pipeline, or it is still in an early stage. Every agent decision and customer action will be listed here.'
        }
      />
    )
  }

  const categoriesWithItems: (AuditCategory | 'all')[] = [
    'all',
    'payment',
    'customer',
    'intervention',
    'diagnosis',
    'commitment',
    'safety',
    'human',
    'simulation',
  ].filter((c) => c === 'all' || (categoryCounts[c] && categoryCounts[c] > 0)) as (AuditCategory | 'all')[]

  return (
    <div className="space-y-3">
      {/* Category Filter Pills */}
      {filterEnabled && categoriesWithItems.length > 2 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-2.5 border-b border-white/[0.06]">
          {categoriesWithItems.map((cat) => {
            const isAll = cat === 'all'
            const active = activeCategory === cat
            const theme = !isAll ? CATEGORY_THEME[cat] : null
            const label = isAll ? 'All Events' : theme?.label ?? cat
            const icon = isAll ? '📋' : theme?.icon ?? '•'
            const count = categoryCounts[cat] || 0

            return (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={`px-2 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-1 transition-all cursor-pointer ${
                  active
                    ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-400'
                    : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white'
                }`}
              >
                <span>{icon}</span>
                <span>{label}</span>
                <span
                  className={`ml-0.5 px-1.5 py-0.2 rounded-full text-[9px] font-mono ${
                    active ? 'bg-indigo-800 text-white' : 'bg-white/10 text-slate-400'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Chronological List of Nodes */}
      <ol className="mt-3">
        {filteredEvents.map((node, i) => (
          <TimelineNode
            key={`${node.id}-${node.sortKey}-${i}`}
            node={node}
            last={i === filteredEvents.length - 1}
          />
        ))}
      </ol>
    </div>
  )
}

