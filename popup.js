// Cryptick Token - Popup Controller
//
// This file is a thin presentation layer. It never computes or caches
// cryptographic material: TOTP codes, passkey assertions, and signatures all
// come back pre-computed from the native host / hardware token, and every
// field rendered below traces back to an actual field in that response.
// See ../cryptick-token-daemon/docs/ARCHITECTURE.md #2 (Zero-Trust Passer
// Principle) -- nothing here should drift from that boundary.
//
// browser.* / chrome.* : Firefox implements the `chrome` namespace as an
// alias for its own `browser` APIs for everything this file uses
// (runtime.sendMessage, storage.local, tabs, runtime.getManifest), so a
// single `chrome.*` call site works unmodified on both targets.

let allTotpAccounts = [];
let allCredentialGroups = [];
let allDevices = [];
let activeCountdownIntervals = {};
let lastConnectionState = null;
let toastHideTimer = null;

// ---------------------------------------------------------------------------
// 0. Global toast
//
// Lives outside every .ct-pane (see #ctToast in popup.html) specifically so
// feedback from an action fired on one tab -- clock sync on the Device tab
// is the case that found this -- is never written into a pane's own result
// line while a *different* pane is the one actually visible. A pane-scoped
// banner only ever helps the user if they're looking at that pane.
// ---------------------------------------------------------------------------
function showToast(message, kind) {
  const el = document.getElementById('ctToast');
  if (!el) return;
  el.textContent = message;
  el.className = 'ct-toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 3500 : 2500);
}

