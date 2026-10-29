import { useState } from 'react';

export const PAYMENT_METHODS = [
  { value: 'cash',          label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'online',        label: 'Online Payment' },
  { value: 'other',         label: 'Other' },
];

export function usePaymentForm(initialAmount = '') {
  const [amount,      setAmount]      = useState(initialAmount);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [method,      setMethod]      = useState('cash');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes,       setNotes]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [success,     setSuccess]     = useState('');

  return {
    amount, setAmount,
    paymentDate, setPaymentDate,
    method, setMethod,
    referenceNo, setReferenceNo,
    notes, setNotes,
    loading, setLoading,
    error, setError,
    success, setSuccess,
  };
}
