/**
 * st-ui-animation-optimizer
 *
 * 目标：
 * - 不改酒馆源代码，仅通过前端扩展 JS/CSS 优化 UI 动画与展开体验
 * - 优先解决：顶部抽屉（.drawer-content）展开卡顿、扩展面板 inline-drawer 展开卡顿、WorldInfo 内 inline-drawer 展开卡顿
 *
 * 核心思路：
 * - 顶部抽屉：避免 height 动画（layout thrash），改用 transform/opacity 动画（compositor 友好）
 * - inline-drawer：拦截 click，替换 jQuery slideToggle（height 动画）为 “瞬间布局 + transform/opacity 动画”
 */
import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-ui-animation-optimizer';

const DEFAULT_JQ_SLIDE_MS = 200;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  optimizeTopDrawers: true,
  optimizeJquerySlideAnimations: true,
  optimizeExtensionsInlineDrawers: true,
  optimizeWorldInfoInlineDrawers: true,
  enableWorldInfoContentVisibility: false, // experimental
  disableDrawerBlur: false,

  debugLog: false,
});

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stUiAnimationOptimizerLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stUiAnimationOptimizerLoaded = true;
}

let _ctx = null;
let _settings = null;
let _clickInterceptorInstalled = false;

/** @type {Set<HTMLElement>} */
const _extHostsWithListener = new Set();
/** @type {MutationObserver|null} */
let _extHostObserver = null;
/** @type {boolean} */
let _extHostObsRafPending = false;

/** @type {{ slideToggle: any; slideUp: any; slideDown: any } | null} */
let _jqSlideOriginal = null;
/** @type {boolean} */
let _jqSlidePatched = false;

/** @type {WeakMap<HTMLElement, { timer: number|null; onEnd: ((e: TransitionEvent) => void) | null; }>} */
const _contentAnimState = new WeakMap();

/** @type {Map<number, number>} */
const _wiReserveHeightByWidthKey = new Map();

/** @type {Map<string, { key: string; worldName: string; uid: string; drawerEl: HTMLElement; contentEl: HTMLElement; lastUsedAt: number; createdAt: number; }>} */
const _wiEntryEditorCache = new Map();

/** @type {number|null} */
let _wiCachePruneTimer = null;

/** @type {boolean} */
let _wiWorldSelectListenerInstalled = false;

// WorldInfo entry editor cache:
// - Always enabled (no user settings)
// - Always cleared when switching lorebook
// - Cache persists within the same lorebook (no TTL / no manual clear)
const WI_ENTRY_CACHE_MAX_ENTRIES = 0; // 0 = unlimited (cleared on world switch)
const WI_ENTRY_CACHE_TTL_MS = 0; // 0 = no TTL

const DEFAULT_WI_ENTRY_RESERVE_PX = 620;

function logDebug(...args) {
  if (_settings?.debugLog) {
    console.debug(`[${EXTENSION_NAME}]`, ...args);
  }
}

function clampBool(v, fallback) {
  if (v === undefined) return fallback;
  return Boolean(v);
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

  s.enabled = clampBool(s.enabled, DEFAULT_SETTINGS.enabled);
  s.optimizeTopDrawers = clampBool(s.optimizeTopDrawers, DEFAULT_SETTINGS.optimizeTopDrawers);
  s.optimizeJquerySlideAnimations = clampBool(s.optimizeJquerySlideAnimations, DEFAULT_SETTINGS.optimizeJquerySlideAnimations);
  s.optimizeExtensionsInlineDrawers = clampBool(s.optimizeExtensionsInlineDrawers, DEFAULT_SETTINGS.optimizeExtensionsInlineDrawers);
  s.optimizeWorldInfoInlineDrawers = clampBool(s.optimizeWorldInfoInlineDrawers, DEFAULT_SETTINGS.optimizeWorldInfoInlineDrawers);
  s.enableWorldInfoContentVisibility = clampBool(s.enableWorldInfoContentVisibility, DEFAULT_SETTINGS.enableWorldInfoContentVisibility);
  s.disableDrawerBlur = clampBool(s.disableDrawerBlur, DEFAULT_SETTINGS.disableDrawerBlur);
  s.debugLog = clampBool(s.debugLog, DEFAULT_SETTINGS.debugLog);

  return s;
}

function saveSettings(ctx) {
  try {
    ctx?.saveSettingsDebounced?.();
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
  }
}

function applyBodyClasses() {
  const body = document.body;
  if (!body) return;

  const enabled = Boolean(_settings?.enabled);
  body.classList.toggle('st-uao-enabled', enabled);
  body.classList.toggle('st-uao-top-drawer', enabled && Boolean(_settings?.optimizeTopDrawers));
  body.classList.toggle('st-uao-jq-slide', enabled && Boolean(_settings?.optimizeJquerySlideAnimations));
  body.classList.toggle('st-uao-ext-inline', enabled && Boolean(_settings?.optimizeExtensionsInlineDrawers));
  body.classList.toggle('st-uao-wi-inline', enabled && Boolean(_settings?.optimizeWorldInfoInlineDrawers));
  body.classList.toggle('st-uao-wi-cv', enabled && Boolean(_settings?.enableWorldInfoContentVisibility));
  body.classList.toggle('st-uao-no-blur', enabled && Boolean(_settings?.disableDrawerBlur));
}

function isInteractiveTarget(el) {
  // Avoid collapsing drawers when user interacts with controls in headers.
  return Boolean(el.closest('input, textarea, select, option, button, a, label, [contenteditable="true"], .text_pole, .select2, .select2-container'));
}

function findDrawerParts(drawerEl) {
  const content = drawerEl.querySelector(':scope > .inline-drawer-content');
  /** @type {HTMLElement|null} */
  let icon = drawerEl.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
  if (!icon) {
    // Some UIs use the icon itself as the toggle (or omit a separate header wrapper)
    icon = drawerEl.querySelector(':scope > .inline-drawer-icon');
  }
  return { content, icon };
}

function setInlineDrawerIcon(icon, expanded) {
  if (!isDomElement(icon)) return;
  if (expanded) {
    icon.classList.remove('down', 'fa-circle-chevron-down');
    icon.classList.add('up', 'fa-circle-chevron-up');
  } else {
    icon.classList.remove('up', 'fa-circle-chevron-up');
    icon.classList.add('down', 'fa-circle-chevron-down');
  }
}

