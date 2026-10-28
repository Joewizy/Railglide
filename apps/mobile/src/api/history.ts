// Order history — GET /api/paycrest/orders (SIWE-protected, Bearer token).
// HistoryOrder mirrors web's PaycrestHistoryOrder (display fields only).
import { apiFetch } from "./client";

export type PaycrestDirection = "offramp" | "onramp";

export interface HistoryOrder {
  id: string;
  direction: PaycrestDirection;
  status: string;
  amount: string;
  token: string;
  network: string;
  rate: string | null;
  currency: string | null;
  fiatAmount: number | null;
  recipientName: string | null;
  institution: string | null;
  accountIdentifier: string | null;
  txHash: string | null;
  createdAt: string | null;
  /** Buy only: open and still waiting for the bank transfer (set by the backend). */
  awaitingPayment?: boolean;
}

export interface OrdersResponse {
  orders: HistoryOrder[];
  address: string;
}

export function fetchOrders(token: string): Promise<OrdersResponse> {
  return apiFetch<OrdersResponse>("/api/paycrest/orders", {
    headers: { Authorization: `Bearer ${token}` },
  });
}
