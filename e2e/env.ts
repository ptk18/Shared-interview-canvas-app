// E2E_BASE_URL points the tests at a stack that is already running; otherwise global-setup.ts
// starts docker-compose.yaml on E2E_PORT, away from the 8080 a dev stack would use.
export const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;
export const PORT = process.env.E2E_PORT ?? '8180';
export const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;
