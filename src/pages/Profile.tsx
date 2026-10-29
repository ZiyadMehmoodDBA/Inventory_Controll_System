import { useState, useEffect } from 'react';
import {
  ArrowLeft, User, Mail, Phone, MapPin, Briefcase, Building2,
  GitBranch, Calendar, Loader2, CheckCircle, KeyRound, Save,
} from 'lucide-react';
import ErrorBanner from '../components/ErrorBanner';
import { api } from '../api/client';
import ChangePasswordModal from '../components/ChangePasswordModal';

interface Props {
  onBack: () => void;
  onUpdated: (name: string) => void;
}

const ROLE_LABELS: Record<string, string> = {
  org_admin:      'Organization Admin',
  branch_manager: 'Branch Manager',
  staff:          'Staff',
};

const ROLE_COLORS: Record<string, string> = {
  org_admin:      'bg-teal-100 text-teal-700 border-teal-200',
  branch_manager: 'bg-teal-100 text-teal-700 border-teal-200',
  staff:          'bg-slate-100 text-slate-600 border-slate-200',
};

const RELATION_OPTIONS = [
  'Spouse', 'Parent', 'Sibling', 'Child', 'Partner', 'Guardian', 'Friend', 'Colleague', 'Other',
];

function InfoRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
        <Icon size={14} className="text-slate-500" />
      </div>
      <div>
        <p className="text-xs text-slate-400 font-medium">{label}</p>
        <p className="text-sm text-slate-800 font-medium mt-0.5">{value}</p>
      </div>
    </div>
  );
}

