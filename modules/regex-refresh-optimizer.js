/**
 * st-regex-refresh-optimizer
 *
 * 目标：
 * - 在 Regex 配置面板展开期间不刷新聊天
 * - 面板收起/隐藏时才统一刷新一次聊天（默认分帧增量重渲染）
 *
 * 说明：
 * - 酒馆内置 regex 扩展会在多处直接调用 reloadCurrentChat()，导致每次开关都全量重渲染+正则重跑。
 * - 本扩展通过“捕获阶段事件拦截 + 自己保存设置”绕开内置 handler 的 reload 行为。
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-regex-refresh-optimizer';
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // incremental: 分帧增量重渲染已显示消息；full: 一次 reloadCurrentChat
  refreshMode: 'incremental',
  rerenderBatchSize: 15,
  // 面板收起后延迟触发刷新，用于合并极短时间内的重复触发
  closeRefreshDelayMs: 80,
  debugLog: false,
});

// Avoid double-install
const _ALREADY_LOADED = Boolean(globalThis.__stRegexRefreshOptimizerLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stRegexRefreshOptimizerLoaded = true;
}

let _ctx = null;
let _settings = null;

let _enginePromise = null;
let _engine = null;
let _regexUiDepsPromise = null;

let _dirty = false;
let _lastPanelVisible = false;
let _closeTimer = /** @type {number|null} */ (null);

let _installedGlobalListeners = false;
let _installedSortablePatch = false;
let _installedVisibilityObserver = false;
const _patchedSortableSelectors = new Set();

// Serialize all save operations to avoid concurrent writes.
let _saveChain = Promise.resolve();

function logDebug(...args) {
  if (_settings?.debugLog) console.debug(`[${EXTENSION_NAME}]`, ...args);
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
  return globalThis.SillyTavern?.getContext?.();
}