// ---------------------------------------------------------------------------
// 1. Tab navigation
// ---------------------------------------------------------------------------
function initTabs() {
  const tabs = document.querySelectorAll('.ct-tab');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.ct-pane').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const targetId = btn.getAttribute('data-tab');
      const content = document.getElementById(targetId);
      if (content) content.classList.add('active');

      if (targetId === 'tab-totp') {
        if (lastConnectionState) loadTotpAccounts();
      } else if (targetId === 'tab-passkeys') {
        if (lastConnectionState) loadCredentials();
      } else if (targetId === 'tab-device') {
        checkStatus();
        loadDevices();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 2. Hardware status
//    Every value used here is a real field from the native host's status
//    response (status/usb/inRange/bonded/daemonRunning/transport/latencyMs/
//    clockSynced/message) -- nothing is invented for visual effect.
// ---------------------------------------------------------------------------
function setIcon(svgEl, symbolId) {
  if (!svgEl) return;
  const use = svgEl.querySelector('use');
  if (use) use.setAttribute('href', `#${symbolId}`);
}

function applyStatus(res) {
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  if (!connDot || !connText) return;

  const isUsb = !!(res && res.status === 'ok' && res.usb);
  const isInRange = !!(res && res.status === 'ok' && res.inRange);
  const isConnected = isUsb || isInRange;
  const isHostOnline = !!(res && res.status === 'ok');
  const isBootloader = !!(res && res.message && res.message.toLowerCase().includes('bootloader'));

  const passkeyDisc = document.getElementById('passkeyDisconnected');
  const passkeyConn = document.getElementById('passkeyConnected');
  const totpDisc = document.getElementById('totpDisconnected');
  const totpConn = document.getElementById('totpConnected');
  const deviceDisc = document.getElementById('deviceDisconnected');
  const deviceConn = document.getElementById('deviceConnected');

  if (passkeyDisc && passkeyConn) {
    passkeyDisc.style.display = isConnected ? 'none' : 'flex';
    passkeyConn.style.display = isConnected ? 'flex' : 'none';
  }
  if (totpDisc && totpConn) {
    totpDisc.style.display = isConnected ? 'none' : 'flex';
    totpConn.style.display = isConnected ? 'flex' : 'none';
  }
  if (deviceDisc && deviceConn) {
    deviceDisc.style.display = isConnected ? 'none' : 'flex';
    deviceConn.style.display = isConnected ? 'flex' : 'none';
  }

  // On the transition into "connected," proactively sync the hardware clock
  // and refresh whichever tab is active -- the daemon already does the sync
  // work; we're just the ones kicking it off. `lastConnectionState === null`
  // covers the very first status this popup instance ever sees (e.g. the
  // token was already plugged in before the popup was opened) -- that's a
  // real "newly connected, from this popup's point of view" case too, just
  // without the clock re-sync, which the background worker already handles
  // on its own cold-start rehydration path.
  const isReconnectTransition = isConnected && lastConnectionState === false;
  const isFirstConnectedObservation = isConnected && lastConnectionState === null;

  if (isReconnectTransition) {
    syncClock();
  }
  if (isReconnectTransition || isFirstConnectedObservation) {
    loadDevices();
    const activeTab = document.querySelector('.ct-tab.active');
    const activeTabId = activeTab ? activeTab.getAttribute('data-tab') : null;
    if (activeTabId === 'tab-totp') loadTotpAccounts();
    else if (activeTabId === 'tab-passkeys') loadCredentials();
  }
  lastConnectionState = isConnected;

  const totpClockDot = document.getElementById('totpClockDot');
  const totpClockBadge = document.getElementById('totpClockBadge');
  const isClockSynced = !!(res && res.clockSynced);

  if (totpClockDot && totpClockBadge) {
    if (isConnected) {
      totpClockDot.className = isClockSynced ? 'ct-dot green' : 'ct-dot yellow';
      totpClockBadge.textContent = isClockSynced ? 'In sync' : 'Sync needed';
    } else {
      totpClockDot.className = 'ct-dot yellow';
      totpClockBadge.textContent = 'Token disconnected';
    }
  }

  // Device tab: connection detail rows, built only from real fields.
  const devTransport = document.getElementById('devTransport');
  const devTransportIcon = document.getElementById('devTransportIcon');
  const devPairRow = document.getElementById('devPairRow');
  const devPair = document.getElementById('devPair');
  const devLatencyRow = document.getElementById('devLatencyRow');
  const devLatency = document.getElementById('devLatency');
  const devService = document.getElementById('devService');
  const devSub = document.getElementById('devSub');
  const devPillDot = document.getElementById('devPillDot');
  const devPillText = document.getElementById('devPillText');

  if (devService) devService.textContent = (res && res.daemonRunning) ? 'Running' : 'Not running';

  if (isUsb) {
    setIcon(devTransportIcon, 'ic-usb');
    if (devTransport) devTransport.textContent = 'USB';
    if (devPairRow) devPairRow.hidden = true;
    if (devLatencyRow) devLatencyRow.hidden = !(res && res.latencyMs);
    if (devLatency && res && res.latencyMs) devLatency.textContent = `${res.latencyMs} ms`;
    if (devSub) devSub.textContent = 'Connected over USB';
    if (devPillDot) devPillDot.className = 'ct-dot green';
    if (devPillText) devPillText.textContent = 'Active';
  } else if (isInRange) {
    setIcon(devTransportIcon, 'ic-bluetooth');
    if (devTransport) devTransport.textContent = 'Bluetooth';
    if (devPairRow) devPairRow.hidden = false;
    if (devPair) devPair.textContent = (res && res.bonded) ? 'Paired' : 'Not paired';
    if (devLatencyRow) devLatencyRow.hidden = !(res && res.latencyMs);
    if (devLatency && res && res.latencyMs) devLatency.textContent = `${res.latencyMs} ms`;
    if (devSub) devSub.textContent = 'Connected over Bluetooth';
    if (devPillDot) devPillDot.className = 'ct-dot green';
    if (devPillText) devPillText.textContent = 'Active';
  } else if (isHostOnline) {
    if (devTransport) devTransport.textContent = 'None';
    if (devPairRow) devPairRow.hidden = true;
    if (devLatencyRow) devLatencyRow.hidden = true;
    if (devSub) devSub.textContent = isBootloader ? 'Waiting -- reflash firmware to continue' : 'Plug in or wake over Bluetooth';
    if (devPillDot) devPillDot.className = 'ct-dot yellow';
    if (devPillText) devPillText.textContent = 'Not detected';
  } else {
    if (devTransport) devTransport.textContent = 'None';
    if (devPairRow) devPairRow.hidden = true;
    if (devLatencyRow) devLatencyRow.hidden = true;
    if (devSub) devSub.textContent = 'Bridge service unreachable';
    if (devPillDot) devPillDot.className = 'ct-dot red';
    if (devPillText) devPillText.textContent = 'Offline';
  }

  // Top bar chip mirrors the same four states.
  if (isUsb) {
    connDot.className = 'ct-dot green';
    connText.textContent = 'USB connected';
  } else if (isInRange) {
    connDot.className = 'ct-dot green';
    connText.textContent = 'Bluetooth connected';
  } else if (isHostOnline) {
    connDot.className = 'ct-dot yellow';
    connText.textContent = isBootloader ? 'Needs firmware' : 'No key inserted';
  } else {
    connDot.className = 'ct-dot red';
    connText.textContent = 'Bridge offline';
  }
}

async function checkStatus(forceFresh = false) {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'status', forceFresh });
    applyStatus(res);
  } catch (err) {
    applyStatus(null);
  }
}

