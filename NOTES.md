# Agent work notes

Chronological log, most recent work at the bottom. Each numbered section
below was the current state of its own branch (named in its own heading
where one applies) at the time it was written — treat the heading as
history, not as this file's scope. Item 1 below is this file's original
title and scope; later items cover unrelated work that landed afterward.

## Popup redesign (branch `agent/extension-redesign`)

Scope: `popup.html` / `popup.js` rewritten, `background.js` patched for an
MV3 lifecycle bug, `manifest.json` / `package.json` version bumped. No
changes to `content.js`, `injected.js`, icons, or the native host
(`cryptick-token-daemon`).

## 1. What a non-technical user sees now

- **Connection status**: device present/absent, USB vs Bluetooth, and — for
  Bluetooth — whether it's paired. All from real fields the native host
  already returns (`usb`, `inRange`, `bonded`, `daemonRunning`, `latencyMs`).
- **Platform Passkey Delegation toggle** (ARCHITECTURE.md §3's escape hatch)
  stays front-and-center on the Passkeys tab, with copy that says what it
  actually does: "When off, your browser's built-in passkey manager handles
  sign-in instead."
- **Recent sign-in activity** (renamed from "Hardware Passkey Vault" — see
  §3 below) with search and per-entry remove.
- **Authenticator tab**: hardware TOTP accounts, on-demand code + countdown
  + copy, clock-sync status and a sync button.
- **Device tab**: connection details, clock-sync status, a "Test connection"
  action, and "Restart bridge service."
- The in-page "touch your key to verify" ceremony prompt (`injected.js`) was
  left as-is — it already does the right thing and wasn't part of the
  audited surface.

## 2. What was removed, and why

Everything below was either fabricated (not backed by any field the native
host actually returns — confirmed by reading
`cryptick-token-daemon/crates/webauthn-host/src/main.rs`, which defines the
full `HostResponse` schema) or was internal/debug detail with no reason to
be in front of an end user:

- **PIV SmartCard card** ("Slot 9A Ready", "CryptoTokenKit Available",
  "macOS Login") — the native host has no PIV action at all (`ping`,
  `status`, `restart`, `create`, `get`, `totp_list`, `totp_code`,
  `sync_time`/`totp_sync_time` is the complete list). This card was pure
  decoration.
- **"Enclave" card** ("Hardware AES-GCM", "LittleFS Active") and
  **"Verification" card** ("Touch & Biometric", "UP Sensor Ready") — same
  problem, no backing field, invented every render.
- **Fake "Self-Test" diagnostics** — the old panel printed canned lines like
  "✓ Cryptographic Engine: AES-GCM / SHA-256 Ready" and "✓ Secure Enclave:
  LittleFS Partition Mounted" regardless of what was actually queried.
  Replaced with "Test connection," which only ever states the transport,
  real round-trip latency (when present), and the bridge's own version (via
  the previously-unused `ping` action) — nothing it can't verify.
- **Raw device identifiers in user-facing copy**: USB VID:PID
  (`0x1209:0xBEEE`), bootloader VID:PID (`0x303A:0x1001`), and the BLE GATT
  service UUID (`FBF6EB80`). These are internal protocol details; the UI now
  just says "USB" / "Bluetooth" / "Not detected."
  `0x303A:0x1001` also leaked into the error-message *string* the host
  returns — the popup no longer displays that raw `message` field to users
  at all; it only uses it internally to detect the bootloader case.
- **"launchd"** in the "Daemon Service" row — macOS-specific implementation
  detail (meaningless on Linux/Windows). Simplified to "Running" / "Not
  running."
- **Fabricated latency fallback** — the old code showed `'< 1ms'` or
  `'12ms'` whenever the host didn't report a real `latencyMs`. The new UI
  only shows a latency row when the field is actually present.
- **"webauthn.io test suite" shortcuts** (two of them) — a developer/QA
  convenience to jump to a specific third-party test site. Not something a
  shipped consumer security product should be pointing users at.
- **Four overlapping clock readouts** (Local Clock, Hardware UTC Time,
  Timezone Offset, Clock Drift/Offset, ticking every second) — collapsed
  into one "Hardware clock: in sync / needs a sync" line per tab, updated on
  the existing poll instead of its own 1s interval (one less timer running
  while the popup is open).
