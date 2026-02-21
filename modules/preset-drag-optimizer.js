/**
 * st-preset-drag-optimizer
 *
 * 目标：
 * - 不改酒馆源代码，仅通过前端扩展 JS 优化“预设/配置相关面板”的交互体验
 *
 * 当前包含的优化项：
 * - PromptManager：render(true) 先 dry-run token 计数、再渲染 UI → 改为先渲染 UI，计数后台执行
 * - PromptManager：拖拽排序时改为轻量 helper/placeholder 显示，减少拖拽过程重排抖动
 *
 * 背景：
 * - PromptManager.render(true) 会先执行 tryGenerate()（dry-run，会触发大量 `/api/tokenizers/openai/count`）
 *   再渲染 UI；网络慢时会导致“开关要等计数结束才变化”的体感卡顿。
 *
 * 做法：
 * - monkey-patch PromptManager.prototype.render：
 *   - render(true) 时：先立即走一次原始 render(false) 更新 UI；
 *     再把 tryGenerate() 放到后台（防抖 + 单飞），完成后再 render(false) 刷新 token 显示。
 * - monkey-patch PromptManager.prototype.makeDraggable：
 *   - 对齐 WorldInfo 拖拽优化：支持“指示线拖拽 / 原生 sortable”。
 *   - render(false) 时：保持原行为
 */
import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-preset-drag-optimizer';
const LEGACY_EXTENSION_NAME = 'st-preset-panel-optimizer';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // 连续切换多个开关时，合并为一次后台 dry-run
  debounceMs: 250,
  // PromptManager 拖拽优化（参考 WorldInfo 拖拽排序优化）
  promptDragEnabled: true,
  engine: 'indicator', // 'indicator' | 'sortable'
  helperMode: 'lite', // 'lite' | 'clone' (only for sortable engine)
  appendToBody: true,
  zIndex: 2147483647,
  autoScrollEnabled: true,
  autoScrollEdgePx: 72,
  autoScrollMinSpeedPx: 4,
  autoScrollMaxSpeedPx: 22,
  // Debug log
  debugLog: false,
});

const STATE = {
  ctx: null,
  settings: null,

  // Patch bookkeeping
  patched: false,
  originalRender: null,
  originalMakeDraggable: null,

  /** @type {WeakMap<HTMLElement, { instance: any; patchedAt: number; }>} */
  dragPatchedByListEl: new WeakMap(),

  // Per-instance scheduler state
  instanceState: new WeakMap(),

  // Lazy-loaded deps for gating (avoid dry-run during generation)
  depsPromise: null,

  /** @type {Set<HTMLElement>} */
  indicatorLists: new Set(),
  /** @type {WeakMap<HTMLElement, { onPointerDown: (e: Event) => void; onMouseDown: (e: Event) => void; onTouchStart: (e: Event) => void; }>} */
  indicatorHandlers: new WeakMap(),
  /** @type {null | { listEl: HTMLElement; viewportEl: HTMLElement; listRect: DOMRect; viewportRect: DOMRect; draggedEl: HTMLElement; offsetX: number; offsetY: number; lastX: number; lastY: number; refEl: HTMLElement|null; insertBefore: boolean; ghostEl: HTMLElement; indicatorEl: HTMLElement; rafId: number|null; active: boolean; _onMove: (e: Event) => void; _onUp: (e: Event) => void; }} */
  drag: null,
};

