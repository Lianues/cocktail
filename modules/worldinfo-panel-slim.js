/**
 * st-worldinfo-panel-slim
 *
 * 目标：
 * - 精简 WorldInfo 条目编辑面板，隐藏不常用区块，降低展开时的前端渲染负担
 * - 不改酒馆源代码，仅在前端 DOM 层做可逆处理
 *
 * 当前处理的区块：
 * - “额外匹配来源”（Additional Matching Sources）
 * - “主要关键字”（key）
 * - “逻辑”（entryLogicType）
 * - “可选过滤器”（keysecondary）
 * - “绑定到角色或标签”（characterFilter）
 * - “筛选生成触发器”（triggers）
 * - “扫描深度”（scanDepth）
 * - “区分大小写”（caseSensitive）
 * - “完整单词”（matchWholeWords）
 * - “组评分”（useGroupScoring）
 * - “自动化ID”（automationId）
 * - “递归等级”（delayUntilRecursionLevel）
 * - “包含组”（group/groupOverride）
 * - “组权重”（groupWeight）
 * - “粘性”（sticky）
 * - “冷却”（cooldown）
 * - “延迟”（delay）
 * - “不可递归”（excludeRecursion）
 * - “防止进一步递归”（preventRecursion）
 * - “延迟到递归”（delay_until_recursion）
 * - “无视回复限额”（ignoreBudget）
 * - WIEntryBottomControls（selective/useProbability/addMemo 那块）
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-worldinfo-panel-slim';

const DEFAULT_SETTINGS = Object.freeze({
  optimizationMode: 'hide', // 'hide' | 'remove'
  enabled: false,
  hideAdditionalMatchingSources: false,
  hidePrimaryKeywords: false,
  hideEntryLogic: false,
  hideOptionalFilter: false,
  hideCharacterOrTagFilter: false,
  hideGenerationTriggersFilter: false,
  hideScanDepth: false,
  hideCaseSensitive: false,
  hideMatchWholeWords: false,
  hideUseGroupScoring: false,
  hideAutomationId: false,
  hideRecursionLevel: false,
  hideInclusionGroup: false,
  hideGroupWeight: false,
  hideSticky: false,
  hideCooldown: false,
  hideDelay: false,
  hideExcludeRecursion: false,
  hidePreventRecursion: false,
  hideDelayUntilRecursion: false,
  hideIgnoreBudget: false,
  hideBottomLegacyControls: false,
  debugLog: false,
});

const HIDDEN_BY_ATTR = 'data-st-wips-hidden-by';
const HIDDEN_PREV_DISPLAY_ATTR = 'data-st-wips-prev-display';
const OPTIMIZATION_MODE_HIDE = 'hide';
const OPTIMIZATION_MODE_REMOVE = 'remove';

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stWorldInfoPanelSlimLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stWorldInfoPanelSlimLoaded = true;
}

const STATE = {
  started: false,
  ctx: null,
  settings: null,
  observer: /** @type {MutationObserver|null} */ (null),
  rafPending: false,
  lastDigest: '',
  observerTarget: /** @type {Node|null} */ (null),
  templateSnapshotHtml: /** @type {string|null} */ (null),
  dirtyEntries: new Set(),
  forceFullApply: true,
};

/** @type {WeakMap<HTMLElement, { parent: Node, nextSibling: Node | null }>} */
const REMOVED_STATE_BY_EL = new WeakMap();
/** @type {Set<HTMLElement>} */
const REMOVED_ELS = new Set();

