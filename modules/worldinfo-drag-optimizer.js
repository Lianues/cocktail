/**
 * st-worldinfo-drag-optimizer
 *
 * 目标：
 * - 优化 WorldInfo（世界信息）在“自定义排序”时的拖拽排序卡顿
 * - 不改酒馆源代码，仅通过前端扩展 JS/CSS 改善 sortable 拖拽体验
 *
 * 核心思路：
 * - 默认使用“指示线拖拽”：拖拽过程中不让列表项重排，只移动轻量拖拽影子 + 指示线，松手时一次性移动 DOM 并调用 core 的 stop 保存逻辑。
 *   - 好处：大幅减少 mousemove 期间的 layout/paint（尤其是条目 DOM 很重时）
 * - 兼容模式：仍使用 jQuery UI sortable（低风险），但仅调整 helper/placeholder（不改条目外观）。
 */
import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-worldinfo-drag-optimizer';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  engine: 'indicator', // 'indicator' | 'sortable'
  helperMode: 'lite', // 'lite' | 'clone'
  appendToBody: true,
  zIndex: 2147483647,
  autoScrollEnabled: true,
  autoScrollEdgePx: 72,
  autoScrollMinSpeedPx: 4,
  autoScrollMaxSpeedPx: 22,
  debugLog: false,
});

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stWorldInfoDragOptimizerLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stWorldInfoDragOptimizerLoaded = true;
}

let _ctx = null;
let _settings = null;

/** @type {MutationObserver|null} */
let _observer = null;
let _rafPending = false;

/** @type {WeakMap<HTMLElement, { instance: any; patchedAt: number; }>} */
const _patchedByListEl = new WeakMap();

/** @type {Set<HTMLElement>} */
const _indicatorLists = new Set();
/** @type {WeakMap<HTMLElement, { onPointerDown: (e: Event) => void; onMouseDown: (e: Event) => void; onTouchStart: (e: Event) => void; }>} */
const _indicatorHandlers = new WeakMap();

/** @type {null | { listEl: HTMLElement; viewportEl: HTMLElement; listRect: DOMRect; viewportRect: DOMRect; draggedEl: HTMLElement; offsetX: number; offsetY: number; lastX: number; lastY: number; refEl: HTMLElement|null; insertBefore: boolean; ghostEl: HTMLElement; indicatorEl: HTMLElement; rafId: number|null; active: boolean; _onMove: (e: Event) => void; _onUp: (e: Event) => void; }} */
let _drag = null;

function logDebug(...args) {
  if (_settings?.debugLog) console.debug(`[${EXTENSION_NAME}]`, ...args);
}

function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function ensureSettings(ctx) {
  const root = ctx?.extensionSettings;
  if (!root) return null;
  root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
  const s = root[EXTENSION_NAME];

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  s.enabled = Boolean(s.enabled);
  s.engine = (s.engine === 'sortable') ? 'sortable' : 'indicator';
  s.helperMode = (s.helperMode === 'clone') ? 'clone' : 'lite';
  s.appendToBody = Boolean(s.appendToBody);
  s.zIndex = Number.isFinite(Number(s.zIndex)) ? Math.max(0, Math.trunc(Number(s.zIndex))) : DEFAULT_SETTINGS.zIndex;
  s.autoScrollEnabled = Boolean(s.autoScrollEnabled);
  s.autoScrollEdgePx = Number.isFinite(Number(s.autoScrollEdgePx)) ? Math.max(0, Math.trunc(Number(s.autoScrollEdgePx))) : DEFAULT_SETTINGS.autoScrollEdgePx;
  s.autoScrollMinSpeedPx = Number.isFinite(Number(s.autoScrollMinSpeedPx)) ? Math.max(0, Number(s.autoScrollMinSpeedPx)) : DEFAULT_SETTINGS.autoScrollMinSpeedPx;
  s.autoScrollMaxSpeedPx = Number.isFinite(Number(s.autoScrollMaxSpeedPx)) ? Math.max(0, Number(s.autoScrollMaxSpeedPx)) : DEFAULT_SETTINGS.autoScrollMaxSpeedPx;
  if (s.autoScrollMaxSpeedPx < s.autoScrollMinSpeedPx) {
    const tmp = s.autoScrollMaxSpeedPx;
    s.autoScrollMaxSpeedPx = s.autoScrollMinSpeedPx;
    s.autoScrollMinSpeedPx = tmp;
  }
  s.debugLog = Boolean(s.debugLog);

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
  body.classList.toggle('st-wido-enabled', enabled);
  body.classList.toggle('st-wido-engine-indicator', enabled && _settings?.engine === 'indicator');
  body.classList.toggle('st-wido-engine-sortable', enabled && _settings?.engine === 'sortable');
}

