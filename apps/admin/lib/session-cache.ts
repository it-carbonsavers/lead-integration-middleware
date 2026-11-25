/**
 * The signed-in user, remembered for this browser tab (sessionStorage), so a page refresh can draw
 * the page and its own loading skeleton straight away instead of waiting for /auth/me first.
 *
 * Only what the UI needs to lay itself out is kept (the same object /auth/me returns; no secrets).
 * The server still checks the session and permissions on every request; this cache only decides
 * what is drawn first, and /auth/me is always fetched again to refresh it. It is cleared on sign-out,
 * on any 401 (expired session) and when the tab closes.
 */

import type { Me } from "./api";

const KEY = "lim.me";

export function readCachedMe(): Me | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function cacheMe(me: Me) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(me));
  } catch {
    // storage unavailable (private mode, blocked): the page just waits for /auth/me
  }
}

export function clearCachedMe() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
