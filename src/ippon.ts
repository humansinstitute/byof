import type { Database } from 'bun:sqlite';
import type { Member } from './auth.ts';
import type { Workshop } from './workshop.ts';
import type { NappletData } from './napplet-data.ts';
import { demand, HttpError } from './errors.ts';
import encodeQR from 'qr';

type IpponFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Scope = { workshop: string; project: string; user: string };
type WalletView = {
  name: string;
  mint: string;
  unit: 'sat' | 'msat';
  balance: number;
  pendingBalance: number;
  limits: { maxBalance: number | null; maxSend: number | null; maxPay: number | null } | null;
};
type DepositView = { quote: string; invoice: string; qr: string; state: 'UNPAID' | 'PAID' | 'ISSUED' | 'EXPIRED'; expiry: number | null };
type PaymentView = { quote: string; amount: number; feeReserve: number; state: 'UNPAID' | 'PENDING' | 'PAID'; paymentPreimage: string | null; expiry: number };
type PaymentInput = { destinationType: 'bolt11' | 'lightningAddress'; destination: string; amount: number };
type PaymentPreview = PaymentInput & { confirmationToken: string; unit: 'sat' | 'msat'; expiresAt: number };

const DEFAULT_BASE = 'https://ippon.minibits.cash';
const MAX_RESPONSE_BYTES = 64 * 1024;
const QUOTE = /^[A-Za-z0-9_-]{8,200}$/;
const ACCESS_KEY = /^[A-Za-z0-9_-]{6,256}$/;
const DEPOSIT_STATES = new Set(['UNPAID', 'PAID', 'ISSUED', 'EXPIRED']);
const PAYMENT_STATES = new Set(['UNPAID', 'PENDING', 'PAID']);
const LIGHTNING_ADDRESS = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const INSUFFICIENT_MELT_BALANCE = /^Insufficient balance for melt: \d+ < \d+$/;
const INSUFFICIENT_BALANCE_MESSAGE = 'Not enough balance to cover the payment and Lightning fee. Add a few sats or send a smaller amount.';

function recognizedPaymentError(path: string, method: 'GET' | 'POST', status: number, body: string) {
  if (path !== '/v1/wallet/pay' || method !== 'POST' || status !== 400) return null;
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  const error = parsed.error;
  if (error && !Array.isArray(error) && typeof error === 'object' && error.statusCode === 400 && error.name === 'VALIDATION_ERROR'
    && typeof error.message === 'string' && INSUFFICIENT_MELT_BALANCE.test(error.message)) return INSUFFICIENT_BALANCE_MESSAGE;
  return null;
}

export function ipponBaseUrl(value = DEFAULT_BASE) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('FREEDOM_IPPON_BASE_URL must be a valid HTTPS Ippon origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('FREEDOM_IPPON_BASE_URL must be an HTTPS origin without credentials, path, query or fragment');
  return url.origin;
}

