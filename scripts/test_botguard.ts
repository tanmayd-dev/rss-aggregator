/**
 * Offline checks for the botGuard classifier, host cooldown registry, Shorts link
 * derivation and the bounded-concurrency helper. No network access, no DB writes.
 *
 * Run with: npm run test-botguard
 */
import assert from 'node:assert/strict';
import {
  botCooldownMinutes,
  clearBotCooldowns,
  isBotFlagError,
  isCooling,
  coolingMinutesLeft,
  recordBotFlag,
} from '../src/services/botGuard.js';
import { isShortLink, mapLimit } from '../src/services/scraper.js';

let failed = 0;
let passed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`FAIL - ${name}:`, err?.message ?? err);
  }
}

// Captured from real responses served to this host on 2026-10-22 (YouTube bot
// mitigation served while the client IP was flagged).
const GOOGLE_404_BODY = `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">
  <title>Error 404 (Not Found)!!1</title>`;

const GOOGLE_500_BODY = `<html><head>
  <meta http-equiv="content-type" content="text/html;charset=utf-8">
  <title>Error 500 (Server Error)!!1</title>
</head><body>
  <p>The server encountered an error and could not complete your request.<p>If the problem persists, please <A HREF="http://www.google.com/support/">report</A> your problem and mention this error message and the query that caused it.</p>
  <ins>That’s all we know.</ins></body></html>`;

await check('404!!1 body classifies as bot flag', () => {
  const err: any = { response: { status: 404, data: GOOGLE_404_BODY } };
  assert.equal(isBotFlagError(err), true);
});

await check('500 body (no !!1 title) classifies as bot flag', () => {
  const err: any = { response: { status: 500, data: GOOGLE_500_BODY } };
  assert.equal(isBotFlagError(err), true);
});

await check('pre-tagged error always classifies', () => {
  const err: any = { botFlagged: true, response: { status: 404, data: '' } };
  assert.equal(isBotFlagError(err), true);
});

await check('plain 404 body is NOT a bot flag', () => {
  const err: any = {
    response: { status: 404, data: '<h1>404 Not Found</h1><p>nginx</p>' },
  };
  assert.equal(isBotFlagError(err), false);
});

await check('network error (no response) is NOT a bot flag', () => {
  assert.equal(isBotFlagError(new Error('ECONNRESET')), false);
  assert.equal(isBotFlagError({ response: { status: 404, data: { parsed: false } } }), false);
});

await check('other 500 responses that are not Google-shaped do NOT classify', () => {
  const err: any = { response: { status: 502, data: '<html><body>Bad Gateway</body></html>' } };
  assert.equal(isBotFlagError(err), false);
});

await check('cooldown registry pauses and expires', async () => {
  clearBotCooldowns();
  process.env.BOT_COOLDOWN_MINUTES = '30';
  const t0 = Date.now();
  recordBotFlag('www.youtube.com', t0);
  assert.equal(isCooling('WWW.YouTube.com', t0 + 1000), true); // case-insensitive
  assert.equal(coolingMinutesLeft('www.youtube.com', t0), 30);
  assert.equal(coolingMinutesLeft('www.youtube.com', t0 + 31 * 60_000), 0);
  assert.equal(isCooling('example.com', t0), false);

  // A second flag during the pause extends it instead of resetting it.
  recordBotFlag('www.youtube.com', t0 + 10 * 60_000);
  assert.equal(isCooling('www.youtube.com', t0 + 20 * 60_000), true);
  delete process.env.BOT_COOLDOWN_MINUTES;
});

await check('botCooldownMinutes falls back to the default', () => {
  delete process.env.BOT_COOLDOWN_MINUTES;
  assert.equal(botCooldownMinutes(), 45);
});

await check('isShortLink derives the flag from feed links', () => {
  assert.equal(isShortLink('https://www.youtube.com/shorts/RK4UVg08wt0'), true);

  assert.equal(
    isShortLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygEIRA%3D%3D'),
    false
  );
  assert.equal(isShortLink('https://youtu.be/dQw4w9WgXcQ'), false);

  // Ambiguous → null (caller may consult cache/HEAD fallback)
  assert.equal(isShortLink('https://example.com/video'), null);
  assert.equal(isShortLink(''), null);
  assert.equal(isShortLink(undefined), null);

  // Query strings must not defeat the match
  assert.equal(isShortLink('https://www.youtube.com/shorts/rHgCRGNbG_Q?feature=share'), true);
  assert.equal(isShortLink('youtu.be/abc'), null); // too short to be a video id
});

await check('mapLimit preserves order and respects the cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.equal(peak, 3);
});

console.log(failed === 0 ? `\nAll ${passed} checks passed.` : `\n${failed} of ${passed + failed} checks failed.`);
process.exitCode = failed === 0 ? 0 : 1;
