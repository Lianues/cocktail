/**
 * st-html-render-cache
 *
 * 目标：
 * - 解决“消息编辑 -> 取消/确认”导致 JS-Slash-Runner 渲染的 HTML iframe 刷新（重建/重载）的问题。
 *
 * 背景（关键机制）：
 * - 酒馆在进入编辑/取消/确认时会 `.mes_text.empty()` 并重新 `messageFormatting(...)`。
 * - JS-Slash-Runner 在 `event_types.MESSAGE_UPDATED` 时会刷新 message iframe runtimes，
 *   进而触发 Vue Teleport/iframe 组件重新挂载（iframe 被移除再创建）。
 *
 * 核心思路：
 * - 进入编辑前（捕获阶段拦截 `.mes_edit` click）标记并“钉住” `.mes_text` 里现存的 `.TH-render`（含 iframe），
 *   并通过补丁让酒馆的 `.mes_text.empty()` **不会删除**这些被钉住的 `.TH-render`，从而保证 iframe 不被卸载。
 * - 在 `MESSAGE_UPDATED` 发出时，提取“前端代码块（HTML）签名”（直接用 JSR 的 `pre>code` 文本）
 *   与旧签名对比：
 *   - 未变化：本次 emit 中跳过 JSR 的 MESSAGE_UPDATED 监听器，并在事件末尾清理新渲染的 `<pre>`，恢复显示旧 `.TH-render`。
 *   - 有变化：允许 JSR 正常重渲染，并移除旧 `.TH-render`（避免重复 iframe）。
 *
 * 说明：
 * - 这里只做“前端 HTML 代码块”判定，不做复杂 HTML 提取；完全借助 JSR 已经解析出的代码文本。
 */
import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-html-render-cache';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  debugLog: false,
  // 当 HTML 未变时，是否跳过 JS-Slash-Runner 注册的 MESSAGE_UPDATED 监听器
  skipJsSlashRunnerOnMessageUpdated: true,
  // stash 过期清理（避免极端情况下残留）
  cacheTtlMs: 5 * 60 * 1000,
});

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stHtmlRenderCacheLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stHtmlRenderCacheLoaded = true;
}

let _ctx = null;
let _settings = null;

const PIN_ATTR = 'data-st-hrc-pinned';
const PIN_VALUE = '1';
const HIDDEN_ATTR = 'data-st-hrc-hidden';

/**
 * @typedef {{
 *   messageId: number;
 *   createdAt: number;
 *   lastUsedAt: number;
 *   oldBlocks: string[];
 *   thRenders: HTMLElement[];
 *   prevDisplay?: string[];
 *   computedNewBlocks?: string[]|null;
 *   shouldRestore?: boolean;
 }} CacheEntry
 */

/** @type {Map<number, CacheEntry>} */
const _cacheByMessageId = new Map();

// ---- EventSource monkey-patching (listener attribution + selective filtering) ----

/** @type {WeakMap<Function, { stack: string; event: string; ts: number }>} */
const _listenerMeta = new WeakMap();

let _eventSourcePatched = false;
let _origEventSource = null;

let _jqueryEmptyPatched = false;
let _jqEmptyOriginal = null;

function logDebug(...args) {
  if (_settings?.debugLog) {
    console.debug(`[${EXTENSION_NAME}]`, ...args);
  }
}

function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
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
  s.skipJsSlashRunnerOnMessageUpdated = Boolean(s.skipJsSlashRunnerOnMessageUpdated);
  s.cacheTtlMs = clampInt(s.cacheTtlMs, 0, 60 * 60 * 1000, DEFAULT_SETTINGS.cacheTtlMs);

  return s;
}

function saveSettings(ctx) {
  try {
    ctx?.saveSettingsDebounced?.();
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
  }
}

function normalizeCodeText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

// JSR 的“前端代码块”判定很简单：包含这些标记即可
function isFrontendCode(codeText) {
  const s = String(codeText ?? '');
  return s.includes('html>') || s.includes('<head>') || s.includes('<body');
}

