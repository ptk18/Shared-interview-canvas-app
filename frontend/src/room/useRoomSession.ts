import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BackendService } from '../services/types';
import { participantTokens } from './identity';
import { RoomSession, type RoomState, type TokenStore } from './roomSession';

const noSubscribe = () => () => {};
const noState = () => null;

/**
 * Owns a RoomSession for as long as the component is mounted with a name.
 * Bumping `generation` tears the session down and joins again.
 */
export function useRoomSession(
  backend: BackendService,
  roomId: string,
  name: string | null,
  generation = 0,
  tokens: TokenStore = participantTokens,
): { session: RoomSession | null; state: RoomState | null } {
  const [session, setSession] = useState<RoomSession | null>(null);

  useEffect(() => {
    if (!name) return;
    const s = new RoomSession({ backend, roomId, name, tokens });
    // Connect on the next tick: a mount that is torn down immediately (React
    // StrictMode's double effect) must not open a socket, or the server would
    // reserve a participant slot for a connection that never got its token.
    const timer = setTimeout(() => s.start(), 0);
    setSession(s);
    return () => {
      clearTimeout(timer);
      s.dispose();
      setSession(null);
    };
  }, [backend, roomId, name, generation, tokens]);

  const state = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getState ?? noState);
  return { session, state };
}