function logDebug(...args) {
  if (STATE.settings?.debugLog) {
    console.debug(`[${EXTENSION_NAME}]`, ...args);
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

  // 兼容旧版本：从 st-preset-panel-optimizer 迁移设置。
  if (root[EXTENSION_NAME] === undefined && root[LEGACY_EXTENSION_NAME] && typeof root[LEGACY_EXTENSION_NAME] === 'object') {
    root[EXTENSION_NAME] = { ...root[LEGACY_EXTENSION_NAME] };
  }

  root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
  const s = root[EXTENSION_NAME];

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  s.enabled = Boolean(s.enabled);
  s.debounceMs = clampInt(s.debounceMs, 0, 5000, DEFAULT_SETTINGS.debounceMs);
  // 兼容旧字段 optimizePromptDragDisplay
  if (s.promptDragEnabled === undefined && s.optimizePromptDragDisplay !== undefined) {
    s.promptDragEnabled = Boolean(s.optimizePromptDragDisplay);
  }
  s.promptDragEnabled = Boolean(s.promptDragEnabled);
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
  const enabled = Boolean(STATE.settings?.enabled);
  const dragEnabled = enabled && Boolean(STATE.settings?.promptDragEnabled);
  body.classList.toggle('st-pdo-enabled', enabled);
  body.classList.toggle('st-pdo-drag-enabled', dragEnabled);
  body.classList.toggle('st-pdo-engine-indicator', dragEnabled && STATE.settings?.engine === 'indicator');
  body.classList.toggle('st-pdo-engine-sortable', dragEnabled && STATE.settings?.engine === 'sortable');
}

function getJq() {
  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') return null;
  if (!$?.fn) return null;
  return $;
}

function pickPromptEntryTitle(itemEl) {
  if (!(itemEl instanceof HTMLElement)) return 'Prompt';

  const nameWrap = itemEl.querySelector('.completion_prompt_manager_prompt_name');
  const byAttr = String(nameWrap?.getAttribute?.('data-pm-name') || '').trim();
  if (byAttr) return byAttr;

  const inspectText = String(itemEl.querySelector('.prompt-manager-inspect-action')?.textContent || '').trim();
  if (inspectText) return inspectText;

  const identifier = String(itemEl.getAttribute('data-pm-identifier') || '').trim();
  if (identifier) return identifier;

  return 'Prompt';
}

function makePromptDragLiteHelper($, itemEl) {
  const li = (itemEl?.closest?.('.completion_prompt_manager_prompt')) || itemEl;
  const title = pickPromptEntryTitle(li instanceof HTMLElement ? li : null);

  const helper = document.createElement('div');
  helper.className = 'st-pdo-helper';
  helper.textContent = title;

  try {
    const w = Math.round($(itemEl).outerWidth?.() || itemEl.getBoundingClientRect().width || 0);
    if (w > 0) helper.style.width = `${w}px`;
  } catch { }

  return $(helper);
}

function patchPromptSortableOptionsForList(listEl) {
  if (!(listEl instanceof HTMLElement)) return false;
  if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return false;
  if (STATE.settings?.engine !== 'sortable') return false;

  const $ = getJq();
  if (!$) return false;

  const $list = $(listEl);
  let instance;
  try {
    instance = $list.sortable('instance');
  } catch {
    return false;
  }
  if (!instance) return false;

  const prev = STATE.dragPatchedByListEl.get(listEl);
  if (prev?.instance === instance) return true;

  try {
    const helperOpt = (STATE.settings?.helperMode === 'clone')
      ? 'clone'
      : (e, ui) => makePromptDragLiteHelper($, ui?.[0] || ui);

    $list.sortable('option', {
      helper: helperOpt,
      appendTo: STATE.settings?.appendToBody ? document.body : 'parent',
      zIndex: STATE.settings?.zIndex ?? DEFAULT_SETTINGS.zIndex,
      tolerance: 'pointer',
      forcePlaceholderSize: true,
      placeholder: 'st-pdo-placeholder',
      cursor: 'grabbing',
      scroll: true,
      scrollSensitivity: 60,
      scrollSpeed: 18,
    });
  } catch (e) {
    logDebug('patch prompt sortable options failed', e);
    return false;
  }

  STATE.dragPatchedByListEl.set(listEl, { instance, patchedAt: Date.now() });
  return true;
}

function patchPromptSortableOptionsByManager(pm) {
  if (!pm?.configuration) return false;
  const listId = `${String(pm.configuration.prefix || '')}prompt_manager_list`;
  const listEl = document.getElementById(listId);
  return applyPromptDragEngineForList(listEl);
}

function patchExistingPromptSortableLists() {
  if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return;
  const listEls = Array.from(document.querySelectorAll('ul[id$="prompt_manager_list"]'));
  for (const el of listEls) {
    if (el instanceof HTMLElement) applyPromptDragEngineForList(el);
  }
}

function applyPromptDragEngineForList(listEl) {
  if (!(listEl instanceof HTMLElement)) return false;
  if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return false;
  if (STATE.settings?.engine === 'indicator') {
    return installIndicatorEngineForList(listEl);
  }
  return patchPromptSortableOptionsForList(listEl);
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
  ghost.className = 'st-pdo-helper st-pdo-drag-ghost';
  ghost.textContent = pickPromptEntryTitle(draggedEl);
  if (Number.isFinite(widthPx) && widthPx > 0) ghost.style.width = `${Math.round(widthPx)}px`;
  return ghost;
}

function createIndicator(widthPx, leftPx, topPx, zIndex) {
  const el = document.createElement('div');
  el.className = 'st-pdo-drop-indicator';
  el.style.left = `${Math.round(leftPx)}px`;
  el.style.top = `${Math.round(topPx)}px`;
  el.style.width = `${Math.round(widthPx)}px`;
  el.style.zIndex = String(zIndex);
  return el;
}

function getPromptItemAtPoint(listEl, draggedEl, x, y) {
  let el;
  try { el = document.elementFromPoint(x, y); } catch { el = null; }
  if (!(el instanceof Element)) return null;
  const li = el.closest('li[data-pm-identifier]');
  if (!(li instanceof HTMLElement)) return null;
  if (li === draggedEl) return null;
  if (li.closest(`#${CSS.escape(listEl.id)}`) !== listEl) return null;
  return li;
}

function getFirstLastPromptItem(listEl, draggedEl) {
  const all = Array
    .from(listEl.querySelectorAll('li[data-pm-identifier]'))
    .filter((n) => n instanceof HTMLElement && n !== draggedEl);
  return {
    first: all[0] || null,
    last: all.length ? all[all.length - 1] : null,
  };
}

function getPointerXY(e) {
  if (e && typeof e === 'object') {
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

function updatePromptDropTarget(d) {
  try { d.listRect = d.listEl.getBoundingClientRect(); } catch { }
  try { d.viewportRect = d.viewportEl.getBoundingClientRect(); } catch { }

  const x = d.lastX;
  const y = d.lastY;
  const listRect = d.listRect;
  const viewportRect = d.viewportRect;

  try {
    d.indicatorEl.style.left = `${Math.round(listRect.left)}px`;
    d.indicatorEl.style.width = `${Math.round(listRect.width)}px`;
  } catch { }

  const hitItem = getPromptItemAtPoint(d.listEl, d.draggedEl, x, y);
  if (hitItem) {
    const r = hitItem.getBoundingClientRect();
    const before = y < (r.top + r.height / 2);
    d.refEl = hitItem;
    d.insertBefore = before;
    d.indicatorEl.style.top = `${Math.round(before ? r.top : r.bottom)}px`;
    return;
  }

  const { first, last } = getFirstLastPromptItem(d.listEl, d.draggedEl);
  if (!first || !last) {
    d.refEl = null;
    d.insertBefore = true;
    d.indicatorEl.style.top = `${Math.round(viewportRect.top)}px`;
    return;
  }

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
    d.insertBefore = false;
    d.indicatorEl.style.top = `${Math.round(r.bottom)}px`;
    return;
  }

  if (d.refEl && d.refEl !== d.draggedEl && d.refEl.isConnected) {
    const r = d.refEl.getBoundingClientRect();
    d.indicatorEl.style.top = `${Math.round(d.insertBefore ? r.top : r.bottom)}px`;
    return;
  }

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

function tickPromptDrag() {
  const d = STATE.drag;
  if (!d || !d.active) return;
  d.rafId = requestAnimationFrame(tickPromptDrag);

  try { d.listRect = d.listEl.getBoundingClientRect(); } catch { }
  try { d.viewportRect = d.viewportEl.getBoundingClientRect(); } catch { }

  if (STATE.settings?.autoScrollEnabled) {
    const edgePx = Math.max(0, Number(STATE.settings?.autoScrollEdgePx ?? DEFAULT_SETTINGS.autoScrollEdgePx) || 0);
    const minSpeed = Math.max(0, Number(STATE.settings?.autoScrollMinSpeedPx ?? DEFAULT_SETTINGS.autoScrollMinSpeedPx) || 0);
    const maxSpeed = Math.max(minSpeed, Number(STATE.settings?.autoScrollMaxSpeedPx ?? DEFAULT_SETTINGS.autoScrollMaxSpeedPx) || 0);

    if (edgePx > 0 && maxSpeed > 0) {
      const y = d.lastY;
      const distTop = y - d.viewportRect.top;
      const distBottom = d.viewportRect.bottom - y;
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
        d.viewportEl.scrollTop = Math.max(0, Math.min(maxScroll, d.viewportEl.scrollTop + delta));
      }
    }
  }

  const gx = d.lastX - d.offsetX;
  const gy = d.lastY - d.offsetY;
  d.ghostEl.style.transform = `translate3d(${Math.round(gx)}px, ${Math.round(gy)}px, 0)`;

  updatePromptDropTarget(d);
}

function endPromptDrag({ commit }) {
  const d = STATE.drag;
  if (!d) return;
  STATE.drag = null;

  d.active = false;
  if (d.rafId !== null) {
    try { cancelAnimationFrame(d.rafId); } catch { }
  }

  try { d.ghostEl.remove(); } catch { }
  try { d.indicatorEl.remove(); } catch { }

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
      const updateFn = $list.sortable('option', 'update');
      if (typeof updateFn === 'function') {
        Promise.resolve(updateFn.call(d.listEl, null, { item: $(d.draggedEl) })).catch((e) => {
          console.warn(`[${EXTENSION_NAME}] core update handler failed`, e);
        });
      }
    }
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] invoke core update failed`, e);
  }
}

function startIndicatorDrag(startEvent, listEl, draggedEl) {
  if (STATE.drag) return;

  const $ = getJq();
  if (!$) return;

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
  ghost.style.zIndex = String(STATE.settings?.zIndex ?? DEFAULT_SETTINGS.zIndex);
  ghost.style.transform = `translate3d(${Math.round(dragRect.left)}px, ${Math.round(dragRect.top)}px, 0)`;
  document.body.appendChild(ghost);

  const indicator = createIndicator(listRect.width, listRect.left, viewportRect.top, STATE.settings?.zIndex ?? DEFAULT_SETTINGS.zIndex);
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
    const cur = STATE.drag;
    if (!cur || !cur.active) return;
    if (ev && typeof ev === 'object' && String(ev.type || '').startsWith('touch')) {
      try { ev.preventDefault?.(); } catch { }
      try { ev.stopPropagation?.(); } catch { }
    }
    const p = getPointerXY(ev);
    cur.lastX = p.x;
    cur.lastY = p.y;
  };

  const onUp = (ev) => {
    stopEvent(ev);
    try {
      if (STATE.drag && STATE.drag.active) updatePromptDropTarget(STATE.drag);
    } catch { }
    endPromptDrag({ commit: true });
  };

  d._onMove = onMove;
  d._onUp = onUp;

  STATE.drag = d;

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('touchmove', onMove, { capture: true, passive: false });
  window.addEventListener('touchend', onUp, { capture: true, passive: false });
  window.addEventListener('touchcancel', onUp, { capture: true, passive: false });

  updatePromptDropTarget(d);
  d.rafId = requestAnimationFrame(tickPromptDrag);
}

function installIndicatorEngineForList(listEl) {
  if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return false;
  if (STATE.settings?.engine !== 'indicator') return false;
  if (!(listEl instanceof HTMLElement)) return false;

  if (STATE.indicatorLists.has(listEl)) return true;

  const onPointerDown = (e) => {
    if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return;
    if (STATE.settings?.engine !== 'indicator') return;
    if (STATE.drag) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    // 对齐你的操作习惯：支持从左侧 drag-handle，或条目名前的图标（如 fa-thumb-tack / fa-asterisk）开始拖拽。
    const dragStartEl = target.closest('.drag-handle, .completion_prompt_manager_prompt_name .fa-thumb-tack, .completion_prompt_manager_prompt_name .fa-asterisk');
    if (!(dragStartEl instanceof Element)) return;

    const draggedEl = dragStartEl.closest('li.completion_prompt_manager_prompt_draggable[data-pm-identifier]');
    if (!(draggedEl instanceof HTMLElement)) return;
    if (draggedEl.closest(`#${CSS.escape(listEl.id)}`) !== listEl) return;

    // 忽略控件区点击，避免误拦截开关/编辑按钮。
    const controls = target.closest('.prompt_manager_prompt_controls');
    if (controls && !target.closest('.drag-handle')) return;

    if (e.type === 'mousedown' && typeof e.button === 'number' && e.button !== 0) return;

    stopEvent(e);
    startIndicatorDrag(e, listEl, draggedEl);
  };

  const onMouseDown = onPointerDown;
  const onTouchStart = onPointerDown;

  listEl.addEventListener('pointerdown', onPointerDown, true);
  listEl.addEventListener('mousedown', onMouseDown, true);
  listEl.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });

  STATE.indicatorLists.add(listEl);
  STATE.indicatorHandlers.set(listEl, { onPointerDown, onMouseDown, onTouchStart });
  return true;
}

