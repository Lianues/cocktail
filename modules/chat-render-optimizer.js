/**
 * st-chat-render-optimizer
 * - 首屏分页：通过 power_user.chat_truncation 限制初次渲染条数
 * - 加载更多分帧：拦截 #show_more_messages 的事件，按 rAF 分批插入
 * - 禁用代码块高亮：屏蔽 window.hljs.highlightElement，避免性能浪费
 * - 设置面板：优先使用 st-api-wrapper 的 ST_API.ui.registerSettingsPanel
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-chat-render-optimizer';

// Keep in sync with folder name when you copy it into:
// public/scripts/extensions/third-party/<EXTENSION_NAME>/
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

const DEFAULT_SETTINGS = Object.freeze({
  initialRenderCount: 20,
  loadMoreBatchSize: 20,
  disableCodeHighlight: true,
  hideCodeBlocks: true,
  enableContentVisibility: false, // optional/experimental
  autoLoadMore: true,
  autoLoadThresholdPx: 400,
  autoLoadCooldownMs: 250,
});

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stChatRenderOptimizerLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stChatRenderOptimizerLoaded = true;
}

let _ctx = null;
let _settings = null;

let _hljsOriginal = null;
let _loadMoreInstalled = false;
let _isLoadingMore = false;
let _loadMoreBatchSize = DEFAULT_SETTINGS.loadMoreBatchSize;

let _autoLoadInstalled = false;
let _autoLoadRafPending = false;
let _autoLoadMoreEnabled = DEFAULT_SETTINGS.autoLoadMore;
let _autoLoadThresholdPx = DEFAULT_SETTINGS.autoLoadThresholdPx;
let _autoLoadCooldownMs = DEFAULT_SETTINGS.autoLoadCooldownMs;
let _lastAutoLoadTs = 0;
let _autoLoadChatEl = null;

let _topIntentInstalled = false;
let _touchStartY = null;

let _codeBlockClickToExpandInstalled = false;

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

  // Normalize types/ranges
  s.initialRenderCount = clampInt(s.initialRenderCount, 1, 1000, DEFAULT_SETTINGS.initialRenderCount);
  s.loadMoreBatchSize = clampInt(s.loadMoreBatchSize, 1, 500, DEFAULT_SETTINGS.loadMoreBatchSize);
  s.disableCodeHighlight = Boolean(s.disableCodeHighlight);
  s.hideCodeBlocks = Boolean(s.hideCodeBlocks);
  s.enableContentVisibility = Boolean(s.enableContentVisibility);
  s.autoLoadMore = Boolean(s.autoLoadMore);
  s.autoLoadThresholdPx = clampInt(s.autoLoadThresholdPx, 0, 10000, DEFAULT_SETTINGS.autoLoadThresholdPx);
  s.autoLoadCooldownMs = clampInt(s.autoLoadCooldownMs, 0, 10000, DEFAULT_SETTINGS.autoLoadCooldownMs);

  return s;
}

function saveSettings(ctx) {
  try {
    ctx?.saveSettingsDebounced?.();
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
  }
}

function applyChatTruncation(ctx, count) {
  if (!ctx?.powerUserSettings) return;
  ctx.powerUserSettings.chat_truncation = clampInt(count, 1, 1000, DEFAULT_SETTINGS.initialRenderCount);
}

function applyHideCodeBlocks(enable) {
  document.body.classList.toggle('st-cro-hide-code', Boolean(enable));
}

function applyContentVisibility(enable) {
  document.body.classList.toggle('st-cro-cv', Boolean(enable));
}

function installCodeBlockClickToExpand() {
  if (_codeBlockClickToExpandInstalled) return;

  const chatEl = document.getElementById('chat');
  if (!(chatEl instanceof HTMLElement)) {
    // Chat container might not exist yet; init() is called multiple times anyway.
    setTimeout(() => installCodeBlockClickToExpand(), 500);
    return;
  }

  const ensureCollapseButton = (pre) => {
    if (!(pre instanceof HTMLElement)) return;

    const codeEl = pre.querySelector('code');
    if (!(codeEl instanceof HTMLElement)) return;

    // Avoid duplicates
    if (codeEl.querySelector('.st-cro-code-collapse')) return;

    const btn = document.createElement('i');
    // Reuse SillyTavern's .code-copy styling; we only shift it to the left in our CSS.
    btn.classList.add('fa-solid', 'fa-chevron-up', 'code-copy', 'st-cro-code-collapse', 'interactable');
    btn.title = '收起代码块';
    btn.tabIndex = 0;

    const copyBtn = codeEl.querySelector('.code-copy:not(.st-cro-code-collapse)');
    if (copyBtn instanceof HTMLElement) {
      codeEl.insertBefore(btn, copyBtn);
    } else {
      codeEl.appendChild(btn);
    }

    const collapse = (ev) => {
      ev?.preventDefault?.();
      ev?.stopImmediatePropagation?.();
      ev?.stopPropagation?.();
      pre.classList.remove('st-cro-code-expanded');
      btn.remove();
    };

    btn.addEventListener('click', collapse);
    btn.addEventListener('keydown', (ev) => {
      if (!ev || typeof ev.key !== 'string') return;
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      collapse(ev);
    });
  };

  const onClick = (e) => {
    if (!document.body.classList.contains('st-cro-hide-code')) return;
    const target = e?.target;
    if (!(target instanceof Element)) return;

    const pre = target.closest('#chat .mes_text pre, #chat .mes_reasoning pre');
    if (!(pre instanceof HTMLElement)) return;
    if (pre.classList.contains('st-cro-code-expanded')) return; // one-way expand (avoid interfering with selection/copy)

    pre.classList.add('st-cro-code-expanded');
    ensureCollapseButton(pre);
  };

  chatEl.addEventListener('click', onClick);
  _codeBlockClickToExpandInstalled = true;
}

function patchHljs(disableHighlight) {
  const hljs = globalThis.hljs;
  if (!hljs) return;

  // snapshot original only once
  if (!_hljsOriginal) {
    _hljsOriginal = {
      highlightElement: typeof hljs.highlightElement === 'function' ? hljs.highlightElement : null,
      highlightAll: typeof hljs.highlightAll === 'function' ? hljs.highlightAll : null,
      highlightBlock: typeof hljs.highlightBlock === 'function' ? hljs.highlightBlock : null,
    };
  }

  if (disableHighlight) {
    if (typeof hljs.highlightElement === 'function') hljs.highlightElement = () => { };
    if (typeof hljs.highlightAll === 'function') hljs.highlightAll = () => { };
    if (typeof hljs.highlightBlock === 'function') hljs.highlightBlock = () => { };
  } else {
    if (_hljsOriginal.highlightElement) hljs.highlightElement = _hljsOriginal.highlightElement;
    if (_hljsOriginal.highlightAll) hljs.highlightAll = _hljsOriginal.highlightAll;
    if (_hljsOriginal.highlightBlock) hljs.highlightBlock = _hljsOriginal.highlightBlock;
  }
}

// NOTE:
// For “load older messages” we *do* want to preserve the current viewport position.
// We do it by temporarily disabling native scroll anchoring (overflow-anchor) and then compensating
// scrollTop by the added scrollHeight per frame. This avoids “double compensation” flicker.

function installLoadMoreOverride(ctx) {
  if (_loadMoreInstalled) return;
  if (!globalThis.jQuery) {
    console.warn(`[${EXTENSION_NAME}] jQuery not found; cannot override show_more_messages handler`);
    return;
  }

  // Remove the built-in handler that loads a large while-loop batch.
  // Note: This may also remove other handlers for the same selector; in practice it is a single built-in handler.
  globalThis.jQuery(document).off('mouseup touchend', '#show_more_messages');

  // Install our chunked handler (namespaced to avoid duplicates)
  globalThis.jQuery(document).on('mouseup.stcro touchend.stcro', '#show_more_messages', async function (event) {
    try {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      event?.stopPropagation?.();
      await loadMoreChunked(ctx);
    } catch (e) {
      console.error(`[${EXTENSION_NAME}] loadMoreChunked failed`, e);
    }
  });

  _loadMoreInstalled = true;
}

function installAutoLoadScrollTrigger(ctx) {
  if (_autoLoadInstalled) return;

  const chatEl = document.getElementById('chat');
  if (!(chatEl instanceof HTMLElement)) {
    // Chat container might not exist yet; init() is called multiple times anyway.
    setTimeout(() => installAutoLoadScrollTrigger(ctx), 500);
    return;
  }

  _autoLoadChatEl = chatEl;

  const maybeTrigger = () => {
    if (!_autoLoadMoreEnabled) return;
    if (_isLoadingMore) return;
    if (!document.getElementById('show_more_messages')) return;
    if (!(_autoLoadChatEl instanceof HTMLElement)) return;

    if (_autoLoadChatEl.scrollTop > _autoLoadThresholdPx) return;

    const now = Date.now();
    if (_autoLoadCooldownMs > 0 && (now - _lastAutoLoadTs) < _autoLoadCooldownMs) return;
    _lastAutoLoadTs = now;
    void loadMoreChunked(ctx);
  };

  const onScroll = () => {
    if (!_autoLoadMoreEnabled) return;
    if (_autoLoadRafPending) return;
    _autoLoadRafPending = true;
    requestAnimationFrame(() => {
      _autoLoadRafPending = false;
      maybeTrigger();
    });
  };

  chatEl.addEventListener('scroll', onScroll, { passive: true });
  _autoLoadInstalled = true;

  // In case the user starts near the top (rare), run once.
  onScroll();
}

function installTopIntentLoadMore(ctx) {
  if (_topIntentInstalled) return;

  const chatEl = document.getElementById('chat');
  if (!(chatEl instanceof HTMLElement)) {
    setTimeout(() => installTopIntentLoadMore(ctx), 500);
    return;
  }

  const canTrigger = () => {
    if (_isLoadingMore) return false;
    if (!document.getElementById('show_more_messages')) return false;
    if (chatEl.scrollTop > 0) return false; // must already be at top
    const now = Date.now();
    if (_autoLoadCooldownMs > 0 && (now - _lastAutoLoadTs) < _autoLoadCooldownMs) return false;
    _lastAutoLoadTs = now;
    return true;
  };

  // Desktop: when already at top, wheel up again means “load more”.
  const onWheel = (e) => {
    // deltaY < 0: user scrolls up (towards older messages)
    if (!(e instanceof WheelEvent)) return;
    if (e.deltaY >= 0) return;
    if (!canTrigger()) return;
    void loadMoreChunked(ctx);
  };

  // Mobile/touch: when already at top, pull down again means “load more”.
  const onTouchStart = (e) => {
    if (!(e instanceof TouchEvent)) return;
    if (!e.touches || e.touches.length === 0) return;
    _touchStartY = e.touches[0].clientY;
  };

  const onTouchMove = (e) => {
    if (!(e instanceof TouchEvent)) return;
    if (_touchStartY === null) return;
    if (!e.touches || e.touches.length === 0) return;
    const y = e.touches[0].clientY;
    const dy = y - _touchStartY;

    // To scroll further up at top, user typically pulls down (dy > 0).
    if (dy < 18) return;
    if (!canTrigger()) return;

    // Reset so one pull triggers once
    _touchStartY = y;
    void loadMoreChunked(ctx);
  };

  const onTouchEnd = () => {
    _touchStartY = null;
  };

  chatEl.addEventListener('wheel', onWheel, { passive: true });
  chatEl.addEventListener('touchstart', onTouchStart, { passive: true });
  chatEl.addEventListener('touchmove', onTouchMove, { passive: true });
  chatEl.addEventListener('touchend', onTouchEnd, { passive: true });
  chatEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

  _topIntentInstalled = true;
}

function insertMessagesInRafChunks(ctx, messageIdStart, totalToInsert, perFrame = 3, chatEl = null, preserveViewport = true) {
  return new Promise((resolve) => {
    let messageId = messageIdStart;
    let remaining = totalToInsert;
    let inserted = 0;

    const step = () => {
      const prevHeight = (preserveViewport && chatEl instanceof HTMLElement) ? chatEl.scrollHeight : 0;
      let processed = 0;
      while (messageId > 0 && remaining > 0 && processed < perFrame) {
        const newMessageId = messageId - 1;

        // Same logic as core showMoreMessages(): insert before current messageId.
        ctx.addOneMessage(ctx.chat[newMessageId], {
          insertBefore: messageId >= ctx.chat.length ? null : messageId,
          scroll: false,
          forceId: newMessageId,
          showSwipes: false,
        });

        remaining--;
        messageId--;
        inserted++;
        processed++;
      }

      if (preserveViewport && chatEl instanceof HTMLElement) {
        const delta = chatEl.scrollHeight - prevHeight;
        if (delta) {
          chatEl.scrollTop += delta;
        }
      }

      if (messageId <= 0 || remaining <= 0) {
        resolve({ finalMessageId: messageId, inserted });
        return;
      }

      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  });
}

async function loadMoreChunked(ctx) {
  if (_isLoadingMore) return;
  if (!ctx?.chat || typeof ctx.addOneMessage !== 'function') return;
  if (!globalThis.jQuery) return;

  _isLoadingMore = true;
  const prevAutoScroll = (ctx?.powerUserSettings && typeof ctx.powerUserSettings.auto_scroll_chat_to_bottom === 'boolean')
    ? ctx.powerUserSettings.auto_scroll_chat_to_bottom
    : undefined;
  /** @type {HTMLElement|null} */
  let chatEl = null;
  /** @type {string|null} */
  let prevOverflowAnchor = null;
  try {
    // Prevent any code path from scrolling to bottom during backfill.
    if (prevAutoScroll !== undefined) {
      ctx.powerUserSettings.auto_scroll_chat_to_bottom = false;
    }

    const $ = globalThis.jQuery;
    const chatElement = $('#chat');
    if (!chatElement.length) return;
    chatEl = chatElement.get(0);
    if (!(chatEl instanceof HTMLElement)) return;
    prevOverflowAnchor = chatEl.style.overflowAnchor;
    // Disable native scroll anchoring while we manually compensate scrollTop.
    chatEl.style.overflowAnchor = 'none';

    const firstDisplayedMesIdStr = chatElement.children('.mes').first().attr('mesid');
    let messageId = Number(firstDisplayedMesIdStr);
    if (Number.isNaN(messageId)) {
      // one higher than last message id (same intent as core code)
      messageId = ctx.chat.length;
    }

    const batchSize = clampInt(_loadMoreBatchSize, 1, 500, DEFAULT_SETTINGS.loadMoreBatchSize);
    const { finalMessageId } = await insertMessagesInRafChunks(ctx, messageId, batchSize, 3, chatEl, true);

    // Do one global refresh after the batch.
    try {
      ctx?.swipe?.refresh?.(false, false);
    } catch { }

    if (finalMessageId <= 0) {
      $('#show_more_messages').remove();
    }

    // Keep compatibility with other code listening to this event
    try {
      if (ctx?.eventSource?.emit && ctx?.eventTypes?.MORE_MESSAGES_LOADED) {
        await ctx.eventSource.emit(ctx.eventTypes.MORE_MESSAGES_LOADED);
      }
    } catch { }

    // addOneMessage()/showMoreMessages() do not emit per-message rendered/updated events.
    // Emit one MESSAGE_UPDATED so renderers (e.g. JS-Slash-Runner) can re-scan newly inserted messages.
    try {
      if (ctx?.eventSource?.emit && ctx?.eventTypes?.MESSAGE_UPDATED) {
        void ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, finalMessageId);
      }
    } catch { }
  } finally {
    // Always restore overflow-anchor.
    if (chatEl instanceof HTMLElement && prevOverflowAnchor !== null) {
      chatEl.style.overflowAnchor = prevOverflowAnchor;
    }
    if (prevAutoScroll !== undefined) {
      ctx.powerUserSettings.auto_scroll_chat_to_bottom = prevAutoScroll;
    }
    _isLoadingMore = false;
  }
}

