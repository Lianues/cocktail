/**
 * st-chat-saving-unblocker（集成到 cocktail）
 *
 * 目标：
 * - 不改酒馆源代码：当“保存对话请求已发出但仍在进行”时，允许继续切换角色/群组
 * - 保存状态提示：在页面右下角显示 “↓ / 保存中” 的提示（不依附任何元素）
 * - 保存失败：提示可点击重试
 *
 * 默认：关闭（需要在鸡尾酒面板手动开启）
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-chat-saving-unblocker';

// Avoid double-install (some reload flows can evaluate modules twice)
if (globalThis.__cocktailChatSavingUnblockerLoaded) {
  console.debug(`[${EXTENSION_NAME}] already loaded (cocktail), skipping init`);
} else {
  globalThis.__cocktailChatSavingUnblockerLoaded = true;
}

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false, // IMPORTANT: default OFF (per user request)
  debugLog: false,
  indicatorDelayMs: 300,
});

const STATE = {
  started: false,
  ctx: null,
  settings: null,

  depsPromise: null,
  fetchWrapped: false,
  baseFetch: null,

  inFlightSaveCount: 0,
  /** @type {{ url: string, init: any, failedAt: number, reason: string } | null} */
  lastFailedSave: null,
  /** @type {{ url: string, init: any, startedAt: number } | null} */
  lastSaveRequest: null,

  /** @type {HTMLButtonElement | null} */
  saveBadgeEl: null,
  indicatorShowTimer: /** @type {number|null} */ (null),

  /** @type {{ groupId: string, requestedAt: number } | null} */
  queuedGroupSwitch: null,

  switchingCharacter: false,
  interceptorsInstalled: false,
  placementListenersInstalled: false,
};

