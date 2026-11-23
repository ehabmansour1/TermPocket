# Contributing to TermPocket

Thanks for helping! Bug reports, docs fixes, tests and features are all welcome.

- **Bugs and ideas:** [open an issue](https://github.com/ehabmansour1/TermPocket/issues/new/choose).
- **Security problems:** never in a public issue — see [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first so we can agree on the approach.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE) and you follow
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **[PROTOCOL.md](PROTOCOL.md) is the contract** between the agent, the VS Code extension and the app. A
  change to a message changes PROTOCOL.md in the same pull request, and stays backwards compatible where it
  can (older extensions and agents must keep working or say clearly what to update).
- **No build steps.** The agent is plain ESM JavaScript, the extension plain CommonJS, the app vanilla ES
  modules + CSS. No TypeScript, bundler, framework or CDN.
- **Few dependencies.** The agent uses `ws`, `@lydell/node-pty` (prebuilt — not `node-pty`, which needs a
  compiler), `qrcode-terminal`, and xterm.js / Monaco only for vendoring. Ask before adding one.
- **No custom executables.** Antivirus products block freshly compiled unsigned exes. Native Windows work
  goes through the PowerShell helper (C# loaded with `Add-Type`).
- **Security first.** Remote data is rendered as text, never `innerHTML`. Don't weaken the Host / Origin
  checks, the token handling or the loopback-only pages. Read [docs/security.md](docs/security.md).
- **Never touch the real desktop in tests.** See below.

## Project layout

| Folder | What | Language |
|---|---|---|
| `agent/` | PC agent and terminals host | Node.js 20+ ESM |
| `vscode-extension/` | VS Code extension | CommonJS, stable VS Code API, `^1.93.0` |
| `web/` | The PWA | Vanilla JS / CSS |
| `relay/` | Optional self-hosted relay | Node.js ESM |
| `scripts/` | Autostart, tray monitor, Tailscale setup | PowerShell 5.1 |
| `e2e/` | End-to-end tests | Node.js + `playwright-core` |
| `docs/` | Documentation | Markdown |

How they fit together: [docs/architecture.md](docs/architecture.md).

## Set up

```bat
git clone https://github.com/ehabmansour1/TermPocket.git
cd TermPocket
cd agent && npm install && cd ..
cd vscode-extension && npm install && cd ..
cd e2e && npm install && cd ..
```

`npm install` in `agent/` also copies xterm.js and Monaco into `web/vendor/` (git-ignored).

Run a development agent **without touching your real install**:

```powershell
$env:TERMPOCKET_HOME = "$env:TEMP\termpocket-dev"   # its own config.json and token
$env:TERMPOCKET_PORT = '18765'
$env:TERMPOCKET_DRYRUN_INPUT = '1'                  # mouse, keyboard, power, kill, clipboard-set, open: logged only
node agent\src\index.js
```

With a separate `TERMPOCKET_HOME` the agent also gets its own terminals host pipe, so it never adopts or
stops your real terminals.

## Tests

Run each line on its own from the repository root (in `cmd`):

```bat
cd agent && npm test                       & rem core + system/screen tests (node:test)
cd vscode-extension && npm test            & rem extension tests against a VS Code mock
cd vscode-extension && npm run check       & rem syntax / manifest check
node web\tools\check-refs.mjs --strict     & rem the PWA: references, SW list, manifest, imports, syntax
cd e2e && npm test                         & rem integration: real agent + isolated VS Code + headless Chrome
cd e2e && npm run test:pwa                 & rem the phone app, feature by feature
cd e2e && npm run test:desktop             & rem laptop layout and Remote Desktop mode
cd e2e && npm run test:live                & rem Live view of ordinary VS Code terminals
cd e2e && npm run test:workbench           & rem the desktop Code workbench
cd e2e && npm run test:durable             & rem durable terminals + snapshots, protocol level
cd e2e && npm run test:durable-terminals   & rem durable terminals through the PWA
```

The end-to-end suites are safe to run on your own PC:

- the agent runs in a temporary `TERMPOCKET_HOME` on a test port with `TERMPOCKET_DRYRUN_INPUT=1`;
- VS Code runs as an **isolated instance** (temporary user-data and extensions folders, the extension
  loaded with `--extensionDevelopmentPath`), launched only through `e2e/lib/harness.mjs`, which keeps its
  windows off-screen. Never launch VS Code any other way from a test;
- Chrome is headless (`playwright-core` with `channel: 'chrome'`, no browser download);
- the browser's `navigator.clipboard` is stubbed. The snapshot tests briefly use the Windows clipboard and
  restore its text; they skip that part when the clipboard holds anything but text.

Details per suite: [e2e/README.md](e2e/README.md). Please run the suites that cover your change, and add
tests for new behaviour.

## Demo mode (screenshots and videos)

`TERMPOCKET_DEMO=1` starts the agent with a made-up identity and a synthetic desktop, so screenshots,
videos and docs never show your PC:

```powershell
$env:TERMPOCKET_HOME = "$env:TEMP\termpocket-demo"   # a throw-away config folder (own token)
$env:TERMPOCKET_PORT = '18800'
$env:TERMPOCKET_DEMO = '1'
$env:TERMPOCKET_DEMO_CWD = 'C:\dev\my-app'          # optional: default folder of new terminals
node agent\src\index.js
```

- The PC is reported as **DEV-PC**, user **you**, IP addresses `100.101.102.103` and `10.0.0.24`.
- The **Screen** tab shows `agent/demo/desktop-1920x1080.jpg` / `desktop-1280x720.jpg`: a fake Windows
  desktop drawn in `agent/demo/desktop.html` (not a capture). Regenerate the JPEGs with
  `node agent/demo/make-demo-desktop.mjs` (needs `e2e`'s `npm install` and Chrome or Edge).
- Mouse, keyboard, power, clipboard-set, open and kill are **always dry-run**, and the process list,
  battery and clipboard formats are sample data. The real screen is never captured.
- Terminals, files and VS Code stay real: use a sample project and an isolated VS Code (like
  `e2e/lib/harness.mjs` does) so no personal paths or window titles show up.

README screenshots live in `docs/images/` and must come from demo mode. Never commit screenshots,
logs or fixtures with real host names, user names, paths, IP addresses, domains or tokens.

## Pull requests

1. Branch from `main`; keep a pull request to one topic.
2. Follow the existing style: small modules, comments that explain *why*, no new dependencies without a
   reason.
3. Update PROTOCOL.md for wire changes, the README / docs for user-visible changes, and
   [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
4. Run the tests (list them in the pull request).
5. Fill in the pull request template.

## Building the extension package

```bat
cd vscode-extension
npm install
npx --yes @vscode/vsce package --out termpocket.vsix
```

Release builds (zip, `.vsix`, installer) are made by GitHub Actions from tagged source.
