// Stock position definitions, shared by the item list and the stock-control routes. One definition so nothing is counted twice:
//   on_hand      everything physically recorded (tires.stock = sum of all locations)
//   quarantined  on hand in restricted locations (kind quarantine / damaged): never available
//   expired      on hand in normal locations in batches past their expiry date: never available
//   held         on hand in normal locations in batches on quality hold, recalled or damaged (and not expired: those count as expired)
//   reserved     active, unexpired reservations (they only exist in normal locations)
//   available    on_hand - quarantined - expired - held - reserved   (never below zero)
//   in_transit   dispatched transfers not yet received: already out of the source, not yet in the destination, so NOT in on_hand
//   on_order     quantity on pending purchase orders: not yet received, so NOT in on_hand
const POSITION_APPLY = `
  OUTER APPLY (SELECT ISNULL(SUM(r.qty), 0) AS qty FROM stock_reservations r
               WHERE r.tire_id = t.id AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at >= CAST(GETDATE() AS DATE))) rsv
  OUTER APPLY (SELECT ISNULL(SUM(x.qty), 0) AS qty FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id
               WHERE x.tire_id = t.id AND l.kind <> 'normal') qr
  OUTER APPLY (SELECT ISNULL(SUM(bl.qty), 0) AS qty FROM batch_location_stock bl JOIN stock_batches b ON b.id = bl.batch_id JOIN stock_locations l ON l.id = bl.location_id
               WHERE b.tire_id = t.id AND l.kind = 'normal' AND b.expiry_date IS NOT NULL AND b.expiry_date < CAST(GETDATE() AS DATE)) ex
  OUTER APPLY (SELECT ISNULL(SUM(bl.qty), 0) AS qty FROM batch_location_stock bl JOIN stock_batches b ON b.id = bl.batch_id JOIN stock_locations l ON l.id = bl.location_id
               WHERE b.tire_id = t.id AND l.kind = 'normal' AND b.quality_status <> 'released' AND (b.expiry_date IS NULL OR b.expiry_date >= CAST(GETDATE() AS DATE))) hd
  OUTER APPLY (SELECT ISNULL(SUM(i.qty), 0) AS qty FROM stock_transfer_items i JOIN stock_transfers tr ON tr.id = i.transfer_id
               WHERE i.tire_id = t.id AND tr.status = 'in_transit') tt
  OUTER APPLY (SELECT ISNULL(SUM(pi.qty), 0) AS qty FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
               WHERE pi.tire_id = t.id AND p.status = 'pending') oo`;

const POSITION_COLUMNS = `
  rsv.qty AS reserved, qr.qty AS quarantined, ex.qty AS expired, hd.qty AS held, tt.qty AS in_transit, oo.qty AS on_order,
  CASE WHEN t.stock - qr.qty - ex.qty - hd.qty - rsv.qty < 0 THEN 0 ELSE t.stock - qr.qty - ex.qty - hd.qty - rsv.qty END AS available`;

module.exports = { POSITION_APPLY, POSITION_COLUMNS };
