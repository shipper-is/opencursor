# Open Cursor Models

Use models from OpenAI-compatible or Anthropic APIs inside Cursor. OpenCursor stores each model's provider URL and API key, then routes Cursor requests through one local proxy.

> **Unofficial project.** Open Cursor Models is not affiliated with, endorsed by, or sponsored by Anysphere or Cursor. “Cursor” is a trademark of its respective owners.

## Install

Requirements:

- [Cursor](https://cursor.com) (not vanilla VS Code for the full setup flow)
- Node.js **20** or newer
- An HTTPS tunnel provider on your `PATH`: [ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

macOS, Linux, and Windows are supported. On Windows, install ngrok or cloudflared and ensure they are on your `PATH`.

Run the installer from a clone of this repo:

```sh
./install.sh
```

It checks your Node version, finds the Cursor CLI, builds the extension, and installs it into Cursor. Reload Cursor when it finishes.

Or install without cloning first:

```sh
curl -fsSL https://raw.githubusercontent.com/shipper-is/open-cursor/main/install.sh | bash
```

Set `OPEN_CURSOR_REPO` or `OPEN_CURSOR_REF` if you want the piped installer to build from a different repo or branch.

<details>
<summary>Manual install</summary>

```sh
npm ci
npm run package
```

In Cursor, open Extensions, choose **More Actions → Install from VSIX**, and select the generated `.vsix` file.

</details>

## Setup

Open **Open Cursor Models: Open Models Setup** from the Command Palette, or click **Custom Models** in the status bar. Both open the same setup page.

### 1. Add models

Click **Add model** and enter:

- A display name
- The exact model ID expected by the provider
- The provider API base URL (prefer **HTTPS**)
- The API protocol
- The provider API key

Add as many models as you need. Every model can use a different provider, URL, and API key.

### 2. Start the proxy

Click **Start proxy**. OpenCursor starts:

- A local routing proxy bound to `127.0.0.1`
- A public HTTPS tunnel that Cursor can reach

Wait for the setup page to show **Proxy and tunnel are running**. The extension starts the proxy automatically on future Cursor launches when at least one model is enabled.

### 3. Set the Base URL and API key in Cursor

The setup page defaults to the **Google API Key** slot so the OpenAI and Anthropic slots remain available. You can change the slot from the dropdown.

In **Cursor Settings → Models**:

1. Enable **Override OpenAI Base URL** and paste the Base URL from OpenCursor.
2. Paste the generated OpenCursor proxy key into **Google API Key**.
3. Enable **Google API Key**.

If you selected a different slot in OpenCursor, use and enable that provider's API key field instead.

Use the generated proxy key here—not a real provider key. Provider keys stay stored per model in Cursor's secure secret storage.

### 4. Add the model names to Cursor

In **Cursor Settings → Models**, choose **Add model** and paste each exact model name shown in step 4 of the OpenCursor setup page.

Your models are now available in Cursor's model picker.

## Manage models

Use the same setup page to add, test, edit, disable, or delete models and to restart the proxy. Clicking **Custom Models** in the status bar always returns to this page.

## Privacy and security

- **Provider API keys** stay in Cursor SecretStorage and are only sent to the upstream base URL you configure.
- **The generated proxy key** authenticates every request to the local proxy. Anyone who has both the public Base URL and that key can use your configured models—treat it like a password.
- **Prompts and responses** travel through the tunnel provider you choose (ngrok or Cloudflare) and then to your model provider. Prefer a tunnel you trust.
- **This project does not phone home.** There is no maintainer telemetry. Optional request logging stays in Cursor’s local Output channel (`openCursorModels.logRequests`, off by default).
- See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and a fuller threat model.

## Troubleshooting

- **Installer cannot find the Cursor CLI:** In Cursor, run **Shell Command: Install 'cursor' command in PATH** from the Command Palette, then run `./install.sh` again.
- **Tunnel failed:** Install ngrok or cloudflared, then click **Start proxy** again.
- **Model not found:** Copy the exact generated model name from step 4.
- **Unauthorized:** Copy the generated proxy key from step 3 into the selected Cursor API key field.
- **Base URL stopped working:** Restart the proxy and copy the current HTTPS Base URL into Cursor again.

For detailed proxy and tunnel errors, open **View → Output** and select **Open Cursor Models**.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Releasing

There is nothing to publish. Users build from source with `install.sh`, so shipping a change is just merging it to `main`. Bump the version in `package.json` when you want the installed extension version to change.

## License

MIT. See [LICENSE](LICENSE).
