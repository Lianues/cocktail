/**
 * st-auto-update-checker
 *
 * 目标：
 * - 进入主页面后，后台拉取远端 manifest.json 对比版本号
 * - 如果不是最新版本：弹出提示，让用户选择是否更新
 * - 用户选择更新：触发扩展管理器的 `.btn_update` 点击事件，并在更新完成后自动刷新页面
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

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 120) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch { }
    await sleep(intervalMs);
  }
  return false;
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

async function triggerUpdateViaBtnUpdate(externalId) {
  if (!externalId) return false;

  // Build a temporary DOM that matches the delegated selector:
  // $(document).on('click', '.extensions_info .extension_block .btn_update', onUpdateClick)
  // The element must be inside `.extensions_info .extension_block` for the handler to match.
  const wrapper = document.createElement('div');
  wrapper.className = 'extensions_info';
  wrapper.style.display = 'none';

  const block = document.createElement('div');
  block.className = 'extension_block';
  block.dataset.name = externalId;

  const btn = document.createElement('button');
  btn.className = 'btn_update menu_button displayNone interactable';
  btn.dataset.name = externalId;
  btn.title = 'Update available';
  btn.tabIndex = 0;
  btn.setAttribute('role', 'button');
  btn.innerHTML = '<i class="fa-solid fa-download fa-fw"></i>';

  block.appendChild(btn);
  wrapper.appendChild(block);
  document.body.appendChild(wrapper);

  const icon = btn.querySelector('i');

  // Dispatch click so it bubbles to delegated handlers
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  // Wait for spinner to start (best-effort)
  const spinStarted = await waitUntil(() => icon?.classList?.contains('fa-spin') === true, 2000, 50);

  // If spinner started, wait until it ends (updateExtension awaited)
  if (spinStarted) {
    await waitUntil(() => icon?.classList?.contains('fa-spin') === false, 180000, 250);
  } else {
    // Handler might still run without spinner (or not installed). Give it a short grace period.
    await sleep(1500);
  }

  try { wrapper.remove(); } catch { }
  return true;
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
    `是否现在更新？更新完成后会自动刷新页面。`;

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

  // Trigger update via extensions.js delegated handler
  await triggerUpdateViaBtnUpdate(externalId);

  // Always reload after update attempt (requirement)
  try {
    globalThis.location?.reload?.();
  } catch {
    location.reload();
  }
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

