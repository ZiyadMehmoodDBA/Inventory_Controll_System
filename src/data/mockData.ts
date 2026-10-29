export const tireInventory = [
  { id: '1', brand: 'Bridgestone', model: 'Turanza T005', size: '205/55R16', type: 'Passenger', stock: 45, costPrice: 12500, salePrice: 16500, reorderLevel: 10 },
  { id: '2', brand: 'Michelin', model: 'Primacy 4', size: '215/60R16', type: 'Passenger', stock: 32, costPrice: 15000, salePrice: 20000, reorderLevel: 8 },
  { id: '3', brand: 'Continental', model: 'ContiSportContact 5', size: '225/45R17', type: 'Performance', stock: 18, costPrice: 18000, salePrice: 24000, reorderLevel: 5 },
  { id: '4', brand: 'Yokohama', model: 'Advan Sport', size: '245/40R18', type: 'Performance', stock: 12, costPrice: 22000, salePrice: 29000, reorderLevel: 5 },
  { id: '5', brand: 'Dunlop', model: 'SP Sport Maxx', size: '235/55R18', type: 'SUV', stock: 28, costPrice: 19500, salePrice: 26000, reorderLevel: 8 },
  { id: '6', brand: 'Pirelli', model: 'Scorpion Verde', size: '255/50R19', type: 'SUV', stock: 15, costPrice: 25000, salePrice: 33000, reorderLevel: 5 },
  { id: '7', brand: 'Goodyear', model: 'Eagle F1', size: '265/65R17', type: 'SUV', stock: 22, costPrice: 17000, salePrice: 22500, reorderLevel: 6 },
  { id: '8', brand: 'Hankook', model: 'Kinergy 4S2', size: '185/65R15', type: 'Passenger', stock: 60, costPrice: 8500, salePrice: 11500, reorderLevel: 15 },
  { id: '9', brand: 'Toyo', model: 'Open Country A/T', size: '31x10.5R15', type: '4x4', stock: 8, costPrice: 28000, salePrice: 36000, reorderLevel: 4 },
  { id: '10', brand: 'Falken', model: 'Sincera SN110', size: '175/70R14', type: 'Passenger', stock: 75, costPrice: 7000, salePrice: 9500, reorderLevel: 20 },
];

export const customers = [
  { id: 'C001', name: 'Ahmed Transport Co.', phone: '+92-300-1234567', email: 'ahmed@transport.pk', address: 'Lahore', totalPurchases: 485000, balance: 0 },
  { id: 'C002', name: 'Karachi Auto Hub', phone: '+92-321-9876543', email: 'info@karachiauto.pk', address: 'Karachi', totalPurchases: 320000, balance: 15000 },
  { id: 'C003', name: 'Islamabad Fleet Solutions', phone: '+92-311-5555123', email: 'fleet@isb.pk', address: 'Islamabad', totalPurchases: 750000, balance: 0 },
  { id: 'C004', name: 'Faisal Motors', phone: '+92-333-4444222', email: 'faisal@motors.pk', address: 'Faisalabad', totalPurchases: 190000, balance: 8000 },
  { id: 'C005', name: 'Malik Tyre Works', phone: '+92-345-6677889', email: 'malik@tyre.pk', address: 'Multan', totalPurchases: 265000, balance: 0 },
];

export const suppliers = [
  { id: 'S001', name: 'Bridgestone Pakistan', phone: '+92-21-3456789', email: 'supply@bridgestone.pk', address: 'Karachi', totalPurchases: 850000, balance: 0 },
  { id: 'S002', name: 'Tyre World Imports', phone: '+92-42-7654321', email: 'orders@tyreworld.pk', address: 'Lahore', totalPurchases: 620000, balance: 45000 },
  { id: 'S003', name: 'Continental Distributors', phone: '+92-51-9876000', email: 'dist@continental.pk', address: 'Islamabad', totalPurchases: 410000, balance: 0 },
  { id: 'S004', name: 'Asia Tyre Traders', phone: '+92-300-9988776', email: 'asia@tyretraders.pk', address: 'Peshawar', totalPurchases: 295000, balance: 22000 },
];

