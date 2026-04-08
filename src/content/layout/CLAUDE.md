# src/content/layout

> 更新时间：2026-04-08 10:36:05
> 导航：[根级](../../../CLAUDE.md) / [src/content](../CLAUDE.md) / `layout`

## 模块职责

`layout/` 负责把 Cursor 原始聊天页面重新组织成扩展需要的视觉与交互形态，核心任务包括：

- 聊天区居中与壳层（shell）重排
- DOM observer / reconcile / 恢复逻辑
- 用户消息气泡标记
- 工具返回结果块、续写请求气泡处理
- thinking / tool block 的样式注入

## 文件分工

```mermaid
flowchart TD
  core[layout-core.js\n居中布局 / shell / 自动展开]
  observer[layout-reconcile-observer.js\n标记、observer、reconcile]
  style[layout-thinking-style.js\nthinking / tool block 样式]
  css[../styles/*.css\n全局视觉与响应式]

  core --> observer
  observer --> style
  style --> css
```

### `layout-core.js`
- 找出页面主布局目标容器
- 创建和维护 `tm-chat-shell`
- 自动展开侧边栏 / 聊天区
- 免责声明 badge、输入占位符、居中布局生命周期

### `layout-reconcile-observer.js`
- 给用户消息打标记类名
- 识别并折叠展示 `[MCP_TOOL_RESULT]`
- 识别并隐藏续写请求气泡
- 启停 DOM observer，并在页面变化时触发 reconcile

### `layout-thinking-style.js`
- 注入 `.tm-thinking-block`、`.tm-tool-code-block` 等样式
- 统一 thinking 折叠块、工具代码块、工具结果块的视觉风格

### 配套样式
- `../styles/layout-global-base.css`：基础色板、壳层变量、免责声明
- `../styles/layout-global-shell-history.css`：会话侧栏与壳层样式
- `../styles/layout-global-chat-responsive.css`：居中聊天、气泡标记、响应式收敛

## 工作方式

这个模块不是“渲染一次就结束”，而是 **持续纠偏**：

1. 启动时做一次布局接管
2. 页面流式输出 / 路由变化 / 窗口缩放后再次 reconcile
3. DOM observer 发现结构变化后继续修正
4. startup recovery 会在延迟点位重复拉起关键功能

因此看到 UI 被反复“恢复”是设计使然，不是多余代码。

## 改动注意事项

1. **选择器极脆弱**
   - 很多逻辑直接依赖 Cursor 当前 DOM 结构
   - 改前先确认真实页面结构是否已经变化

2. **类名与标记属性是协议**
   - 如：
     - `.tm-user-message-bubble`
     - `.tm-user-message-bubble--mcp-result`
     - `.tm-user-message-bubble--continue-request`
     - `data-tm-*`
   - 这些不只是样式名，也被 JS 逻辑依赖

3. **改 observer 前先确认恢复路径**
   - 有些视觉问题来自 `layout-core.js`
   - 有些来自 `layout-reconcile-observer.js`
   - 还有一部分由 `bridge-fab-recovery-layout.js` 参与恢复

4. **样式改动要看三层**
   - 内联样式/JS 赋值
   - `layout-thinking-style.js` 注入样式
   - `src/content/styles/*.css` 全局样式

## 高风险点

- `ensureCenteredLayout()` / `restoreCenteredLayout()`
- `ensureUserMessageMarkers()`
- MCP 结果块和续写请求气泡的识别条件
- 与 `state.shell*`、`state.centered*`、observer/timer 的交互
