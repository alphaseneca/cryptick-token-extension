# Cryptick Token Browser Extension

[![Release](https://github.com/alphaseneca/cryptick-token-extension/actions/workflows/release.yml/badge.svg)](https://github.com/alphaseneca/cryptick-token-extension/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](manifest.json)

The official browser extension bridge for **Cryptick Token** — enabling seamless, zero-trust hardware passkeys (FIDO2 / WebAuthn Level 3) and live OATH-TOTP code lookup across Chromium browsers (Google Chrome, Brave, Microsoft Edge, Arc) and Mozilla Firefox.

---

## Highlights

- **Direct Hardware Passkey Polyfill**: Injects zero-trust `navigator.credentials.create()` and `navigator.credentials.get()` interception directly into web contexts, routing cryptographic operations through the `cryptick-daemon` native messaging host or direct WebUSB.
- **Biometric Presence & Confirmation**: Every passkey signing ceremony displays the relying party ID (domain) on the Cryptick Token's physical OLED screen and requires an authentic fingerprint match before producing a signature.
- **Hardware TOTP Quick-Access Popup**: View your active 30-second rotating 2FA codes generated on the hardware token's secure real-time clock without opening your smartphone.
- **Manifest V3 Compliant**: Built strictly on modern WebExtensions standards with lightweight isolated scripts and minimal memory footprint.

---

## Installation

### From GitHub Releases (Pre-built ZIP)
1. Download `cryptick-token-extension-v*.zip` from the [Latest Releases](https://github.com/alphaseneca/cryptick-token-extension/releases).
2. Unzip into a local folder (e.g., `~/Extensions/cryptick-token-extension`).
3. Open your browser's extension manager:
   - **Chrome / Brave / Edge**: Navigate to `chrome://extensions`, enable **Developer mode** in the top right, and click **Load unpacked**. Select the unzipped folder.
   - **Firefox**: Navigate to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...**, and select `manifest.json`.

---

## How It Works

```
┌─────────────────────────────────┐
│        Web Page Context         │
│  navigator.credentials.get()    │
└────────────────┬────────────────┘
                 │ (CustomEvent / PostMessage)
┌────────────────▼────────────────┐
│    Cryptick Injected Script     │
│       (Isolated Context)        │
└────────────────┬────────────────┘
                 │ (Chrome Runtime Port)
┌────────────────▼────────────────┐
│       Background Worker         │
└────────────────┬────────────────┘
                 │ (Native Messaging JSON-RPC)
┌────────────────▼────────────────┐
│      cryptick-webauthn-host     │
│        (Rust IPC Daemon)        │
└────────────────┬────────────────┘
                 │ (CTAPHID USB / Dual-GATT BLE)
┌────────────────▼────────────────┐
│         Cryptick Token          │
│   (ESP32-S3 Biometric Enclave)  │
└─────────────────────────────────┘
```

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

## Part of the Cryptick Token Ecosystem

- [Main Consolidated Repository](https://github.com/alphaseneca/cryptick-token)
- [Firmware & Core Logic](https://github.com/alphaseneca/cryptick-token-code)
- [Host Daemon, CLI & SmartCard PIV](https://github.com/alphaseneca/cryptick-token-daemon)
- [Hardware Schematics & PCB (KiCad)](https://github.com/alphaseneca/cryptick-token-pcb)

---

## License

Licensed under the [MIT License](LICENSE).
