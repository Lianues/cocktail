/**
 * st-cocktail（鸡尾酒 综合优化）
 *
 * 合并以下三个前端扩展的功能：
 * - st-startup-optimizer
 * - st-chat-render-optimizer
 * - st-regex-refresh-optimizer
 *
 * 同时：不再依赖 st-api-wrapper 插件本身。
 * - 直接内置其“设置面板注册 / 刷新”相关实现（底层依赖仅为 ST 的 DOM + getContext + eventSource）。
 */

const COCKTAIL_EXTENSION_NAME = 'st-cocktail';

// Avoid double-install (some reload flows can evaluate modules twice)
if (globalThis.__stCocktailLoaded) {
  console.debug(`[${COCKTAIL_EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stCocktailLoaded = true;

  function getCtx() {
    return globalThis.SillyTavern?.getContext?.();
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ============================================================================
  // Minimal UI helpers (derived from st-api-wrapper/src/apis/ui/impl.ts)
  // ============================================================================

  const CocktailUI = (() => {
    /** @type {Map<string, { cleanup?: () => void }>} */
    const panels = new Map();

    /**
     * @param {any} target
     */
    function resolveTargetSelector(target) {
      if (target === 'left' || target === 'extensions_settings') return '#extensions_settings';
      if (target === 'right' || target === 'extensions_settings2') return '#extensions_settings2';
      return target || '#extensions_settings2';
    }

    /**
     * 等待或检查 APP_READY（只做最小等待，避免过度阻塞）
     */
    async function waitAppReady() {
      const ctx = getCtx();
      if (!ctx) return;

      const eventSource = ctx.eventSource;
      const eventTypes = ctx.event_types || ctx.eventTypes;

      if (document.getElementById('extensions_settings') || document.getElementById('extensions_settings2')) {
        return;
      }

      return new Promise((resolve) => {
        const done = () => {
          try { eventSource?.removeListener?.(eventTypes?.APP_READY, done); } catch { }
          resolve();
        };
        try { eventSource?.on?.(eventTypes?.APP_READY, done); } catch { resolve(); return; }
        setTimeout(done, 5000);
      });
    }

    /**
     * @param {string} input
     */
    function sanitizeForId(input) {
      return String(input).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * @param {HTMLElement} header
     * @param {HTMLElement} content
     * @param {boolean} expanded
     */
    function applyInitialState(header, content, expanded) {
      const icon = header.querySelector('.inline-drawer-icon');
      if (expanded) {
        content.style.display = 'block';
        icon?.classList.replace('down', 'up');
        icon?.classList.replace('fa-circle-chevron-down', 'fa-circle-chevron-up');
      } else {
        content.style.display = 'none';
        icon?.classList.replace('up', 'down');
        icon?.classList.replace('fa-circle-chevron-up', 'fa-circle-chevron-down');
      }
    }

    /**
     * @typedef {{ kind: 'html', html: string } | { kind: 'htmlTemplate', html: string, extractSelector?: string } | { kind: 'element', element: HTMLElement } | { kind: 'render', render: (container: HTMLElement) => (void | (() => void) | Promise<void | (() => void)>) }} PanelContent
     */

    /**
     * @param {{
     *  id: string;
     *  title: string;
     *  target?: 'left'|'right'|'extensions_settings'|'extensions_settings2'|string;
     *  expanded?: boolean;
     *  order?: number;
     *  index?: number;
     *  className?: string;
     *  content: PanelContent;
     * }} input
     */
    async function registerSettingsPanel(input) {
      await waitAppReady();

      const targetSelector = resolveTargetSelector(input.target);
      /** @type {HTMLElement|null} */
      const targetEl = document.querySelector(targetSelector);
      if (!targetEl) throw new Error(`Target not found: ${targetSelector}`);

      const containerId = `${sanitizeForId(input.id)}_container`;
      if (document.getElementById(containerId)) {
        throw new Error(`Panel ID already registered: ${input.id}`);
      }

      const wrapper = document.createElement('div');
      wrapper.id = containerId;
      wrapper.className = `extension_container st-cocktail-panel-wrapper ${input.className ?? ''}`.trim();
      wrapper.dataset.order = String(input.order ?? 0);

      const drawer = document.createElement('div');
      drawer.className = 'inline-drawer st-cocktail-drawer';

      const header = document.createElement('div');
      header.className = 'inline-drawer-toggle inline-drawer-header';
      header.innerHTML = `<b>${input.title}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>`;

      const content = document.createElement('div');
      content.className = 'inline-drawer-content';

      drawer.appendChild(header);
      drawer.appendChild(content);
      wrapper.appendChild(drawer);

      if (typeof input.index === 'number' && input.index >= 0 && input.index < targetEl.children.length) {
        targetEl.insertBefore(wrapper, targetEl.children[input.index]);
      } else {
        targetEl.appendChild(wrapper);
      }

      if (input.content.kind === 'html') {
        content.innerHTML = input.content.html;
      } else if (input.content.kind === 'htmlTemplate') {
        const frag = document.createRange().createContextualFragment(input.content.html);
        const extracted = frag.querySelector(input.content.extractSelector || '.inline-drawer-content');
        content.innerHTML = extracted ? extracted.innerHTML : input.content.html;
      } else if (input.content.kind === 'element') {
        content.appendChild(input.content.element);
      } else if (input.content.kind === 'render') {
        const cleanup = await input.content.render(content);
        panels.set(input.id, { cleanup: typeof cleanup === 'function' ? cleanup : undefined });
      }

      applyInitialState(header, content, !!input.expanded);
      return { id: input.id, containerId, drawer, content };
    }

    /**
     * @param {{ id: string }} input
     */
    async function unregisterSettingsPanel(input) {
      const containerId = `${sanitizeForId(input.id)}_container`;
      const el = document.getElementById(containerId);
      if (el) el.remove();
      const rec = panels.get(input.id);
      if (rec?.cleanup) rec.cleanup();
      panels.delete(input.id);
      return { ok: true };
    }

    /**
     * 重载当前聊天界面
     */
    async function reloadChat() {
      const ctx = getCtx();
      if (ctx?.reloadCurrentChat) {
        await ctx.reloadCurrentChat();
        return { ok: true };
      }
      return { ok: false };
    }

    /**
     * 重载设置界面 (保存并尝试刷新 UI)
     */
    async function reloadSettings() {
      const ctx = getCtx();
      if (!ctx) return { ok: false };

      try { ctx.saveSettingsDebounced?.(); } catch { }

      try {
        if (ctx.eventSource && ctx.eventTypes) {
          const { eventSource, eventTypes } = ctx;
          eventSource.emit(eventTypes.PRESET_CHANGED);
          eventSource.emit(eventTypes.SETTINGS_LOADED);
        } else if (ctx.eventSource && ctx.event_types) {
          const { eventSource, event_types } = ctx;
          eventSource.emit(event_types.PRESET_CHANGED);
          eventSource.emit(event_types.SETTINGS_LOADED);
        }
      } catch { }

      return { ok: true };
    }

    return {
      registerSettingsPanel,
      unregisterSettingsPanel,
      reloadChat,
      reloadSettings,
    };
  })();

  // ============================================================================
  // Module: st-chat-render-optimizer (mostly unchanged)
  // ============================================================================

  const ChatRenderOptimizer = (() => {
    /**
     * st-chat-render-optimizer
     * - 首屏分页：通过 power_user.chat_truncation 限制初次渲染条数
     * - 加载更多分帧：拦截 #show_more_messages 的事件，按 rAF 分批插入
     * - 禁用代码块高亮：屏蔽 window.hljs.highlightElement，避免性能浪费
     */

    const EXTENSION_NAME = 'st-chat-render-optimizer';
    const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${COCKTAIL_EXTENSION_NAME}`;

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

    function clampInt(value, min, max, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const i = Math.trunc(n);
      if (i < min) return min;
      if (i > max) return max;
      return i;
    }

    function getStCtx() {
      return getCtx();
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

    async function registerSettingsPanel(ctx, targetOverride) {
      const PANEL_CONTAINER_ID = 'st-cro-settings-root';
      if (document.getElementById(PANEL_CONTAINER_ID)) return true;

      try {
        await CocktailUI.registerSettingsPanel({
          id: `${EXTENSION_NAME}.settings`,
          title: '聊天渲染优化',
          target: targetOverride ?? 'right',
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
                  <div>- “隐藏代码块”：不直接显示 <code>&lt;pre&gt;&lt;code&gt;</code> 内容，改为显示小占位符，并同时隐藏复制按钮。</div>
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
                  const res = await CocktailUI.reloadChat();
                  if (!res?.ok) {
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
    }

    async function init() {
      const ctx = getStCtx();
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
        registerPanel: (target) => _ctx && registerSettingsPanel(_ctx, target),
      };
    }

    // Run on DOM ready, and also on APP_READY (some environments delay init)
    if (!_ALREADY_LOADED) {
      globalThis.jQuery?.(async () => {
        await init();
        const ctx = getStCtx();
        ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
      });
    }

    return {
      name: EXTENSION_NAME,
      registerSettingsPanel,
    };
  })();

  // ============================================================================
  // Module: st-regex-refresh-optimizer (mostly unchanged, wrapper removed)
  // ============================================================================

  const RegexRefreshOptimizer = (() => {
    /**
     * st-regex-refresh-optimizer
     *
     * 目标：
     * - 在 Regex 配置面板展开期间不刷新聊天
     * - 面板收起/隐藏时才统一刷新一次聊天（默认分帧增量重渲染）
     */

    const EXTENSION_NAME = 'st-regex-refresh-optimizer';
    const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${COCKTAIL_EXTENSION_NAME}`;

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

    function getStCtx() {
      return getCtx();
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
          _engine = mod;
          return mod;
        } catch (e) {
          console.warn(`[${EXTENSION_NAME}] Regex engine import failed`, e);
          _engine = null;
          _enginePromise = null; // allow retry
          return null;
        }
      })();

      return _enginePromise;
    }

    function getRegexContainer() {
      return document.getElementById('regex_container');
    }

    function getExtensionsDrawer() {
      // 新版 UI：扩展设置抽屉容器（openDrawer/closedDrawer）
      return document.getElementById('rm_extensions_block');
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
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
      try {
        const Popup = ctx?.Popup;
        if (Popup?.show?.confirm) {
          return await Popup.show.confirm(title, message);
        }
      } catch { }
      return globalThis.confirm?.(`${title}\n\n${message}`) ?? true;
    }

    async function deleteScriptsByIds(idsByType) {
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
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
      const ctx = _ctx || getStCtx();
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
            saveSettings(_ctx || getStCtx());
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

    async function registerSettingsPanel(ctx, targetOverride) {
      const PANEL_CONTAINER_ID = 'st-rro-settings-root';
      if (document.getElementById(PANEL_CONTAINER_ID)) return true;

      try {
        await CocktailUI.registerSettingsPanel({
          id: `${EXTENSION_NAME}.settings`,
          title: '正则刷新优化',
          target: targetOverride ?? 'right',
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

    async function init() {
      const ctx = getStCtx();
      if (!ctx) return;
      _ctx = ctx;

      const s = ensureExtensionSettings(ctx);
      if (!s) return;
      _settings = s;

      // Preload regex engine; if it fails, do not intercept anything (but allow retries later).
      const engine = await importRegexEngine();
      if (!engine) {
        console.warn(`[${EXTENSION_NAME}] Regex engine unavailable; extension will retry on APP_READY`);
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
        registerPanel: (target) => _ctx && registerSettingsPanel(_ctx, target),
      };
    }

    if (!_ALREADY_LOADED) {
      globalThis.jQuery?.(async () => {
        await init();
        const ctx = getStCtx();
        ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, init);
      });
    }

    return {
      name: EXTENSION_NAME,
      registerSettingsPanel,
    };
  })();

  // ============================================================================
  // Module: st-startup-optimizer (mostly unchanged, wrapper removed)
  // ============================================================================

  const StartupOptimizer = (() => {
    /**
     * st-startup-optimizer
     * - 不改源代码，通过扩展改善“启动到主界面”体验
     * - 提前解除遮罩（SETTINGS_LOADED 后 hideLoader）
     * - 提示必做：toast + 角标
     * - 预取 + 复用：/api/avatars/get、/api/characters/all、/api/backgrounds/all
     */

    const EXTENSION_NAME = 'st-startup-optimizer';

    // Avoid double-install (some reload flows can evaluate modules twice)
    if (globalThis.__stStartupOptimizerLoaded) {
      console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
      return {
        name: EXTENSION_NAME,
        registerSettingsPanel: async () => false,
      };
    }
    globalThis.__stStartupOptimizerLoaded = true;

    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      earlyHideLoader: true,
      hintToast: true,      // “后台初始化中…” toast（必须实现，默认开启）
      hintBadge: true,      // 右下角角标（必须实现，默认开启）
      prefetchEnabled: true,
      dedupeFetch: true,
      prefetchTimeoutMs: 15000,
      debug: false,
    });

    const STATE = {
      t0: performance.now(),
      ctx: null,
      settings: null,
      badgeEl: null,
      toastShown: false,
      earlyHideAttempted: false,
      fetchWrapped: false,
      baseFetch: null,
      // pathname -> { key, promise, result, usedCount }
      prefetch: new Map(),
      marks: [],
    };

    function msSinceStart() {
      return Math.round(performance.now() - STATE.t0);
    }

    function debug(...args) {
      if (STATE.settings?.debug) {
        console.debug(`[${EXTENSION_NAME}]`, ...args);
      }
    }

    function mark(name, extra) {
      const t = performance.now();
      STATE.marks.push({ name, t, extra });
      debug(`mark ${name} @ ${Math.round(t - STATE.t0)}ms`, extra ?? '');
    }

    function getStCtx() {
      try {
        return getCtx();
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

    function ensureSettings(ctx) {
      const root = ctx?.extensionSettings;
      if (!root) return null;

      root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
      const s = root[EXTENSION_NAME];

      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
      }

      // normalize
      s.enabled = Boolean(s.enabled);
      s.earlyHideLoader = Boolean(s.earlyHideLoader);
      s.hintToast = Boolean(s.hintToast);
      s.hintBadge = Boolean(s.hintBadge);
      s.prefetchEnabled = Boolean(s.prefetchEnabled);
      s.dedupeFetch = Boolean(s.dedupeFetch);
      s.prefetchTimeoutMs = clampInt(s.prefetchTimeoutMs, 0, 600000, DEFAULT_SETTINGS.prefetchTimeoutMs);
      s.debug = Boolean(s.debug);

      return s;
    }

    function saveSettings(ctx) {
      try {
        ctx?.saveSettingsDebounced?.();
      } catch (e) {
        console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
      }
    }

    function ensureBadge() {
      if (!STATE.settings?.hintBadge) return null;
      if (STATE.badgeEl && document.body.contains(STATE.badgeEl)) return STATE.badgeEl;

      const el = document.createElement('div');
      el.id = 'st-startup-optimizer-badge';
      el.className = 'st-startup-optimizer-badge';
      el.dataset.state = 'loading';
      el.textContent = '启动优化：后台初始化中…';

      document.body.appendChild(el);
      STATE.badgeEl = el;
      return el;
    }

    function updateBadge(text, state) {
      const el = ensureBadge();
      if (!el) return;
      if (typeof text === 'string') el.textContent = text;
      if (state) el.dataset.state = state;
    }

    function removeBadgeLater(delayMs = 2000) {
      if (!STATE.badgeEl) return;
      const el = STATE.badgeEl;
      setTimeout(() => {
        try {
          el.remove();
        } catch { }
        if (STATE.badgeEl === el) STATE.badgeEl = null;
      }, Math.max(0, delayMs));
    }

    function showInitHint() {
      // “提示必做”：至少实现 toast+角标。这里用开关控制是否展示，但默认开启。
      if (STATE.settings?.hintBadge) {
        updateBadge('启动优化：后台初始化中…', 'loading');
      }

      if (!STATE.settings?.hintToast) return;
      if (STATE.toastShown) return;
      STATE.toastShown = true;

      try {
        if (globalThis.toastr?.info) {
          globalThis.toastr.info(
            '后台仍在初始化中，部分功能会稍后就绪。',
            '启动优化',
            { timeOut: 4000, extendedTimeOut: 2000, closeButton: true },
          );
        } else {
          console.info(`[${EXTENSION_NAME}] 后台仍在初始化中，部分功能会稍后就绪。`);
        }
      } catch (e) {
        console.warn(`[${EXTENSION_NAME}] showInitHint failed`, e);
      }
    }

    async function tryEarlyHideLoader(ctx, reason) {
      if (!STATE.settings?.enabled) return;
      if (!STATE.settings?.earlyHideLoader) return;
      if (STATE.earlyHideAttempted) return;
      STATE.earlyHideAttempted = true;

      mark('earlyHide.attempt', reason);
      updateBadge('启动优化：解除遮罩中…', 'loading');

      try {
        await ctx?.hideLoader?.();
        mark('earlyHide.done', { reason, ms: msSinceStart() });
        showInitHint();
        updateBadge('启动优化：后台初始化中…', 'loading');
      } catch (e) {
        console.warn(`[${EXTENSION_NAME}] earlyHide failed`, e);
        mark('earlyHide.error', String(e));
        updateBadge('启动优化：解除遮罩失败（请看控制台）', 'error');
      }
    }

    function toPathname(input) {
      try {
        const urlStr =
          typeof input === 'string'
            ? input
            : (input && typeof input === 'object' && 'url' in input)
              ? input.url
              : String(input);
        return new URL(urlStr, globalThis.location?.origin ?? 'http://localhost').pathname;
      } catch {
        return null;
      }
    }

    function makeAbortSignal(timeoutMs) {
      if (!timeoutMs || timeoutMs <= 0) return { signal: undefined, cancel: () => { } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return {
        signal: controller.signal,
        cancel: () => clearTimeout(timer),
      };
    }

    async function prefetchText(baseFetch, path, init, timeoutMs) {
      const startedAt = performance.now();
      const { signal, cancel } = makeAbortSignal(timeoutMs);
      try {
        const resp = await baseFetch(path, { ...init, signal: init?.signal ?? signal });
        const headers = {};
        try {
          resp.headers?.forEach?.((v, k) => { headers[k] = v; });
        } catch { }
        const text = await resp.text();
        const endedAt = performance.now();
        return {
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          headers,
          text,
          startedAt,
          endedAt,
          durationMs: Math.round(endedAt - startedAt),
        };
      } catch (e) {
        const endedAt = performance.now();
        return {
          ok: false,
          status: 0,
          statusText: 'prefetch_error',
          headers: {},
          text: '',
          error: String(e?.message || e),
          startedAt,
          endedAt,
          durationMs: Math.round(endedAt - startedAt),
        };
      } finally {
        cancel();
      }
    }

    function responseFromPrefetch(result) {
      const headers = new Headers(result?.headers || {});
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json; charset=utf-8');
      }
      return new Response(result.text, {
        status: result.status || 200,
        statusText: result.statusText || 'OK',
        headers,
      });
    }

    function installFetchWrapper(ctx) {
      if (STATE.fetchWrapped) return;

      // Wrap whatever fetch currently is (don’t assume native)
      const baseFetch = (globalThis.fetch || window.fetch).bind(globalThis);
      STATE.baseFetch = baseFetch;

      const matchToKey = (pathname) => {
        switch (pathname) {
          case '/api/avatars/get': return 'avatars';
          case '/api/characters/all': return 'characters';
          case '/api/backgrounds/all': return 'backgrounds';
          default: return null;
        }
      };

      const wrappedFetch = async (input, init) => {
        const pathname = toPathname(input);
        const key = pathname ? matchToKey(pathname) : null;

        if (!STATE.settings?.enabled || !STATE.settings?.prefetchEnabled || !STATE.settings?.dedupeFetch || !key) {
          return baseFetch(input, init);
        }

        const entry = STATE.prefetch.get(pathname);
        if (!entry?.promise) {
          return baseFetch(input, init);
        }

        try {
          entry.usedCount = (entry.usedCount || 0) + 1;
          const result = await entry.promise;
          if (result?.ok) {
            debug(`dedupe hit: ${pathname} (used=${entry.usedCount}, ${result.durationMs}ms)`);
            mark('fetch.dedupe.hit', { pathname, durationMs: result.durationMs });
            return responseFromPrefetch(result);
          }
        } catch { }

        // Prefetch failed; fallback to real fetch
        mark('fetch.dedupe.miss', { pathname });
        return baseFetch(input, init);
      };

      // Install wrapper
      globalThis.fetch = wrappedFetch;
      window.fetch = wrappedFetch;
      STATE.fetchWrapped = true;
      mark('fetch.wrap.installed');
      debug('fetch wrapper installed');
    }

    function maybeStartPrefetch(ctx) {
      if (!STATE.settings?.enabled || !STATE.settings?.prefetchEnabled) return;
      if (!STATE.fetchWrapped || !STATE.baseFetch) return;

      const timeoutMs = STATE.settings.prefetchTimeoutMs;
      const headersJson = ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
      const headersNoCT = ctx?.getRequestHeaders?.({ omitContentType: true }) || {};

      const items = [
        {
          key: 'avatars',
          pathname: '/api/avatars/get',
          init: { method: 'POST', headers: headersNoCT },
        },
        {
          key: 'characters',
          pathname: '/api/characters/all',
          init: { method: 'POST', headers: headersJson, body: JSON.stringify({}) },
        },
        {
          key: 'backgrounds',
          pathname: '/api/backgrounds/all',
          init: { method: 'POST', headers: headersJson, body: JSON.stringify({}) },
        },
      ];

      for (const item of items) {
        if (STATE.prefetch.has(item.pathname)) continue;

        const promise = prefetchText(STATE.baseFetch, item.pathname, item.init, timeoutMs)
          .then((result) => {
            mark('prefetch.done', { key: item.key, pathname: item.pathname, ok: result.ok, durationMs: result.durationMs });
            return result;
          });

        STATE.prefetch.set(item.pathname, {
          key: item.key,
          promise,
          usedCount: 0,
        });

        mark('prefetch.start', { key: item.key, pathname: item.pathname });
        debug(`prefetch started: ${item.pathname}`);
      }
    }

    async function registerSettingsPanel(ctx, targetOverride) {
      const PANEL_ROOT_ID = 'stso-settings-root';
      if (document.getElementById(PANEL_ROOT_ID)) return true;

      try {
        await CocktailUI.registerSettingsPanel({
          id: `${EXTENSION_NAME}.settings`,
          title: '启动加载优化',
          target: targetOverride ?? 'right',
          expanded: false,
          order: 45,
          content: {
            kind: 'render',
            render: (container) => {
              const root = document.createElement('div');
              root.id = PANEL_ROOT_ID;
              root.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:10px;">
                  <div><b>启动加载优化（前端扩展）</b></div>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_enabled" type="checkbox">
                    启用
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_earlyHide" type="checkbox">
                    提前解除遮罩（SETTINGS_LOADED 后 hideLoader）
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_hintToast" type="checkbox">
                    提示：toast（后台初始化中…）
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_hintBadge" type="checkbox">
                    提示：右下角角标
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_prefetch" type="checkbox">
                    预取关键接口（avatars/characters/backgrounds）
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_dedupe" type="checkbox">
                    复用预取结果（fetch 去重）
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    预取超时(ms)
                    <input id="stso_timeout" type="number" min="0" max="600000" step="500">
                  </label>

                  <label style="display:flex; gap:8px; align-items:center;">
                    <input id="stso_debug" type="checkbox">
                    Debug 日志
                  </label>

                  <div style="opacity:0.85; font-size:12px;">
                    说明：扩展无法消除入口处等待 <code>window.load</code> 的时间，但可以让你更早看到主界面，并减少后半段接口等待。
                  </div>
                </div>
              `;

              container.appendChild(root);

              const $ = (sel) => /** @type {HTMLInputElement|null} */ (root.querySelector(sel));
              const enabled = $('#stso_enabled');
              const earlyHide = $('#stso_earlyHide');
              const hintToast = $('#stso_hintToast');
              const hintBadge = $('#stso_hintBadge');
              const prefetch = $('#stso_prefetch');
              const dedupe = $('#stso_dedupe');
              const timeout = $('#stso_timeout');
              const debugBox = $('#stso_debug');

              const refreshUI = () => {
                const s = ensureSettings(ctx);
                if (!s) return;
                STATE.settings = s;
                if (enabled) enabled.checked = Boolean(s.enabled);
                if (earlyHide) earlyHide.checked = Boolean(s.earlyHideLoader);
                if (hintToast) hintToast.checked = Boolean(s.hintToast);
                if (hintBadge) hintBadge.checked = Boolean(s.hintBadge);
                if (prefetch) prefetch.checked = Boolean(s.prefetchEnabled);
                if (dedupe) dedupe.checked = Boolean(s.dedupeFetch);
                if (timeout) timeout.value = String(s.prefetchTimeoutMs);
                if (debugBox) debugBox.checked = Boolean(s.debug);
              };

              const onChange = () => {
                const s = ensureSettings(ctx);
                if (!s) return;

                if (enabled) s.enabled = Boolean(enabled.checked);
                if (earlyHide) s.earlyHideLoader = Boolean(earlyHide.checked);
                if (hintToast) s.hintToast = Boolean(hintToast.checked);
                if (hintBadge) s.hintBadge = Boolean(hintBadge.checked);
                if (prefetch) s.prefetchEnabled = Boolean(prefetch.checked);
                if (dedupe) s.dedupeFetch = Boolean(dedupe.checked);
                if (timeout) s.prefetchTimeoutMs = clampInt(timeout.value, 0, 600000, DEFAULT_SETTINGS.prefetchTimeoutMs);
                if (debugBox) s.debug = Boolean(debugBox.checked);

                STATE.settings = s;

                // If badge got disabled, remove immediately
                if (!s.hintBadge && STATE.badgeEl) {
                  try { STATE.badgeEl.remove(); } catch { }
                  STATE.badgeEl = null;
                }

                // Start prefetch if user enables it after load
                if (s.enabled) {
                  maybeStartPrefetch(ctx);
                }

                saveSettings(ctx);
                refreshUI();
              };

              [
                enabled,
                earlyHide,
                hintToast,
                hintBadge,
                prefetch,
                dedupe,
                timeout,
                debugBox,
              ].forEach((el) => el?.addEventListener('change', onChange));

              refreshUI();

              return () => {
                [
                  enabled,
                  earlyHide,
                  hintToast,
                  hintBadge,
                  prefetch,
                  dedupe,
                  timeout,
                  debugBox,
                ].forEach((el) => el?.removeEventListener('change', onChange));
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

    function printSummary() {
      try {
        const ms = (t) => Math.round(t - STATE.t0);
        const findMark = (name) => STATE.marks.findLast?.(m => m.name === name) || [...STATE.marks].reverse().find(m => m.name === name);

        const mSettings = findMark('event.SETTINGS_LOADED');
        const mReady = findMark('event.APP_READY');

        const prefetchLines = [];
        for (const [pathname, entry] of STATE.prefetch.entries()) {
          const key = entry.key;
          const used = entry.usedCount || 0;
          prefetchLines.push({ pathname, key, used });
        }

        console.groupCollapsed(`[${EXTENSION_NAME}] 启动统计 @ ${msSinceStart()}ms`);
        console.log('扩展加载后(ms):', msSinceStart());
        if (mSettings) console.log('SETTINGS_LOADED(ms):', ms(mSettings.t));
        if (mReady) console.log('APP_READY(ms):', ms(mReady.t));
        console.log('提前解除遮罩:', STATE.earlyHideAttempted ? '已尝试' : '未尝试');
        console.log('预取条目:', prefetchLines);
        console.log('marks:', STATE.marks.map(m => ({ name: m.name, ms: ms(m.t), extra: m.extra })));
        console.groupEnd();
      } catch (e) {
        console.warn(`[${EXTENSION_NAME}] printSummary failed`, e);
      }
    }

    async function init() {
      mark('extension.init');
      const ctx = getStCtx();
      if (!ctx) {
        console.warn(`[${EXTENSION_NAME}] SillyTavern context not available`);
        return;
      }

      STATE.ctx = ctx;
      STATE.settings = ensureSettings(ctx);
      if (!STATE.settings) {
        console.warn(`[${EXTENSION_NAME}] extension settings not available`);
        return;
      }

      installFetchWrapper(ctx);
      maybeStartPrefetch(ctx);

      // Events
      const ev = ctx.eventTypes;
      const es = ctx.eventSource;

      if (es?.on && ev?.SETTINGS_LOADED) {
        es.on(ev.SETTINGS_LOADED, async () => {
          mark('event.SETTINGS_LOADED', { ms: msSinceStart() });
          // 提前解除遮罩（核心会在最后再 hideLoader 一次；那次会产生一个 warn，但不影响功能）
          await tryEarlyHideLoader(ctx, 'SETTINGS_LOADED');
        });
      }

      if (es?.on && ev?.APP_READY) {
        es.on(ev.APP_READY, () => {
          mark('event.APP_READY', { ms: msSinceStart() });
          updateBadge('启动优化：初始化完成', 'done');
          removeBadgeLater(2500);
          printSummary();
        });
      }

      globalThis.__stStartupOptimizer = {
        version: '0.1.0',
        extensionName: EXTENSION_NAME,
        get settings() { return STATE.settings; },
        printSummary,
        registerPanel: (target) => ctx && registerSettingsPanel(ctx, target),
      };

      saveSettings(ctx);
    }

    // Run as early as possible; module scripts are already deferred, but DOM should exist here.
    try {
      init();
    } catch (e) {
      console.error(`[${EXTENSION_NAME}] init crashed`, e);
    }

    return {
      name: EXTENSION_NAME,
      registerSettingsPanel,
    };
  })();

  // ============================================================================
  // 鸡尾酒统一设置面板（一个入口，内含三个子抽屉）
  // ============================================================================

  async function registerCocktailPanel(ctx) {
    const ROOT_ID = 'st-cocktail-settings-root';
    if (document.getElementById(ROOT_ID)) return true;

    try {
      await CocktailUI.registerSettingsPanel({
        id: `${COCKTAIL_EXTENSION_NAME}.settings`,
        title: '鸡尾酒',
        target: 'right',
        expanded: false,
        order: 40,
        content: {
          kind: 'render',
          render: async (container) => {
            const root = document.createElement('div');
            root.id = ROOT_ID;
            root.className = 'st-cocktail-panel';
            root.innerHTML = `
              <div class="st-cocktail-intro">
                <div><b>鸡尾酒</b>：把「启动加载优化 / 聊天渲染优化 / 正则刷新优化」合并为一个插件。</div>
                <div class="st-cocktail-sub">下面三个子面板分别对应原来的三个插件设置项。</div>
              </div>
              <div id="st-cocktail-subpanels"></div>
            `;
            container.appendChild(root);

            // Register nested panels into our container (no st-api-wrapper needed).
            const targetSelector = '#st-cocktail-subpanels';
            await StartupOptimizer.registerSettingsPanel(ctx, targetSelector);
            await ChatRenderOptimizer.registerSettingsPanel(ctx, targetSelector);
            await RegexRefreshOptimizer.registerSettingsPanel(ctx, targetSelector);
          },
        },
      });
      return true;
    } catch (e) {
      console.warn(`[${COCKTAIL_EXTENSION_NAME}] registerCocktailPanel failed`, e);
      return false;
    }
  }

  async function registerCocktailPanelWithRetry() {
    for (let i = 0; i < 12; i++) {
      const ctx = getCtx();
      if (ctx) {
        const ok = await registerCocktailPanel(ctx);
        if (ok) return true;
      }
      await delay(300);
    }
    return false;
  }

  // Try to register settings panel on DOM ready and APP_READY.
  globalThis.jQuery?.(async () => {
    await registerCocktailPanelWithRetry();
    const ctx = getCtx();
    ctx?.eventSource?.on?.(ctx.eventTypes?.APP_READY, registerCocktailPanelWithRetry);
  });

  // Expose a compact debug handle
  globalThis.__stCocktail = {
    version: '0.1.0',
    extensionName: COCKTAIL_EXTENSION_NAME,
    ui: CocktailUI,
    modules: {
      startup: StartupOptimizer,
      chatRender: ChatRenderOptimizer,
      regexRefresh: RegexRefreshOptimizer,
    },
  };
}

