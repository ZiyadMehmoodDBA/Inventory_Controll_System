import { useState, useEffect } from 'react';
import {
  Car, Search, ChevronDown, CheckCircle2, XCircle,
  Loader2, AlertCircle, Award, TriangleAlert, RefreshCw,
} from 'lucide-react';
import { api } from '../api/client';

/* ── Types ────────────────────────────────────────────────────────────────── */
type FitmentRow = {
  id: number;
  category: string;
  make: string;
  model: string;
  year_from: number | null;
  year_to: number | null;
  tire_size: string;
  gtr_pattern: string | null;
  position: 'Front' | 'Rear' | null;
};

type CatalogEntry = {
  id: number;
  brand: string;
  tire_model: string;
  size: string;
  pattern: string | null;
  load_index: string | null;
  speed_index: string | null;
  tire_type: string | null;
};

/* ── Category metadata — colour, badge, vehicle illustration, education text ── */
type CategoryMeta = {
  color: string; abbr: string; border: string; text: string;
  emoji: string; desc: string; examples: string; sizes: string;
  svg: React.ReactNode;
};

/** Simple inline SVG silhouettes — no external deps, works offline */
const CarSVG = () => (
  <svg viewBox="0 0 120 60" fill="currentColor" className="w-full h-full">
    <path d="M10 38 L18 22 Q22 16 30 16 L90 16 Q98 16 102 22 L110 38 L110 44 Q110 48 106 48 L14 48 Q10 48 10 44 Z" opacity="0.15"/>
    <path d="M18 22 Q22 16 30 16 L90 16 Q98 16 102 22 L110 38 L10 38 Z" opacity="0.25"/>
    <path d="M35 16 L45 6 Q48 4 55 4 L72 4 Q78 4 82 8 L90 16 Z" opacity="0.9"/>
    <circle cx="30" cy="46" r="9" opacity="0.9"/>
    <circle cx="30" cy="46" r="5" fill="white" opacity="0.6"/>
    <circle cx="90" cy="46" r="9" opacity="0.9"/>
    <circle cx="90" cy="46" r="5" fill="white" opacity="0.6"/>
    <rect x="12" y="28" width="12" height="8" rx="2" fill="white" opacity="0.5"/>
    <rect x="96" y="28" width="12" height="8" rx="2" fill="white" opacity="0.5"/>
  </svg>
);

const SuvSVG = () => (
  <svg viewBox="0 0 120 60" fill="currentColor" className="w-full h-full">
    <path d="M8 38 L14 20 Q18 12 28 12 L92 12 Q102 12 106 20 L112 38 L112 46 Q112 50 108 50 L12 50 Q8 50 8 46 Z" opacity="0.15"/>
    <path d="M28 12 L34 4 Q37 2 44 2 L80 2 Q87 2 90 6 L96 12 Z" opacity="0.9"/>
    <path d="M14 20 Q18 12 28 12 L92 12 Q102 12 106 20 L112 38 L8 38 Z" opacity="0.3"/>
    <circle cx="30" cy="48" r="10" opacity="0.9"/>
    <circle cx="30" cy="48" r="5" fill="white" opacity="0.6"/>
    <circle cx="90" cy="48" r="10" opacity="0.9"/>
    <circle cx="90" cy="48" r="5" fill="white" opacity="0.6"/>
    <rect x="10" y="26" width="14" height="10" rx="2" fill="white" opacity="0.45"/>
    <rect x="96" y="26" width="14" height="10" rx="2" fill="white" opacity="0.45"/>
    <rect x="34" y="4" width="46" height="8" rx="1" fill="white" opacity="0.15"/>
  </svg>
);

const PickupSVG = () => (
  <svg viewBox="0 0 130 60" fill="currentColor" className="w-full h-full">
    <rect x="70" y="30" width="52" height="18" rx="3" opacity="0.25"/>
    <path d="M10 38 L16 18 Q20 10 30 10 L74 10 Q82 10 84 18 L86 38 Z" opacity="0.2"/>
    <path d="M30 10 L36 3 Q40 1 48 1 L70 1 Q76 1 78 6 L84 18 L16 18 Z" opacity="0.9"/>
    <rect x="84" y="22" width="40" height="16" rx="2" opacity="0.8"/>
    <circle cx="28" cy="48" r="10" opacity="0.9"/>
    <circle cx="28" cy="48" r="5" fill="white" opacity="0.6"/>
    <circle cx="104" cy="48" r="10" opacity="0.9"/>
    <circle cx="104" cy="48" r="5" fill="white" opacity="0.6"/>
    <rect x="12" y="25" width="14" height="10" rx="2" fill="white" opacity="0.45"/>
  </svg>
);

