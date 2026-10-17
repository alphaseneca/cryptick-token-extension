# Cryptick Token Browser Extension

[![Release](https://github.com/alphaseneca/cryptick-token-extension/actions/workflows/release.yml/badge.svg)](https://github.com/alphaseneca/cryptick-token-extension/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](manifest.json)

A Manifest V3 browser extension that bridges a webpage's WebAuthn/passkey calls to **Cryptick Token**, a physical FIDO2 hardware security key, over a native messaging host running on the user's machine. It also gives the user a popup to manage what's on the key: saved passkeys, hardware TOTP (2FA) codes, and (when more than one key is present) which one is active.

Every sensitive step — the actual signature, the fingerprint/touch check, viewing or deleting a resident passkey — happens on the hardware token itself. This extension never computes, caches, or asks the user to type a credential, PIN, or secret; it only relays requests and displays whatever the token hands back. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for exactly how a request moves end to end, with the touch-wait ceremony marked at each step.

---

## What it does

- **Hardware passkey bridge (WebAuthn Level 3)**: intercepts `navigator.credentials.create()` / `.get()` on the page (`injected.js`) and routes the request to the Cryptick Token through the native messaging host. If the token isn't connected or the user turns the bridge off, the call falls through to the browser's own built-in passkey handling — nothing is blocked.
- **Live, on-device passkey management**: the Passkeys tab calls the host's `list_credentials` directly, so it always shows the real resident credentials on the key right now, grouped by site, with a live count and remaining slot count. Each entry can be deleted from the device with `delete_credential`, behind a second explicit "Delete from device?" confirmation.
- **Fingerprint-gated, zero PIN**: viewing or deleting a saved passkey is gated by the same fingerprint/touch ceremony as an everyday sign-in, prompted on the token's own hardware — never a PIN. No PIN field exists anywhere in this extension's UI or code, and the popup's `sendWithTouchWait()` helper shows a "Touch your Cryptick Token to verify…" state while that ceremony is pending.
- **Multi-device picker**: if the host reports more than one Cryptick Token (`list_devices`), a dropdown appears on the Device tab to switch the active one (`select_device`); with only one device connected, the picker stays hidden.
- **Hardware TOTP (Authenticator tab)**: on-demand 30-second 2FA codes computed on the token's own chip — the extension only displays the 6-digit result and a countdown, it never derives it.
- **Device status**: connection state (USB / Bluetooth / not detected), Bluetooth pairing state, round-trip latency and bridge/daemon health, all built only from fields the native host actually returns — plus a "Test connection" check and a bridge-service restart action.
- **Manifest V3, Chromium + Firefox**: one `chrome.*`-API codebase; Firefox 109+ is supported via its `browser.*`-as-`chrome.*` alias (see `manifest.json`'s `browser_specific_settings`).

## How it works, briefly

```
Webpage (navigator.credentials)
   -> injected.js   (MAIN world: intercepts the call, builds the request)
   -> content.js    (ISOLATED world: checks the on/off toggle, relays to the background worker)
   -> background.js (service worker: forwards to the native messaging host, no logic of its own)
   -> native messaging host on the user's machine -> Cryptick Token (USB, or BLE via a bridging daemon)
   -> ... and the response flows back the same way.
```

The popup (`popup.js`) talks to `background.js` directly (it doesn't go through `content.js`/`injected.js`) for everything shown in its three tabs — status, passkey list/delete, TOTP codes, and the device picker.

The full breakdown — every hop, every message shape, and exactly where the fingerprint touch-wait sits — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), with sequence diagrams for both the webpage sign-in flow and the popup's credential-management flow.

---

## Repository layout

| Path | What it is |
|---|---|
| `manifest.json` | MV3 manifest: permissions, content script injection points, popup entry point. |
| `background.js` | Service worker. Forwards popup/content-script messages to the native messaging host (`com.cryptick.webauthn`) and caches connection status across service-worker restarts. Contains no UI and no cryptographic logic. |
| `content.js` | Runs in the page's isolated world on every frame. Relays `window.postMessage` traffic between `injected.js` and `background.js`, and enforces the bridge on/off toggle for `create`/`get`. |
| `injected.js` | Runs in the page's main world. Overrides `navigator.credentials.create`/`get`, builds the WebAuthn request/response, and shows the in-page "touch your key" prompt. |
| `popup.html` / `popup.js` | The extension popup UI: Passkeys, Authenticator, and Device tabs. Pure presentation layer — every value rendered traces back to a real field in a native-host response. |
| `icon*.png` | Toolbar/store icons at the sizes `manifest.json` references, plus a larger `icon.png` used for packaging/store listings. |
| `docs/ARCHITECTURE.md` | How a request actually moves through this extension and out to the hardware, with Mermaid diagrams grounded in the code above. |
| `NOTES.md` | Running engineering log from past development sessions (redesign rationale, what was removed and why, testing performed). Not required reading to use or build the extension — kept for engineering history, not polished for an end user. |
| `.github/workflows/release.yml` | Packages a release zip and publishes it on a `v*` tag push. |
| `package.json` | `npm run pack` builds the same release zip locally. |

---

## Installation

### From GitHub Releases (Pre-built ZIP)
1. Download `cryptick-token-extension-v*.zip` from the [Latest Releases](https://github.com/alphaseneca/cryptick-token-extension/releases).
2. Unzip into a local folder (e.g., `~/Extensions/cryptick-token-extension`).
3. Open your browser's extension manager:
   - **Chrome / Brave / Edge**: Navigate to `chrome://extensions`, enable **Developer mode** in the top right, and click **Load unpacked**. Select the unzipped folder.
   - **Firefox**: Navigate to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...**, and select `manifest.json`.

### Prerequisite
This extension only *bridges* to a Cryptick Token — it has no driver code of its own. It needs the Cryptick Token native messaging host (registered as `com.cryptick.webauthn`) and, for Bluetooth use, its background bridging daemon, installed and running on the machine. Without that host installed, `background.js`'s native-messaging calls simply fail and the popup reports the bridge as offline; the extension still loads and the page-side WebAuthn fallback still works.

---

## Permissions (`manifest.json`)

| Permission | Why |
|---|---|
| `nativeMessaging` | Required to talk to the native messaging host (`background.js`'s `chrome.runtime.sendNativeMessage`). This is the only way this extension reaches the hardware. |
| `storage` | Persists the bridge on/off toggle and the last-known connection status (`chrome.storage.local`), so a killed-and-restarted MV3 service worker and a freshly opened popup don't show a stale or flickering state. |
| `host_permissions: <all_urls>` | `content.js`/`injected.js` need to run on every page, at `document_start`, so a site's own `navigator.credentials` call can be intercepted before the page uses it. |

---

## Development

```bash
# Clone the repository
git clone https://github.com/alphaseneca/cryptick-token-extension.git
cd cryptick-token-extension

# Pack into a release zip
npm run pack
```

---

## License

Licensed under the [MIT License](LICENSE).
