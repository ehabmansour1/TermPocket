// Builder C's workbench parts, registered on the shell (shell.js) in VS Code's order:
//   panel views  PROBLEMS (problems.js) · TERMINAL (wbterminal.js)
//   quick input  Command Palette / Quick Open / Go to Line (palette.js)
//   side bar     SEARCH (search.js) · SOURCE CONTROL (scm.js)
//   status bar   remote, branch/sync, problems, Ln/Col, indentation, encoding, EOL, language, bell
//
// register(wb) registers only the panel views; registerAll(wb) is the one-call bootstrap the shell
// can use for every C module. Each part is guarded, so one failing part never takes the others (or
// the shell) down.

import { ensureCss } from './c-common.js';
import { register as registerProblems } from './problems.js';
import { register as registerTerminal } from './wbterminal.js';
import { register as registerPalette } from './palette.js';
import { register as registerScm } from './scm.js';
import { register as registerSearch } from './search.js';
import { register as registerStatus } from './statusbar.js';

function guarded(name, fn, wb) {
  try {
    return fn(wb);
  } catch (err) {
    console.error(`[wb] ${name} failed to register`, err);
    return null;
  }
}

/** Panel views: PROBLEMS and TERMINAL. */
export function register(wb) {
  ensureCss();
  return {
    problems: guarded('problems', registerProblems, wb),
    terminal: guarded('terminal', registerTerminal, wb),
  };
}

/** Everything builder C provides (palette first: the other parts may open quick inputs). */
export function registerAll(wb) {
  ensureCss();
  const out = {};
  out.palette = guarded('palette', registerPalette, wb);
  Object.assign(out, register(wb));
  out.search = guarded('search', registerSearch, wb);
  out.scm = guarded('scm', registerScm, wb);
  out.status = guarded('statusbar', registerStatus, wb);
  return out;
}