function dispatchInlineDrawerToggle(drawerEl) {
  try {
    drawerEl.dispatchEvent(new CustomEvent('inline-drawer-toggle', { bubbles: true }));
  } catch (e) {
    logDebug('dispatch inline-drawer-toggle failed', e);
  }
}

function cleanupAnim(contentEl) {
  const s = _contentAnimState.get(contentEl);
  if (!s) return;
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.onEnd) {
    contentEl.removeEventListener('transitionend', s.onEnd);
    s.onEnd = null;
  }
}

function scheduleTextareaAutoHeight(container) {
  if (CSS.supports('field-sizing', 'content')) return;
  // Defer to avoid blocking the click/animation path.
  setTimeout(() => {
    try {
      container.querySelectorAll('textarea.autoSetHeight').forEach((ta) => {
        if (!(ta instanceof HTMLTextAreaElement)) return;
        ta.style.height = '0px';
        ta.style.height = `${ta.scrollHeight + 3}px`;
      });
    } catch { }
  }, 0);
}

function getJq() {
  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') return null;
  if (!$?.fn) return null;
  return $;
}

function isDomElement(el) {
  return Boolean(el && typeof el === 'object' && el.nodeType === 1);
}

function isStyleableElement(el) {
  if (!isDomElement(el)) return false;
  // Avoid `instanceof HTMLElement` checks (can fail across realms / sandboxes).
  return Boolean(el.style && el.classList);
}

function describeEl(el) {
  if (!isDomElement(el)) return String(el);
  const tag = (el.tagName || '').toLowerCase() || 'element';
  const id = el.id ? `#${el.id}` : '';
  const clsRaw = typeof el.className === 'string' ? el.className : '';
  const cls = clsRaw
    .trim()
    .split(/\s+/g)
    .filter(Boolean)
    .slice(0, 6)
    .join('.');
  const clsPart = cls ? `.${cls}` : '';
  return `${tag}${id}${clsPart}`;
}

function getDataVAttrName(el) {
  if (!isDomElement(el)) return null;
  try {
    for (const name of el.getAttributeNames()) {
      if (name.startsWith('data-v-')) return name;
    }
  } catch { }
  return null;
}

function getElDebugInfo(el) {
  if (!isStyleableElement(el)) return null;
  let cs = null;
  try { cs = getComputedStyle(el); } catch { }
  let rect = null;
  try {
    const r = el.getBoundingClientRect();
    rect = { w: Math.round(r.width), h: Math.round(r.height) };
  } catch { }

  const scriptId = el.closest?.('[script_id]')?.getAttribute?.('script_id') || null;
  const dataV = getDataVAttrName(el);

  return {
    el: describeEl(el),
    isConnected: Boolean(el.isConnected),
    scriptId,
    dataV,
    className: String(el.className || ''),
    style: {
      display: el.style.display || '',
      height: el.style.height || '',
      maxHeight: el.style.maxHeight || '',
      overflow: el.style.overflow || '',
      opacity: el.style.opacity || '',
      transform: el.style.transform || '',
    },
    computed: cs ? {
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      transform: cs.transform,
      height: cs.height,
      maxHeight: cs.maxHeight,
      overflow: cs.overflow,
      overflowY: cs.overflowY,
    } : null,
    rect,
    scrollHeight: Number(el.scrollHeight || 0),
    clientHeight: Number(el.clientHeight || 0),
  };
}

function shouldTraceEl(el) {
  if (!_settings?.debugLog) return false;
  if (!isDomElement(el)) return false;
  // Prioritize extension settings & script-injected blocks (script_id wrapper is common).
  if (el.closest?.('#extensions_settings2, #extensions_settings')) return true;
  if (el.closest?.('[script_id]')) return true;
  if (el.matches?.('.inline-drawer-content, .drawer-content')) return true;
  return false;
}

function isEffectivelyHidden(el) {
  if (!isStyleableElement(el)) return true;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden') return true;
    const rh = el.getBoundingClientRect().height;
    const sh = el.scrollHeight;
    // Consider "collapsed to 0 height" as hidden (some UIs keep display:block but animate height).
    if (rh <= 1 && sh > 2) return true;
    return false;
  } catch {
    return true;
  }
}

function parseJqAnimArgs(args) {
  let durationMs = null;
  /** @type {Function | null} */
  let complete = null;

  const a = args?.[0];
  const b = args?.[1];
  const c = args?.[2];

  if (a && typeof a === 'object') {
    const maybeDur = Number(a.duration);
    if (Number.isFinite(maybeDur)) durationMs = maybeDur;
    if (typeof a.complete === 'function') complete = a.complete;
  } else {
    if (typeof a === 'number') durationMs = a;
    if (typeof a === 'function') complete = a;
    if (typeof b === 'function') complete = b;
    if (typeof c === 'function') complete = c;
  }

  const ms = Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : DEFAULT_JQ_SLIDE_MS;
  return { durationMs: ms, complete };
}

function rememberDisplay(el) {
  if (!isStyleableElement(el)) return;
  try {
    const d = getComputedStyle(el).display;
    if (d && d !== 'none') {
      if (el.dataset) el.dataset.stUaoDisplay = d;
    }
  } catch { }
}

function getDisplayForShow(el) {
  const d = el?.dataset?.stUaoDisplay;
  if (d && d !== 'none') return d;
  return 'block';
}