function logDebug(...args) {
  if (STATE.settings?.debugLog) console.debug(`[${EXTENSION_NAME}]`, ...args);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function ensureExtensionSettings(ctx) {
  const root = ctx?.extensionSettings;
  if (!root) return null;

  root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
  const s = root[EXTENSION_NAME];

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  s.enabled = Boolean(s.enabled);
  s.debugLog = Boolean(s.debugLog);
  s.indicatorDelayMs = clampInt(s.indicatorDelayMs, 0, 10_000, DEFAULT_SETTINGS.indicatorDelayMs);

  return s;
}

function saveSettings(ctx) {
  try {
    ctx?.saveSettingsDebounced?.();
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
  }
}

function toPathname(input) {
  try {
    if (typeof input === 'string') {
      return new URL(input, window.location.href).pathname;
    }
    if (input && typeof input === 'object' && typeof input.url === 'string') {
      return new URL(input.url, window.location.href).pathname;
    }
  } catch { }
  return null;
}

function toUrlString(input) {
  try {
    if (typeof input === 'string') return new URL(input, window.location.href).toString();
    if (input && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url, window.location.href).toString();
  } catch { }
  return typeof input === 'string' ? input : '';
}

function cloneHeaders(headers) {
  try {
    if (headers instanceof Headers) {
      const out = {};
      headers.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(headers)) return headers.slice();
    if (headers && typeof headers === 'object') return { ...headers };
  } catch { }
  return undefined;
}

function cloneInitForRetry(init) {
  // Avoid reusing AbortSignal; keep only safe fields for retry
  const out = {
    method: init?.method,
    headers: cloneHeaders(init?.headers),
    body: init?.body,
    cache: init?.cache,
    credentials: init?.credentials,
    mode: init?.mode,
    redirect: init?.redirect,
    referrer: init?.referrer,
    referrerPolicy: init?.referrerPolicy,
    integrity: init?.integrity,
    keepalive: init?.keepalive,
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function isChatSavePath(pathname) {
  return pathname === '/api/chats/save' || pathname === '/api/chats/group/save';
}

function getSendButton() {
  const el = document.getElementById('send_but');
  return el instanceof HTMLElement ? el : null;
}

function ensureSaveBadge() {
  const host = getSendButton();
  if (!host) return null;
  if (STATE.saveBadgeEl && host.contains(STATE.saveBadgeEl)) return STATE.saveBadgeEl;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'st-csu-save-badge';
  btn.dataset.state = 'hidden';
  // 不显示额外文案（用户要求只要“↓ / 保存中”）
  btn.title = '';
  btn.tabIndex = -1; // don’t steal focus
  btn.innerHTML = `
    <div class="st-csu-save-badge-arrow">↓</div>
    <div class="st-csu-save-badge-text">保存中</div>
  `.trim();

  btn.addEventListener('click', async (e) => {
    // Only clickable on failed state
    if (btn.dataset.state !== 'failed') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    await retryLastFailedSave();
  });

  host.appendChild(btn);
  STATE.saveBadgeEl = btn;
  return btn;
}

function setSaveBadgeState(state) {
  const el = ensureSaveBadge();
  if (!el) return;

  el.dataset.state = state;
  // Keep title empty to avoid hover/press tooltips.
  el.title = '';

  const arrowEl = el.querySelector('.st-csu-save-badge-arrow');
  const textEl = el.querySelector('.st-csu-save-badge-text');

  if (state === 'saving') {
    if (arrowEl) arrowEl.textContent = '↓';
    if (textEl) textEl.textContent = '保存中';
    el.style.display = '';
    // Don’t block UI while saving
    el.style.pointerEvents = 'none';
    return;
  }

  if (state === 'failed') {
    if (arrowEl) arrowEl.textContent = '!';
    if (textEl) textEl.textContent = '保存失败';
    el.style.display = '';
    // Allow click to retry
    el.style.pointerEvents = 'auto';
    return;
  }

  // hidden
  el.style.display = 'none';
  el.style.pointerEvents = 'none';
}

function clearIndicatorTimer() {
  if (STATE.indicatorShowTimer) {
    clearTimeout(STATE.indicatorShowTimer);
    STATE.indicatorShowTimer = null;
  }
}

function scheduleShowSavingIndicator() {
  if (STATE.indicatorShowTimer) return;
  const delayMs = STATE.settings?.indicatorDelayMs ?? DEFAULT_SETTINGS.indicatorDelayMs;

  STATE.indicatorShowTimer = window.setTimeout(() => {
    STATE.indicatorShowTimer = null;
    if (!STATE.settings?.enabled) return;
    if (STATE.inFlightSaveCount > 0 && !STATE.lastFailedSave) {
      setSaveBadgeState('saving');
    }
  }, Math.max(0, delayMs));
}

function refreshIndicator() {
  if (!STATE.settings?.enabled) {
    clearIndicatorTimer();
    setSaveBadgeState('hidden');
    return;
  }

  // Failed takes priority
  if (STATE.lastFailedSave) {
    clearIndicatorTimer();
    setSaveBadgeState('failed');
    return;
  }

  if (STATE.inFlightSaveCount > 0) {
    scheduleShowSavingIndicator();
    return;
  }

  clearIndicatorTimer();
  setSaveBadgeState('hidden');
}

async function retryLastFailedSave() {
  if (!STATE.settings?.enabled) return;
  const failed = STATE.lastFailedSave;
  if (!failed) return;

  // Clear failed state first to avoid “stuck failed” UI
  STATE.lastFailedSave = null;
  refreshIndicator();

  try {
    // Use current fetch (wrapped) so in-flight state updates properly
    const resp = await (globalThis.fetch || window.fetch)(failed.url, failed.init);
    if (!resp.ok) {
      const reason = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
      STATE.lastFailedSave = { ...failed, failedAt: Date.now(), reason };
    }
  } catch (e) {
    const reason = String(e?.message || e || 'network error');
    STATE.lastFailedSave = { ...failed, failedAt: Date.now(), reason };
  } finally {
    refreshIndicator();
  }
}

async function getDeps() {
  if (STATE.depsPromise) return STATE.depsPromise;
  STATE.depsPromise = Promise.all([
    import('/script.js'),
    import('/scripts/group-chats.js'),
  ]).then(([scriptMod, groupMod]) => ({ scriptMod, groupMod }))
    .catch((e) => {
      console.error(`[${EXTENSION_NAME}] failed to load deps`, e);
      return { scriptMod: null, groupMod: null };
    });
  return STATE.depsPromise;
}

function installFetchWrapper() {
  if (STATE.fetchWrapped) return;

  // Wrap whatever fetch currently is (don’t assume native)
  const baseFetch = (globalThis.fetch || window.fetch).bind(globalThis);
  STATE.baseFetch = baseFetch;

  const wrappedFetch = async (input, init) => {
    const pathname = toPathname(input);
    const isSave = Boolean(pathname && isChatSavePath(pathname));

    // If disabled or not a save endpoint, passthrough
    if (!STATE.settings?.enabled || !isSave) {
      return baseFetch(input, init);
    }

    // Enter in-flight window immediately (request “已发出”)
    STATE.inFlightSaveCount++;
    const startedAt = Date.now();

    const url = toUrlString(input);
    const retryInit = cloneInitForRetry(init);
    STATE.lastSaveRequest = { url, init: retryInit, startedAt };

    // New save attempt clears previous failure
    STATE.lastFailedSave = null;
    refreshIndicator();

    try {
      const resp = await baseFetch(input, init);
      if (!resp.ok) {
        const reason = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
        STATE.lastFailedSave = { url, init: retryInit, failedAt: Date.now(), reason };
      }
      return resp;
    } catch (e) {
      const reason = String(e?.message || e || 'network error');
      STATE.lastFailedSave = { url, init: retryInit, failedAt: Date.now(), reason };
      throw e;
    } finally {
      STATE.inFlightSaveCount = Math.max(0, STATE.inFlightSaveCount - 1);

      // If a group switch was queued, attempt it after saves finish
      if (STATE.inFlightSaveCount === 0 && STATE.queuedGroupSwitch) {
        const { groupId } = STATE.queuedGroupSwitch;
        STATE.queuedGroupSwitch = null;

        const { groupMod } = await getDeps();
        groupMod?.openGroupById?.(groupId).catch((err) => logDebug('queued openGroupById failed', err));
      }

      refreshIndicator();
    }
  };

  globalThis.fetch = wrappedFetch;
  window.fetch = wrappedFetch;
  STATE.fetchWrapped = true;
  logDebug('fetch wrapper installed');
}

function shouldBypassSwitchBlock() {
  // Only allow bypass when a save request is already in-flight.
  return Boolean(STATE.settings?.enabled && STATE.inFlightSaveCount > 0);
}

async function switchCharacterByIdBypass(id) {
  if (!Number.isInteger(id) || id < 0) return;
  if (!STATE.settings?.enabled) return;
  if (STATE.switchingCharacter) return;

  const { scriptMod, groupMod } = await getDeps();
  if (!scriptMod || !groupMod) return;

  const characters = scriptMod.characters;
  if (!Array.isArray(characters) || characters[id] === undefined) return;

  // Match ST behavior: don’t switch while generating
  if (scriptMod.is_send_press) return;
  if (groupMod.selected_group && groupMod.is_group_generating) return;

  const currentId = scriptMod.this_chid;
  if (String(currentId) === String(id)) return;

  STATE.switchingCharacter = true;
  try {
    await scriptMod.clearChat();
    scriptMod.cancelTtsPlay();
    groupMod.resetSelectedGroup();
    scriptMod.setEditedMessageId(undefined);
    scriptMod.setCharacterId(id);
    scriptMod.chat.length = 0;
    scriptMod.updateChatMetadata({}, true);
    await scriptMod.getChat();
  } finally {
    STATE.switchingCharacter = false;
  }
}

function installClickInterceptors() {
  if (STATE.interceptorsInstalled) return;

  // Capture phase: run before ST’s jQuery delegated handlers.
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    if (!shouldBypassSwitchBlock()) return;

    const charEl = e.target.closest('.character_select');
    if (!charEl) return;

    const idStr = charEl.getAttribute('data-chid');
    const id = Number(idStr);
    if (!Number.isFinite(id)) return;

    // Stop original handler to avoid toast + early return.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    // Fire-and-forget switch; errors logged
    switchCharacterByIdBypass(id).catch((err) => logDebug('switchCharacterByIdBypass failed', err));
  }, true);

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    if (!shouldBypassSwitchBlock()) return;

    const groupEl = e.target.closest('.group_select');
    if (!groupEl) return;

    const groupId = groupEl.getAttribute('data-chid') || groupEl.getAttribute('data-grid');
    if (!groupId) return;

    // Group switching needs internal module state; we queue it.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    STATE.queuedGroupSwitch = { groupId: String(groupId), requestedAt: Date.now() };
    // Provide immediate feedback when we intercept a click.
    setSaveBadgeState('saving');
  }, true);

  STATE.interceptorsInstalled = true;
  logDebug('click interceptors installed');
}

