import { cn } from '../lib/utils';

interface StatCardProps {
  title: string;
  value: string;
  change?: string;
  changeType?: 'up' | 'down' | 'neutral';
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}

export default function StatCard({ title, value, change, changeType, icon: Icon, iconColor, iconBg }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl sm:rounded-2xl p-3 sm:p-5 shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs sm:text-sm font-medium text-slate-500 truncate">{title}</p>
          <p className="text-lg sm:text-2xl font-bold text-slate-900 mt-0.5 sm:mt-1 truncate">{value}</p>
          {change && (
            <p className={cn(
              'text-xs font-medium mt-1 sm:mt-1.5 flex items-center gap-1 truncate',
              changeType === 'up' && 'text-emerald-600',
              changeType === 'down' && 'text-red-500',
              changeType === 'neutral' && 'text-slate-500'
            )}>
              {changeType === 'up' && '↑'}
              {changeType === 'down' && '↓'}
              <span className="truncate">{change}</span>
            </p>
          )}
        </div>
        <div className={cn('p-2 sm:p-3 rounded-lg sm:rounded-xl flex-shrink-0', iconBg)}>
          <Icon size={16} className={cn(iconColor, 'sm:hidden')} />
          <Icon size={22} className={cn(iconColor, 'hidden sm:block')} />
        </div>
      </div>
    </div>
  );
}
