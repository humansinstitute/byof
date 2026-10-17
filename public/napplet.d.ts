export type CashuWallet = {
  name: string;
  mint: string;
  unit: 'sat' | 'msat';
  balance: number;
  pendingBalance: number;
  limits: { maxBalance: number | null; maxSend: number | null; maxPay: number | null } | null;
};

export type CashuDeposit = {
  quote: string;
  invoice: string;
  state: 'UNPAID' | 'PAID' | 'ISSUED' | 'EXPIRED';
  expiry: number | null;
};

export type CashuStatus =
  | { connected: true; wallet: CashuWallet; deposit: CashuDeposit | null }
  | { connected: false; state: 'none' | 'creating' | 'uncertain' };

export interface ManagedCashuCapability {
  status(): Promise<CashuStatus>;
  connect(): Promise<{ connected: true; wallet: CashuWallet }>;
  createDeposit(amount: number): Promise<CashuDeposit>;
  checkDeposit(quote: string): Promise<CashuDeposit>;
  disconnect(): Promise<{ connected: false; forgotten: boolean; upstreamDeleted: false }>;
}

export interface FreedomNappletApi {
  readonly version: 1;
  capabilities(): Promise<Record<string, unknown>>;
  readonly cashu: ManagedCashuCapability;
  readonly identity: { getPublicKey(): Promise<string> };
  readonly signing: { signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<Record<string, unknown>> };
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  readonly relay: { query(options: unknown): Promise<unknown>; subscribe(options: unknown, callbacks: unknown): Promise<{ id: string; close(): Promise<void> }> };
  readonly datasets: { open(binding: unknown): Promise<unknown> };
}

declare global {
  interface Window { readonly napplet: FreedomNappletApi }
  const napplet: FreedomNappletApi;
}