const TruckSVG = () => (
  <svg viewBox="0 0 140 60" fill="currentColor" className="w-full h-full">
    <rect x="6" y="14" width="38" height="34" rx="4" opacity="0.9"/>
    <rect x="44" y="8" width="88" height="40" rx="3" opacity="0.7"/>
    <rect x="8" y="18" width="16" height="12" rx="2" fill="white" opacity="0.6"/>
    <rect x="26" y="18" width="16" height="12" rx="2" fill="white" opacity="0.3"/>
    <circle cx="22" cy="50" r="9" opacity="0.9"/>
    <circle cx="22" cy="50" r="4" fill="white" opacity="0.6"/>
    <circle cx="90" cy="50" r="9" opacity="0.9"/>
    <circle cx="90" cy="50" r="4" fill="white" opacity="0.6"/>
    <circle cx="112" cy="50" r="9" opacity="0.9"/>
    <circle cx="112" cy="50" r="4" fill="white" opacity="0.6"/>
    <rect x="6" y="44" width="128" height="4" rx="1" opacity="0.4"/>
  </svg>
);

const TractorSVG = () => (
  <svg viewBox="0 0 120 65" fill="currentColor" className="w-full h-full">
    <circle cx="85" cy="46" r="18" opacity="0.9"/>
    <circle cx="85" cy="46" r="10" fill="white" opacity="0.5"/>
    <circle cx="85" cy="46" r="4" opacity="0.8"/>
    <circle cx="30" cy="52" r="12" opacity="0.85"/>
    <circle cx="30" cy="52" r="6" fill="white" opacity="0.5"/>
    <path d="M38 20 L52 10 Q58 6 66 6 L88 6 Q96 6 100 14 L104 24 L104 34 L38 34 Z" opacity="0.85"/>
    <rect x="38" y="28" width="66" height="8" rx="2" opacity="0.4"/>
    <rect x="50" y="8" width="22" height="4" rx="1" fill="white" opacity="0.3"/>
    <path d="M20 34 L38 34 L38 44 L18 44 Z" opacity="0.6"/>
    <rect x="100" y="14" width="14" height="6" rx="2" opacity="0.5"/>
  </svg>
);

const MotorcycleSVG = () => (
  <svg viewBox="0 0 110 60" fill="currentColor" className="w-full h-full">
    <circle cx="20" cy="44" r="14" opacity="0.9"/>
    <circle cx="20" cy="44" r="8" fill="white" opacity="0.5"/>
    <circle cx="90" cy="44" r="14" opacity="0.9"/>
    <circle cx="90" cy="44" r="8" fill="white" opacity="0.5"/>
    <path d="M20 44 L40 28 L58 24 L70 30 L90 44" stroke="currentColor" strokeWidth="5" fill="none" opacity="0.85"/>
    <path d="M58 24 L62 14 L72 12 L74 18 L64 22 Z" opacity="0.9"/>
    <path d="M38 28 L44 20 L54 20 L54 28 Z" opacity="0.7"/>
    <circle cx="62" cy="18" r="3" fill="white" opacity="0.6"/>
    <path d="M88 30 L96 24 L102 26 L96 34 Z" opacity="0.8"/>
  </svg>
);

