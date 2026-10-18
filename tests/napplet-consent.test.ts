import { expect, test } from 'bun:test';

const canvasSource = await Bun.file('public/canvas-host.js').text();
const canvasApi: {
  datasetDisplayName: (name: string) => string;
  canvasDomain: (ports: any) => { execute: (binding: any, method: string, params: any, signal: AbortSignal) => Promise<any> };
} = new Function(canvasSource.replaceAll('export ', '') + ';return {datasetDisplayName,canvasDomain};')();
const { datasetDisplayName, canvasDomain } = canvasApi;

test('dataset permission language turns technical names into friendly titles', () => {
  expect(datasetDisplayName('anonymous-troll-box')).toBe('Anonymous Troll Box');
  expect(datasetDisplayName('shared_notes')).toBe('Shared Notes');
});

test('shared dataset open bypasses consent while private open still requires it', async () => {
  const consent: string[] = [], backendCalls: any[] = [], binding: any = {};
  const domain = canvasDomain({
    context: () => ({}),
    backend: async (_binding: any, action: string, body: any) => {
      backendCalls.push({ action, body });
      return { handle: `handle-${backendCalls.length}`, binding: body.dataset, schema: {} };
    },
    ask: async (_binding: any, kind: string) => { consent.push(kind); },
    assert: () => {},
    error: (code: string, message: string) => Object.assign(new Error(message), { code }),
    close: () => {},
  });
  const signal = new AbortController().signal;
  await domain.execute(binding, 'datasets.open', { dataset: { name: 'shared_notes', visibility: 'shared' } }, signal);
  expect(consent).toEqual([]);
  expect(backendCalls).toHaveLength(1);
  await domain.execute(binding, 'datasets.open', { dataset: { name: 'private_notes', visibility: 'private' } }, signal);
  expect(consent).toEqual(['dataset']);
  expect(backendCalls).toHaveLength(2);
});

test('private dataset permission keeps technical identifiers behind details', async () => {
  const source = await Bun.file('public/napplet-host.js').text();
  expect(source).toContain("`Open ${datasetLabel}?`");
  expect(source).toContain('saved privately for you on this Canvas');
  expect(source).toContain('only while this Napplet channel is active');
  expect(source).toContain("label.textContent=kind==='dataset'?'Technical details':'Inspect app binding'");
  expect(source).toContain("kind==='dataset'?details.append(pre):dialog.append(pre)");
  expect(source).toContain("deny.textContent=kind==='dataset'?'Not now':'Deny'");
  expect(source).toContain("allow.textContent=kind==='dataset'?'Open'");
});

test('outgoing payments use trusted exact-context confirmation and hold a single lock through submission', async () => {
  const source = await Bun.file('public/napplet-host.js').text();
  expect(source).toContain("if(!b.identityGranted){await ask(b,'identity',null,signal)");
  expect(source).toContain("await ask(b,'sign',unsigned,signal)");
  expect(source).toContain("kind==='payment'?'Approve wallet payment?'");
  expect(source).toContain("Wallet funds will leave your account.");
  expect(source).toContain("Amount: ${event.amount} ${event.unit}");
  expect(source).toContain("destination.textContent=event.destination");
  expect(source).toContain("Confirm the exact app version, Canvas, account, destination and amount before approving.");
  expect(source).toContain("if(paymentPending)throw error('BUSY'");
  expect(source.indexOf("paymentPending=true")).toBeLessThan(source.indexOf("method:'paymentPreview'"));
  expect(source.indexOf("await ask(b,'payment',preview,signal)")).toBeLessThan(source.indexOf("method:'pay',confirmationToken"));
  expect(source).toContain("method:'cancelPaymentPreview'");
  expect(source).not.toContain("METHODS=['cashu.paymentPreview'");
});

test('capability discovery states automatic shared and confirmed private dataset access', async () => {
  const source = await Bun.file('public/napplet-host.js').text();
  expect(source).toContain("datasets:{shared:{automaticOpen:true,requiresCanvasMembership:true},private:{hostConfirmation:true,scope:'canvas-project-user'}");
  expect(source).not.toContain('datasets:{explicitConsent:true');
});
