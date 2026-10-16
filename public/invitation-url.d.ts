export type InvitationSource = 'canonical' | 'shorthand' | 'session' | null;
export type InvitationNavigation = {
  explicit: boolean;
  valid: boolean;
  code: string;
  source: InvitationSource;
  restored?: boolean;
};

export const invitationStorageKey: string;
export const invitationHistoryKey: string;
export function invitationFromUrl(value: string): InvitationNavigation;
export function storedInvitation(value: string | null): { code: string; flow: string } | null;
export function invitationAtNavigation(value: string, storedValue: string | null, historyState: unknown): InvitationNavigation;
export function invitationFreeUrl(value: string): URL;
export function singleInvitationRedemption<T>(run: (code: string) => Promise<T> | T): (code: string) => Promise<T>;
