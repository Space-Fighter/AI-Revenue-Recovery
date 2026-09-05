import { useEffect, useState, type PropsWithChildren } from 'react'
import { NavLink } from 'react-router-dom'
import { dataSource } from '../api/dataSource'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/queue', label: 'At-risk queue', end: false },
  { to: '/recovery', label: 'Recovery', end: false },
  { to: '/exceptions', label: 'Exceptions', end: false },
  { to: '/attention', label: 'Urgent attention', end: false },
]

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () =>
      (document.documentElement.dataset.theme as 'light' | 'dark') ||
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'),
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <button
      type="button"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      className="rounded-lg px-2.5 py-1 text-xs text-ink-soft ring-1 ring-[var(--color-ring)]"
    >
      {theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  )
}

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-plane text-ink">
      <header
        className="sticky top-0 z-30 border-b border-[var(--color-hairline)] backdrop-blur-md"
        style={{
          background:
            'linear-gradient(180deg, var(--glass-tint-from), var(--glass-tint-to))',
        }}
      >
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <div>
            <div className="text-sm font-semibold">AI Revenue Recovery</div>
            <div className="text-xs text-ink-muted">
              Detect · diagnose · recover · account for every case
            </div>
          </div>
          <nav className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 ${
                    isActive
                      ? 'bg-surface-2 font-medium text-ink'
                      : 'text-ink-soft hover:text-ink'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-ink-muted">
              {dataSource.isLive ? 'Live API' : 'Sample data'}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="viz-root mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
