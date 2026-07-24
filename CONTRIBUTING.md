# Contributing

Thanks for helping improve Open Cursor Models.

## Development setup

Requirements:

- Node.js 20 or newer
- Cursor (for end-to-end testing)
- Optional but recommended: [ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

```sh
npm ci
npm run build
```

### Run the extension in Cursor

1. Open this folder in Cursor.
2. Press **F5** (or use the **Run Extension** launch config).
3. In the Extension Development Host, open **Open Cursor Models: Open Models Setup**.

For a watch build while editing:

```sh
npm run watch
```

### Checks before opening a PR

```sh
npm run typecheck
npm test
npm run build
npm run package
```

## Project layout

| Path | Role |
|------|------|
| `src/extension.ts` | Activation, commands, status bar |
| `src/proxyServer.ts` | Local OpenAI/Anthropic/Gemini-compatible proxy |
| `src/tunnelManager.ts` | Public HTTPS tunnel (ngrok / cloudflared) |
| `src/setupWizard.ts` | Setup webview |
| `src/modelStore.ts` | Profiles + SecretStorage |
| `src/*Inbound.ts` / `requestTransform.ts` | Protocol translation |

## Pull requests

- Keep changes focused and explained in the PR description.
- Prefer tests for protocol transforms and URL helpers when you touch them.
- Do not commit secrets, `.env` files, or `.vsix` artifacts.
- This project is **not affiliated with Anysphere or Cursor**. Avoid implying endorsement in copy or branding.

## Reporting bugs

Use GitHub Issues. Include Cursor version, OS, tunnel provider, and relevant Output channel lines (redact keys and prompt content).

Security issues: see [SECURITY.md](SECURITY.md).