/**
 * 从一个 container（通常是 `.mes_text`）提取“前端代码块”列表（按 DOM 顺序）。
 * @param {HTMLElement} container
 * @param {{ ignorePinned?: boolean }} [options]
 * @returns {string[]}
 */
function extractFrontendBlocksFromContainer(container, options = {}) {
  const ignorePinned = Boolean(options.ignorePinned);
  /** @type {string[]} */
  const blocks = [];
  if (!(container instanceof HTMLElement)) return blocks;

  container.querySelectorAll('pre').forEach((pre) => {
    if (!(pre instanceof HTMLElement)) return;
    if (ignorePinned) {
      const pinnedWrapper = pre.closest(`.TH-render[${PIN_ATTR}="${PIN_VALUE}"]`);
      if (pinnedWrapper) return;
    }
    const codeEl = pre.querySelector('code') || pre;
    const txt = normalizeCodeText(codeEl.textContent || '');
    if (!txt) return;
    if (!isFrontendCode(txt)) return;
    blocks.push(txt);
  });

  return blocks;
}

/**
 * 从 stashed 的 `.TH-render` 元素提取“前端代码块”列表（按数组顺序）。
 * @param {HTMLElement[]} thRenders
 * @returns {string[]}
 */
function extractFrontendBlocksFromThRenders(thRenders) {
  /** @type {string[]} */
  const blocks = [];
  for (const el of thRenders) {
    if (!(el instanceof HTMLElement)) continue;
    const pre = el.querySelector('pre');
    if (!(pre instanceof HTMLElement)) continue;
    const codeEl = pre.querySelector('code') || pre;
    const txt = normalizeCodeText(codeEl.textContent || '');
    if (!txt) continue;
    if (!isFrontendCode(txt)) continue;
    blocks.push(txt);
  }
  return blocks;
}