async function registerSettingsPanel(ctx) {
  const ST_API = globalThis.ST_API;
  if (!ST_API?.ui?.registerSettingsPanel) return false;

  // Avoid double registration
  const PANEL_CONTAINER_ID = 'st-cro-settings-root';
  if (document.getElementById(PANEL_CONTAINER_ID)) return true;

  try {
    await ST_API.ui.registerSettingsPanel({
      id: `${EXTENSION_NAME}.settings`,
      title: '聊天渲染优化',
      target: 'right',
      expanded: false,
      order: 50,
      content: {
        kind: 'render',
        render: (container) => {
          const root = document.createElement('div');
          root.id = PANEL_CONTAINER_ID;
          root.className = 'st-cro-panel';
          root.innerHTML = `
            <div class="st-cro-row">
              <label>
                首屏渲染条数
                <input id="st_cro_initialRenderCount" type="number" min="1" max="1000" step="1">
              </label>
              <label>
                加载更多每批
                <input id="st_cro_loadMoreBatchSize" type="number" min="1" max="500" step="1">
              </label>
            </div>
            <div class="st-cro-row">
              <label>
                <input id="st_cro_autoLoadMore" type="checkbox">
                提前无感预加载
              </label>
              <label>
                提前触发(px)
                <input id="st_cro_autoLoadThresholdPx" type="number" min="0" max="10000" step="50">
              </label>
            </div>
            <div class="st-cro-row">
              <label>
                <input id="st_cro_hideCodeBlocks" type="checkbox">
                隐藏代码块（占位符）
              </label>
              <label>
                <input id="st_cro_disableCodeHighlight" type="checkbox">
                禁用代码块高亮（推荐）
              </label>
              <label>
                <input id="st_cro_enableContentVisibility" type="checkbox">
                开启 content-visibility（实验）
              </label>
            </div>
            <div class="st-cro-row">
              <button id="st_cro_reloadChat" class="menu_button">应用并重载聊天</button>
            </div>
            <div class="st-cro-help">
              <div>说明：</div>
              <div>- “首屏渲染条数”通过修改 <code>power_user.chat_truncation</code> 生效。</div>
              <div>- “提前无感预加载”：上滑接近顶部（提前触发阈值内）会自动分批加载，无需点击。关闭后不会提前加载。</div>
              <div>- 手势：当你已经到达顶部，再继续往上滚动/上拉一次，会触发“加载更多”（无需点击按钮）。</div>
              <div>- “加载更多每批”会把顶部“Show more messages”改为分帧分批插入，减少冻结；按钮仍可点击作为备用。</div>
              <div>- “禁用代码块高亮”会屏蔽 <code>hljs.highlightElement</code>，代码块仍可显示/复制。</div>
              <div>- “隐藏代码块”：不直接显示 <code>&lt;pre&gt;&lt;code&gt;</code> 内容，改为显示占位符（点击占位符可展开原代码块），并同时隐藏复制按钮。</div>
              <div>- “content-visibility” 是浏览器的 CSS 性能优化：离开视口的消息会跳过布局/绘制，聊天很长时更流畅；主要在 Chromium / 酒馆桌面端有效，若出现显示/滚动异常请关闭。</div>
            </div>
          `;

          container.appendChild(root);

          const $initial = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_initialRenderCount'));
          const $batch = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_loadMoreBatchSize'));
          const $autoLoad = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_autoLoadMore'));
          const $threshold = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_autoLoadThresholdPx'));
          const $hideCode = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_hideCodeBlocks'));
          const $disableHl = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_disableCodeHighlight'));
          const $cv = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_enableContentVisibility'));
          const $reload = /** @type {HTMLButtonElement|null} */ (root.querySelector('#st_cro_reloadChat'));

          const refreshUI = () => {
            const s = ensureExtensionSettings(ctx);
            if (!s) return;
            _settings = s;
            if ($initial) $initial.value = String(s.initialRenderCount);
            if ($batch) $batch.value = String(s.loadMoreBatchSize);
            if ($autoLoad) $autoLoad.checked = Boolean(s.autoLoadMore);
            if ($threshold) $threshold.value = String(s.autoLoadThresholdPx);
            if ($hideCode) $hideCode.checked = Boolean(s.hideCodeBlocks);
            if ($disableHl) $disableHl.checked = Boolean(s.disableCodeHighlight);
            if ($cv) $cv.checked = Boolean(s.enableContentVisibility);
          };

          const onChange = () => {
            const s = ensureExtensionSettings(ctx);
            if (!s) return;
            if ($initial) s.initialRenderCount = clampInt($initial.value, 1, 1000, DEFAULT_SETTINGS.initialRenderCount);
            if ($batch) s.loadMoreBatchSize = clampInt($batch.value, 1, 500, DEFAULT_SETTINGS.loadMoreBatchSize);
            if ($autoLoad) s.autoLoadMore = Boolean($autoLoad.checked);
            if ($threshold) s.autoLoadThresholdPx = clampInt($threshold.value, 0, 10000, DEFAULT_SETTINGS.autoLoadThresholdPx);
            if ($hideCode) s.hideCodeBlocks = Boolean($hideCode.checked);
            if ($disableHl) s.disableCodeHighlight = Boolean($disableHl.checked);
            if ($cv) s.enableContentVisibility = Boolean($cv.checked);

            // apply immediately (reload needed for initial render count to affect already-rendered chat)
            _loadMoreBatchSize = s.loadMoreBatchSize;
            _autoLoadMoreEnabled = s.autoLoadMore;
            _autoLoadThresholdPx = s.autoLoadThresholdPx;
            patchHljs(s.disableCodeHighlight);
            applyHideCodeBlocks(s.hideCodeBlocks);
            applyContentVisibility(s.enableContentVisibility);
            applyChatTruncation(ctx, s.initialRenderCount);
            installAutoLoadScrollTrigger(ctx);
            installTopIntentLoadMore(ctx);

            saveSettings(ctx);
            refreshUI();
          };

          const onReload = async () => {
            // best effort: reload chat UI so truncation is applied immediately
            try {
              if (globalThis.ST_API?.ui?.reloadChat) {
                await globalThis.ST_API.ui.reloadChat();
              } else {
                await ctx?.reloadCurrentChat?.();
              }
            } catch (e) {
              console.warn(`[${EXTENSION_NAME}] reloadChat failed`, e);
            }
          };

          $initial?.addEventListener('change', onChange);
          $batch?.addEventListener('change', onChange);
          $autoLoad?.addEventListener('change', onChange);
          $threshold?.addEventListener('change', onChange);
          $hideCode?.addEventListener('change', onChange);
          $disableHl?.addEventListener('change', onChange);
          $cv?.addEventListener('change', onChange);
          $reload?.addEventListener('click', onReload);

          refreshUI();

          return () => {
            $initial?.removeEventListener('change', onChange);
            $batch?.removeEventListener('change', onChange);
            $autoLoad?.removeEventListener('change', onChange);
            $threshold?.removeEventListener('change', onChange);
            $hideCode?.removeEventListener('change', onChange);
            $disableHl?.removeEventListener('change', onChange);
            $cv?.removeEventListener('change', onChange);
            $reload?.removeEventListener('click', onReload);
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

function applyAll(ctx, s) {
  _loadMoreBatchSize = s.loadMoreBatchSize;
  _autoLoadMoreEnabled = Boolean(s.autoLoadMore);
  _autoLoadThresholdPx = s.autoLoadThresholdPx;
  _autoLoadCooldownMs = s.autoLoadCooldownMs;
  patchHljs(s.disableCodeHighlight);
  applyHideCodeBlocks(s.hideCodeBlocks);
  applyContentVisibility(s.enableContentVisibility);
  applyChatTruncation(ctx, s.initialRenderCount);
  installLoadMoreOverride(ctx);
  installAutoLoadScrollTrigger(ctx);
  installTopIntentLoadMore(ctx);
  installCodeBlockClickToExpand();
}

async function init() {
  const ctx = getCtx();
  if (!ctx) return;

  _ctx = ctx;
  const s = ensureExtensionSettings(ctx);
  if (!s) return;
  _settings = s;

  applyAll(ctx, s);

  // Optional: expose a tiny debug handle
  globalThis.__stChatRenderOptimizer = {
    version: '0.1.0',
    extensionName: EXTENSION_NAME,
    folderPath: EXTENSION_FOLDER_PATH,
    get settings() { return _settings; },
    apply: () => _ctx && _settings && applyAll(_ctx, _settings),
  };
}

function renderCocktailSettings(container, ctx) {
  const root = document.createElement('div');
  root.className = 'cocktail-form';
  root.innerHTML = `
    <div class="cocktail-grid">
      <label class="cocktail-field">
        <span class="cocktail-label">首屏渲染条数</span>
        <input id="st_cro_initialRenderCount" type="number" min="1" max="1000" step="1">
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">加载更多每批</span>
        <input id="st_cro_loadMoreBatchSize" type="number" min="1" max="500" step="1">
      </label>

      <label class="cocktail-check">
        <input id="st_cro_autoLoadMore" type="checkbox">
        提前无感预加载
      </label>

      <label class="cocktail-field">
        <span class="cocktail-label">提前触发(px)</span>
        <input id="st_cro_autoLoadThresholdPx" type="number" min="0" max="10000" step="50">
      </label>

      <label class="cocktail-check">
        <input id="st_cro_hideCodeBlocks" type="checkbox">
        隐藏代码块（占位符）
      </label>

      <label class="cocktail-check">
        <input id="st_cro_disableCodeHighlight" type="checkbox">
        禁用代码块高亮（推荐）
      </label>

      <label class="cocktail-check">
        <input id="st_cro_enableContentVisibility" type="checkbox">
        开启 content-visibility（实验）
      </label>
    </div>

    <div class="cocktail-actions">
      <button id="st_cro_reloadChat" type="button" class="cocktail-btn">应用并重载聊天</button>
    </div>

    <div class="cocktail-help">
      <div>说明：</div>
      <div>- “首屏渲染条数”通过修改 <code>power_user.chat_truncation</code> 生效。</div>
      <div>- “加载更多每批”：把插入旧消息拆成多帧，减少卡顿。</div>
      <div>- “禁用代码块高亮”会屏蔽 <code>hljs.highlightElement</code>，代码块仍可显示/复制。</div>
      <div>- “隐藏代码块”：会显示占位符；点击占位符可展开原代码块。</div>
    </div>
  `;

  container.appendChild(root);

  const $initial = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_initialRenderCount'));
  const $batch = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_loadMoreBatchSize'));
  const $autoLoad = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_autoLoadMore'));
  const $threshold = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_autoLoadThresholdPx'));
  const $hideCode = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_hideCodeBlocks'));
  const $disableHl = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_disableCodeHighlight'));
  const $cv = /** @type {HTMLInputElement|null} */ (root.querySelector('#st_cro_enableContentVisibility'));
  const $reload = /** @type {HTMLButtonElement|null} */ (root.querySelector('#st_cro_reloadChat'));

  const refreshUI = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    _settings = s;
    if ($initial) $initial.value = String(s.initialRenderCount);
    if ($batch) $batch.value = String(s.loadMoreBatchSize);
    if ($autoLoad) $autoLoad.checked = Boolean(s.autoLoadMore);
    if ($threshold) $threshold.value = String(s.autoLoadThresholdPx);
    if ($hideCode) $hideCode.checked = Boolean(s.hideCodeBlocks);
    if ($disableHl) $disableHl.checked = Boolean(s.disableCodeHighlight);
    if ($cv) $cv.checked = Boolean(s.enableContentVisibility);
  };

  const onChange = () => {
    const s = ensureExtensionSettings(ctx);
    if (!s) return;
    if ($initial) s.initialRenderCount = clampInt($initial.value, 1, 1000, DEFAULT_SETTINGS.initialRenderCount);
    if ($batch) s.loadMoreBatchSize = clampInt($batch.value, 1, 500, DEFAULT_SETTINGS.loadMoreBatchSize);
    if ($autoLoad) s.autoLoadMore = Boolean($autoLoad.checked);
    if ($threshold) s.autoLoadThresholdPx = clampInt($threshold.value, 0, 10000, DEFAULT_SETTINGS.autoLoadThresholdPx);
    if ($hideCode) s.hideCodeBlocks = Boolean($hideCode.checked);
    if ($disableHl) s.disableCodeHighlight = Boolean($disableHl.checked);
    if ($cv) s.enableContentVisibility = Boolean($cv.checked);

    _settings = s;
    applyAll(ctx, s);
    saveSettings(ctx);
    refreshUI();
  };

  const onReload = async () => {
    try {
      await ctx?.reloadCurrentChat?.();
    } catch (e) {
      console.warn(`[${EXTENSION_NAME}] reloadChat failed`, e);
    }
  };

  $initial?.addEventListener('change', onChange);
  $batch?.addEventListener('change', onChange);
  $autoLoad?.addEventListener('change', onChange);
  $threshold?.addEventListener('change', onChange);
  $hideCode?.addEventListener('change', onChange);
  $disableHl?.addEventListener('change', onChange);
  $cv?.addEventListener('change', onChange);
  $reload?.addEventListener('click', onReload);

  refreshUI();

  return () => {
    $initial?.removeEventListener('change', onChange);
    $batch?.removeEventListener('change', onChange);
    $autoLoad?.removeEventListener('change', onChange);
    $threshold?.removeEventListener('change', onChange);
    $hideCode?.removeEventListener('change', onChange);
    $disableHl?.removeEventListener('change', onChange);
    $cv?.removeEventListener('change', onChange);
    $reload?.removeEventListener('click', onReload);
  };
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
  id: EXTENSION_NAME,
  title: '聊天渲染优化',
  order: 20,
  render: renderCocktailSettings,
});

// Run on DOM ready, and also on APP_READY (some environments delay init)
if (!_ALREADY_LOADED) {
  globalThis.jQuery?.(async () => {
    await init();
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
  });
}