function getJq() {
  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') return null;
  if (!$?.fn) return null;
  return $;
}

function getWorldEntriesListEl() {
  const el = document.getElementById('world_popup_entries_list');
  return (el instanceof HTMLElement) ? el : null;
}

function getSortOrderRule() {
  // Optional gating: only when custom order is selected.
  // Prefer jQuery because core uses data-rule on <option>.
  const $ = getJq();
  try {
    if (typeof $ === 'function') {
      const opt = $('#world_info_sort_order').find(':selected');
      const rule = opt?.data?.('rule');
      return rule ? String(rule) : null;
    }
  } catch { }
  return null;
}

function isCustomOrderActive() {
  const rule = getSortOrderRule();
  // If we cannot read the rule (different UI/build), do not block patching.
  if (!rule) return true;
  return rule === 'custom';
}

function pickEntryTitle(worldEntryEl) {
  if (!(worldEntryEl instanceof Element)) return '';
  // Prefer the memo/title textarea value (what the user sees).
  const ta = worldEntryEl.querySelector('textarea[name="comment"]');
  const v = (ta && 'value' in ta) ? String(ta.value || '').trim() : '';
  if (v) return v;

  // Fallback: keys (if any rendered)
  const keyText = String(worldEntryEl.querySelector('.key_info')?.textContent || '').trim();
  if (keyText) return keyText.slice(0, 80);

  // Fallback: uid
  const uid = worldEntryEl.getAttribute('uid') || worldEntryEl.getAttribute('data-uid') || worldEntryEl.dataset?.uid;
  if (uid) return `UID ${uid}`;
  return 'WorldInfo 条目';
}

function makeLiteHelper($, itemEl) {
  const worldEntryEl = itemEl?.closest?.('.world_entry') || itemEl;
  const title = pickEntryTitle(worldEntryEl);

  const helper = document.createElement('div');
  helper.className = 'st-wio-helper';
  helper.textContent = title;

  // Width: keep it stable (avoid text reflow during drag).
  try {
    const w = Math.round($(itemEl).outerWidth?.() || itemEl.getBoundingClientRect().width || 0);
    if (w > 0) helper.style.width = `${w}px`;
  } catch { }

  return $(helper);
}