const CATEGORY_META: Record<string, CategoryMeta> = {
  'Passenger Car Tyres': {
    color: 'bg-blue-600', abbr: 'PCR', border: 'border-blue-200', text: 'text-blue-700',
    emoji: '🚗',
    desc: 'Sedans, hatchbacks & saloon cars',
    examples: 'Toyota Corolla, Honda City, Suzuki Alto, Kia Picanto, Hyundai Elantra',
    sizes: '145/80R12 – 205/65R15',
    svg: <CarSVG />,
  },
  'SUV/Crossovers Tyres': {
    color: 'bg-emerald-600', abbr: 'SUV', border: 'border-emerald-200', text: 'text-emerald-700',
    emoji: '🚙',
    desc: '4×4s, crossovers & sport utility vehicles',
    examples: 'Toyota Fortuner, Kia Sportage, Honda BR-V, Hyundai Tucson, Toyota Land Cruiser',
    sizes: '215/65R16 – 265/65R17',
    svg: <SuvSVG />,
  },
  'Light Truck Tyres': {
    color: 'bg-amber-600', abbr: 'LT', border: 'border-amber-200', text: 'text-amber-700',
    emoji: '🛻',
    desc: 'Pickup trucks & light commercial vans',
    examples: 'Toyota Hilux, Isuzu D-Max, Suzuki Ravi, Mazda BT-50, KIA Frontier',
    sizes: '195R14C – 265/70R16',
    svg: <PickupSVG />,
  },
  'Truck & Bus/OTR Tyres': {
    color: 'bg-orange-700', abbr: 'TBR', border: 'border-orange-200', text: 'text-orange-700',
    emoji: '🚛',
    desc: 'Heavy trucks, buses & off-road vehicles',
    examples: 'Hino, Isuzu NQR, FAW, Daewoo Bus, Sinotruk, Volvo',
    sizes: '7.50R16 – 11R22.5',
    svg: <TruckSVG />,
  },
  'Tractor Tyres': {
    color: 'bg-lime-700', abbr: 'AGR', border: 'border-lime-200', text: 'text-lime-700',
    emoji: '🚜',
    desc: 'Agricultural tractors & farm machinery',
    examples: 'Massey Ferguson, New Holland, Fiat, Millat Tractors, Al-Ghazi',
    sizes: '6.00-16 – 18.4-30',
    svg: <TractorSVG />,
  },
  'Motorcycle/Rickshaw Tyres': {
    color: 'bg-purple-600', abbr: 'MCY', border: 'border-purple-200', text: 'text-purple-700',
    emoji: '🏍️',
    desc: 'Motorbikes, scooters & auto-rickshaws',
    examples: 'Honda 125, Yamaha YBR, Sazgar Rickshaw, Ravi Loader, Road Prince',
    sizes: '2.50-17 – 4.00-8',
    svg: <MotorcycleSVG />,
  },
};

/* ── Vehicle → Tyre Type mapping (source: tyres-online.pk) ───────────────── */
type VehicleTyreInfo = {
  vehicleLabel: string;
  /** Usage/season types from tyres-online.pk */
  usageTypes: string[];
  /** tire_type values stored in tire_catalog DB */
  dbTypes: string[];
};

const VEHICLE_TYRE_TYPES: Record<string, VehicleTyreInfo> = {
  'Passenger Car Tyres': {
    vehicleLabel: 'Passenger Car',
    usageTypes: ['Summer', 'Winter', 'All-Season', 'Performance', 'Touring', 'Run-Flat'],
    dbTypes: ['Passenger', 'Performance'],
  },
  'SUV/Crossovers Tyres': {
    vehicleLabel: 'SUV / Crossover',
    usageTypes: ['All-Terrain', 'Highway Terrain', 'Mud Terrain', 'All-Season', 'Sport'],
    dbTypes: ['SUV', '4x4', 'Performance'],
  },
  'Light Truck Tyres': {
    vehicleLabel: 'Light Truck',
    usageTypes: ['Highway Terrain', 'All-Terrain', 'Commercial', 'All-Season'],
    dbTypes: ['LT', '4x4', 'Van'],
  },
  'Truck & Bus/OTR Tyres': {
    vehicleLabel: 'Truck / Bus / OTR',
    usageTypes: ['Long Haul', 'Regional', 'All-Season', 'Mixed Service', 'Off-Road'],
    dbTypes: ['Truck', 'OTR'],
  },
  'Tractor Tyres': {
    vehicleLabel: 'Agricultural',
    usageTypes: ['Ribbed Front', 'Traction Rear', 'Implement', 'Float'],
    dbTypes: ['Agricultural'],
  },
  'Motorcycle/Rickshaw Tyres': {
    vehicleLabel: 'Motorcycle / Rickshaw',
    usageTypes: ['Sport', 'Touring', 'Enduro', 'Scooter', 'Motocross', 'Chopper'],
    dbTypes: ['Motorcycle', 'Rickshaw'],
  },
};

