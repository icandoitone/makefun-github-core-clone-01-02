// The entrypoint: start the forge, tell the environment where it listens,
// then wait until the environment says the trial is over.
//
// The environment's origin comes from MAKEFUN_ENV_URL. The forge binds port
// 0 so the kernel picks a free port (never 8080, which the environment
// owns), registers that port with POST /register, and polls GET /done until
// it answers {"done": true}. A register or poll that fails is retried with a
// short exponential backoff; the process only exits once the environment
// says done, and then it exits 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no environment to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Announce the bound port to the environment. A 200 accepts it; a 409 means
 * another entry already registered first, which is not ours to fix. A 400
 * or 405 is a contract error and ends the program; anything else is retried,
 * since the environment may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet: it is not done, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

/** Close the listener and drop any connections still in flight, then resolve. */
function shutdown(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  const server = createApp();
  // If the trial runner stops the process, shut the listener down cleanly
  // rather than leaving the port held by a half-dead process.
  const onSignal = (): void => {
    void shutdown(server).finally(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the environment to say done\n');
  await waitForDone();
  await shutdown(server);
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