export const salesData = [
  { id: 'INV-2024-001', date: '2024-01-05', customer: 'Ahmed Transport Co.', items: [{ tire: 'Bridgestone Turanza T005 205/55R16', qty: 4, price: 16500 }], subtotal: 66000, tax: 9900, total: 75900, status: 'paid' },
  { id: 'INV-2024-002', date: '2024-01-08', customer: 'Karachi Auto Hub', items: [{ tire: 'Michelin Primacy 4 215/60R16', qty: 8, price: 20000 }], subtotal: 160000, tax: 24000, total: 184000, status: 'paid' },
  { id: 'INV-2024-003', date: '2024-01-12', customer: 'Islamabad Fleet Solutions', items: [{ tire: 'Dunlop SP Sport Maxx 235/55R18', qty: 16, price: 26000 }], subtotal: 416000, tax: 62400, total: 478400, status: 'paid' },
  { id: 'INV-2024-004', date: '2024-01-18', customer: 'Faisal Motors', items: [{ tire: 'Hankook Kinergy 4S2 185/65R15', qty: 4, price: 11500 }], subtotal: 46000, tax: 6900, total: 52900, status: 'pending' },
  { id: 'INV-2024-005', date: '2024-01-22', customer: 'Malik Tyre Works', items: [{ tire: 'Continental ContiSportContact 5 225/45R17', qty: 4, price: 24000 }], subtotal: 96000, tax: 14400, total: 110400, status: 'paid' },
  { id: 'INV-2024-006', date: '2024-02-03', customer: 'Ahmed Transport Co.', items: [{ tire: 'Goodyear Eagle F1 265/65R17', qty: 6, price: 22500 }], subtotal: 135000, tax: 20250, total: 155250, status: 'paid' },
  { id: 'INV-2024-007', date: '2024-02-14', customer: 'Karachi Auto Hub', items: [{ tire: 'Yokohama Advan Sport 245/40R18', qty: 4, price: 29000 }], subtotal: 116000, tax: 17400, total: 133400, status: 'overdue' },
  { id: 'INV-2024-008', date: '2024-02-20', customer: 'Islamabad Fleet Solutions', items: [{ tire: 'Bridgestone Turanza T005 205/55R16', qty: 20, price: 16500 }], subtotal: 330000, tax: 49500, total: 379500, status: 'paid' },
  { id: 'INV-2024-009', date: '2024-03-01', customer: 'Faisal Motors', items: [{ tire: 'Pirelli Scorpion Verde 255/50R19', qty: 4, price: 33000 }], subtotal: 132000, tax: 19800, total: 151800, status: 'paid' },
  { id: 'INV-2024-010', date: '2024-03-10', customer: 'Ahmed Transport Co.', items: [{ tire: 'Falken Sincera SN110 175/70R14', qty: 12, price: 9500 }], subtotal: 114000, tax: 17100, total: 131100, status: 'pending' },
];

export const purchasesData = [
  { id: 'PO-2024-001', date: '2024-01-02', supplier: 'Bridgestone Pakistan', items: [{ tire: 'Bridgestone Turanza T005 205/55R16', qty: 50, price: 12500 }], subtotal: 625000, tax: 0, total: 625000, status: 'received' },
  { id: 'PO-2024-002', date: '2024-01-10', supplier: 'Tyre World Imports', items: [{ tire: 'Michelin Primacy 4 215/60R16', qty: 30, price: 15000 }], subtotal: 450000, tax: 0, total: 450000, status: 'received' },
  { id: 'PO-2024-003', date: '2024-01-20', supplier: 'Continental Distributors', items: [{ tire: 'Continental ContiSportContact 5 225/45R17', qty: 20, price: 18000 }], subtotal: 360000, tax: 0, total: 360000, status: 'received' },
  { id: 'PO-2024-004', date: '2024-02-05', supplier: 'Asia Tyre Traders', items: [{ tire: 'Yokohama Advan Sport 245/40R18', qty: 15, price: 22000 }], subtotal: 330000, tax: 0, total: 330000, status: 'received' },
  { id: 'PO-2024-005', date: '2024-02-18', supplier: 'Tyre World Imports', items: [{ tire: 'Dunlop SP Sport Maxx 235/55R18', qty: 25, price: 19500 }], subtotal: 487500, tax: 0, total: 487500, status: 'pending' },
  { id: 'PO-2024-006', date: '2024-03-05', supplier: 'Bridgestone Pakistan', items: [{ tire: 'Hankook Kinergy 4S2 185/65R15', qty: 60, price: 8500 }], subtotal: 510000, tax: 0, total: 510000, status: 'received' },
];

export const monthlyRevenue = [
  { month: 'Jan', revenue: 801650, purchases: 1435000, profit: 234650 },
  { month: 'Feb', revenue: 668150, purchases: 817500, profit: 195150 },
  { month: 'Mar', revenue: 282900, purchases: 510000, profit: 82900 },
  { month: 'Apr', revenue: 425000, purchases: 380000, profit: 125000 },
  { month: 'May', revenue: 560000, purchases: 490000, profit: 165000 },
  { month: 'Jun', revenue: 720000, purchases: 620000, profit: 210000 },
];

export const tireTypeSales = [
  { name: 'Passenger', value: 45, color: '#3b82f6' },
  { name: 'SUV', value: 28, color: '#8b5cf6' },
  { name: 'Performance', value: 18, color: '#f59e0b' },
  { name: '4x4', value: 9, color: '#10b981' },
];
