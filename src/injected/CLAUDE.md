# src/injected

> 更新时间：2026-04-08 10:36:05
> 导航：[根级](../../CLAUDE.md) / `src` / `injected`

## 模块职责

`src/injected/page-hook.js` 运行在页面上下文，不是普通内容脚本上下文。它的作用是：

- 拦截页面侧的请求与流式响应
- 注入能力扩展 / thinking 协议 / 全局提示词
- 识别工具调用格式问题、续写截断、工具结果自动回灌
- 把页面侧观察结果通过 `window.postMessage` 回传给内容脚本

## 为什么必须单独存在

内容脚本无法直接改写页面自身的 JS 执行环境；因此需要先把 `page-hook.js` 作为 `web_accessible_resources` 注入到页面上下文，才能拦截 `fetch`、`WebAssembly`、页面运行时协议等。

## 关键能力

### 1. 页面侧状态接收
接收来自内容脚本的：
- `CONTENT_SET_ENABLED`
- `CONTENT_SET_THINKING_INJECTION`
- `CONTENT_SET_GLOBAL_PROMPT_INSTRUCTION`
- `CONTENT_SYNC_MCP_STATE`

### 2. 页面侧事件回传
回传给内容脚本：
- `PAGE_HOOK_READY`
- `PAGE_HOOK_CHAT_REQUEST`
- `PAGE_HOOK_STREAM_START`
- `PAGE_HOOK_STREAM_DONE`
- `PAGE_HOOK_TOOLCODE_FOUND`
- `PAGE_HOOK_TOOL_FORMAT_RETRY_REQUIRED`
- `PAGE_HOOK_LOG`

### 3. 请求/流式输出干预
- 改写请求，注入提示词或文件内容
- 解析 SSE / 流式事件
- 检测工具调用与截断续写协议
- 识别未闭合工具调用 token

### 4. 页面补丁
- 主题同步
- 部分 anti-lag hook
- Shiki / code rendering 相关替代逻辑

## 注意事项

1. 这里的任何协议改动，必须同步 `bridge-mcp-runner.js`。
2. 这里的字符串注入能力很强，改动时要警惕把内部指令泄漏到用户可见输出。
3. 该文件承担页面拦截与协议桥接双重职责，修改前最好先确认影响的是：
   - 请求改写
   - 流式解析
   - 工具协议
   - UI 补丁
   哪一类。
4. 如果新增 `PAGE_HOOK_*` 事件，必须补全接收端路由。