function showFast(el, durationMs, complete) {
  if (!isStyleableElement(el)) return;
  cleanupAnim(el);

  if (shouldTraceEl(el)) {
    logDebug('jq.showFast:before', getElDebugInfo(el));
  }

  el.classList.add('st-uao-slide');
  el.style.setProperty('--st-uao-slide-duration', `${Math.max(0, durationMs)}ms`);

  // Some UIs (or interrupted jQuery slide* animations) may leave an element stuck at height:0/overflow:hidden.
  // Our compositor-only animation won't "grow" height, so make sure we release those constraints.
  try {
    const h = Number.parseFloat(String(el.style.height || ''));
    if (Number.isFinite(h) && h <= 1) el.style.height = '';
    const mh = Number.parseFloat(String(el.style.maxHeight || ''));
    if (Number.isFinite(mh) && mh <= 1) el.style.maxHeight = '';
    if (el.style.overflow === 'hidden') el.style.overflow = '';
  } catch { }

  // Ensure we start from the "closed" visual state, then animate to open.
  el.classList.remove('st-uao-open');
  el.style.display = getDisplayForShow(el);

  // If the element is still collapsed (height 0 but has scrollHeight), force it open for layout.
  try {
    const sh = el.scrollHeight;
    const rh = el.getBoundingClientRect().height;
    if (sh > 2 && rh <= 1) {
      el.style.height = 'auto';
      el.style.maxHeight = 'none';
      const ov = getComputedStyle(el).overflow;
      if (ov === 'hidden') el.style.overflow = '';
    }
  } catch { }

  // eslint-disable-next-line no-unused-expressions
  el.getBoundingClientRect();
  requestAnimationFrame(() => {
    el.classList.add('st-uao-open');
  });

  const state = { timer: null, onEnd: null };
  state.timer = window.setTimeout(() => {
    cleanupAnim(el);
    try { complete?.call(el); } catch { }
    if (shouldTraceEl(el)) {
      logDebug('jq.showFast:after', getElDebugInfo(el));
    }
  }, Math.max(0, durationMs) + 50);
  _contentAnimState.set(el, state);
}

function hideFast(el, durationMs, complete) {
  if (!isStyleableElement(el)) return;
  cleanupAnim(el);

  if (shouldTraceEl(el)) {
    logDebug('jq.hideFast:before', getElDebugInfo(el));
  }

  rememberDisplay(el);

  let isHidden = false;
  try { isHidden = getComputedStyle(el).display === 'none'; } catch { isHidden = true; }
  if (isHidden) {
    try { complete?.call(el); } catch { }
    return;
  }

  el.classList.add('st-uao-slide');
  el.style.setProperty('--st-uao-slide-duration', `${Math.max(0, durationMs)}ms`);

  // Ensure starting point is "open" so the transition runs.
  el.classList.add('st-uao-open');
  // eslint-disable-next-line no-unused-expressions
  el.getBoundingClientRect();

  requestAnimationFrame(() => {
    el.classList.remove('st-uao-open');
  });

  const finish = () => {
    cleanupAnim(el);
    el.style.display = 'none';
    try { complete?.call(el); } catch { }
    if (shouldTraceEl(el)) {
      logDebug('jq.hideFast:after', getElDebugInfo(el));
    }
  };

  const onEnd = (e) => {
    if (e.target !== el) return;
    if (e.propertyName !== 'opacity') return;
    finish();
  };
  el.addEventListener('transitionend', onEnd);

  const state = { timer: null, onEnd };
  state.timer = window.setTimeout(finish, Math.max(0, durationMs) + 80);
  _contentAnimState.set(el, state);
}

function installJqSlidePatch() {
  const $ = getJq();
  if (!$) return false;
  if (_jqSlidePatched) return true;

  _jqSlideOriginal = {
    slideToggle: $.fn.slideToggle,
    slideUp: $.fn.slideUp,
    slideDown: $.fn.slideDown,
  };

  $.fn.slideDown = function (...args) {
    const { durationMs, complete } = parseJqAnimArgs(args);
    if (_settings?.debugLog) {
      const first = this.get?.(0);
      logDebug('jq.slideDown', { durationMs, count: this.length, first: getElDebugInfo(first) });
    }
    this.each((_, el) => showFast(el, durationMs, complete));
    return this;
  };

  $.fn.slideUp = function (...args) {
    const { durationMs, complete } = parseJqAnimArgs(args);
    if (_settings?.debugLog) {
      const first = this.get?.(0);
      logDebug('jq.slideUp', { durationMs, count: this.length, first: getElDebugInfo(first) });
    }
    this.each((_, el) => hideFast(el, durationMs, complete));
    return this;
  };

  $.fn.slideToggle = function (...args) {
    const { durationMs, complete } = parseJqAnimArgs(args);
    if (_settings?.debugLog) {
      const first = this.get?.(0);
      const stack = String(new Error('jq.slideToggle stack').stack || '').split('\n').slice(0, 10).join('\n');
      logDebug('jq.slideToggle', { durationMs, count: this.length, first: getElDebugInfo(first), stack });
    }
    this.each((_, el) => {
      if (!isStyleableElement(el)) {
        if (_settings?.debugLog) {
          logDebug('jq.slideToggle:skipNonElement', {
            type: Object.prototype.toString.call(el),
            nodeType: el?.nodeType,
            el,
          });
        }
        return;
      }
      const hidden = isEffectivelyHidden(el);
      if (shouldTraceEl(el)) {
        logDebug('jq.slideToggle:decide', { hidden, durationMs, info: getElDebugInfo(el) });
      }
      if (hidden) showFast(el, durationMs, complete);
      else hideFast(el, durationMs, complete);
    });
    return this;
  };

  _jqSlidePatched = true;
  logDebug('jQuery slide* patched');
  return true;
}

function uninstallJqSlidePatch() {
  const $ = getJq();
  if (!$) return;
  if (!_jqSlidePatched) return;
  if (!_jqSlideOriginal) return;
  $.fn.slideToggle = _jqSlideOriginal.slideToggle;
  $.fn.slideUp = _jqSlideOriginal.slideUp;
  $.fn.slideDown = _jqSlideOriginal.slideDown;
  _jqSlidePatched = false;
  logDebug('jQuery slide* restored');
}

function parseTimeToMs(value) {
  const s = String(value ?? '').trim();
  if (!s) return 0;
  if (s.endsWith('ms')) return Number.parseFloat(s) || 0;
  if (s.endsWith('s')) return (Number.parseFloat(s) || 0) * 1000;
  return Number.parseFloat(s) || 0;
}

function getMaxTransitionMs(el) {
  const style = window.getComputedStyle(el);
  const durations = String(style.transitionDuration || '').split(',').map(parseTimeToMs);
  const delays = String(style.transitionDelay || '').split(',').map(parseTimeToMs);
  const len = Math.max(durations.length, delays.length);
  let max = 0;
  for (let i = 0; i < len; i++) {
    const d = durations[i % durations.length] ?? 0;
    const t = delays[i % delays.length] ?? 0;
    max = Math.max(max, d + t);
  }
  if (!Number.isFinite(max) || max <= 0) return 250;
  return Math.min(max, 5000);
}