function uninstallIndicatorEngineIfNeeded() {
  for (const el of Array.from(STATE.indicatorLists)) {
    const shouldKeep = Boolean(
      STATE.settings?.enabled
      && STATE.settings?.promptDragEnabled
      && STATE.settings?.engine === 'indicator'
      && el.isConnected,
    );
    if (shouldKeep) continue;
    const h = STATE.indicatorHandlers.get(el);
    try { el.removeEventListener('pointerdown', h?.onPointerDown, true); } catch { }
    try { el.removeEventListener('mousedown', h?.onMouseDown, true); } catch { }
    try { el.removeEventListener('touchstart', h?.onTouchStart, true); } catch { }
    STATE.indicatorLists.delete(el);
    STATE.indicatorHandlers.delete(el);
  }

  if (!(STATE.settings?.enabled && STATE.settings?.promptDragEnabled && STATE.settings?.engine === 'indicator')) {
    endPromptDrag({ commit: false });
  }
}

function refreshPromptDragRuntime() {
  uninstallIndicatorEngineIfNeeded();
  if (!STATE.settings?.enabled || !STATE.settings?.promptDragEnabled) return;
  patchExistingPromptSortableLists();
}

function getInstanceState(pm) {
  let s = STATE.instanceState.get(pm);
  if (!s) {
    s = {
      timerId: /** @type {number|null} */ (null),
      inFlight: false,
      pending: false,
      lastRunAt: 0,
    };
    STATE.instanceState.set(pm, s);
  }
  return s;
}

