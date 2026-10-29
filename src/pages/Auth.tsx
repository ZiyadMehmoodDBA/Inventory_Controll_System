import { useState, useEffect, useRef } from 'react';
import {
  TrendingUp, Eye, EyeOff, User, Mail, Phone, Lock,
  Building2, MapPin, ArrowRight, CheckCircle, AlertCircle,
  Loader2, ShieldCheck, Zap, PieChart, FlaskConical,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { api } from '../api/client';

interface AuthProps {
  onAuth: (user: {
    name: string; email: string; role: string;
    organization_id: number;
    branch_id: number | null;
    organization?: { name: string; code: string; currency: string };
    branches?: { id: number; name: string; code: string }[];
    accessToken: string;
    refreshToken: string;
    rememberMe?: boolean;
  }) => void;
}

type View = 'login' | 'register' | 'forgot' | 'reset';

interface FormField {
  label: string;
  name: string;
  type: string;
  placeholder: string;
  icon: React.ElementType;
  required?: boolean;
  options?: { value: string; label: string }[];
}

const registerFields: FormField[] = [
  { label: 'Full Name',        name: 'fullName',        type: 'text',     placeholder: 'Muhammad Ahmed',   icon: User,      required: true },
  { label: 'Email Address',    name: 'email',           type: 'email',    placeholder: 'ahmed@company.pk', icon: Mail,      required: true },
  { label: 'Phone Number',     name: 'phone',           type: 'tel',      placeholder: '+92-300-1234567',  icon: Phone,     required: true },
  { label: 'Business Name',    name: 'org_name',        type: 'text',     placeholder: 'TuneGEN Traders',  icon: Building2, required: true },
  { label: 'Business Type',    name: 'org_type',        type: 'select',   placeholder: '',                 icon: Building2, required: true,
    options: [
      { value: 'retail',      label: 'Retail' },
      { value: 'wholesale',   label: 'Wholesale' },
      { value: 'franchise',   label: 'Franchise' },
      { value: 'distributor', label: 'Distributor' },
    ],
  },
  { label: 'City / Address',   name: 'city',            type: 'text',     placeholder: 'Lahore',           icon: MapPin },
  { label: 'Password',         name: 'password',        type: 'password', placeholder: '••••••••',         icon: Lock,      required: true },
  { label: 'Confirm Password', name: 'confirmPassword', type: 'password', placeholder: '••••••••',         icon: Lock,      required: true },
];

const loginFields: FormField[] = [
  { label: 'Email Address', name: 'email',    type: 'email',    placeholder: 'ahmed@company.pk', icon: Mail, required: true },
  { label: 'Password',      name: 'password', type: 'password', placeholder: '••••••••',         icon: Lock, required: true },
];

function getPasswordStrength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8)          score++;
  if (/[A-Z]/.test(pw))        score++;
  if (/[0-9]/.test(pw))        score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score, label: 'Weak',   color: 'bg-red-400' };
  if (score === 2) return { score, label: 'Fair',   color: 'bg-amber-400' };
  if (score === 3) return { score, label: 'Good',   color: 'bg-teal-500' };
  return              { score, label: 'Strong', color: 'bg-emerald-500' };
}

// Add VITE_GOOGLE_CLIENT_ID=<your_id> to a .env file in the project root to enable Google Sign-In
const GOOGLE_CLIENT_ID = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID;

const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="flex-shrink-0">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

