import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const AGENT_DIR = '/tmp/pi-ui-e2e-agent';
const WORKSPACE = '/tmp/pi-ui-e2e-workspace';

/**
 * Builds a pristine pi agent dir for the live-agent specs on every run:
 *
 * - AGENT_DIR holds only models.json pointing at the local fake LLM
 *   (e2e/fake-llm.ts). Sessions accumulate here during the run but are wiped
 *   next run, so the server never resumes a session left mid-turn by an
 *   earlier killed test — resuming such a session wedges the composer.
 * - WORKSPACE is the server's PI_CWD: a bare dir with no .pi/ resources, so
 *   pi neither shows the project-trust gate nor loads project extensions.
 */
export default function globalSetup(): void {
  for (const dir of [AGENT_DIR, WORKSPACE]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    `${AGENT_DIR}/models.json`,
    JSON.stringify(
      {
        providers: {
          'e2e-fake': {
            name: 'E2E Fake',
            baseUrl: 'http://127.0.0.1:8787/v1',
            apiKey: 'e2e-test-key',
            api: 'openai-completions',
            models: [
              {
                id: 'e2e-fake-model',
                name: 'E2E Fake Model',
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      null,
      2
    ) + '\n'
  );
}
