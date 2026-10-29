import { useState } from 'react';
import { X, KeyRound, Eye, EyeOff, Loader2, CheckCircle, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';
import { setTokens } from '../lib/auth';

interface Props {
  onClose: () => void;
}

function getStrength(pw: string): { level: 0 | 1 | 2 | 3; label: string; color: string } {
  if (pw.length < 8)  return { level: 0, label: '', color: '' };
  const hasUpper   = /[A-Z]/.test(pw);
  const hasLower   = /[a-z]/.test(pw);
  const hasDigit   = /[0-9]/.test(pw);
  const hasSpecial = /[^A-Za-z0-9]/.test(pw);
  const score = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (pw.length >= 12 && score === 4) return { level: 3, label: 'Strong',   color: 'bg-emerald-500' };
  if (score >= 3)                     return { level: 2, label: 'Good',     color: 'bg-teal-500'    };
  return                                     { level: 1, label: 'Fair',     color: 'bg-amber-400'   };
}

export default function ChangePasswordModal({ onClose }: Props) {
  const [current,  setCurrent]  = useState('');
  const [next,     setNext]     = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [showCur,  setShowCur]  = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showCon,  setShowCon]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [success,  setSuccess]  = useState(false);
  const [error,    setError]    = useState('');

  const strength = getStrength(next);
  const match    = next && confirm && next === confirm;
  const mismatch = confirm.length > 0 && next !== confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current)         return setError('Enter your current password.');
    if (next.length < 8)  return setError('New password must be at least 8 characters.');
    if (next !== confirm)  return setError('New passwords do not match.');
    setError('');
    setLoading(true);
    try {
      const { refreshToken } = await api.profile.changePassword({
        currentPassword: current,
        newPassword:     next,
      });
      // Replace refresh token so the current session stays alive
      // Access token remains valid until its 15-min expiry
      const existingAt = localStorage.getItem('tunegen_at') ?? '';
      setTokens(existingAt, refreshToken);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to change password');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center">
              <KeyRound size={15} className="text-teal-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">Change Password</h2>
          </div>
          <button onClick={onClose} disabled={loading}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        {success ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3 text-center">
            <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center">
              <CheckCircle size={28} className="text-emerald-500" />
            </div>
            <p className="text-base font-bold text-slate-900">Password Updated</p>
            <p className="text-sm text-slate-500 max-w-xs">
              Your password has been changed. All other devices have been signed out for security.
            </p>
            <button onClick={onClose}
              className="mt-2 px-6 py-2.5 bg-teal-600 text-white text-sm font-semibold rounded-xl hover:bg-teal-700 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
            <ErrorBanner error={error} />

            {/* Security notice */}
            <div className="flex items-start gap-2.5 bg-slate-50 rounded-xl px-3.5 py-3 border border-slate-100">
              <ShieldCheck size={15} className="text-teal-500 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-500 leading-relaxed">
                All other active sessions will be signed out when you change your password.
              </p>
            </div>

            {/* Current Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Current Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type={showCur ? 'text' : 'password'}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  placeholder="Enter your current password"
                  autoComplete="current-password"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                />
                <button type="button" tabIndex={-1}
                  onClick={() => setShowCur(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showCur ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* New Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                New Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type={showNext ? 'text' : 'password'}
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                />
                <button type="button" tabIndex={-1}
                  onClick={() => setShowNext(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showNext ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {/* Strength bar */}
              {next.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="flex gap-1">
                    {[1, 2, 3].map(n => (
                      <div key={n}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          strength.level >= n ? strength.color : 'bg-slate-200'
                        }`}
                      />
                    ))}
                  </div>
                  {strength.label && (
                    <p className={`text-xs font-medium ${
                      strength.level === 3 ? 'text-emerald-600'
                      : strength.level === 2 ? 'text-teal-600'
                      : 'text-amber-600'
                    }`}>
                      {strength.label}
                      {strength.level < 3 && ' — add uppercase, numbers, or symbols'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Confirm New Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type={showCon ? 'text' : 'password'}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                  className={`w-full text-sm border rounded-xl px-3 py-2.5 pr-10 focus:outline-none focus:ring-2 bg-slate-50 ${
                    mismatch
                      ? 'border-red-300 focus:ring-red-400'
                      : match
                      ? 'border-emerald-300 focus:ring-emerald-400'
                      : 'border-slate-200 focus:ring-teal-500'
                  }`}
                />
                <button type="button" tabIndex={-1}
                  onClick={() => setShowCon(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showCon ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {mismatch && (
                <p className="text-xs text-red-500 mt-1 font-medium">Passwords do not match</p>
              )}
              {match && (
                <p className="text-xs text-emerald-600 mt-1 font-medium flex items-center gap-1">
                  <CheckCircle size={11} /> Passwords match
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={loading}
                className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={loading || !current || next.length < 8 || next !== confirm}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-50 min-w-36 justify-center">
                {loading
                  ? <><Loader2 size={15} className="animate-spin" /> Updating...</>
                  : 'Update Password'
                }
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