/** Colour classes per DB tire_type value */
const TIRE_TYPE_STYLE: Record<string, string> = {
  Passenger:   'bg-blue-50 text-blue-700 border-blue-200',
  Performance: 'bg-red-50 text-red-700 border-red-200',
  SUV:         'bg-emerald-50 text-emerald-700 border-emerald-200',
  '4x4':       'bg-emerald-50 text-emerald-700 border-emerald-200',
  LT:          'bg-amber-50 text-amber-700 border-amber-200',
  Van:         'bg-amber-50 text-amber-700 border-amber-200',
  Truck:       'bg-orange-50 text-orange-700 border-orange-200',
  OTR:         'bg-orange-50 text-orange-700 border-orange-200',
  Agricultural:'bg-lime-50 text-lime-700 border-lime-200',
  Motorcycle:  'bg-purple-50 text-purple-700 border-purple-200',
  Rickshaw:    'bg-purple-50 text-purple-700 border-purple-200',
};

/* ── Sub-components ───────────────────────────────────────────────────────── */
function Select({
  value, onChange, options, placeholder, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full appearance-none border rounded-xl py-2.5 pl-3 pr-8 text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors ${
          disabled
            ? 'border-slate-200 bg-slate-50 text-slate-300 cursor-not-allowed'
            : 'border-slate-300 text-slate-800 cursor-pointer hover:border-slate-400'
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
    </div>
  );
}

function YearBadge({ row }: { row: FitmentRow }) {
  if (!row.year_from) return <span className="text-slate-400 text-xs">—</span>;
  return (
    <span className="text-slate-600 text-xs whitespace-nowrap">
      {row.year_from}–{row.year_to ?? 'present'}
    </span>
  );
}

function SizeBadge({ size }: { size: string }) {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-teal-50 text-teal-700 text-xs font-bold border border-teal-200 whitespace-nowrap tracking-wide">
      {size}
    </span>
  );
}

function PositionBadge({ position }: { position: 'Front' | 'Rear' | null }) {
  if (!position) return null;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
      position === 'Front' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'
    }`}>
      {position === 'Front' ? 'F' : 'R'}
    </span>
  );
}

function GtrBadge({ pattern }: { pattern: string | null }) {
  if (!pattern) return <span className="text-slate-300 text-xs italic">—</span>;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-semibold whitespace-nowrap">
      <Award size={10} />
      {pattern}
    </span>
  );
}

/** Shows the vehicle type label derived from category */
function VehicleTypeBadge({ category }: { category: string }) {
  const info = VEHICLE_TYRE_TYPES[category];
  const meta = CATEGORY_META[category];
  if (!info || !meta) return <span className="text-slate-300 text-xs">—</span>;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[10px] font-bold whitespace-nowrap ${meta.text} ${meta.border} bg-white`}>
      {info.vehicleLabel}
    </span>
  );
}