// ---------------------------------------------------------------------------
// 3. Platform Passkey Delegation toggle
//    (ARCHITECTURE.md #3 "Platform Passkey Delegation" escape hatch --
//    this must stay user-controllable.)
// ---------------------------------------------------------------------------
function initBridgeToggle() {
  const toggle = document.getElementById('bridgeToggle');
  if (!toggle) return;
  chrome.storage.local.get(['cryptick_bridge_enabled'], (data) => {
    toggle.checked = data.cryptick_bridge_enabled !== false;
  });
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ cryptick_bridge_enabled: toggle.checked });
  });
}

// ---------------------------------------------------------------------------
// 3b. Saved passkeys -- live from the daemon's list_credentials, grouped by
//     relying party. Replaces the old local "recent sign-in activity" log,
//     which was never what the hardware actually held (see NOTES.md #3's
//     correctness finding): this reads the real resident credentials off
//     the token itself, every time, the same way the Authenticator tab
//     reads real OATH accounts rather than caching them.
//
//     Listing and deleting a saved credential are both gated by the
//     token's own fingerprint/UV ceremony -- the same touch prompt as a
//     normal sign-in, shown on the device's own OLED. There is no PIN
//     anywhere in this flow and this file never asks for or holds one; the
//     only thing rendered here is a "waiting for your touch" state, worded
//     the same way the real sign-in ceremony already is (see injected.js's
//     "Touch your Cryptick Token to verify...").
// ---------------------------------------------------------------------------
const CRED_TOUCH_POLL_MS = 1200;
const CRED_TOUCH_MAX_ATTEMPTS = 40; // ~48s, in line with injected.js's own 60s ceremony timeout

// Sends a native-host-backed action and transparently rides out a
// `touch_required` response by polling the same request again -- the
// daemon is expected to keep answering `touch_required` while the token's
// touch/UV ceremony is still pending, then settle into a terminal status
// (ok/error) once the user touches the sensor or it times out.
// `onTouchPending` fires once per pending poll so the caller can show (or
// keep showing) the "touch your key" state.
async function sendWithTouchWait(action, payload, onTouchPending) {
  for (let attempt = 0; attempt <= CRED_TOUCH_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await chrome.runtime.sendMessage(payload ? { action, payload } : { action });
    } catch (err) {
      console.error(`[Cryptick Token] '${action}' could not reach the background service:`, err.message || err);
      return { status: 'error', message: "Couldn't reach the bridge service." };
    }
    if (res && res.status === 'touch_required') {
      if (onTouchPending) onTouchPending(attempt);
      await new Promise((resolve) => setTimeout(resolve, CRED_TOUCH_POLL_MS));
      continue;
    }
    return res;
  }
  return { status: 'error', message: 'Timed out waiting for your touch.' };
}

function initCredentialsTab() {
  const searchInput = document.getElementById('credSearch');
  if (!searchInput) return;
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    renderCredentialGroups(filterCredentialGroups(q));
  });
}

function showCredTouchGate() {
  const gate = document.getElementById('credTouchGate');
  if (gate) gate.hidden = false;
}

function hideCredTouchGate() {
  const gate = document.getElementById('credTouchGate');
  if (gate) gate.hidden = true;
}

async function loadCredentials() {
  const listEl = document.getElementById('credList');
  if (!listEl) return;

  hideCredTouchGate();
  hideCredCount();
  listEl.innerHTML = `
    <div class="ct-empty">
      <svg class="ct-icon" style="animation: ct-spin 1s linear infinite;"><use href="#ic-refresh"/></svg>
      <span>Reading saved passkeys from your Cryptick Token&hellip;</span>
    </div>`;

  const res = await sendWithTouchWait('list_credentials', null, showCredTouchGate);
  hideCredTouchGate();

  if (res && res.status === 'ok') {
    allCredentialGroups = res.relyingParties || [];
    renderCredCount(res.totalCredentials, res.remainingSlots);
    const searchInput = document.getElementById('credSearch');
    const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
    renderCredentialGroups(filterCredentialGroups(q));
    return;
  }

  renderCredentialError((res && res.message) || "Couldn't load saved passkeys from your Cryptick Token.");
}

function renderCredentialError(msg) {
  const listEl = document.getElementById('credList');
  if (!listEl) return;
  listEl.innerHTML = `
    <div class="ct-empty">
      <svg class="ct-icon"><use href="#ic-error"/></svg>
      <span>${escapeHtml(msg)}</span>
    </div>`;
}

function hideCredCount() {
  const badge = document.getElementById('credCountBadge');
  if (badge) badge.hidden = true;
}