function isSameBlocks(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getMesElementById(messageId) {
  const el = document.querySelector(`#chat > .mes[mesid="${messageId}"]`);
  return el instanceof HTMLElement ? el : null;
}

function getMesTextElement(messageId) {
  const mes = getMesElementById(messageId);
  if (!mes) return null;
  const el = mes.querySelector('.mes_text');
  return el instanceof HTMLElement ? el : null;
}

function getJsSlashRunnerMarkerFromStack(stack) {
  if (!stack) return false;
  // 常见路径：/scripts/extensions/third-party/JS-Slash-Runner/...
  if (/JS-Slash-Runner/i.test(stack)) return true;
  // 某些环境下打包名可能不同，但 dist 里常包含 tavern_helper 的设置字段
  if (/tavern_helper/i.test(stack)) return true;
  return false;
}

function isJsSlashRunnerListener(listenerFn) {
  if (typeof listenerFn !== 'function') return false;
  const meta = _listenerMeta.get(listenerFn);
  if (meta?.stack && getJsSlashRunnerMarkerFromStack(meta.stack)) return true;

  // fallback：极端情况下没记录到 stack 时，尽量不误伤（默认 false）
  return false;
}

function recordListenerMeta(event, listener) {
  if (typeof listener !== 'function') return;
  if (_listenerMeta.has(listener)) return;
  let stack = '';
  try {
    stack = String(new Error().stack || '');
  } catch { }
  _listenerMeta.set(listener, { stack, event: String(event ?? ''), ts: Date.now() });
}

function patchEventSource(ctx) {
  if (_eventSourcePatched) return;
  const es = ctx?.eventSource;
  if (!es || typeof es !== 'object') return;
  if (typeof es.emit !== 'function' || typeof es.on !== 'function') return;

  _origEventSource = {
    emit: es.emit,
    on: es.on,
    once: typeof es.once === 'function' ? es.once : null,
    makeFirst: typeof es.makeFirst === 'function' ? es.makeFirst : null,
    makeLast: typeof es.makeLast === 'function' ? es.makeLast : null,
  };

  // Patch on/makeFirst/makeLast/once to record callsite stack for listener attribution
  es.on = function patchedOn(event, listener) {
    recordListenerMeta(event, listener);
    return _origEventSource.on.call(this, event, listener);
  };
  if (_origEventSource.once) {
    es.once = function patchedOnce(event, listener) {
      recordListenerMeta(event, listener);
      return _origEventSource.once.call(this, event, listener);
    };
  }
  if (_origEventSource.makeFirst) {
    es.makeFirst = function patchedMakeFirst(event, listener) {
      recordListenerMeta(event, listener);
      return _origEventSource.makeFirst.call(this, event, listener);
    };
  }
  if (_origEventSource.makeLast) {
    es.makeLast = function patchedMakeLast(event, listener) {
      recordListenerMeta(event, listener);
      return _origEventSource.makeLast.call(this, event, listener);
    };
  }

  // Patch emit to selectively skip JSR listeners for MESSAGE_UPDATED when HTML signature unchanged.
  es.emit = async function patchedEmit(event, ...args) {
    const eventName = String(event ?? '');
    const messageUpdated = ctx?.eventTypes?.MESSAGE_UPDATED;

    // Only handle MESSAGE_UPDATED with a numeric message id.
    const isMessageUpdated = messageUpdated && eventName === messageUpdated;
    const messageId = isMessageUpdated ? Number(args?.[0]) : NaN;

    let shouldSkipJsr = false;
    if (_settings?.enabled && _settings?.skipJsSlashRunnerOnMessageUpdated && isMessageUpdated && Number.isFinite(messageId)) {
      const entry = _cacheByMessageId.get(messageId);
      if (entry) {
        const mesText = getMesTextElement(messageId);
        const newBlocks = mesText ? extractFrontendBlocksFromContainer(mesText, { ignorePinned: true }) : null;
        entry.computedNewBlocks = newBlocks;
        entry.shouldRestore = Array.isArray(newBlocks) && isSameBlocks(entry.oldBlocks, newBlocks);
        entry.lastUsedAt = Date.now();

        if (entry.shouldRestore) {
          shouldSkipJsr = true;
          logDebug('MESSAGE_UPDATED: html unchanged -> skip JSR listeners', { messageId });
        } else {
          // HTML changed -> we will allow JSR to handle it, but clear cached old iframe early
          // to avoid background side effects.
          logDebug('MESSAGE_UPDATED: html changed -> discard cache, allow JSR', { messageId });
          discardCache(messageId, { reason: 'html_changed_before_emit' });
        }
      }
    }

    // Fast path: no filtering needed.
    if (!shouldSkipJsr) {
      return _origEventSource.emit.call(this, event, ...args);
    }

    // Filter path: copy EventEmitter.emit semantics but skip listeners from JS-Slash-Runner.
    const argsArr = args;
    try {
      if (localStorage.getItem('eventTracing') === 'true') {
        console.trace('Event emitted: ' + eventName, argsArr);
      } else {
        console.debug('Event emitted: ' + eventName);
      }
    } catch { }

    /** @type {any[]} */
    let listeners = [];
    try {
      if (typeof this.events?.[eventName] === 'object') {
        listeners = this.events[eventName].slice();
      }
    } catch { }

    const skipped = listeners.filter((fn) => isJsSlashRunnerListener(fn));
    const filtered = listeners.filter((fn) => !isJsSlashRunnerListener(fn));
    logDebug('MESSAGE_UPDATED filter summary', {
      messageId,
      totalListeners: listeners.length,
      skippedJsSlashRunner: skipped.length,
    });

    for (const fn of filtered) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await fn.apply(this, argsArr);
      } catch (err) {
        console.error(err);
        console.trace('Error in event listener');
      }
    }

    try {
      if (this.autoFireAfterEmit?.has?.(eventName)) {
        this.autoFireLastArgs?.set?.(eventName, argsArr);
      }
    } catch { }
  };

  _eventSourcePatched = true;
  logDebug('patched eventSource (on/emit)');
}

// ---- Cache / stash / restore ----

