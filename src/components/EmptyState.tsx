import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  message: string;
  subtitle?: string;
  className?: string;
}

export default function EmptyState({ icon: Icon, message, subtitle, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 text-slate-400 gap-2 ${className}`}>
      {Icon && (
        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center mb-1">
          <Icon size={18} className="text-slate-300" />
        </div>
      )}
      <p className="text-sm">{message}</p>
      {subtitle && <p className="text-xs">{subtitle}</p>}
    </div>
  );
}