function patchSortableOptionsForWorldInfo() {
  if (!_settings?.enabled) return false;
  const $ = getJq();
  if (!$) return false;
  const listEl = getWorldEntriesListEl();
  if (!listEl) return false;

  // Only when custom order is active (drag handles are present then).
  if (!isCustomOrderActive()) return false;

  // Only for the sortable engine.
  if (_settings?.engine !== 'sortable') return false;

  const $list = $(listEl);
  let instance;
  try {
    instance = $list.sortable('instance');
  } catch {
    return false;
  }
  if (!instance) return false;

  const prev = _patchedByListEl.get(listEl);
  if (prev?.instance === instance) return true;

  // Patch options (do NOT override core stop callback).
  try {
    const helperOpt = (_settings?.helperMode === 'clone')
      ? 'clone'
      : (e, ui) => makeLiteHelper($, ui?.[0] || ui);

    $list.sortable('option', {
      helper: helperOpt,
      appendTo: _settings?.appendToBody ? document.body : 'parent',
      zIndex: _settings?.zIndex ?? DEFAULT_SETTINGS.zIndex,
      tolerance: 'pointer',
      forcePlaceholderSize: true,
      placeholder: 'st-wio-placeholder',
      cursor: 'grabbing',
      scroll: true,
      scrollSensitivity: 60,
      scrollSpeed: 18,
    });
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] failed to patch sortable options`, e);
    return false;
  }

  // NOTE: We intentionally do NOT change entry styles during drag.

  _patchedByListEl.set(listEl, { instance, patchedAt: Date.now() });
  logDebug('sortable patched', { id: listEl.id, patchedAt: Date.now() });
  return true;
}

function stopEvent(e) {
  try { e.preventDefault?.(); } catch { }
  try { e.stopImmediatePropagation?.(); } catch { }
  try { e.stopPropagation?.(); } catch { }
}

function isScrollableY(el) {
  if (!(el instanceof HTMLElement)) return false;
  try {
    const cs = getComputedStyle(el);
    const ovy = String(cs.overflowY || '');
    const canScroll = ovy === 'auto' || ovy === 'scroll' || ovy === 'overlay';
    if (!canScroll) return false;
    return (el.scrollHeight - el.clientHeight) > 2;
  } catch {
    return false;
  }
}

function findScrollContainer(startEl) {
  /** @type {HTMLElement|null} */
  let el = startEl;
  while (el) {
    if (isScrollableY(el)) return el;
    el = el.parentElement;
  }
  return startEl;
}

function createGhost(draggedEl, widthPx) {
  const ghost = document.createElement('div');
  ghost.className = 'st-wio-helper st-wio-drag-ghost';
  ghost.textContent = pickEntryTitle(draggedEl);
  if (Number.isFinite(widthPx) && widthPx > 0) ghost.style.width = `${Math.round(widthPx)}px`;
  return ghost;
}

function createIndicator(widthPx, leftPx, topPx, zIndex) {
  const el = document.createElement('div');
  el.className = 'st-wio-drop-indicator';
  el.style.left = `${Math.round(leftPx)}px`;
  el.style.top = `${Math.round(topPx)}px`;
  el.style.width = `${Math.round(widthPx)}px`;
  el.style.zIndex = String(zIndex);
  return el;
}

function getWorldEntryAtPoint(listEl, draggedEl, x, y) {
  let el;
  try { el = document.elementFromPoint(x, y); } catch { el = null; }
  if (!(el instanceof Element)) return null;
  const entry = el.closest('.world_entry');
  if (!(entry instanceof HTMLElement)) return null;
  if (entry === draggedEl) return null;
  if (entry.closest('#world_popup_entries_list') !== listEl) return null;
  return entry;
}

function getFirstLastEntry(listEl, draggedEl) {
  const all = Array.from(listEl.querySelectorAll('.world_entry')).filter((n) => n instanceof HTMLElement && n !== draggedEl);
  return {
    first: all[0] || null,
    last: all.length ? all[all.length - 1] : null,
  };
}

function getPointerXY(e) {
  if (e && typeof e === 'object') {
    // TouchEvent
    const touches = /** @type {any} */ (e).touches;
    if (touches && touches.length) {
      return { x: touches[0].clientX, y: touches[0].clientY };
    }
    const changed = /** @type {any} */ (e).changedTouches;
    if (changed && changed.length) {
      return { x: changed[0].clientX, y: changed[0].clientY };
    }
  }
  return { x: /** @type {any} */ (e).clientX, y: /** @type {any} */ (e).clientY };
}

function updateDropTarget(d) {
  // Always keep rect up to date (wheel scroll may move the popup/list container).
  try { d.listRect = d.listEl.getBoundingClientRect(); } catch { }
  try { d.viewportRect = d.viewportEl.getBoundingClientRect(); } catch { }

  const { x, y } = { x: d.lastX, y: d.lastY };
  const listRect = d.listRect;
  const viewportRect = d.viewportRect;

  // Keep indicator aligned with the list
  try {
    d.indicatorEl.style.left = `${Math.round(listRect.left)}px`;
    d.indicatorEl.style.width = `${Math.round(listRect.width)}px`;
  } catch { }

  // Prefer hit-testing the current DOM under pointer (robust to scrolling / dynamic heights).
  const hitEntry = getWorldEntryAtPoint(d.listEl, d.draggedEl, x, y);
  if (hitEntry) {
    const r = hitEntry.getBoundingClientRect();
    const before = y < (r.top + r.height / 2);
    d.refEl = hitEntry;
    d.insertBefore = before;
    d.indicatorEl.style.top = `${Math.round(before ? r.top : r.bottom)}px`;
    return;
  }

  // If we didn't hit an entry (e.g. over whitespace / while wheel scrolling), fall back:
  const { first, last } = getFirstLastEntry(d.listEl, d.draggedEl);
  if (!first || !last) {
    // empty list (shouldn't happen), place indicator at list top
    d.refEl = null;
    d.insertBefore = true;
    d.indicatorEl.style.top = `${Math.round(viewportRect.top)}px`;
    return;
  }

  // Outside the list viewport: clamp to ends
  if (y < viewportRect.top) {
    const r = first.getBoundingClientRect();
    d.refEl = first;
    d.insertBefore = true;
    d.indicatorEl.style.top = `${Math.round(r.top)}px`;
    return;
  }
  if (y > viewportRect.bottom) {
    const r = last.getBoundingClientRect();
    d.refEl = last;
    d.insertBefore = false; // after last
    d.indicatorEl.style.top = `${Math.round(r.bottom)}px`;
    return;
  }

  // Inside list but not on an entry: keep last known target (prevents jitter).
  if (d.refEl && d.refEl !== d.draggedEl && d.refEl.isConnected) {
    const r = d.refEl.getBoundingClientRect();
    d.indicatorEl.style.top = `${Math.round(d.insertBefore ? r.top : r.bottom)}px`;
    return;
  }

  // As a final fallback, pick end based on y position.
  const mid = viewportRect.top + viewportRect.height / 2;
  if (y < mid) {
    const r = first.getBoundingClientRect();
    d.refEl = first;
    d.insertBefore = true;
    d.indicatorEl.style.top = `${Math.round(r.top)}px`;
  } else {
    const r = last.getBoundingClientRect();
    d.refEl = last;
    d.insertBefore = false;
    d.indicatorEl.style.top = `${Math.round(r.bottom)}px`;
  }
}

function tick() {
  if (!_drag || !_drag.active) return;
  const d = _drag;
  d.rafId = requestAnimationFrame(tick);

  // Keep rects up-to-date (wheel scroll can move containers)
  try { d.listRect = d.listEl.getBoundingClientRect(); } catch { }
  try { d.viewportRect = d.viewportEl.getBoundingClientRect(); } catch { }

  // Auto scroll near edges (keeps drag smooth without DOM reorders).
  if (_settings?.autoScrollEnabled) {
    const edgePx = Math.max(0, Number(_settings?.autoScrollEdgePx ?? DEFAULT_SETTINGS.autoScrollEdgePx) || 0);
    const minSpeed = Math.max(0, Number(_settings?.autoScrollMinSpeedPx ?? DEFAULT_SETTINGS.autoScrollMinSpeedPx) || 0);
    const maxSpeed = Math.max(minSpeed, Number(_settings?.autoScrollMaxSpeedPx ?? DEFAULT_SETTINGS.autoScrollMaxSpeedPx) || 0);

    if (edgePx > 0 && maxSpeed > 0) {
      const y = d.lastY;
      const distTop = y - d.viewportRect.top;
      const distBottom = d.viewportRect.bottom - y;

      /** @type {number|null} */
      let delta = null;
      if (distTop < edgePx) {
        const t = Math.max(0, Math.min(1, (edgePx - distTop) / edgePx));
        delta = -(minSpeed + (maxSpeed - minSpeed) * t);
      } else if (distBottom < edgePx) {
        const t = Math.max(0, Math.min(1, (edgePx - distBottom) / edgePx));
        delta = (minSpeed + (maxSpeed - minSpeed) * t);
      }

      if (delta !== null && delta !== 0) {
        const maxScroll = Math.max(0, (d.viewportEl.scrollHeight || 0) - (d.viewportEl.clientHeight || 0));
        const before = d.viewportEl.scrollTop;
        d.viewportEl.scrollTop = Math.max(0, Math.min(maxScroll, d.viewportEl.scrollTop + delta));
        if (_settings?.debugLog && before !== d.viewportEl.scrollTop) {
          logDebug('autoScroll', { delta: Math.round(delta * 10) / 10, scrollTop: Math.round(d.viewportEl.scrollTop) });
        }
      }
    }
  }

  // Move ghost (compositor-friendly)
  const gx = d.lastX - d.offsetX;
  const gy = d.lastY - d.offsetY;
  d.ghostEl.style.transform = `translate3d(${Math.round(gx)}px, ${Math.round(gy)}px, 0)`;

  // Recompute drop target each frame (robust to wheel scroll / dynamic layout)
  updateDropTarget(d);
}

function endDrag({ commit }) {
  if (!_drag) return;
  const d = _drag;
  _drag = null;

  d.active = false;
  if (d.rafId !== null) {
    try { cancelAnimationFrame(d.rafId); } catch { }
  }

  try { d.ghostEl.remove(); } catch { }
  try { d.indicatorEl.remove(); } catch { }

  // Remove listeners
  try {
    window.removeEventListener('pointermove', d._onMove, true);
    window.removeEventListener('pointerup', d._onUp, true);
    window.removeEventListener('pointercancel', d._onUp, true);
  } catch { }
  try {
    window.removeEventListener('mousemove', d._onMove, true);
    window.removeEventListener('mouseup', d._onUp, true);
  } catch { }
  try {
    window.removeEventListener('touchmove', d._onMove, true);
    window.removeEventListener('touchend', d._onUp, true);
    window.removeEventListener('touchcancel', d._onUp, true);
  } catch { }

  if (!commit) return;

  // Commit DOM reorder once, then reuse core stop callback to persist displayIndex/saveWorldInfo.
  try {
    const ref = d.refEl;
    if (ref && ref !== d.draggedEl && ref.parentElement === d.listEl) {
      if (d.insertBefore) {
        d.listEl.insertBefore(d.draggedEl, ref);
      } else {
        d.listEl.insertBefore(d.draggedEl, ref.nextSibling);
      }
    } else {
      d.listEl.appendChild(d.draggedEl);
    }
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] commit reorder failed`, e);
  }

  try {
    const $ = getJq();
    if (typeof $ === 'function') {
      const $list = $(d.listEl);
      const stopFn = $list.sortable('option', 'stop');
      if (typeof stopFn === 'function') {
        Promise.resolve(stopFn.call(d.listEl, null, { item: $(d.draggedEl) })).catch((e) => {
          console.warn(`[${EXTENSION_NAME}] core stop handler failed`, e);
        });
      } else {
        logDebug('core stop handler not found');
      }
    }
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] invoke core stop failed`, e);
  }
}

function startIndicatorDrag(startEvent, listEl, draggedEl) {
  if (_drag) return;

  const $ = getJq();
  if (!$) return;

  // Require sortable instance so we can reuse core stop handler for saving.
  try {
    const inst = $(listEl).sortable('instance');
    if (!inst) return;
  } catch {
    return;
  }

  const viewportEl = findScrollContainer(listEl);
  const viewportRect = viewportEl.getBoundingClientRect();
  const listRect = listEl.getBoundingClientRect();
  const dragRect = draggedEl.getBoundingClientRect();

  const { x, y } = getPointerXY(startEvent);
  const offsetX = Math.max(0, Math.min(dragRect.width, x - dragRect.left));
  const offsetY = Math.max(0, Math.min(dragRect.height, y - dragRect.top));

  const ghost = createGhost(draggedEl, dragRect.width);
  ghost.style.zIndex = String(_settings?.zIndex ?? DEFAULT_SETTINGS.zIndex);
  ghost.style.transform = `translate3d(${Math.round(dragRect.left)}px, ${Math.round(dragRect.top)}px, 0)`;
  document.body.appendChild(ghost);

  const indicator = createIndicator(listRect.width, listRect.left, viewportRect.top, _settings?.zIndex ?? DEFAULT_SETTINGS.zIndex);
  document.body.appendChild(indicator);

  const d = {
    listEl,
    viewportEl,
    draggedEl,
    listRect,
    viewportRect,
    offsetX,
    offsetY,
    lastX: x,
    lastY: y,
    refEl: null,
    insertBefore: true,
    ghostEl: ghost,
    indicatorEl: indicator,
    rafId: null,
    active: true,
  };

  const onMove = (ev) => {
    if (!_drag || !_drag.active) return;
    // For touch, prevent page scroll while dragging.
    if (ev && typeof ev === 'object' && String(ev.type || '').startsWith('touch')) {
      try { ev.preventDefault?.(); } catch { }
      try { ev.stopPropagation?.(); } catch { }
    }
    const p = getPointerXY(ev);
    _drag.lastX = p.x;
    _drag.lastY = p.y;
  };

  const onUp = (ev) => {
    stopEvent(ev);
    try {
      if (_drag && _drag.active) updateDropTarget(_drag);
    } catch { }
    endDrag({ commit: true });
  };

  d._onMove = onMove;
  d._onUp = onUp;

  _drag = d;

  // Install move/up listeners
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('touchmove', onMove, { capture: true, passive: false });
  window.addEventListener('touchend', onUp, { capture: true, passive: false });
  window.addEventListener('touchcancel', onUp, { capture: true, passive: false });

  // Initial target/indicator
  updateDropTarget(d);

  // Start rAF loop
  d.rafId = requestAnimationFrame(tick);

  logDebug('indicator drag start', {
    title: pickEntryTitle(draggedEl),
    viewport: viewportEl?.id || viewportEl?.className || viewportEl?.tagName,
  });
}

function installIndicatorEngine(listEl) {
  if (!_settings?.enabled) return false;
  if (_settings?.engine !== 'indicator') return false;
  if (!isCustomOrderActive()) return false;

  if (_indicatorLists.has(listEl)) return true;

  const onPointerDown = (e) => {
    if (!_settings?.enabled) return;
    if (_settings?.engine !== 'indicator') return;
    if (!isCustomOrderActive()) return;
    if (_drag) return;

    const target = e.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest('.drag-handle');
    if (!(handle instanceof Element)) return;
    const draggedEl = handle.closest('.world_entry');
    if (!(draggedEl instanceof HTMLElement)) return;
    if (draggedEl.closest('#world_popup_entries_list') !== listEl) return;

    // Left click only for mouse events
    if (e.type === 'mousedown' && typeof e.button === 'number' && e.button !== 0) return;

    stopEvent(e);
    startIndicatorDrag(e, listEl, draggedEl);
  };

  // Need mousedown capture to block jQuery UI mouse plugin; pointerdown alone won't stop mousedown.
  const onMouseDown = onPointerDown;
  const onTouchStart = onPointerDown;

  listEl.addEventListener('pointerdown', onPointerDown, true);
  listEl.addEventListener('mousedown', onMouseDown, true);
  listEl.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });

  _indicatorLists.add(listEl);
  _indicatorHandlers.set(listEl, { onPointerDown, onMouseDown, onTouchStart });
  logDebug('indicator engine installed');
  return true;
}

function uninstallIndicatorEngineIfNeeded() {
  for (const el of Array.from(_indicatorLists)) {
    const shouldKeep = Boolean(_settings?.enabled && _settings?.engine === 'indicator' && el.isConnected);
    if (shouldKeep) continue;
    const h = _indicatorHandlers.get(el);
    try { el.removeEventListener('pointerdown', h?.onPointerDown, true); } catch { }
    try { el.removeEventListener('mousedown', h?.onMouseDown, true); } catch { }
    try { el.removeEventListener('touchstart', h?.onTouchStart, true); } catch { }
    _indicatorLists.delete(el);
  }
}

function refreshRuntime() {
  applyBodyClasses();
  uninstallIndicatorEngineIfNeeded();

  if (!_settings?.enabled) return;
  const listEl = getWorldEntriesListEl();
  if (!listEl) return;

  // Install the selected engine.
  if (_settings?.engine === 'indicator') {
    installIndicatorEngine(listEl);
  } else {
    patchSortableOptionsForWorldInfo();
  }
}

function installObserver() {
  if (_observer) return;
  _observer = new MutationObserver(() => {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      refreshRuntime();
    });
  });

  try {
    const root = document.getElementById('WorldInfo')
      || document.getElementById('world_popup')
      || document.body;
    _observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] observer install failed`, e);
  }
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return false;
  _ctx = ctx;
  _settings = ensureSettings(ctx);
  refreshRuntime();
  installObserver();
  return true;
}