function isWorldInfoEntriesDrawer(drawerEl) {
  return Boolean(drawerEl.closest('#WorldInfo #world_popup_entries_list'));
}

function getCurrentWorldEditorName() {
  const sel = document.getElementById('world_editor_select');
  if (sel instanceof HTMLSelectElement) {
    const opt = sel.selectedOptions?.[0] || sel.options?.[sel.selectedIndex];
    const name = (opt?.textContent || '').trim();
    return name || null;
  }
  const $ = globalThis.jQuery;
  if (typeof $ === 'function') {
    const name = String($('#world_editor_select').find(':selected').text() || '').trim();
    return name || null;
  }
  return null;
}

function getWorldEntryUidFromDrawer(drawerEl) {
  const entryEl = drawerEl.closest('.world_entry');
  if (!isDomElement(entryEl)) return null;
  const uid = entryEl.getAttribute('uid') || entryEl.dataset.uid;
  return uid ? String(uid) : null;
}

function makeWiEntryCacheKey(worldName, uid) {
  return `${worldName}#${uid}`;
}

function isDrawerOpen(drawerEl, contentEl) {
  if (drawerEl.classList.contains('st-uao-open')) return true;
  try {
    return getComputedStyle(contentEl).display !== 'none';
  } catch {
    return false;
  }
}

function getWorldInfoWidthKeyPx(drawerEl) {
  const rect = drawerEl.getBoundingClientRect();
  const w = Number(rect?.width) || 0;
  // Bucket by 40px to keep cache small while reasonably accurate.
  const key = Math.max(320, Math.round(Math.max(0, w) / 40) * 40);
  return key;
}

function getWorldInfoReserveHeightPx(widthKeyPx) {
  const cached = _wiReserveHeightByWidthKey.get(widthKeyPx);
  if (Number.isFinite(cached) && cached > 80) return Math.round(cached);

  // Default reserve should be conservative to avoid huge gaps.
  // Keep it smaller than before; we will learn real heights per width and cache them.
  const vh = Math.round((window.innerHeight || 800) * 0.5);
  return Math.max(360, Math.min(780, Number.isFinite(vh) ? vh : DEFAULT_WI_ENTRY_RESERVE_PX));
}

function isWorldEntryTopDrawerContent(contentEl) {
  // Top-level entry drawer outlet is both .inline-drawer-content and .inline-drawer-outlet
  return contentEl.classList.contains('inline-drawer-outlet');
}

function isWorldEntryEditorInitialized(contentEl) {
  return Boolean(contentEl.querySelector('.world_entry_edit'));
}

function measureNaturalContentHeight(contentEl) {
  // When we reserve a large fixed height, element.scrollHeight becomes >= clientHeight,
  // which makes it impossible to learn the true content height if content is smaller.
  // Trick: temporarily set height to 0 so scrollHeight reflects real content height.
  const prevHeight = contentEl.style.height;
  const prevOverflow = contentEl.style.overflow;
  try {
    contentEl.style.height = '0px';
    contentEl.style.overflow = 'hidden';
    return Math.max(0, contentEl.scrollHeight);
  } finally {
    contentEl.style.height = prevHeight;
    contentEl.style.overflow = prevOverflow;
  }
}

function ensureLoadingPlaceholder(contentEl) {
  if (contentEl.querySelector('.st-uao-wi-loading')) return;
  const placeholder = document.createElement('div');
  placeholder.className = 'st-uao-wi-loading';
  placeholder.textContent = '加载中…';
  contentEl.appendChild(placeholder);
}

function clearLoadingPlaceholder(contentEl) {
  contentEl.querySelectorAll('.st-uao-wi-loading').forEach((n) => n.remove());
}

function clearJqListDeep($list) {
  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') {
    try { $list?.empty?.(); } catch { }
    return;
  }

  if (!$list?.children?.().length) {
    try { $list?.empty?.(); } catch { }
    return;
  }

  // Unsubscribe from toggle events, so that mass open won't create new drawers
  try { $list.find('.inline-drawer').off('inline-drawer-toggle'); } catch { }

  // Step 1: Clean all <option> elements within <select>
  try {
    $list.find('option').each(function () {
      const $option = $(this);
      $option.off();
      $.cleanData([$option[0]]);
      $option.remove();
    });
  } catch { }

  // Step 2: Clean all <select> elements
  try {
    $list.find('select').each(function () {
      const $select = $(this);
      // Remove Select2-related data and container if present
      if ($select.data('select2')) {
        try { $select.select2('destroy'); } catch { }
      }
      const $container = $select.parent();
      if ($container.length) {
        $container.find('*').off();
        $.cleanData($container.find('*').get());
        $container.remove();
      }

      $select.off();
      $.cleanData([$select[0]]);
    });
  } catch { }

  // Step 3: Clean <div>, <span>, <input>
  try {
    $list.find('div, span, input').each(function () {
      const $elem = $(this);
      $elem.off();
      $.cleanData([$elem[0]]);
      $elem.remove();
    });
  } catch { }

  // Final cleanup
  try { $list.empty(); } catch { }
}

function destroyWorldEntryEditor(contentEl) {
  clearLoadingPlaceholder(contentEl);
  delete contentEl.dataset.stUaoReserveHeight;
  contentEl.style.height = '';
  contentEl.style.overflow = '';

  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') {
    contentEl.innerHTML = '';
    return;
  }

  clearJqListDeep($(contentEl));
}

