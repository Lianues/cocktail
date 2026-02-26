/**
 * cocktail（综合优化插件）
 *
 * 目标：把以下三个插件合并为一个插件（但内部保持解耦，按模块拆分）：
 * - st-startup-optimizer
 * - st-chat-render-optimizer
 * - st-regex-refresh-optimizer
 *
 * 说明：
 * - 酒馆会以 <script type="module"> 加载扩展脚本，因此这里使用 ES Module 的拆分方式即可，无需打包。
 * - 每个模块仍使用自己原本的 EXTENSION_NAME 作为 settings key，方便迁移/回滚。
 */

// 主鸡尾酒面板 + 子面板注册器
import './core/panel.js';

const REGEX_REFRESH_MIN_ST_VERSION = '1.14.0';

let _regexRefreshFinalized = false;
let _regexRefreshLoadPromise = null;

function extractVersionString(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Source: displayVersion, e.g. "SillyTavern 1.15.0 'release' (hash)"
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function parseSemver(version) {
  const m = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

async function detectStVersion() {
  try {
    const scriptMod = await import('/script.js');
    return extractVersionString(scriptMod?.displayVersion);
  } catch {
    return null;
  }
}

async function maybeLoadRegexRefreshOptimizer() {
  if (_regexRefreshFinalized) return;
  if (_regexRefreshLoadPromise) return _regexRefreshLoadPromise;

  _regexRefreshLoadPromise = (async () => {
    const stVersion = await detectStVersion();

    // Version not ready yet -> keep waiting for a later retry hook.
    if (!stVersion) {
      console.debug('[cocktail] ST version is not ready, postpone loading st-regex-refresh-optimizer');
      return;
    }

    if (compareSemver(stVersion, REGEX_REFRESH_MIN_ST_VERSION) < 0) {
      _regexRefreshFinalized = true;
      console.info(`[cocktail] skip st-regex-refresh-optimizer on ST ${stVersion} (< ${REGEX_REFRESH_MIN_ST_VERSION})`);
      return;
    }

    await import('./modules/regex-refresh-optimizer.js');
    _regexRefreshFinalized = true;
  })()
    .catch((e) => {
      console.warn('[cocktail] failed to load st-regex-refresh-optimizer', e);
    })
    .finally(() => {
      _regexRefreshLoadPromise = null;
    });

  return _regexRefreshLoadPromise;
}

import './modules/startup-optimizer.js';
import './modules/chat-render-optimizer.js';
import './modules/preset-drag-optimizer.js';
import './modules/chat-saving-unblocker.js';
import './modules/auto-update-checker.js';
import './modules/ui-animation-optimizer.js';
import './modules/worldinfo-drag-optimizer.js';
import './modules/regex-drag-optimizer.js';
import './modules/worldinfo-panel-slim.js';
void maybeLoadRegexRefreshOptimizer();

globalThis.jQuery?.(() => {
  // Retry when DOM is ready.
  void maybeLoadRegexRefreshOptimizer();

  // Retry again after APP_READY; by then version info is usually initialized.
  const ctx = globalThis.SillyTavern?.getContext?.();
  ctx?.eventSource?.on?.(ctx?.eventTypes?.APP_READY, () => {
    void maybeLoadRegexRefreshOptimizer();
  });
});

// import './modules/html-render-cache.js';
// 暂时不再使用，避免bug