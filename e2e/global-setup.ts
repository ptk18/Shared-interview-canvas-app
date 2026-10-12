import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_BASE_URL, PORT } from './env';

const COMPOSE_FILE = fileURLToPath(new URL('../docker-compose.yaml', import.meta.url));
// A project name of its own keeps the test stack, and its database volume, apart from a dev stack.
const PROJECT = 'sdi-e2e';

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], {
    stdio: 'inherit',
    env: { ...process.env, APP_PORT: PORT },
  });
}

/** Starts the app and Postgres from docker-compose.yaml; the returned function is Playwright's teardown. */
export default function globalSetup(): (() => void) | undefined {
  if (EXTERNAL_BASE_URL) return undefined;
  const down = () => compose('down', '--volumes');
  try {
    // --wait returns once both services pass their health checks, and fails if one never does.
    compose('up', '--build', '--detach', '--wait');
  } catch (error) {
    down();
    throw error;
  }
  return down;
}
