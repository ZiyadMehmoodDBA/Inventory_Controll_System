'use strict';
// Catalogue profiles: what to extract, search for and treat as a duplicate, per business type. The scraping engine contains no
// industry knowledge; everything industry-specific is data here (and can be overridden per organisation, see effective()).
const { BUSINESS_TYPES } = require('../utils/businessTypes');

// Columns on a catalogue record. Any other field key is stored in the record's attributes.
const CORE = ['name', 'brand', 'sku', 'barcode', 'oem', 'category', 'subcategory', 'price', 'wholesale_price', 'unit', 'pack_size', 'image_url', 'description'];

// field: [key, label, required?, aliases?]  (aliases = spec-table labels on supplier sites that mean this field)
const f = (key, label, required, aliases) => ({ key, label, required: !!required, aliases: aliases || [] });
const NAME = f('name', 'Product name', true, ['product', 'title', 'item', 'product name']);
const BRAND = f('brand', 'Brand', false, ['make', 'manufacturer', 'brand name']);
const SKU = f('sku', 'SKU / Part number', false, ['sku', 'part number', 'part no', 'item number', 'model number', 'mpn', 'article number']);
const BARCODE = f('barcode', 'Barcode / GTIN', false, ['gtin', 'ean', 'upc', 'barcode', 'isbn']);
const CATEGORY = f('category', 'Category'), SUB = f('subcategory', 'Subcategory');
const DESC = f('description', 'Description');
const PRICE = f('price', 'Retail price'), WHOLESALE = f('wholesale_price', 'Wholesale price', false, ['trade price', 'dealer price']);
const IMAGE = f('image_url', 'Product image');
const UNIT = f('unit', 'Unit', false, ['unit of measure', 'uom']);
const PACK = f('pack_size', 'Package size', false, ['size', 'pack size', 'net weight', 'net quantity', 'volume', 'net content']);
const SPECS = f('specifications', 'Specifications', false, ['specifications', 'specs', 'technical specifications']);
const MANUFACTURER = f('manufacturer', 'Manufacturer', false, ['manufacturer', 'made by']);
const SUPPLIER = f('supplier', 'Supplier', false, ['supplier', 'sold by', 'seller']);
const COLOR = f('color', 'Color', false, ['colour', 'color']);
const MATERIAL = f('material', 'Material', false, ['material', 'fabric']);
const GENDER = f('gender', 'Gender / Collection', false, ['gender', 'collection', 'department']);

const GENERIC = [NAME, SKU, BARCODE, BRAND, CATEGORY, SUB, DESC, UNIT, PACK, PRICE, IMAGE];