function logDebug(...args) {
  if (STATE.settings?.debugLog) {
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

function ensureExtensionSettings(ctx) {
  const root = ctx?.extensionSettings;
  if (!root) return null;

  root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
  const s = root[EXTENSION_NAME];

  // 兼容旧版本：hideStickyCooldownDelay -> hideSticky/hideCooldown/hideDelay
  const legacyHideStickyCooldownDelay = (typeof s.hideStickyCooldownDelay === 'boolean')
    ? Boolean(s.hideStickyCooldownDelay)
    : null;
  const hadHideSticky = s.hideSticky !== undefined;
  const hadHideCooldown = s.hideCooldown !== undefined;
  const hadHideDelay = s.hideDelay !== undefined;

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) s[k] = v;
  }

  if (legacyHideStickyCooldownDelay !== null) {
    if (!hadHideSticky) s.hideSticky = legacyHideStickyCooldownDelay;
    if (!hadHideCooldown) s.hideCooldown = legacyHideStickyCooldownDelay;
    if (!hadHideDelay) s.hideDelay = legacyHideStickyCooldownDelay;
  }

  s.enabled = Boolean(s.enabled);
  const modeRaw = String(s.optimizationMode || '').trim().toLowerCase();
  s.optimizationMode = (modeRaw === OPTIMIZATION_MODE_REMOVE) ? OPTIMIZATION_MODE_REMOVE : OPTIMIZATION_MODE_HIDE;
  s.hideAdditionalMatchingSources = Boolean(s.hideAdditionalMatchingSources);
  s.hidePrimaryKeywords = Boolean(s.hidePrimaryKeywords);
  s.hideEntryLogic = Boolean(s.hideEntryLogic);
  s.hideOptionalFilter = Boolean(s.hideOptionalFilter);
  s.hideCharacterOrTagFilter = Boolean(s.hideCharacterOrTagFilter);
  s.hideGenerationTriggersFilter = Boolean(s.hideGenerationTriggersFilter);
  s.hideScanDepth = Boolean(s.hideScanDepth);
  s.hideCaseSensitive = Boolean(s.hideCaseSensitive);
  s.hideMatchWholeWords = Boolean(s.hideMatchWholeWords);
  s.hideUseGroupScoring = Boolean(s.hideUseGroupScoring);
  s.hideAutomationId = Boolean(s.hideAutomationId);
  s.hideRecursionLevel = Boolean(s.hideRecursionLevel);
  s.hideInclusionGroup = Boolean(s.hideInclusionGroup);
  s.hideGroupWeight = Boolean(s.hideGroupWeight);
  s.hideSticky = Boolean(s.hideSticky);
  s.hideCooldown = Boolean(s.hideCooldown);
  s.hideDelay = Boolean(s.hideDelay);
  s.hideExcludeRecursion = Boolean(s.hideExcludeRecursion);
  s.hidePreventRecursion = Boolean(s.hidePreventRecursion);
  s.hideDelayUntilRecursion = Boolean(s.hideDelayUntilRecursion);
  s.hideIgnoreBudget = Boolean(s.hideIgnoreBudget);
  s.hideBottomLegacyControls = Boolean(s.hideBottomLegacyControls);
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

function getWorldEntriesListEl() {
  const el = document.getElementById('world_popup_entries_list');
  return (el instanceof HTMLElement) ? el : null;
}

function getEntryEditTemplateRoot() {
  const el = document.getElementById('entry_edit_template');
  return (el instanceof HTMLElement) ? el : null;
}

function ensureTemplateSnapshot() {
  if (STATE.templateSnapshotHtml !== null) return;
  const root = getEntryEditTemplateRoot();
  if (!root) return;
  STATE.templateSnapshotHtml = root.innerHTML;
}

function restoreTemplateSnapshot() {
  const root = getEntryEditTemplateRoot();
  if (!root) return;
  if (STATE.templateSnapshotHtml === null) return;
  if (root.innerHTML !== STATE.templateSnapshotHtml) {
    root.innerHTML = STATE.templateSnapshotHtml;
  }
}

function removeMatchedBlocks(editTemplateEl, blocks) {
  for (const el of blocks) {
    if (!(el instanceof HTMLElement)) continue;
    if (editTemplateEl.contains(el)) el.remove();
  }
}

function applyTemplatePruningForRemoveMode() {
  ensureTemplateSnapshot();

  const root = getEntryEditTemplateRoot();
  if (!root || STATE.templateSnapshotHtml === null) return;

  const s = STATE.settings;
  if (!(s?.enabled) || s.optimizationMode !== OPTIMIZATION_MODE_REMOVE) {
    restoreTemplateSnapshot();
    return;
  }

  // 每次都从原始模板开始裁剪，避免累计误差。
  restoreTemplateSnapshot();

  const editTemplateEl = root.querySelector('.world_entry_edit');
  if (!(editTemplateEl instanceof HTMLElement)) return;

  if (s.hideAdditionalMatchingSources) removeMatchedBlocks(editTemplateEl, findAdditionalMatchingSourceBlocks(editTemplateEl));
  if (s.hidePrimaryKeywords) removeMatchedBlocks(editTemplateEl, findPrimaryKeywordsBlocks(editTemplateEl));
  if (s.hideEntryLogic) removeMatchedBlocks(editTemplateEl, findEntryLogicBlocks(editTemplateEl));
  if (s.hideOptionalFilter) removeMatchedBlocks(editTemplateEl, findOptionalFilterBlocks(editTemplateEl));
  if (s.hideCharacterOrTagFilter) removeMatchedBlocks(editTemplateEl, findCharacterOrTagFilterBlocks(editTemplateEl));
  if (s.hideGenerationTriggersFilter) removeMatchedBlocks(editTemplateEl, findGenerationTriggersFilterBlocks(editTemplateEl));
  if (s.hideScanDepth) removeMatchedBlocks(editTemplateEl, findScanDepthBlocks(editTemplateEl));
  if (s.hideCaseSensitive) removeMatchedBlocks(editTemplateEl, findCaseSensitiveBlocks(editTemplateEl));
  if (s.hideMatchWholeWords) removeMatchedBlocks(editTemplateEl, findMatchWholeWordsBlocks(editTemplateEl));
  if (s.hideUseGroupScoring) removeMatchedBlocks(editTemplateEl, findUseGroupScoringBlocks(editTemplateEl));
  if (s.hideAutomationId) removeMatchedBlocks(editTemplateEl, findAutomationIdBlocks(editTemplateEl));
  if (s.hideRecursionLevel) removeMatchedBlocks(editTemplateEl, findRecursionLevelBlocks(editTemplateEl));
  if (s.hideInclusionGroup) removeMatchedBlocks(editTemplateEl, findInclusionGroupBlocks(editTemplateEl));
  if (s.hideGroupWeight) removeMatchedBlocks(editTemplateEl, findGroupWeightBlocks(editTemplateEl));
  if (s.hideSticky) removeMatchedBlocks(editTemplateEl, findStickyBlocks(editTemplateEl));
  if (s.hideCooldown) removeMatchedBlocks(editTemplateEl, findCooldownBlocks(editTemplateEl));
  if (s.hideDelay) removeMatchedBlocks(editTemplateEl, findDelayBlocks(editTemplateEl));
  if (s.hideExcludeRecursion) removeMatchedBlocks(editTemplateEl, findExcludeRecursionBlocks(editTemplateEl));
  if (s.hidePreventRecursion) removeMatchedBlocks(editTemplateEl, findPreventRecursionBlocks(editTemplateEl));
  if (s.hideDelayUntilRecursion) removeMatchedBlocks(editTemplateEl, findDelayUntilRecursionBlocks(editTemplateEl));
  if (s.hideIgnoreBudget) removeMatchedBlocks(editTemplateEl, findIgnoreBudgetBlocks(editTemplateEl));

  if (s.hideBottomLegacyControls) {
    const bottomLegacyControl = editTemplateEl.querySelector('[name="WIEntryBottomControls"]');
    if (bottomLegacyControl instanceof HTMLElement) bottomLegacyControl.remove();
  }

  // 同步压缩模板内部空容器，减少后续 clone 时的无效节点。
  compactEmptyContainers(editTemplateEl);
}

function markRemoved(el) {
  if (!(el instanceof HTMLElement)) return;
  if (REMOVED_STATE_BY_EL.has(el)) return;
  const parent = el.parentNode;
  if (!parent) return;

  REMOVED_STATE_BY_EL.set(el, {
    parent,
    nextSibling: el.nextSibling,
  });
  REMOVED_ELS.add(el);
  el.remove();
}

function restoreRemoved(el) {
  if (!(el instanceof HTMLElement)) return;
  const record = REMOVED_STATE_BY_EL.get(el);
  if (!record) return;

  const { parent, nextSibling } = record;
  try {
    if (parent.isConnected) {
      if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(el, nextSibling);
      } else {
        parent.appendChild(el);
      }
    }
  } catch { }

  REMOVED_STATE_BY_EL.delete(el);
  REMOVED_ELS.delete(el);
}

