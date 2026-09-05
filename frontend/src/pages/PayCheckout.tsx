import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { dataSource } from '../api/dataSource'
import { useLiquidGlass } from '../lib/liquidGlass'
import { formatINRPrecise } from '../lib/format'
import type { PaymentAttemptFailureReason, PaymentPageResponse } from '../api/types'

type Step = 'loading' | 'otp' | 'processing' | 'success' | 'failed' | 'exhausted' | 'error'

const FAILURE_LABEL: Record<PaymentAttemptFailureReason, string> = {
  wrong_otp: 'The OTP you entered was incorrect.',
  insufficient_funds: 'Your account has insufficient balance right now.',
  user_cancelled: 'The payment was cancelled before it completed.',
}

export default function PayCheckout() {
  const { token = '' } = useParams()
  const [step, setStep] = useState<Step>('loading')
  const [page, setPage] = useState<PaymentPageResponse | null>(null)
  const [otp, setOtp] = useState('')
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const cardRef = useRef<HTMLDivElement>(null)
  useLiquidGlass(cardRef, { scale: -90, chroma: 5, border: 0.06, blur: 4 })

  useEffect(() => {
    let cancelled = false
    dataSource
      .getPaymentPage(token)
      .then((res) => {
        if (cancelled) return
        setPage(res)
        setAttemptsRemaining(res.attempts_remaining)
        if (res.payment_link_status === 'captured') {
          setStep('success')
        } else if (res.attempts_remaining <= 0) {
          setStep('exhausted')
        } else {
          setStep('otp')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setErrorMessage(err instanceof Error ? err.message : 'This payment link could not be found.')
        setStep('error')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (step !== 'otp') return
    setStep('processing')
    setFailureReason(null)
    try {
      const res = await dataSource.attemptPayment(token)
      if ('status' in res && res.status === 'error') {
        setAttemptsRemaining(0)
        setStep('exhausted')
        return
      }
      if ('captured' in res) {
        setAttemptsRemaining(res.attempts_remaining)
        if (res.captured) {
          setStep('success')
        } else {
          setFailureReason(res.reason)
          if (res.attempts_remaining <= 0) {
            setStep('exhausted')
          } else {
            setStep('failed')
          }
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'The payment attempt could not be completed.')
      setStep('error')
    }
  }

  const retry = () => {
    setOtp('')
    setStep('otp')
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#0a0c10] px-4 py-10 text-slate-100">
      <div ref={cardRef} className="w-full max-w-sm liquid-glass-card p-6 relative">
        <div className="text-center mb-5">
          <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold mb-1">
            Razorpay · Test Mode
          </div>
          <h1 className="text-lg font-semibold text-white">Complete your payment</h1>
        </div>

        {step === 'loading' && (
          <div className="py-10 flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-indigo-400 animate-spin" />
            <p className="text-xs text-slate-400">Loading payment details…</p>
          </div>
        )}

        {step === 'error' && (
          <div className="py-8 text-center">
            <p className="text-sm text-rose-300 font-medium mb-1">Link unavailable</p>
            <p className="text-xs text-slate-400">{errorMessage}</p>
          </div>
        )}

        {page && step !== 'loading' && step !== 'error' && (
          <>
            <div className="liquid-glass-pill rounded-xl p-4 mb-5">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Billed to</span>
                <span className="text-slate-200">{page.customer_name}</span>
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>Amount due</span>
                <span className="text-white font-semibold text-base">
                  {formatINRPrecise(page.amount)}
                </span>
              </div>
            </div>

            {(step === 'otp' || step === 'processing' || step === 'failed') && (
              <form onSubmit={submit} className="flex flex-col gap-3">
                <label className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                  Enter OTP sent to your registered mobile
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••"
                  disabled={step === 'processing'}
                  className="w-full px-3 py-2.5 rounded-xl liquid-glass-pill text-center text-lg tracking-[0.5em] text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
                />

                {step === 'failed' && failureReason && (
                  <div className="p-3 rounded-lg liquid-glass-pill text-xs text-rose-300">
                    {FAILURE_LABEL[failureReason as PaymentAttemptFailureReason] ?? failureReason}
                    {attemptsRemaining != null && (
                      <span className="block text-slate-500 mt-1">
                        {attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} remaining
                      </span>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={step === 'processing' || otp.length < 4}
                  className="w-full py-2.5 rounded-xl liquid-glass-pill hover:bg-white/10 text-white font-semibold text-sm transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {step === 'processing' ? 'Verifying…' : 'Pay ' + formatINRPrecise(page.amount)}
                </button>

                <p className="text-[10px] text-slate-500 text-center">
                  Test mode — no real money moves. Razorpay-style OTP simulation.
                </p>
              </form>
            )}

            {step === 'success' && (
              <div className="py-6 text-center flex flex-col items-center gap-2">
                <div className="w-12 h-12 rounded-full liquid-glass-pill flex items-center justify-center text-emerald-300 text-xl font-semibold">
                  &#10003;
                </div>
                <p className="text-sm font-semibold text-emerald-300">Payment successful</p>
                <p className="text-xs text-slate-400">
                  {formatINRPrecise(page.amount)} received. A receipt has been sent to your registered contact.
                </p>
              </div>
            )}

            {step === 'exhausted' && (
              <div className="py-6 text-center flex flex-col items-center gap-2">
                <p className="text-sm font-semibold text-amber-300">No attempts remaining</p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  This payment link has reached its retry limit. Please contact Razorpay support or
                  wait for a new link to be sent.
                </p>
              </div>
            )}

            {step === 'failed' && (
              <button
                type="button"
                onClick={retry}
                className="mt-3 w-full py-2 rounded-xl liquid-glass-pill hover:bg-white/10 text-slate-200 text-xs font-medium transition-colors"
              >
                Try again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