function ensureExtensionSettings(ctx) {
  if (!ctx?.extensionSettings) return null;
  ctx.extensionSettings[EXTENSION_NAME] = ctx.extensionSettings[EXTENSION_NAME] || {};
  const s = ctx.extensionSettings[EXTENSION_NAME];

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  s.enabled = Boolean(s.enabled);
  s.refreshMode = (s.refreshMode === 'full') ? 'full' : 'incremental';
  s.rerenderBatchSize = clampInt(s.rerenderBatchSize, 1, 200, DEFAULT_SETTINGS.rerenderBatchSize);
  s.closeRefreshDelayMs = clampInt(s.closeRefreshDelayMs, 0, 5000, DEFAULT_SETTINGS.closeRefreshDelayMs);
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

async function importRegexEngine() {
  if (_engine) return _engine;
  if (_enginePromise) return _enginePromise;

  _enginePromise = (async () => {
    try {
      // ESM dynamic import
      const mod = await import('/scripts/extensions/regex/engine.js');
      return mod;
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] Regex engine import failed`, e);
      return null;
    }
  })();

  _engine = await _enginePromise;
  return _engine;
}

function getRegexContainer() {
  return document.getElementById('regex_container');
}

function getExtensionsDrawer() {
  // 新版 UI：扩展设置抽屉容器（openDrawer/closedDrawer）
  return document.getElementById('rm_extensions_block');
}

function isElementVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // If it has no layout boxes, it's effectively hidden
  if (el.getClientRects().length === 0) return false;
  return true;
}

function isRegexPanelVisible() {
  // 只以扩展设置抽屉开合状态为准（openDrawer/closedDrawer）
  // 用户明确：只需要根据这个面板触发刷新，其他可见性触发都不要
  const drawer = getExtensionsDrawer();
  if (!(drawer instanceof HTMLElement)) return false;
  return drawer.classList.contains('openDrawer') && !drawer.classList.contains('closedDrawer');
}

function markDirty() {
  _dirty = true;
  logDebug('dirty=true');
}

function stopEvent(e) {
  try { e.stopImmediatePropagation?.(); } catch { }
  try { e.stopPropagation?.(); } catch { }
}

function queueWork(fn) {
  _saveChain = _saveChain.then(fn).catch((e) => {
    console.error(`[${EXTENSION_NAME}] queued work failed`, e);
  });
  return _saveChain;
}

function getScriptTypeFromDom(scriptLabelEl, engine) {
  if (!(scriptLabelEl instanceof HTMLElement)) return null;
  if (scriptLabelEl.closest('#saved_regex_scripts')) return engine.SCRIPT_TYPES.GLOBAL;
  if (scriptLabelEl.closest('#saved_scoped_scripts')) return engine.SCRIPT_TYPES.SCOPED;
  if (scriptLabelEl.closest('#saved_preset_scripts')) return engine.SCRIPT_TYPES.PRESET;
  return null;
}

function findScriptAcrossTypes(engine, scriptId) {
  for (const type of Object.values(engine.SCRIPT_TYPES)) {
    const list = engine.getScriptsByType(type) || [];
    const idx = list.findIndex(s => s?.id === scriptId);
    if (idx !== -1) return { type, list, index: idx, script: list[idx] };
  }
  return null;
}

async function setScriptDisabled(scriptId, scriptTypeMaybe, disabled) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  const domScriptType = scriptTypeMaybe;
  let hit = null;

  if (domScriptType !== null && domScriptType !== undefined) {
    const list = engine.getScriptsByType(domScriptType) || [];
    const idx = list.findIndex(s => s?.id === scriptId);
    if (idx !== -1) {
      hit = { type: domScriptType, list, index: idx, script: list[idx] };
    }
  }

  if (!hit) {
    hit = findScriptAcrossTypes(engine, scriptId);
  }

  if (!hit?.script) {
    console.warn(`[${EXTENSION_NAME}] script not found: ${scriptId}`);
    return;
  }

  hit.script.disabled = Boolean(disabled);

  // Save (scope aware)
  await engine.saveScriptsByType(hit.list, hit.type);

  // Keep behavior similar to core: saving scoped/preset scripts implies allowing them
  try {
    if (hit.type === engine.SCRIPT_TYPES.SCOPED) {
      const character = ctx.characters?.[ctx.characterId];
      engine.allowScopedScripts?.(character);
    }
    if (hit.type === engine.SCRIPT_TYPES.PRESET) {
      engine.allowPresetScripts?.(engine.getCurrentPresetAPI?.(), engine.getCurrentPresetName?.());
    }
  } catch { }

  saveSettings(ctx);
  markDirty();
}

function getSelectedScriptLabelElements() {
  const container = getRegexContainer();
  if (!container) return [];
  const labels = Array.from(container.querySelectorAll('.regex-script-label'));
  return labels.filter((label) => {
    const cb = label.querySelector('.regex_bulk_checkbox');
    return cb instanceof HTMLInputElement && cb.checked;
  });
}

async function bulkSetDisabled({ enable }) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  const selectedLabels = getSelectedScriptLabelElements();
  if (selectedLabels.length === 0) {
    globalThis.toastr?.warning(enable ? '未选择需要启用的正则脚本。' : '未选择需要禁用的正则脚本。');
    return;
  }

  const desiredDisabled = !enable;
  const touchedTypes = new Set();

  // Group by type -> ids
  /** @type {Map<number, Set<string>>} */
  const idsByType = new Map();
  for (const label of selectedLabels) {
    const id = label.getAttribute('id');
    if (!id) continue;
    const type = getScriptTypeFromDom(label, engine) ?? null;
    const realType = type ?? findScriptAcrossTypes(engine, id)?.type;
    if (realType === null || realType === undefined) continue;
    if (!idsByType.has(realType)) idsByType.set(realType, new Set());
    idsByType.get(realType).add(id);
  }

  for (const [type, ids] of idsByType.entries()) {
    const list = engine.getScriptsByType(type) || [];
    let changed = 0;
    for (const script of list) {
      if (!script?.id) continue;
      if (!ids.has(script.id)) continue;
      if (Boolean(script.disabled) === desiredDisabled) continue;
      script.disabled = desiredDisabled;
      changed++;
    }

    if (changed > 0) {
      await engine.saveScriptsByType(list, type);
      touchedTypes.add(type);
    }
  }

  try {
    if (touchedTypes.has(engine.SCRIPT_TYPES.SCOPED)) {
      const character = ctx.characters?.[ctx.characterId];
      engine.allowScopedScripts?.(character);
    }
    if (touchedTypes.has(engine.SCRIPT_TYPES.PRESET)) {
      engine.allowPresetScripts?.(engine.getCurrentPresetAPI?.(), engine.getCurrentPresetName?.());
    }
  } catch { }

  // Sync UI checkboxes for touched items
  for (const label of selectedLabels) {
    const input = label.querySelector('input.disable_regex');
    if (input instanceof HTMLInputElement) {
      input.checked = desiredDisabled;
    }
  }

  saveSettings(ctx);
  markDirty();
}

async function confirmUi(message, title = '确认') {
  const ctx = _ctx || getCtx();
  try {
    const Popup = ctx?.Popup;
    if (Popup?.show?.confirm) {
      return await Popup.show.confirm(title, message);
    }
  } catch { }
  return globalThis.confirm?.(`${title}\n\n${message}`) ?? true;
}

async function getRegexUiDeps() {
  if (_regexUiDepsPromise) return _regexUiDepsPromise;

  _regexUiDepsPromise = Promise.all([
    import('/scripts/extensions.js'),
    import('/scripts/popup.js'),
    import('/scripts/utils.js'),
  ]).then(([extensionsMod, popupMod, utilsMod]) => ({
    extensionsMod,
    popupMod,
    utilsMod,
  })).catch((e) => {
    console.warn(`[${EXTENSION_NAME}] failed to load regex UI deps`, e);
    return null;
  });

  return _regexUiDepsPromise;
}

function syncScriptLabelUi(scriptLabelEl, script) {
  if (!(scriptLabelEl instanceof HTMLElement)) return;
  if (!script) return;

  // Name
  const nameEl = scriptLabelEl.querySelector('.regex_script_name');
  if (nameEl instanceof HTMLElement) {
    const name = String(script.scriptName ?? '');
    nameEl.textContent = name;
    nameEl.setAttribute('title', name);
  }

  // Disabled checkbox on list item
  const disableCb = scriptLabelEl.querySelector('input.disable_regex');
  if (disableCb instanceof HTMLInputElement) {
    disableCb.checked = Boolean(script.disabled);
  }
}

async function openRegexEditorForScript({ scriptId, scriptTypeMaybe, scriptLabelEl }) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;

  const engine = await importRegexEngine();
  if (!engine) return;

  const deps = await getRegexUiDeps();
  if (!deps) {
    globalThis.toastr?.error('无法加载 Regex 编辑器依赖，无法打开编辑器。');
    return;
  }

  const $ = globalThis.jQuery;
  if (typeof $ !== 'function') {
    console.warn(`[${EXTENSION_NAME}] jQuery not found; cannot open regex editor`);
    globalThis.toastr?.error('未找到 jQuery，无法打开编辑器。');
    return;
  }

  const { extensionsMod, popupMod, utilsMod } = deps;
  const renderExtensionTemplateAsync = extensionsMod?.renderExtensionTemplateAsync;
  const callGenericPopup = popupMod?.callGenericPopup;
  const POPUP_TYPE = popupMod?.POPUP_TYPE;

  if (typeof renderExtensionTemplateAsync !== 'function' || typeof callGenericPopup !== 'function' || !POPUP_TYPE) {
    console.warn(`[${EXTENSION_NAME}] regex UI deps missing exports`, deps);
    globalThis.toastr?.error('Regex 编辑器依赖缺失，无法打开编辑器。');
    return;
  }

  // Resolve script + type from DOM type or fallback across all types
  let hit = null;
  if (scriptTypeMaybe !== null && scriptTypeMaybe !== undefined) {
    const list = engine.getScriptsByType(scriptTypeMaybe) || [];
    const index = list.findIndex(s => s?.id === scriptId);
    if (index !== -1) {
      hit = { type: scriptTypeMaybe, list, index, script: list[index] };
    }
  }
  if (!hit) hit = findScriptAcrossTypes(engine, scriptId);

  if (!hit?.script) {
    globalThis.toastr?.error('未找到要编辑的正则脚本。');
    return;
  }

  const existingScript = hit.script;
  if (!existingScript?.scriptName) {
    globalThis.toastr?.error('该脚本没有名称，请删除后重新创建。');
    return;
  }

  const editorHtml = $(await renderExtensionTemplateAsync('regex', 'editor'));

  // Fill values
  editorHtml.find('.regex_script_name').val(existingScript.scriptName);
  editorHtml.find('.find_regex').val(existingScript.findRegex || '');
  editorHtml.find('.regex_replace_string').val(existingScript.replaceString || '');
  editorHtml.find('.regex_trim_strings').val(existingScript.trimStrings?.join('\n') || []);
  editorHtml.find('input[name="disabled"]').prop('checked', existingScript.disabled ?? false);
  editorHtml.find('input[name="only_format_display"]').prop('checked', existingScript.markdownOnly ?? false);
  editorHtml.find('input[name="only_format_prompt"]').prop('checked', existingScript.promptOnly ?? false);
  editorHtml.find('input[name="run_on_edit"]').prop('checked', existingScript.runOnEdit ?? false);
  editorHtml.find('select[name="substitute_regex"]').val(existingScript.substituteRegex ?? 0);
  editorHtml.find('input[name="min_depth"]').val(existingScript.minDepth ?? '');
  editorHtml.find('input[name="max_depth"]').val(existingScript.maxDepth ?? '');

  try {
    const placementArr = Array.isArray(existingScript.placement) ? existingScript.placement : [];
    placementArr.forEach((element) => {
      editorHtml
        .find(`input[name="replace_position"][value="${element}"]`)
        .prop('checked', true);
    });
  } catch { }

  const regexFromString = utilsMod?.regexFromString;
  const setInfoBlock = utilsMod?.setInfoBlock;
  const uuidv4 = utilsMod?.uuidv4;

  const updateInfoBlock = () => {
    const infoBlock = editorHtml.find('.info-block').get(0);
    const infoBlockFlagsHint = editorHtml.find('#regex_info_block_flags_hint');
    const findRegex = String(editorHtml.find('.find_regex').val());

    try { infoBlockFlagsHint.hide(); } catch { }

    if (typeof setInfoBlock !== 'function') return;

    // Clear the info block if the find regex is empty
    if (!findRegex) {
      setInfoBlock(infoBlock, 'Find Regex 为空', 'info');
      return;
    }

    if (typeof regexFromString !== 'function') return;

    try {
      const regex = regexFromString(findRegex);
      if (!regex) throw new Error('无效的 Find Regex');

      const flagInfo = [];
      flagInfo.push(regex.flags.includes('g') ? '全局匹配 (g)' : '仅匹配第一个');
      flagInfo.push(regex.flags.includes('i') ? '忽略大小写 (i)' : '区分大小写');

      setInfoBlock(infoBlock, flagInfo.join('；'), 'hint');
      try { infoBlockFlagsHint.show(); } catch { }
    } catch (error) {
      setInfoBlock(infoBlock, error?.message ?? String(error), 'error');
    }
  };

  const updateTestResult = () => {
    updateInfoBlock();

    // Test mode UI (optional)
    try {
      if (!editorHtml.find('#regex_test_mode').is(':visible')) return;
    } catch {
      return;
    }

    if (typeof engine?.runRegexScript !== 'function') return;

    const testScript = {
      id: (typeof uuidv4 === 'function') ? uuidv4() : (globalThis.crypto?.randomUUID?.() ?? String(Math.random())),
      scriptName: editorHtml.find('.regex_script_name').val().toString(),
      findRegex: editorHtml.find('.find_regex').val().toString(),
      replaceString: editorHtml.find('.regex_replace_string').val().toString(),
      trimStrings: String(editorHtml.find('.regex_trim_strings').val()).split('\n').filter((e) => e.length !== 0) || [],
      substituteRegex: Number(editorHtml.find('select[name="substitute_regex"]').val()),
      disabled: false,
      promptOnly: false,
      markdownOnly: false,
      runOnEdit: false,
      minDepth: null,
      maxDepth: null,
      placement: null,
    };

    const rawTestString = String(editorHtml.find('#regex_test_input').val());
    const result = engine.runRegexScript(testScript, rawTestString);
    editorHtml.find('#regex_test_output').text(result);
  };

  // Wire up test mode toggle
  editorHtml.find('#regex_test_mode_toggle').on('click', function () {
    editorHtml.find('#regex_test_mode').toggleClass('displayNone');
    updateTestResult();
  });

  editorHtml.find('input, textarea, select').on('input', updateTestResult);
  updateInfoBlock();

  const popupResult = await callGenericPopup(
    editorHtml,
    POPUP_TYPE.CONFIRM,
    '',
    { okButton: '保存', cancelButton: '取消', allowVerticalScrolling: true },
  );

  if (!popupResult) return;

  const newScriptName = String(editorHtml.find('.regex_script_name').val());
  const newFindRegex = String(editorHtml.find('.find_regex').val());
  const newReplaceString = String(editorHtml.find('.regex_replace_string').val());
  const newTrimStrings = String(editorHtml.find('.regex_trim_strings').val()).split('\n').filter((e) => e.length !== 0) || [];
  const newPlacement =
    editorHtml
      .find('input[name="replace_position"]')
      .filter(':checked')
      .map(function () { return parseInt($(this).val().toString()); })
      .get()
      .filter((e) => !isNaN(e)) || [];

  const newDisabled = Boolean(editorHtml.find('input[name="disabled"]').prop('checked'));
  const newMarkdownOnly = Boolean(editorHtml.find('input[name="only_format_display"]').prop('checked'));
  const newPromptOnly = Boolean(editorHtml.find('input[name="only_format_prompt"]').prop('checked'));
  const newRunOnEdit = Boolean(editorHtml.find('input[name="run_on_edit"]').prop('checked'));
  const newSubstituteRegex = Number(editorHtml.find('select[name="substitute_regex"]').val());
  const newMinDepth = parseInt(String(editorHtml.find('input[name="min_depth"]').val()));
  const newMaxDepth = parseInt(String(editorHtml.find('input[name="max_depth"]').val()));

  if (!newScriptName) {
    globalThis.toastr?.error('无法保存：脚本名为空。');
    return;
  }
  if (newFindRegex.length === 0) {
    globalThis.toastr?.warning('该脚本 Find Regex 为空：可能不会生效，但仍会保存。');
  }
  if (newPlacement.length === 0) {
    globalThis.toastr?.warning('该脚本未勾选任何 Affects：可能不会生效，但仍会保存。');
  }

  // Mutate in place to keep DOM closures (e.g. export) pointing to latest data
  existingScript.scriptName = newScriptName;
  existingScript.findRegex = newFindRegex;
  existingScript.replaceString = newReplaceString;
  existingScript.trimStrings = newTrimStrings;
  existingScript.placement = newPlacement;
  existingScript.disabled = newDisabled;
  existingScript.markdownOnly = newMarkdownOnly;
  existingScript.promptOnly = newPromptOnly;
  existingScript.runOnEdit = newRunOnEdit;
  existingScript.substituteRegex = newSubstituteRegex;
  existingScript.minDepth = newMinDepth;
  existingScript.maxDepth = newMaxDepth;

  await engine.saveScriptsByType(hit.list, hit.type);

  // Keep behavior similar to core: saving scoped/preset scripts implies allowing them
  try {
    if (hit.type === engine.SCRIPT_TYPES.SCOPED) {
      const character = ctx.characters?.[ctx.characterId];
      engine.allowScopedScripts?.(character);
    }
    if (hit.type === engine.SCRIPT_TYPES.PRESET) {
      engine.allowPresetScripts?.(engine.getCurrentPresetAPI?.(), engine.getCurrentPresetName?.());
    }
  } catch { }

  syncScriptLabelUi(scriptLabelEl, existingScript);

  saveSettings(ctx);
  markDirty();
}

async function deleteScriptsByIds(idsByType) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  for (const [type, ids] of idsByType.entries()) {
    const list = engine.getScriptsByType(type) || [];
    const before = list.length;
    const next = list.filter(s => !ids.has(s?.id));
    if (next.length !== before) {
      await engine.saveScriptsByType(next, type);
    }
  }

  // Remove DOM nodes
  for (const ids of idsByType.values()) {
    for (const id of ids) {
      document.getElementById(id)?.remove();
    }
  }

  saveSettings(ctx);
  markDirty();
}

async function moveScriptsToType({ ids, toType }) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  // Validate scoped move constraints
  if (toType === engine.SCRIPT_TYPES.SCOPED) {
    if (ctx.characterId === undefined || ctx.characterId === null) {
      globalThis.toastr?.error('未选择角色，无法移动到「局部」脚本。');
      return;
    }
    if (ctx.groupId) {
      globalThis.toastr?.error('群聊中无法编辑「局部」脚本。');
      return;
    }
  }

  const types = [engine.SCRIPT_TYPES.GLOBAL, engine.SCRIPT_TYPES.SCOPED, engine.SCRIPT_TYPES.PRESET];
  const lists = new Map(types.map(t => [t, [...(engine.getScriptsByType(t) || [])]]));
  const byId = new Map();
  for (const t of types) {
    for (const s of lists.get(t)) {
      if (s?.id) byId.set(s.id, { type: t, script: s });
    }
  }

  const touched = new Set();
  for (const id of ids) {
    const info = byId.get(id);
    if (!info) continue;
    if (info.type === toType) continue;

    const fromList = lists.get(info.type);
    const toList = lists.get(toType);
    if (!fromList || !toList) continue;

    // Remove from fromList
    const idx = fromList.findIndex(x => x?.id === id);
    if (idx !== -1) {
      fromList.splice(idx, 1);
      toList.push(info.script);
      touched.add(info.type);
      touched.add(toType);
    }
  }

  for (const t of touched) {
    await engine.saveScriptsByType(lists.get(t), t);
  }

  try {
    if (touched.has(engine.SCRIPT_TYPES.SCOPED) || toType === engine.SCRIPT_TYPES.SCOPED) {
      const character = ctx.characters?.[ctx.characterId];
      engine.allowScopedScripts?.(character);
    }
    if (touched.has(engine.SCRIPT_TYPES.PRESET) || toType === engine.SCRIPT_TYPES.PRESET) {
      engine.allowPresetScripts?.(engine.getCurrentPresetAPI?.(), engine.getCurrentPresetName?.());
    }
  } catch { }

  // Move DOM nodes
  const destSelector =
    toType === engine.SCRIPT_TYPES.GLOBAL ? '#saved_regex_scripts'
      : toType === engine.SCRIPT_TYPES.SCOPED ? '#saved_scoped_scripts'
        : '#saved_preset_scripts';
  const dest = document.querySelector(destSelector);
  if (dest instanceof HTMLElement) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el instanceof HTMLElement) dest.appendChild(el);
    }
  }

  saveSettings(ctx);
  markDirty();
}

function syncUiList(containerSelector, scripts) {
  const root = document.querySelector(containerSelector);
  if (!(root instanceof HTMLElement)) return;

  // Map id -> element
  const idToEl = new Map();
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const id = el.getAttribute('id');
    if (id) idToEl.set(id, el);
  }

  const frag = document.createDocumentFragment();
  for (const s of scripts) {
    const id = s?.id;
    if (!id) continue;
    const el = idToEl.get(id);
    if (!el) continue;
    frag.appendChild(el);
    // Update disable checkbox state
    const cb = el.querySelector('input.disable_regex');
    if (cb instanceof HTMLInputElement) cb.checked = Boolean(s.disabled);
  }

  // Append any elements not covered (keep at end)
  for (const [id, el] of idToEl.entries()) {
    if (!scripts?.some(s => s?.id === id)) {
      frag.appendChild(el);
    }
  }

  root.appendChild(frag);
}

async function applyPresetById(presetId) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  const presets = ctx.extensionSettings?.regex_presets;
  if (!Array.isArray(presets)) {
    globalThis.toastr?.error('未找到 regex 预设数据。');
    return;
  }

  const preset = presets.find(p => p?.id === presetId);
  if (!preset) {
    globalThis.toastr?.error('选择的 regex 预设不存在。');
    return;
  }

  /** @type {Array<[number, any[], string]>} */
  const mappings = [
    [engine.SCRIPT_TYPES.GLOBAL, Array.isArray(preset.global) ? preset.global : [], '#saved_regex_scripts'],
    [engine.SCRIPT_TYPES.SCOPED, Array.isArray(preset.scoped) ? preset.scoped : [], '#saved_scoped_scripts'],
    [engine.SCRIPT_TYPES.PRESET, Array.isArray(preset.preset) ? preset.preset : [], '#saved_preset_scripts'],
  ];

  for (const [type, presetList, containerSel] of mappings) {
    const list = engine.getScriptsByType(type) || [];
    const presetIds = presetList.map(x => x?.id).filter(Boolean);
    const presetSet = new Set(presetIds);
    const presetIndex = new Map(presetIds.map((id, i) => [id, i]));
    const originalIndex = new Map(list.map((s, i) => [s?.id, i]));

    for (const script of list) {
      if (!script?.id) continue;
      script.disabled = !presetSet.has(script.id);
    }

    list.sort((a, b) => {
      const ai = presetIndex.has(a?.id) ? presetIndex.get(a.id) : Number.POSITIVE_INFINITY;
      const bi = presetIndex.has(b?.id) ? presetIndex.get(b.id) : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      const ao = originalIndex.get(a?.id) ?? 0;
      const bo = originalIndex.get(b?.id) ?? 0;
      return ao - bo;
    });

    await engine.saveScriptsByType(list, type);
    syncUiList(containerSel, list);
  }

  // Update selected flag
  presets.forEach(p => { p.isSelected = p?.id === presetId; });
  saveSettings(ctx);

  markDirty();
}

async function applyScopedPresetAllowToggle({ kind, enabled }) {
  const ctx = _ctx || getCtx();
  if (!ctx) return;
  const engine = await importRegexEngine();
  if (!engine) return;

  if (kind === 'scoped') {
    if (ctx.characterId === undefined || ctx.characterId === null) {
      globalThis.toastr?.error('未选择角色，无法切换局部正则。');
      return;
    }
    if (ctx.groupId) {
      globalThis.toastr?.error('群聊中无法编辑局部正则。');
      return;
    }
    const character = ctx.characters?.[ctx.characterId];
    if (enabled) engine.allowScopedScripts?.(character);
    else engine.disallowScopedScripts?.(character);
    saveSettings(ctx);
    markDirty();
    return;
  }

  if (kind === 'preset') {
    const apiId = engine.getCurrentPresetAPI?.();
    const name = engine.getCurrentPresetName?.();
    if (!apiId || !name) {
      globalThis.toastr?.error('未找到当前预设信息，无法切换预设正则。');
      return;
    }
    if (enabled) engine.allowPresetScripts?.(apiId, name);
    else engine.disallowPresetScripts?.(apiId, name);
    saveSettings(ctx);
    markDirty();
  }
}

function collectDisplayedMessageIds() {
  const nodes = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
  const ids = [];
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    const v = el.getAttribute('mesid');
    const id = Number(v);
    if (!Number.isFinite(id)) continue;
    ids.push(id);
  }
  // unique + stable order
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function rerenderDisplayedMessagesChunked(ctx, batchSize) {
  const ids = collectDisplayedMessageIds();
  if (ids.length === 0) return Promise.resolve({ total: 0 });

  return new Promise((resolve) => {
    let index = 0;
    const total = ids.length;

    const step = () => {
      const end = Math.min(total, index + batchSize);
      for (; index < end; index++) {
        const id = ids[index];
        const message = ctx.chat?.[id];
        if (!message) continue;
        try {
          ctx.updateMessageBlock?.(id, message, { rerenderMessage: true });
          // updateMessageBlock() does NOT emit MESSAGE_UPDATED in core.
          // Emit it here so other plugins (e.g. JS-Slash-Runner) can re-scan and render frontend blocks.
          try {
            if (ctx?.eventSource?.emit && ctx?.eventTypes?.MESSAGE_UPDATED) {
              void ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, id);
            }
          } catch { }
        } catch (e) {
          console.warn(`[${EXTENSION_NAME}] updateMessageBlock failed for #${id}`, e);
        }
      }

      if (index >= total) {
        resolve({ total });
        return;
      }
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  });
}