/** Shows usage tyre types applicable for the vehicle category (from tyres-online.pk) */
function TyreTypesPills({ category }: { category: string }) {
  const info = VEHICLE_TYRE_TYPES[category];
  if (!info) return <span className="text-slate-300 text-xs">—</span>;
  const SHOW = 3;
  const visible = info.usageTypes.slice(0, SHOW);
  const hidden  = info.usageTypes.slice(SHOW);
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {visible.map(t => (
        <span key={t} className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-medium border border-slate-200 whitespace-nowrap">
          {t}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.join(', ')}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-50 text-slate-400 text-[10px] font-medium border border-slate-200 cursor-default whitespace-nowrap"
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}

function CatalogBadges({ entries }: { entries: CatalogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 5;

  if (entries.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-300">
        <XCircle size={12} /> Not in catalogue
      </span>
    );
  }

  const visible = expanded ? entries : entries.slice(0, LIMIT);
  const hidden  = entries.length - LIMIT;

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {visible.map(c => {
        const typeStyle = c.tire_type ? (TIRE_TYPE_STYLE[c.tire_type] ?? 'bg-slate-50 text-slate-500 border-slate-200') : null;
        return (
          <span
            key={c.id}
            title={[
              c.load_index  && `LI: ${c.load_index}`,
              c.speed_index && `SI: ${c.speed_index}`,
            ].filter(Boolean).join(' | ')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-xs font-medium cursor-default"
          >
            <CheckCircle2 size={10} />
            {c.brand} — {c.tire_model}
            {typeStyle && (
              <span className={`ml-1 px-1.5 py-px rounded text-[9px] font-bold border ${typeStyle}`}>
                {c.tire_type}
              </span>
            )}
          </span>
        );
      })}
      {!expanded && hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="inline-flex items-center px-2 py-0.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-500 text-xs font-medium hover:bg-slate-200 transition-colors cursor-pointer"
        >
          +{hidden} more
        </button>
      )}
      {expanded && entries.length > LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="inline-flex items-center px-2 py-0.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-500 text-xs font-medium hover:bg-slate-200 transition-colors cursor-pointer"
        >
          show less
        </button>
      )}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────────────────── */
export function FitmentSearch() {
  const [categories,    setCategories]    = useState<string[]>([]);
  const [catsLoading,   setCatsLoading]   = useState(true);
  const [catsError,     setCatsError]     = useState('');
  const [makes,         setMakes]         = useState<string[]>([]);
  const [models,        setModels]        = useState<string[]>([]);

  const [selCategory, setSelCategory] = useState('');
  const [selMake,     setSelMake]     = useState('');
  const [selModel,    setSelModel]    = useState('');

  const [loading,  setLoading]  = useState(false);
  const [searched, setSearched] = useState(false);
  const [error,    setError]    = useState('');
  const [fitments, setFitments] = useState<FitmentRow[]>([]);
  const [matches,  setMatches]  = useState<Record<string, CatalogEntry[]>>({});

  // Boot: load categories
  const loadCategories = () => {
    setCatsLoading(true);
    setCatsError('');
    api.fitments.categories()
      .then(data => {
        setCategories(data);
        if (data.length === 0) setCatsError('no_data');
      })
      .catch(() => setCatsError('api_error'))
      .finally(() => setCatsLoading(false));
  };

  useEffect(() => { loadCategories(); }, []);

  // Category change → reload makes
  useEffect(() => {
    setSelMake(''); setSelModel(''); setMakes([]); setModels([]);
    api.fitments.makes(selCategory || undefined).then(setMakes).catch(() => {});
  }, [selCategory]);

  // Make change → reload models
  useEffect(() => {
    setSelModel(''); setModels([]);
    if (!selMake) return;
    api.fitments.models(selMake, selCategory || undefined).then(setModels).catch(() => {});
  }, [selMake, selCategory]);

  const handleSearch = async () => {
    if (!selMake && !selModel) { setError('Please select at least a Make.'); return; }
    setError(''); setLoading(true); setSearched(false);
    try {
      const result = await api.fitments.search({
        make:     selMake     || undefined,
        model:    selModel    || undefined,
        category: selCategory || undefined,
      });
      setFitments(result.fitments);
      setMatches(result.catalogMatches);
      setSearched(true);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  /* ── Group results by make → model (for tractor/moto with Front/Rear pairs) */
  const grouped = fitments.reduce<Record<string, FitmentRow[]>>((acc, f) => {
    const key = `${f.make}|||${f.model}`;
    (acc[key] ??= []).push(f);
    return acc;
  }, {});

  const catMeta = selCategory ? CATEGORY_META[selCategory] : null;

  const hasPosition = fitments.some(f => f.position !== null);
  const totalResults = fitments.length;
  const catalogHits  = fitments.filter(f => (matches[f.tire_size] ?? []).length > 0).length;

  return (
    <div className="space-y-5" onKeyDown={handleKeyDown}>

      {/* ── Header banner ──────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-br from-red-700 via-red-600 to-red-500 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-red-200 mb-0.5">GTR Tyre Fitment Guide</p>
            <h2 className="text-lg font-black tracking-tight leading-tight">
              Find the Right Tyre for Any Vehicle
            </h2>
            <p className="text-red-100 text-xs mt-1">
              Pakistan-market OEM fitment · 130+ vehicle models · cross-referenced with your GTR catalogue
            </p>
          </div>
          <div className="hidden sm:flex gap-2">
            {Object.entries(CATEGORY_META).map(([cat, meta]) => (
              <span
                key={cat}
                title={cat}
                className={`${meta.color} text-white text-[9px] font-bold px-2 py-1 rounded-lg opacity-80`}
              >
                {meta.abbr}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-slate-900 px-5 py-3">
          <p className="text-xs font-bold text-slate-300 uppercase tracking-widest">Select Tyre</p>
        </div>
        <div className="p-4 sm:p-5">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                Tyre Category
              </label>
              <Select
                value={selCategory}
                onChange={setSelCategory}
                options={categories}
                placeholder="All Categories"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                Make
              </label>
              <Select
                value={selMake}
                onChange={setSelMake}
                options={makes}
                placeholder="Select Make"
                disabled={makes.length === 0}
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                Model / Type
              </label>
              <Select
                value={selModel}
                onChange={setSelModel}
                options={models}
                placeholder="Select Model"
                disabled={models.length === 0}
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={loading || (!selMake && !selModel)}
              className="flex items-center justify-center gap-2 px-5 py-2.5 bg-red-600 text-white text-sm font-bold rounded-xl hover:bg-red-700 active:bg-red-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {loading
                ? <Loader2 size={15} className="animate-spin" />
                : <Search size={15} />
              }
              Search
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <AlertCircle size={13} /> {error}
            </div>
          )}
        </div>
      </div>

      {/* ── Results ────────────────────────────────────────────────────── */}
      {searched && (
        fitments.length === 0 ? (
          <div className="text-center py-16">
            <XCircle size={32} className="mx-auto mb-3 text-slate-200" />
            <p className="text-slate-400 text-sm">No fitment data found for the selected vehicle.</p>
            <p className="text-slate-300 text-xs mt-1">Try broadening your selection.</p>
          </div>
        ) : (
          <div className="space-y-4">

            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-3 px-1">
              <span className="text-xs text-slate-500">
                <span className="font-bold text-slate-800">{totalResults}</span> fitment{totalResults !== 1 ? 's' : ''}
              </span>
              {catMeta && (
                <span className={`${catMeta.color} text-white text-[10px] font-bold px-2 py-0.5 rounded-lg`}>
                  {selCategory}
                </span>
              )}
              {catalogHits > 0 && (
                <span className="text-xs text-green-600 font-semibold flex items-center gap-1">
                  <CheckCircle2 size={12} /> {catalogHits} size{catalogHits !== 1 ? 's' : ''} matched in your GTR catalogue
                </span>
              )}
              {catalogHits < totalResults && (
                <span className="text-xs text-amber-600 flex items-center gap-1">
                  <TriangleAlert size={12} /> {totalResults - catalogHits} not yet in catalogue
                </span>
              )}
            </div>

            {/* Results grouped by make+model */}
            {Object.entries(grouped).map(([groupKey, rows]) => {
              const [make, model] = groupKey.split('|||');
              const catKey = rows[0].category;
              const meta   = CATEGORY_META[catKey] ?? { color: 'bg-slate-700', abbr: '—' };

              return (
                <div key={groupKey} className="border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  {/* Group header */}
                  <div className="flex items-center gap-3 bg-slate-900 text-white px-4 py-3">
                    <Car size={15} className="text-slate-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-bold text-sm">{make}</span>
                      <span className="text-slate-400 text-sm ml-2">{model}</span>
                    </div>
                    <span className={`${meta.color} text-white text-[9px] font-bold px-2 py-0.5 rounded-lg flex-shrink-0`}>
                      {meta.abbr}
                    </span>
                  </div>

                  {/* Fitment table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                            Years
                          </th>
                          {hasPosition && (
                            <th className="px-3 py-2 text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wide w-12">
                              Pos.
                            </th>
                          )}
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                            OEM Size
                          </th>
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                            Vehicle Type
                          </th>
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-indigo-500 uppercase tracking-wide whitespace-nowrap">
                            Tyre Types
                          </th>
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-red-500 uppercase tracking-wide">
                            GTR Recommended
                          </th>
                          <th className="px-4 py-2 text-left text-[10px] font-semibold text-green-600 uppercase tracking-wide">
                            Catalogue Match
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(f => {
                          const catalogEntries = matches[f.tire_size] ?? [];
                          const gtrInCatalog   = catalogEntries.some(
                            c => f.gtr_pattern && (
                              c.pattern?.toLowerCase().includes(f.gtr_pattern.toLowerCase()) ||
                              c.tire_model?.toLowerCase().includes(f.gtr_pattern.toLowerCase())
                            )
                          );

                          return (
                            <tr
                              key={f.id}
                              className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70 transition-colors"
                            >
                              <td className="px-4 py-3">
                                <YearBadge row={f} />
                              </td>
                              {hasPosition && (
                                <td className="px-3 py-3 text-center">
                                  <PositionBadge position={f.position} />
                                </td>
                              )}
                              <td className="px-4 py-3">
                                <SizeBadge size={f.tire_size} />
                              </td>
                              <td className="px-4 py-3">
                                <VehicleTypeBadge category={f.category} />
                              </td>
                              <td className="px-4 py-3">
                                <TyreTypesPills category={f.category} />
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
                                  <GtrBadge pattern={f.gtr_pattern} />
                                  {f.gtr_pattern && gtrInCatalog && (
                                    <span title="This GTR pattern is in your catalogue" className="text-green-500">
                                      <CheckCircle2 size={12} />
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <CatalogBadges entries={catalogEntries} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── Empty / error state (before first search) ──────────────── */}
      {!searched && !loading && (
        <div className="select-none">
          {/* Server not started or API error */}
          {catsError && (
            <div className="mb-6 inline-block text-left bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 max-w-md">
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-amber-800">
                    {catsError === 'api_error'
                      ? 'Fitment API unavailable'
                      : 'No fitment data found'}
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    {catsError === 'api_error'
                      ? 'The backend server may need to be restarted. Run the server once to create the vehicle_fitments table and seed Pakistan-market data.'
                      : 'The vehicle_fitments table is empty. Restart the backend server to trigger the seed.'}
                  </p>
                  <button
                    onClick={loadCategories}
                    disabled={catsLoading}
                    className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-amber-800 hover:text-amber-900 transition-colors"
                  >
                    {catsLoading
                      ? <Loader2 size={12} className="animate-spin" />
                      : <RefreshCw size={12} />}
                    Retry
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Loading state */}
          {catsLoading && (
            <div className="flex justify-center py-14">
              <Loader2 size={28} className="text-slate-300 animate-spin" />
            </div>
          )}

          {/* Normal idle state — vehicle category education cards */}
          {!catsError && !catsLoading && (
            <div className="text-left">
              <p className="text-center text-slate-400 text-sm font-medium mb-1">
                Select your vehicle category to get started
              </p>
              <p className="text-center text-slate-300 text-xs mb-6">
                Click a card to pre-fill the category, then choose your make and model
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(categories.length > 0 ? categories : Object.keys(CATEGORY_META)).map(cat => {
                  const m = CATEGORY_META[cat];
                  if (!m) return null;
                  return (
                    <button
                      key={cat}
                      onClick={() => setSelCategory(cat)}
                      className={`group text-left border-2 ${m.border} rounded-2xl overflow-hidden hover:shadow-md transition-all hover:-translate-y-0.5 bg-white`}
                    >
                      {/* Vehicle illustration */}
                      <div className={`${m.color} bg-opacity-10 px-6 pt-5 pb-3 flex items-center justify-center`}
                           style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.04) 0%, rgba(0,0,0,0.01) 100%)' }}>
                        <div className={`w-32 h-16 ${m.text} opacity-80 group-hover:opacity-100 transition-opacity`}>
                          {m.svg}
                        </div>
                      </div>

                      {/* Card body */}
                      <div className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`${m.color} text-white text-[9px] font-black px-1.5 py-0.5 rounded-md tracking-wider`}>
                            {m.abbr}
                          </span>
                          <span className="text-xs font-bold text-slate-800 leading-tight">{cat}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mb-2">{m.desc}</p>

                        <div className="space-y-1">
                          <div>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Examples</span>
                            <p className="text-[10px] text-slate-600 leading-snug">{m.examples}</p>
                          </div>
                          <div>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Typical sizes</span>
                            <p className={`text-[10px] font-mono font-semibold ${m.text}`}>{m.sizes}</p>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      <div className={`${m.color} bg-opacity-5 px-4 py-2 border-t ${m.border} flex items-center justify-between`}
                           style={{ background: 'rgba(0,0,0,0.02)' }}>
                        <span className="text-[10px] font-semibold text-slate-400 group-hover:text-slate-600 transition-colors">
                          Click to select →
                        </span>
                        <span className="text-[9px] text-slate-300">{m.emoji}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