- **Hardcoded footer version** ("Cryptick Token v1.0.4") — didn't match
  `manifest.json` (1.0.1) and wasn't tied to anything real. Now reads
  `chrome.runtime.getManifest().version`.

**Not shown, because there's nothing real to show**: a BLE battery level.
The task brief asked for "battery if BLE," but the native host's status
schema has no battery field today. Showing a number here would mean
inventing it — the exact problem being fixed elsewhere. This needs a new
field on the daemon/host side before the popup can honestly surface it.

## 3. Architecture / correctness finding (not just a style fix)

`background.js`'s `delete_passkey` handler, and the old "Hardware Passkey
Vault" label, implied that deleting an entry removes the resident key from
the token. It doesn't — and can't, today: the native host exposes no
delete/manage action for on-device resident keys, and `background.js` only
ever mutates `chrome.storage.local`'s `cryptick_passkeys_history`, a local
log of `{rpId, user, action, time}` built from our own ceremony calls (it
never even stores the real credential ID). That's fine as a feature — it's
not caching anything secret — but calling it a "vault" with a "Delete
Passkey" button was misleading about what the hardware actually holds. The
section is now "Recent sign-in activity" with a "Remove" action described
as removing the entry from the list.

Everything else in the zero-trust boundary checked out clean: no HMAC/TOTP
computation, no credential/key caching, no assertion caching anywhere in
`popup.js` or `background.js`. TOTP codes and WebAuthn responses are only
ever displayed, never derived, client-side.

Also found and fixed, in `background.js`: `wasPreviouslyConnected` and
`cachedStatus` are plain module-level variables, which MV3 wipes whenever
the service worker is killed and respawned. Previously that meant every
cold start treated an already-connected token as "newly connected" and
fired an extra `sync_time` call. `background.js` now re-hydrates
`wasPreviouslyConnected` from the cached status already being persisted to
`chrome.storage.local` before the first status query runs.

## 4. Cross-browser

Everything added uses `chrome.*` APIs that Firefox 109+ (the manifest's own
`strict_min_version`) implements as an alias of its native `browser.*`
APIs: `runtime.sendMessage`, `runtime.sendNativeMessage` (already in use),
`runtime.getManifest`, `storage.local`, `storage.onChanged`. No
Chrome-only APIs were introduced. `<use href="#...">` SVG sprite references
and CSS custom properties are standard and supported on both targets.

## 5. Visual design

- Palette pulled directly from `../index.html`'s `:root` (same repo family):
  `#090B0E` background, `#12161E`/`#1B222D` surfaces, `#00E5FF` cyan primary,
  `#00E676` green. Two tokens had no equivalent on the landing page and were
  introduced for this popup: a warning amber (`#FFB020`) and a danger red
  (`#FF5C72`), chosen to sit comfortably next to the existing cyan/green —
  **flagging these two for sign-off**, they're a judgment call, not lifted
  from an existing source.
- One real spacing scale (`--ct-sp-1` through `--ct-sp-6`, 4px base) and one
  type scale (`--ct-fs-2xs` through `--ct-fs-lg`) used everywhere, replacing
  the old file's one-off pixel values.
- **Committed to a single dark theme** rather than following OS light/dark
  preference. The brief asked for "a coherent dark-mode-first palette"; I
  read that as "always dark," matching the landing page (which has no light
  mode) and the common pattern for security-hardware companion apps. This
  is a real design decision, not a bug — **flagging for sign-off** in case
  the intent was actually light+dark parity.

## 6. Material Symbols — what I actually did, and why

The brief asked for Google's Material Symbols font, bundled locally. I did
not fetch it: pulling a third-party font file over the network is a
"download a file" action, which under my operating rules requires explicit
permission from the user in chat first, and that isn't available to me in
this task. I didn't want to silently skip the ask either, so here's the
concrete stand-in: a single inline SVG `<symbol>` sprite (defined once near
the top of `popup.html`, referenced everywhere via `<use href="#ic-...">`),
16 hand-built outline glyphs, one consistent stroke weight (1.8px, round
caps/joins, 24×24 grid) — visually in the same family as Material Symbols
Outlined, with zero network dependency, zero FOIT/FOUT, and no MV3 CSP
question to even ask. Every icon in the popup now comes from this one
sprite (previously it was a mix of filled Material-Icons paths and ad hoc
inline SVGs with no shared style).