async function getDeps() {
  if (STATE.depsPromise) return STATE.depsPromise;
  STATE.depsPromise = Promise.all([
    import('/script.js'),
    import('/scripts/group-chats.js'),
    import('/scripts/utils.js'),
  ]).then(([scriptMod, groupMod, utilsMod]) => ({
    scriptMod,
    groupMod,
    utilsMod,
  })).catch((e) => {
    console.warn(`[${EXTENSION_NAME}] deps import failed`, e);
    return null;
  });
  return STATE.depsPromise;
}

async function waitUntilNotGenerating() {
  const deps = await getDeps();
  if (!deps) return;

  const { scriptMod, groupMod, utilsMod } = deps;
  const waitUntilCondition = utilsMod?.waitUntilCondition;
  if (typeof waitUntilCondition !== 'function') return;

  try {
    await waitUntilCondition(
      () => !scriptMod.is_send_press && !groupMod.is_group_generating,
      60_000,
      120,
      { rejectOnTimeout: false },
    );
  } catch {
    // ignore
  }
}

function scheduleBackgroundDryRun(pm) {
  const s = getInstanceState(pm);
  if (s.timerId !== null) {
    clearTimeout(s.timerId);
    s.timerId = null;
  }

  const debounceMs = STATE.settings?.debounceMs ?? DEFAULT_SETTINGS.debounceMs;
  s.timerId = setTimeout(() => {
    s.timerId = null;
    void runBackgroundDryRun(pm);
  }, Math.max(0, debounceMs));
}

