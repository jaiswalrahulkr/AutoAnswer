# AutoAnswer AI (Chrome Extension)

Capture page content, ask an AI for suggested answers, and auto-fill forms. Built for Manifest V3.

## Features
- Capture visible page text and detect input fields (text, textarea, contenteditable)
- Optional visible-tab screenshot during capture
- Send structured prompt to an AI endpoint; fill returned answers
- Toggle auto-submit behavior
- Keyboard shortcut: Ctrl+Shift+F to trigger autofill

## How It Works
1. Content script extracts trimmed page text and input descriptors `{ id, label }`.
2. Background service worker builds a prompt and calls the configured AI endpoint via `fetch()`.
3. The AI returns a JSON object mapping field ids to answers.
4. Content script fills those values and optionally submits the form.

## File Structure
- `manifest.json`: MV3 configuration, permissions, commands
- `background.js`: lifecycle, keyboard command, AI call, messaging
- `content.js`: DOM extraction and filling logic
- `popup.html` + `popup.js`: quick UI to save key and trigger capture/fill
- `options.html` + `options.js`: settings for API key, endpoint, and auto-submit

## Permissions
- `activeTab`, `scripting`, `storage`, `tabs`, `clipboardRead`
- `host_permissions: <all_urls>` to run on any site

## Configure AI Endpoint
By default, the endpoint is `https://example.com/ai` (placeholder). Replace in Options.

Expected request body (example):
```
{
  "prompt": "...",
  "pageText": "...",
  "inputLabels": [{"id":"...","label":"..."}],
  "model": "gpt-4o-mini",
  "max_tokens": 512
}
```

Expected response body: either a pure JSON object mapping ids to answers, or a text body containing such JSON. Example:
```
{
  "id:email|name:userEmail|type:text|idx:0": "jane@example.com",
  "id:msg|type:textarea|idx:1": "Hello, here is my response..."
}
```

## Development / Load Unpacked
1. Open Chrome → Extensions → Enable Developer Mode
2. Load Unpacked → select the `ChromeExtension/` directory
3. Pin the extension; open the popup
4. In Options, set your API key and endpoint

## Usage
- On a page with forms, click "Capture Page & Fill Answers" in the popup or press Ctrl+Shift+F.
- The extension will extract page text and fields, call the AI, fill answers, and optionally submit.

## Notes
- The content extractor limits text to ~20k characters to keep payloads reasonable.
- The content script tags fields with `data-autoanswer-id` to map answers back.

## Replace with OpenAI/Gemini (example pseudocode)
Point `apiEndpoint` to your proxy that wraps OpenAI/Gemini. The proxy should accept the above JSON and return a JSON mapping of field ids to answers (no extra text).

## Privacy
- API key and settings stored via `chrome.storage.sync`.
- Page text is sent to your configured endpoint only when you trigger capture.

---

## Example Test Scenarios
- When user clicks the popup button on a page with text inputs → fields are detected and filled.
- When AI returns valid JSON mapping → values are inserted and input/change events dispatched.
- When AI returns text with fenced JSON → JSON is extracted and applied.
- When no inputs are visible → shows success with zero fields filled; no errors thrown.
- When auto-submit is enabled and a form is touched → the first form is submitted.
- When the content script is not injected yet → popup injects it and retries.
- When the keyboard shortcut is pressed → autofill triggers in the active tab.
- When the API endpoint returns a non-200 error → popup shows an error message.
- When endpoint is slow/unavailable → user sees failure message; no page breaks.
- When toggling auto-submit off → values fill but forms are not submitted.



TO access the admin dashboard http://127.0.0.1:3001/admin

To restart the server navigate to backend Folder and run npm run dev

Packaging note: Do not include the `backend/` folder or any `.env` files when zipping for the Chrome Web Store. Zip only the extension assets (`manifest.json`, `background.js`, `content.js`, `popup.*`, `options.*`, and any icons). See `PACKAGING.md` for detailed steps.