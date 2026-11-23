#!/usr/bin/env node
// Scripted, made-up terminal sessions for the README screenshots (e2e/screenshots.mjs). Nothing here
// calls an AI service, runs a build or touches the network: every line is canned text, drawn to fit
// the terminal's current size and redrawn whenever it changes (phone and laptop views of the same
// terminal have different widths).
//
//   node demo-session.mjs agent   an AI coding-agent session (Claude-Code-like layout, scripted)
//   node demo-session.mjs dev     "npm run dev": a dev server with a request log
//   node demo-session.mjs test    "npm test": a watch-mode test run, all green
//
// It stays on screen until q / Ctrl+C. The screen is redrawn in the alternate buffer, so resizing
// never leaves wrapped leftovers behind.

const mode = process.argv[2] || 'agent';
const out = process.stdout;

/* ------------------------------------------------------------------------------------ styling */

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const fg = (hex) => (s) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`;
const bg = (hex) => (s) => `\x1b[48;2;${rgb(hex)}m${s}\x1b[49m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const dim = fg('#8a8f98');
const faint = fg('#5c6370');
const white = fg('#e6e6e6');
const accent = fg('#d97757'); // warm orange accent of the agent UI
const green = fg('#4ec98a');
const red = fg('#f07178');
const cyan = fg('#5fd7ff');
const yellow = fg('#e5c07b');
const blue = fg('#61afef');
const magenta = fg('#c678dd');
const addBg = bg('#1f3b2a');
const delBg = bg('#4a2328');

/** Visible length (ANSI escapes stripped; every code point counts as one cell). */
const vlen = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - vlen(s)));

/** Cut a plain string to `w` cells (with an ellipsis). */
function cut(s, w) {
  const cps = [...s];
  return cps.length <= w ? s : `${cps.slice(0, Math.max(0, w - 1)).join('')}…`;
}

/** Word-wrap plain text to `w` cells. */
function wrap(text, w) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if (vlen(line) + 1 + vlen(word) <= w) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A rounded box `w` cells wide around plain or styled lines. */
function box(lines, w, color = faint) {
  const inner = w - 4;
  const res = [color(`╭${'─'.repeat(w - 2)}╮`)];
  for (const l of lines) res.push(`${color('│')} ${pad(l, inner)} ${color('│')}`);
  res.push(color(`╰${'─'.repeat(w - 2)}╯`));
  return res;
}

/* ------------------------------------------------------------------------------------ sessions */

function agentScreen(cols) {
  const w = Math.max(30, Math.min(cols - 1, 110));
  const tw = w - 4; // text width after the "● " / "  ⎿  " gutters
  const L = [];
  const bullet = (color, text) => {
    const parts = wrap(text, tw);
    L.push(`${color('●')} ${parts[0]}`);
    for (const p of parts.slice(1)) L.push(`  ${p}`);
  };
  const tool = (name, arg) => L.push(`${green('●')} ${bold(white(name))}${dim('(')}${white(cut(arg, tw - name.length - 2))}${dim(')')}`);
  const result = (text) => {
    const parts = wrap(text, tw - 3);
    L.push(`  ${dim('⎿')}  ${dim(parts[0])}`);
    for (const p of parts.slice(1)) L.push(`     ${dim(p)}`);
  };
  const diff = (n, sign, code) => {
    const num = String(n).padStart(4);
    const body = cut(code, Math.max(8, w - 13));
    const line = pad(` ${num} ${sign} ${body}`, w - 6);
    L.push(`     ${sign === '+' ? addBg(green(line)) : sign === '-' ? delBg(red(line)) : faint(line)}`);
  };

  L.push(...box([
    `${accent('✻')} ${bold(white('Welcome back!'))}`,
    '',
    dim(cut('  /help for help, /status for your current setup', w - 4)),
    '',
    dim(cut('  cwd: C:\\dev\\my-app', w - 4)),
  ], w, accent));
  L.push('');
  // an earlier, short exchange (scrolls away first on small screens)
  L.push(`${dim('>')} ${white(cut('what does GET /health return?', w - 4))}`);
  L.push('');
  bullet(white, '{ ok, uptime, version } — see src/server.ts:14. The load balancer and the uptime monitor poll it.');
  L.push('');
  const ask = wrap('Add rate limiting to /api/todos (120 requests a minute per IP) and cover it with a test', w - 4);
  L.push(`${dim('>')} ${white(ask[0])}`);
  for (const p of ask.slice(1)) L.push(`  ${white(p)}`);
  L.push('');
  bullet(white, "I'll add a small in-memory limiter, wire it into the API router and test the 429 path.");
  L.push('');
  tool('Read', 'src/server.ts');
  result('Read 27 lines');
  L.push('');
  tool('Write', 'src/rateLimit.ts');
  result('Wrote 34 lines to src/rateLimit.ts');
  L.push('');
  tool('Update', 'src/server.ts');
  result('Updated src/server.ts with 1 addition and 1 removal');
  diff(10, ' ', "app.use(express.json());");
  diff(11, '-', "app.use('/api', router);");
  diff(11, '+', "app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }), router);");
  L.push('');
  tool('Bash', 'npm test -- rateLimit');
  result('✓ test/rateLimit.test.ts (3 tests) 41ms');
  L.push(`     ${dim('Tests  ')}${green('3 passed')}${dim(' (3)')}`);
  L.push('');
  bullet(white, 'Done. /api/todos now answers 429 with a Retry-After header after 120 requests a minute per IP, and the 3 new tests pass.');
  L.push('');
  L.push(...box([`${white('>')} ${white('\x1b[7m \x1b[27m')}`], w, faint));
  L.push(`  ${magenta('⏵⏵ accept edits on')} ${dim(cut('(shift+tab to cycle)', Math.max(0, w - 22)))}`);
  return L;
}

