import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { dataSource } from '../api/dataSource'
import { useAsync } from '../hooks/useAsync'
import { Card } from '../components/Card'
import { DataTable, type Column } from '../components/DataTable'
import { StatusPill } from '../components/StatusPill'
import { SimulateSession } from '../components/SimulateSession'
import { Skeleton, ErrorState } from '../components/Feedback'
import { labelEventType, labelRootCause } from '../api/actionLabels'
import { formatINR, toNum } from '../lib/format'
import type { EventRead } from '../api/types'

const columns: Column<EventRead>[] = [
  {
    key: 'event_id',
    header: 'Case',
    render: (e) => <span className="font-mono text-xs">{e.event_id}</span>,
    sortValue: (e) => e.event_id,
    csv: (e) => e.event_id,
  },
  {
    key: 'customer_name',
    header: 'Customer',
    render: (e) => e.customer_name ?? <span className="font-mono text-xs">{e.customer_id}</span>,
    sortValue: (e) => e.customer_name ?? e.customer_id,
    csv: (e) => e.customer_name ?? e.customer_id,
  },
  {
    key: 'event_type',
    header: 'Type',
    render: (e) => labelEventType(e.event_type),
    sortValue: (e) => e.event_type,
    csv: (e) => e.event_type,
  },
  {
    key: 'root_cause',
    header: 'Root cause',
    render: (e) => labelRootCause(e.root_cause),
    sortValue: (e) => e.root_cause ?? '',
    csv: (e) => e.root_cause ?? '',
  },
  {
    key: 'amount',
    header: '₹ at risk',
    numeric: true,
    render: (e) => formatINR(e.amount),
    sortValue: (e) => toNum(e.amount),
    csv: (e) => e.amount,
  },
  {
    key: 'status',
    header: 'Status',
    render: (e) => <StatusPill status={e.status} />,
    sortValue: (e) => e.status,
    csv: (e) => e.status,
  },
]

type DataSourceMode = 'synthetic' | 'razorpay_test_mode'

export function Playground() {
  const { data, loading, error } = useAsync(() => dataSource.getEvents())
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [sourceMode, setSourceMode] = useState<DataSourceMode>('synthetic')

  const events = useMemo(() => data?.events ?? [], [data])
  const simulateId = params.get('simulate')

  const hasRazorpayLinks = useMemo(
    () => events.some((e) => (e.payment_link_id ?? '').startsWith('plink_')),
    [events],
  )

  const scoped = useMemo(() => {
    if (sourceMode !== 'razorpay_test_mode' || !hasRazorpayLinks) return events
    return events.filter((e) => (e.payment_link_id ?? '').startsWith('plink_'))
  }, [events, sourceMode, hasRazorpayLinks])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter(
      (e) =>
        e.event_id.toLowerCase().includes(q) ||
        e.customer_id.toLowerCase().includes(q) ||
        (e.customer_name ?? '').toLowerCase().includes(q),
    )
  }, [scoped, search])

  if (loading) return <Skeleton rows={12} />
  if (error) return <ErrorState message={error} />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-ink">Playground</h1>
        <p className="mt-0.5 max-w-2xl text-xs text-ink-muted">
          Pick any case and talk to the AI yourself — as the customer, or watch two
          AIs role-play the whole outreach. A rehearsal: nothing you do here is saved
          to the dashboard or counted in the metrics.
        </p>
      </div>

      <Card title="Simulation settings">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-ink-soft">Data source</label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSourceMode('synthetic')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-[var(--color-ring)] ${
                sourceMode === 'synthetic' ? 'bg-surface-2 text-ink' : 'text-ink-soft hover:text-ink'
              }`}
            >
              Synthetic seed batch
            </button>
            <button
              type="button"
              onClick={() => hasRazorpayLinks && setSourceMode('razorpay_test_mode')}
              disabled={!hasRazorpayLinks}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
                sourceMode === 'razorpay_test_mode' ? 'bg-surface-2 text-ink' : 'text-ink-soft hover:text-ink'
              }`}
            >
              Razorpay test-mode records only
            </button>
          </div>
          {!hasRazorpayLinks && (
            <p className="text-[11px] text-ink-muted">
              No Razorpay test-mode payment links (`plink_...`) found in this dataset — no Razorpay
              test-mode keys are configured on the backend for this run, so every case here used the
              fake gateway instead. This toggle is disabled until real test-mode links exist.
            </p>
          )}
          {hasRazorpayLinks && sourceMode === 'razorpay_test_mode' && (
            <p className="text-[11px] text-ink-muted">
              Showing only cases backed by a genuine Razorpay test-mode Payment Link.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Pick a case to simulate"
        action={
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search case, customer…"
            className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs text-ink ring-1 ring-[var(--color-ring)] focus:outline-none focus:ring-2"
          />
        }
      >
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(e) => e.event_id}
          initialSort={{ key: 'amount', dir: 'desc' }}
          onRowClick={(e) => setParams({ simulate: e.event_id })}
          emptyLabel="No cases match this search"
        />
      </Card>

      <SimulateSession
        eventId={simulateId ?? ''}
        isOpen={!!simulateId}
        onClose={() => {
          const next = new URLSearchParams(params)
          next.delete('simulate')
          setParams(next)
        }}
      />
    </div>
  )
}