function renderCredCount(total, remaining) {
  const badge = document.getElementById('credCountBadge');
  if (!badge) return;
  if (typeof total !== 'number') {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = (typeof remaining === 'number')
    ? `${total} saved · ${remaining} slots left`
    : `${total} saved`;
}

function filterCredentialGroups(q) {
  if (!q) return allCredentialGroups.filter(rp => (rp.credentials || []).length > 0);
  return allCredentialGroups
    .map(rp => {
      const rpMatches = (rp.rpName && rp.rpName.toLowerCase().includes(q)) ||
                         (rp.rpId && rp.rpId.toLowerCase().includes(q));
      const credentials = (rp.credentials || []).filter(c =>
        rpMatches ||
        (c.userName && c.userName.toLowerCase().includes(q)) ||
        (c.userDisplayName && c.userDisplayName.toLowerCase().includes(q))
      );
      return credentials.length ? { ...rp, credentials } : null;
    })
    .filter(Boolean);
}

function totalCredentialCount(groups) {
  return groups.reduce((n, rp) => n + (rp.credentials || []).length, 0);
}

function renderCredentialGroups(groups) {
  const listEl = document.getElementById('credList');
  if (!listEl) return;

  if (totalCredentialCount(allCredentialGroups) === 0) {
    listEl.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-key"/></svg>
        <span>No saved passkeys</span>
        <span class="ct-empty-note">Passkeys you register with your Cryptick Token will show up here, grouped by site.</span>
      </div>`;
    return;
  }

  if (groups.length === 0) {
    listEl.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-search"/></svg>
        <span>No matches</span>
      </div>`;
    return;
  }

  listEl.innerHTML = '';
  groups.forEach(rp => {
    const section = document.createElement('div');
    section.style.marginBottom = 'var(--ct-sp-2)';

    const header = document.createElement('div');
    header.className = 'ct-section-title';
    header.style.marginBottom = '6px';
    const rpLabel = rp.rpName || rp.rpId || 'Unknown site';
    header.innerHTML = `<span>${escapeHtml(rpLabel)}</span><span class="ct-badge">${(rp.credentials || []).length}</span>`;
    section.appendChild(header);

    const groupList = document.createElement('div');
    groupList.className = 'ct-list';
    groupList.style.marginBottom = 'var(--ct-sp-2)';

    (rp.credentials || []).forEach(cred => {
      groupList.appendChild(renderCredentialRow(rp, cred));
    });

    section.appendChild(groupList);
    listEl.appendChild(section);
  });
}

function renderCredentialRow(rp, cred) {
  const row = document.createElement('div');
  row.className = 'ct-item';

  const title = cred.userDisplayName || cred.userName || 'Passkey';
  const subtitle = (cred.userName && cred.userName !== title) ? cred.userName : (rp.rpId || '');
  const initial = title.charAt(0).toUpperCase() || '?';

  const mainCol = document.createElement('div');
  mainCol.className = 'ct-item-main';
  mainCol.style.cursor = 'default';
  mainCol.innerHTML = `
    <div class="ct-avatar">${escapeHtml(initial)}</div>
    <div class="ct-item-content">
      <span class="ct-item-title">${escapeHtml(title)}</span>
      <span class="ct-item-subtitle">${escapeHtml(subtitle)}</span>
    </div>
  `;

  const actionsCol = document.createElement('div');
  actionsCol.className = 'ct-item-actions';

  const delBtn = document.createElement('button');
  delBtn.className = 'ct-btn-icon danger';
  delBtn.title = 'Permanently delete this passkey from your Cryptick Token';
  delBtn.setAttribute(
    'aria-label',
    `Permanently delete the passkey for ${title} on ${rp.rpName || rp.rpId || 'this site'} from your Cryptick Token`
  );
  delBtn.innerHTML = `<svg class="ct-icon" style="width:14px;height:14px;"><use href="#ic-delete"/></svg>`;

  function resetRowActions() {
    actionsCol.innerHTML = '';
    actionsCol.appendChild(delBtn);
  }

  function triggerDeleteConfirm(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    actionsCol.innerHTML = '';

    const warn = document.createElement('span');
    warn.className = 'ct-badge';
    warn.style.color = 'var(--ct-danger)';
    warn.textContent = 'Delete from device?';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ct-btn-text';
    cancelBtn.style.fontSize = 'var(--ct-fs-xs)';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      resetRowActions();
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'ct-btn-text danger';
    confirmBtn.style.fontSize = 'var(--ct-fs-xs)';
    confirmBtn.style.fontWeight = '700';
    confirmBtn.textContent = 'Delete from device';
    confirmBtn.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      executeDeleteCredential(rp, cred, row, resetRowActions);
    });

    actionsCol.appendChild(warn);
    actionsCol.appendChild(cancelBtn);
    actionsCol.appendChild(confirmBtn);
  }

  delBtn.addEventListener('click', triggerDeleteConfirm);
  actionsCol.appendChild(delBtn);

  row.appendChild(mainCol);
  row.appendChild(actionsCol);
  return row;
}