function restoreAllRemoved() {
  Array.from(REMOVED_ELS).forEach((el) => {
    restoreRemoved(el);
  });
}

function markDisplayHidden(el) {
  if (!(el instanceof HTMLElement)) return;
  if (el.getAttribute(HIDDEN_BY_ATTR) === EXTENSION_NAME) return;

  el.setAttribute(HIDDEN_BY_ATTR, EXTENSION_NAME);
  el.setAttribute(HIDDEN_PREV_DISPLAY_ATTR, el.style.display || '');
  el.style.display = 'none';
}

function restoreDisplayHidden(el) {
  if (!(el instanceof HTMLElement)) return;
  if (el.getAttribute(HIDDEN_BY_ATTR) !== EXTENSION_NAME) return;

  const prev = el.getAttribute(HIDDEN_PREV_DISPLAY_ATTR);
  if (prev === null) {
    el.style.removeProperty('display');
  } else if (prev === '') {
    el.style.removeProperty('display');
  } else {
    el.style.display = prev;
  }

  el.removeAttribute(HIDDEN_PREV_DISPLAY_ATTR);
  el.removeAttribute(HIDDEN_BY_ATTR);
}

function markHidden(el) {
  const mode = STATE.settings?.optimizationMode === OPTIMIZATION_MODE_REMOVE
    ? OPTIMIZATION_MODE_REMOVE
    : OPTIMIZATION_MODE_HIDE;
  if (mode === OPTIMIZATION_MODE_REMOVE) {
    restoreDisplayHidden(el);
    markRemoved(el);
    return;
  }

  restoreRemoved(el);
  markDisplayHidden(el);
}

function restoreHidden(el) {
  restoreDisplayHidden(el);
  restoreRemoved(el);
}

function restoreAllHidden() {
  document.querySelectorAll(`[${HIDDEN_BY_ATTR}="${EXTENSION_NAME}"]`).forEach((el) => {
    restoreDisplayHidden(el);
  });
}

function isHiddenByUs(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.getAttribute(HIDDEN_BY_ATTR) === EXTENSION_NAME) return true;
  return Boolean(el.closest(`[${HIDDEN_BY_ATTR}="${EXTENSION_NAME}"]`));
}

function isEffectivelyVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (!el.isConnected) return false;
  if (isHiddenByUs(el)) return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
  } catch {
    return false;
  }
  return true;
}

function hasVisibleTargets(container, selector) {
  if (!(container instanceof HTMLElement)) return false;
  const nodes = container.querySelectorAll(selector);
  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (isEffectivelyVisible(n)) return true;
  }
  return false;
}

function applyCompactVisibility(container, shouldHide) {
  if (!(container instanceof HTMLElement)) return;
  if (shouldHide) markHidden(container);
  else restoreHidden(container);
}

function compactEmptyContainers(entryEl) {
  if (!(entryEl instanceof HTMLElement)) return;

  const keywordsAndLogicBlock = entryEl.querySelector('[name="keywordsAndLogicBlock"]');
  const perEntryOverridesBlock = entryEl.querySelector('[name="perEntryOverridesBlock"]');
  const contentControl = entryEl.querySelector('textarea[name="content"]')?.closest('.world_entry_form_control');
  const contentExtraOptionsWrap = contentControl?.querySelector('label small > span > div.flex-container');

  applyCompactVisibility(keywordsAndLogicBlock, !hasVisibleTargets(keywordsAndLogicBlock, '.world_entry_form_control'));
  applyCompactVisibility(perEntryOverridesBlock, !hasVisibleTargets(perEntryOverridesBlock, '.world_entry_form_control'));
  applyCompactVisibility(
    contentExtraOptionsWrap,
    !hasVisibleTargets(
      contentExtraOptionsWrap,
      'input[name="excludeRecursion"],input[name="preventRecursion"],input[name="delay_until_recursion"],input[name="ignoreBudget"]',
    ),
  );

  const compactRows = Array.from(entryEl.children).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    return el.classList.contains('flex-container') && el.classList.contains('wide100p') && el.classList.contains('flexGap10');
  });
  for (const row of compactRows) {
    const hasControls = hasVisibleTargets(row, '.world_entry_form_control, input, select, textarea, button, label.checkbox, label.checkbox_label');
    applyCompactVisibility(row, !hasControls);
  }
}

/**
 * 定位“额外匹配来源”块。
 * 用 input name 识别，避免受 i18n 文本变化影响。
 * @param {HTMLElement} entryEl
 * @returns {HTMLElement[]}
 */
function findAdditionalMatchingSourceBlocks(entryEl) {
  /** @type {HTMLElement[]} */
  const out = [];
  const drawers = entryEl.querySelectorAll('.inline-drawer.wide100p.flexFlowColumn');
  for (const drawer of drawers) {
    if (!(drawer instanceof HTMLElement)) continue;

    const hasMarkerInput = drawer.querySelector(
      'input[name="matchCharacterDescription"],input[name="matchCharacterPersonality"],input[name="matchScenario"],input[name="matchPersonaDescription"],input[name="matchCharacterDepthPrompt"],input[name="matchCreatorNotes"]',
    );

    if (hasMarkerInput) out.push(drawer);
  }
  return out;
}

