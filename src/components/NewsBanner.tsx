import { useState } from 'react';
import { X, Megaphone } from 'lucide-react';

interface NewsBannerProps {
  message: string;
}

export default function NewsBanner({ message }: NewsBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !message.trim()) return null;

  return (
    <div className="relative flex items-center gap-3 bg-gradient-to-r from-teal-600 to-cyan-500 px-4 py-2.5 text-white text-sm z-50 flex-shrink-0">
      <Megaphone size={15} className="flex-shrink-0 opacity-90" />

      {/* Scrolling ticker if text is long, else static */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {message.length > 80 ? (
          <div className="whitespace-nowrap animate-marquee font-medium text-xs sm:text-sm text-white/95">
            {message}&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;{message}
          </div>
        ) : (
          <p className="font-medium text-xs sm:text-sm text-white/95 truncate">{message}</p>
        )}
      </div>

      <button
        onClick={() => setDismissed(true)}
        className="flex-shrink-0 p-1 hover:bg-white/20 rounded-lg transition-colors ml-2"
        aria-label="Dismiss announcement"
      >
        <X size={14} />
      </button>
    </div>
  );
}