function touchPendingBadgeHtml() {
  return `<span class="ct-badge"><svg class="ct-icon" style="width:11px;height:11px;vertical-align:-1px;"><use href="#ic-key"/></svg> Touch to verify&hellip;</span>`;
}

async function executeDeleteCredential(rp, cred, rowEl, resetRowActions) {
  const actionsCol = rowEl.querySelector('.ct-item-actions');
  if (actionsCol) actionsCol.innerHTML = touchPendingBadgeHtml();

  const res = await sendWithTouchWait(
    'delete_credential',
    { credentialId: cred.credentialId, rpId: rp.rpId },
    () => { if (actionsCol) actionsCol.innerHTML = touchPendingBadgeHtml(); }
  );

  if (res && res.status === 'ok') {
    rowEl.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    rowEl.style.opacity = '0';
    rowEl.style.transform = 'scale(0.97)';
    showToast('Passkey deleted from your Cryptick Token.', 'success');
    setTimeout(() => loadCredentials(), 160);
    return;
  }

  showToast(
    (res && res.message) || "Your Cryptick Token's bridge service couldn't delete that passkey -- nothing was removed.",
    'error'
  );
  resetRowActions();
}

// ---------------------------------------------------------------------------
// 4. Hardware TOTP (Authenticator tab)
//    Codes are computed on-chip (CTAPHID_CRYPTICK_OATH / INS 0xA2); this
//    only ever displays the 6-digit result the host hands back.
// ---------------------------------------------------------------------------
async function loadTotpAccounts() {
  const container = document.getElementById('totpContainer');
  if (!container) return;

  container.innerHTML = `
    <div class="ct-empty">
      <svg class="ct-icon" style="animation: ct-spin 1s linear infinite;"><use href="#ic-refresh"/></svg>
      <span>Reading accounts from token&hellip;</span>
    </div>`;

  try {
    const res = await chrome.runtime.sendMessage({ action: 'totp_list' });
    if (res && res.status === 'ok') {
      allTotpAccounts = res.accounts || [];
      renderTotpList(allTotpAccounts);
    } else {
      const msg = res && res.message ? 'Could not read accounts from the token.' : 'Plug in or wake Bluetooth to view accounts.';
      container.innerHTML = `
        <div class="ct-empty">
          <svg class="ct-icon"><use href="#ic-warning"/></svg>
          <span>${escapeHtml(msg)}</span>
        </div>`;
    }
  } catch (e) {
    container.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-error"/></svg>
        <span>Token not reachable</span>
      </div>`;
  }
}

function renderTotpList(accounts) {
  const container = document.getElementById('totpContainer');
  if (!container) return;

  if (accounts.length === 0) {
    container.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-clock"/></svg>
        <span>No 2FA accounts found on this token</span>
      </div>`;
    return;
  }

  container.innerHTML = '';
  accounts.forEach(acc => {
    const item = document.createElement('div');
    item.className = 'ct-item';

    const avatar = document.createElement('div');
    avatar.className = 'ct-avatar';
    avatar.innerHTML = `<svg class="ct-icon" style="width:15px;height:15px;"><use href="#ic-clock"/></svg>`;

    const meta = document.createElement('div');
    meta.className = 'ct-item-content';
    meta.style.marginLeft = '8px';

    const label = document.createElement('span');
    label.className = 'ct-item-title';
    label.textContent = acc;
    label.title = acc;

    const sub = document.createElement('span');
    sub.className = 'ct-item-subtitle';
    sub.textContent = 'Hardware 2FA';

    meta.appendChild(label);
    meta.appendChild(sub);

    const actionWrap = document.createElement('div');
    actionWrap.style.display = 'flex';
    actionWrap.style.alignItems = 'center';
    actionWrap.style.flexShrink = '0';
    actionWrap.style.marginLeft = '8px';

    const getBtn = document.createElement('button');
    getBtn.className = 'ct-btn ct-btn-tonal';
    getBtn.style.height = '28px';
    getBtn.style.fontSize = 'var(--ct-fs-2xs)';
    getBtn.textContent = 'Get code';
    getBtn.addEventListener('click', () => fetchTotpCode(acc, actionWrap, getBtn));

    actionWrap.appendChild(getBtn);
    item.appendChild(avatar);
    item.appendChild(meta);
    item.appendChild(actionWrap);
    container.appendChild(item);
  });
}

