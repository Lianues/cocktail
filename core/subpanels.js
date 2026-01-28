/**
 * cocktail 子面板注册器（统一入口）
 *
 * - 模块通过 registerCocktailSubpanel(...) 注册自己的“子面板”
 * - 主鸡尾酒面板会读取注册表并渲染
 *
 * 注意：
 * - 这里只做注册与订阅，不直接操作 DOM
 */

/** @typedef {{ id: string; title: string; order?: number; render: (container: HTMLElement, ctx: any) => (void | (() => void)); }} CocktailSubpanel */

/** @type {Map<string, CocktailSubpanel>} */
const _registry = new Map();

/** @type {Set<() => void>} */
const _listeners = new Set();

function _notify() {
  for (const fn of Array.from(_listeners)) {
    try { fn(); } catch { }
  }
}

/**
 * 注册一个子面板。重复注册同 id 会覆盖。
 * @param {CocktailSubpanel} def
 */
export function registerCocktailSubpanel(def) {
  if (!def || typeof def !== 'object') throw new Error('registerCocktailSubpanel: invalid def');
  if (!def.id || typeof def.id !== 'string') throw new Error('registerCocktailSubpanel: missing id');
  if (!def.title || typeof def.title !== 'string') throw new Error('registerCocktailSubpanel: missing title');
  if (typeof def.render !== 'function') throw new Error('registerCocktailSubpanel: missing render()');

  _registry.set(def.id, {
    ...def,
    order: Number.isFinite(Number(def.order)) ? Number(def.order) : 0,
  });
  _notify();
  return { ok: true };
}

export function listCocktailSubpanels() {
  return Array.from(_registry.values()).sort((a, b) => {
    const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
    const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
    if (ao !== bo) return ao - bo;
    return String(a.title).localeCompare(String(b.title));
  });
}

export function onCocktailSubpanelsChanged(listener) {
  if (typeof listener !== 'function') return () => { };
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// Small debug handle
globalThis.__cocktailSubpanels = {
  register: registerCocktailSubpanel,
  list: listCocktailSubpanels,
};