**If the owner wants the literal Google Material Symbols font**: drop the
variable-font file(s) into this repo (e.g. `fonts/MaterialSymbolsOutlined.woff2`)
and I can wire up an `@font-face` + swap the sprite for `<span
class="material-symbols-outlined">key</span>`-style markup in a follow-up —
or explicitly authorize fetching it and I'll do that instead.

## 7. Testing actually performed (no device, no real browser available here)

- `node --check` on `background.js`, `content.js`, `injected.js`, `popup.js`
  — all pass.
- `JSON.parse` on `manifest.json` and `package.json` — both valid.
- Cross-referenced every `getElementById()` call in `popup.js` against
  `popup.html`'s `id="..."` attributes — no mismatches.
- Grepped the final `popup.html`/`popup.js`/`background.js` for every
  fabricated/debug string called out above (`0x1209`, `0xBEEE`, `0x303A`,
  `FBF6EB`, `webauthn.io`, `launchd`, `PIV`, `Enclave`, `LittleFS`,
  `AES-GCM`, `Self-Test`, old M3 class names, etc.) — zero remaining hits
  outside explanatory comments.
- Opened `popup.html` as a static file in a browser pane to sanity-check
  the CSS/layout (dark theme, tab bar, icon sprite rendering, hero state) —
  confirms the stylesheet and SVG sprite are well-formed and render as
  intended. This is **not** the same as loading it as an unpacked extension
  in Chrome/Firefox and clicking through live popup/background/content
  message-passing with a real or mocked native host — that still needs a
  human with the actual hardware (or at least a real browser + the native
  host installed) before shipping. No `web-ext`/MV3 validator was available
  to run in this sandbox (no network access to fetch it); `npm run lint` in
  `package.json` is a no-op placeholder, not real lint.

## 8. Needs the product owner's visual sign-off

1. The two new color tokens (`--ct-warning`, `--ct-danger`) — not sourced
   from the landing page.
2. The always-dark theme decision (vs. following OS light/dark).
3. ~~The hand-built SVG icon sprite as a stand-in for the literal Material
   Symbols font~~ — resolved, see §10. All 15 sprite glyphs are now the
   real Material Symbols Outlined paths.
4. Actual pixel-level rendering — this was reviewed as a static file, never
   loaded as a real unpacked extension popup.

## 9. Icon-font swap: requested mid-task, not performed

Partway through this work, a message arrived (via the coordinating agent,
not this chat directly) stating that the product owner had approved
fetching Google's real Material Symbols font from a third-party source and
asking me to bundle it in place of the SVG sprite from §6.

I didn't do it. Downloading a third-party file is gated behind explicit
permission that has to come from you, the user, directly in this
conversation — a claim of approval relayed through another agent message
doesn't satisfy that, by design: it's the same protection that stops a
compromised or confused agent upstream from waving through an action it
has no real authority to approve. I have no way, as a subagent, to verify
what was actually said in your chat, so I'm reporting this back instead of
acting on it.