function integer(value: unknown, name: string) {
  demand(Number.isSafeInteger(value) && (value as number) >= 0, 502, `Wallet service returned an invalid ${name}`);
  return value as number;
}
function nullableLimit(value: unknown, name: string) {
  if (value === null) return null;
  return integer(value, name);
}
function walletView(value: any): WalletView {
  demand(value && !Array.isArray(value) && typeof value === 'object', 502, 'Wallet service returned an invalid wallet');
  demand(typeof value.name === 'string' && value.name.length <= 200, 502, 'Wallet service returned an invalid wallet name');
  demand(typeof value.mint === 'string' && value.mint.length <= 2048, 502, 'Wallet service returned an invalid wallet mint');
  demand(value.unit === 'sat' || value.unit === 'msat', 502, 'Wallet service returned an invalid wallet unit');
  let limits = null;
  if (value.limits !== null && value.limits !== undefined) {
    demand(value.limits && !Array.isArray(value.limits) && typeof value.limits === 'object', 502, 'Wallet service returned invalid wallet limits');
    limits = {
      maxBalance: nullableLimit(value.limits.max_balance, 'maximum balance'),
      maxSend: nullableLimit(value.limits.max_send, 'maximum send amount'),
      maxPay: nullableLimit(value.limits.max_pay, 'maximum payment amount'),
    };
  }
  return {
    name: value.name,
    mint: value.mint,
    unit: value.unit,
    balance: integer(value.balance, 'wallet balance'),
    pendingBalance: integer(value.pending_balance, 'pending balance'),
    limits,
  };
}
function depositView(value: any): DepositView {
  demand(value && !Array.isArray(value) && typeof value === 'object', 502, 'Wallet service returned an invalid deposit');
  demand(typeof value.quote === 'string' && QUOTE.test(value.quote), 502, 'Wallet service returned an invalid deposit quote');
  demand(typeof value.request === 'string' && value.request.length >= 20 && value.request.length <= 8192 && /^ln[a-z0-9]+$/i.test(value.request), 502, 'Wallet service returned an invalid Lightning invoice');
  demand(typeof value.state === 'string' && DEPOSIT_STATES.has(value.state), 502, 'Wallet service returned an invalid deposit state');
  demand(value.expiry === null || Number.isSafeInteger(value.expiry) && value.expiry >= 0, 502, 'Wallet service returned an invalid deposit expiry');
  return { quote: value.quote, invoice: value.request, qr: encodeQR('lightning:' + value.request, 'data-url', { scale: 3, border: 4, ecc: 'medium' }), state: value.state, expiry: value.expiry } as DepositView;
}
function paymentInput(value: any): PaymentInput {
  demand(value && !Array.isArray(value) && typeof value === 'object', 400, 'Expected a payment destination and amount');
  const allowed = ['bolt11Request', 'lightningAddress', 'amount'];
  demand(Object.keys(value).every(key => allowed.includes(key)), 400, 'Unexpected payment field');
  demand(Number.isSafeInteger(value.amount) && value.amount >= 1 && value.amount <= 100_000, 400, 'Payment amount must be a whole number from 1 to 100000 wallet units');
  const hasBolt11 = typeof value.bolt11Request === 'string', hasAddress = typeof value.lightningAddress === 'string';
  demand(hasBolt11 !== hasAddress, 400, 'Supply exactly one BOLT11 invoice or Lightning address');
  if (hasBolt11) {
    const destination = value.bolt11Request.trim();
    demand(destination.length >= 20 && destination.length <= 8192 && /^ln(?:bc|tb|bcrt|sb)[0-9a-z]+$/i.test(destination) && (destination === destination.toLowerCase() || destination === destination.toUpperCase()), 400, 'BOLT11 invoice is invalid');
    return { destinationType: 'bolt11', destination, amount: value.amount };
  }
  const destination = value.lightningAddress.trim();
  demand(destination.length <= 254 && LIGHTNING_ADDRESS.test(destination), 400, 'Lightning address is invalid');
  const at = destination.lastIndexOf('@'), normalized = destination.slice(0, at) + '@' + destination.slice(at + 1).toLowerCase();
  return { destinationType: 'lightningAddress', destination: normalized, amount: value.amount };
}
function paymentView(value: any): PaymentView {
  demand(value && !Array.isArray(value) && typeof value === 'object', 502, 'Wallet service returned an invalid payment');
  demand(typeof value.quote === 'string' && QUOTE.test(value.quote), 502, 'Wallet service returned an invalid payment quote');
  demand(typeof value.state === 'string' && PAYMENT_STATES.has(value.state), 502, 'Wallet service returned an invalid payment state');
  demand(value.payment_preimage === null || typeof value.payment_preimage === 'string' && value.payment_preimage.length <= 8192, 502, 'Wallet service returned an invalid payment preimage');
  return { quote: value.quote, amount: integer(value.amount, 'payment amount'), feeReserve: integer(value.fee_reserve, 'payment fee reserve'), state: value.state, paymentPreimage: value.payment_preimage, expiry: integer(value.expiry, 'payment expiry') } as PaymentView;
}

