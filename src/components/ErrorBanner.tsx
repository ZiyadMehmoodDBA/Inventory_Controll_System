import { AlertCircle } from 'lucide-react';

interface Props {
  error: string;
  className?: string;
}

export default function ErrorBanner({ error, className = '' }: Props) {
  if (!error) return null;
  return (
    <div className={`flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 ${className}`}>
      <AlertCircle size={15} className="flex-shrink-0" />
      <span>{error}</span>
    </div>
  );
}
