@echo off
rem ---------------------------------------------------------------------------
rem  TermPocket - start the PC agent in this console window (Ctrl+C to stop).
rem  Uses the bundled node\node.exe of an installed release, else node on PATH
rem  (git checkout; installs the agent's npm dependencies on first run).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

set "NODE_EXE=node"
if exist "node\node.exe" (
  set "NODE_EXE=%CD%\node\node.exe"
  goto run
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org/
  exit /b 1
)

if not exist "agent\node_modules\ws\package.json" (
  echo Installing agent dependencies...
  pushd agent
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    popd
    echo npm install failed.
    exit /b 1
  )
  popd
)

:run
"%NODE_EXE%" agent\src\index.js %*
exit /b %errorlevel%
