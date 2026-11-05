/**
 * pi-ui's on-disk state directory — the same directory the pi SDK uses
 * (`getAgentDir()`), resolved without loading the SDK so cold-start modules
 * (auth, registries) can use it.
 *
 * Honouring `PI_CODING_AGENT_DIR` matters: e2e/live test servers and smoke
 * runs point it at a scratch dir. When pi-ui hard-coded `~/.pi/agent`, those
 * runs overwrote the real session-scan cache with an empty index and leaked
 * scratch projects into the production project list.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

export function piAgentDir(): string {
  const env = process.env[AGENT_DIR_ENV]?.trim();
  if (env) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return resolve(env);
  }
  return join(homedir(), '.pi', 'agent');
}
