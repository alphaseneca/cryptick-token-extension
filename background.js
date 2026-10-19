// Cryptick Token - Background Service Worker
//
// MV3 service workers are not persistent: Chrome (and Firefox's equivalent
// event-page lifecycle) can tear this script down and re-run it from a cold
// start between any two messages. None of the module-level state below is
// guaranteed to survive that -- `cachedStatus`/`wasPreviouslyConnected` are
// only ever safe to use as *within-session* fast paths. Anything that must
// outlive a restart is persisted to chrome.storage.local instead (and
// re-hydrated below on cold start) so we don't fire a spurious extra
// `sync_time` call -- or show a stale "disconnected" flash in the popup --
// every time the worker gets re-spawned while the token is already plugged in.
const HOST_NAME = 'com.cryptick.webauthn';

let cachedStatus = null;
let lastStatusFetchTime = 0;
let isFetchingStatus = false;
let wasPreviouslyConnected = false;

// `chrome.runtime.sendNativeMessage` is a one-shot exchange: Chrome delivers
// exactly one reply to the callback, then disconnects -- which, per the
// Native Messaging host protocol, closes the host's stdin and ends its
// process. `obtain_uv_token` in webauthn-host (list_credentials,
// delete_credential) writes an immediate `touch_required` message and then
// keeps running, waiting on the device's own fingerprint ceremony (up to
// ~25s), before writing the *real* final result as a second message. Against
// `sendNativeMessage` specifically, that second message can never arrive:
// Chrome's implicit disconnect after the first one kills the host process
// before the user's touch is ever reached, silently losing the real result.
// Confirmed directly against the native host (bypassing Chrome) that the
// host-side protocol itself is sound end-to-end when the connection is kept
// open for both messages.
//
// `connectNative` opens the same host via a persistent port that only closes
// when something explicitly disconnects it, which is what both messages
// need. Every action goes through it now, not just the two that currently
// write an interim message, so a future action gaining one doesn't silently
// regress into this same bug.
function sendNativeMessage(msg) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    port.onMessage.addListener((response) => {
      if (settled) return; // a stray message after we've already resolved
      if (response && response.status === 'touch_required') {
        chrome.runtime.sendMessage({ type: 'cryptick_touch_pending', requestAction: msg.action }).catch(() => {});
        return; // interim only -- keep the port open for the real result
      }
      settled = true;
      resolve(response);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Native host disconnected'));
    });
    port.postMessage(msg);
  });
}

async function getLiveStatus(forceFresh = false) {
  const now = Date.now();
  // Return cached state instantly if fresh (< 300ms) and not forced
  if (!forceFresh && cachedStatus && (now - lastStatusFetchTime < 300)) {
    return cachedStatus;
  }
  if (isFetchingStatus && cachedStatus && !forceFresh) {
    return cachedStatus;
  }

  isFetchingStatus = true;
  try {
    const res = await sendNativeMessage({ action: 'status' });
    if (res && res.status === 'ok') {
      cachedStatus = res;
    } else {
      cachedStatus = res || { status: 'error', message: 'No response from host' };
      console.error('[Cryptick Token] status query failed:', cachedStatus.message || cachedStatus);
    }
    lastStatusFetchTime = Date.now();

    const isConnected = !!(cachedStatus && (cachedStatus.usb || cachedStatus.inRange));
    if (isConnected && !wasPreviouslyConnected) {
      // Auto-sync hardware RTC to host UTC upon token insertion or reconnection
      sendNativeMessage({ action: 'sync_time' }).catch(() => {});
    }
    wasPreviouslyConnected = isConnected;

    chrome.storage.local.set({ cryptick_cached_status: cachedStatus });
    return cachedStatus;
  } catch (err) {
    console.error('[Cryptick Token] status query threw:', err.message || err);
    cachedStatus = {
      status: 'error',
      message: err.message || 'Host offline',
      usb: false,
      inRange: false,
      daemonRunning: false,
      transport: 'offline'
    };
    wasPreviouslyConnected = false;
    lastStatusFetchTime = Date.now();
    chrome.storage.local.set({ cryptick_cached_status: cachedStatus });
    return cachedStatus;
  } finally {
    isFetchingStatus = false;
  }
}

// Re-hydrate from the last known state before the very first query, so a
// service-worker restart while the token is already connected doesn't look
// like a fresh "newly connected" transition and fire an extra sync_time call.
chrome.storage.local.get(['cryptick_cached_status'], (data) => {
  const prev = data && data.cryptick_cached_status;
  if (prev) {
    wasPreviouslyConnected = !!(prev.usb || prev.inRange);
  }
  // Initial warm-up query on service worker start
  getLiveStatus(true);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // sendNativeMessage's own `cryptick_touch_pending` broadcast (see above)
  // reaches this same listener since it's sent via chrome.runtime.sendMessage
  // -- it's for popup.js, not for dispatch here.
  if (!request || !request.action) return false;

  const { action, payload } = request;

  if (action === 'status') {
    getLiveStatus(request.forceFresh || false)
      .then((res) => sendResponse(res))
      .catch((err) => {
        console.error('[Cryptick Token] status action failed:', err.message || err);
        sendResponse({ status: 'error', message: err.message });
      });
    return true; // Keep channel open
  }

  // Actions that need no extra fields -- the native host infers everything
  // it needs from the action name alone.
  const NATIVE_ACTIONS_NO_PAYLOAD = [
    'ping', 'restart', 'totp_list', 'sync_time',
    'list_devices', 'list_credentials'
  ];
  // Actions that forward the popup's payload straight through.
  // delete_credential carries no secret here -- it's gated by the device's
  // own fingerprint/UV ceremony (the host blocks on a physical touch, same
  // as a normal sign-in), not by anything typed into this extension.
  const NATIVE_ACTIONS_WITH_PAYLOAD = [
    'create', 'get', 'totp_code', 'delete_credential', 'select_device',
    'totp_add', 'totp_delete'
  ];

  let nativeMsg;
  if (NATIVE_ACTIONS_NO_PAYLOAD.includes(action)) {
    nativeMsg = { action };
  } else if (NATIVE_ACTIONS_WITH_PAYLOAD.includes(action)) {
    nativeMsg = { action, ...payload };
  } else {
    sendResponse({ status: 'error', message: 'Unknown action' });
    return false;
  }

  sendNativeMessage(nativeMsg)
    .then((result) => {
      if (action === 'restart') {
        setTimeout(() => getLiveStatus(true), 1200);
      }
      if (result && result.status === 'error') {
        console.error(`[Cryptick Token] action '${action}' failed:`, result.message || result);
      }
      sendResponse(result);
    })
    .catch((err) => {
      console.error(`[Cryptick Token] action '${action}' threw:`, err.message || err);
      sendResponse({ status: 'error', message: err.message });
    });

  return true; // Keep message channel open for async response
});