/**
 * 通过 selector 定位所属 world_entry_form_control 区块。
 * @param {HTMLElement} entryEl
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
function findControlBlocksBySelector(entryEl, selector) {
  const blocks = new Set();
  entryEl.querySelectorAll(selector).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const block = el.closest('.world_entry_form_control');
    if (block instanceof HTMLElement) blocks.add(block);
  });
  return Array.from(blocks);
}

function findPrimaryKeywordsBlocks(entryEl) {
  return findControlBlocksBySelector(
    entryEl,
    'textarea[name="key"],select[name="key"],.world_entry_form_control.keyprimary',
  );
}

function findEntryLogicBlocks(entryEl) {
  return findControlBlocksBySelector(
    entryEl,
    'select[name="entryLogicType"]',
  );
}

function findOptionalFilterBlocks(entryEl) {
  return findControlBlocksBySelector(
    entryEl,
    'textarea[name="keysecondary"],select[name="keysecondary"],.world_entry_form_control.keysecondary',
  );
}

/**
 * 通过 select name 定位所属区块。
 * @param {HTMLElement} entryEl
 * @param {string} selectName
 * @returns {HTMLElement[]}
 */
function findBlocksBySelectName(entryEl, selectName) {
  const blocks = new Set();

  entryEl.querySelectorAll(`select[name="${selectName}"]`).forEach((sel) => {
    if (!(sel instanceof HTMLElement)) return;

    const block = sel.closest('.flex4');
    if (block instanceof HTMLElement) {
      blocks.add(block);
      return;
    }

    const fallback = sel.closest('.range-block-range')?.parentElement;
    if (fallback instanceof HTMLElement) blocks.add(fallback);
  });

  return Array.from(blocks);
}

function findCharacterOrTagFilterBlocks(entryEl) {
  return findBlocksBySelectName(entryEl, 'characterFilter');
}

function findGenerationTriggersFilterBlocks(entryEl) {
  return findBlocksBySelectName(entryEl, 'triggers');
}

/**
 * 通过字段名定位 perEntryOverridesBlock 内的 world_entry_form_control。
 * @param {HTMLElement} entryEl
 * @param {{ inputNames?: string[]; selectNames?: string[] }} options
 * @returns {HTMLElement[]}
 */
function findPerEntryOverrideBlocks(entryEl, options = {}) {
  const blocks = new Set();
  const { inputNames = [], selectNames = [] } = options;

  for (const name of inputNames) {
    entryEl.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
      const block = el.closest('.world_entry_form_control');
      if (block instanceof HTMLElement) blocks.add(block);
    });
  }

  for (const name of selectNames) {
    entryEl.querySelectorAll(`select[name="${name}"]`).forEach((el) => {
      const block = el.closest('.world_entry_form_control');
      if (block instanceof HTMLElement) blocks.add(block);
    });
  }

  return Array.from(blocks);
}

function findScanDepthBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { inputNames: ['scanDepth'] }); }
function findCaseSensitiveBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { selectNames: ['caseSensitive'] }); }
function findMatchWholeWordsBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { selectNames: ['matchWholeWords'] }); }
function findUseGroupScoringBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { selectNames: ['useGroupScoring'] }); }
function findAutomationIdBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { inputNames: ['automationId'] }); }
function findRecursionLevelBlocks(entryEl) { return findPerEntryOverrideBlocks(entryEl, { inputNames: ['delayUntilRecursionLevel'] }); }

/**
 * 通过 input name 定位所属区块。
 * @param {HTMLElement} entryEl
 * @param {string[]} inputNames
 * @param {string} [preferredClosestSelector]
 * @returns {HTMLElement[]}
 */
function findBlocksByInputNames(entryEl, inputNames, preferredClosestSelector = '') {
  const blocks = new Set();

  for (const name of inputNames) {
    entryEl.querySelectorAll(`input[name="${name}"]`).forEach((inputEl) => {
      if (!(inputEl instanceof HTMLElement)) return;

      const preferred = preferredClosestSelector ? inputEl.closest(preferredClosestSelector) : null;
      if (preferred instanceof HTMLElement) {
        blocks.add(preferred);
        return;
      }

      const fallback = inputEl.closest('.range-block-range')?.parentElement;
      if (fallback instanceof HTMLElement) blocks.add(fallback);
    });
  }

  return Array.from(blocks);
}

function findInclusionGroupBlocks(entryEl) {
  return findBlocksByInputNames(entryEl, ['group', 'groupOverride'], '.flex4');
}

function findGroupWeightBlocks(entryEl) {
  return findBlocksByInputNames(entryEl, ['groupWeight'], '.flex2');
}

function findStickyBlocks(entryEl) {
  return findBlocksByInputNames(entryEl, ['sticky'], '.flex2');
}

function findCooldownBlocks(entryEl) {
  return findBlocksByInputNames(entryEl, ['cooldown'], '.flex2');
}

function findDelayBlocks(entryEl) {
  return findBlocksByInputNames(entryEl, ['delay'], '.flex2');
}

/**
 * 通过 checkbox input name 定位对应的 label.checkbox（精确到单个开关）。
 * @param {HTMLElement} entryEl
 * @param {string[]} inputNames
 * @returns {HTMLElement[]}
 */
function findCheckboxLabelBlocks(entryEl, inputNames) {
  const blocks = new Set();
  for (const name of inputNames) {
    entryEl.querySelectorAll(`input[name="${name}"]`).forEach((inputEl) => {
      if (!(inputEl instanceof HTMLElement)) return;
      const label = inputEl.closest('label.checkbox');
      if (label instanceof HTMLElement) {
        blocks.add(label);
      }
    });
  }
  return Array.from(blocks);
}

function findExcludeRecursionBlocks(entryEl) { return findCheckboxLabelBlocks(entryEl, ['excludeRecursion']); }

