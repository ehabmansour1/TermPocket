# Security policy

TermPocket gives remote control of a Windows PC, so security reports are taken seriously and handled
first.

## Supported versions

| Version | Supported |
|---|---|
| 1.x (latest release) | ✅ |
| VS Control 0.x (before the rename) | ❌ — please update |

Fixes go into the latest release. Always run the newest agent **and** VS Code extension together.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately through GitHub: open
[**Security → Report a vulnerability**](https://github.com/ehabmansour1/TermPocket/security/advisories/new)
on this repository. Include:

- what an attacker needs (network position: tailnet, relay, LAN, a web page in the victim's browser, a
  local process; whether they need the pairing token);
- what they get;
- steps to reproduce, ideally against a test agent (`TERMPOCKET_HOME` set to a temporary folder,
  `TERMPOCKET_DRYRUN_INPUT=1`);
- the TermPocket, Windows, Node.js and VS Code versions.

You should get an answer within a few days. Once a fix is released, the advisory is published with credit
to you, unless you prefer otherwise. Please give a reasonable time to fix the issue before disclosing it.

## In scope

- Getting access to the agent (terminals, files, screen, input, system actions) **without** the pairing
  token, or bypassing the failed-login rate limit.
- DNS-rebinding or cross-site attacks from a web page against the agent, `/pair`, `/status` or `/monitor`.
- Making the VS Code extension talk to a server other than the agent, or leak the token.
- Reaching the terminals host pipe without its secret.
- Leaking the token or the relay key in logs, the dashboard, the tray or error messages.
- Relay bugs that let a client reach a PC without the relay key, or one client read another's traffic.
- Injection of markup or script into the app from data the PC sends.

## Out of scope

- Anything that requires the pairing token: the token is full control by design.
- Malware or another administrator already running on the PC, or a compromised phone.
- A relay server operated by someone you don't trust (documented: it can read what it carries).
- Exposing the agent against the documentation (port forwarding, `tailscale funnel`, `"host": "0.0.0.0"` on
  untrusted networks).
- Missing hardening headers without a concrete attack.

The full threat model is in [docs/security.md](docs/security.md).
