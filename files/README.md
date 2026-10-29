# GTR / TuneGEN — Seed Data Files

This bundle contains everything needed to power a Category → Make → Model tyre
search dropdown (like the one on www.gtr.com.pk) inside your TuneGEN app.

## Files

- **`gtr-catalogue.json`** — The official GTR product catalogue, extracted from
  the May 2025 master catalogue PDF. 60+ products across 6 categories with
  sizes, speed/load indexes, ply ratings, and descriptions.
- **`vehicle-fitment.json`** — A Pakistan-market vehicle fitment table:
  Category → Make → Model → recommended tyre size + recommended GTR product.
  Built from general knowledge of the Pakistani auto market plus the catalogue's
  own vehicle hints (e.g. Euro Kompact for Suzuki Mehran/Alto/Daihatsu Cuore,
  BG Vano Plus for Toyota Hi-Ace, AGRI TRAC for MF/Fiat tractors). This is a
  reasonable starting point — verify and refine per actual stock.
- **`gtr-catalogue-data.xlsx`** — Same data in 5 review-friendly sheets:
  1. Categories
  2. GTR Products (one row per SKU/size)
  3. Vehicle Fitment (one row per make/model)
  4. Dropdown: Category → Make
  5. Dropdown: Make → Model

## How to use in TuneGEN

### 1. Seed the database

In `prisma/seed.ts` (or your seed script), import both JSON files and create:
- Categories from `gtr-catalogue.categories`
- Products from `gtr-catalogue.products` (one Product row per name, one
  ProductSize row per size — or flatten into a single Product per size as
  shown in the Excel sheet 2, which is closer to a normal POS SKU model).
- VehicleMakes / VehicleModels from `vehicle-fitment` (use the Cat→Make and
  Make→Model sheets directly).

### 2. Add three small tables to your Prisma schema

```prisma
model VehicleMake {
  id         String  @id @default(uuid())
  category   String                       // e.g. "Passenger Car Tyres"
  name       String                       // e.g. "Suzuki"
  models     VehicleModel[]
  @@unique([category, name])
}

model VehicleModel {
  id          String  @id @default(uuid())
  makeId      String
  make        VehicleMake @relation(fields: [makeId], references: [id])
  name        String                      // e.g. "Mehran"
  tyreSize    String                      // e.g. "145/80 R12"
  recommended String?                     // recommended GTR product name
  @@unique([makeId, name])
}
```

### 3. Wire the three dropdowns

```ts
// /api/dropdown/makes?category=Passenger%20Car%20Tyres
GET → SELECT DISTINCT make FROM VehicleMake WHERE category = ?

// /api/dropdown/models?make=Suzuki
GET → SELECT name, tyreSize, recommended FROM VehicleModel WHERE makeId = ?

// /api/search?modelId=...
GET → SELECT * FROM Product WHERE size = (SELECT tyreSize FROM VehicleModel WHERE id = ?)
```

### 4. The user flow

1. User picks **Category** → frontend calls `/api/dropdown/makes` → populates
   the Make dropdown.
2. User picks **Make** → frontend calls `/api/dropdown/models` → populates
   the Type/Model dropdown.
3. User clicks **Search** → frontend calls `/api/search?modelId=X` → lands on
   a results page showing all GTR tyres in that size, with the recommended
   one highlighted.

## Caveats and verification notes

- Every recommendation in `vehicle-fitment.json` is a sensible best-guess based
  on common OEM sizes in Pakistan. Vehicle-tyre fitment varies by trim, year,
  and rim option — **always verify against the actual placard inside the
  driver door** before selling.
- Sizes for the same model can differ between local-assembled (KD) and
  imported (CBU) units. Where this matters (e.g. Corolla Altis 1.6 vs 1.8),
  separate model entries have been provided.
- The catalogue itself is the source of truth for GTR product specs. If GTR
  publishes an updated catalogue, refresh `gtr-catalogue.json` from the new
  PDF rather than editing it by hand.
- For motorcycle/rickshaw rows, F = front tyre, R = rear tyre — keep this
  convention if you display sizes to end users.

## Counts at a glance

- Categories: 6
- Distinct GTR products: ~60 (roughly 100 SKU rows once size variants are
  expanded)
- Vehicle makes covered: 30+ across all categories
- Vehicle models / fitment rows: 130+

That should be enough to demo and seed. Add real local SKUs, prices, and
stock levels on top.