function touchWiEntryCache(drawerEl, contentEl) {
  if (!_settings?.enabled) return;
  if (!isWorldInfoEntriesDrawer(drawerEl)) return;
  if (!isWorldEntryTopDrawerContent(contentEl)) return;
  if (!isWorldEntryEditorInitialized(contentEl)) return;

  const worldName = getCurrentWorldEditorName();
  const uid = getWorldEntryUidFromDrawer(drawerEl);
  if (!worldName || !uid) return;
  const key = makeWiEntryCacheKey(worldName, uid);

  const now = Date.now();
  const prev = _wiEntryEditorCache.get(key);
  if (prev) {
    prev.drawerEl = drawerEl;
    prev.contentEl = contentEl;
    prev.lastUsedAt = now;
  } else {
    _wiEntryEditorCache.set(key, {
      key,
      worldName,
      uid,
      drawerEl,
      contentEl,
      createdAt: now,
      lastUsedAt: now,
    });
  }

  // Schedule a prune soon (batched).
  if (_wiCachePruneTimer !== null) return;
  _wiCachePruneTimer = window.setTimeout(() => {
    _wiCachePruneTimer = null;
    pruneWiEntryCache();
  }, 500);
}

function pruneWiEntryCache() {
  const now = Date.now();
  const maxEntries = WI_ENTRY_CACHE_MAX_ENTRIES;
  const ttlMs = WI_ENTRY_CACHE_TTL_MS;
  const clearOnWorldChange = true;
  const currentWorld = getCurrentWorldEditorName();

  const evict = (key, item) => {
    if (!item?.contentEl || !item?.drawerEl) {
      _wiEntryEditorCache.delete(key);
      return;
    }
    if (!item.contentEl.isConnected || !item.drawerEl.isConnected) {
      _wiEntryEditorCache.delete(key);
      return;
    }
    if (isDrawerOpen(item.drawerEl, item.contentEl)) return; // never evict open
    destroyWorldEntryEditor(item.contentEl);
    _wiEntryEditorCache.delete(key);
  };

  // 1) Drop disconnected / other-world entries first
  for (const [key, item] of Array.from(_wiEntryEditorCache.entries())) {
    if (!item?.contentEl?.isConnected || !item?.drawerEl?.isConnected) {
      _wiEntryEditorCache.delete(key);
      continue;
    }
    if (clearOnWorldChange && currentWorld && item.worldName !== currentWorld) {
      evict(key, item);
    }
  }

  // 2) TTL eviction
  if (ttlMs > 0) {
    for (const [key, item] of Array.from(_wiEntryEditorCache.entries())) {
      if (!item?.contentEl?.isConnected || !item?.drawerEl?.isConnected) {
        _wiEntryEditorCache.delete(key);
        continue;
      }
      if (isDrawerOpen(item.drawerEl, item.contentEl)) continue;
      if ((now - (item.lastUsedAt || 0)) > ttlMs) {
        evict(key, item);
      }
    }
  }

  // 3) LRU eviction to maxEntries (0 means unlimited)
  if (maxEntries > 0 && _wiEntryEditorCache.size > maxEntries) {
    const candidates = Array
      .from(_wiEntryEditorCache.entries())
      .map(([key, item]) => ({ key, item }))
      .filter(({ item }) => item?.contentEl?.isConnected && item?.drawerEl?.isConnected)
      .filter(({ item }) => !isDrawerOpen(item.drawerEl, item.contentEl))
      .filter(({ item }) => !clearOnWorldChange || !currentWorld || item.worldName === currentWorld);

    candidates.sort((a, b) => (a.item.lastUsedAt || 0) - (b.item.lastUsedAt || 0));

    for (const { key, item } of candidates) {
      if (_wiEntryEditorCache.size <= maxEntries) break;
      evict(key, item);
    }
  }
}

function clearWiEntryCache({ includeOpen = false } = {}) {
  for (const [key, item] of Array.from(_wiEntryEditorCache.entries())) {
    if (!item?.contentEl?.isConnected || !item?.drawerEl?.isConnected) {
      _wiEntryEditorCache.delete(key);
      continue;
    }
    if (!includeOpen && isDrawerOpen(item.drawerEl, item.contentEl)) continue;
    destroyWorldEntryEditor(item.contentEl);
    _wiEntryEditorCache.delete(key);
  }
}

function installWorldEditorSelectListener() {
  if (_wiWorldSelectListenerInstalled) return;
  const sel = document.getElementById('world_editor_select');
  if (!(sel instanceof HTMLSelectElement)) return;

  sel.addEventListener('change', () => {
    if (!_settings?.enabled) return;
    // Always clear cache when switching lorebook.
    clearWiEntryCache({ includeOpen: true });
  });
  _wiWorldSelectListenerInstalled = true;
}

