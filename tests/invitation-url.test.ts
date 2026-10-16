import { expect, test } from 'bun:test';
import { invitationAtNavigation, invitationFreeUrl, invitationHistoryKey, invitationFromUrl, invitationStorageKey, singleInvitationRedemption, storedInvitation } from '../public/invitation-url.js';

const codeA = '000000', codeB = '000001';

test('canonical generated and shorthand invitation URLs accept exact six-digit values', () => {
  expect(invitationFromUrl(`https://example.test/?code=${codeA}`)).toEqual({explicit:true,valid:true,code:codeA,source:'canonical'});
  expect(invitationFromUrl(`https://example.test/?other=kept&code-${codeB}#ignored`)).toEqual({explicit:true,valid:true,code:codeB,source:'shorthand'});
  expect(invitationFromUrl('https://example.test/?code=%30%30%30%30%30%30')).toEqual({explicit:true,valid:true,code:codeA,source:'canonical'});
});

test('canonical first value deterministically wins duplicates and shorthand', () => {
  expect(invitationFromUrl(`https://example.test/?code=${codeA}&code=${codeB}`)).toMatchObject({valid:true,code:codeA,source:'canonical'});
  expect(invitationFromUrl(`https://example.test/?code-${codeB}&code=${codeA}`)).toMatchObject({valid:true,code:codeA,source:'canonical'});
  expect(invitationFromUrl(`https://example.test/?code=bad&code=${codeA}&code-${codeB}`)).toMatchObject({explicit:true,valid:false,code:'',source:'canonical'});
});

test('unrelated parameters and fragments are ignored while malformed explicit invites stay explicit', () => {
  expect(invitationFromUrl(`https://example.test/?other=${codeA}#code=${codeB}`)).toMatchObject({explicit:false,code:''});
  for (const url of ['?code=', '?code=12345', '?code=0000000', '?code=%20' + codeA, '?code-', '?code-12345', `?code-${codeA}=value`])
    expect(invitationFromUrl('https://example.test/' + url)).toMatchObject({explicit:true,valid:false,code:''});
  expect(invitationFromUrl('https://example.test/?code-theme=dark')).toMatchObject({explicit:false,code:''});
});

test('only navigation-scoped structured state restores an invitation', () => {
  const flow = 'synthetic-flow', stored = JSON.stringify({code:codeA,flow});
  expect(storedInvitation(codeA)).toBeNull(); // legacy plaintext is deliberately stale
  expect(invitationAtNavigation('https://example.test/',stored,{[invitationHistoryKey]:flow})).toMatchObject({valid:true,code:codeA,source:'session',restored:true});
  expect(invitationAtNavigation('https://example.test/',stored,null)).toMatchObject({valid:false,code:'',restored:false});
  expect(invitationAtNavigation(`https://example.test/?code=${codeB}`,stored,{[invitationHistoryKey]:flow})).toMatchObject({valid:true,code:codeB,source:'canonical',restored:false});
  expect(invitationAtNavigation('https://example.test/?code=bad',stored,{[invitationHistoryKey]:flow})).toMatchObject({explicit:true,valid:false,code:'',restored:false});
  expect(invitationStorageKey).not.toBe('freedom-join-code');
});

test('successful cleanup removes invitation parameters and preserves unrelated code-prefixed navigation', () => {
  const cleaned = invitationFreeUrl(`https://example.test/path?keep=yes&code=${codeA}&code-${codeB}&code=bad&code-theme=dark#section`);
  expect(cleaned.href).toBe('https://example.test/path?keep=yes&code-theme=dark#section');
});

test('duplicate navigation events share one in-flight redemption and later retries remain possible', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const redeem = singleInvitationRedemption(async code => { calls++; await gate; return code; });
  const first = redeem(codeA), duplicate = redeem(codeA);
  expect(first).toBe(duplicate);expect(calls).toBe(0);
  await Promise.resolve();expect(calls).toBe(1);release();
  expect(await Promise.all([first,duplicate])).toEqual([codeA,codeA]);
  await redeem(codeA);expect(calls).toBe(2);
});
