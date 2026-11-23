# Release tooling

| File | What it does |
|---|---|
| `build-bundle.ps1` | Builds `TermPocket-<ver>-win-x64.zip` (portable `node\node.exe`, agent with production `node_modules` and a verified `@lydell/node-pty` win32-x64 prebuild, `web\` incl. `web\vendor`, `scripts\`, `relay\`, `docs\relay.md`, `termpocket-<ver>.vsix`, LICENSE / README / PROTOCOL / CHANGELOG), plus `install.ps1` and `SHA256SUMS.txt`, in `dist\`. |
| `test-install.ps1` | Smoke test of `scripts\install.ps1` / `scripts\uninstall.ps1` against a built zip, in a temp folder with a temp `TERMPOCKET_HOME`, a free port and dry-run input. It covers a bad checksum, install, `install-autostart.ps1 -DryRun`, the running agent (`/healthz`, `/`, `/vendor/*`, `/pair`), an upgrade over the running install (the terminals host keeps running, and an in-use `node.exe` is replaced), uninstall refusing while a terminal runs, and `uninstall -Force -Purge`. It never registers tasks, never writes the registry or `%APPDATA%\TermPocket`, and never touches VS Code. |
| `check-ps.ps1` | Parse-checks every `.ps1` (nothing is run) and validates `packaging\**\*.json`. |
| `release-notes.mjs` | Prints the release notes: install instructions plus the `## <version>` section of `CHANGELOG.md` (else `vscode-extension/CHANGELOG.md`). |
| `scoop-manifest.mjs` | Fills `packaging/scoop/termpocket.json` with a release's version, URL and SHA-256 (a build artifact; nothing is pushed). |

## Local test (no network)

```powershell
# Reuses agent\node_modules + web\vendor and an existing .vsix. Without -NodeDir there is no bundled node.exe.
powershell -ExecutionPolicy Bypass -File scripts\release\build-bundle.ps1 -UseInstalledModules -Vsix vscode-extension\termpocket.vsix
powershell -ExecutionPolicy Bypass -File scripts\release\test-install.ps1        # uses node on PATH
powershell -ExecutionPolicy Bypass -File scripts\release\check-ps.ps1
```

To bundle an official node.exe that is already on the machine (no download), pass
`-NodeDir "C:\Program Files\nodejs"`.

## Cutting a release

1. Set the same version in `agent/package.json` and `vscode-extension/package.json` (and add a
   `## <version>` section to `CHANGELOG.md`).
2. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
3. `.github/workflows/release.yml` then:
   - downloads the latest official Node.js 24 win-x64 zip and checks it against `SHASUMS256.txt`;
   - packages the extension with `@vscode/vsce`;
   - builds the bundle (`npm ci --omit=dev` in a staging copy of the agent);
   - runs `test-install.ps1` with the bundled `node.exe`;
   - creates the GitHub Release with the zip, the `.vsix`, `install.ps1` and `SHA256SUMS.txt`. The notes come from `release-notes.mjs`, followed by GitHub's generated notes.
4. Optional: with the repository secrets `OVSX_PAT` (Open VSX) and `VSCE_PAT` (VS Code Marketplace,
   publisher `ehabmansour1`), the extension is published there too. Without them those jobs only
   print a notice. Pre-release versions (`1.2.3-beta.1`) are never published to the stores.
5. Scoop: copy the filled manifest (`termpocket.json` in the run's **release-extras** artifact) to
   `bucket/termpocket.json` in [ehabmansour1/scoop-bucket](https://github.com/ehabmansour1/scoop-bucket).
   The README's `scoop install termpocket` works only once that file is in the bucket; after the first
   release Scoop's `checkver` / `autoupdate` keep it current.

"Run workflow" on the Release workflow builds and tests without creating a release. The files and the
filled Scoop manifest are then kept as workflow artifacts.