export default function Auth({ onAuth }: AuthProps) {
  const [view, setView]                   = useState<View>('login');
  const [showPw, setShowPw]               = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [loading, setLoading]             = useState(false);
  const [success, setSuccess]             = useState(false);
  const [successMsg, setSuccessMsg]       = useState('');
  const [errors, setErrors]               = useState<Record<string, string>>({});
  const [form, setForm]                   = useState<Record<string, string>>({});
  const [resetToken, setResetToken]       = useState('');
  const googleBtnRef                      = useRef<HTMLDivElement>(null);

  const pw       = form.password ?? '';
  const strength = getPasswordStrength(pw);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const initGoogle = () => {
      const g = (window as any).google;
      if (!g || !googleBtnRef.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response: { credential: string }) => {
          setLoading(true);
          setErrors({});
          try {
            const raw = await api.auth.google(response.credential) as any;
            const { accessToken, refreshToken, user: userFields } = raw;
            // Google sign-in is session-only (no "keep me signed in" prompt)
            onAuth({ ...userFields, accessToken, refreshToken, rememberMe: false });
          } catch (err: any) {
            setErrors({ _form: err.message || 'Google sign-in failed. Please try again.' });
          } finally {
            setLoading(false);
          }
        },
      });
      const btnWidth = googleBtnRef.current.offsetWidth;
      g.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline',
        size: 'large',
        width: btnWidth > 0 ? btnWidth : 360,
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left',
      });
    };

    if ((window as any).google) {
      initGoogle();
    } else {
      const existing = document.getElementById('gsi-client-script');
      if (existing) {
        existing.addEventListener('load', initGoogle);
        return;
      }
      const script  = document.createElement('script');
      script.id     = 'gsi-client-script';
      script.src    = 'https://accounts.google.com/gsi/client';
      script.async  = true;
      script.defer  = true;
      script.onload = initGoogle;
      document.head.appendChild(script);
    }
  }, [onAuth]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (view === 'register') {
      if (!form.fullName?.trim())        next.fullName        = 'Full name is required';
      if (!form.email?.includes('@'))    next.email           = 'Enter a valid email';
      if (!form.phone?.trim())           next.phone           = 'Phone number is required';
      if (!form.org_name?.trim())        next.org_name        = 'Business name is required';
      if ((form.password ?? '').length < 8) next.password    = 'Password must be at least 8 characters';
      if (form.password !== form.confirmPassword) next.confirmPassword = 'Passwords do not match';
    } else {
      if (!form.email?.includes('@')) next.email    = 'Enter a valid email';
      if (!form.password)             next.password = 'Password is required';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setErrors({});
    try {
      if (view === 'register') {
        await api.auth.register({
          fullName:    form.fullName,
          email:       form.email,
          password:    form.password,
          phone:       form.phone,
          org_name:    form.org_name,
          org_type:    form.org_type || 'retail',
          org_phone:   form.phone,
          org_address: form.city,
        });
        setSuccess(true);
        setTimeout(() => { setSuccess(false); setView('login'); setForm({}); }, 1800);
      } else {
        const remember = form.rememberMe === 'true';
        const raw = await api.auth.login({
          email:      form.email,
          password:   form.password,
          rememberMe: remember,
        }) as any;
        // Server returns { accessToken, refreshToken, user: {...} }
        // Flatten so handleAuth receives a single object
        const { accessToken, refreshToken, user: userFields } = raw;
        onAuth({ ...userFields, accessToken, refreshToken, rememberMe: remember });
      }
    } catch (err: any) {
      setErrors({ _form: err.message || 'Something went wrong. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.email?.includes('@')) errs.email = 'Enter a valid email';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const data = await api.auth.forgotPassword(form.email) as any;
      setForm({});
      setErrors({});
      setSuccessMsg(data?.message || 'Ask your administrator to reset your password.');
      setSuccess(true);
      setView('login');
      setTimeout(() => { setSuccess(false); setSuccessMsg(''); }, 8000);
    } catch (err: any) {
      setErrors({ _form: err.message || 'Failed to generate reset link. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if ((form.password ?? '').length < 8)              errs.password        = 'Password must be at least 8 characters';
    if (form.password !== form.confirmPassword)        errs.confirmPassword = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      await api.auth.resetPassword(resetToken, form.password);
      setSuccessMsg('Password updated! Redirecting to sign in…');
      setSuccess(true);
      setForm({});
      setResetToken('');
      setTimeout(() => { setSuccess(false); setSuccessMsg(''); setView('login'); }, 2000);
    } catch (err: any) {
      setErrors({ _form: err.message || 'Failed to reset password. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const set = (name: string, val: string) => {
    setForm(f => ({ ...f, [name]: val }));
    if (errors[name]) setErrors(e => { const n = { ...e }; delete n[name]; return n; });
  };

  const switchView = (v: View) => {
    setView(v); setErrors({}); setForm({});
    if (v !== 'reset') setResetToken('');
    if (v !== 'login')  { setSuccess(false); setSuccessMsg(''); }
  };

  const handleDemo = async () => {
    setLoading(true);
    setErrors({});
    try {
      const raw = await api.auth.demo() as any;
      const { accessToken, refreshToken, user: userFields } = raw;
      onAuth({ ...userFields, accessToken, refreshToken, rememberMe: false });
    } catch (err: any) {
      setErrors({ _form: err.message || 'Failed to start demo. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const fields = view === 'login' ? loginFields : registerFields;

  return (
    <div className="min-h-screen flex bg-[#f0f4f7]">

      {/* ── Left branding panel — lg+ only ── */}
      <div className="hidden lg:flex lg:w-[44%] xl:w-[46%] bg-gradient-to-br from-teal-700 via-teal-600 to-cyan-500 flex-col justify-between p-10 xl:p-14 relative overflow-hidden flex-shrink-0">
        {/* Decorative blobs */}
        <div className="absolute -top-40 -left-40 w-[520px] h-[520px] bg-white/5 rounded-full pointer-events-none" />
        <div className="absolute -bottom-40 -right-40 w-[520px] h-[520px] bg-white/5 rounded-full pointer-events-none" />
        <div className="absolute top-1/3 right-0 w-48 h-48 bg-cyan-400/10 rounded-full pointer-events-none" />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-11 h-11 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center shadow-lg border border-white/30">
            <TrendingUp size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white leading-none">TuneGEN</h1>
            <p className="text-xs text-teal-100/80 font-medium">Billing &amp; Inventory Control</p>
          </div>
        </div>

        {/* Hero copy */}
        <div className="relative z-10">
          <h2 className="text-3xl xl:text-[2.4rem] font-bold text-white leading-snug mb-4">
            Control your billing<br />
            and inventory with<br />
            <span className="text-teal-100">confidence.</span>
          </h2>
          <p className="text-teal-100/75 text-sm xl:text-base leading-relaxed max-w-xs">
            Complete invoicing, inventory, sales tracking and analytics — with AI-powered business reporting.
          </p>

          <div className="mt-8 space-y-3">
            {[
              { icon: ShieldCheck, title: 'Smart Invoicing',     desc: 'Generate professional PDF invoices instantly' },
              { icon: Zap,         title: 'Real-time Inventory', desc: 'Live stock alerts and reorder tracking' },
              { icon: PieChart,    title: 'Business Analytics',  desc: 'Revenue, profit & brand performance reports' },
            ].map(f => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="flex items-start gap-3 p-3.5 rounded-xl bg-white/10 border border-white/20 backdrop-blur-sm">
                  <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon size={15} className="text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white leading-none">{f.title}</p>
                    <p className="text-xs text-teal-100/70 mt-1">{f.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Stats */}
        <div className="relative z-10 flex items-center gap-8 pt-5 border-t border-white/20">
          {[
            { value: '500+',   label: 'Businesses' },
            { value: 'PKR 2B+', label: 'Tracked' },
            { value: '99.9%',  label: 'Uptime' },
          ].map(s => (
            <div key={s.label}>
              <p className="text-xl font-bold text-white">{s.value}</p>
              <p className="text-[11px] text-teal-100/70 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-8 lg:p-10 overflow-y-auto min-h-screen lg:min-h-0">
        <div className="w-full max-w-[420px] py-6 sm:py-0">

          {/* Mobile logo */}
          <div className="flex items-center gap-2.5 mb-6 lg:hidden">
            <div className="w-9 h-9 bg-teal-500 rounded-xl flex items-center justify-center shadow-md">
              <TrendingUp size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900 leading-none">TuneGEN</h1>
              <p className="text-[11px] text-slate-400 font-medium">Management System</p>
            </div>
          </div>

          {/* Card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 overflow-hidden">
            {/* Teal accent strip */}
            <div className="h-1 bg-gradient-to-r from-teal-500 to-cyan-400" />

            <div className="px-6 sm:px-8 py-6 sm:py-8">

              {/* Heading */}
              <div className="mb-5">
                <h3 className="text-xl font-bold text-slate-900">
                  {view === 'login'    ? 'Welcome back'       :
                   view === 'register' ? 'Create account'     :
                   view === 'forgot'   ? 'Forgot password?'   :
                                        'Set new password'}
                </h3>
                <p className="text-sm text-slate-400 mt-1">
                  {view === 'login'    ? 'Sign in to your TuneGEN workspace'          :
                   view === 'register' ? 'Get started with TuneGEN for free'          :
                   view === 'forgot'   ? 'Enter your email and we\'ll generate a reset link' :
                                        'Choose a strong new password for your account'}
                </p>
              </div>

              {/* Success banner */}
              {success && (
                <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-5">
                  <CheckCircle size={17} className="text-emerald-600 flex-shrink-0" />
                  <p className="text-sm font-medium text-emerald-700">
                    {successMsg || 'Account created! Redirecting to sign in…'}
                  </p>
                </div>
              )}

              {/* Google Sign-In — login / register only */}
              {(view === 'login' || view === 'register') && (
                <div className="mb-4 w-full overflow-hidden">
                  {GOOGLE_CLIENT_ID ? (
                    /* GIS renders its button into this div; width is set dynamically to prevent overflow */
                    <div ref={googleBtnRef} className="w-full" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => alert('Add VITE_GOOGLE_CLIENT_ID=<your_client_id> to your .env file to enable Google Sign-In.')}
                      className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 active:bg-slate-100 transition-colors text-sm font-medium text-slate-700 shadow-sm"
                    >
                      <GoogleIcon />
                      Continue with Google
                    </button>
                  )}
                </div>
              )}

              {/* Divider — login / register only */}
              {(view === 'login' || view === 'register') && (
                <div className="flex items-center gap-3 mb-5">
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-xs text-slate-400 font-medium whitespace-nowrap">or continue with email</span>
                  <div className="flex-1 h-px bg-slate-200" />
                </div>
              )}

              {/* Email / password form — login / register only */}
              {(view === 'login' || view === 'register') && (
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                {fields.map(field => {
                  const Icon       = field.icon;
                  const isPassword = field.type === 'password';
                  const isSelect   = field.type === 'select';
                  const isConfirm  = field.name === 'confirmPassword';
                  const visible    = isConfirm ? showConfirmPw : showPw;

                  return (
                    <div key={field.name}>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                        {field.label}
                        {field.required && <span className="text-red-400 ml-0.5">*</span>}
                      </label>
                      <div className="relative">
                        <Icon size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
                        {isSelect ? (
                          <select
                            value={form[field.name] ?? ''}
                            onChange={e => set(field.name, e.target.value)}
                            className={cn(
                              'w-full pl-10 pr-4 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all bg-slate-50 focus:bg-white appearance-none',
                              errors[field.name]
                                ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                                : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
                            )}
                          >
                            <option value="">Select type…</option>
                            {field.options?.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={isPassword ? (visible ? 'text' : 'password') : field.type}
                            placeholder={field.placeholder}
                            value={form[field.name] ?? ''}
                            onChange={e => set(field.name, e.target.value)}
                            className={cn(
                              'w-full pl-10 pr-10 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all bg-slate-50 focus:bg-white',
                              errors[field.name]
                                ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                                : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
                            )}
                          />
                        )}
                        {isPassword && (
                          <button
                            type="button"
                            onClick={() => isConfirm ? setShowConfirmPw(v => !v) : setShowPw(v => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                          >
                            {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        )}
                      </div>

                      {/* Password strength */}
                      {field.name === 'password' && view === 'register' && pw && (
                        <div className="mt-2">
                          <div className="flex gap-1 mb-1">
                            {[1, 2, 3, 4].map(i => (
                              <div
                                key={i}
                                className={cn('h-1 flex-1 rounded-full transition-all', i <= strength.score ? strength.color : 'bg-slate-200')}
                              />
                            ))}
                          </div>
                          <p className={cn('text-xs font-medium', {
                            'text-red-500':     strength.label === 'Weak',
                            'text-amber-500':   strength.label === 'Fair',
                            'text-teal-600':    strength.label === 'Good',
                            'text-emerald-600': strength.label === 'Strong',
                          })}>
                            {strength.label} password
                          </p>
                        </div>
                      )}

                      {errors[field.name] && (
                        <p className="flex items-center gap-1 text-xs text-red-500 mt-1.5 font-medium">
                          <AlertCircle size={11} /> {errors[field.name]}
                        </p>
                      )}
                    </div>
                  );
                })}

                {view === 'register' && (
                  <div className="flex items-start gap-2 pt-1">
                    <input type="checkbox" id="terms" className="mt-0.5 accent-teal-600 cursor-pointer" required />
                    <label htmlFor="terms" className="text-xs text-slate-500 leading-relaxed cursor-pointer select-none">
                      I agree to the{' '}
                      <span className="text-teal-600 font-medium hover:underline">Terms of Service</span>
                      {' '}and{' '}
                      <span className="text-teal-600 font-medium hover:underline">Privacy Policy</span>
                    </label>
                  </div>
                )}

                {view === 'login' && (
                  <div className="flex items-center justify-between -mt-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={form.rememberMe === 'true'}
                        onChange={e => set('rememberMe', e.target.checked ? 'true' : 'false')}
                        className="accent-teal-600 cursor-pointer"
                      />
                      <span className="text-xs text-slate-500">Keep me signed in</span>
                    </label>
                    <button type="button" onClick={() => switchView('forgot')}
                      className="text-xs text-teal-600 font-medium hover:underline">
                      Forgot password?
                    </button>
                  </div>
                )}

                {errors._form && (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-3 text-sm text-red-700">
                    <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                    <span>{errors._form}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || success}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all mt-1',
                    loading || success
                      ? 'bg-teal-400 text-white cursor-not-allowed'
                      : 'bg-teal-600 text-white hover:bg-teal-700 active:scale-[0.98] shadow-sm shadow-teal-200'
                  )}
                >
                  {loading ? (
                    <><Loader2 size={15} className="animate-spin" /> Processing…</>
                  ) : success ? (
                    <><CheckCircle size={15} /> Done!</>
                  ) : view === 'login' ? (
                    <>Sign In <ArrowRight size={15} /></>
                  ) : (
                    <>Create Account <ArrowRight size={15} /></>
                  )}
                </button>
              </form>
              )}

              {/* ── Forgot password form ──────────────────────────────────── */}
              {view === 'forgot' && (
                <form onSubmit={handleForgot} noValidate className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                      Email Address <span className="text-red-400 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
                      <input
                        type="email"
                        placeholder="ahmed@company.pk"
                        value={form.email ?? ''}
                        onChange={e => set('email', e.target.value)}
                        className={cn(
                          'w-full pl-10 pr-4 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all bg-slate-50 focus:bg-white',
                          errors.email
                            ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                            : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
                        )}
                      />
                    </div>
                    {errors.email && (
                      <p className="flex items-center gap-1 text-xs text-red-500 mt-1.5 font-medium">
                        <AlertCircle size={11} /> {errors.email}
                      </p>
                    )}
                  </div>

                  {errors._form && (
                    <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-3 text-sm text-red-700">
                      <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                      <span>{errors._form}</span>
                    </div>
                  )}

                  <button type="submit" disabled={loading}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all mt-1',
                      loading
                        ? 'bg-teal-400 text-white cursor-not-allowed'
                        : 'bg-teal-600 text-white hover:bg-teal-700 active:scale-[0.98] shadow-sm shadow-teal-200'
                    )}
                  >
                    {loading
                      ? <><Loader2 size={15} className="animate-spin" /> Generating…</>
                      : <>Generate Reset Link <ArrowRight size={15} /></>}
                  </button>

                  <p className="text-center text-xs text-slate-400 mt-1">
                    Remember your password?{' '}
                    <button type="button" onClick={() => switchView('login')}
                      className="text-teal-600 font-semibold hover:underline">
                      Sign in
                    </button>
                  </p>
                </form>
              )}

              {/* ── Reset password form ───────────────────────────────────── */}
              {view === 'reset' && (
                <form onSubmit={handleReset} noValidate className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                      New Password <span className="text-red-400 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
                      <input
                        type={showPw ? 'text' : 'password'}
                        placeholder="Min 8 characters"
                        value={form.password ?? ''}
                        onChange={e => set('password', e.target.value)}
                        className={cn(
                          'w-full pl-10 pr-10 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all bg-slate-50 focus:bg-white',
                          errors.password
                            ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                            : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
                        )}
                      />
                      <button type="button" onClick={() => setShowPw(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                        {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {form.password && (
                      <div className="mt-2">
                        <div className="flex gap-1 mb-1">
                          {[1,2,3,4].map(i => (
                            <div key={i} className={cn('h-1 flex-1 rounded-full transition-all', i <= strength.score ? strength.color : 'bg-slate-200')} />
                          ))}
                        </div>
                        <p className={cn('text-xs font-medium', {
                          'text-red-500':     strength.label === 'Weak',
                          'text-amber-500':   strength.label === 'Fair',
                          'text-teal-600':    strength.label === 'Good',
                          'text-emerald-600': strength.label === 'Strong',
                        })}>{strength.label} password</p>
                      </div>
                    )}
                    {errors.password && (
                      <p className="flex items-center gap-1 text-xs text-red-500 mt-1.5 font-medium">
                        <AlertCircle size={11} /> {errors.password}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                      Confirm Password <span className="text-red-400 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
                      <input
                        type={showConfirmPw ? 'text' : 'password'}
                        placeholder="Re-enter password"
                        value={form.confirmPassword ?? ''}
                        onChange={e => set('confirmPassword', e.target.value)}
                        className={cn(
                          'w-full pl-10 pr-10 py-2.5 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all bg-slate-50 focus:bg-white',
                          errors.confirmPassword
                            ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                            : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
                        )}
                      />
                      <button type="button" onClick={() => setShowConfirmPw(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                        {showConfirmPw ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {errors.confirmPassword && (
                      <p className="flex items-center gap-1 text-xs text-red-500 mt-1.5 font-medium">
                        <AlertCircle size={11} /> {errors.confirmPassword}
                      </p>
                    )}
                  </div>

                  {errors._form && (
                    <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-3 text-sm text-red-700">
                      <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                      <span>{errors._form}</span>
                    </div>
                  )}

                  <button type="submit" disabled={loading || success}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all mt-1',
                      loading || success
                        ? 'bg-teal-400 text-white cursor-not-allowed'
                        : 'bg-teal-600 text-white hover:bg-teal-700 active:scale-[0.98] shadow-sm shadow-teal-200'
                    )}
                  >
                    {loading
                      ? <><Loader2 size={15} className="animate-spin" /> Saving…</>
                      : success
                      ? <><CheckCircle size={15} /> Done!</>
                      : <>Set New Password <ArrowRight size={15} /></>}
                  </button>

                  <p className="text-center text-xs text-slate-400 mt-1">
                    <button type="button" onClick={() => switchView('forgot')}
                      className="text-teal-600 font-semibold hover:underline">
                      ← Try a different email
                    </button>
                  </p>
                </form>
              )}

              {/* View toggle — login / register only */}
              {(view === 'login' || view === 'register') && (
                <p className="text-center text-xs text-slate-400 mt-5">
                  {view === 'login' ? "Don't have an account? " : 'Already have an account? '}
                  <button
                    onClick={() => switchView(view === 'login' ? 'register' : 'login')}
                    className="text-teal-600 font-semibold hover:underline"
                  >
                    {view === 'login' ? 'Register now' : 'Sign in'}
                  </button>
                </p>
              )}

              {/* Try Demo — login view only */}
              {view === 'login' && (
                <div className="mt-4">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex-1 h-px bg-slate-200" />
                    <span className="text-xs text-slate-400 font-medium whitespace-nowrap">or</span>
                    <div className="flex-1 h-px bg-slate-200" />
                  </div>
                  <button
                    type="button"
                    onClick={handleDemo}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 transition-colors disabled:opacity-60"
                  >
                    <FlaskConical size={15} className="text-amber-600" />
                    Try Demo — No sign-up needed
                  </button>
                </div>
              )}
            </div>
          </div>

          <p className="text-center text-xs text-slate-400 mt-5">
            &copy; {new Date().getFullYear()} TuneGEN · Billing and Inventory Control System
          </p>
        </div>
      </div>
    </div>
  );
}