function expandInlineDrawer(drawerEl, contentEl, iconEl) {
  cleanupAnim(contentEl);

  setInlineDrawerIcon(iconEl, true);

  // Ensure legacy inline styles from previous toggles do not interfere.
  contentEl.style.maxHeight = '';
  contentEl.style.overflow = '';
  contentEl.style.height = '';

  // Start from collapsed visual state (CSS handles opacity/transform).
  drawerEl.classList.remove('st-uao-open');
  contentEl.style.display = 'block';

  const inEntries = isWorldInfoEntriesDrawer(drawerEl);
  const isTopOutlet = inEntries && isWorldEntryTopDrawerContent(contentEl);
  const initialized = isTopOutlet ? isWorldEntryEditorInitialized(contentEl) : true;

  // If this is a heavy entry editor, show a tiny placeholder during the animation,
  // then trigger the expensive DOM build after the transition so the animation stays smooth.
  if (isTopOutlet && !initialized) {
    // 关键：立刻占位到“最终高度”，让后续条目一次性下移到位（避免边挤边算）。
    const widthKeyPx = getWorldInfoWidthKeyPx(drawerEl);
    const reservePx = getWorldInfoReserveHeightPx(widthKeyPx);
    contentEl.style.height = `${reservePx}px`;
    contentEl.style.overflow = 'hidden';
    contentEl.dataset.stUaoReserveHeight = String(reservePx);

    // Loading 占位（尽量轻量）
    ensureLoadingPlaceholder(contentEl);
  } else {
    clearLoadingPlaceholder(contentEl);
  }

  // Ensure initial styles are committed before we expand.
  // eslint-disable-next-line no-unused-expressions
  contentEl.getBoundingClientRect();

  requestAnimationFrame(() => {
    drawerEl.classList.add('st-uao-open');
  });

  if (isTopOutlet && !initialized) {
    const delayMs = getMaxTransitionMs(contentEl) + 30;
    const state = { timer: null, onEnd: null };
    state.timer = window.setTimeout(() => {
      state.timer = null;
      const widthKeyPx = getWorldInfoWidthKeyPx(drawerEl);

      // 触发真正的重内容构建（同步，可能会卡一下，但动画已结束，且用户已看到位移+loading）
      dispatchInlineDrawerToggle(drawerEl);

      // 构建完成后移除 loading
      clearLoadingPlaceholder(contentEl);

      // 尽量把“最终高度”校准到真实高度，供后续展开直接占位（避免二次位移）
      try {
        const reservePx = Number(contentEl.dataset.stUaoReserveHeight) || 0;
        const natural = measureNaturalContentHeight(contentEl);
        if (natural > 80) {
          _wiReserveHeightByWidthKey.set(widthKeyPx, natural);

          // If content is larger than reserve, expand immediately to avoid clipping.
          if (natural > reservePx) {
            contentEl.style.height = `${natural}px`;
          }

          requestAnimationFrame(() => {
            if (!drawerEl.classList.contains('st-uao-open')) return;
            // Only release to auto when it would NOT shrink (avoid "回缩" after load).
            if (natural >= reservePx) {
              contentEl.style.height = '';
            }
            contentEl.style.overflow = '';
          });
        } else {
          // fallback: keep behavior, but avoid getting stuck in reserved height
          requestAnimationFrame(() => {
            if (drawerEl.classList.contains('st-uao-open')) {
              contentEl.style.height = '';
              contentEl.style.overflow = '';
            }
          });
        }
      } catch {
        requestAnimationFrame(() => {
          if (drawerEl.classList.contains('st-uao-open')) {
            contentEl.style.height = '';
            contentEl.style.overflow = '';
          }
        });
      }

      scheduleTextareaAutoHeight(contentEl);
      touchWiEntryCache(drawerEl, contentEl);
    }, delayMs);
    _contentAnimState.set(contentEl, state);
  } else {
    // For already-initialized drawers:
    // - For WI entry editor, do NOT trigger `inline-drawer-toggle` (it schedules destroy timers).
    if (!(isTopOutlet && isWorldEntryEditorInitialized(contentEl))) {
      dispatchInlineDrawerToggle(drawerEl);
    }
    scheduleTextareaAutoHeight(contentEl);
    touchWiEntryCache(drawerEl, contentEl);
  }
}

function collapseInlineDrawer(drawerEl, contentEl, iconEl) {
  cleanupAnim(contentEl);

  setInlineDrawerIcon(iconEl, false);
  // IMPORTANT: WorldInfo entry editor uses `inline-drawer-toggle` to lazily build its heavy DOM.
  // If we delayed init (editor not built yet) and the user closes quickly, dispatching here would
  // incorrectly build the editor during close. So only dispatch when it's already initialized.
  const inEntries = isWorldInfoEntriesDrawer(drawerEl);
  const isTopOutlet = inEntries && isWorldEntryTopDrawerContent(contentEl);
  // For WI entry editor, never dispatch here (dispatch would schedule a destroy timer / destroy content).
  if (!isTopOutlet) dispatchInlineDrawerToggle(drawerEl);
  touchWiEntryCache(drawerEl, contentEl);

  // If already hidden, do nothing
  if (getComputedStyle(contentEl).display === 'none') {
    drawerEl.classList.remove('st-uao-open');
    contentEl.style.display = 'none';
    contentEl.style.maxHeight = '';
    contentEl.style.overflow = '';
    contentEl.style.height = '';
    clearLoadingPlaceholder(contentEl);
    return;
  }

  // Remove any pending "open init" placeholder and timers.
  clearLoadingPlaceholder(contentEl);

  drawerEl.classList.remove('st-uao-open');

  const onEnd = (e) => {
    if (e.target !== contentEl) return;
    // We only care about the visual transition finishing once.
    if (e.propertyName !== 'opacity') return;
    cleanupAnim(contentEl);
    if (!drawerEl.classList.contains('st-uao-open')) {
      contentEl.style.display = 'none';
      contentEl.style.maxHeight = '';
      contentEl.style.overflow = '';
      contentEl.style.height = '';
    }
  };
  contentEl.addEventListener('transitionend', onEnd);

  const state = { timer: null, onEnd };
  state.timer = window.setTimeout(() => {
    if (!drawerEl.classList.contains('st-uao-open')) {
      contentEl.style.display = 'none';
      contentEl.style.maxHeight = '';
      contentEl.style.overflow = '';
      contentEl.style.height = '';
    }
    cleanupAnim(contentEl);
  }, getMaxTransitionMs(contentEl) + 80);
  _contentAnimState.set(contentEl, state);
}

