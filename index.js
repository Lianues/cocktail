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

import './modules/startup-optimizer.js';
import './modules/chat-render-optimizer.js';
import './modules/regex-refresh-optimizer.js';
import './modules/preset-panel-optimizer.js';