async function refreshChatOnce() {
  const ctx = _ctx || getCtx();
  if (!ctx) return;

  const mode = _settings?.refreshMode ?? DEFAULT_SETTINGS.refreshMode;

  if (mode === 'full') {
    logDebug('refresh: full reloadCurrentChat()');
    try {
      await ctx.reloadCurrentChat?.();
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] reloadCurrentChat failed`, e);
    }
    return;
  }

  // Safety fallback: if incremental rerender isn't available, do a full reload.
  if (typeof ctx.updateMessageBlock !== 'function') {
    console.warn(`[${EXTENSION_NAME}] updateMessageBlock not available; falling back to full reload`);
    try {
      await ctx.reloadCurrentChat?.();
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] reloadCurrentChat failed`, e);
    }
    return;
  }

  const batchSize = clampInt(_settings?.rerenderBatchSize, 1, 200, DEFAULT_SETTINGS.rerenderBatchSize);
  logDebug('refresh: incremental rerender', { batchSize });
  await rerenderDisplayedMessagesChunked(ctx, batchSize);
}

async function flushDirtyIfPanelHidden() {
  if (!_settings?.enabled) return;

  // Only flush when panel is NOT visible right now
  if (isRegexPanelVisible()) return;

  // Wait for pending saves first (so we rerender with latest script state)
  try { await _saveChain; } catch { }

  if (!_dirty) return;
  _dirty = false;

  await refreshChatOnce();
}