function pruneCache() {
  const ttl = Number(_settings?.cacheTtlMs ?? DEFAULT_SETTINGS.cacheTtlMs);
  if (!ttl || ttl <= 0) return;
  const now = Date.now();
  for (const [messageId, entry] of Array.from(_cacheByMessageId.entries())) {
    const age = now - (entry.lastUsedAt || entry.createdAt || now);
    if (age > ttl) {
      logDebug('prune stale cache entry', { messageId, ageMs: age });
      discardCache(messageId, { reason: 'ttl' });
    }
  }
}

function discardCache(messageId, { reason } = {}) {
  const entry = _cacheByMessageId.get(messageId);
  if (!entry) return;
  _cacheByMessageId.delete(messageId);

  // Remove pinned nodes from DOM (and therefore iframe) to avoid duplicates/leaks.
  for (const el of entry.thRenders) {
    try {
      el.removeAttribute(PIN_ATTR);
      el.removeAttribute(HIDDEN_ATTR);
      el.style.display = '';
      el.remove();
    } catch { }
  }

  logDebug('discardCache', { messageId, reason });
}

function stashOnEditClick(messageId) {
  if (!_settings?.enabled) return;
  if (!Number.isFinite(messageId) || messageId < 0) return;

  // If already cached for this message, do nothing.
  if (_cacheByMessageId.has(messageId)) return;

  const mesText = getMesTextElement(messageId);
  if (!mesText) return;

  // Only stash JSR-rendered blocks that already have an iframe AND are frontend HTML blocks.
  /** @type {HTMLElement[]} */
  const thRenders = [];
  /** @type {string[]} */
  const oldBlocks = [];

  const candidates = Array.from(mesText.querySelectorAll('.TH-render'))
    .filter((el) => el instanceof HTMLElement)
    .filter((el) => el.querySelector('iframe'));

  for (const el of candidates) {
    const pre = el.querySelector('pre');
    if (!(pre instanceof HTMLElement)) continue;
    const codeEl = pre.querySelector('code') || pre;
    const txt = normalizeCodeText(codeEl.textContent || '');
    if (!txt) continue;
    if (!isFrontendCode(txt)) continue;
    thRenders.push(el);
    oldBlocks.push(txt);
  }

  if (thRenders.length === 0 || oldBlocks.length === 0) return;

  // Pin in-place (do NOT move nodes, to avoid iframe reload).
  /** @type {string[]} */
  const prevDisplay = [];
  for (const el of thRenders) {
    prevDisplay.push(el.style.display || '');
    el.setAttribute(PIN_ATTR, PIN_VALUE);
    el.setAttribute(HIDDEN_ATTR, PIN_VALUE);
    el.style.display = 'none';
  }

  /** @type {CacheEntry} */
  const entry = {
    messageId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    oldBlocks,
    thRenders,
    prevDisplay,
  };
  _cacheByMessageId.set(messageId, entry);

  logDebug('pinned TH-render blocks', { messageId, count: thRenders.length });
}

function cleanupNewFrontendPreBlocks(mesText) {
  if (!(mesText instanceof HTMLElement)) return;
  const targets = [];
  mesText.querySelectorAll('pre').forEach((pre) => {
    if (!(pre instanceof HTMLElement)) return;
    // Skip pinned TH-render's original <pre>
    const pinnedWrapper = pre.closest(`.TH-render[${PIN_ATTR}="${PIN_VALUE}"]`);
    if (pinnedWrapper) return;
    const codeEl = pre.querySelector('code') || pre;
    const txt = normalizeCodeText(codeEl.textContent || '');
    if (!txt) return;
    if (!isFrontendCode(txt)) return;
    const wrapper = pre.closest('.TH-render');
    targets.push(wrapper instanceof HTMLElement ? wrapper : pre);
  });
  for (const el of targets) {
    try { el.remove(); } catch { }
  }
}