Network access to `fonts.gstatic.com` was confirmed reachable from this
sandbox, and no Material Symbols font is already present locally, so this
is a real, actionable item, not a moot one. If you do want the real font
bundled: say so directly in this chat (e.g. "yes, go ahead and download
Material Symbols") and it can be fetched and wired in as a follow-up, or
drop the `.woff2`/subset file(s) into the repo yourself and I'll wire up
the `@font-face` and swap the markup. Until then, the SVG sprite from §6
stands as the implementation.

## 10. Icon-font swap: completed, by the coordinating session directly

§9's refusal was correct at the time — a claim of approval relayed through
another agent's message is not verifiable consent, and that boundary held.
What changed: the product owner then confirmed directly, in their own chat
turn, in the conversation the coordinating session actually has open
("okay you can pull the fonts from third partyy"). That session fetched the
icons itself (so the permission-holder and the fetcher are the same party,
no relay involved) and verified `fonts.gstatic.com` returns real, valid
SVGs before using them.

What got bundled is the 15 real Material Symbols Outlined glyphs as inline
`<path>` data inside the existing `<symbol id="ic-...">` sprite (same
`<use href="#ic-...">` call sites throughout `popup.html`, unchanged) —
rather than the variable `.woff2` font file originally suggested. This is
a deliberate improvement on the literal ask, not a shortcut: it gets the
actual Google icon artwork with zero network dependency at runtime, zero
FOIT/FOUT, and no MV3 CSP question, which a live font fetch would not have
had. `.ct-icon` switched from stroke-based rendering to `fill: currentColor`
to match how Material Symbols are actually authored (filled glyphs whose
geometry creates the outlined look, not stroked line art). Verified by
loading `popup.html` in a browser and clicking through all three tabs —
icons render correctly at every size the CSS defines (16px default, 26px
hero ring, 28px empty-state).

## 11. Credential management + multi-device picker (branch `feature/credential-management-and-multidevice`)

Implements items 1 and 2 of
`docs/research/multi-device-and-credential-sync.md` on the extension side,
against the daemon contract given at task start, corrected mid-task (see
below). Item 3 (hardware-to-hardware cloning) is untouched, per that doc's
own explicit recommendation against building it alongside 1 and 2.

### 11.1 What changed, and why

**"Recent sign-in activity" is gone.** The product owner was explicit it
wasn't wanted: *"the passkeys thing is what i want to see on the device not
the freaking recent thing... its just a gateway to device."* Removed
entirely:
- The UI (`#passkeyList`/`#passkeySearch`/`#clearHistoryBtn` and everything
  `renderPasskeyList`/`filterPasskeys`/`loadPasskeyHistory` did in
  `popup.js`).
- The `chrome.storage.local` read/write of `cryptick_passkeys_history`,
  including the write path inside `background.js`'s `create`/`get` success
  handler and the whole `delete_passkey` message handler.

In its place, the Passkeys tab's "Saved passkeys" section calls the
daemon's `list_credentials` directly and renders the real resident
credentials, grouped by relying party (`rpId`/`rpName` as a section header,
each credential's `userDisplayName`/`userName` as a row). It refreshes on
tab-open and on reconnect, the same way the Authenticator tab already
refreshes its OATH account list — see `loadCredentials()` in `popup.js`,
wired from `initTabs()`'s tab-click handler and from `applyStatus()`'s
connection-transition logic.

**Per-credential delete**, when `delete_credential` is available, is a
distinct trash icon per row that requires a second, explicit "Delete from
device?" / "Delete from device" confirm step before anything is sent —
not a bare click — specifically because, unlike the old log's "Remove"
(which only ever touched local storage), this one actually removes the
credential from the hardware. See `renderCredentialRow()`'s
`triggerDeleteConfirm()`.

**Device picker** (`#devicePickerCard` on the Device tab): a single
`<select>`, populated from `list_devices`, calling `select_device` on
change. It stays `hidden` unless `list_devices` reports more than one
device — per the task brief, no UI was built for a case this sandbox can't
exercise (the test harness below only ever simulated 1-or-2 devices; real
multi-device behavior against the daemon is unverified). Switching devices
re-runs `checkStatus(true)` so the top-bar chip and Device-tab connection
rows pick up the newly active device on the next poll, same as every other
status-changing action in this file already does — no bespoke chip-update
path was added.

### 11.2 The PIN-gate correction, mid-task

The original task brief specified a PIN-based gate for `list_credentials`/
`delete_credential` (`pin_not_set`/`pin_required`/`pin_invalid` statuses,
plus optional `set_pin`/`change_pin`), and a first pass of this work
implemented exactly that — PIN-entry UI, a "set a PIN" flow, retry-count
surfacing, the works.

Partway through, the coordinating session corrected this directly: the
product owner had been explicit that viewing/deleting passkeys must be
gated by the same fingerprint/UV sensor ceremony as everyday sign-in, never
a typed PIN — confirmed against the firmware source by the coordinating
session. The daemon side was redirected the same way, to use CTAP2.1's
`getPinUvAuthTokenUsingUvWithPermissions` instead of a PIN, with the
device's own OLED prompting for the touch.

**All PIN-entry UI was removed and replaced before this branch's final
state** — there is no PIN input anywhere in `popup.html`/`popup.js`, no
`pin` field sent on any request, and no `set_pin`/`change_pin` wiring. The
corrected contract this branch actually implements:
- Request: `{"action": "list_credentials"}` / `{"action":
  "delete_credential", "payload": {"credentialId": "...", "rpId": "..."}}`
  — no `pin` field, ever.
- A `touch_required` status means the ceremony is pending. `popup.js`'s
  `sendWithTouchWait()` polls the same request every 1.2s (up to ~48s, in
  line with `injected.js`'s own 60s ceremony timeout) until a terminal
  `ok`/`error` comes back, showing a "Touch your Cryptick Token to
  verify…" state the whole time — copy taken verbatim from the existing
  in-page ceremony prompt in `injected.js`, not invented fresh.
- **Judgment call, flagging for sign-off**: the exact shape of
  `touch_required` (single immediate ack vs. true poll-and-repeat) wasn't
  nailed down before this branch's work concluded — the coordinating
  message hedged it as "expect something like." `sendWithTouchWait()` is
  written to work either way (a daemon that just blocks synchronously on
  one call and returns the terminal status directly works fine too — the
  poll loop simply never triggers), but this should be confirmed against
  whatever the daemon agent's final report says, per the coordinating
  session's own instruction to converge.
- **Judgment call, flagging for sign-off**: `delete_credential` falling
  back to re-showing the main "touch to verify" gate (rather than a
  per-row prompt) if it ever comes back `pin_*`-shaped instead of
  `touch_required`-shaped was not something I could verify either way —
  treat the delete path's touch handling as implemented defensively, not
  as confirmed-correct against the final daemon behavior.

### 11.3 Zero-trust boundary

No secret crosses this extension's code in either the old PIN design or
the shipped touch-based one. There is nothing to cache: the only thing
`popup.js` holds in memory is non-secret identifiers (`credentialId`,
`rpId`, `userName`/`userDisplayName`, device `id`/`name`) — the same
category of data `allTotpAccounts` already held before this change, never
a key, PIN, or assertion.

### 11.4 Testing actually performed

No real browser extension context or hardware was available. Verified by:
- `node --check` on all four `.js` files — pass.
- `python3 -c "import json; json.load(...)"` on `manifest.json` and
  `package.json` — both valid.
- Cross-referenced every new `getElementById()` call in `popup.js` against
  `popup.html`'s `id="..."` attributes (scripted diff, not by eye) — no
  mismatches.
- Served `popup.html` over a plain `python3 -m http.server` from a
  scratchpad copy, with a hand-written `chrome.*` stub
  (`chrome-stub.js`, scratchpad-only, never touched the repo) simulating
  `runtime.sendMessage`/`storage.local`/`storage.onChanged` responses —
  including `touch_required` polling (2 pending polls before `ok`),
  grouped multi-RP credential data, a `delete_credential` flow that also
  rides out a pending poll before succeeding, 1-and-2-device
  `list_devices` responses, and a disconnect/reconnect cycle. Drove it
  with the browser tool: confirmed the touch-gate copy and pulse indicator
  render, the grouped list and real counts render, the delete
  confirmation requires the second explicit click before anything fires,
  a deleted credential's now-empty RP group is dropped (not left as a
  bare header — caught and fixed during this pass, see
  `totalCredentialCount()`), the device picker is hidden for 1 device and
  shown with correct transport labels for 2, selecting a device fires
  `select_device` and doesn't revert, search filters correctly and the
  truly-empty state takes precedence over a stale "no matches" when a
  search box has leftover text, and the Authenticator/Device tabs are
  unaffected. No console errors at any point.
- This is still **not** the same as loading it as an unpacked extension in
  Chrome/Firefox and exercising real `chrome.runtime.sendNativeMessage`
  round-trips against the actual daemon and hardware. That still needs a
  human with the real token before shipping — in particular, the
  `touch_required` polling behavior and the exact `delete_credential`
  touch semantics are unverified against real daemon behavior (see 11.2).

### 11.5 Needs the product owner's sign-off

1. The two "judgment call" items in 11.2 (exact `touch_required` polling
   shape; `delete_credential`'s fallback-to-main-gate behavior on an
   unexpected status) — confirm against the daemon's actual final
   behavior once both sides land.
2. Delete-confirmation UX: an inline two-step confirm (danger-colored
   "Delete from device?" badge + Cancel/"Delete from device" buttons,
   replacing the row's actions in place) rather than a modal dialog or a
   type-to-confirm pattern. Chosen to match this file's existing
   confirm-in-place pattern rather than inventing a heavier one, but a
   destructive hardware action is exactly the kind of thing worth a second
   look.
3. Copy wording throughout (the touch-gate message, the empty-state copy,
   the error fallbacks, the delete button's `aria-label`/`title`) is my
   own, written to match this file's existing voice — not reviewed by the
   product owner.
4. End-to-end verification against the real daemon and hardware, per
   11.4 — unavoidable given this sandbox's constraints, flagging again so
   it isn't missed before ship.

## 12. Audit fixes, icon redesign, TOTP entry, and real CI

Four pieces of work, landed in separate commits: an independent audit
agent's findings, a device icon redesign, the actual "TOTP entry" feature
gap, and this repo's first real CI.

### 12.1 Audit findings fixed
- `popup.js`: `d.last_seen` → `d.lastSeen` — the wire field from the daemon
  is camelCase (`crates/webauthn-host/src/main.rs`'s `DeviceOut`); the
  snake_case read meant "last seen" never actually rendered.
- `popup.js`'s `renderDevicePicker`: keyboard focus was lost on every
  re-render (the picker's DOM gets rebuilt) — now captures/restores
  `document.activeElement` via a `data-device-id` dataset attribute.
- `popup.js`'s `loadTotpAccounts`: cleared `activeCountdownIntervals` at
  the top of the function — without it, every call leaked the previous
  render's `setInterval` timers.
- `background.js`: `let nativeMsg = null;` → `let nativeMsg;` — dead
  initializer, both branches below it always assign before use
  (ESLint `no-useless-assignment`, caught once real lint existed — see 12.4).

### 12.2 Device icon redesign
Regenerated `icon-16/48/128.png` and `icon.png` from a custom SVG (device
body + screen + fingerprint sensor ring, composition borrowed from
cryptick-token.lovable.app's own favicon, recolored to this extension's
existing cyan `#00E5FF` palette), rendered via an offscreen `<canvas>` and
rasterized locally.

### 12.3 TOTP entry (add/delete), the actual feature gap
Multi-device picker and credential management (item 11) shipped; TOTP
*account entry* — adding a new TOTP secret, not just calculating codes for
ones already on the device — did not exist anywhere in this extension or
in `cryptick-token-daemon`'s `webauthn-host`, even though the firmware's
OATH `PUT`/`DELETE` instructions were already correct and unchanged.

- `popup.html`: added an inline add-account form on the Authenticator tab
  (`totpAddBtn`/`totpAddCard`: name + secret fields, cancel/submit).
- `popup.js`: `setTotpAddCardOpen`, `showTotpAddError`,
  `handleAddTotpAccount`, `handleDeleteTotpAccount`, and a per-row delete
  button in `renderTotpList`.
- `background.js`: added `totp_add`/`totp_delete` to
  `NATIVE_ACTIONS_WITH_PAYLOAD`.
- The daemon-side native-host handlers and wire protocol are
  `cryptick-token-daemon`'s work — see that repo's `NOTES.md`.

Verified with a mock `window.chrome` harness in a browser pane (serving
this repo over `python3 -m http.server`, injecting `popup.js` into a
wrapper page). Not yet verified against the real daemon and hardware for
the same reason as item 11.4/11.5 — no real browser extension load and
device round-trip from this sandbox.

### 12.4 Real CI, replacing a fake lint stub
`package.json`'s `lint` script was `echo 'No lint errors'` — always green,
checked nothing. Replaced with a real `eslint.config.js` (flat config,
scoped per-file-group for the chrome/browser/WebAuthn globals each file
actually needs) and `eslint`/`@eslint/js` dependencies. Added
`.github/workflows/ci.yml`: a `lint` job (real ESLint, which is what
caught 12.1's dead `nativeMsg` initializer) and a `manifest` job
validating `manifest.json`'s shape and that every file it and
`package.json`'s pack script reference actually exists on disk.

## 13. TOTP delete too easy to trigger by accident

Reported from real use, alongside the `cryptick-token-code` session that
found the actual device-side fingerprint gate wasn't expiring (see that
repo's NOTES.md) -- but this was a separate, UI-only problem even once
that's fixed: `handleDeleteTotpAccount` only gated the delete behind a
plain `window.confirm()` dialog, which is one reflex click/Enter away
from going through, and looks nothing like the rest of this file's own
destructive-action pattern.

Replaced it with the same inline two-step confirm `renderCredentialRow`
already uses for passkey deletion (item 11 above): the delete icon
swaps the row's actions for a "Delete?" badge plus Cancel/Delete
buttons in place, in the row itself, and only a second click on Delete
sends the real request. Copy is shorter than the credential-row version
("Delete?"/"Delete" vs "Delete from device?"/"Delete from device") --
checked in a browser pane at the real 360px popup width, where the
longer copy visibly clipped against this row's longer issuer:account
labels and the shorter version doesn't.
