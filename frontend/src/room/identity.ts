// Per-tab participant tokens live in sessionStorage: they survive a refresh (so
// a refreshing participant reclaims their seat) but are not shared with other
// tabs, so two windows of one browser can be the two participants.
const tokenKey = (roomId: string) => `sdi:token:${roomId}`;
const NAME_KEY = 'sdi:name';

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const participantTokens = {
  get: (roomId: string): string | null => safely(() => sessionStorage.getItem(tokenKey(roomId)), null),
  set: (roomId: string, token: string): void => safely(() => sessionStorage.setItem(tokenKey(roomId), token), undefined),
};

export const rememberedName = {
  get: (): string => safely(() => localStorage.getItem(NAME_KEY) ?? '', ''),
  set: (name: string): void => safely(() => localStorage.setItem(NAME_KEY, name), undefined),
};
