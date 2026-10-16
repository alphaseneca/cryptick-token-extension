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
let allPasskeys = [];
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
        if (lastConnectionState) loadPasskeyHistory();
      } else if (targetId === 'tab-device') {
        checkStatus();
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
  // work; we're just the ones kicking it off.
  if (isConnected && lastConnectionState === false) {
    syncClock();
    const activeTab = document.querySelector('.ct-tab.active');
    const activeTabId = activeTab ? activeTab.getAttribute('data-tab') : null;
    if (activeTabId === 'tab-totp') loadTotpAccounts();
    else if (activeTabId === 'tab-passkeys') loadPasskeyHistory();
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
// 3. Platform Passkey Delegation toggle + recent sign-in activity
//    (ARCHITECTURE.md #3 "Platform Passkey Delegation" escape hatch --
//    this must stay user-controllable.)
// ---------------------------------------------------------------------------
function initPasskeyTab() {
  const toggle = document.getElementById('bridgeToggle');
  if (toggle) {
    chrome.storage.local.get(['cryptick_bridge_enabled'], (data) => {
      toggle.checked = data.cryptick_bridge_enabled !== false;
    });
    toggle.addEventListener('change', () => {
      chrome.storage.local.set({ cryptick_bridge_enabled: toggle.checked });
    });
  }

  const clearBtn = document.getElementById('clearHistoryBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      chrome.storage.local.remove(['cryptick_passkeys_history'], () => {
        allPasskeys = [];
        renderPasskeyList([]);
      });
    });
  }

  initPasskeySearch();
  loadPasskeyHistory();
}

function initPasskeySearch() {
  const searchInput = document.getElementById('passkeySearch');
  if (!searchInput) return;
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    renderPasskeyList(filterPasskeys(q), q);
  });
}

function filterPasskeys(q) {
  if (!q) return allPasskeys;
  return allPasskeys.filter(item =>
    (item.rpId && item.rpId.toLowerCase().includes(q)) ||
    (item.user && item.user.toLowerCase().includes(q))
  );
}

function loadPasskeyHistory() {
  chrome.storage.local.get(['cryptick_passkeys_history'], (data) => {
    allPasskeys = data.cryptick_passkeys_history || [];
    const searchInput = document.getElementById('passkeySearch');
    const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
    renderPasskeyList(filterPasskeys(q), q);
  });
}

