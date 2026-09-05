import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dataSource } from '../api/dataSource'
import { useAsync } from '../hooks/useAsync'
import { useLiquidGlass } from '../lib/liquidGlass'
import {
  labelEventType,
  labelRootCause,
} from '../api/actionLabels'
import { formatDateTime, formatINRPrecise, formatPct } from '../lib/format'
import { SimilarCases } from './SimilarCases'
import { AuditTimeline } from './AuditTimeline'
import { StatusPill } from './StatusPill'
import { Skeleton, ErrorState } from './Feedback'
import { SimulateSession } from './SimulateSession'
import { SequencerTimeline } from './SequencerTimeline'
import type { EventRead } from '../api/types'

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-xs border-b border-white/[0.04] last:border-0">
      <span className="text-slate-400 font-medium">{label}</span>
      <span className="text-right text-slate-200">{value}</span>
    </div>
  )
}

const maskTail = (v: string | null | undefined): string | null => {
  if (!v) return null
  const tail = v.slice(-4)
  return `${'•'.repeat(Math.max(v.length - 4, 4))}${tail}`
}

function Summary({ event }: { event: EventRead }) {
  const hasContact = event.customer_name || event.customer_phone || event.customer_upi_vpa
  return (
    <div className="rounded-2xl liquid-glass-card p-4 my-3 text-slate-200">
      <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-2 flex items-center justify-between pb-1 border-b border-white/[0.06]">
        <span>Case Overview</span>
        <span className="font-mono text-indigo-400">{event.event_id}</span>
      </div>
      <SummaryRow label="Customer" value={<span className="font-mono">{event.customer_id}</span>} />
      {hasContact && (
        <>
          {event.customer_name && <SummaryRow label="Name" value={event.customer_name} />}
          {event.customer_phone && (
            <SummaryRow label="Phone" value={<span className="font-mono">{maskTail(event.customer_phone)}</span>} />
          )}
          {event.customer_bank_account && (
            <SummaryRow
              label="Bank account"
              value={<span className="font-mono">{maskTail(event.customer_bank_account)}</span>}
            />
          )}
          {event.customer_upi_vpa && (
            <SummaryRow label="UPI VPA" value={<span className="font-mono">{event.customer_upi_vpa}</span>} />
          )}
          <p className="text-[10px] text-slate-500 -mt-0.5 mb-1">synthetic test data, not a real record</p>
        </>
      )}
      <SummaryRow label="Type" value={labelEventType(event.event_type)} />
      <SummaryRow label="Amount at risk" value={formatINRPrecise(event.amount)} />
      <SummaryRow label="Recovered" value={formatINRPrecise(event.recovered_amount)} />
      <SummaryRow label="Root cause" value={labelRootCause(event.root_cause)} />
      <SummaryRow
        label="Diagnosis confidence"
        value={
          event.diagnosis_confidence == null
            ? '—'
            : formatPct(event.diagnosis_confidence)
        }
      />
      {event.ptp_status && event.ptp_status !== 'none' && (
        <SummaryRow
          label="Promise-to-Pay (PTP)"
          value={
            <span className="capitalize font-semibold text-amber-400">
              {event.ptp_status} {event.promised_date ? `(${formatDateTime(event.promised_date)})` : ''}
            </span>
          }
        />
      )}
      <SummaryRow label="Attempts so far" value={event.attempts_so_far} />
      <SummaryRow label="Days overdue" value={event.days_overdue} />
      <SummaryRow
        label="Failure reason (raw)"
        value={<span className="font-mono text-xs">{event.raw_failure_reason ?? '—'}</span>}
      />
      <SummaryRow label="Last updated" value={formatDateTime(event.updated_at)} />
    </div>
  )
}

export function DetailDrawer({
  caseId,
  onClose,
}: {
  caseId: string | null
  onClose: () => void
}) {
  const [simulateOpen, setSimulateOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  useLiquidGlass(drawerRef, { scale: -112, chroma: 6, border: 0.05, blur: 4 })

  useEffect(() => {
    if (!caseId) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [caseId, onClose])

  const state = useAsync(
    () => dataSource.getEventAudit(caseId as string),
    [caseId],
  )

  if (!caseId) return null

  return (
    <>
      <div className="fixed inset-0 z-40 flex justify-end">
        <button
          type="button"
          aria-label="Close"
          className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 cursor-pointer"
          onClick={onClose}
        />
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Decision trail for ${caseId}`}
          className="relative z-10 flex h-full w-full max-w-lg flex-col overflow-y-auto liquid-glass-drawer p-6 text-slate-100 shadow-2xl animate-in slide-in-from-right duration-300"
        >
          <div className="mb-4 flex items-center justify-between pb-3 border-b border-white/[0.08]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-sm shadow-inner">
                ⚡
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">Decision Trail</h2>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                    LIQUID GLASS
                  </span>
                </div>
                <p className="text-xs font-mono text-slate-400 mt-0.5">{caseId}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer text-sm"
              title="Close drawer"
            >
              ✕
            </button>
          </div>

          {state.loading && <Skeleton rows={8} />}
          {state.error && <ErrorState message={state.error} />}
          {state.data && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <StatusPill status={state.data.event.status} />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSimulateOpen(true)}
                    title="Roleplay this case as a two-AI text chat — sandboxed rehearsal, nothing is saved"
                    aria-pressed={simulateOpen}
                    className={`px-2.5 py-1.5 text-xs font-bold rounded-xl border transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-md ${
                      simulateOpen
                        ? 'bg-gradient-to-r from-purple-600/60 to-indigo-600/60 text-white border-purple-400/70 ring-2 ring-purple-400/40'
                        : 'bg-gradient-to-r from-purple-600/30 to-indigo-600/30 hover:from-purple-600/50 hover:to-indigo-600/50 text-purple-200 border-purple-500/40'
                    }`}
                  >
                    🧪 Simulate
                  </button>
                </div>
              </div>

              <Summary event={state.data.event} />

              {/* Mandate Retry Sequencer Plan */}
              <div className="mt-4 rounded-2xl liquid-glass-card p-4">
                <SequencerTimeline eventId={caseId} />
              </div>

              <h3 className="mt-5 mb-2 text-sm font-semibold text-slate-200">
                Every agent decision
              </h3>
              <div className="rounded-2xl liquid-glass-card p-4">
                <AuditTimeline trail={state.data.trail} />
              </div>

              <div className="mt-4 rounded-2xl liquid-glass-card p-4">
                <SimilarCases caseId={caseId} />
              </div>
            </>
          )}
        </div>
      </div>

      <SimulateSession
        eventId={caseId}
        isOpen={simulateOpen}
        onClose={() => setSimulateOpen(false)}
      />
    </>
  )
}

