# 鸡尾酒

这是一个 **SillyTavern 前端扩展**，把以下三个优化插件合并成一个：

- `st-startup-optimizer`（启动加载优化）
- `st-chat-render-optimizer`（聊天渲染优化）
- `st-regex-refresh-optimizer`（正则刷新优化）

## 安装（无需编译）

把整个 `st-cocktail/` 文件夹复制到你的 SillyTavern：

`SillyTavern/public/scripts/extensions/third-party/st-cocktail/`

确保目录内至少有：

- `manifest.json`
- `index.js`
- `style.css`

然后在酒馆前端：**扩展 → 启用** `鸡尾酒`。

## 设置面板

启用后会在“扩展设置”右侧注册一个 **鸡尾酒** 面板，里面包含 3 个子面板（对应原来的 3 个插件）。

