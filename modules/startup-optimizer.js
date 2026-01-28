/**
 * st-startup-optimizer
 * - 不改源代码，通过扩展改善“启动到主界面”体验
 * - 提前解除遮罩（SETTINGS_LOADED 后 hideLoader）
 * - 提示必做：toast + 角标
 * - 预取 + 复用：/api/avatars/get、/api/characters/all、/api/backgrounds/all
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-startup-optimizer';

// Avoid double-install (some reload flows can evaluate modules twice)
if (globalThis.__stStartupOptimizerLoaded) {
    console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
    globalThis.__stStartupOptimizerLoaded = true;
}

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

function getCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.();
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

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
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

    const maybeInvalidatePrefetch = (pathname) => {
        if (!pathname) return;
        if (!STATE.settings?.enabled || !STATE.settings?.prefetchEnabled || !STATE.settings?.dedupeFetch) return;

        // If an API call potentially modifies core lists, invalidate the startup-prefetched snapshots.
        // This prevents stale `/api/characters/all` results from breaking import/refresh flows.
        if (pathname.startsWith('/api/characters/') && pathname !== '/api/characters/all') {
            const droppedCharacters = STATE.prefetch.delete('/api/characters/all');
            const droppedAvatars = STATE.prefetch.delete('/api/avatars/get');

            if (droppedCharacters || droppedAvatars) {
                mark('prefetch.invalidate.characters', {
                    cause: pathname,
                    charactersAll: droppedCharacters,
                    avatarsGet: droppedAvatars,
                });
                debug('prefetch invalidated (characters)', { cause: pathname, droppedCharacters, droppedAvatars });
            }
        }

        if (pathname.startsWith('/api/backgrounds/') && pathname !== '/api/backgrounds/all') {
            const droppedBackgrounds = STATE.prefetch.delete('/api/backgrounds/all');
            if (droppedBackgrounds) {
                mark('prefetch.invalidate.backgrounds', { cause: pathname });
                debug('prefetch invalidated (backgrounds)', { cause: pathname });
            }
        }
    };

    const wrappedFetch = async (input, init) => {
        const pathname = toPathname(input);
        maybeInvalidatePrefetch(pathname);
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

async function registerSettingsPanel(ctx) {
    const ST_API = globalThis.ST_API;
    if (!ST_API?.ui?.registerSettingsPanel) return false;

    const PANEL_ROOT_ID = 'stso-settings-root';
    if (document.getElementById(PANEL_ROOT_ID)) return true;

    try {
        await ST_API.ui.registerSettingsPanel({
            id: `${EXTENSION_NAME}.settings`,
            title: '启动加载优化',
            target: 'right',
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
                <input id="stso_timeout" type="number" min="0" max="600000" step="500" style="width:120px;">
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
    const ctx = getCtx();
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

            const sizeBeforeClear = STATE.prefetch.size;
            if (sizeBeforeClear > 0) {
                mark('prefetch.clear', { size: sizeBeforeClear });
            }
            printSummary();

            // Startup-prefetch is only meant to speed up init; don't keep reusing snapshots afterward.
            if (sizeBeforeClear > 0) {
                STATE.prefetch.clear();
                debug('prefetch cleared on APP_READY', { size: sizeBeforeClear });
            }
        });
    }

    // Expose a small debug handle
    globalThis.__stStartupOptimizer = {
        version: '0.1.0',
        extensionName: EXTENSION_NAME,
        get settings() { return STATE.settings; },
        printSummary,
    };

    saveSettings(ctx);
}

function renderCocktailSettings(container, ctx) {
    const root = document.createElement('div');
    root.className = 'cocktail-form';
    root.innerHTML = `
        <div class="cocktail-grid">
            <label class="cocktail-check">
                <input id="stso_enabled" type="checkbox">
                启用
            </label>
            <label class="cocktail-check">
                <input id="stso_earlyHide" type="checkbox">
                提前解除遮罩（SETTINGS_LOADED 后）
            </label>
            <label class="cocktail-check">
                <input id="stso_hintToast" type="checkbox">
                提示：toast（后台初始化中…）
            </label>
            <label class="cocktail-check">
                <input id="stso_hintBadge" type="checkbox">
                提示：右下角角标
            </label>
            <label class="cocktail-check">
                <input id="stso_prefetch" type="checkbox">
                预取关键接口（avatars / characters / backgrounds）
            </label>
            <label class="cocktail-check">
                <input id="stso_dedupe" type="checkbox">
                复用预取结果（fetch 去重）
            </label>
            <label class="cocktail-field">
                <span class="cocktail-label">预取超时(ms)</span>
                <input id="stso_timeout" type="number" min="0" max="600000" step="500">
            </label>
            <label class="cocktail-check">
                <input id="stso_debug" type="checkbox">
                Debug 日志
            </label>
        </div>
        <div class="cocktail-help">
            说明：扩展无法消除入口处等待 <code>window.load</code> 的时间，但可以让你更早看到主界面，并减少后半段接口等待。
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
}

// 注册到“鸡尾酒”统一面板
registerCocktailSubpanel({
    id: EXTENSION_NAME,
    title: '启动加载优化',
    order: 10,
    render: renderCocktailSettings,
});

// Run as early as possible; module scripts are already deferred, but DOM should exist here.
try {
    init();
} catch (e) {
    console.error(`[${EXTENSION_NAME}] init crashed`, e);
}