function toggleInlineDrawerFast(drawerEl) {
  // Mark as managed so CSS rules only affect drawers we control.
  drawerEl.classList.add('st-uao-managed');
  const { content, icon } = findDrawerParts(drawerEl);
  if (!isStyleableElement(content)) {
    logDebug('toggleInlineDrawerFast: no content', { drawer: describeEl(drawerEl) });
    return;
  }

  const isOpen = !isEffectivelyHidden(content);
  if (_settings?.debugLog && drawerEl.closest?.('#extensions_settings2, #extensions_settings')) {
    logDebug('ext.toggleInlineDrawerFast', {
      drawer: describeEl(drawerEl),
      isOpen,
      title: String(drawerEl.querySelector(':scope > .inline-drawer-header')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      content: getElDebugInfo(content),
    });
  }
  if (isOpen) {
    collapseInlineDrawer(drawerEl, content, icon);
  } else {
    expandInlineDrawer(drawerEl, content, icon);
  }
}

function onClickCapture(e) {
  if (!_settings?.enabled) return;
  if (!_settings?.optimizeWorldInfoInlineDrawers) return;

  const target = e.target;
  if (!isDomElement(target)) return;

  // Find the nearest inline-drawer toggle.
  const toggleEl = target.closest('.inline-drawer-toggle');
  if (!isDomElement(toggleEl)) return;
  if (toggleEl.classList.contains('inline-drawer-maximize')) return;
  // Only intercept the entry chevron icon; avoid nested drawers inside editor.
  if (!toggleEl.classList.contains('inline-drawer-icon')) return;
  if (toggleEl.closest('.world_entry_edit')) return;

  // Scope: only WorldInfo *entries list* (avoid affecting other settings drawers).
  if (!toggleEl.closest('#WorldInfo #world_popup_entries_list')) return;

  // Do not intercept interactions with controls.
  if (isInteractiveTarget(target)) return;

  const drawerEl = toggleEl.closest('.inline-drawer');
  if (!isDomElement(drawerEl)) return;

  // Prevent core delegated handler (jQuery slideToggle) from running.
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  toggleInlineDrawerFast(drawerEl);
}

function installClickInterceptor() {
  if (_clickInterceptorInstalled) return;
  document.addEventListener('click', onClickCapture, true);
  _clickInterceptorInstalled = true;
  logDebug('click interceptor installed');
}

function uninstallClickInterceptor() {
  if (!_clickInterceptorInstalled) return;
  document.removeEventListener('click', onClickCapture, true);
  _clickInterceptorInstalled = false;
  logDebug('click interceptor removed');
}

function getExtensionsSettingsHosts() {
  /** @type {HTMLElement[]} */
  const list = [];
  const el2 = document.getElementById('extensions_settings2');
  if (isDomElement(el2)) list.push(el2);
  const el1 = document.getElementById('extensions_settings');
  if (isDomElement(el1) && el1 !== el2) list.push(el1);
  return list;
}

function isInExtensionsSettings(el) {
  return Boolean(el?.closest?.('#extensions_settings2, #extensions_settings'));
}

function onExtensionsClick(e) {
  if (!_settings?.enabled) return;
  if (!_settings?.optimizeExtensionsInlineDrawers) return;

  const target = e.target;
  if (!isDomElement(target)) return;

  const toggleEl = target.closest('.inline-drawer-toggle');
  if (!isDomElement(toggleEl)) return;
  if (toggleEl.classList.contains('inline-drawer-maximize')) return;

  // Scope: only the extensions settings panel (avoid affecting other settings drawers).
  if (!isInExtensionsSettings(toggleEl)) return;

  // Do not intercept interactions with controls.
  if (isInteractiveTarget(target)) return;

  const drawerEl = toggleEl.closest('.inline-drawer');
  if (!isDomElement(drawerEl)) return;

  if (_settings?.debugLog) {
    const contentEl = drawerEl.querySelector(':scope > .inline-drawer-content');
    const title = String(toggleEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    logDebug('ext.click:intercept', {
      title,
      target: describeEl(target),
      toggle: describeEl(toggleEl),
      drawer: describeEl(drawerEl),
      content: getElDebugInfo(contentEl),
    });
    // Post-state after 2 frames (catches "re-render reverted it" issues)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const contentNow = drawerEl.querySelector(':scope > .inline-drawer-content');
      logDebug('ext.click:after2f', {
        title,
        drawerClass: drawerEl.className,
        content: getElDebugInfo(contentNow),
      });
    }));
  }

  // Block the core delegated handler (jQuery slideToggle on document).
  e.preventDefault();
  e.stopPropagation();

  toggleInlineDrawerFast(drawerEl);
}

function installExtensionsInlineDrawerInterceptor() {
  // Prune detached hosts (some builds may recreate the settings DOM).
  for (const host of Array.from(_extHostsWithListener)) {
    if (!host?.isConnected) _extHostsWithListener.delete(host);
  }

  const hosts = getExtensionsSettingsHosts();
  for (const host of hosts) {
    if (_extHostsWithListener.has(host)) continue;
    host.addEventListener('click', onExtensionsClick, false);
    _extHostsWithListener.add(host);
    logDebug('extensions inline-drawer interceptor attached', host.id);
  }

  // If we have a host, we can avoid a long-lived observer (chat DOM mutates a lot).
  // We'll re-attach on SETTINGS_LOADED / APP_READY anyway.
  if (_extHostsWithListener.size > 0) {
    if (_extHostObserver) {
      try { _extHostObserver.disconnect(); } catch { }
      _extHostObserver = null;
    }
    _extHostObsRafPending = false;
    return;
  }

  if (_extHostObserver) return;
  // Panels can be recreated; observe and attach again when needed.
  try {
    const root = document.getElementById('rm_extensions_block')
      || document.getElementById('top-settings-holder')
      || document.body;
    _extHostObserver = new MutationObserver(() => {
      if (_extHostObsRafPending) return;
      _extHostObsRafPending = true;
      requestAnimationFrame(() => {
        _extHostObsRafPending = false;
        if (!_settings?.enabled || !_settings?.optimizeExtensionsInlineDrawers) return;
        installExtensionsInlineDrawerInterceptor();
      });
    });
    _extHostObserver.observe(root, { childList: true, subtree: true });
  } catch (e) {
    logDebug('extensions host observer failed', e);
  }
}

function uninstallExtensionsInlineDrawerInterceptor() {
  for (const host of Array.from(_extHostsWithListener)) {
    try { host.removeEventListener('click', onExtensionsClick, false); } catch { }
  }
  _extHostsWithListener.clear();

  if (_extHostObserver) {
    try { _extHostObserver.disconnect(); } catch { }
    _extHostObserver = null;
  }
  _extHostObsRafPending = false;
}

function refreshRuntime() {
  applyBodyClasses();

  const wantJqSlide = Boolean(_settings?.enabled && _settings?.optimizeJquerySlideAnimations);
  if (wantJqSlide) {
    installJqSlidePatch();
  } else {
    uninstallJqSlidePatch();
  }

  const wantInterceptor = Boolean(_settings?.enabled && _settings?.optimizeWorldInfoInlineDrawers);
  if (wantInterceptor) {
    installClickInterceptor();
  } else {
    uninstallClickInterceptor();
  }

  const wantExt = Boolean(_settings?.enabled && _settings?.optimizeExtensionsInlineDrawers);
  if (wantExt) {
    installExtensionsInlineDrawerInterceptor();
  } else {
    uninstallExtensionsInlineDrawerInterceptor();
  }

  // WorldInfo entry editor cache is always enabled when the module is enabled.
  if (_settings?.enabled) {
    installWorldEditorSelectListener();
    pruneWiEntryCache();
  }
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return false;

  _ctx = ctx;
  _settings = ensureExtensionSettings(ctx);
  refreshRuntime();
  return true;
}

