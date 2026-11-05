import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_DIR_ENV, piAgentDir } from '../agent-dir';

describe('piAgentDir', () => {
  const original = process.env[AGENT_DIR_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = original;
  });

  it('defaults to ~/.pi/agent', () => {
    delete process.env[AGENT_DIR_ENV];
    expect(piAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
  });

  it('honours PI_CODING_AGENT_DIR like the SDK (test servers use scratch dirs)', () => {
    process.env[AGENT_DIR_ENV] = '/tmp/pi-ui-e2e-agent';
    expect(piAgentDir()).toBe('/tmp/pi-ui-e2e-agent');
    process.env[AGENT_DIR_ENV] = '~/alt-agent';
    expect(piAgentDir()).toBe(join(homedir(), 'alt-agent'));
    process.env[AGENT_DIR_ENV] = 'rel/agent';
    expect(piAgentDir()).toBe(resolve('rel/agent'));
  });

  it('ignores an empty override', () => {
    process.env[AGENT_DIR_ENV] = '  ';
    expect(piAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
  });
});
