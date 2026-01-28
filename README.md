# 鸡尾酒（cocktail）

这是一个 **SillyTavern 前端扩展**，把以下三个优化插件合并成一个：

- `st-startup-optimizer`（启动加载优化）
- `st-chat-render-optimizer`（聊天渲染优化）
- `st-regex-refresh-optimizer`（正则刷新优化）

本插件的实现方式是 **入口 `index.js` + `modules/` 下的独立模块文件**：三个模块互不依赖，方便你后续按需拆装/替换。

## 安装（无需编译）

把整个 `cocktail/` 文件夹复制到你的 SillyTavern：

`SillyTavern/public/scripts/extensions/third-party/cocktail/`

确保目录内至少有：

- `manifest.json`
- `index.js`
- `modules/`
- `style.css`

然后在酒馆前端：**扩展 → 启用** `鸡尾酒`。

## 设置面板（可选）

启用后，会在“扩展设置”里插入一个 **鸡尾酒** 面板，内部包含 3 个 **自定义 HTML 子面板**：

- 启动加载优化
- 聊天渲染优化
- 正则刷新优化

三个模块不再各自注册独立面板；而是通过 `core/subpanels.js` 提供的统一注册器注册到鸡尾酒面板里。

## 如何“解耦/只保留其中一项”

编辑 `index.js`，删除对应的 import，并删除 `modules/` 下的对应模块文件即可。