async function fetchTotpCode(name, container, origBtn) {
  origBtn.textContent = '...';
  origBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ action: 'totp_code', payload: { name } });
    if (res && res.status === 'ok' && res.code) {
      container.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'ct-code-chip';
      box.title = 'Click to copy';
      box.setAttribute('role', 'button');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-label', `Copy 2FA code for ${name}`);

      const codeStr = String(res.code).padStart(6, '0');
      const codeFormatted = codeStr.slice(0, 3) + ' ' + codeStr.slice(3);

      const digits = document.createElement('span');
      digits.className = 'ct-digits';
      digits.textContent = codeFormatted;

      const copyIcon = document.createElement('svg');
      copyIcon.setAttribute('class', 'ct-icon');
      copyIcon.style.width = '12px';
      copyIcon.style.height = '12px';
      copyIcon.style.opacity = '0.75';
      copyIcon.innerHTML = `<use href="#ic-copy"/>`;

      let remaining = res.remaining || 30;
      let isCopied = false;

      const countdown = document.createElement('span');
      countdown.className = 'ct-timer-pill';
      countdown.textContent = `${remaining}s`;

      box.appendChild(digits);
      box.appendChild(copyIcon);
      box.appendChild(countdown);

      function doCopy(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        function fallbackCopy() {
          try {
            const ta = document.createElement('textarea');
            ta.value = codeStr;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          } catch (err) { /* clipboard unavailable; ignore */ }
        }

        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(codeStr).catch(() => fallbackCopy());
        } else {
          fallbackCopy();
        }

        isCopied = true;
        countdown.textContent = 'Copied';
        countdown.style.background = 'var(--ct-primary-dim)';
        countdown.style.color = 'var(--ct-primary)';
        copyIcon.innerHTML = `<use href="#ic-check-circle"/>`;
        copyIcon.style.color = 'var(--ct-primary)';
        copyIcon.style.opacity = '1';

        setTimeout(() => {
          isCopied = false;
          countdown.textContent = `${remaining}s`;
          countdown.style.background = '';
          countdown.style.color = '';
          copyIcon.innerHTML = `<use href="#ic-copy"/>`;
          copyIcon.style.opacity = '0.75';
          copyIcon.style.color = '';
        }, 1200);
      }

      box.addEventListener('click', doCopy);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          doCopy();
        }
      });

      if (activeCountdownIntervals[name]) clearInterval(activeCountdownIntervals[name]);

      activeCountdownIntervals[name] = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(activeCountdownIntervals[name]);
          delete activeCountdownIntervals[name];
          container.innerHTML = '';
          origBtn.textContent = 'Get code';
          origBtn.disabled = false;
          container.appendChild(origBtn);
        } else if (!isCopied) {
          countdown.textContent = `${remaining}s`;
        }
      }, 1000);

      container.appendChild(box);
    } else {
      origBtn.textContent = 'Failed';
      setTimeout(() => {
        origBtn.textContent = 'Get code';
        origBtn.disabled = false;
      }, 2000);
    }
  } catch (err) {
    origBtn.textContent = 'Error';
    setTimeout(() => {
      origBtn.textContent = 'Get code';
      origBtn.disabled = false;
    }, 2000);
  }
}

function initSearch() {
  const searchInput = document.getElementById('totpSearch');
  if (!searchInput) return;
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      renderTotpList(allTotpAccounts);
    } else {
      renderTotpList(allTotpAccounts.filter(acc => acc.toLowerCase().includes(query)));
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Hardware clock sync (RFC 6238 needs the token's RTC within the host's
//    30s window; SET_TIME is a real on-device instruction, not a client-side
//    trick -- see ARCHITECTURE.md #2).
// ---------------------------------------------------------------------------
async function syncClock(btn) {
  const origContent = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="ct-icon" style="width:13px;height:13px; animation: ct-spin 0.8s linear infinite;"><use href="#ic-refresh"/></svg><span>Syncing&hellip;</span>`;
  }

  const totpClockDot = document.getElementById('totpClockDot');
  const totpClockBadge = document.getElementById('totpClockBadge');

  try {
    const res = await chrome.runtime.sendMessage({ action: 'sync_time' });
    if (res && res.status === 'ok') {
      if (totpClockDot) totpClockDot.className = 'ct-dot green';
      if (totpClockBadge) totpClockBadge.textContent = 'In sync';
      showToast('Hardware clock synced.', 'success');
      loadTotpAccounts();
    } else {
      showToast("Couldn't sync the hardware clock. Try again once the token is connected.", 'error');
    }
  } catch (err) {
    showToast("Couldn't reach the bridge service.", 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (origContent) btn.innerHTML = origContent;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Test connection -- a truthful stand-in for the old "Self-Test" panel.
//    It reports only what the status (+ ping) response actually contains;
//    it never asserts anything about on-chip crypto engines or storage that
//    this extension has no way to verify.
// ---------------------------------------------------------------------------
async function runConnectionTest() {
  const btn = document.getElementById('testConnBtn');
  const result = document.getElementById('testConnResult');
  if (!btn || !result) return;

  const origContent = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="ct-icon" style="width:13px;height:13px; animation: ct-spin 1s linear infinite;"><use href="#ic-refresh"/></svg>`;
  result.style.display = 'block';
  result.textContent = 'Checking the connection to your token…';

  try {
    const [status, ping] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'status', forceFresh: true }),
      chrome.runtime.sendMessage({ action: 'ping' }).catch(() => null)
    ]);
    applyStatus(status);

    let line;
    if (status && status.status === 'ok' && (status.usb || status.inRange)) {
      const via = status.usb ? 'USB' : 'Bluetooth';
      const latency = status.latencyMs ? ` — responded in ${status.latencyMs} ms` : '';
      line = `Connected over ${via}${latency}.`;
    } else if (status && status.status === 'ok') {
      line = 'Bridge service is running, but no token is connected.';
    } else {
      line = "Can't reach the bridge service. Make sure it's installed and running.";
    }
    if (ping && ping.status === 'ok' && ping.version) {
      line += ` (Bridge v${ping.version})`;
    }
    result.textContent = line;
  } catch (e) {
    result.textContent = "Couldn't complete the connection test.";
  } finally {
    btn.disabled = false;
    btn.innerHTML = origContent;
  }
}

