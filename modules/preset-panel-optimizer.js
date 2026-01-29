/**
 * st-preset-panel-optimizer
 *
 * 目标：
 * - 不改酒馆源代码，仅通过前端扩展 JS 优化“预设/配置相关面板”的交互体验
 *
 * 当前包含的优化项：
 * - PromptManager：render(true) 先 dry-run token 计数、再渲染 UI → 改为先渲染 UI，计数后台执行
 *
 * 背景：
 * - PromptManager.render(true) 会先执行 tryGenerate()（dry-run，会触发大量 `/api/tokenizers/openai/count`）
 *   再渲染 UI；网络慢时会导致“开关要等计数结束才变化”的体感卡顿。
 *
 * 做法：
 * - monkey-patch PromptManager.prototype.render：
 *   - render(true) 时：先立即走一次原始 render(false) 更新 UI；
 *     再把 tryGenerate() 放到后台（防抖 + 单飞），完成后再 render(false) 刷新 token 显示。
 *   - render(false) 时：保持原行为
 */
import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-preset-panel-optimizer';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // 连续切换多个开关时，合并为一次后台 dry-run
  debounceMs: 250,
  // Debug log
  debugLog: false,
});

const STATE = {
  ctx: null,
  settings: null,

  // Patch bookkeeping
  patched: false,
  originalRender: null,

  // Per-instance scheduler state
  instanceState: new WeakMap(),

  // Lazy-loaded deps for gating (avoid dry-run during generation)
  depsPromise: null,
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

  root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
  const s = root[EXTENSION_NAME];

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  s.enabled = Boolean(s.enabled);
  s.debounceMs = clampInt(s.debounceMs, 0, 5000, DEFAULT_SETTINGS.debounceMs);
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

  // Avoid double patch (module may be evaluated twice in some reload flows)
  if (proto.render.__stPresetPanelOptimizerPatched) {
    STATE.patched = true;
    STATE.originalRender = proto.render.__stPresetPanelOptimizerOriginalRender || proto.render;
    return true;
  }

  const originalRender = proto.render;
  STATE.originalRender = originalRender;

  function patchedRender(afterTryGenerate = true) {
    // Keep exact behavior when disabled.
    const ctx = getCtx();
    const settings = ensureExtensionSettings(ctx);
    STATE.ctx = ctx;
    STATE.settings = settings;

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

  STATE.patched = true;
  logDebug('PromptManager.render patched');
  return true;
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return;

  STATE.ctx = ctx;
  STATE.settings = ensureExtensionSettings(ctx);

  // Always install patch once; runtime switch controls behavior.
  await installPatch();
}

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_pmnt_enabled" type="checkbox">
        启用预设面板优化（先切换 UI，后台补齐统计）
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">后台合并延迟(ms)</span>
        <input id="st_pmnt_debounce" type="number" min="0" max="5000" step="10">
      </label>

      <label class="cocktail-check">
        <input id="st_pmnt_debug" type="checkbox">
        Debug log
      </label>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 本模块用于优化“预设/配置相关面板”的交互体验。</div>
      <div>- 当前包含：PromptManager 列表开关不再等待 token 计数完成（token 统计后台更新）。</div>
    </div>
  `;

  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pmnt_enabled'));
  const $debounce = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pmnt_debounce'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_pmnt_debug'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    STATE.settings = s;
    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($debounce) $debounce.value = String(s.debounceMs);
    if ($debug) $debug.checked = Boolean(s.debugLog);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($debounce) s.debounceMs = clampInt($debounce.value, 0, 5000, DEFAULT_SETTINGS.debounceMs);
    if ($debug) s.debugLog = Boolean($debug.checked);
    STATE.settings = s;
    saveSettings(ctx);
    refreshUI();
  };

  $enabled?.addEventListener('change', onChange);
  $debounce?.addEventListener('change', onChange);
  $debug?.addEventListener('change', onChange);

  refreshUI();

  return () => {
    $enabled?.removeEventListener('change', onChange);
    $debounce?.removeEventListener('change', onChange);
    $debug?.removeEventListener('change', onChange);
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '预设面板优化',
  order: 40,
  render: renderCocktailSettings,
});

// Run on DOM ready, and also on APP_READY (some environments delay init)
globalThis.jQuery?.(async () => {
  await init();
  const ctx = getCtx();
  ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
});

