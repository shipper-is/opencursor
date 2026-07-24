# Security Policy

## Supported versions

Security fixes are applied to the latest released version on `main`.

## Reporting a vulnerability

Do **not** open a public GitHub issue for security reports.

Email **mattmichel17@gmail.com** with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept when practical
- Affected version or commit if known

You should receive an acknowledgment within a few days. Please give us a reasonable window to investigate and ship a fix before any public disclosure.

## Threat model (summary)

Open Cursor Models runs a **local** HTTP proxy on `127.0.0.1` and, when started, creates a **public HTTPS tunnel** so Cursor can reach it.

| Asset | Handling |
|-------|----------|
| Provider API keys | Stored in Cursor SecretStorage; loaded into memory while the proxy runs |
| Generated proxy key | Stored in SecretStorage; required on every proxied request |
| Prompt / response bodies | Forwarded to the configured upstream provider **and** transit the chosen tunnel provider |

### What this means for you

1. **Anyone with the public Base URL and proxy key can call your models.** Treat the proxy key like a password. Do not commit it or paste it into public chats.
2. **Tunnel providers (ngrok or Cloudflare) can see traffic** on the public path. Prefer a tunnel you trust.
3. **Upstream providers receive your prompts and keys** according to their own policies.
4. **This project does not phone home.** There is no maintainer telemetry. Logging stays in Cursor’s local Output channel when enabled.
5. **HTTP upstream URLs are discouraged.** Prefer HTTPS so provider keys are not sent in cleartext.

## Hardening tips

- Keep request logging off unless you are debugging (`openCursorModels.logRequests`).
- Restart the proxy after rotating keys.
- Disable or delete unused models so their keys are removed from SecretStorage.
- If a tunnel URL leaks, stop the proxy and rotate the OpenCursor proxy key by clearing the extension’s secret storage (or reinstalling) and updating Cursor’s API key field.