function devScreen(cols) {
  const w = Math.max(30, cols - 1);
  const L = [];
  L.push(`${blue('PS C:\\dev\\my-app>')} ${white('npm run dev')}`);
  L.push('');
  L.push(dim('> my-app@1.4.0 dev'));
  L.push(dim('> tsx watch src/server.ts'));
  L.push('');
  const t = (s) => faint(s);
  const req = (time, method, route, status, ms) => {
    const st = status < 400 ? green(String(status)) : status < 500 ? yellow(String(status)) : red(String(status));
    const routeW = Math.max(6, Math.min(18, w - 33));
    L.push(`${t(time)} ${cyan(method.padEnd(6))} ${white(cut(route, routeW).padEnd(routeW))} ${st} ${dim(`${String(ms).padStart(3)} ms`)}`);
  };
  L.push(`${t('10:41:58')} ${green('ready')}  API listening on ${blue('http://localhost:3000')}`);
  req('10:42:03', 'GET', '/api/todos', 200, 12);
  req('10:42:05', 'POST', '/api/todos', 201, 18);
  req('10:42:09', 'GET', '/health', 200, 1);
  req('10:42:10', 'PATCH', '/api/todos/3', 200, 9);
  L.push(`${t('10:42:11')} ${yellow('watch')}  ${dim('src/server.ts changed, restarting…')}`);
  L.push(`${t('10:42:11')} ${green('ready')}  API listening on ${blue('http://localhost:3000')}`);
  req('10:42:14', 'GET', '/api/todos', 200, 8);
  req('10:42:16', 'DELETE', '/api/todos/5', 204, 6);
  req('10:42:21', 'GET', '/api/todos', 429, 2);
  L.push(`${t('10:42:21')} ${yellow('warn')}   ${dim(cut('rate limit hit for 10.0.0.24 (121/120 per min)', Math.max(10, w - 16)))}`);
  return L;
}

function testScreen(cols) {
  const w = Math.max(30, cols - 1);
  const L = [];
  L.push(`${blue('PS C:\\dev\\my-app>')} ${white('npm test')}`);
  L.push('');
  L.push(`${bg('#61afef')(fg('#0b0f14')(bold(' RUN ')))} ${cyan('v2.1.4')} ${dim('C:/dev/my-app')}`);
  L.push('');
  const file = (name, n, ms) => L.push(` ${green('✓')} ${white(cut(name, Math.max(10, w - 22)))} ${dim(`(${n} tests)`)} ${yellow(`${ms}ms`)}`);
  file('test/todos.test.ts', 6, 38);
  file('test/rateLimit.test.ts', 3, 41);
  file('test/logger.test.ts', 2, 5);
  file('test/health.test.ts', 1, 3);
  L.push('');
  L.push(`${dim(' Test Files ')} ${green(bold('4 passed'))} ${dim('(4)')}`);
  L.push(`${dim('      Tests ')} ${green(bold('12 passed'))} ${dim('(12)')}`);
  L.push(`${dim('   Start at ')} 10:44:12`);
  L.push(`${dim('   Duration ')} 612ms ${dim('(transform 88ms, setup 0ms, collect 140ms, tests 87ms)')}`.slice(0, 400));
  L.push('');
  L.push(`${bg('#4ec98a')(fg('#0b0f14')(bold(' PASS ')))} ${green('Waiting for file changes...')}`);
  L.push(`       ${dim('press ')}${white('h')}${dim(' to show help, press ')}${white('q')}${dim(' to quit')}`);
  return L;
}

const screens = { agent: agentScreen, dev: devScreen, test: testScreen };

/* ------------------------------------------------------------------------------------ drawing */

let last = '';
function draw(force = false) {
  let cols = 80;
  let rows = 24;
  try {
    [cols, rows] = out.getWindowSize();
  } catch { /* not a TTY */ }
  const key = `${cols}x${rows}`;
  if (!force && key === last) return;
  last = key;
  const lines = (screens[mode] || agentScreen)(cols);
  // The agent session keeps its input box at the bottom like a full-screen app; logs start at the top.
  const top = mode === 'agent' ? Math.max(0, rows - lines.length) : 0;
  const shown = lines.length > rows ? lines.slice(lines.length - rows) : lines;
  out.write(`\x1b[?25l\x1b[H\x1b[2J${'\r\n'.repeat(mode === 'agent' ? Math.min(top, 1) : 0)}${shown.join('\r\n')}`);
}

out.write('\x1b[?1049h'); // alternate screen
draw(true);
const timer = setInterval(() => draw(), 250);
out.on('resize', () => draw(true));

const quit = () => {
  clearInterval(timer);
  out.write('\x1b[?25h\x1b[?1049l');
  process.exit(0);
};
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const s = d.toString();
    if (s === 'q' || s === '\x03') quit();
    else if (s === '\x0c') draw(true); // Ctrl+L
  });
}
process.on('SIGINT', quit);