function findPreventRecursionBlocks(entryEl) { return findCheckboxLabelBlocks(entryEl, ['preventRecursion']); }

function findDelayUntilRecursionBlocks(entryEl) { return findCheckboxLabelBlocks(entryEl, ['delay_until_recursion']); }

function findIgnoreBudgetBlocks(entryEl) { return findCheckboxLabelBlocks(entryEl, ['ignoreBudget']); }

/**
 * @param {HTMLElement} entryEl
 */
function applyToWorldEntry(entryEl) {
  const s = STATE.settings;
  if (!s) return;

  const additionalBlocks = findAdditionalMatchingSourceBlocks(entryEl);
  const bottomLegacyControl = entryEl.querySelector('[name="WIEntryBottomControls"]');
  const primaryKeywordsBlocks = findPrimaryKeywordsBlocks(entryEl);
  const entryLogicBlocks = findEntryLogicBlocks(entryEl);
  const optionalFilterBlocks = findOptionalFilterBlocks(entryEl);
  const characterOrTagFilterBlocks = findCharacterOrTagFilterBlocks(entryEl);
  const generationTriggersFilterBlocks = findGenerationTriggersFilterBlocks(entryEl);
  const scanDepthBlocks = findScanDepthBlocks(entryEl);
  const caseSensitiveBlocks = findCaseSensitiveBlocks(entryEl);
  const matchWholeWordsBlocks = findMatchWholeWordsBlocks(entryEl);
  const useGroupScoringBlocks = findUseGroupScoringBlocks(entryEl);
  const automationIdBlocks = findAutomationIdBlocks(entryEl);
  const recursionLevelBlocks = findRecursionLevelBlocks(entryEl);
  const inclusionGroupBlocks = findInclusionGroupBlocks(entryEl);
  const groupWeightBlocks = findGroupWeightBlocks(entryEl);
  const stickyBlocks = findStickyBlocks(entryEl);
  const cooldownBlocks = findCooldownBlocks(entryEl);
  const delayBlocks = findDelayBlocks(entryEl);
  const excludeRecursionBlocks = findExcludeRecursionBlocks(entryEl);
  const preventRecursionBlocks = findPreventRecursionBlocks(entryEl);
  const delayUntilRecursionBlocks = findDelayUntilRecursionBlocks(entryEl);
  const ignoreBudgetBlocks = findIgnoreBudgetBlocks(entryEl);

  if (s.enabled && s.hideAdditionalMatchingSources) {
    additionalBlocks.forEach(markHidden);
  } else {
    additionalBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hidePrimaryKeywords) {
    primaryKeywordsBlocks.forEach(markHidden);
  } else {
    primaryKeywordsBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideEntryLogic) {
    entryLogicBlocks.forEach(markHidden);
  } else {
    entryLogicBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideOptionalFilter) {
    optionalFilterBlocks.forEach(markHidden);
  } else {
    optionalFilterBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideCharacterOrTagFilter) {
    characterOrTagFilterBlocks.forEach(markHidden);
  } else {
    characterOrTagFilterBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideGenerationTriggersFilter) {
    generationTriggersFilterBlocks.forEach(markHidden);
  } else {
    generationTriggersFilterBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideScanDepth) {
    scanDepthBlocks.forEach(markHidden);
  } else {
    scanDepthBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideCaseSensitive) {
    caseSensitiveBlocks.forEach(markHidden);
  } else {
    caseSensitiveBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideMatchWholeWords) {
    matchWholeWordsBlocks.forEach(markHidden);
  } else {
    matchWholeWordsBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideUseGroupScoring) {
    useGroupScoringBlocks.forEach(markHidden);
  } else {
    useGroupScoringBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideAutomationId) {
    automationIdBlocks.forEach(markHidden);
  } else {
    automationIdBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideRecursionLevel) {
    recursionLevelBlocks.forEach(markHidden);
  } else {
    recursionLevelBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideInclusionGroup) {
    inclusionGroupBlocks.forEach(markHidden);
  } else {
    inclusionGroupBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideGroupWeight) {
    groupWeightBlocks.forEach(markHidden);
  } else {
    groupWeightBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideSticky) {
    stickyBlocks.forEach(markHidden);
  } else {
    stickyBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideCooldown) {
    cooldownBlocks.forEach(markHidden);
  } else {
    cooldownBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideDelay) {
    delayBlocks.forEach(markHidden);
  } else {
    delayBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideExcludeRecursion) {
    excludeRecursionBlocks.forEach(markHidden);
  } else {
    excludeRecursionBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hidePreventRecursion) {
    preventRecursionBlocks.forEach(markHidden);
  } else {
    preventRecursionBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideDelayUntilRecursion) {
    delayUntilRecursionBlocks.forEach(markHidden);
  } else {
    delayUntilRecursionBlocks.forEach(restoreHidden);
  }

  if (s.enabled && s.hideIgnoreBudget) {
    ignoreBudgetBlocks.forEach(markHidden);
  } else {
    ignoreBudgetBlocks.forEach(restoreHidden);
  }

  if (bottomLegacyControl instanceof HTMLElement) {
    if (s.enabled && s.hideBottomLegacyControls) {
      markHidden(bottomLegacyControl);
    } else {
      restoreHidden(bottomLegacyControl);
    }
  }

  compactEmptyContainers(entryEl);
}

function isEntryEditorInitialized(entryEl) {
  if (!(entryEl instanceof HTMLElement)) return false;
  return Boolean(entryEl.querySelector('.world_entry_edit'));
}

function applyToCurrentWorldInfoPanel() {
  const listEl = getWorldEntriesListEl();
  if (!listEl) return;

  const entries = listEl.querySelectorAll('.world_entry');
  entries.forEach((entry) => {
    if (entry instanceof HTMLElement && isEntryEditorInitialized(entry)) {
      applyToWorldEntry(entry);
    }
  });
}

