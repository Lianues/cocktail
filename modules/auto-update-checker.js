/**
 * st-auto-update-checker
 *
 * 目标：
 * - 进入主页面后，后台拉取远端 manifest.json 对比版本号
 * - 如果不是最新版本：弹出提示，让用户选择是否更新
 * - 用户选择更新：直接调用酒馆的扩展更新 API（不模拟点击、不跳转界面），更新完成后刷新页面生效
 *
 * 说明：
 * - 不改酒馆源代码；仅通过前端扩展 JS 实现
 * - 远端 manifest 源：`https://github.com/Lianues/cocktail/blob/main/manifest.json`
 *   实际请求会优先使用支持 CORS/纯 JSON 的 raw 链接（并保留 blob 兼容尝试）
 */

const EXTENSION_NAME = 'st-auto-update-checker';

// Avoid double-install (some reload flows can evaluate modules twice)
const _ALREADY_LOADED = Boolean(globalThis.__stAutoUpdateCheckerLoaded);
if (_ALREADY_LOADED) {
  console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
  globalThis.__stAutoUpdateCheckerLoaded = true;
}

const STATE = {
  started: false,
  checked: false,
  checking: false,
  promptedThisSession: false,
};

function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function getRequestHeaders(ctx) {
  try {
    const headers = ctx?.getRequestHeaders?.();
    if (headers && typeof headers === 'object') return headers;
  } catch { }
  return { 'Content-Type': 'application/json' };
}

function parseSemver(version) {
  const v = String(version ?? '').trim();
  // Extract leading numeric parts like "1.2.3" from "1.2.3-beta"
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const resp = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getLocalManifestUrl() {
  // modules/auto-update-checker.js -> ../manifest.json
  try {
    return new URL('../manifest.json', import.meta.url).toString();
  } catch {
    return '/scripts/extensions/third-party/cocktail/manifest.json';
  }
}

function getRemoteManifestUrls() {
  // User-provided URL (blob) + more reliable raw endpoints
  return [
    'https://github.com/Lianues/cocktail/blob/main/manifest.json?raw=1',
    'https://raw.githubusercontent.com/Lianues/cocktail/main/manifest.json',
    'https://github.com/Lianues/cocktail/raw/main/manifest.json',
  ];
}

async function getCurrentVersion() {
  const localUrl = getLocalManifestUrl();
  const local = await fetchJsonWithTimeout(localUrl, 5000);
  const localVersion = String(local?.version ?? '').trim();
  return localVersion || null;
}

async function getLatestVersion() {
  for (const url of getRemoteManifestUrls()) {
    const remote = await fetchJsonWithTimeout(url, 8000);
    const remoteVersion = String(remote?.version ?? '').trim();
    if (remoteVersion) {
      return { version: remoteVersion, raw: remote };
    }
  }
  return null;
}

function guessExternalId() {
  // From URL like: /scripts/extensions/third-party/<folder>/modules/...
  try {
    const path = new URL(import.meta.url).pathname || '';
    const marker = '/scripts/extensions/third-party/';
    const idx = path.indexOf(marker);
    if (idx === -1) return null;
    const rest = path.slice(idx + marker.length);
    const folder = rest.split('/')[0];
    if (!folder) return null;
    return `/${folder}`;
  } catch {
    return null;
  }
}

function externalIdToDiscoverName(externalId) {
  const folder = String(externalId || '').replace(/^\//, '').trim();
  if (!folder) return null;
  return `third-party/${folder}`;
}

async function discoverExtensionType(externalId, ctx) {
  const name = externalIdToDiscoverName(externalId);
  if (!name) return null;

  try {
    const resp = await fetch('/api/extensions/discover', {
      method: 'GET',
      headers: getRequestHeaders(ctx),
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const list = await resp.json();
    if (!Array.isArray(list)) return null;

    const hit = list.find((x) => x && typeof x === 'object' && x.name === name);
    const type = hit?.type;
    if (type === 'global' || type === 'local' || type === 'system') return type;
    return null;
  } catch {
    return null;
  }
}

async function updateExtensionViaApi(externalId, ctx) {
  if (!externalId) return { ok: false, error: 'missing externalId' };

  const type = await discoverExtensionType(externalId, ctx);
  const isGlobal = type === 'global';

  try {
    const resp = await fetch('/api/extensions/update', {
      method: 'POST',
      headers: getRequestHeaders(ctx),
      body: JSON.stringify({
        extensionName: externalId,
        global: isGlobal,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: text || resp.statusText || String(resp.status) };
    }

    const data = await resp.json().catch(() => ({}));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'network error') };
  }
}

async function promptAndMaybeUpdate({ currentVersion, latestVersion }) {
  if (STATE.promptedThisSession) return;
  STATE.promptedThisSession = true;

  const ctx = getCtx();
  const Popup = ctx?.Popup;
  const POPUP_RESULT = ctx?.POPUP_RESULT;

  const title = '【鸡尾酒】发现新版本';
  const text =
    `当前版本：${currentVersion}\n` +
    `最新版本：${latestVersion}\n\n` +
    `是否现在更新？`;

  // Fallback: native confirm
  let shouldUpdate = false;
  try {
    if (Popup?.show?.confirm && POPUP_RESULT) {
      const result = await Popup.show.confirm(title, text, {
        okButton: '更新并刷新',
        cancelButton: '稍后',
      });
      shouldUpdate = result === POPUP_RESULT.AFFIRMATIVE;
    } else {
      shouldUpdate = globalThis.confirm(`${title}\n\n${text}`);
    }
  } catch {
    shouldUpdate = false;
  }

  if (!shouldUpdate) {
    return;
  }

  // Prefer updating the current extension folder; fallback to known external id.
  const externalId = guessExternalId() || '/cocktail';

  const result = await updateExtensionViaApi(externalId, ctx);
  if (!result?.ok) {
    try {
      globalThis.toastr?.error?.(String(result?.error || 'unknown error'), '扩展更新失败', { timeOut: 6000 });
    } catch { }
    return;
  }

  // 更新完成后刷新页面以应用新版本（按你的需求：简单稳）
  try {
    globalThis.toastr?.success?.('更新完成，页面即将刷新…', '鸡尾酒', { timeOut: 1200 });
  } catch { }
  await sleep(600);
  try {
    globalThis.location?.reload?.();
  } catch { }
}

async function checkOnce() {
  if (STATE.checked || STATE.checking) return;
  STATE.checking = true;

  try {
    const currentVersion = await getCurrentVersion();
    if (!currentVersion) return;

    const latest = await getLatestVersion();
    const latestVersion = latest?.version;
    if (!latestVersion) return;

    // latest > current ?
    if (compareSemver(latestVersion, currentVersion) > 0) {
      await promptAndMaybeUpdate({ currentVersion, latestVersion });
    }
  } finally {
    STATE.checked = true;
    STATE.checking = false;
  }
}

async function init() {
  if (STATE.started) return;
  STATE.started = true;

  // Delay a bit to ensure main UI is ready and avoid impacting startup.
  await sleep(1200);
  void checkOnce();

  // Also try on APP_READY (some builds delay extension init)
  const ctx = getCtx();
  ctx?.eventSource?.on?.(ctx?.eventTypes?.APP_READY, () => { void checkOnce(); });
}

if (!_ALREADY_LOADED) {
  globalThis.jQuery?.(() => { void init(); });
}