function scheduleFlushOnClose() {
  if (_closeTimer !== null) return;
  const delayMs = clampInt(_settings?.closeRefreshDelayMs, 0, 5000, DEFAULT_SETTINGS.closeRefreshDelayMs);
  _closeTimer = window.setTimeout(() => {
    _closeTimer = null;
    void flushDirtyIfPanelHidden();
  }, delayMs);
}

function onVisibilityMaybeChanged() {
  const visible = isRegexPanelVisible();
  if (_lastPanelVisible && !visible) {
    logDebug('panel hidden -> schedule flush');
    scheduleFlushOnClose();
  }
  _lastPanelVisible = visible;
}

function installVisibilityObserver() {
  if (_installedVisibilityObserver) return;
  const obs = new MutationObserver(() => {
    // Throttle to next frame to avoid storm
    if (installVisibilityObserver._rafPending) return;
    installVisibilityObserver._rafPending = true;
    requestAnimationFrame(() => {
      installVisibilityObserver._rafPending = false;
      onVisibilityMaybeChanged();
      // Also try to patch sortable once regex UI appears
      if (!_installedSortablePatch) {
        void tryInstallSortablePatch();
      }
    });
  });
  installVisibilityObserver._rafPending = false;

  obs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    // 只关心 openDrawer/closedDrawer 的 class 变化
    attributeFilter: ['class'],
  });

  // Initial state
  _lastPanelVisible = isRegexPanelVisible();
  _installedVisibilityObserver = true;
}

