// Financial inventory valuation. Independent of physical rotation: this decides what COST is booked, not which units are picked.
//   standard  stock x the item's current cost price
//   average   stock x cost price, which is re-averaged on every goods receipt (weighted / moving average)
//   fifo      remaining cost layers: the newest purchase costs stay in stock (oldest cost is expensed first)
//   lifo      remaining cost layers: the oldest purchase costs stay in stock (newest cost is expensed first)
const { getPool, sql } = require('../db');

const LAYER_METHODS = ['fifo', 'lifo'];
const round2 = n => Math.round(n * 100) / 100;

const METHOD_INFO = {
  standard: { label: 'Standard cost (item cost price)', description: 'Every unit is valued at the item\'s current cost price. Simple; changes in purchase price show only when you update the cost price.' },
  average:  { label: 'Weighted average cost', description: 'Each goods receipt re-averages the item\'s cost price (old stock and new stock blended by quantity). Stock and cost of goods sold both use that average.' },
  fifo:     { label: 'FIFO cost — first in, first out', description: 'The oldest purchase cost is expensed first, so stock on hand is valued at the most recent purchase costs.' },
  lifo:     { label: 'LIFO cost — last in, first out', description: 'The newest purchase cost is expensed first, so stock on hand is valued at the oldest purchase costs. Not permitted under IFRS and in many jurisdictions: enable only where your accountant confirms it is legal for your business.', needsAck: true },
};

/** Stock value per item under `method`, with category and grand totals. `branchId` null = every branch of the organisation. */
async function computeValuation(orgId, branchId, method, conn) {
  const r = await (conn || (await getPool())).request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, t.uom, t.stock, t.cost_price, t.sale_price,
                   ISNULL(c.name, 'Uncategorised') AS category,
                   ISNULL(l.qty, 0) AS layer_qty, ISNULL(l.value, 0) AS layer_value
            FROM tires t
            LEFT JOIN item_categories c ON c.id = t.category_id
            OUTER APPLY (SELECT SUM(qty_remaining) AS qty, SUM(qty_remaining * unit_cost) AS value FROM stock_cost_layers WHERE tire_id = t.id) l
            WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.stock > 0
            ORDER BY t.model`);
  const items = r.recordset.map(x => {
    const layerQty = Math.min(x.layer_qty, x.stock);
    const value = LAYER_METHODS.includes(method)
      ? (x.layer_qty > x.stock ? x.stock * (x.layer_value / x.layer_qty) : Number(x.layer_value)) + (x.stock - layerQty) * Number(x.cost_price)
      : x.stock * Number(x.cost_price);
    return { tire_id: x.tire_id, item_name: x.item_name, sku: x.sku, uom: x.uom, category: x.category, stock: x.stock,
             unit_cost: x.stock ? Math.round((value / x.stock) * 10000) / 10000 : 0, value: round2(value), retail_value: round2(x.stock * Number(x.sale_price)) };
  });
  const byCat = {};
  for (const i of items) { const c = byCat[i.category] ??= { category: i.category, units: 0, value: 0, retail_value: 0 }; c.units += i.stock; c.value += i.value; c.retail_value += i.retail_value; }
  const total = k => round2(items.reduce((a, i) => a + i[k], 0));
  return { items,
           categories: Object.values(byCat).map(c => ({ ...c, value: round2(c.value), retail_value: round2(c.retail_value) })).sort((a, b) => b.value - a.value),
           totals: { units: items.reduce((a, i) => a + i.stock, 0), value: total('value'), retail_value: total('retail_value') } };
}

module.exports = { METHOD_INFO, LAYER_METHODS, computeValuation, round2 };