function markDirtyEntryFromNode(node) {
  if (!(node instanceof Node)) return;

  if (!(node instanceof HTMLElement)) return;

  // 绝大多数 mutation 都发生在某个 world_entry 子树内，直接向上找最近条目即可。
  const closestEntry = node.closest('.world_entry');
  if (closestEntry instanceof HTMLElement) {
    STATE.dirtyEntries.add(closestEntry);
    return;
  }

  // 兜底：当整条目作为新增节点插入列表时，node 本身可能就是 world_entry。
  if (node.matches('.world_entry')) {
    STATE.dirtyEntries.add(node);
  }
}

function applyToDirtyEntriesIfAny() {
  if (STATE.dirtyEntries.size === 0) return false;

  const entries = Array.from(STATE.dirtyEntries)
    .filter((entry) => entry instanceof HTMLElement)
    .filter((entry) => entry.isConnected)
    .filter((entry) => isEntryEditorInitialized(entry));

  STATE.dirtyEntries.clear();
  if (entries.length === 0) return false;

  for (const entry of entries) {
    applyToWorldEntry(entry);
  }
  return true;
}

function makeSettingsDigest(s) {
  if (!s) return '';
  return [
    s.enabled,
    s.optimizationMode,
    s.hideAdditionalMatchingSources,
    s.hidePrimaryKeywords,
    s.hideEntryLogic,
    s.hideOptionalFilter,
    s.hideCharacterOrTagFilter,
    s.hideGenerationTriggersFilter,
    s.hideScanDepth,
    s.hideCaseSensitive,
    s.hideMatchWholeWords,
    s.hideUseGroupScoring,
    s.hideAutomationId,
    s.hideRecursionLevel,
    s.hideInclusionGroup,
    s.hideGroupWeight,
    s.hideSticky,
    s.hideCooldown,
    s.hideDelay,
    s.hideExcludeRecursion,
    s.hidePreventRecursion,
    s.hideDelayUntilRecursion,
    s.hideIgnoreBudget,
    s.hideBottomLegacyControls,
  ].map((x) => String(Boolean(x))).join('|') + `|mode:${String(s.optimizationMode || '')}`;
}

function scheduleApply() {
  if (STATE.rafPending) return;
  STATE.rafPending = true;

  requestAnimationFrame(() => {
    STATE.rafPending = false;

    if (!STATE.settings?.enabled) {
      restoreAllRemoved();
      restoreAllHidden();
      STATE.dirtyEntries.clear();
      STATE.forceFullApply = true;
      STATE.lastDigest = makeSettingsDigest(STATE.settings);
      return;
    }

    const nextDigest = makeSettingsDigest(STATE.settings);
    if (nextDigest !== STATE.lastDigest) {
      // 仅在设置变更时做一次全量恢复，避免每次 DOM 变动都触发全量回流。
      STATE.forceFullApply = true;
      restoreAllRemoved();
      restoreAllHidden();
      STATE.lastDigest = nextDigest;
    }

    if (STATE.forceFullApply) {
      STATE.forceFullApply = false;
      STATE.dirtyEntries.clear();
      applyToCurrentWorldInfoPanel();
      return;
    }

    const appliedDirty = applyToDirtyEntriesIfAny();
    if (!appliedDirty) {
      // 没有脏条目时不做全量扫描，避免 500/page 时每次交互都扫全列表。
      return;
    }
  });
}

