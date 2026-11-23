'use strict';

/**
 * Small, dependency-free helpers shared by the extension modules.
 */

/** Human readable message for any thrown value. */
function errMsg(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err.message === 'string' && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Promise that resolves with `value` after `ms` milliseconds. */
function delay(ms, value) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

/**
 * Trailing-edge debounce. The returned function has `.cancel()` and `.flush()`.
 */
function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  return debounced;
}

/**
 * Convert an arbitrary value into something JSON can carry
 * (PROTOCOL §5.2 commands.run: try a JSON round trip, else String(value)).
 */
function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? null : JSON.parse(s);
  } catch {
    try {
      return String(value);
    } catch {
      return null;
    }
  }
}

/** Throw a clean error unless `value` is a non-empty string. */
function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing or invalid parameter: ${name}`);
  }
  return value;
}

/** Clamp an optional numeric parameter into [min, max], using `def` when absent/invalid. */
function clampInt(value, min, max, def) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Settle with `promise`, or reject with `Error(message)` (code `DEADLINE`) after `ms` — so a request
 * handler always answers the agent (whose own timeout is 30 s) with a clear error instead of leaving the
 * phone on "Loading…" when VS Code (a file system provider, another extension, a git hook…) does not
 * answer. The underlying operation is not cancelled; it may still complete later.
 */
function withDeadline(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'DEADLINE' })), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Throw a clean error unless `value` is a non-empty array of non-empty strings (at most `max`). */
function requireStringArray(value, name, max = 1000) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new Error(`missing or invalid parameter: ${name} (1-${max} non-empty strings)`);
  }
  return value;
}

module.exports = { errMsg, delay, debounce, jsonSafe, requireString, requireStringArray, clampInt, withDeadline };