function restoreFromCache(messageId) {
  const entry = _cacheByMessageId.get(messageId);
  if (!entry) return;

  const mesText = getMesTextElement(messageId);
  if (!mesText) {
    discardCache(messageId, { reason: 'mes_text_missing' });
    return;
  }

  const newBlocks = Array.isArray(entry.computedNewBlocks)
    ? entry.computedNewBlocks
    : extractFrontendBlocksFromContainer(mesText, { ignorePinned: true });

  if (!isSameBlocks(entry.oldBlocks, newBlocks)) {
    discardCache(messageId, { reason: 'html_changed_on_restore' });
    return;
  }

  // Remove newly rendered frontend <pre> blocks and re-show pinned TH-render(s).
  cleanupNewFrontendPreBlocks(mesText);
  for (let i = 0; i < entry.thRenders.length; i++) {
    const el = entry.thRenders[i];
    try {
      el.removeAttribute(HIDDEN_ATTR);
      el.style.display = entry.prevDisplay?.[i] ?? '';
      el.removeAttribute(PIN_ATTR);
    } catch { }
  }

  // Done: clear cache entry but keep restored nodes in DOM.
  _cacheByMessageId.delete(messageId);
  logDebug('restored TH-render blocks (in-place)', { messageId });
}

function patchJqueryEmpty() {
  if (_jqueryEmptyPatched) return;
  const $ = globalThis.jQuery;
  if (!$ || !$.fn || typeof $.fn.empty !== 'function') return;

  _jqEmptyOriginal = $.fn.empty;
  $.fn.empty = function patchedEmpty() {
    /** @type {HTMLElement[]} */
    const passthrough = [];

    // Note: `this` is a jQuery collection.
    this.each((_idx, el) => {
      if (!(el instanceof HTMLElement)) return;

      // Only special-case chat message body.
      if (!el.classList.contains('mes_text')) {
        passthrough.push(el);
        return;
      }

      const mes = el.closest('#chat .mes');
      if (!(mes instanceof HTMLElement)) {
        passthrough.push(el);
        return;
      }

      const messageId = Number(mes.getAttribute('mesid'));
      if (!Number.isFinite(messageId)) {
        passthrough.push(el);
        return;
      }

      const entry = _cacheByMessageId.get(messageId);
      if (!entry) {
        passthrough.push(el);
        return;
      }

      // Only preserve if we actually have pinned TH-render(s) inside.
      const pinned = el.querySelector(`.TH-render[${PIN_ATTR}="${PIN_VALUE}"]`);
      if (!(pinned instanceof HTMLElement)) {
        passthrough.push(el);
        return;
      }

      // Partial-empty: remove everything except pinned TH-render(s).
      // Important: do NOT detach/reattach pinned nodes to avoid iframe reload.
      const keepSelector = `.TH-render[${PIN_ATTR}="${PIN_VALUE}"]`;
      Array.from(el.childNodes).forEach((node) => {
        if (node instanceof HTMLElement && node.matches(keepSelector)) return;
        try { node.remove(); } catch { }
      });

      entry.lastUsedAt = Date.now();
      logDebug('patched $.fn.empty: preserved pinned TH-render', { messageId });
    });

    if (passthrough.length > 0) {
      // Call ORIGINAL empty on the rest (avoid recursion).
      _jqEmptyOriginal.call($(passthrough));
    }

    return this;
  };

  _jqueryEmptyPatched = true;
  logDebug('patched jQuery.fn.empty');
}

// ---- DOM/event wiring ----

let _editCaptureInstalled = false;
let _messageUpdatedListenerInstalled = false;
let _pruneTimer = null;

function installEditCaptureListener() {
  if (_editCaptureInstalled) return;
  _editCaptureInstalled = true;

  document.addEventListener('click', (ev) => {
    try {
      if (!_settings?.enabled) return;
      const target = ev?.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest('#chat .mes_edit');
      if (!(btn instanceof Element)) return;
      const mes = btn.closest('#chat .mes');
      if (!(mes instanceof HTMLElement)) return;
      const idStr = mes.getAttribute('mesid');
      const messageId = Number(idStr);
      if (!Number.isFinite(messageId)) return;

      // 进入编辑前 stash
      stashOnEditClick(messageId);
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] edit capture failed`, e);
    }
  }, true); // capture
}

function installMessageUpdatedListener(ctx) {
  if (_messageUpdatedListenerInstalled) return;
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (!es || !et?.MESSAGE_UPDATED) return;

  const handler = async (messageId) => {
    try {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      if (!_cacheByMessageId.has(id)) return;

      // 若 emit 内已判断为 shouldRestore，会过滤 JSR listener 并留下缓存；
      // 这里进行最终恢复。
      restoreFromCache(id);
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] MESSAGE_UPDATED handler failed`, e);
    }
  };

  // 尽量最后执行（等酒馆/其他扩展把 DOM 都处理完）
  if (typeof es.makeLast === 'function') {
    es.makeLast(et.MESSAGE_UPDATED, handler);
  } else {
    es.on(et.MESSAGE_UPDATED, handler);
  }

  _messageUpdatedListenerInstalled = true;
}

