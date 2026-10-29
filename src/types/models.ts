export interface Sale {
  id: number;
  invoice_no: string;
  date: string;
  customer_name: string;
  customer_id: number;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  status: 'paid' | 'partial' | 'pending' | 'overdue' | 'voided';
  items?: SaleItem[];
}

export interface SaleItem {
  id: number;
  tire_sku_id: number | null;
  product_id: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface Purchase {
  id: number;
  po_no: string;
  date: string;
  supplier_name: string;
  supplier_id: number;
  total: number;
  amount_paid: number;
  status: 'pending' | 'received' | 'cancelled';
  items?: PurchaseItem[];
}

export interface PurchaseItem {
  id: number;
  tire_sku_id: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface Customer {
  id: number;
  code: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  vehicle_plate?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_year?: string;
  invoice_count?: number;
  total_invoiced?: number;
  total_paid?: number;
  balance_due?: number;
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  po_count?: number;
  total_invoiced?: number;
  total_paid?: number;
  balance_due?: number;
}

export interface TireSku {
  id: number;
  brand: string;
  model: string;
  size: string;
  pattern?: string;
  load_index?: string;
  speed_index?: string;
  tire_type?: string;
  quantity: number;
  cost_price?: number;
  selling_price: number;
}

export interface Payment {
  id: number;
  amount: number;
  payment_date: string;
  payment_method: string;
  reference_no?: string;
  notes?: string;
  sale_id?: number;
  purchase_id?: number;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  first_name?: string;
  last_name?: string;
  phone?: string;
  job_title?: string;
  department?: string;
}

export interface Branch {
  id: number;
  name: string;
  code?: string;
  address?: string;
  phone?: string;
}

export interface Organization {
  id: number;
  name: string;
  code?: string;
}