function applyEnabled() {
  if (!STATE.settings?.enabled) {
    // Best-effort reset UI/state
    STATE.queuedGroupSwitch = null;
    STATE.lastFailedSave = null;
    // Don’t force inFlightSaveCount=0; if user disables mid-flight, let finally settle.
    refreshIndicator();
    return;
  }

  // Ensure runtime hooks exist
  installFetchWrapper();
  installClickInterceptors();
  ensureSaveBadge();
  refreshIndicator();
}

function renderCocktailSettings(container, ctx) {
  const settings = ensureExtensionSettings(ctx);
  STATE.settings = settings;

  container.innerHTML = `
    <div class="st-csu-panel">
      <div class="st-csu-row">
        <label class="st-csu-check">
          <input id="st_csu_enabled" type="checkbox">
          <span>启用：保存中仍可切换对话</span>
        </label>
      </div>
      <div class="st-csu-help">
        仅当保存请求（/api/chats/save 或 /api/chats/group/save）已经发出且仍在进行时，允许你切换角色/群组；并在右下角显示“↓ / 保存中”提示。保存失败时可点击该提示重试。
      </div>
      <div class="st-csu-row">
        <label class="st-csu-check">
          <input id="st_csu_debug" type="checkbox">
          <span>调试日志</span>
        </label>
        <label class="st-csu-field">
          <span>提示延迟</span>
          <input id="st_csu_delay" type="number" min="0" max="10000" step="50" class="text_pole" style="width:120px">
          <span>ms</span>
        </label>
      </div>
    </div>
  `.trim();

  const $enabled = container.querySelector('#st_csu_enabled');
  const $debug = container.querySelector('#st_csu_debug');
  const $delay = container.querySelector('#st_csu_delay');

  function refreshUI() {
    if ($enabled instanceof HTMLInputElement) $enabled.checked = Boolean(settings.enabled);
    if ($debug instanceof HTMLInputElement) $debug.checked = Boolean(settings.debugLog);
    if ($delay instanceof HTMLInputElement) $delay.value = String(settings.indicatorDelayMs ?? DEFAULT_SETTINGS.indicatorDelayMs);
  }

  const onChange = () => {
    settings.enabled = Boolean($enabled instanceof HTMLInputElement ? $enabled.checked : settings.enabled);
    settings.debugLog = Boolean($debug instanceof HTMLInputElement ? $debug.checked : settings.debugLog);
    settings.indicatorDelayMs = clampInt(
      $delay instanceof HTMLInputElement ? $delay.value : settings.indicatorDelayMs,
      0,
      10_000,
      DEFAULT_SETTINGS.indicatorDelayMs,
    );

    STATE.settings = settings;
    saveSettings(ctx);
    applyEnabled();
    refreshUI();
  };

  [$enabled, $debug, $delay].forEach((el) => el?.addEventListener('change', onChange));

  refreshUI();
  // Don’t auto-enable; only apply current state
  applyEnabled();

  return () => {
    [$enabled, $debug, $delay].forEach((el) => el?.removeEventListener('change', onChange));
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '保存中切换解锁',
  order: 45,
  render: renderCocktailSettings,
});

async function init() {
  const ctx = getCtx();
  if (!ctx) return;

  STATE.ctx = ctx;
  STATE.settings = ensureExtensionSettings(ctx);

  // Default is OFF; only apply if user enabled it previously
  applyEnabled();
}

// Run on DOM ready, and also on APP_READY (some environments delay init)
if (globalThis.jQuery) {
  globalThis.jQuery(async () => {
    if (STATE.started) return;
    STATE.started = true;
    await init();
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
  });
}

