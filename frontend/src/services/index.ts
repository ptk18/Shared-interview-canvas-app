import { createContext, useContext } from 'react';
import { createHttpBackend } from './http/httpBackend';
import { createMockBackend } from './mock';
import type { BackendService } from './types';

export type { BackendService } from './types';
export { ApiError } from './types';

/** Picks the backend for this build: `VITE_BACKEND=mock` (see `npm run dev:mock`) or the FastAPI server. */
export function createBackend(): BackendService {
  return import.meta.env.VITE_BACKEND === 'mock' ? createMockBackend() : createHttpBackend();
}

export const BackendContext = createContext<BackendService | null>(null);

export function useBackend(): BackendService {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error('useBackend() must be used inside <BackendContext.Provider>.');
  return backend;
}