const PROFILES = {
  general_store: {
    keywords: ['household', 'kitchen', 'cleaning', 'personal care', 'snacks', 'beverages'],
    categories: [['Household', ['household', 'home', 'cleaning', 'detergent']], ['Kitchen', ['kitchen', 'cookware', 'utensil']], ['Personal care', ['soap', 'shampoo', 'toothpaste', 'lotion']], ['Food & beverages', ['snack', 'drink', 'juice', 'biscuit', 'tea', 'coffee']], ['Stationery', ['pen', 'paper', 'notebook']]],
    fields: GENERIC, identity: ['sku', 'barcode'],
  },
  tyre_shop: {
    keywords: ['tyre', 'tire', 'wheel', 'rim', 'alloy'],
    categories: [['Passenger tyres', ['passenger', 'car tyre', 'sedan', 'hatchback']], ['SUV / 4x4 tyres', ['suv', '4x4', 'light truck', 'off-road']], ['Commercial tyres', ['truck', 'bus', 'commercial', 'lorry']], ['Motorcycle tyres', ['motorcycle', 'motorbike', 'scooter']], ['Wheels & rims', ['wheel', 'rim', 'alloy']]],
    fields: [f('brand', 'Tyre brand', true, ['brand', 'make']), f('model', 'Tyre model', true, ['model', 'pattern', 'tread pattern']), f('width', 'Width (mm)', true, ['width', 'section width']), f('aspect_ratio', 'Aspect ratio', true, ['aspect ratio', 'profile', 'series']),
      f('rim_diameter', 'Rim diameter (in)', true, ['rim', 'rim size', 'rim diameter', 'diameter', 'wheel size']), f('load_index', 'Load index', false, ['load index', 'load rating']), f('speed_rating', 'Speed rating', false, ['speed rating', 'speed index', 'speed symbol']),
      f('season', 'Season', false, ['season', 'tyre type']), f('construction', 'Construction', false, ['construction', 'tyre construction']), f('run_flat', 'Run flat'), f('tube_type', 'Tube / tubeless', false, ['tube type', 'tubeless']),
      f('dot', 'DOT / production week', false, ['dot', 'dot code', 'production date']), f('availability', 'Stock availability', false, ['availability', 'stock']), f('vehicle_compatibility', 'Vehicle compatibility', false, ['fits', 'vehicle', 'compatibility']),
      PRICE, IMAGE, SKU, CATEGORY],
    identity: ['sku', 'barcode', 'tyre'],
  },
  auto_parts: {
    keywords: ['brake pad', 'oil filter', 'spark plug', 'battery', 'wiper', 'suspension', 'headlight'],
    categories: [['Filters', ['filter']], ['Brakes', ['brake', 'pad', 'rotor', 'disc']], ['Engine & ignition', ['spark plug', 'engine', 'ignition', 'gasket', 'timing']], ['Suspension & steering', ['shock', 'strut', 'suspension', 'steering', 'ball joint']], ['Electrical & batteries', ['battery', 'alternator', 'starter', 'bulb', 'headlight']], ['Oils & fluids', ['oil', 'coolant', 'fluid', 'grease']], ['Accessories', ['mat', 'cover', 'wiper', 'accessory', 'seat']]],
    fields: [NAME, f('sku', 'SKU / Part number', true, SKU.aliases), f('oem', 'OEM number', false, ['oem', 'oem number', 'oe number', 'cross reference']), BRAND, f('vehicle_make', 'Vehicle make', false, ['vehicle make', 'car make', 'fits make']), f('vehicle_model', 'Vehicle model', false, ['vehicle model', 'car model', 'fits model']),
      f('vehicle_year', 'Vehicle year', false, ['year', 'vehicle year', 'fits year']), f('engine_capacity', 'Engine capacity', false, ['engine', 'engine capacity', 'displacement']), CATEGORY, SUB, f('compatibility', 'Compatibility', false, ['compatibility', 'fits', 'fitment']), DESC, SPECS, PRICE, WHOLESALE, IMAGE, MANUFACTURER, SUPPLIER],
    identity: ['sku', 'oem', 'barcode'],
  },
  auto_workshop: {
    keywords: ['engine oil', 'oil filter', 'coolant', 'brake fluid', 'spark plug', 'wiper', 'battery'],
    categories: [['Oils & lubricants', ['oil', 'lubricant', 'grease']], ['Fluids', ['coolant', 'brake fluid', 'fluid', 'washer']], ['Filters', ['filter']], ['Service parts', ['spark plug', 'belt', 'gasket', 'pad', 'wiper']], ['Batteries', ['battery']]],
    fields: [NAME, f('sku', 'SKU / Part number', true, SKU.aliases), f('oem', 'OEM number', false, ['oem', 'oem number']), BRAND, f('vehicle_make', 'Vehicle make'), f('vehicle_model', 'Vehicle model'), CATEGORY, SUB, f('compatibility', 'Compatibility'), UNIT, PACK, PRICE, WHOLESALE, IMAGE, SUPPLIER],
    identity: ['sku', 'oem', 'barcode'],
  },
  grocery: {
    keywords: ['rice', 'flour', 'cooking oil', 'tea', 'milk', 'sugar', 'biscuits', 'juice'],
    categories: [['Staples', ['rice', 'flour', 'atta', 'sugar', 'pulses', 'lentil']], ['Cooking oil & ghee', ['cooking oil', 'ghee', 'oil']], ['Dairy', ['milk', 'yogurt', 'butter', 'cheese', 'cream']], ['Beverages', ['tea', 'coffee', 'juice', 'drink', 'soda', 'water']], ['Snacks & biscuits', ['biscuit', 'chips', 'snack', 'chocolate', 'candy']], ['Spices', ['spice', 'masala', 'salt', 'pepper']], ['Frozen & canned', ['frozen', 'canned', 'tin']]],
    fields: [NAME, BRAND, f('barcode', 'Barcode / GTIN', false, BARCODE.aliases), CATEGORY, SUB, PACK, UNIT, f('ingredients', 'Ingredients', false, ['ingredients']), f('expiry_info', 'Expiry information', false, ['expiry', 'shelf life', 'best before']), PRICE, WHOLESALE, IMAGE],
    identity: ['barcode', 'sku'],
  },
  pharmacy: {
    keywords: ['tablet', 'syrup', 'capsule', 'ointment', 'vitamin', 'first aid'],
    categories: [['Tablets & capsules', ['tablet', 'capsule', 'tab', 'cap']], ['Syrups & suspensions', ['syrup', 'suspension', 'drops']], ['Topical', ['ointment', 'cream', 'gel', 'lotion']], ['Vitamins & supplements', ['vitamin', 'supplement', 'zinc', 'calcium']], ['Medical supplies', ['bandage', 'syringe', 'mask', 'glove', 'thermometer', 'first aid']]],
    fields: [NAME, f('brand', 'Manufacturer / brand', false, BRAND.aliases), f('barcode', 'Barcode / GTIN', false, BARCODE.aliases), f('generic_name', 'Generic name', false, ['generic', 'generic name', 'active ingredient', 'composition']), f('strength', 'Strength', false, ['strength', 'dose']), f('dosage_form', 'Dosage form', false, ['form', 'dosage form']), PACK, CATEGORY, PRICE, IMAGE],
    identity: ['barcode', 'sku'],
  },
  perfumes_cosmetics: {
    keywords: ['perfume', 'eau de parfum', 'body spray', 'lipstick', 'moisturiser', 'foundation'],
    categories: [['Perfumes', ['perfume', 'parfum', 'eau de', 'cologne', 'attar']], ['Body mists & deodorants', ['body spray', 'mist', 'deodorant']], ['Makeup', ['lipstick', 'foundation', 'mascara', 'eyeliner', 'makeup']], ['Skin care', ['moisturi', 'serum', 'sunscreen', 'face wash', 'cream']], ['Hair care', ['shampoo', 'conditioner', 'hair']]],
    fields: [NAME, f('brand', 'Brand', true, BRAND.aliases), BARCODE, CATEGORY, f('volume', 'Volume', false, ['volume', 'size', 'net content']), f('fragrance_family', 'Fragrance family', false, ['fragrance family', 'scent', 'olfactory family']), GENDER, PRICE, IMAGE],
    identity: ['barcode', 'sku'],
  },
  clothing: {
    keywords: ['shirt', 'trousers', 'dress', 'kurta', 'jeans', 'jacket', 'shoes'],
    categories: [['Tops', ['shirt', 't-shirt', 'top', 'blouse', 'kurta']], ['Bottoms', ['trouser', 'jeans', 'pant', 'shorts', 'skirt']], ['Dresses & suits', ['dress', 'suit', 'gown', 'shalwar']], ['Outerwear', ['jacket', 'coat', 'hoodie', 'sweater']], ['Footwear', ['shoe', 'sandal', 'sneaker', 'boot']], ['Accessories', ['belt', 'scarf', 'cap', 'bag', 'wallet']]],
    fields: [BRAND, f('name', 'Product name', true, NAME.aliases), SKU, CATEGORY, GENDER, f('size', 'Size', false, ['size', 'sizes']), COLOR, MATERIAL, f('pattern', 'Pattern', false, ['pattern']), PRICE, IMAGE],
    identity: ['sku', 'barcode'],
  },
  electronics: {
    keywords: ['smartphone', 'mobile', 'laptop', 'tablet', 'charger', 'earbuds', 'television'],
    categories: [['Mobile phones', ['phone', 'smartphone', 'mobile', 'iphone', 'galaxy']], ['Laptops & computers', ['laptop', 'notebook', 'desktop', 'monitor', 'computer']], ['Tablets', ['tablet', 'ipad']], ['Audio', ['earbud', 'headphone', 'speaker', 'airpods']], ['TV & video', ['television', 'tv', 'projector']], ['Chargers & cables', ['charger', 'cable', 'adapter', 'power bank']], ['Accessories', ['case', 'cover', 'screen protector', 'stand']]],
    fields: [BRAND, f('model', 'Model', true, ['model', 'model name']), f('name', 'Product name', true, NAME.aliases), SKU, CATEGORY, SPECS, f('warranty', 'Warranty', false, ['warranty', 'guarantee']), COLOR, f('storage_capacity', 'Storage capacity', false, ['storage', 'internal storage', 'capacity', 'memory', 'rom']), PRICE, IMAGE, MANUFACTURER],
    identity: ['sku', 'barcode'],
  },
  hardware: {
    keywords: ['cement', 'steel bar', 'pipe', 'paint', 'drill', 'screws', 'cable', 'tiles'],
    categories: [['Cement & masonry', ['cement', 'brick', 'block', 'sand', 'gravel']], ['Steel & metal', ['steel', 'bar', 'iron', 'angle', 'sheet']], ['Plumbing', ['pipe', 'fitting', 'valve', 'tap', 'faucet']], ['Electrical', ['cable', 'wire', 'switch', 'socket', 'breaker']], ['Paint & coatings', ['paint', 'primer', 'varnish', 'putty']], ['Tools', ['drill', 'hammer', 'saw', 'wrench', 'plier', 'tool']], ['Fasteners', ['screw', 'bolt', 'nut', 'nail', 'anchor']], ['Tiles & flooring', ['tile', 'marble', 'flooring']]],
    fields: [NAME, BRAND, SKU, f('material_type', 'Material type', false, ['material', 'material type']), f('dimensions', 'Dimensions', false, ['dimensions', 'size', 'length']), f('weight', 'Weight', false, ['weight', 'net weight']), f('grade', 'Grade', false, ['grade', 'rating', 'standard']), f('unit', 'Unit of measurement', false, UNIT.aliases), SPECS, PRICE, IMAGE],
    identity: ['sku', 'barcode'],
  },
  restaurant: {
    keywords: ['burger', 'pizza', 'biryani', 'cake', 'bread', 'coffee', 'dessert'],
    categories: [['Main course', ['karahi', 'biryani', 'curry', 'steak', 'main']], ['Fast food', ['burger', 'pizza', 'sandwich', 'wrap', 'fries']], ['Bakery', ['cake', 'bread', 'pastry', 'cookie', 'donut']], ['Beverages', ['coffee', 'tea', 'juice', 'shake', 'drink']], ['Desserts', ['dessert', 'ice cream', 'kheer']]],
    fields: [NAME, CATEGORY, DESC, f('portion', 'Portion', false, ['portion', 'serving', 'size']), PRICE, IMAGE],
    identity: ['sku'],
  },
  stationery: {
    keywords: ['notebook', 'pen', 'paper', 'marker', 'file', 'textbook', 'calculator'],
    categories: [['Paper & notebooks', ['paper', 'notebook', 'register', 'diary', 'pad']], ['Writing', ['pen', 'pencil', 'marker', 'highlighter', 'eraser']], ['Files & folders', ['file', 'folder', 'binder', 'envelope']], ['Books', ['book', 'textbook', 'novel', 'guide']], ['Office supplies', ['stapler', 'tape', 'glue', 'calculator', 'scissor']], ['Art & craft', ['paint', 'crayon', 'sketch', 'colour', 'color']]],
    fields: [NAME, BRAND, SKU, f('barcode', 'Barcode / ISBN', false, BARCODE.aliases), CATEGORY, PACK, f('author', 'Author', false, ['author', 'writer']), f('publisher', 'Publisher', false, ['publisher']), PRICE, IMAGE],
    identity: ['barcode', 'sku'],
  },
  wholesale: {
    keywords: ['carton', 'bulk', 'wholesale', 'case pack', 'dozen'],
    categories: [['Food & grocery', ['food', 'grocery', 'rice', 'flour', 'oil']], ['Beverages', ['beverage', 'drink', 'juice', 'water']], ['Household', ['household', 'cleaning', 'detergent']], ['Personal care', ['soap', 'shampoo', 'care']], ['General merchandise', []]],
    fields: [NAME, BRAND, SKU, BARCODE, CATEGORY, SUB, UNIT, PACK, f('carton_quantity', 'Units per carton', false, ['carton quantity', 'units per carton', 'case pack', 'pack of']), PRICE, WHOLESALE, IMAGE, SUPPLIER],
    identity: ['barcode', 'sku'],
  },
  manufacturing: {
    keywords: ['raw material', 'steel', 'resin', 'packaging', 'fabric', 'component'],
    categories: [['Raw materials', ['raw', 'resin', 'steel', 'aluminium', 'aluminum', 'polymer', 'chemical']], ['Components', ['component', 'bearing', 'motor', 'gear', 'valve']], ['Packaging', ['packaging', 'carton', 'box', 'film', 'label']], ['Consumables', ['consumable', 'lubricant', 'abrasive', 'glove']]],
    fields: [NAME, SKU, f('material_type', 'Material type', false, ['material', 'material type']), f('dimensions', 'Dimensions', false, ['dimensions', 'size']), f('weight', 'Weight', false, ['weight']), f('grade', 'Grade', false, ['grade', 'standard']), UNIT, SPECS, SUPPLIER, MANUFACTURER, PRICE, IMAGE],
    identity: ['sku', 'barcode'],
  },
  other: {
    keywords: [], categories: [['General', []]], fields: GENERIC, identity: ['sku', 'barcode'],
  },
};

