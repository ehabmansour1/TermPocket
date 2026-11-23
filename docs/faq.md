# TermPocket FAQ

Questions people ask about controlling VS Code, terminals and a Windows PC from a phone. Something
missing? [Open a discussion or an issue](https://github.com/ehabmansour1/TermPocket/issues).

- [General](#general)
- [Claude Code and AI coding agents](#claude-code-and-ai-coding-agents)
- [VS Code](#vs-code)
- [Connecting](#connecting)
- [Security and privacy](#security-and-privacy)
- [Alternatives](#alternatives)
- [Screen and Remote Desktop](#screen-and-remote-desktop)
- [Using it day to day](#using-it-day-to-day)
- [بالعربية](#بالعربية)

## General

### What is TermPocket?
A free, open-source way to use your Windows PC from your phone or a laptop browser: real terminals
(PowerShell, cmd, WSL), the VS Code windows already open on your PC (files, editor, Problems, Source
Control, terminals), the screen with mouse and keyboard, and system controls (processes, power,
clipboard). A small agent runs on the PC; the app is an installable web app (PWA) the agent serves.

### How do I control VS Code from my phone?
1. [Install TermPocket](../README.md#install) on the PC (agent + VS Code extension).
2. [Connect your phone](../README.md#connect-your-phone) with Tailscale and scan the pairing QR code.
3. Open the **Code** tab, pick a VS Code window, and browse, edit and save its files; see Problems; run
   commands from the command list. Its terminals are in the **Terminals** tab.

Every VS Code window on the PC connects to the agent by itself.

### Can I use it from another computer, not just a phone?
Yes. Open the same pairing link in Chrome or Edge on a laptop (any OS) and install it as an app. The
desktop layout gives you terminal tabs, a full VS Code workbench (Monaco editor, explorer, Source Control,
Command Palette) and a Remote Desktop mode.

### Does it work on iPhone or iPad?
The app is tested on Android with Chrome and on laptop browsers. iPhone / iPad Safari is untested; it may
work in the browser, but installing it as an app and some keyboard features are not verified.

### Can the PC run macOS or Linux?
Not today. The agent uses Windows APIs (ConPTY, a PowerShell / C# helper for screen, input and system), so
the PC must run Windows 10 or 11. The phone and laptop side runs in any modern browser.

### Is it free? What is the license?
Free and open source under the [MIT license](../LICENSE). There is no paid tier and no hosted service.
Tailscale, which it uses by default, has a free plan for personal use.

### Do I need to install an app from the Play Store?
No. The app is a PWA: open the pairing link in Chrome and choose **Install app** / **Add to Home screen**.
It then opens full-screen like a normal app, and updates itself when you update the agent.

## Claude Code and AI coding agents

### How do I use Claude Code from my phone / Android?
Open the **Terminals** tab, start a new terminal (in your project folder) and run `claude`. It is a real
shell on your PC, so Claude Code works with your files, Git, Node, Python and everything else installed
there. The extra-keys row gives you Esc, Tab, Ctrl, arrows and ^C, which Claude Code's interface needs.

### Will my Claude Code session keep running if my phone locks or loses signal?
Yes. Terminals run on the PC in the *terminals host*, not on the phone. Close the app, switch networks or
lose signal — the session keeps working, and when you come back the terminal reconnects with its full
scrollback. It even survives restarting the TermPocket agent.

### Can I see a Claude Code session I started in a VS Code terminal?
Yes. VS Code's terminals appear under their window in the Terminals tab:

- **Mirrored terminals** (profile *TermPocket (mirrored)*) show everything from the first line, live, and you
  can type into them from both sides. Turn on **Phone-visible VS Code terminals** to make every new VS Code
  terminal mirrored.
- **Ordinary terminals** open in the **Live** view: you see exactly what VS Code draws — Claude Code's
  full-screen interface included — and can type into it. A session that was already running before the
  extension started (for example after a VS Code reload) shows its current screen, and live output from
  the next command on.

### Does it work with other terminal AI agents — Codex CLI, Gemini CLI, Aider, OpenCode…?
Yes. Anything that runs in a Windows terminal runs in TermPocket: it is a real ConPTY shell with 256
colours, true colour and full-screen apps.

### Can I approve Claude Code's prompts or answer its questions from my phone?
Yes — you type into the same terminal, so menus, `y/n` prompts and arrow-key selections work with the
extra-keys row.

## VS Code

### Is this a VS Code in the browser like vscode.dev?
No. TermPocket controls the VS Code windows **already open on your PC**, with your extensions, settings,
language servers and Git. On a laptop the Code tab looks like VS Code (Monaco editor, explorer, Source
Control, Problems, terminal panel, Command Palette), but every action runs in your real VS Code: saving,
diagnostics, commands, commits.

### Do I need VS Code at all?
No. Terminals, Screen and System work without it. The Code tab and VS Code terminals need the extension in
at least one open VS Code window.

### Does it see unsaved changes?
Yes. If a file is open in VS Code, the app reads the editor's current text, and saving writes through VS
Code. On a laptop, Ctrl+S first checks that the file didn't change on the PC meanwhile and asks before
overwriting.

### Can I run VS Code commands, tasks and Git from my phone?
Yes: the Command Palette (laptop) or command list (phone) runs any VS Code command in that window. Source
Control can stage, unstage, discard and commit.

### Does it work with VS Code Insiders, VSCodium, Cursor or other forks?
It is built and tested with VS Code (stable API only, version 1.93+). Forks that can install a `.vsix` may
work but are untested.

### Does it work in remote windows (WSL, SSH, Dev Containers)?
The extension is a UI extension, so it runs on the PC side of a remote window and connects to the agent.
Files and editors work through VS Code; Git status isn't available there (the Git extension runs on the
remote side).

## Connecting

### Does it need port forwarding, a public IP or dynamic DNS?
**No.** With Tailscale, your phone reaches the PC through your private tailnet, even behind CGNAT or
mobile data. With the self-hosted relay, the PC connects *out* to your server. **Never forward port 8765
on your router.**

### Why Tailscale?
It is the simplest secure option: a private WireGuard network between only your devices, with a real HTTPS
certificate for `https://<pc>.<tailnet>.ts.net` through `tailscale serve`. HTTPS is what makes the app
installable, lets it start offline, and enables clipboard sync and keyboard lock. Nothing on your PC is
exposed to the internet.

### Can I use it without Tailscale?
Yes, two ways:

- your own **relay** on a server and domain you control ([docs/relay.md](relay.md)) — for devices that can't
  run Tailscale;
- **LAN only**: set `"host": "0.0.0.0"` in `config.json` and open `http://<pc-ip>:8765` at home. Plain HTTP
  means no app install, no clipboard sync, no keyboard lock, and everyone on that network can reach the
  login. Only on networks you trust.

### Can I use ZeroTier, WireGuard or another VPN instead?
Anything that gives the phone a route to the PC can work, but you lose the automatic HTTPS that
`tailscale serve` gives you. Bind the agent to the VPN address (`"host"`) and add any host name you use to
`allowedHosts`.

### Is there a hosted TermPocket service?
No, by design. Your PC talks to your devices over your tailnet or through a relay **you** run.

### How much data does it use?
Terminals, files and system info use very little. The screen is the heavy part: the default Medium preset
sends 2 fps at 1280 px, typically 20–80 KB per frame and only when something changed; HD Remote Desktop
can use up to about 1.8 MB/s while video plays. Numbers: [user guide](user-guide.md#bandwidth-screen-streaming).

### Can I control several PCs?
Yes. Install the agent on each one; each PC has its own address (its own `*.ts.net` name) and its own
pairing token, so each gets its own installed app.

### Can several phones connect at once?
Yes. They share terminals (each one sees the same output) and each can stream the screen.

## Security and privacy

### Is TermPocket safe?
It is designed to be: the agent listens on localhost only, Tailscale (or your own relay) is the only way
in, every connection needs a 256-bit pairing token, failed logins are rate-limited, DNS-rebinding and
cross-site WebSocket attacks are refused, and the VS Code extension and the terminals host authenticate
with challenge-response so the token never crosses the wire there. The token gives full control of the
PC, so keep it like a password. Full threat model: [security.md](security.md).

### What happens if someone sees my QR code?
They have your token. They would still need to reach the agent (be on your tailnet or relay), but rotate
the token: delete `token` from `config.json`, restart the agent, pair again.
[How](security.md#rotate-the-token-revoke-every-phone).

### Does TermPocket send my code or data anywhere?
No. No telemetry, no analytics, no accounts, no CDN. Traffic goes only between your devices (or through
your own relay).

### Does the agent run as administrator?
No, it runs as you, and it should. Windows then doesn't let it type into apps running as administrator, and
UAC prompts can't be seen or clicked remotely.

### Who can open the dashboard and the pairing page?
Only the PC itself: `/pair`, `/status` and `/monitor` refuse anything that isn't a direct local request.

## Alternatives

### TermPocket vs code-server
[code-server](https://github.com/coder/code-server) runs a separate VS Code server you open in a browser.
TermPocket instead drives the VS Code windows you already have open on your Windows desktop, adds durable
terminals, the screen and system control, and has a phone-first UI. code-server is the better choice for
a headless Linux server.

### TermPocket vs VS Code Remote Tunnels / vscode.dev
Tunnels give you a full VS Code in the browser connected to your machine, through Microsoft's tunnel
service and a GitHub / Microsoft sign-in. TermPocket uses no third-party relay (Tailscale's traffic is
end-to-end encrypted between your devices, or you run your own relay), works with your desktop windows and
terminals as they are, and adds screen and system control. Tunnels' browser UI is not built for phones.

### TermPocket vs Chrome Remote Desktop, AnyDesk, TeamViewer, RDP
Remote-desktop apps send pixels: reading code or a terminal on a phone screen is painful. TermPocket gives
you native terminals and files sized for the phone — and a screen view / Remote Desktop mode when you do
need the desktop. Windows' own RDP also signs your desktop session out of the PC's screen; TermPocket
doesn't.

### TermPocket vs Termius, JuiceSSH or another SSH client
SSH clients need an SSH server on Windows, keys, and a way to reach port 22. Their sessions end when the
connection drops unless you add tmux-like tools. TermPocket needs no SSH server, keeps terminals alive by
itself, and also shows VS Code's terminals, files and the screen.

### TermPocket vs GitHub Codespaces
Codespaces runs your project in the cloud. TermPocket uses your own PC, with your local tools, data and
hardware, for free.

## Screen and Remote Desktop

### Can I see and control the PC's screen?
Yes: the **Screen** tab streams any monitor (or all of them) with touch or trackpad mouse control and a
keyboard. On a laptop, **Remote Desktop mode** gives a full-screen, RDP-like experience with keyboard lock
and clipboard sync.

### Why is the screen black?
UAC prompts and the lock screen run on Windows' secure desktop, which can't be captured. The stream
continues when they close.

### Can I send Ctrl+Alt+Del?
No app can. Use the **Task Manager** button (Ctrl+Shift+Esc), and **Win** / **Alt+Tab**.

### Does it work with two or more monitors?
Yes. Pick a monitor or **All displays**; coordinates follow Windows' display scaling.

## Using it day to day

### Does the PC have to stay awake?
Yes. A sleeping or hibernated PC can't be reached, and TermPocket can't wake it (no Wake-on-LAN). Set
Windows' sleep timer accordingly when you plan to work remotely.

### Does it keep working when the PC is locked?
Terminals, files, VS Code and system actions keep working; the screen view shows nothing until it is
unlocked.

### Does it start automatically?
With `scripts\install-autostart.ps1`, yes: at every logon, hidden, restarted if it crashes. The tray icon
shows whether the phone can reach it.

### How do I update?
Run the [install one-liner](../README.md#one-liner-powershell) again: it upgrades in place, keeps your
pairing, and terminals keep running in the terminals host. From source: `git pull`, `npm install` in
`agent/`, reinstall the `.vsix` and restart the agent. The phone app updates itself on its next start.

### Can I type Arabic or other languages?
Yes. Terminals take whatever your phone's keyboard types, and the Screen keyboard types Unicode text into
the PC.

### I used VS Control before. Do I need to re-pair?
No. TermPocket was called VS Control before 1.0 and keeps your pairing.
[Upgrading from VS Control](user-guide.md#upgrading-from-vs-control).

## بالعربية

<div dir="rtl">

### ما هو TermPocket؟
تطبيق مجاني ومفتوح المصدر للتحكم في جهاز الكمبيوتر بنظام Windows من هاتفك الأندرويد أو من متصفح لابتوب:
طرفيات حقيقية (PowerShell و cmd و WSL)، ونوافذ VS Code المفتوحة على جهازك (الملفات والمحرر والأخطاء و Git
والطرفيات)، وشاشة الكمبيوتر مع الماوس ولوحة المفاتيح، والتحكم في العمليات والطاقة والحافظة.

### كيف أتحكم في VS Code من الهاتف؟
ثبّت TermPocket على الكمبيوتر (الوكيل وإضافة VS Code)، ثم ثبّت Tailscale على الكمبيوتر والهاتف بنفس الحساب،
وشغّل `scripts\setup-tailscale.ps1`، ثم افتح `http://127.0.0.1:8765/pair` على الكمبيوتر وامسح رمز QR بالهاتف.
ستظهر كل نوافذ VS Code في تبويب Code.

### كيف أستخدم Claude Code من الهاتف؟
افتح تبويب Terminals، وأنشئ طرفية جديدة في مجلد مشروعك، واكتب `claude`. الجلسة تعمل على الكمبيوتر نفسه،
لذلك تستمر حتى لو أُغلق الهاتف أو انقطع الإنترنت، وتعود إليها بكل ما فيها.

### هل أحتاج إلى فتح منفذ (Port Forwarding) في الراوتر؟
لا. الاتصال يتم عبر شبكة Tailscale الخاصة بك، أو عبر خادم وسيط (Relay) تستضيفه بنفسك. لا تفتح المنفذ 8765
في الراوتر أبدًا.

### هل هو آمن؟
الوكيل يستمع على الجهاز المحلي فقط، وكل اتصال يحتاج رمز اقتران (Token) عشوائي طوله 256 بت، ومحاولات الدخول
الخاطئة محدودة. لكن رمز الاقتران يعطي تحكمًا كاملًا في الكمبيوتر، فاحفظه مثل كلمة المرور ولا تنشر صورة رمز QR.

### هل يرسل TermPocket بياناتي إلى أي خادم؟
لا. لا توجد خدمة سحابية ولا حسابات ولا تتبع. البيانات تنتقل بين أجهزتك فقط.

### هل يعمل على الآيفون أو على ماك؟
الكمبيوتر يجب أن يعمل بنظام Windows 10 أو 11. التطبيق مُختبَر على أندرويد (Chrome) وعلى متصفحات اللابتوب؛
الآيفون غير مُختبَر.

### هل يمكنني الكتابة بالعربية؟
نعم، في الطرفيات وفي لوحة مفاتيح الشاشة.

</div>
