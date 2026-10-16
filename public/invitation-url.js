export const invitationStorageKey = 'freedom-invitation-flow';
export const invitationHistoryKey = 'freedomInvitationFlow';

const validCode = value => /^\d{6}$/.test(value);
const shorthandKey = value => /^code-\d*$/.test(value);

export function invitationFromUrl(value) {
  const url = new URL(value, 'https://invitation.invalid/');
  const canonical = url.searchParams.getAll('code');
  const shorthand = [...url.searchParams].filter(([key]) => shorthandKey(key));
  if (canonical.length) {
    const code = canonical[0];
    return { explicit:true, valid:validCode(code), code:validCode(code) ? code : '', source:'canonical' };
  }
  if (shorthand.length) {
    const [key, parameterValue] = shorthand[0], code = key.slice('code-'.length);
    const valid = parameterValue === '' && validCode(code);
    return { explicit:true, valid, code:valid ? code : '', source:'shorthand' };
  }
  return { explicit:false, valid:false, code:'', source:null };
}

export function storedInvitation(value) {
  try {
    const parsed = JSON.parse(value || 'null');
    return parsed && validCode(parsed.code) && typeof parsed.flow === 'string' && parsed.flow ? parsed : null;
  } catch { return null; }
}

export function invitationAtNavigation(value, storedValue, historyState) {
  const current = invitationFromUrl(value);
  if (current.explicit) return { ...current, restored:false };
  const stored = storedInvitation(storedValue);
  const flow = historyState && typeof historyState === 'object' ? historyState[invitationHistoryKey] : null;
  if (stored && stored.flow === flow) return { explicit:false, valid:true, code:stored.code, source:'session', restored:true };
  return { explicit:false, valid:false, code:'', source:null, restored:false };
}

export function invitationFreeUrl(value) {
  const url = new URL(value);
  url.searchParams.delete('code');
  for (const key of [...url.searchParams.keys()]) if (shorthandKey(key)) url.searchParams.delete(key);
  return url;
}

export function singleInvitationRedemption(run) {
  let active = null;
  return code => {
    if (active?.code === code) return active.promise;
    const promise = Promise.resolve().then(() => run(code));
    active = { code, promise };
    void promise.finally(() => { if (active?.promise === promise) active = null; }).catch(() => {});
    return promise;
  };
}