async function tryInstallSortablePatch() {
  if (_installedSortablePatch) return;
  const container = getRegexContainer();
  if (!container) return;
  if (!globalThis.jQuery) return;

  const engine = await importRegexEngine();
  if (!engine) return;

  const $ = globalThis.jQuery;
  const patchOne = (selector, type) => {
    if (_patchedSortableSelectors.has(selector)) return true;
    const el = $(selector);
    if (!el.length) return false;
    try {
      // If sortable not initialized yet, this will throw.
      el.sortable('instance');
    } catch {
      return false;
    }
    try {
      el.sortable('option', 'stop', async () => {
        if (!_settings?.enabled) return;
        // Rebuild order from DOM
        const ids = el.children().map((_, child) => $(child).attr('id')).get().filter(Boolean);
        const oldList = engine.getScriptsByType(type) || [];
        const idToScript = new Map(oldList.map(s => [s?.id, s]));
        const pushed = new Set();
        const newList = [];
        for (const id of ids) {
          const s = idToScript.get(id);
          if (s && s?.id && !pushed.has(s.id)) {
            newList.push(s);
            pushed.add(s.id);
          }
        }
        for (const s of oldList) {
          if (!s?.id) continue;
          if (pushed.has(s.id)) continue;
          newList.push(s);
          pushed.add(s.id);
        }
        await engine.saveScriptsByType(newList, type);
        saveSettings(_ctx || getCtx());
        markDirty();
      });
      _patchedSortableSelectors.add(selector);
      return true;
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] failed to patch sortable for ${selector}`, e);
      return false;
    }
  };

  patchOne('#saved_regex_scripts', engine.SCRIPT_TYPES.GLOBAL);
  patchOne('#saved_scoped_scripts', engine.SCRIPT_TYPES.SCOPED);
  patchOne('#saved_preset_scripts', engine.SCRIPT_TYPES.PRESET);

  if (_patchedSortableSelectors.size >= 3) {
    _installedSortablePatch = true;
    logDebug('sortable patched (all)');
  } else if (_patchedSortableSelectors.size > 0) {
    logDebug('sortable patched (partial)', Array.from(_patchedSortableSelectors));
  }
}

function installGlobalEventInterceptors() {
  if (_installedGlobalListeners) return;

  const onInputCapture = (e) => {
    if (!_settings?.enabled) return;
    const container = getRegexContainer();
    if (!container) return;
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!container.contains(t)) return;

    // 1) 单条开关：input.disable_regex
    if (t instanceof HTMLInputElement && t.classList.contains('disable_regex')) {
      // Block built-in handler (prevents reloadCurrentChat)
      stopEvent(e);
      const scriptLabel = t.closest('.regex-script-label');
      const scriptId = scriptLabel?.getAttribute?.('id') || scriptLabel?.id;
      if (!scriptId) return;
      queueWork(async () => {
        const engine = await importRegexEngine();
        if (!engine) return;
        const type = getScriptTypeFromDom(scriptLabel, engine);
        await setScriptDisabled(scriptId, type, t.checked);
      });
      return;
    }

    // 2) scoped/preset allow toggles
    if (t instanceof HTMLInputElement && (t.id === 'regex_scoped_toggle' || t.id === 'regex_preset_toggle')) {
      stopEvent(e);
      const kind = (t.id === 'regex_scoped_toggle') ? 'scoped' : 'preset';
      queueWork(async () => {
        await applyScopedPresetAllowToggle({ kind, enabled: Boolean(t.checked) });
      });
      return;
    }
  };

  const onChangeCapture = (e) => {
    if (!_settings?.enabled) return;
    const container = getRegexContainer();
    if (!container) return;
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!container.contains(t)) return;

    // 预设下拉切换
    if (t instanceof HTMLSelectElement && t.id === 'regex_presets') {
      stopEvent(e);
      const presetId = String(t.value || '');
      if (!presetId) return;
      queueWork(async () => {
        await applyPresetById(presetId);
      });
      return;
    }
  };

  const onClickCapture = (e) => {
    if (!_settings?.enabled) return;
    const container = getRegexContainer();
    if (!container) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!container.contains(target)) return;

    // bulk enable/disable
    const bulkEnable = target.closest('#bulk_enable_regex');
    const bulkDisable = target.closest('#bulk_disable_regex');
    if (bulkEnable || bulkDisable) {
      stopEvent(e);
      const enable = Boolean(bulkEnable);
      queueWork(async () => {
        await bulkSetDisabled({ enable });
      });
      return;
    }

    // 单条编辑（修复跨作用域移动后：编辑器内容显示为空）
    const editBtn = target.closest('.edit_existing_regex');
    if (editBtn) {
      const scriptLabel = target.closest('.regex-script-label');
      if (!scriptLabel) return;
      stopEvent(e);
      const scriptId = scriptLabel.getAttribute('id') || scriptLabel.id;
      if (!scriptId) return;
      queueWork(async () => {
        const engine = await importRegexEngine();
        if (!engine) return;
        const type = getScriptTypeFromDom(scriptLabel, engine);
        await openRegexEditorForScript({ scriptId, scriptTypeMaybe: type, scriptLabelEl: scriptLabel });
      });
      return;
    }

    // 单条移动（避免 move -> reloadCurrentChat）
    const moveGlobal = target.closest('.move_to_global');
    const moveScoped = target.closest('.move_to_scoped');
    const movePreset = target.closest('.move_to_preset');
    if (moveGlobal || moveScoped || movePreset) {
      const scriptLabel = target.closest('.regex-script-label');
      if (!scriptLabel) return;
      stopEvent(e);
      const scriptId = scriptLabel.getAttribute('id') || scriptLabel.id;
      if (!scriptId) return;
      queueWork(async () => {
        const ok = await confirmUi('确定要移动这个正则脚本吗？');
        if (!ok) return;
        const engine = await importRegexEngine();
        if (!engine) return;
        const toType = moveGlobal ? engine.SCRIPT_TYPES.GLOBAL : moveScoped ? engine.SCRIPT_TYPES.SCOPED : engine.SCRIPT_TYPES.PRESET;
        await moveScriptsToType({ ids: [scriptId], toType });
      });
      return;
    }

    // 批量移动（避免 bulk move -> reloadCurrentChat）
    const bulkMoveGlobal = target.closest('#bulk_regex_move_to_global');
    const bulkMoveScoped = target.closest('#bulk_regex_move_to_scoped');
    const bulkMovePreset = target.closest('#bulk_regex_move_to_preset');
    if (bulkMoveGlobal || bulkMoveScoped || bulkMovePreset) {
      stopEvent(e);
      queueWork(async () => {
        const engine = await importRegexEngine();
        if (!engine) return;
        const selectedLabels = getSelectedScriptLabelElements();
        if (selectedLabels.length === 0) {
          globalThis.toastr?.warning('未选择需要移动的正则脚本。');
          return;
        }
        const ok = await confirmUi(`确定要移动选中的 ${selectedLabels.length} 个脚本吗？`);
        if (!ok) return;
        const ids = selectedLabels.map(x => x.getAttribute('id')).filter(Boolean);
        const toType = bulkMoveGlobal ? engine.SCRIPT_TYPES.GLOBAL : bulkMoveScoped ? engine.SCRIPT_TYPES.SCOPED : engine.SCRIPT_TYPES.PRESET;
        await moveScriptsToType({ ids, toType });
      });
      return;
    }

    // 单条脚本 toggle 图标（防止 jQuery trigger('input') 走不到原生 input 事件）
    const scriptLabelForToggle = target.closest('.regex-script-label');
    if (scriptLabelForToggle) {
      const toggleOn = target.closest('.regex-toggle-on');
      const toggleOff = target.closest('.regex-toggle-off');
      if (toggleOn || toggleOff) {
        stopEvent(e);
        const scriptId = scriptLabelForToggle.getAttribute('id') || scriptLabelForToggle.id;
        if (!scriptId) return;
        const input = scriptLabelForToggle.querySelector('input.disable_regex');
        const checked = Boolean(toggleOn); // checked == disabled
        if (input instanceof HTMLInputElement) {
          input.checked = checked;
        }
        queueWork(async () => {
          const engine = await importRegexEngine();
          if (!engine) return;
          const type = getScriptTypeFromDom(scriptLabelForToggle, engine);
          await setScriptDisabled(scriptId, type, checked);
        });
        return;
      }
    }

    // 单条删除（避免 delete -> reloadCurrentChat）
    const deleteBtn = target.closest('.delete_regex');
    if (deleteBtn) {
      const scriptLabel = target.closest('.regex-script-label');
      if (!scriptLabel) return;
      stopEvent(e);
      const scriptId = scriptLabel.getAttribute('id') || scriptLabel.id;
      if (!scriptId) return;
      queueWork(async () => {
        const ok = await confirmUi('确定要删除这个正则脚本吗？');
        if (!ok) return;
        const engine = await importRegexEngine();
        if (!engine) return;
        const type = getScriptTypeFromDom(scriptLabel, engine) ?? findScriptAcrossTypes(engine, scriptId)?.type;
        if (type === null || type === undefined) return;
        const idsByType = new Map([[type, new Set([scriptId])]]);
        await deleteScriptsByIds(idsByType);
      });
      return;
    }

    // 批量删除（避免 bulk_delete -> reloadCurrentChat）
    const bulkDelete = target.closest('#bulk_delete_regex');
    if (bulkDelete) {
      stopEvent(e);
      queueWork(async () => {
        const engine = await importRegexEngine();
        if (!engine) return;
        const selectedLabels = getSelectedScriptLabelElements();
        if (selectedLabels.length === 0) {
          globalThis.toastr?.warning('未选择需要删除的正则脚本。');
          return;
        }
        const ok = await confirmUi(`确定要删除选中的 ${selectedLabels.length} 个脚本吗？`);
        if (!ok) return;
        /** @type {Map<number, Set<string>>} */
        const idsByType = new Map();
        for (const label of selectedLabels) {
          const id = label.getAttribute('id');
          if (!id) continue;
          const type = getScriptTypeFromDom(label, engine) ?? findScriptAcrossTypes(engine, id)?.type;
          if (type === null || type === undefined) continue;
          if (!idsByType.has(type)) idsByType.set(type, new Set());
          idsByType.get(type).add(id);
        }
        await deleteScriptsByIds(idsByType);
      });
      return;
    }

    // preset apply button
    const applyBtn = target.closest('#regex_preset_apply');
    if (applyBtn) {
      stopEvent(e);
      const select = container.querySelector('#regex_presets');
      const presetId = (select instanceof HTMLSelectElement) ? String(select.value || '') : '';
      if (!presetId) return;
      queueWork(async () => {
        await applyPresetById(presetId);
      });
      return;
    }
  };

  document.addEventListener('input', onInputCapture, true);
  document.addEventListener('change', onChangeCapture, true);
  document.addEventListener('click', onClickCapture, true);

  _installedGlobalListeners = true;
}

async function registerSettingsPanel(ctx) {
  const ST_API = globalThis.ST_API;
  if (!ST_API?.ui?.registerSettingsPanel) return false;

  const PANEL_CONTAINER_ID = 'st-rro-settings-root';
  if (document.getElementById(PANEL_CONTAINER_ID)) return true;

  try {
    await ST_API.ui.registerSettingsPanel({
      id: `${EXTENSION_NAME}.settings`,
      title: '正则刷新优化',
      target: 'right',
      expanded: false,
      order: 55,
      content: {
        kind: 'render',
        render: (container) => {
          const root = document.createElement('div');
          root.id = PANEL_CONTAINER_ID;
          root.className = 'st-rro-panel';
          root.innerHTML = `
            <div class="st-rro-row">
              <label>
                <input id="st_rro_enabled" type="checkbox">
                启用优化（面板收起后再刷新）
              </label>
            </div>
            <div class="st-rro-row">
              <label>
                刷新策略
                <select id="st_rro_refreshMode" class="text_pole">
                  <option value="incremental">增量重渲染（推荐）</option>
                  <option value="full">全量重载聊天（更稳）</option>
                </select>
              </label>
              <label>
                每帧条数
                <input id="st_rro_batchSize" type="number" min="1" max="200" step="1">
              </label>
              <label>
                收起后延迟(ms)
                <input id="st_rro_closeDelay" type="number" min="0" max="5000" step="10">
              </label>
            </div>
            <div class="st-rro-row">
              <button id="st_rro_applyNow" class="menu_button">立即刷新一次（不关闭面板）</button>
              <label>
                <input id="st_rro_debug" type="checkbox">
                Debug log
              </label>
            </div>
            <div class="st-rro-help">
              <div>说明：</div>
              <div>- 酒馆内置 Regex 在开关脚本时会触发 <code>reloadCurrentChat()</code>，导致重复全量重渲染与正则重跑。</div>
              <div>- 本插件在“正则面板展开期间”拦截这些刷新；当面板收起/隐藏时才统一刷新一次。</div>
              <div>- 若遇到兼容性问题，可把“刷新策略”切到“全量重载聊天”。</div>
            </div>
          `;

          container.appendChild(root);

          const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_enabled'));
          const $mode = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_rro_refreshMode'));
          const $batch = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_batchSize'));
          const $delay = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_closeDelay'));
          const $apply = /** @type {HTMLButtonElement|null} */ (root.querySelector('#st_rro_applyNow'));
          const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_debug'));

          const refreshUI = () => {
            const s = ensureExtensionSettings(ctx);
            if (!s) return;
            _settings = s;
            if ($enabled) $enabled.checked = Boolean(s.enabled);
            if ($mode) $mode.value = String(s.refreshMode);
            if ($batch) $batch.value = String(s.rerenderBatchSize);
            if ($delay) $delay.value = String(s.closeRefreshDelayMs);
            if ($debug) $debug.checked = Boolean(s.debugLog);
          };

          const onChange = () => {
            const s = ensureExtensionSettings(ctx);
            if (!s) return;
            if ($enabled) s.enabled = Boolean($enabled.checked);
            if ($mode) s.refreshMode = ($mode.value === 'full') ? 'full' : 'incremental';
            if ($batch) s.rerenderBatchSize = clampInt($batch.value, 1, 200, DEFAULT_SETTINGS.rerenderBatchSize);
            if ($delay) s.closeRefreshDelayMs = clampInt($delay.value, 0, 5000, DEFAULT_SETTINGS.closeRefreshDelayMs);
            if ($debug) s.debugLog = Boolean($debug.checked);
            _settings = s;
            saveSettings(ctx);
            refreshUI();
          };

          const onApplyNow = async () => {
            try {
              // Force an immediate refresh even if panel is open
              if (_settings?.enabled) {
                await _saveChain;
                await refreshChatOnce();
                _dirty = false;
              }
            } catch (e) {
              console.warn(`[${EXTENSION_NAME}] applyNow failed`, e);
            }
          };

          $enabled?.addEventListener('change', onChange);
          $mode?.addEventListener('change', onChange);
          $batch?.addEventListener('change', onChange);
          $delay?.addEventListener('change', onChange);
          $debug?.addEventListener('change', onChange);
          $apply?.addEventListener('click', onApplyNow);

          refreshUI();

          return () => {
            $enabled?.removeEventListener('change', onChange);
            $mode?.removeEventListener('change', onChange);
            $batch?.removeEventListener('change', onChange);
            $delay?.removeEventListener('change', onChange);
            $debug?.removeEventListener('change', onChange);
            $apply?.removeEventListener('click', onApplyNow);
          };
        },
      },
    });
    return true;
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] registerSettingsPanel failed`, e);
    return false;
  }
}

