interface Props {
  rows?: number;
  rowHeight?: string;
}

export default function TableSkeleton({ rows = 5, rowHeight = 'h-12' }: Props) {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`${rowHeight} bg-slate-100 rounded-lg animate-pulse`} />
      ))}
    </div>
  );
}
