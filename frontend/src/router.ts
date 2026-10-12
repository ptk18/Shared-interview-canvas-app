import { useSyncExternalStore } from 'react';

// Two routes don't justify a router dependency: `/` and `/r/:roomId`.
const NAVIGATE_EVENT = 'sdi:navigate';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export type Route = { name: 'home' } | { name: 'room'; roomId: string } | { name: 'not_found' };

export function matchRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  const room = /^\/r\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (room?.[1]) return { name: 'room', roomId: room[1] };
  return { name: 'not_found' };
}

export const roomPath = (roomId: string) => `/r/${roomId}`;
export const roomUrl = (roomId: string) => `${window.location.origin}${roomPath(roomId)}`;
