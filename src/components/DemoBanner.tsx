import { FlaskConical, LogOut } from 'lucide-react';

interface Props {
  onExit: () => void;
}

export default function DemoBanner({ onExit }: Props) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <FlaskConical size={15} className="text-amber-600 flex-shrink-0" />
        <span className="text-sm font-semibold text-amber-900">Demo Mode</span>
        <span className="hidden sm:inline text-xs text-amber-700 truncate">
          — Exploring with sample data. Creates are sandboxed and reset every 30 min. Deletes &amp; admin actions are disabled.
        </span>
      </div>
      <button
        onClick={onExit}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 rounded-lg transition-colors flex-shrink-0"
      >
        <LogOut size={12} />
        Exit Demo
      </button>
    </div>
  );
}