// ---------------------------------------------------------------------------
// 7. Bridge service restart
// ---------------------------------------------------------------------------
async function handleRestart() {
  const btn = document.getElementById('restartBtn');
  const devSub = document.getElementById('devSub');
  if (devSub) devSub.textContent = 'Restarting the bridge service…';
  if (btn) btn.disabled = true;

  try {
    await chrome.runtime.sendMessage({ action: 'restart' });
  } finally {
    setTimeout(() => {
      checkStatus(true);
      if (btn) btn.disabled = false;
    }, 1200);
  }
}

// ---------------------------------------------------------------------------
// 7b. Device picker -- only shown once list_devices actually reports more
//     than one device (per-task brief: don't build UI for a case that
//     can't be exercised). Rendered as the same .ct-card > .ct-list >
//     .ct-item pattern as "Saved passkeys" and the Authenticator tab,
//     populated from real fields (id/name/transport/active/last_seen) on
//     the Device tab, calling select_device on click. The top-bar status
//     chip and the rest of the Device tab already update from the next
//     checkStatus() poll, so switching devices doesn't need any bespoke
//     chip-update logic here.
// ---------------------------------------------------------------------------
async function loadDevices() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ action: 'list_devices' });
  } catch (err) {
    return; // Best-effort only -- the picker is a convenience, not a critical path.
  }
  if (!res || res.status !== 'ok' || !Array.isArray(res.devices)) return;
  allDevices = res.devices;
  renderDevicePicker();
}

function deviceTransportLabel(transport) {
  if (transport === 'ble' || transport === 'bluetooth') return 'Bluetooth';
  if (transport === 'usb') return 'USB';
  return transport || 'Unknown';
}

function deviceTransportIcon(transport) {
  return (transport === 'ble' || transport === 'bluetooth') ? 'ic-bluetooth' : 'ic-usb';
}

// Best-effort "last seen" phrasing from a ms-epoch `last_seen`. Returns null
// -- never a placeholder string -- when the field isn't present, since a
// daemon that hasn't picked up the new multi-device identity work yet may
// not send it. Computed once per render, not on a ticking timer (this file
// already moved away from 1s-interval clock displays once -- see NOTES.md).
function formatLastSeen(ts) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return null;
  const deltaS = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (deltaS < 10) return 'just now';
  if (deltaS < 60) return `${deltaS}s ago`;
  const m = Math.round(deltaS / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// Two Cryptick Tokens very often share the same default name. Append a
// stable, user-facing ordinal -- never the raw internal device id, which
// this popup deliberately keeps out of user-facing copy throughout (see
// NOTES.md #2) -- to any name that collides with another device's name in
// the current list, so two rows are never shown as literally identical.
function disambiguatedDeviceNames(devices) {
  const seen = {};
  return devices.map(d => {
    const base = d.name || 'Cryptick Token';
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] > 1 ? `${base} (${seen[base]})` : base;
  });
}

function renderDevicePicker() {
  const card = document.getElementById('devicePickerCard');
  const list = document.getElementById('devicePickerList');
  const countBadge = document.getElementById('deviceCountBadge');
  if (!card || !list) return;

  if (allDevices.length <= 1) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  if (countBadge) {
    countBadge.hidden = false;
    countBadge.textContent = `${allDevices.length} devices`;
  }

  const names = disambiguatedDeviceNames(allDevices);
  list.innerHTML = '';
  allDevices.forEach((d, i) => {
    const label = names[i];
    const seen = d.active ? null : formatLastSeen(d.last_seen);
    const subtitle = seen ? `${deviceTransportLabel(d.transport)} · Last seen ${seen}` : deviceTransportLabel(d.transport);
    list.appendChild(renderDeviceRow(d, label, subtitle));
  });
}