function ensureObserver() {
  const target = getWorldEntriesListEl()
    ?? document.getElementById('WorldInfo')
    ?? document.body;

  if (!(target instanceof Node)) return;
  if (STATE.observer && STATE.observerTarget === target) return;

  disconnectObserver();

  try {
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        // 优先用 target 定位（最便宜）
        markDirtyEntryFromNode(rec.target);
        rec.addedNodes?.forEach((n) => markDirtyEntryFromNode(n));
      }
      if (records.length > 0) scheduleApply();
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
    });

    STATE.observer = observer;
    STATE.observerTarget = target;
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] MutationObserver init failed`, e);
  }
}

function disconnectObserver() {
  if (!STATE.observer) return;
  try {
    STATE.observer.disconnect();
  } catch { }
  STATE.observerTarget = null;
  STATE.observer = null;
}

function refreshRuntime() {
  if (STATE.settings?.enabled) {
    ensureObserver();
    applyTemplatePruningForRemoveMode();
    // 模板或观察目标刷新后，下一帧做一次全量（仅初始化条目）校正。
    STATE.forceFullApply = true;
    scheduleApply();
  } else {
    restoreTemplateSnapshot();
    disconnectObserver();
  }
  scheduleApply();
}

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-check">
        <input id="st_wips_enabled" type="checkbox">
        启用面板精简
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">优化模式</span>
        <select id="st_wips_mode" class="text_pole margin0">
          <option value="hide">隐藏（兼容优先）</option>
          <option value="remove">硬删除（性能优先）</option>
        </select>
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_additional" type="checkbox">
        隐藏“额外匹配来源”
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_primary_keywords" type="checkbox">
        隐藏 主要关键字
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_entry_logic" type="checkbox">
        隐藏 逻辑
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_optional_filter" type="checkbox">
        隐藏 可选过滤器
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_character_filter" type="checkbox">
        隐藏 绑定到角色或标签
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_triggers_filter" type="checkbox">
        隐藏 筛选生成触发器
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_scan_depth" type="checkbox">
        隐藏 扫描深度
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_case_sensitive" type="checkbox">
        隐藏 区分大小写
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_match_whole_words" type="checkbox">
        隐藏 完整单词
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_use_group_scoring" type="checkbox">
        隐藏 组评分
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_automation_id" type="checkbox">
        隐藏 自动化ID
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_recursion_level" type="checkbox">
        隐藏 递归等级
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_inclusion_group" type="checkbox">
        隐藏 包含组
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_group_weight" type="checkbox">
        隐藏 组权重
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_sticky" type="checkbox">
        隐藏 粘性
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_cooldown" type="checkbox">
        隐藏 冷却
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_delay" type="checkbox">
        隐藏 延迟
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_exclude_recursion" type="checkbox">
        隐藏 不可递归
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_prevent_recursion" type="checkbox">
        隐藏 防止进一步递归
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_delay_until_recursion" type="checkbox">
        隐藏 延迟到递归
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_ignore_budget" type="checkbox">
        隐藏 无视回复限额
      </label>

      <label class="cocktail-check">
        <input id="st_wips_hide_bottom" type="checkbox">
        隐藏底部旧控件（WIEntryBottomControls）
      </label>

      <label class="cocktail-check">
        <input id="st_wips_debug" type="checkbox">
        Debug log
      </label>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- 该模块只隐藏 DOM，不改酒馆核心逻辑。</div>
      <div>- 关闭本模块后会恢复已隐藏区块。</div>
    </div>
  `;

  container.appendChild(root);

  const $enabled = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_enabled'));
  const $mode = /** @type {HTMLSelectElement|null} */ (root.querySelector('#st_wips_mode'));
  const $hideAdditional = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_additional'));
  const $hidePrimaryKeywords = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_primary_keywords'));
  const $hideEntryLogic = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_entry_logic'));
  const $hideOptionalFilter = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_optional_filter'));
  const $hideCharacterFilter = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_character_filter'));
  const $hideTriggersFilter = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_triggers_filter'));
  const $hideScanDepth = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_scan_depth'));
  const $hideCaseSensitive = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_case_sensitive'));
  const $hideMatchWholeWords = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_match_whole_words'));
  const $hideUseGroupScoring = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_use_group_scoring'));
  const $hideAutomationId = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_automation_id'));
  const $hideRecursionLevel = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_recursion_level'));
  const $hideInclusionGroup = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_inclusion_group'));
  const $hideGroupWeight = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_group_weight'));
  const $hideSticky = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_sticky'));
  const $hideCooldown = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_cooldown'));
  const $hideDelay = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_delay'));
  const $hideExcludeRecursion = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_exclude_recursion'));
  const $hidePreventRecursion = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_prevent_recursion'));
  const $hideDelayUntilRecursion = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_delay_until_recursion'));
  const $hideIgnoreBudget = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_ignore_budget'));
  const $hideBottom = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_hide_bottom'));
  const $debug = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_wips_debug'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    STATE.settings = s;

    if ($enabled) $enabled.checked = Boolean(s.enabled);
    if ($mode) $mode.value = s.optimizationMode === OPTIMIZATION_MODE_REMOVE ? OPTIMIZATION_MODE_REMOVE : OPTIMIZATION_MODE_HIDE;
    if ($hideAdditional) $hideAdditional.checked = Boolean(s.hideAdditionalMatchingSources);
    if ($hidePrimaryKeywords) $hidePrimaryKeywords.checked = Boolean(s.hidePrimaryKeywords);
    if ($hideEntryLogic) $hideEntryLogic.checked = Boolean(s.hideEntryLogic);
    if ($hideOptionalFilter) $hideOptionalFilter.checked = Boolean(s.hideOptionalFilter);
    if ($hideCharacterFilter) $hideCharacterFilter.checked = Boolean(s.hideCharacterOrTagFilter);
    if ($hideTriggersFilter) $hideTriggersFilter.checked = Boolean(s.hideGenerationTriggersFilter);
    if ($hideScanDepth) $hideScanDepth.checked = Boolean(s.hideScanDepth);
    if ($hideCaseSensitive) $hideCaseSensitive.checked = Boolean(s.hideCaseSensitive);
    if ($hideMatchWholeWords) $hideMatchWholeWords.checked = Boolean(s.hideMatchWholeWords);
    if ($hideUseGroupScoring) $hideUseGroupScoring.checked = Boolean(s.hideUseGroupScoring);
    if ($hideAutomationId) $hideAutomationId.checked = Boolean(s.hideAutomationId);
    if ($hideRecursionLevel) $hideRecursionLevel.checked = Boolean(s.hideRecursionLevel);
    if ($hideInclusionGroup) $hideInclusionGroup.checked = Boolean(s.hideInclusionGroup);
    if ($hideGroupWeight) $hideGroupWeight.checked = Boolean(s.hideGroupWeight);
    if ($hideSticky) $hideSticky.checked = Boolean(s.hideSticky);
    if ($hideCooldown) $hideCooldown.checked = Boolean(s.hideCooldown);
    if ($hideDelay) $hideDelay.checked = Boolean(s.hideDelay);
    if ($hideExcludeRecursion) $hideExcludeRecursion.checked = Boolean(s.hideExcludeRecursion);
    if ($hidePreventRecursion) $hidePreventRecursion.checked = Boolean(s.hidePreventRecursion);
    if ($hideDelayUntilRecursion) $hideDelayUntilRecursion.checked = Boolean(s.hideDelayUntilRecursion);
    if ($hideIgnoreBudget) $hideIgnoreBudget.checked = Boolean(s.hideIgnoreBudget);
    if ($hideBottom) $hideBottom.checked = Boolean(s.hideBottomLegacyControls);
    if ($debug) $debug.checked = Boolean(s.debugLog);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;

    if ($enabled) s.enabled = Boolean($enabled.checked);
    if ($mode) s.optimizationMode = ($mode.value === OPTIMIZATION_MODE_REMOVE)
      ? OPTIMIZATION_MODE_REMOVE : OPTIMIZATION_MODE_HIDE;
    if ($hideAdditional) s.hideAdditionalMatchingSources = Boolean($hideAdditional.checked);
    if ($hidePrimaryKeywords) s.hidePrimaryKeywords = Boolean($hidePrimaryKeywords.checked);
    if ($hideEntryLogic) s.hideEntryLogic = Boolean($hideEntryLogic.checked);
    if ($hideOptionalFilter) s.hideOptionalFilter = Boolean($hideOptionalFilter.checked);
    if ($hideCharacterFilter) s.hideCharacterOrTagFilter = Boolean($hideCharacterFilter.checked);
    if ($hideTriggersFilter) s.hideGenerationTriggersFilter = Boolean($hideTriggersFilter.checked);
    if ($hideScanDepth) s.hideScanDepth = Boolean($hideScanDepth.checked);
    if ($hideCaseSensitive) s.hideCaseSensitive = Boolean($hideCaseSensitive.checked);
    if ($hideMatchWholeWords) s.hideMatchWholeWords = Boolean($hideMatchWholeWords.checked);
    if ($hideUseGroupScoring) s.hideUseGroupScoring = Boolean($hideUseGroupScoring.checked);
    if ($hideAutomationId) s.hideAutomationId = Boolean($hideAutomationId.checked);
    if ($hideRecursionLevel) s.hideRecursionLevel = Boolean($hideRecursionLevel.checked);
    if ($hideInclusionGroup) s.hideInclusionGroup = Boolean($hideInclusionGroup.checked);
    if ($hideGroupWeight) s.hideGroupWeight = Boolean($hideGroupWeight.checked);
    if ($hideSticky) s.hideSticky = Boolean($hideSticky.checked);
    if ($hideCooldown) s.hideCooldown = Boolean($hideCooldown.checked);
    if ($hideDelay) s.hideDelay = Boolean($hideDelay.checked);
    if ($hideExcludeRecursion) s.hideExcludeRecursion = Boolean($hideExcludeRecursion.checked);
    if ($hidePreventRecursion) s.hidePreventRecursion = Boolean($hidePreventRecursion.checked);
    if ($hideDelayUntilRecursion) s.hideDelayUntilRecursion = Boolean($hideDelayUntilRecursion.checked);
    if ($hideIgnoreBudget) s.hideIgnoreBudget = Boolean($hideIgnoreBudget.checked);
    if ($hideBottom) s.hideBottomLegacyControls = Boolean($hideBottom.checked);
    if ($debug) s.debugLog = Boolean($debug.checked);

    STATE.settings = s;
    saveSettings(ctx);
    refreshRuntime();
    refreshUI();

    logDebug('settings changed', {
      enabled: s.enabled,
      optimizationMode: s.optimizationMode,
      hideAdditionalMatchingSources: s.hideAdditionalMatchingSources,
      hidePrimaryKeywords: s.hidePrimaryKeywords,
      hideEntryLogic: s.hideEntryLogic,
      hideOptionalFilter: s.hideOptionalFilter,
      hideCharacterOrTagFilter: s.hideCharacterOrTagFilter,
      hideGenerationTriggersFilter: s.hideGenerationTriggersFilter,
      hideScanDepth: s.hideScanDepth,
      hideCaseSensitive: s.hideCaseSensitive,
      hideMatchWholeWords: s.hideMatchWholeWords,
      hideUseGroupScoring: s.hideUseGroupScoring,
      hideAutomationId: s.hideAutomationId,
      hideRecursionLevel: s.hideRecursionLevel,
      hideInclusionGroup: s.hideInclusionGroup,
      hideGroupWeight: s.hideGroupWeight,
      hideSticky: s.hideSticky,
      hideCooldown: s.hideCooldown,
      hideDelay: s.hideDelay,
      hideExcludeRecursion: s.hideExcludeRecursion,
      hidePreventRecursion: s.hidePreventRecursion,
      hideDelayUntilRecursion: s.hideDelayUntilRecursion,
      hideIgnoreBudget: s.hideIgnoreBudget,
      hideBottomLegacyControls: s.hideBottomLegacyControls,
      debugLog: s.debugLog,
    });
  };

  [
    $enabled, $mode, $hideAdditional, $hidePrimaryKeywords, $hideEntryLogic, $hideOptionalFilter, $hideCharacterFilter, $hideTriggersFilter,
    $hideScanDepth, $hideCaseSensitive, $hideMatchWholeWords, $hideUseGroupScoring, $hideAutomationId, $hideRecursionLevel,
    $hideInclusionGroup, $hideGroupWeight, $hideSticky, $hideCooldown, $hideDelay,
    $hideExcludeRecursion, $hidePreventRecursion, $hideDelayUntilRecursion, $hideIgnoreBudget,
    $hideBottom, $debug,
  ]
    .forEach((el) => el?.addEventListener('change', onChange));
  refreshUI();

  return () => {
    [
      $enabled, $mode, $hideAdditional, $hidePrimaryKeywords, $hideEntryLogic, $hideOptionalFilter, $hideCharacterFilter, $hideTriggersFilter,
      $hideScanDepth, $hideCaseSensitive, $hideMatchWholeWords, $hideUseGroupScoring, $hideAutomationId, $hideRecursionLevel,
      $hideInclusionGroup, $hideGroupWeight, $hideSticky, $hideCooldown, $hideDelay,
      $hideExcludeRecursion, $hidePreventRecursion, $hideDelayUntilRecursion, $hideIgnoreBudget,
      $hideBottom, $debug,
    ]
      .forEach((el) => el?.removeEventListener('change', onChange));
  };
}

registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '简化 世界书条目 配置显示',
  order: 57,
  render: renderCocktailSettings,
});

async function init() {
  const ctx = getCtx();
  if (!ctx) return;

  STATE.ctx = ctx;
  STATE.settings = ensureExtensionSettings(ctx);
  refreshRuntime();
}

if (!_ALREADY_LOADED) {
  const boot = async () => {
    if (STATE.started) return;
    STATE.started = true;

    await init();

    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
    ctx?.eventSource?.on?.(ctx.eventTypes?.SETTINGS_LOADED, init);
  };

  if (globalThis.jQuery) {
    globalThis.jQuery(() => {
      void boot();
    });
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void boot();
    }, { once: true });
  } else {
    void boot();
  }
}