function renderCocktailSettings(container, ctx) {
  const s = ensureSettings(ctx);
  if (!s) return;
  _ctx = ctx;
  _settings = s;
  applyBodyClasses();

  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_wido_enabled" type="checkbox">
        启用 WorldInfo 拖拽排序优化（自定义排序）
      </label>

      <label class="cocktail-field" title="推荐：指示线拖拽（拖动中不重排条目，松手一次性移动并保存），对重 UI 条目更流畅。">
        <span class="cocktail-label">拖拽引擎</span>
        <select id="st_wido_engine" class="text_pole">
          <option value="indicator">指示线拖拽（推荐，更流畅）</option>
          <option value="sortable">原生 sortable（跟随移动）</option>
        </select>
      </label>

      <label class="cocktail-field" title="仅对“原生 sortable（跟随移动）”引擎生效：lite=轻量拖拽块；clone=克隆原条目（更接近原始外观，但更重）。">
        <span class="cocktail-label">拖拽 helper</span>
        <select id="st_wido_helper" class="text_pole">
          <option value="lite">lite（推荐）</option>
          <option value="clone">clone</option>
        </select>
      </label>

      <label class="cocktail-check" title="仅对“原生 sortable”生效：把拖拽 helper 挂到 body，避免被列表 overflow 裁剪。">
        <input id="st_wido_appendToBody" type="checkbox">
        helper 追加到 body（避免裁剪）
      </label>

      <label class="cocktail-check" title="拖拽接近列表上下边缘时自动滚动，便于把条目拖到很远的位置。">
        <input id="st_wido_autoScroll" type="checkbox">
        边缘自动滚动
      </label>

      <label class="cocktail-field" title="指针距离列表上下边缘小于该值时开始自动滚动。">
        <span class="cocktail-label">滚动触发距离(px)</span>
        <input id="st_wido_scrollEdge" type="number" min="0" max="300" step="1">
      </label>

      <label class="cocktail-field" title="拖拽靠近边缘时的最小滚动速度（每帧像素）。">
        <span class="cocktail-label">最小速度(px/f)</span>
        <input id="st_wido_scrollMin" type="number" min="0" max="80" step="0.5">
      </label>

      <label class="cocktail-field" title="拖拽贴近/越过边缘时的最大滚动速度（每帧像素）。">
        <span class="cocktail-label">最大速度(px/f)</span>
        <input id="st_wido_scrollMax" type="number" min="0" max="120" step="0.5">
      </label>

      <label class="cocktail-check">
        <input id="st_wido_debug" type="checkbox">
        Debug log
      </label>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 酒馆核心使用 jQuery UI sortable 进行 WorldInfo 自定义排序。</div>
      <div>- 默认使用“指示线拖拽”：拖动时不让列表项跟随移动，只显示轻量拖拽影子+插入指示线；松手后一次性移动并保存顺序。</div>
    </div>
  `;
  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_enabled'));
  const $engine = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_wido_engine'));
  const $helper = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_wido_helper'));
  const $appendToBody = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_appendToBody'));
  const $autoScroll = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_autoScroll'));
  const $scrollEdge = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_scrollEdge'));
  const $scrollMin = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_scrollMin'));
  const $scrollMax = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_scrollMax'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wido_debug'));

  const refreshUI = () => {
    const ss = ensureSettings(ctx);
    if (!ss) return;
    _settings = ss;
    if ($enabled) $enabled.checked = Boolean(ss.enabled);
    if ($engine) $engine.value = (ss.engine === 'sortable') ? 'sortable' : 'indicator';
    if ($helper) $helper.value = ss.helperMode === 'clone' ? 'clone' : 'lite';
    if ($appendToBody) $appendToBody.checked = Boolean(ss.appendToBody);
    if ($autoScroll) $autoScroll.checked = Boolean(ss.autoScrollEnabled);
    if ($scrollEdge) $scrollEdge.value = String(ss.autoScrollEdgePx ?? DEFAULT_SETTINGS.autoScrollEdgePx);
    if ($scrollMin) $scrollMin.value = String(ss.autoScrollMinSpeedPx ?? DEFAULT_SETTINGS.autoScrollMinSpeedPx);
    if ($scrollMax) $scrollMax.value = String(ss.autoScrollMaxSpeedPx ?? DEFAULT_SETTINGS.autoScrollMaxSpeedPx);
    if ($debug) $debug.checked = Boolean(ss.debugLog);
  };

  const onChange = () => {
    const ss = ensureSettings(ctx);
    if (!ss) return;
    if ($enabled) ss.enabled = Boolean($enabled.checked);
    if ($engine) ss.engine = ($engine.value === 'sortable') ? 'sortable' : 'indicator';
    if ($helper) ss.helperMode = ($helper.value === 'clone') ? 'clone' : 'lite';
    if ($appendToBody) ss.appendToBody = Boolean($appendToBody.checked);
    if ($autoScroll) ss.autoScrollEnabled = Boolean($autoScroll.checked);
    if ($scrollEdge) ss.autoScrollEdgePx = Number($scrollEdge.value);
    if ($scrollMin) ss.autoScrollMinSpeedPx = Number($scrollMin.value);
    if ($scrollMax) ss.autoScrollMaxSpeedPx = Number($scrollMax.value);
    if ($debug) ss.debugLog = Boolean($debug.checked);
    _settings = ss;
    refreshRuntime();
    saveSettings(ctx);
    refreshUI();
  };

  [$enabled, $engine, $helper, $appendToBody, $autoScroll, $scrollEdge, $scrollMin, $scrollMax, $debug].forEach((el) => el?.addEventListener('change', onChange));
  refreshUI();

  return () => {
    [$enabled, $engine, $helper, $appendToBody, $autoScroll, $scrollEdge, $scrollMin, $scrollMax, $debug].forEach((el) => el?.removeEventListener('change', onChange));
  };
}

registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: 'WorldInfo 拖拽排序优化',
  order: 56,
  render: renderCocktailSettings,
});

// Run on DOM ready, and also on APP_READY/SETTINGS_LOADED
if (!_ALREADY_LOADED) {
  globalThis.jQuery?.(async () => {
    const ok = await init();
    if (!ok) return;
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
    ctx?.eventSource?.on?.(ctx.eventTypes?.SETTINGS_LOADED, init);
  });
}

