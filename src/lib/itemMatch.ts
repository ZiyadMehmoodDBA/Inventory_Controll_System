// Match typed line-item specs against inventory. Tyre shops key on brand + size (model optional);
// other businesses key on the item name (stored in `model`) with brand / size as optional narrowing.
interface Spec { brand: string; model: string; size: string }
interface Stocked { brand?: string | null; model?: string | null; size?: string | null }

const norm = (v?: string | null) => (v ?? '').toLowerCase().trim();

export function matchItem<T extends Stocked>(items: T[], spec: Spec, tyre: boolean): T | undefined {
  const brand = norm(spec.brand), model = norm(spec.model), size = norm(spec.size);
  if (tyre) {
    return items.find(t => norm(t.brand) === brand && norm(t.size) === size && (!model || norm(t.model) === model));
  }
  if (!model) return undefined;
  return items.find(t => norm(t.model) === model && (!brand || norm(t.brand) === brand) && (!size || norm(t.size) === size));
}

export const joinName = (...parts: (string | null | undefined)[]) => parts.map(p => (p ?? '').trim()).filter(Boolean).join(' ');