export default function Profile({ onBack, onUpdated }: Props) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState('');
  const [showCP,  setShowCP]  = useState(false);

  // Form state
  const [name,      setName]      = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [phone,     setPhone]     = useState('');
  const [dob,       setDob]       = useState('');
  const [address,   setAddress]   = useState('');
  const [jobTitle,  setJobTitle]  = useState('');
  const [dept,      setDept]      = useState('');
  const [ecName,    setEcName]    = useState('');
  const [ecPhone,   setEcPhone]   = useState('');
  const [ecRel,     setEcRel]     = useState('');

  useEffect(() => {
    api.profile.get()
      .then(data => {
        setProfile(data);
        setName(data.name || '');
        setFirstName(data.first_name || '');
        setLastName(data.last_name  || '');
        setPhone(data.phone         || '');
        setDob(data.date_of_birth
          ? new Date(data.date_of_birth).toISOString().split('T')[0]
          : '');
        setAddress(data.address     || '');
        setJobTitle(data.job_title  || '');
        setDept(data.department     || '');
        setEcName(data.emergency_contact_name     || '');
        setEcPhone(data.emergency_contact_phone   || '');
        setEcRel(data.emergency_contact_relation  || '');
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Display name is required');
    setError('');
    setSaving(true);
    try {
      const updated = await api.profile.update({
        name:        name.trim(),
        first_name:  firstName.trim() || undefined,
        last_name:   lastName.trim()  || undefined,
        phone:       phone.trim()     || undefined,
        address:     address.trim()   || undefined,
        job_title:   jobTitle.trim()  || undefined,
        department:  dept.trim()      || undefined,
        date_of_birth: dob            || undefined,
        emergency_contact_name:     ecName.trim()  || undefined,
        emergency_contact_phone:    ecPhone.trim() || undefined,
        emergency_contact_relation: ecRel          || undefined,
      });
      setProfile((p: any) => ({ ...p, ...updated }));
      onUpdated(updated.name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err.message || 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const initials = name
    ? name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()
    : '?';

  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
    : '';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Back button */}
        <button onClick={onBack}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 font-medium transition-colors group">
          <ArrowLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" />
          Back
        </button>

        <ErrorBanner error={error} />

        <form onSubmit={handleSave} className="space-y-5">

          {/* ── Profile header card ── */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* Avatar */}
              <div className="w-20 h-20 rounded-2xl bg-teal-500 flex items-center justify-center text-white font-bold text-2xl ring-4 ring-teal-100 shrink-0">
                {initials}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h1 className="text-xl font-bold text-slate-900">{profile?.name}</h1>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                    ROLE_COLORS[profile?.role] ?? 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}>
                    {ROLE_LABELS[profile?.role] ?? profile?.role}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <Mail size={13} /> {profile?.email}
                  </span>
                  {profile?.organization_name && (
                    <span className="flex items-center gap-1.5">
                      <Building2 size={13} /> {profile.organization_name}
                    </span>
                  )}
                  {profile?.branch_name && (
                    <span className="flex items-center gap-1.5">
                      <GitBranch size={13} /> {profile.branch_name}
                    </span>
                  )}
                </div>
                {memberSince && (
                  <p className="text-xs text-slate-400 mt-1.5 flex items-center gap-1">
                    <Calendar size={11} /> Member since {memberSince}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── Personal Information ── */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <User size={16} className="text-teal-600" />
              <h2 className="text-sm font-bold text-slate-900">Personal Information</h2>
            </div>

            {/* First / Last name */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">First Name</label>
                <input value={firstName} onChange={e => setFirstName(e.target.value)}
                  placeholder="e.g. Ziyad"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Last Name</label>
                <input value={lastName} onChange={e => setLastName(e.target.value)}
                  placeholder="e.g. Mehmood"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            {/* Display name */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Display Name <span className="text-red-500">*</span>
                <span className="text-slate-400 font-normal ml-1">— shown throughout the app</span>
              </label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Your full name as shown in the app"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                required />
            </div>

            {/* Phone / DOB */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  <span className="flex items-center gap-1"><Phone size={11} /> Phone</span>
                </label>
                <input value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="+92 300 0000000" type="tel"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  <span className="flex items-center gap-1"><Calendar size={11} /> Date of Birth <span className="text-slate-400 font-normal">(opt)</span></span>
                </label>
                <input value={dob} onChange={e => setDob(e.target.value)}
                  type="date"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                <span className="flex items-center gap-1"><MapPin size={11} /> Address <span className="text-slate-400 font-normal">(opt)</span></span>
              </label>
              <textarea value={address} onChange={e => setAddress(e.target.value)}
                rows={2}
                placeholder="Street, City, Country"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none" />
            </div>
          </div>

          {/* ── Work Information ── */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Briefcase size={16} className="text-teal-600" />
              <h2 className="text-sm font-bold text-slate-900">Work Information</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Job Title <span className="text-slate-400 font-normal">(opt)</span>
                </label>
                <input value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                  placeholder="e.g. Store Manager"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Department <span className="text-slate-400 font-normal">(opt)</span>
                </label>
                <input value={dept} onChange={e => setDept(e.target.value)}
                  placeholder="e.g. Operations"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            {/* Read-only org info */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
              <InfoRow icon={Building2}  label="Organization" value={profile?.organization_name || ''} />
              <InfoRow icon={GitBranch}  label="Branch"       value={profile?.branch_name || 'All Branches'} />
              <InfoRow icon={User}       label="Account Type" value={ROLE_LABELS[profile?.role] ?? profile?.role ?? ''} />
            </div>
          </div>

          {/* ── Emergency Contact ── */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Phone size={16} className="text-teal-600" />
              <h2 className="text-sm font-bold text-slate-900">Emergency Contact</h2>
              <span className="text-xs text-slate-400 font-normal">(optional)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Contact Name</label>
                <input value={ecName} onChange={e => setEcName(e.target.value)}
                  placeholder="Full name"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Relationship</label>
                <select value={ecRel} onChange={e => setEcRel(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                  <option value="">Select relationship...</option>
                  {RELATION_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Contact Phone</label>
              <input value={ecPhone} onChange={e => setEcPhone(e.target.value)}
                placeholder="+92 300 0000000" type="tel"
                className="w-full sm:w-72 text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
            </div>
          </div>

          {/* ── Security ── */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <KeyRound size={16} className="text-teal-600" />
              <h2 className="text-sm font-bold text-slate-900">Security</h2>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-800">Password</p>
                <p className="text-xs text-slate-400 mt-0.5">Keep your account secure with a strong password</p>
              </div>
              <button type="button" onClick={() => setShowCP(true)}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded-xl hover:bg-teal-100 transition-colors">
                <KeyRound size={14} />
                Change Password
              </button>
            </div>
          </div>

          {/* ── Save button ── */}
          <div className="flex items-center justify-end gap-3 pb-6">
            {saved && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium">
                <CheckCircle size={15} /> Profile saved
              </span>
            )}
            <button type="button" onClick={onBack}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-36 justify-center">
              {saving
                ? <><Loader2 size={15} className="animate-spin" /> Saving...</>
                : <><Save size={15} /> Save Profile</>
              }
            </button>
          </div>

        </form>
      </div>

      {showCP && <ChangePasswordModal onClose={() => setShowCP(false)} />}
    </>
  );
}