async function registerFallbackSettingsUi(ctx) {
  // Simple fallback UI when st-api-wrapper is not installed
  const rootId = 'st_rro_fallback_settings';
  if (document.getElementById(rootId)) return;

  const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
  if (!host) return;

  const wrapper = document.createElement('div');
  wrapper.id = rootId;
  wrapper.className = 'inline-drawer';
  wrapper.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>正则刷新优化</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="st-rro-panel">
        <div class="st-rro-row">
          <label><input id="st_rro_enabled_fb" type="checkbox"> 启用优化（面板收起后再刷新）</label>
        </div>
        <div class="st-rro-row">
          <label>刷新策略
            <select id="st_rro_refreshMode_fb" class="text_pole">
              <option value="incremental">增量重渲染（推荐）</option>
              <option value="full">全量重载聊天（更稳）</option>
            </select>
          </label>
          <label>每帧条数 <input id="st_rro_batchSize_fb" type="number" min="1" max="200" step="1"></label>
          <label>收起后延迟(ms) <input id="st_rro_closeDelay_fb" type="number" min="0" max="5000" step="10"></label>
        </div>
        <div class="st-rro-row">
          <button id="st_rro_applyNow_fb" class="menu_button">立即刷新一次</button>
        </div>
        <div class="st-rro-help">
          <div>提示：安装 <code>st-api-wrapper</code> 可获得更一致的设置面板体验。</div>
        </div>
      </div>
    </div>
  `;

  host.appendChild(wrapper);

  const $enabled = /** @type {HTMLInputElement|null} */ (wrapper.querySelector('#st_rro_enabled_fb'));
  const $mode = /** @type {HTMLSelectElement|null} */ (wrapper.querySelector('#st_rro_refreshMode_fb'));
  const $batch = /** @type {HTMLInputElement|null} */ (wrapper.querySelector('#st_rro_batchSize_fb'));
  const $delay = /** @type {HTMLInputElement|null} */ (wrapper.querySelector('#st_rro_closeDelay_fb'));
  const $apply = /** @type {HTMLButtonElement|null} */ (wrapper.querySelector('#st_rro_applyNow_fb'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    _settings = s;
    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($mode) $mode.value = String(s.refreshMode);
    if ($batch) $batch.value = String(s.rerenderBatchSize);
    if ($delay) $delay.value = String(s.closeRefreshDelayMs);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($mode) s.refreshMode = ($mode.value === 'full') ? 'full' : 'incremental';
    if ($batch) s.rerenderBatchSize = clampInt($batch.value, 1, 200, DEFAULT_SETTINGS.rerenderBatchSize);
    if ($delay) s.closeRefreshDelayMs = clampInt($delay.value, 0, 5000, DEFAULT_SETTINGS.closeRefreshDelayMs);
    _settings = s;
    saveSettings(ctx);
    refreshUI();
  };

  const onApplyNow = async () => {
    try {
      await _saveChain;
      await refreshChatOnce();
      _dirty = false;
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] fallback applyNow failed`, e);
    }
  };

  $enabled?.addEventListener('change', onChange);
  $mode?.addEventListener('change', onChange);
  $batch?.addEventListener('change', onChange);
  $delay?.addEventListener('change', onChange);
  $apply?.addEventListener('click', onApplyNow);

  refreshUI();
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return;
  _ctx = ctx;

  const s = ensureExtensionSettings(ctx);
  if (!s) return;
  _settings = s;

  // Preload regex engine; if it fails, do not intercept anything.
  const engine = await importRegexEngine();
  if (!engine) {
    console.warn(`[${EXTENSION_NAME}] Regex engine unavailable; extension will be inert`);
    return;
  }

  installGlobalEventInterceptors();
  installVisibilityObserver();
  void tryInstallSortablePatch();

  globalThis.__stRegexRefreshOptimizer = {
    version: '0.1.0',
    extensionName: EXTENSION_NAME,
    folderPath: EXTENSION_FOLDER_PATH,
    get settings() { return _settings; },
    get dirty() { return _dirty; },
    flush: () => flushDirtyIfPanelHidden(),
    refreshNow: () => refreshChatOnce(),
  };
}

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_rro_enabled" type="checkbox">
        启用优化（面板收起后再刷新）
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">刷新策略</span>
        <select id="st_rro_refreshMode">
          <option value="incremental">增量重渲染（推荐）</option>
          <option value="full">全量重载聊天（更稳）</option>
        </select>
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">每帧条数</span>
        <input id="st_rro_batchSize" type="number" min="1" max="200" step="1">
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">收起后延迟(ms)</span>
        <input id="st_rro_closeDelay" type="number" min="0" max="5000" step="10">
      </label>

      <label class="cocktail-check">
        <input id="st_rro_debug" type="checkbox">
        Debug log
      </label>
    </div>

    <div class="cocktail-actions">
      <button id="st_rro_applyNow" type="button" class="cocktail-btn">立即刷新一次（不关闭面板）</button>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 酒馆内置 Regex 在开关脚本时会触发 <code>reloadCurrentChat()</code>，导致重复全量重渲染与正则重跑。</div>
      <div>- 本插件在“正则面板展开期间”拦截这些刷新；当面板收起/隐藏时才统一刷新一次。</div>
    </div>
  `;

  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_enabled'));
  const $mode = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_rro_refreshMode'));
  const $batch = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_batchSize'));
  const $delay = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_closeDelay'));
  const $apply = /** @type {HTMLButtonElement|null} */ (root.querySelector('#st_rro_applyNow'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_rro_debug'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    _settings = s;
    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($mode) $mode.value = String(s.refreshMode);
    if ($batch) $batch.value = String(s.rerenderBatchSize);
    if ($delay) $delay.value = String(s.closeRefreshDelayMs);
    if ($debug) $debug.checked = Boolean(s.debugLog);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($mode) s.refreshMode = ($mode.value === 'full') ? 'full' : 'incremental';
    if ($batch) s.rerenderBatchSize = clampInt($batch.value, 1, 200, DEFAULT_SETTINGS.rerenderBatchSize);
    if ($delay) s.closeRefreshDelayMs = clampInt($delay.value, 0, 5000, DEFAULT_SETTINGS.closeRefreshDelayMs);
    if ($debug) s.debugLog = Boolean($debug.checked);
    _settings = s;
    saveSettings(ctx);
    refreshUI();
  };

  const onApplyNow = async () => {
    try {
      if (_settings?.enabled) {
        await _saveChain;
        await refreshChatOnce();
        _dirty = false;
      }
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] applyNow failed`, e);
    }
  };

  $enabled?.addEventListener('change', onChange);
  $mode?.addEventListener('change', onChange);
  $batch?.addEventListener('change', onChange);
  $delay?.addEventListener('change', onChange);
  $debug?.addEventListener('change', onChange);
  $apply?.addEventListener('click', onApplyNow);

  refreshUI();

  return () => {
    $enabled?.removeEventListener('change', onChange);
    $mode?.removeEventListener('change', onChange);
    $batch?.removeEventListener('change', onChange);
    $delay?.removeEventListener('change', onChange);
    $debug?.removeEventListener('change', onChange);
    $apply?.removeEventListener('click', onApplyNow);
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '正则刷新优化',
  order: 30,
  render: renderCocktailSettings,
});

if (!_ALREADY_LOADED) {
  globalThis.jQuery?.(async () => {
    await init();
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
  });
}

