# Changelog

## 0.5.3

- Share one proxy and tunnel across every open Cursor window instead of each window starting its own
- Apply model changes made in any window to the shared proxy immediately
- Hand the proxy and tunnel over to another window when the one hosting them closes

## 0.5.0

- Guided setup webview for models, proxy, and Cursor settings
- Local routing proxy with OpenAI-compatible, Anthropic, and Gemini slot adapters
- HTTPS tunnel via ngrok or cloudflared
- Provider API keys stored in Cursor SecretStorage
