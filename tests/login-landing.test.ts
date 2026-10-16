import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
const source = await Bun.file(new URL('../public/app.js', import.meta.url)).text();
const entry = source.match(/async function enterAfterSignIn\(\)\{[^\n]+\}/)![0];
async function navigate(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const context = { pendingCode: '', selectedWorkshop: '', requestedProjectId: null, screen: '', joinCodeError: '',
    workshopsPage: async () => calls.push('workshops'), page: async () => calls.push('workshop'),
    connect: () => calls.push('connect'), openRequestedProject: async () => calls.push('project'),
    redeemJoinCode: async () => calls.push('redeem'), render: () => calls.push('render'),
    toast: () => calls.push('toast'), ...overrides };
  await runInNewContext(entry + ';enterAfterSignIn()', context);
  return { calls, context };
}
test('ordinary sign-in and session restore land on Workshops for users and administrators', async () => {
  for (const admin of [false, true]) expect((await navigate({ me: { admin } })).calls).toEqual(['workshops']);
  expect(source.match(/await enterAfterSignIn\(\)/g)?.length).toBeGreaterThanOrEqual(3);
});
test('explicit workshop and project destinations retain workshop navigation', async () => {
  for (const input of [{ selectedWorkshop: 'workshop-id' }, { requestedProjectId: 'project-id' }])
    expect((await navigate(input)).calls).toEqual(['workshop', 'connect', 'project']);
});
test('invitation redemption takes precedence; failed codes retain the join form', async () => {
  expect((await navigate({ pendingCode: '123456' })).calls).toEqual(['redeem', 'project']);
  const failed = await navigate({ pendingCode: '123456', redeemJoinCode: async () => { throw Error('Invalid code'); } });
  expect(failed.context.screen).toBe('join-code');
  expect(failed.calls).toEqual(['render', 'toast']);
});
test('malformed invitation navigation keeps the authenticated profile on the retry surface', async () => {
  const result = await navigate({ joinCodeError: 'Invalid invitation link' });
  expect(result.context.screen).toBe('join-code');
  expect(result.calls).toEqual(['render']);
});
test('entry form puts the optional code before both authentication choices without a join button', () => {
  const start = source.match(/if \(screen === 'start'\)[^\n]+/)![0];
  expect(start.indexOf('entryJoinCodeField()')).toBeLessThan(start.indexOf("button('signup'"));
  expect(start.indexOf("button('signup'")).toBeLessThan(start.indexOf("button('login'"));
  expect(start).toContain('Create a New Profile');
  expect(start).not.toContain('Join with code');
  const field = source.match(/function entryJoinCodeField\(\)\{[^\n]+\}/)![0];
  expect(field).toContain('Canvas Code <span>(optional)</span>');
  expect(field).not.toContain('<button');
});
test('both entry choices capture and preserve a code before authentication', () => {
  expect(source).toContain("if (action === 'signup') { captureEntryJoinCode();");
  expect(source).toContain("if (action === 'login') { captureEntryJoinCode();");
  expect(source).toContain("After authentication, join with code");
  expect(source).toContain("joinCodeError=error.message;screen='join-code'");
});
test('choosing Workshops clears old deep links, selection and the workshop connection', async () => {
  const body = source.match(/async function workshopsPage\(\) \{[\s\S]*?\n\}/)![0];
  const calls: string[] = [];
  const context = { URL, nappletHost: { revoke: () => calls.push('revoke') }, detail: {}, selectedWorkshop: 'old', requestedProjectId: 'old-project',
    reconnectTimer: 1, clearTimeout: () => {}, socket: { close: () => calls.push('close') }, subscribedRequest: 'old',
    location: { href: 'https://example.test/?workshop=old&project=old-project&other=keep' },
    history: { replaceState: (_state: unknown, _title: unknown, url: URL) => calls.push(url.search) },
    api: async () => ({ workshops: [] }), workshops: [], screen: '', menu: true, createWorkshop: true, render: () => calls.push('render'),
    workshopsLoadEpoch:0,workshopsLoading:false,workshopsLoadError:'',cachedWorkshops:()=>[],cacheWorkshops:()=>{},AbortSignal };
  await runInNewContext(body + ';workshopsPage()', context);
  expect(context.selectedWorkshop).toBe('');expect(context.requestedProjectId).toBeNull();expect(context.socket).toBeNull();
  expect(context.screen).toBe('workshops');expect(calls).toEqual(['revoke', 'close', '?other=keep', 'render', 'render']);
});