export class IpponCapability {
  private active = 0;
  private connects = new Map<string, Promise<any>>();
  private paymentPreviews = new Map<string, PaymentPreview & { scopeKey: string }>();
  private previewByScope = new Map<string, string>();
  private payments = new Set<string>();
  readonly baseUrl: string;
  constructor(private db: Database, private data: NappletData, options: { baseUrl?: string; fetch?: IpponFetch; timeoutMs?: number } = {}) {
    this.baseUrl = ipponBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    db.exec(`CREATE TABLE IF NOT EXISTS ippon_wallets(
      workshop_id TEXT NOT NULL REFERENCES workshops(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      user_pubkey TEXT NOT NULL REFERENCES members(pubkey),
      state TEXT NOT NULL CHECK(state IN ('creating','ready','uncertain')),
      operation_id TEXT NOT NULL,
      access_key TEXT,
      wallet_name TEXT,
      mint TEXT,
      unit TEXT CHECK(unit IN ('sat','msat')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workshop_id,project_id,user_pubkey)
    );
    CREATE TABLE IF NOT EXISTS ippon_deposit_quotes(
      workshop_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_pubkey TEXT NOT NULL,
      quote TEXT NOT NULL,
      invoice TEXT NOT NULL,
      state TEXT NOT NULL,
      expiry INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workshop_id,project_id,user_pubkey,quote),
      FOREIGN KEY(workshop_id,project_id,user_pubkey) REFERENCES ippon_wallets(workshop_id,project_id,user_pubkey) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ippon_payment_quotes(
      workshop_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_pubkey TEXT NOT NULL,
      quote TEXT NOT NULL,
      destination_type TEXT NOT NULL CHECK(destination_type IN ('bolt11','lightningAddress')),
      destination TEXT NOT NULL,
      amount INTEGER NOT NULL,
      unit TEXT NOT NULL CHECK(unit IN ('sat','msat')),
      fee_reserve INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('UNPAID','PENDING','PAID')),
      payment_preimage TEXT,
      expiry INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workshop_id,project_id,user_pubkey,quote),
      FOREIGN KEY(workshop_id,project_id,user_pubkey) REFERENCES ippon_wallets(workshop_id,project_id,user_pubkey) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS ippon_wallet_project_scope BEFORE INSERT ON ippon_wallets
    WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workshop_id=NEW.workshop_id)
    BEGIN SELECT RAISE(ABORT,'Ippon wallet project mismatch'); END;`);
  }
  private fetcher: IpponFetch;
  private timeoutMs: number;
  private key(scope: Scope) { return `${scope.workshop}:${scope.project}:${scope.user}`; }
  private clearExpiredPreviews() {
    const now = Date.now();
    for (const [token, preview] of this.paymentPreviews) if (preview.expiresAt <= now) {
      this.paymentPreviews.delete(token);
      if (this.previewByScope.get(preview.scopeKey) === token) this.previewByScope.delete(preview.scopeKey);
    }
  }
  private row(scope: Scope) {
    return this.db.query('SELECT * FROM ippon_wallets WHERE workshop_id=? AND project_id=? AND user_pubkey=?').get(scope.workshop, scope.project, scope.user) as any;
  }
  private latestDeposit(scope: Scope): DepositView | null {
    const row = this.db.query('SELECT quote,invoice,state,expiry FROM ippon_deposit_quotes WHERE workshop_id=? AND project_id=? AND user_pubkey=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(scope.workshop, scope.project, scope.user) as any;
    return row ? { quote: row.quote, invoice: row.invoice, qr: encodeQR('lightning:' + row.invoice, 'data-url', { scale: 3, border: 4, ecc: 'medium' }), state: row.state, expiry: row.expiry } : null;
  }
  private scope(workshop: Workshop, member: Member, sessionHash: string, token: unknown): Scope {
    demand(typeof token === 'string', 400, 'Bridge token required');
    const binding = this.data.authorize(workshop, member, sessionHash, token);
    return { workshop: binding.workshop, project: binding.project, user: binding.user };
  }
  private async request(path: '/v1/wallet' | '/v1/wallet/deposit' | string, method: 'GET' | 'POST', accessKey?: string, body?: object) {
    demand(this.active < 16, 429, 'Managed Cashu service is busy; retry shortly');
    this.active++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.baseUrl + path, {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(accessKey ? { authorization: `Bearer ${accessKey}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        throw new HttpError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'Wallet service timed out; retry shortly' : 'Wallet service could not be reached; retry shortly');
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new HttpError(502, 'Wallet service response exceeded the safe size limit'); }
        chunks.push(next.value);
      }
      const responseBody = Buffer.concat(chunks).toString('utf8');
      if (!response.ok) {
        if (response.status === 404) throw new HttpError(404, 'Wallet record was not found');
        if (response.status === 401 || response.status === 403) throw new HttpError(502, 'Wallet authorization was rejected; disconnect it and connect a new wallet');
        if (response.status === 429) throw new HttpError(503, 'Wallet service is busy; retry shortly');
        const recognized = recognizedPaymentError(path, method, response.status, responseBody);
        if (recognized) throw new HttpError(400, recognized);
        throw new HttpError(502, response.status >= 500 ? 'Wallet service is unavailable; retry later' : 'Wallet service rejected the request');
      }
      let parsed: any;
      try { parsed = JSON.parse(responseBody); }
      catch { throw new HttpError(502, 'Wallet service returned malformed JSON'); }
      demand(parsed && !Array.isArray(parsed) && typeof parsed === 'object', 502, 'Wallet service returned malformed JSON');
      return parsed;
    } finally { clearTimeout(timer); this.active--; }
  }
  private ready(scope: Scope) {
    const row = this.row(scope);
    demand(row?.state === 'ready' && typeof row.access_key === 'string' && ACCESS_KEY.test(row.access_key), 409, 'No managed Cashu wallet is connected');
    return row;
  }
  private async connect(scope: Scope) {
    const mapKey = this.key(scope), existing = this.connects.get(mapKey);
    if (existing) return existing;
    const operation = this.connectInner(scope).finally(() => this.connects.delete(mapKey));
    this.connects.set(mapKey, operation);
    return operation;
  }
  private async connectInner(scope: Scope) {
    const existing = this.row(scope), now = Math.floor(Date.now() / 1000);
    if (existing?.state === 'ready') return { connected: true, wallet: await this.wallet(scope) };
    if (existing?.state === 'uncertain') throw new HttpError(409, 'A previous wallet creation had an uncertain outcome; forget it before explicitly connecting again');
    if (existing?.state === 'creating' && now - existing.updated_at < 120) throw new HttpError(409, 'Managed wallet connection is already starting; retry shortly');
    if (existing?.state === 'creating') {
      this.db.run("UPDATE ippon_wallets SET state='uncertain',updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=?", [now, scope.workshop, scope.project, scope.user]);
      throw new HttpError(409, 'A previous wallet creation had an uncertain outcome; forget it before explicitly connecting again');
    }
    const operationId = crypto.randomUUID();
    this.db.run("INSERT INTO ippon_wallets(workshop_id,project_id,user_pubkey,state,operation_id,updated_at) VALUES(?,?,?,'creating',?,?)", [scope.workshop, scope.project, scope.user, operationId, now]);
    try {
      const upstream = await this.request('/v1/wallet', 'POST', undefined, { name: 'Arcade wallet' });
      demand(typeof upstream.access_key === 'string' && ACCESS_KEY.test(upstream.access_key), 502, 'Wallet service returned an invalid wallet credential');
      const view = walletView(upstream);
      const saved = this.db.run("UPDATE ippon_wallets SET state='ready',access_key=?,wallet_name=?,mint=?,unit=?,updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND operation_id=? AND state='creating'", [upstream.access_key, view.name, view.mint, view.unit, Math.floor(Date.now() / 1000), scope.workshop, scope.project, scope.user, operationId]);
      demand(saved.changes === 1, 409, 'Managed wallet connection was cancelled');
      return { connected: true, wallet: view };
    } catch (error) {
      this.db.run("UPDATE ippon_wallets SET state='uncertain',access_key=NULL,updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND operation_id=? AND state='creating'", [Math.floor(Date.now() / 1000), scope.workshop, scope.project, scope.user, operationId]);
      throw error;
    }
  }
  private async wallet(scope: Scope): Promise<WalletView> {
    const row = this.ready(scope), view = walletView(await this.request('/v1/wallet', 'GET', row.access_key));
    this.db.run('UPDATE ippon_wallets SET wallet_name=?,mint=?,unit=?,updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=?', [view.name, view.mint, view.unit, Math.floor(Date.now() / 1000), scope.workshop, scope.project, scope.user]);
    return view;
  }
  async operate(workshop: Workshop, member: Member, sessionHash: string, body: any) {
    demand(body && !Array.isArray(body) && typeof body === 'object', 400, 'Expected a Cashu operation');
    demand(typeof body.method === 'string' && typeof body.token === 'string', 400, 'Cashu method and bridge token required');
    demand(['status', 'connect', 'disconnect', 'createDeposit', 'checkDeposit', 'paymentPreview', 'cancelPaymentPreview', 'pay', 'checkPayment'].includes(body.method), 400, 'Unknown Cashu method');
    const allowed = body.method === 'createDeposit' ? ['token', 'method', 'amount']
      : body.method === 'checkDeposit' || body.method === 'checkPayment' ? ['token', 'method', 'quote']
      : body.method === 'paymentPreview' ? ['token', 'method', 'bolt11Request', 'lightningAddress', 'amount']
      : body.method === 'cancelPaymentPreview' ? ['token', 'method', 'confirmationToken']
      : body.method === 'pay' ? ['token', 'method', 'confirmationToken', 'bolt11Request', 'lightningAddress', 'amount', 'unit']
      : ['token', 'method'];
    demand(Object.keys(body).every(key => allowed.includes(key)), 400, 'Unexpected Cashu field');
    const scope = this.scope(workshop, member, sessionHash, body.token), row = this.row(scope);
    if (body.method === 'status') {
      if (!row) return { connected: false, state: 'none' };
      if (row.state !== 'ready') return { connected: false, state: row.state };
      return { connected: true, wallet: await this.wallet(scope), deposit: this.latestDeposit(scope) };
    }
    if (body.method === 'connect') return this.connect(scope);
    if (body.method === 'disconnect') {
      const scopeKey = this.key(scope), previewToken = this.previewByScope.get(scopeKey);
      if (previewToken) this.paymentPreviews.delete(previewToken);
      this.previewByScope.delete(scopeKey);
      this.db.transaction(() => {
        this.db.run('DELETE FROM ippon_deposit_quotes WHERE workshop_id=? AND project_id=? AND user_pubkey=?', [scope.workshop, scope.project, scope.user]);
        this.db.run('DELETE FROM ippon_payment_quotes WHERE workshop_id=? AND project_id=? AND user_pubkey=?', [scope.workshop, scope.project, scope.user]);
        this.db.run('DELETE FROM ippon_wallets WHERE workshop_id=? AND project_id=? AND user_pubkey=?', [scope.workshop, scope.project, scope.user]);
      }).immediate();
      return { connected: false, forgotten: !!row, upstreamDeleted: false };
    }
    const ready = this.ready(scope);
    if (body.method === 'paymentPreview') {
      this.clearExpiredPreviews();
      const scopeKey = this.key(scope);
      demand(!this.previewByScope.has(scopeKey) && !this.payments.has(scopeKey), 409, 'Another payment confirmation is already open');
      const input = paymentInput({ ...(body.bolt11Request === undefined ? {} : { bolt11Request: body.bolt11Request }), ...(body.lightningAddress === undefined ? {} : { lightningAddress: body.lightningAddress }), amount: body.amount }), confirmationToken = crypto.randomUUID();
      const preview = { ...input, confirmationToken, unit: ready.unit as 'sat' | 'msat', expiresAt: Date.now() + 55_000, scopeKey };
      this.paymentPreviews.set(confirmationToken, preview); this.previewByScope.set(scopeKey, confirmationToken);
      return { confirmationToken, destinationType: input.destinationType, destination: input.destination, amount: input.amount, unit: preview.unit, expiresAt: preview.expiresAt };
    }
    if (body.method === 'cancelPaymentPreview') {
      demand(typeof body.confirmationToken === 'string', 400, 'Payment confirmation token required');
      const preview = this.paymentPreviews.get(body.confirmationToken), scopeKey = this.key(scope);
      if (preview?.scopeKey === scopeKey) { this.paymentPreviews.delete(body.confirmationToken); if (this.previewByScope.get(scopeKey) === body.confirmationToken) this.previewByScope.delete(scopeKey); }
      return { cancelled: true };
    }
    if (body.method === 'pay') {
      this.clearExpiredPreviews();
      const input = paymentInput({ ...(body.bolt11Request === undefined ? {} : { bolt11Request: body.bolt11Request }), ...(body.lightningAddress === undefined ? {} : { lightningAddress: body.lightningAddress }), amount: body.amount }), scopeKey = this.key(scope), preview = typeof body.confirmationToken === 'string' ? this.paymentPreviews.get(body.confirmationToken) : undefined;
      demand(preview && preview.scopeKey === scopeKey && preview.expiresAt > Date.now() && preview.destinationType === input.destinationType && preview.destination === input.destination && preview.amount === input.amount && preview.unit === body.unit && ready.unit === body.unit, 403, 'Payment confirmation is missing, expired or stale');
      demand(!this.payments.has(scopeKey), 409, 'Another payment is already being processed');
      this.paymentPreviews.delete(body.confirmationToken); if (this.previewByScope.get(scopeKey) === body.confirmationToken) this.previewByScope.delete(scopeKey);
      this.payments.add(scopeKey);
      try {
        const upstreamBody = input.destinationType === 'bolt11' ? { bolt11_request: input.destination, amount: input.amount, unit: ready.unit } : { lightning_address: input.destination, amount: input.amount, unit: ready.unit };
        const payment = paymentView(await this.request('/v1/wallet/pay', 'POST', ready.access_key, upstreamBody));
        demand(payment.amount === input.amount, 502, 'Wallet service returned a mismatched payment amount');
        this.db.run(`INSERT INTO ippon_payment_quotes(workshop_id,project_id,user_pubkey,quote,destination_type,destination,amount,unit,fee_reserve,state,payment_preimage,expiry,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workshop_id,project_id,user_pubkey,quote) DO UPDATE SET fee_reserve=excluded.fee_reserve,state=excluded.state,payment_preimage=excluded.payment_preimage,expiry=excluded.expiry,updated_at=excluded.updated_at`, [scope.workshop, scope.project, scope.user, payment.quote, input.destinationType, input.destination, payment.amount, ready.unit, payment.feeReserve, payment.state, payment.paymentPreimage, payment.expiry, Math.floor(Date.now() / 1000)]);
        return payment;
      } finally { this.payments.delete(scopeKey); }
    }
    if (body.method === 'checkPayment') {
      demand(typeof body.quote === 'string' && QUOTE.test(body.quote), 400, 'Payment quote is invalid');
      const known = this.db.query('SELECT quote,amount FROM ippon_payment_quotes WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND quote=?').get(scope.workshop, scope.project, scope.user, body.quote) as any;
      demand(known, 404, 'Payment quote was not found');
      const payment = paymentView(await this.request(`/v1/wallet/pay/${encodeURIComponent(body.quote)}`, 'GET', ready.access_key));
      demand(payment.quote === body.quote && payment.amount === known.amount, 502, 'Wallet service returned mismatched payment details');
      this.db.run('UPDATE ippon_payment_quotes SET fee_reserve=?,state=?,payment_preimage=?,expiry=?,updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND quote=?', [payment.feeReserve, payment.state, payment.paymentPreimage, payment.expiry, Math.floor(Date.now() / 1000), scope.workshop, scope.project, scope.user, body.quote]);
      return payment;
    }
    if (body.method === 'createDeposit') {
      demand(Number.isSafeInteger(body.amount) && body.amount >= 1 && body.amount <= 100_000, 400, 'Deposit amount must be a whole number from 1 to 100000 wallet units');
      const deposit = depositView(await this.request('/v1/wallet/deposit', 'POST', ready.access_key, { amount: body.amount, unit: ready.unit }));
      this.db.run(`INSERT INTO ippon_deposit_quotes(workshop_id,project_id,user_pubkey,quote,invoice,state,expiry,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(workshop_id,project_id,user_pubkey,quote) DO UPDATE SET invoice=excluded.invoice,state=excluded.state,expiry=excluded.expiry,updated_at=excluded.updated_at`, [scope.workshop, scope.project, scope.user, deposit.quote, deposit.invoice, deposit.state, deposit.expiry, Math.floor(Date.now() / 1000)]);
      return deposit;
    }
    if (body.method === 'checkDeposit') {
      demand(typeof body.quote === 'string' && QUOTE.test(body.quote), 400, 'Deposit quote is invalid');
      const known = this.db.query('SELECT quote FROM ippon_deposit_quotes WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND quote=?').get(scope.workshop, scope.project, scope.user, body.quote);
      demand(known, 404, 'Managed deposit quote was not found');
      const deposit = depositView(await this.request(`/v1/wallet/deposit/${encodeURIComponent(body.quote)}`, 'GET', ready.access_key));
      demand(deposit.quote === body.quote, 502, 'Wallet service returned a mismatched deposit quote');
      this.db.run('UPDATE ippon_deposit_quotes SET invoice=?,state=?,expiry=?,updated_at=? WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND quote=?', [deposit.invoice, deposit.state, deposit.expiry, Math.floor(Date.now() / 1000), scope.workshop, scope.project, scope.user, body.quote]);
      return deposit;
    }
    throw new HttpError(400, 'Unknown Cashu method');
  }
}