function renderDeviceRow(d, label, subtitle) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ct-item';
  row.setAttribute('aria-pressed', d.active ? 'true' : 'false');
  row.setAttribute('aria-label', `${label} — ${subtitle}${d.active ? ' — active' : ''}`);

  const main = document.createElement('div');
  main.className = 'ct-item-main';
  main.innerHTML = `
    <div class="ct-avatar"><svg class="ct-icon" style="width:15px;height:15px;"><use href="#${deviceTransportIcon(d.transport)}"/></svg></div>
    <div class="ct-item-content">
      <span class="ct-item-title">${escapeHtml(label)}</span>
      <span class="ct-item-subtitle">${escapeHtml(subtitle)}</span>
    </div>
  `;

  const actions = document.createElement('div');
  actions.className = 'ct-item-actions';
  if (d.active) {
    actions.innerHTML = `<span class="ct-chip"><span class="ct-dot green"></span><span>Active</span></span>`;
  }

  row.appendChild(main);
  row.appendChild(actions);
  row.addEventListener('click', () => selectDevice(d.id));
  return row;
}

async function selectDevice(id) {
  if (!id) return;
  const current = allDevices.find(d => d.active);
  if (current && current.id === id) return; // already active -- nothing to do

  const rows = document.querySelectorAll('#devicePickerList .ct-item');
  rows.forEach(r => { r.disabled = true; });

  try {
    const res = await chrome.runtime.sendMessage({ action: 'select_device', payload: { id } });
    if (res && res.status === 'ok') {
      allDevices = allDevices.map(d => ({ ...d, active: d.id === id }));
      showToast('Switched active device.', 'success');
      checkStatus(true);
      const activeTab = document.querySelector('.ct-tab.active');
      const activeTabId = activeTab ? activeTab.getAttribute('data-tab') : null;
      if (activeTabId === 'tab-totp') loadTotpAccounts();
      else if (activeTabId === 'tab-passkeys') loadCredentials();
    } else {
      showToast((res && res.message) || "Couldn't switch devices.", 'error');
    }
  } catch (err) {
    showToast("Couldn't reach the bridge service.", 'error');
  } finally {
    renderDevicePicker(); // always rebuild from the real current state
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 8. Boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initBridgeToggle();
  initCredentialsTab();
  initSearch();

  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
  const footerVersion = document.getElementById('footerVersion');
  if (footerVersion) footerVersion.textContent = manifest && manifest.version ? `v${manifest.version}` : '';

  // Instant render from the background worker's last-known cache so the
  // popup never shows a blank/loading flash while a fresh query is inflight.
  chrome.storage.local.get(['cryptick_cached_status'], (data) => {
    if (data.cryptick_cached_status) applyStatus(data.cryptick_cached_status);
  });

  checkStatus(false);
  loadDevices();

  const statusInterval = setInterval(() => checkStatus(false), 1500);
  window.addEventListener('beforeunload', () => clearInterval(statusInterval));

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => checkStatus(true));

  const scanBtn = document.getElementById('totpScanBtn');
  if (scanBtn) scanBtn.addEventListener('click', loadTotpAccounts);

  const totpSyncBtn = document.getElementById('totpSyncBtn');
  if (totpSyncBtn) totpSyncBtn.addEventListener('click', () => syncClock(totpSyncBtn));

  const totpReconnectBtn = document.getElementById('totpReconnectBtn');
  if (totpReconnectBtn) totpReconnectBtn.addEventListener('click', () => checkStatus(true));

  const restartBtn = document.getElementById('restartBtn');
  if (restartBtn) restartBtn.addEventListener('click', handleRestart);

  const refreshBtnDisc = document.getElementById('refreshBtnDisc');
  if (refreshBtnDisc) refreshBtnDisc.addEventListener('click', () => checkStatus(true));

  const testConnBtn = document.getElementById('testConnBtn');
  if (testConnBtn) testConnBtn.addEventListener('click', runConnectionTest);

  // Device picker rows are rebuilt by renderDevicePicker() on every
  // loadDevices()/selectDevice() call, so each row gets its own click
  // listener at creation time (see renderDeviceRow()) -- no static
  // listener to wire up here.

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.cryptick_cached_status) {
      applyStatus(changes.cryptick_cached_status.newValue);
    }
  });
});
