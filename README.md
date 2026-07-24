# Open Cursor Models

Use models from OpenAI-compatible or Anthropic APIs inside Cursor. OpenCursor stores each model's provider URL and API key, then routes Cursor requests through one local proxy.

## Install

Requirements:

- Cursor
- Node.js 18 or newer
- An HTTPS tunnel provider: [ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) is recommended. If neither is installed, OpenCursor falls back to `npx localtunnel`.

Build and install the extension:

```sh
npm install
npm run package
```

In Cursor, open Extensions, choose **More Actions → Install from VSIX**, and select the generated `.vsix` file.

## Setup

Open **Open Cursor Models: Open Models Setup** from the Command Palette, or click **Custom Models** in the status bar. Both open the same setup page.

### 1. Add models

Click **Add model** and enter:

- A display name
- The exact model ID expected by the provider
- The provider API base URL
- The API protocol
- The provider API key

Add as many models as you need. Every model can use a different provider, URL, and API key.

### 2. Start the proxy

Click **Start proxy**. OpenCursor starts:

- A local routing proxy
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

## Troubleshooting

- **Tunnel failed:** Install ngrok or cloudflared, then click **Start proxy** again.
- **Model not found:** Copy the exact generated model name from step 4.
- **Unauthorized:** Copy the generated proxy key from step 3 into the selected Cursor API key field.
- **Base URL stopped working:** Restart the proxy and copy the current HTTPS Base URL into Cursor again.

For detailed proxy and tunnel errors, open **View → Output** and select **Open Cursor Models**.