function renderPasskeyList(items, query = '') {
  const listEl = document.getElementById('passkeyList');
  if (!listEl) return;

  if (allPasskeys.length === 0) {
    listEl.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-key"/></svg>
        <span>No sign-ins yet</span>
        <span class="ct-empty-note">Sign in anywhere that supports passkeys and it'll show up here.</span>
      </div>`;
    return;
  }

  if (items.length === 0 && query) {
    listEl.innerHTML = `
      <div class="ct-empty">
        <svg class="ct-icon"><use href="#ic-search"/></svg>
        <span>No matches for &ldquo;${escapeHtml(query)}&rdquo;</span>
      </div>`;
    return;
  }

  listEl.innerHTML = '';
  items.forEach(item => {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'ct-item';

    const domain = item.rpId || 'Unknown site';
    const initial = domain.charAt(0).toUpperCase();
    const user = item.user || 'Hardware passkey';
    const timeFormatted = formatRelativeTime(item.time);
    const actionBadge = item.action === 'create' ? 'Created' : 'Signed in';

    const mainCol = document.createElement('div');
    mainCol.className = 'ct-item-main';
    mainCol.innerHTML = `
      <div class="ct-avatar">${escapeHtml(initial)}</div>
      <div class="ct-item-content">
        <span class="ct-item-title">${escapeHtml(domain)}</span>
        <span class="ct-item-subtitle">${escapeHtml(user)} &bull; ${timeFormatted}</span>
      </div>
    `;

    const actionsCol = document.createElement('div');
    actionsCol.className = 'ct-item-actions';

    const badge = document.createElement('span');
    badge.className = 'ct-badge';
    badge.textContent = actionBadge;

    const delBtn = document.createElement('button');
    delBtn.className = 'ct-btn-icon danger';
    delBtn.title = 'Remove from this list';
    delBtn.setAttribute('aria-label', `Remove ${domain} from recent activity`);
    delBtn.innerHTML = `<svg class="ct-icon" style="width:14px;height:14px;"><use href="#ic-delete"/></svg>`;

    const chevron = document.createElement('svg');
    chevron.setAttribute('class', 'ct-icon ct-item-chevron');
    chevron.innerHTML = `<use href="#ic-chevron"/>`;

    actionsCol.appendChild(badge);
    actionsCol.appendChild(delBtn);
    actionsCol.appendChild(chevron);

    row.appendChild(mainCol);
    row.appendChild(actionsCol);

    const details = document.createElement('div');
    details.className = 'ct-item-details';
    const fullDate = item.time ? new Date(item.time).toLocaleString() : 'Unknown time';
    details.innerHTML = `
      <div class="ct-detail-row"><span>Site</span><strong>${escapeHtml(domain)}</strong></div>
      <div class="ct-detail-row"><span>Account</span><strong>${escapeHtml(user)}</strong></div>
      <div class="ct-detail-row"><span>Last used</span><strong>${escapeHtml(fullDate)}</strong></div>
      <div style="display:flex; justify-content:flex-end; margin-top: 4px;">
        <button class="ct-btn-text danger detail-del-btn" style="font-size: var(--ct-fs-xs);">Remove</button>
      </div>
    `;

    mainCol.addEventListener('click', () => {
      details.classList.toggle('open');
      row.classList.toggle('expanded', details.classList.contains('open'));
    });

    function triggerDeleteConfirm(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      actionsCol.innerHTML = '';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ct-btn-text';
      cancelBtn.style.fontSize = 'var(--ct-fs-xs)';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        actionsCol.innerHTML = '';
        actionsCol.appendChild(badge);
        actionsCol.appendChild(delBtn);
        actionsCol.appendChild(chevron);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'ct-btn-text danger';
      confirmBtn.style.fontSize = 'var(--ct-fs-xs)';
      confirmBtn.style.fontWeight = '700';
      confirmBtn.textContent = 'Remove';
      confirmBtn.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        executeDeletePasskey(item, wrap);
      });

      actionsCol.appendChild(cancelBtn);
      actionsCol.appendChild(confirmBtn);
    }

    delBtn.addEventListener('click', triggerDeleteConfirm);
    const detailDel = details.querySelector('.detail-del-btn');
    if (detailDel) detailDel.addEventListener('click', triggerDeleteConfirm);

    wrap.appendChild(row);
    wrap.appendChild(details);
    listEl.appendChild(wrap);
  });
}

function executeDeletePasskey(item, element) {
  element.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
  element.style.opacity = '0';
  element.style.transform = 'scale(0.97)';

  chrome.runtime.sendMessage({
    action: 'delete_passkey',
    payload: { id: item.id, rpId: item.rpId, user: item.user }
  }, () => {
    chrome.storage.local.get(['cryptick_passkeys_history'], (data) => {
      let updated = data.cryptick_passkeys_history || [];
      updated = item.id
        ? updated.filter(x => x.id !== item.id)
        : updated.filter(x => !(x.rpId === item.rpId && x.user === item.user));
      chrome.storage.local.set({ cryptick_passkeys_history: updated }, () => {
        allPasskeys = updated;
        const searchInput = document.getElementById('passkeySearch');
        const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
        renderPasskeyList(filterPasskeys(q), q);
      });
    });
  });
}

function formatRelativeTime(ts) {
  if (!ts) return 'Unknown time';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  initPasskeyTab();
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.cryptick_passkeys_history) {
      allPasskeys = changes.cryptick_passkeys_history.newValue || [];
      const searchInput = document.getElementById('passkeySearch');
      const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
      renderPasskeyList(filterPasskeys(q), q);
    }
    if (changes.cryptick_cached_status) {
      applyStatus(changes.cryptick_cached_status.newValue);
    }
  });
});
