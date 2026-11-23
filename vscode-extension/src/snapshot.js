'use strict';

/**
 * Screen snapshot of an ordinary VS Code terminal (PROTOCOL §5.2 `terminals.snapshot`, §5.2.1).
 *
 * The stable API cannot read a terminal's buffer, so a phone opening a terminal whose output was never
 * captured (a program started before TermPocket watched it, no shell integration…) would see nothing.
 * VS Code's own terminal commands can, though: select all → copy → read the clipboard. This module
 * runs that sequence on one terminal and puts everything back the way it was:
 *
 *   1. remember window.activeTerminal and the clipboard text;
 *   2. write a unique marker to the clipboard (to tell "copy did nothing" from "copied text");
 *   3. terminal.show(true)  (preserveFocus: the editor keeps the keyboard), wait until it is active;
 *   4. workbench.action.terminal.selectAll → workbench.action.terminal.copySelection → read clipboard;
 *   5. finally: workbench.action.terminal.clearSelection, restore the clipboard text, re-show the
 *      previously active terminal (preserveFocus).
 *
 * Snapshots are serialized (one at a time: they share the clipboard and the active terminal) and
 * bounded (~1 s budget, each step time-limited). The result is plain text (no colours) with `\n` line
 * ends and trailing blank lines removed. Setting `termpocket.terminalSnapshot: false` disables it.
 * Only clipboard TEXT can be restored, so a snapshot is never taken while the clipboard holds anything
 * else (an image, files, rich text): the agent reports the clipboard's formats (`clipboard.info`, never its
 * text). Against an agent without `clipboard.info` an empty text read counts as "maybe an image" and the
 * snapshot is skipped too. Limit: the terminal panel becomes visible on the PC while the snapshot is taken.
 */

const vscode = require('vscode');
const crypto = require('crypto');

const BUDGET_MS = 1200;
const ACTIVATE_WAIT_MS = 400;
const STEP_MS = 400;
const MAX_TEXT = 4 * 1024 * 1024; // characters

const CMD_SELECT_ALL = 'workbench.action.terminal.selectAll';
const CMD_COPY = 'workbench.action.terminal.copySelection';
const CMD_CLEAR = 'workbench.action.terminal.clearSelection';

class SnapshotError extends Error {}

/** Resolve `p`, or reject after `ms` with a SnapshotError. */
function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SnapshotError(`${what} timed out`)), Math.max(1, ms));
    }),
  ]);
}

/** Normalize copied terminal text: \n line ends, no trailing spaces, no trailing blank lines. */
function cleanText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

class TerminalSnapshots {
  /**
   * @param {object} deps
   * @param {object} deps.log
   * @param {() => boolean} [deps.enabled]   setting termpocket.terminalSnapshot (default true)
   * @param {() => number} [deps.now]
   * @param {() => Promise<boolean|null>} [deps.clipboardRestorable]  true: the clipboard holds only text (a
   *        text restore is faithful) · false: it holds an image / files / rich text · null: unknown
   */
  constructor({ log, enabled, now, clipboardRestorable } = {}) {
    this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
    this.enabled = enabled || (() => true);
    this.clipboardRestorable = clipboardRestorable || (async () => null);
    this.now = now || Date.now;
    this._chain = Promise.resolve();
    this.running = 0;
  }

  /**
   * Snapshot `terminal`: {text, cols, rows, lines, at}. Rejects when disabled or when it could not be
   * taken (the reason is in the message). Calls are queued (mutex).
   */
  take(terminal) {
    const run = () => this._take(terminal);
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  /** Like take(), but resolves null instead of rejecting (used by terminals.attach). */
  tryTake(terminal) {
    return this.take(terminal).catch((err) => {
      this.log.info(`terminal snapshot skipped: ${err && err.message ? err.message : err}`);
      return null;
    });
  }

  async _take(terminal) {
    if (!this.enabled()) throw new SnapshotError('terminal snapshots are turned off (termpocket.terminalSnapshot)');
    if (!terminal || terminal.exitStatus) throw new SnapshotError('the terminal is closed');
    const clip = vscode.env && vscode.env.clipboard;
    if (!clip || typeof clip.readText !== 'function' || typeof clip.writeText !== 'function') throw new SnapshotError('no clipboard access');
    this.running++;
    const t0 = this.now();
    const left = () => BUDGET_MS - (this.now() - t0);
    const step = (p, what) => withTimeout(p, Math.min(STEP_MS, left()), what);
    const w = vscode.window;
    const prevActive = w.activeTerminal;
    let prevClip;
    try {
      // Never destroy what a text-only restore cannot bring back (an image, copied files, rich text).
      let restorable = null;
      try {
        restorable = await step(this.clipboardRestorable(), 'checking the clipboard');
      } catch {
        restorable = null;
      }
      if (restorable === false) throw new SnapshotError('the clipboard holds an image, files or rich text; not touching it');
      prevClip = await step(clip.readText(), 'reading the clipboard');
      if (restorable !== true && !prevClip) throw new SnapshotError('the clipboard may hold an image or files; not touching it');
    } catch (err) {
      this.running--;
      throw err; // nothing changed yet
    }
    const marker = `⁣termpocket-snapshot-${crypto.randomBytes(8).toString('hex')}⁣`;
    let selected = false;
    let clipWritten = false;
    try {
      await step(clip.writeText(marker), 'writing the clipboard');
      clipWritten = true;
      terminal.show(true);
      const activeBy = this.now() + Math.min(ACTIVATE_WAIT_MS, left());
      while (w.activeTerminal !== terminal) {
        if (this.now() >= activeBy) throw new SnapshotError('the terminal did not become active');
        await new Promise((r) => setTimeout(r, 10));
      }
      selected = true;
      await step(vscode.commands.executeCommand(CMD_SELECT_ALL), 'select all');
      await step(vscode.commands.executeCommand(CMD_COPY), 'copy');
      let text = await step(clip.readText(), 'reading the copied text');
      if (typeof text !== 'string' || text === marker) throw new SnapshotError('nothing was copied');
      if (text.length > MAX_TEXT) text = text.slice(text.length - MAX_TEXT);
      const lines = cleanText(text);
      let cols = null;
      let rows = null;
      try {
        const d = terminal.dimensions;
        if (d && d.columns > 0 && d.rows > 0) {
          cols = d.columns;
          rows = d.rows;
        }
      } catch {
        /* unknown */
      }
      return { text: lines.join('\n'), cols, rows, lines: lines.length, at: this.now() };
    } finally {
      // Put everything back, whatever happened above (each step best-effort and bounded).
      if (selected) await withTimeout(vscode.commands.executeCommand(CMD_CLEAR), STEP_MS, 'clear selection').catch(() => {});
      if (clipWritten) {
        await withTimeout(clip.writeText(typeof prevClip === 'string' ? prevClip : ''), STEP_MS, 'restoring the clipboard').catch((err) =>
          this.log.warn(`could not restore the clipboard after a terminal snapshot: ${err.message}`)
        );
      }
      if (prevActive && prevActive !== terminal && !prevActive.exitStatus) {
        try {
          prevActive.show(true);
        } catch {
          /* closed meanwhile */
        }
      }
      this.running--;
    }
  }
}

module.exports = { TerminalSnapshots, SnapshotError, cleanText, CMD_SELECT_ALL, CMD_COPY, CMD_CLEAR, BUDGET_MS };