function renderCocktailSettings(container, ctx) {
  const s = ensureExtensionSettings(ctx);
  if (!s) return;
  _ctx = ctx;
  _settings = s;

  const root = document.createElement('div');
  root.className = 'st-uao-panel';
  root.innerHTML = `
    <div class="st-uao-row">
      <label>
        <input id="st_uao_enabled" type="checkbox">
        启用 UI 动画与展开优化
      </label>
      <label>
        <input id="st_uao_debugLog" type="checkbox">
        Debug log
      </label>
    </div>
    <div class="st-uao-row">
      <label>
        <input id="st_uao_optimizeTopDrawers" type="checkbox">
        顶部面板展开优化（transform/opacity）
      </label>
      <label title="关闭 backdrop-filter 可明显降低 GPU 压力（尤其是内容很多的抽屉面板）。">
        <input id="st_uao_disableDrawerBlur" type="checkbox">
        禁用抽屉背景模糊（backdrop-filter）
      </label>
    </div>
    <div class="st-uao-row">
      <label title="全局替换 jQuery 的 slideToggle/slideDown/slideUp（height 动画）为 transform/opacity，覆盖：大多数 inline-drawer、PromptManager（预设配置面板）等。">
        <input id="st_uao_optimizeJqSlide" type="checkbox">
        全局替换 slideToggle/slideUp/slideDown（减少 height 动画卡顿）
      </label>
      <label title="对扩展设置面板（#extensions_settings2 / #extensions_settings）内的 inline-drawer 生效，替换 slideToggle，减少展开卡顿。">
        <input id="st_uao_optimizeExtensionsInlineDrawers" type="checkbox">
        扩展面板 inline-drawer 展开优化（替换 slideToggle）
      </label>
    </div>
    <div class="st-uao-row">
      <label title="仅对 WorldInfo（#WorldInfo）范围内的 inline-drawer 生效，避免影响其它面板。">
        <input id="st_uao_optimizeWorldInfoInlineDrawers" type="checkbox">
        WorldInfo 子面板展开优化（替换 slideToggle）
      </label>
      <label title="实验性：对离开视口的条目跳过布局/绘制，条目很多时滚动更顺；若出现显示异常请关闭。">
        <input id="st_uao_enableWorldInfoContentVisibility" type="checkbox">
        WorldInfo 条目列表 content-visibility（实验）
      </label>
    </div>
    <div class="st-uao-help">
      <div>说明：</div>
      <div>- 顶部抽屉：移除 <code>height</code> 过渡，改为 <code>transform/opacity</code> 动画，减少打开时的 layout 抖动。</div>
      <div>- 全局 slide*：把 <code>slideToggle/slideDown/slideUp</code> 的“高度动画”替换为合成层动画，减少各类面板展开时的掉帧。</div>
      <div>- WorldInfo 条目抽屉：点击后先“占位下移到位 + 动画 + 加载中”，动画结束再初始化重内容，避免展开过程掉帧。</div>
      <div>- 条目编辑器缓存：同一世界书内会自动缓存已打开过的条目编辑器；切换世界书会自动清空缓存。</div>
      <div>- 如果遇到某些抽屉无法正常展开/关闭，可先关闭本模块对应开关回退。</div>
    </div>
  `;
  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_enabled'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_debugLog'));
  const $top = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_optimizeTopDrawers'));
  const $blur = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_disableDrawerBlur'));
  const $jqSlide = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_optimizeJqSlide'));
  const $extInline = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_optimizeExtensionsInlineDrawers'));
  const $wiInline = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_optimizeWorldInfoInlineDrawers'));
  const $wiCv = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_uao_enableWorldInfoContentVisibility'));

  const refreshUI = () => {
    const ss = ensureExtensionSettings(ctx);
    if (!ss) return;
    _settings = ss;
    if ($enabled) $enabled.checked = Boolean(ss.enabled);
    if ($debug) $debug.checked = Boolean(ss.debugLog);
    if ($top) $top.checked = Boolean(ss.optimizeTopDrawers);
    if ($blur) $blur.checked = Boolean(ss.disableDrawerBlur);
    if ($jqSlide) $jqSlide.checked = Boolean(ss.optimizeJquerySlideAnimations);
    if ($extInline) $extInline.checked = Boolean(ss.optimizeExtensionsInlineDrawers);
    if ($wiInline) $wiInline.checked = Boolean(ss.optimizeWorldInfoInlineDrawers);
    if ($wiCv) $wiCv.checked = Boolean(ss.enableWorldInfoContentVisibility);
  };

  const onChange = () => {
    const ss = ensureExtensionSettings(ctx);
    if (!ss) return;
    if ($enabled) ss.enabled = Boolean($enabled.checked);
    if ($debug) ss.debugLog = Boolean($debug.checked);
    if ($top) ss.optimizeTopDrawers = Boolean($top.checked);
    if ($blur) ss.disableDrawerBlur = Boolean($blur.checked);
    if ($jqSlide) ss.optimizeJquerySlideAnimations = Boolean($jqSlide.checked);
    if ($extInline) ss.optimizeExtensionsInlineDrawers = Boolean($extInline.checked);
    if ($wiInline) ss.optimizeWorldInfoInlineDrawers = Boolean($wiInline.checked);
    if ($wiCv) ss.enableWorldInfoContentVisibility = Boolean($wiCv.checked);

    _settings = ss;
    refreshRuntime();
    saveSettings(ctx);
    refreshUI();
  };

  [$enabled, $debug, $top, $blur, $jqSlide, $extInline, $wiInline, $wiCv].forEach((el) => el?.addEventListener('change', onChange));
  refreshUI();

  return () => {
    [$enabled, $debug, $top, $blur, $jqSlide, $extInline, $wiInline, $wiCv].forEach((el) => el?.removeEventListener('change', onChange));
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: 'UI 动画与抽屉展开优化',
  order: 55,
  render: renderCocktailSettings,
});

// Run on DOM ready, and also on APP_READY (some environments delay init)
if (!_ALREADY_LOADED) {
  globalThis.jQuery?.(async () => {
    const ok = await init();
    if (!ok) return;
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
    ctx?.eventSource?.on?.(ctx.eventTypes?.SETTINGS_LOADED, init);
  });
}