const categoriesOf = p => p.categories.map(c => (Array.isArray(c) ? { name: c[0], match: c[1] } : c));
const clean = (arr, max, len) => [...new Set((Array.isArray(arr) ? arr : []).map(x => String(x ?? '').trim().slice(0, len)).filter(Boolean))].slice(0, max);

/** Defaults for a business type. */
function base(type) {
  const t = BUSINESS_TYPES.includes(type) ? type : 'general_store';
  const p = PROFILES[t];
  return { id: t, keywords: [...p.keywords], categories: categoriesOf(p), fields: p.fields.map(x => ({ ...x })), identity: [...p.identity], max_pages: 3 };
}

/** Defaults merged with an organisation's saved overrides { keywords, categories, required, max_pages }. */
function effective(type, override) {
  const p = base(type);
  const o = override || {};
  if (Array.isArray(o.keywords)) p.keywords = clean(o.keywords, 30, 60);
  if (Array.isArray(o.categories)) {
    p.categories = o.categories.map(c => (typeof c === 'string' ? { name: c, match: [] } : { name: String(c.name || '').trim().slice(0, 100), match: clean(c.match, 20, 60) })).filter(c => c.name).slice(0, 40);
  }
  if (Array.isArray(o.required)) { const r = new Set(o.required); p.fields = p.fields.map(x => ({ ...x, required: r.has(x.key) })); }
  if (Number.isInteger(o.max_pages)) p.max_pages = Math.min(10, Math.max(1, o.max_pages));
  return p;
}

module.exports = { CORE, PROFILES, base, effective, clean, BUSINESS_TYPES };
