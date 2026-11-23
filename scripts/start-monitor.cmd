@echo off
rem ---------------------------------------------------------------------------
rem  TermPocket Monitor - tray icon that shows whether the TermPocket agent and
rem  the phone link work (green = all good, amber = public link problem,
rem  red = agent not running). Left-click the icon for the dashboard,
rem  right-click for the menu. Only one copy runs at a time.
rem  Test mode:  scripts\start-monitor.cmd -Once [-Json]
rem              (prints the state; exit code 0 green, 1 amber, 2 red)
rem ---------------------------------------------------------------------------
setlocal
if /i "%~1"=="-Once" goto once
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0monitor-tray.ps1" %*
exit /b 0

:once
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0monitor-tray.ps1" %*
exit /b %errorlevel%
