/**
 * Google/YouTube bot-flag detection and per-host cooldown.
 *
 * YouTube intermittently serves fake "Error 404 (Not Found)!!1" / "Error 500 (Server
 * Error)!!1" pages to requests it does not like (rate, UA history, IP reputation) even
 * for channels that exist. Retrying such answers within a minute — or re-attempting
 * every failing source on the normal 5-minute backoff — keeps that flag hot and can
 * harden into a full block of the feeds endpoint for the client IP (as observed
 * 2026-10-22 after a prolonged fetch outage).
 *
 * When a response classifies as a bot page we tag the error (`botFlagged`) and pause
 * fetches to the whole host for a cooldown instead. Deferred sources are skipped by the
 * tick (not counted as attempted), so the adaptive budget does not ramp on cooldown
 * churn. On cooldown expiry, a single source attempt per host re-flags (or un-pauses)
 * naturally.
 *
 * Cooldown state is in memory only. A service restart while flagged does not re-burst
 * flagged hosts, because every source whose fetch failed gets its `nextRefreshAt`
 * pushed past the cooldown by feedManager.saveFailure().
 */

/** Default pause applied to a host once a bot-flag response is seen (minutes). */
export const DEFAULT_COOLDOWN_MINUTES = 45;

/** Signature of Google's generic error pages ("Error 404 (Not Found)!!1", AFAIK any status). */
const BOT_PAGE_TITLE = /<title>Error\s+\d+\s*\([^)]{0,100}\)!!1<\/title>/i;
/** The GFE 500 body ("The server encountered an error...") as a second, independent marker. */
const BOT_PAGE_BODY =
  /The server encountered an error and could not complete your request|google\.com\/support/i;

export function isBotFlagError(error: unknown): boolean {
  const err = error as any;
  const status = err?.response?.status;
  if (!status) return false;
  if (err?.botFlagged === true) return true;
  const body = typeof err?.response?.data === 'string' ? err.response.data : '';
  if (BOT_PAGE_TITLE.test(body)) return true;
  if (status >= 500 && BOT_PAGE_BODY.test(body)) return true;
  return false;
}

/** Minutes a flagged host is paused. `BOT_COOLDOWN_MINUTES` env override (minimum 1). */
export function botCooldownMinutes(): number {
  const parsed = parseInt(process.env.BOT_COOLDOWN_MINUTES ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_COOLDOWN_MINUTES;
}

const cooldownUntil = new Map<string, number>();

/**
 * Pause fetches to `host`. Repeated flags extend the pause instead of resetting it.
 */
export function recordBotFlag(host: string, now: number = Date.now()): void {
  const key = host.toLowerCase();
  const candidate = now + botCooldownMinutes() * 60_000;
  const until = Math.max(cooldownUntil.get(key) ?? 0, candidate);
  if (until > now) {
    cooldownUntil.set(key, until);
    console.log(
      `[botGuard] ${key} served a bot-flag page; pausing fetches to it for ~` +
        `${coolingMinutesLeft(key, now)} min (until ${new Date(until).toISOString()})`
    );
  }
}

export function isCooling(host: string, now: number = Date.now()): boolean {
  const until = cooldownUntil.get(host.toLowerCase());
  return until !== undefined && until > now;
}

/** Whole minutes the host stays paused (0 = not cooling). */
export function coolingMinutesLeft(host: string, now: number = Date.now()): number {
  const until = cooldownUntil.get(host.toLowerCase());
  if (until === undefined || until <= now) return 0;
  return Math.ceil((until - now) / 60_000);
}

/** Test helper: forget all cooldowns. */
export function clearBotCooldowns(): void {
  cooldownUntil.clear();
}