function installPruneTimer() {
  if (_pruneTimer !== null) return;
  _pruneTimer = window.setInterval(() => {
    try { pruneCache(); } catch { }
  }, 30 * 1000);
}

// ---- Settings UI (optional, but handy) ----

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_hrc_enabled" type="checkbox">
        启用 HTML 渲染缓存（编辑不刷新）
      </label>

      <label class="cocktail-check">
        <input id="st_hrc_skip_jsr" type="checkbox">
        HTML 未变时跳过 JS-Slash-Runner 的 MESSAGE_UPDATED
      </label>

      <label class="cocktail-check">
        <input id="st_hrc_debug" type="checkbox">
        调试日志（console.debug）
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">缓存过期(ms)</span>
        <input id="st_hrc_ttl" type="number" min="0" max="3600000" step="1000">
      </label>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 仅对 <code>.TH-render</code> 且已存在 <code>&lt;iframe&gt;</code> 的楼层生效（JS-Slash-Runner 渲染结果）。</div>
      <div>- “HTML 未变”通过比对前端代码块（<code>pre&gt;code</code> 文本）实现；不解析复杂 DOM。</div>
      <div>- 若遇到兼容性问题，可先关闭“跳过 JS-Slash-Runner”的选项测试。</div>
    </div>
  `;

  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_hrc_enabled'));
  const $skip = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_hrc_skip_jsr'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_hrc_debug'));
  const $ttl = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_hrc_ttl'));

  const refresh = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    _settings = s;
    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($skip) $skip.checked = Boolean(s.skipJsSlashRunnerOnMessageUpdated);
    if ($debug) $debug.checked = Boolean(s.debugLog);
    if ($ttl) $ttl.value = String(s.cacheTtlMs ?? 0);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($skip) s.skipJsSlashRunnerOnMessageUpdated = Boolean($skip.checked);
    if ($debug) s.debugLog = Boolean($debug.checked);
    if ($ttl) s.cacheTtlMs = clampInt($ttl.value, 0, 60 * 60 * 1000, DEFAULT_SETTINGS.cacheTtlMs);
    _settings = s;
    saveSettings(ctx);
    refresh();
  };

  $enabled?.addEventListener('change', onChange);
  $skip?.addEventListener('change', onChange);
  $debug?.addEventListener('change', onChange);
  $ttl?.addEventListener('change', onChange);

  refresh();

  return () => {
    $enabled?.removeEventListener('change', onChange);
    $skip?.removeEventListener('change', onChange);
    $debug?.removeEventListener('change', onChange);
    $ttl?.removeEventListener('change', onChange);
  };
}

registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: 'HTML 渲染缓存',
  order: 80,
  render: renderCocktailSettings,
});

async function init() {
  const ctx = getCtx();
  if (!ctx) {
    setTimeout(init, 500);
    return;
  }

  _ctx = ctx;
  _settings = ensureExtensionSettings(ctx);
  if (!_settings) {
    setTimeout(init, 500);
    return;
  }

  patchEventSource(ctx);
  patchJqueryEmpty();
  installEditCaptureListener();
  installMessageUpdatedListener(ctx);
  installPruneTimer();
}

if (!_ALREADY_LOADED) {
  // Try ASAP (so we can patch before other extensions register listeners)
  init();
  globalThis.jQuery?.(() => {
    init();
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
  });
}