async function runBackgroundDryRun(pm) {
  if (!STATE.settings?.enabled) return;
  if (!STATE.originalRender) return;

  const s = getInstanceState(pm);
  if (s.inFlight) {
    s.pending = true;
    return;
  }

  s.inFlight = true;
  s.pending = false;
  s.lastRunAt = Date.now();

  logDebug('dry-run start');

  try {
    // Avoid competing with live generation.
    await waitUntilNotGenerating();

    if (typeof pm?.tryGenerate === 'function') {
      await Promise.resolve(pm.tryGenerate());
    }
  } catch (e) {
    logDebug('dry-run error', e);
  } finally {
    s.inFlight = false;

    try {
      // Refresh token counts / warnings; do NOT re-run dry-run here.
      STATE.originalRender.call(pm, false);
    } catch (e) {
      logDebug('post dry-run render failed', e);
    }

    if (s.pending) {
      s.pending = false;
      scheduleBackgroundDryRun(pm);
    }
  }
}

async function installPatch() {
  if (STATE.patched) return true;

  let mod;
  try {
    mod = await import('/scripts/PromptManager.js');
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] failed to import PromptManager.js`, e);
    return false;
  }

  const PromptManager = mod?.PromptManager;
  const proto = PromptManager?.prototype;
  if (!proto || typeof proto.render !== 'function') {
    console.warn(`[${EXTENSION_NAME}] PromptManager.prototype.render not found`);
    return false;
  }

  if (typeof proto.makeDraggable !== 'function') {
    console.warn(`[${EXTENSION_NAME}] PromptManager.prototype.makeDraggable not found`);
    return false;
  }

  const renderAlreadyPatched = Boolean(proto.render.__stPresetPanelOptimizerPatched);
  const dragAlreadyPatched = Boolean(proto.makeDraggable.__stPresetPanelOptimizerDragPatched);

  const originalRender = renderAlreadyPatched
    ? (proto.render.__stPresetPanelOptimizerOriginalRender || proto.render)
    : proto.render;
  STATE.originalRender = originalRender;

  const originalMakeDraggable = dragAlreadyPatched
    ? (proto.makeDraggable.__stPresetPanelOptimizerOriginalMakeDraggable || proto.makeDraggable)
    : proto.makeDraggable;
  STATE.originalMakeDraggable = originalMakeDraggable;

  if (!renderAlreadyPatched) {
    function patchedRender(afterTryGenerate = true) {
      // Keep exact behavior when disabled.
      const ctx = getCtx();
      const settings = ensureExtensionSettings(ctx);
      STATE.ctx = ctx;
      STATE.settings = settings;
      applyBodyClasses();

      if (!settings?.enabled) {
        return originalRender.call(this, afterTryGenerate);
      }

      // Only change the blocking path.
      if (!afterTryGenerate) {
        return originalRender.call(this, false);
      }

      // 1) Render UI immediately (no dry-run)
      try {
        originalRender.call(this, false);
      } catch {
        // Fallback to original behavior if anything goes wrong
        return originalRender.call(this, true);
      }

      // 2) Background dry-run + refresh counts
      scheduleBackgroundDryRun(this);
    }

    // Tag for idempotency/debug
    patchedRender.__stPresetPanelOptimizerPatched = true;
    patchedRender.__stPresetPanelOptimizerOriginalRender = originalRender;

    proto.render = patchedRender;
    logDebug('PromptManager.render patched');
  }

  if (!dragAlreadyPatched) {
    function patchedMakeDraggable(...args) {
      const ctx = getCtx();
      const settings = ensureExtensionSettings(ctx);
      STATE.ctx = ctx;
      STATE.settings = settings;
      applyBodyClasses();

      const out = originalMakeDraggable.apply(this, args);

      refreshPromptDragRuntime();

      return out;
    }

    patchedMakeDraggable.__stPresetPanelOptimizerDragPatched = true;
    patchedMakeDraggable.__stPresetPanelOptimizerOriginalMakeDraggable = originalMakeDraggable;

    proto.makeDraggable = patchedMakeDraggable;
    logDebug('PromptManager.makeDraggable patched');
  }

  STATE.patched = true;
  return true;
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return;

  STATE.ctx = ctx;
  STATE.settings = ensureExtensionSettings(ctx);
  applyBodyClasses();

  // Always install patch once; runtime switch controls behavior.
  await installPatch();
  refreshPromptDragRuntime();
}

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_pdo_enabled" type="checkbox">
        启用预设拖拽与面板优化（先切换 UI，后台补齐统计）
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">后台合并延迟(ms)</span>
        <input id="st_pdo_debounce" type="number" min="0" max="5000" step="10">
      </label>

      <label class="cocktail-check" title="对 PromptManager 预设条目列表启用拖拽排序优化。">
        <input id="st_pdo_drag_enabled" type="checkbox">
        启用预设条目拖拽排序优化
      </label>

      <label class="cocktail-field" title="推荐：指示线拖拽（拖动中不重排条目，松手一次性移动并保存），更流畅。">
        <span class="cocktail-label">拖拽引擎</span>
        <select id="st_pdo_engine" class="text_pole">
          <option value="indicator">指示线拖拽（推荐，更流畅）</option>
          <option value="sortable">原生 sortable（跟随移动）</option>
        </select>
      </label>

      <label class="cocktail-field" title="仅对“原生 sortable”引擎生效：lite=轻量拖拽块；clone=克隆原条目。">
        <span class="cocktail-label">拖拽 helper</span>
        <select id="st_pdo_helper" class="text_pole">
          <option value="lite">lite（推荐）</option>
          <option value="clone">clone</option>
        </select>
      </label>

      <label class="cocktail-check" title="仅对“原生 sortable”生效：把 helper 挂到 body，避免被容器裁剪。">
        <input id="st_pdo_appendToBody" type="checkbox">
        helper 追加到 body（避免裁剪）
      </label>

      <label class="cocktail-check" title="拖拽接近列表上下边缘时自动滚动，便于拖到远位置。">
        <input id="st_pdo_autoScroll" type="checkbox">
        边缘自动滚动
      </label>

      <label class="cocktail-field" title="指针距离列表上下边缘小于该值时开始自动滚动。">
        <span class="cocktail-label">滚动触发距离(px)</span>
        <input id="st_pdo_scrollEdge" type="number" min="0" max="300" step="1">
      </label>

      <label class="cocktail-field" title="拖拽靠近边缘时的最小滚动速度（每帧像素）。">
        <span class="cocktail-label">最小速度(px/f)</span>
        <input id="st_pdo_scrollMin" type="number" min="0" max="80" step="0.5">
      </label>

      <label class="cocktail-field" title="拖拽贴近边缘时的最大滚动速度（每帧像素）。">
        <span class="cocktail-label">最大速度(px/f)</span>
        <input id="st_pdo_scrollMax" type="number" min="0" max="120" step="0.5">
      </label>

      <label class="cocktail-check">
        <input id="st_pdo_debug" type="checkbox">
        Debug log
      </label>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 本模块用于优化“预设/配置相关面板”的交互体验。</div>
      <div>- PromptManager 列表开关不再等待 token 计数完成（token 统计后台更新）。</div>
      <div>- 预设条目拖拽优化与 WorldInfo 拖拽优化对齐：支持“指示线拖拽 / 原生 sortable”两种引擎。</div>
    </div>
  `;

  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_enabled'));
  const $debounce = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_debounce'));
  const $dragEnabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_drag_enabled'));
  const $engine = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_pdo_engine'));
  const $helper = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_pdo_helper'));
  const $appendToBody = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_appendToBody'));
  const $autoScroll = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_autoScroll'));
  const $scrollEdge = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_scrollEdge'));
  const $scrollMin = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_scrollMin'));
  const $scrollMax = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_scrollMax'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pdo_debug'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    STATE.settings = s;
    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($debounce) $debounce.value = String(s.debounceMs);
    if ($dragEnabled) $dragEnabled.checked = Boolean(s.promptDragEnabled);
    if ($engine) $engine.value = (s.engine === 'sortable') ? 'sortable' : 'indicator';
    if ($helper) $helper.value = s.helperMode === 'clone' ? 'clone' : 'lite';
    if ($appendToBody) $appendToBody.checked = Boolean(s.appendToBody);
    if ($autoScroll) $autoScroll.checked = Boolean(s.autoScrollEnabled);
    if ($scrollEdge) $scrollEdge.value = String(s.autoScrollEdgePx ?? DEFAULT_SETTINGS.autoScrollEdgePx);
    if ($scrollMin) $scrollMin.value = String(s.autoScrollMinSpeedPx ?? DEFAULT_SETTINGS.autoScrollMinSpeedPx);
    if ($scrollMax) $scrollMax.value = String(s.autoScrollMaxSpeedPx ?? DEFAULT_SETTINGS.autoScrollMaxSpeedPx);
    if ($debug) $debug.checked = Boolean(s.debugLog);

    if ($helper) $helper.disabled = (s.engine !== 'sortable');
    if ($appendToBody) $appendToBody.disabled = (s.engine !== 'sortable');
    applyBodyClasses();
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($debounce) s.debounceMs = clampInt($debounce.value, 0, 5000, DEFAULT_SETTINGS.debounceMs);
    if ($dragEnabled) s.promptDragEnabled = Boolean($dragEnabled.checked);
    if ($engine) s.engine = ($engine.value === 'sortable') ? 'sortable' : 'indicator';
    if ($helper) s.helperMode = ($helper.value === 'clone') ? 'clone' : 'lite';
    if ($appendToBody) s.appendToBody = Boolean($appendToBody.checked);
    if ($autoScroll) s.autoScrollEnabled = Boolean($autoScroll.checked);
    if ($scrollEdge) s.autoScrollEdgePx = Number($scrollEdge.value);
    if ($scrollMin) s.autoScrollMinSpeedPx = Number($scrollMin.value);
    if ($scrollMax) s.autoScrollMaxSpeedPx = Number($scrollMax.value);
    if ($debug) s.debugLog = Boolean($debug.checked);
    STATE.settings = s;
    applyBodyClasses();
    refreshPromptDragRuntime();
    saveSettings(ctx);
    refreshUI();
  };

  $enabled?.addEventListener('change', onChange);
  $debounce?.addEventListener('change', onChange);
  $dragEnabled?.addEventListener('change', onChange);
  $engine?.addEventListener('change', onChange);
  $helper?.addEventListener('change', onChange);
  $appendToBody?.addEventListener('change', onChange);
  $autoScroll?.addEventListener('change', onChange);
  $scrollEdge?.addEventListener('change', onChange);
  $scrollMin?.addEventListener('change', onChange);
  $scrollMax?.addEventListener('change', onChange);
  $debug?.addEventListener('change', onChange);

  refreshUI();

  return () => {
    $enabled?.removeEventListener('change', onChange);
    $debounce?.removeEventListener('change', onChange);
    $dragEnabled?.removeEventListener('change', onChange);
    $engine?.removeEventListener('change', onChange);
    $helper?.removeEventListener('change', onChange);
    $appendToBody?.removeEventListener('change', onChange);
    $autoScroll?.removeEventListener('change', onChange);
    $scrollEdge?.removeEventListener('change', onChange);
    $scrollMin?.removeEventListener('change', onChange);
    $scrollMax?.removeEventListener('change', onChange);
    $debug?.removeEventListener('change', onChange);
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '预设拖拽与面板优化',
  order: 40,
  render: renderCocktailSettings,
});

// Run on DOM ready, and also on APP_READY (some environments delay init)
globalThis.jQuery?.(async () => {
  await init();
  const ctx = getCtx();
  ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
});

