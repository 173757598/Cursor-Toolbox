// Bridge MCP panel: panel rendering, config parse/save, and tool toggles

'use strict';

function getMcpPanelElement() {
  return document.getElementById('tm-mcp-panel');
}

function removeMcpPanel() {
  const panel = getMcpPanelElement();
  if (panel) panel.remove();
}

function setMcpPanelStatus(message, isError = false) {
  const panel = getMcpPanelElement();
  const status = panel?.querySelector?.('#tm-mcp-status');
  if (!status) return;
  status.textContent = toSafeString(message) || '';
  status.style.color = isError ? '#b42318' : '#475467';
}

function getMcpPanelActiveTab(panel) {
  if (!(panel instanceof HTMLElement)) return MCP_PANEL_TAB_CONFIG;
  const activeTab = toSafeString(panel.getAttribute('data-active-tab'));
  return activeTab === MCP_PANEL_TAB_TOOLS ? MCP_PANEL_TAB_TOOLS : MCP_PANEL_TAB_CONFIG;
}

function setMcpPanelTab(panel, nextTab) {
  if (!(panel instanceof HTMLElement)) return;
  const tab = nextTab === MCP_PANEL_TAB_TOOLS ? MCP_PANEL_TAB_TOOLS : MCP_PANEL_TAB_CONFIG;
  panel.setAttribute('data-active-tab', tab);

  panel.querySelectorAll('[data-mcp-tab]').forEach((buttonNode) => {
    if (!(buttonNode instanceof HTMLButtonElement)) return;
    const isActive = buttonNode.getAttribute('data-mcp-tab') === tab;
    buttonNode.classList.toggle('is-active', isActive);
    buttonNode.setAttribute('aria-selected', isActive ? 'true' : 'false');
    buttonNode.setAttribute('tabindex', isActive ? '0' : '-1');
  });

  panel.querySelectorAll('[data-mcp-tab-panel]').forEach((panelNode) => {
    if (!(panelNode instanceof HTMLElement)) return;
    const isActive = panelNode.getAttribute('data-mcp-tab-panel') === tab;
    panelNode.style.display = isActive ? 'flex' : 'none';
    panelNode.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });

  repositionMcpPanel(panel);
}

function getMcpAnchorButtonRect() {
  const host = document.getElementById('tm-fab-host');
  if (!host?.shadowRoot) return null;
  const button = host.shadowRoot.getElementById('tm-mcp');
  if (!(button instanceof HTMLElement)) return null;
  return button.getBoundingClientRect();
}

function repositionMcpPanel(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const anchorRect = getMcpAnchorButtonRect();
  if (!anchorRect) return;

  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
  if (viewportWidth <= 0 || viewportHeight <= 0) return;

  const margin = 16;
  const gap = 10;
  const minHeight = 260;
  const maxHeightHardLimit = 680;

  const panelRect = panel.getBoundingClientRect();
  const panelWidth = Math.min(panelRect.width || 540, viewportWidth - margin * 2);

  const inputNearTop = anchorRect.top < viewportHeight * 0.46;
  const freeAbove = Math.max(0, anchorRect.top - gap - margin);
  const freeBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - margin);
  const maxHeight = Math.max(minHeight, Math.min(maxHeightHardLimit, inputNearTop ? freeBelow : freeAbove));

  const top = inputNearTop
    ? Math.min(Math.max(anchorRect.bottom + gap, margin), Math.max(margin, viewportHeight - minHeight - margin))
    : Math.min(
      Math.max(anchorRect.top - gap - maxHeight, margin),
      Math.max(margin, viewportHeight - maxHeight - margin)
    );
  const left = Math.min(
    Math.max(anchorRect.right - panelWidth, margin),
    Math.max(margin, viewportWidth - panelWidth - margin)
  );

  panel.style.left = `${Math.round(left)}px`;
  if (inputNearTop) {
    panel.style.top = `${Math.round(top)}px`;
    panel.style.bottom = 'auto';
  } else {
    const bottom = Math.max(margin, viewportHeight - anchorRect.top + gap);
    panel.style.bottom = `${Math.round(bottom)}px`;
    panel.style.top = 'auto';
  }
  panel.style.right = 'auto';
  panel.style.maxHeight = `${Math.round(maxHeight)}px`;
}

function stringifyMcpConfig(config) {
  const normalized = normalizeMcpConfig(config);
  const mcpServers = {};

  normalized.servers.forEach((server) => {
    const key = server.id || server.name;
    if (!key) return;
    // 统一使用 type 字段
    const item = {
      type: server.type || MCP_TRANSPORT_STREAMABLE_HTTP
    };

    if (server.type === MCP_TRANSPORT_STDIO) {
      if (server.command) item.command = server.command;
      if (Array.isArray(server.args) && server.args.length > 0) item.args = server.args;
      if (server.cwd) item.cwd = server.cwd;
      if (server.env && typeof server.env === 'object' && Object.keys(server.env).length > 0) {
        item.env = server.env;
      }
    } else {
      item.url = server.url || MCP_URL_FALLBACK_PLACEHOLDER;
      if (server.headers && typeof server.headers === 'object' && Object.keys(server.headers).length > 0) {
        item.headers = server.headers;
      }
    }

    mcpServers[key] = item;
  });

  if (Object.keys(mcpServers).length === 0) {
    return MCP_CONFIG_DEFAULT_TEXT;
  }

  return JSON.stringify({
    mcpServers
  }, null, 2);
}

function parseMcpConfigFromPanel() {
  const panel = getMcpPanelElement();
  const textarea = panel?.querySelector?.('#tm-mcp-json');
  const retriesInput = panel?.querySelector?.('#tm-mcp-tool-retries');
  const timeoutInput = panel?.querySelector?.('#tm-mcp-tool-timeout-seconds');
  const resultMaxCharsInput = panel?.querySelector?.('#tm-mcp-tool-result-max-chars');
  const maxAutoRoundsInput = panel?.querySelector?.('#tm-mcp-tool-max-auto-rounds');
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return { ok: false, error: 'MCP 配置输入框不可用' };
  }
  if (
    !(retriesInput instanceof HTMLInputElement) ||
    !(timeoutInput instanceof HTMLInputElement) ||
    !(resultMaxCharsInput instanceof HTMLInputElement) ||
    !(maxAutoRoundsInput instanceof HTMLInputElement)
  ) {
    return { ok: false, error: '工具调用策略输入框不可用' };
  }

  const retriesValue = Number.parseInt(retriesInput.value, 10);
  if (!Number.isFinite(retriesValue) || retriesValue < 0 || retriesValue > 20) {
    return { ok: false, error: '失败重试次数必须是 0-20 之间的整数' };
  }
  const timeoutSecondsValue = Number.parseInt(timeoutInput.value, 10);
  if (!Number.isFinite(timeoutSecondsValue) || timeoutSecondsValue < 5 || timeoutSecondsValue > 600) {
    return { ok: false, error: '单次调用超时必须是 5-600 秒之间的整数' };
  }
  const resultMaxCharsText = toSafeString(resultMaxCharsInput.value);
  if (!resultMaxCharsText) {
    return { ok: false, error: `返回最大长度不能为空，请输入 0-${MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS}（0=不截断）` };
  }
  const resultMaxCharsValue = Number.parseInt(resultMaxCharsText, 10);
  if (!Number.isFinite(resultMaxCharsValue) || resultMaxCharsValue < 0 || resultMaxCharsValue > MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS) {
    return { ok: false, error: `返回最大长度必须是 0-${MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS} 之间的整数` };
  }
  const maxAutoRoundsText = toSafeString(maxAutoRoundsInput.value);
  if (!maxAutoRoundsText) {
    return {
      ok: false,
      error: `连续自动工具调用上限不能为空，请输入 0-${MCP_TOOL_POLICY_MAX_AUTO_ROUNDS}（0=不限制）`
    };
  }
  const maxAutoRoundsValue = Number.parseInt(maxAutoRoundsText, 10);
  if (!Number.isFinite(maxAutoRoundsValue) || maxAutoRoundsValue < 0 || maxAutoRoundsValue > MCP_TOOL_POLICY_MAX_AUTO_ROUNDS) {
    return {
      ok: false,
      error: `连续自动工具调用上限必须是 0-${MCP_TOOL_POLICY_MAX_AUTO_ROUNDS} 之间的整数（0=不限制）`
    };
  }
  const toolPolicy = normalizeMcpToolPolicy({
    maxRetries: retriesValue,
    timeoutMs: timeoutSecondsValue * 1000,
    resultMaxChars: resultMaxCharsValue,
    maxAutoRounds: maxAutoRoundsValue
  });

  const text = textarea.value.trim();
  if (!text) {
    return {
      ok: true,
      config: {
        servers: [],
        toolPolicy,
        updatedAt: Date.now()
      }
    };
  }

  try {
    const parsed = JSON.parse(text);
    const normalized = normalizeMcpConfig(parsed);
    normalized.toolPolicy = toolPolicy;
    const parsedRootKeyCount = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).length
      : 0;
    const rawServers = getObjectValueByAliasesCaseInsensitive(parsed, ['servers']);
    const rawMcpServers = getObjectValueByAliasesCaseInsensitive(parsed, ['mcpServers', 'mcp_servers', 'mcpservers']);
    const providedServerRoots = [rawServers, rawMcpServers].filter((item) => item !== undefined);
    const hasOnlyEmptyServerRoots = providedServerRoots.length > 0
      && providedServerRoots.every((item) => {
        if (Array.isArray(item)) return item.length === 0;
        if (item && typeof item === 'object') return Object.keys(item).length === 0;
        return false;
      });

    if (normalized.servers.length === 0 && parsedRootKeyCount > 0 && !hasOnlyEmptyServerRoots) {
      return {
        ok: false,
        error: '未识别到 MCP 服务。请使用 mcpServers 或 servers（对象/数组）格式，且每个服务至少包含 url（或 stdio 的 command）'
      };
    }

    const invalid = normalized.servers.find((server) => {
      if (server.type === MCP_TRANSPORT_STDIO) {
        return !server.command;
      }
      return !server.url;
    });

    if (invalid) {
      // 回写归一化文本，缺失 URL 会显示占位值，提示用户可能填错了字段名。
      textarea.value = stringifyMcpConfig(normalized);
      if (panel) syncMcpJsonAssistFromTextarea(panel);
      if (invalid.type === MCP_TRANSPORT_STDIO) {
        return { ok: false, error: `服务 ${invalid.id} 缺少 command 启动命令` };
      }
      return { ok: false, error: `服务 ${invalid.id} 的 URL 无效` };
    }

    return { ok: true, config: normalized };
  } catch (error) {
    if (panel) setMcpJsonParseStatus(panel, formatMcpJsonParseErrorMessage(text, error), 'error');
    return { ok: false, error: `JSON 解析失败：${String(error?.message || error)}` };
  }
}

function formatMcpJsonParseErrorMessage(text, error) {
  const message = toSafeString(error?.message || error) || 'JSON 解析失败';
  const match = /position\s+(\d+)/i.exec(message);
  if (!match) return message;
  const position = Number.parseInt(match[1], 10);
  if (!Number.isFinite(position) || position < 0) return message;
  const prefix = text.slice(0, position);
  const lines = prefix.split('\n');
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return `${message}（第 ${line} 行，第 ${column} 列）`;
}

function escapeMcpJsonCodeHtml(value) {
  const source = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setMcpJsonParseStatus(panel, message, tone = 'neutral') {
  if (!(panel instanceof HTMLElement)) return;
  const status = panel.querySelector('#tm-mcp-json-parse-status');
  if (!(status instanceof HTMLElement)) return;
  status.textContent = toSafeString(message);
  if (tone === 'error') {
    status.style.color = '#b42318';
    return;
  }
  if (tone === 'ok') {
    status.style.color = '#027a48';
    return;
  }
  status.style.color = '#667085';
}

function computeMcpJsonBracketPairs(text) {
  const pairByIndex = new Map();
  const bracketPositions = new Set();
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push({ ch, index: i });
      bracketPositions.add(i);
      continue;
    }

    if (ch === '}' || ch === ']') {
      bracketPositions.add(i);
      const expected = ch === '}' ? '{' : '[';
      for (let j = stack.length - 1; j >= 0; j -= 1) {
        if (stack[j].ch !== expected) continue;
        const opener = stack[j];
        stack.splice(j, 1);
        pairByIndex.set(opener.index, i);
        pairByIndex.set(i, opener.index);
        break;
      }
    }
  }

  return { pairByIndex, bracketPositions };
}

function resolveMcpJsonActiveBracketIndices(text, caretIndex) {
  const active = new Set();
  if (!text) return active;

  const { pairByIndex, bracketPositions } = computeMcpJsonBracketPairs(text);
  const candidates = [caretIndex, caretIndex - 1];
  for (const index of candidates) {
    if (!Number.isInteger(index) || index < 0 || index >= text.length) continue;
    if (!bracketPositions.has(index)) continue;
    active.add(index);
    if (pairByIndex.has(index)) active.add(pairByIndex.get(index));
    break;
  }
  return active;
}

function renderMcpJsonSyntaxHighlight(text, activeBracketIndices = new Set()) {
  const parts = [];
  const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  let i = 0;
  let depth = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      let end = i + 1;
      let escaped = false;
      while (end < text.length) {
        const nextCh = text[end];
        if (escaped) {
          escaped = false;
          end += 1;
          continue;
        }
        if (nextCh === '\\') {
          escaped = true;
          end += 1;
          continue;
        }
        if (nextCh === '"') {
          end += 1;
          break;
        }
        end += 1;
      }

      const rawToken = text.slice(i, end);
      let probe = end;
      while (probe < text.length && /\s/.test(text[probe])) probe += 1;
      const tokenClass = text[probe] === ':'
        ? 'tm-mcp-json-token-key'
        : 'tm-mcp-json-token-string';
      parts.push(`<span class="${tokenClass}">${escapeMcpJsonCodeHtml(rawToken)}</span>`);
      i = end;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '}' || ch === ']') {
      let rainbowDepth = depth;
      if (ch === '}' || ch === ']') {
        rainbowDepth = Math.max(depth - 1, 0);
      }
      const rainbowClass = `rb-${rainbowDepth % 7}`;
      const activeClass = activeBracketIndices.has(i) ? ' is-active' : '';
      parts.push(`<span class="tm-mcp-json-token-bracket ${rainbowClass}${activeClass}">${escapeMcpJsonCodeHtml(ch)}</span>`);
      if (ch === '{' || ch === '[') depth += 1;
      else depth = Math.max(depth - 1, 0);
      i += 1;
      continue;
    }

    if (ch === ':' || ch === ',') {
      parts.push(`<span class="tm-mcp-json-token-punctuation">${escapeMcpJsonCodeHtml(ch)}</span>`);
      i += 1;
      continue;
    }

    const tail = text.slice(i);
    const numberMatch = numberPattern.exec(tail);
    if (numberMatch) {
      const value = numberMatch[0];
      parts.push(`<span class="tm-mcp-json-token-number">${escapeMcpJsonCodeHtml(value)}</span>`);
      i += value.length;
      continue;
    }

    if (tail.startsWith('true') && !/[A-Za-z0-9_]/.test(tail[4] || '')) {
      parts.push('<span class="tm-mcp-json-token-boolean">true</span>');
      i += 4;
      continue;
    }
    if (tail.startsWith('false') && !/[A-Za-z0-9_]/.test(tail[5] || '')) {
      parts.push('<span class="tm-mcp-json-token-boolean">false</span>');
      i += 5;
      continue;
    }
    if (tail.startsWith('null') && !/[A-Za-z0-9_]/.test(tail[4] || '')) {
      parts.push('<span class="tm-mcp-json-token-null">null</span>');
      i += 4;
      continue;
    }

    parts.push(escapeMcpJsonCodeHtml(ch));
    i += 1;
  }

  return parts.join('');
}

function syncMcpJsonEditorScroll(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const textarea = panel.querySelector('#tm-mcp-json');
  const highlight = panel.querySelector('#tm-mcp-json-highlight');
  if (!(textarea instanceof HTMLTextAreaElement) || !(highlight instanceof HTMLElement)) return;
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
}

function syncMcpJsonAssistFromTextarea(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const textarea = panel.querySelector('#tm-mcp-json');
  const highlight = panel.querySelector('#tm-mcp-json-highlight');
  if (
    !(textarea instanceof HTMLTextAreaElement) ||
    !(highlight instanceof HTMLElement)
  ) return;
  const source = textarea.value || '';
  const displaySource = source.endsWith('\n') ? `${source}\u200b` : source;
  const active = resolveMcpJsonActiveBracketIndices(source, textarea.selectionStart ?? source.length);
  highlight.innerHTML = renderMcpJsonSyntaxHighlight(displaySource, active);
  syncMcpJsonEditorScroll(panel);
}

function applyMcpJsonAutoFormat(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const textarea = panel.querySelector('#tm-mcp-json');
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const rawText = textarea.value || '';
  const text = rawText.trim();
  if (!text) {
    setMcpJsonParseStatus(panel, '等待输入 JSON 配置', 'neutral');
    syncMcpJsonAssistFromTextarea(panel);
    return;
  }

  try {
    const parsed = JSON.parse(text);
    const formatted = JSON.stringify(parsed, null, 2);
    const changed = formatted !== rawText;
    if (changed) {
      textarea.value = formatted;
      const nextPos = Math.min(formatted.length, textarea.selectionStart ?? formatted.length);
      textarea.selectionStart = nextPos;
      textarea.selectionEnd = nextPos;
    }
    setMcpJsonParseStatus(panel, changed ? 'JSON 解析成功，已自动格式化' : 'JSON 解析成功', 'ok');
    syncMcpJsonAssistFromTextarea(panel);
  } catch (error) {
    setMcpJsonParseStatus(panel, `JSON 解析失败：${formatMcpJsonParseErrorMessage(rawText, error)}`, 'error');
    syncMcpJsonAssistFromTextarea(panel);
  }
}

function scheduleMcpJsonAutoFormat(panel) {
  if (!(panel instanceof HTMLElement)) return;
  if (panel.__tmMcpJsonAutoFormatTimer) {
    window.clearTimeout(panel.__tmMcpJsonAutoFormatTimer);
  }
  panel.__tmMcpJsonAutoFormatTimer = window.setTimeout(() => {
    applyMcpJsonAutoFormat(panel);
  }, 260);
}

function cancelMcpJsonAutoFormat(panel) {
  if (!(panel instanceof HTMLElement)) return;
  if (!panel.__tmMcpJsonAutoFormatTimer) return;
  window.clearTimeout(panel.__tmMcpJsonAutoFormatTimer);
  panel.__tmMcpJsonAutoFormatTimer = 0;
}

function hideMcpDeleteConfirm(panel = getMcpPanelElement()) {
  if (!(panel instanceof HTMLElement)) return;
  const confirmBox = panel.querySelector('#tm-mcp-delete-confirm');
  if (!(confirmBox instanceof HTMLElement)) return;
  confirmBox.style.display = 'none';
  confirmBox.setAttribute('data-server-id', '');
  confirmBox.setAttribute('data-server-name', '');
}

function showMcpDeleteConfirm(panel, serverId, serverName, anchorElement) {
  if (!(panel instanceof HTMLElement)) return;
  const confirmBox = panel.querySelector('#tm-mcp-delete-confirm');
  const confirmText = panel.querySelector('#tm-mcp-delete-confirm-text');
  if (!(confirmBox instanceof HTMLElement) || !(confirmText instanceof HTMLElement)) return;

  const safeServerId = toSafeString(serverId);
  if (!safeServerId) return;
  const safeServerName = toSafeString(serverName) || safeServerId;
  confirmBox.setAttribute('data-server-id', safeServerId);
  confirmBox.setAttribute('data-server-name', safeServerName);
  confirmText.textContent = `删除 ${safeServerName}？`;

  if (anchorElement instanceof HTMLElement) {
    const panelRect = panel.getBoundingClientRect();
    const anchorRect = anchorElement.getBoundingClientRect();
    const top = Math.max(56, Math.round(anchorRect.bottom - panelRect.top + 6));
    const right = Math.max(10, Math.round(panelRect.right - anchorRect.right));
    confirmBox.style.top = `${top}px`;
    confirmBox.style.right = `${right}px`;
  } else {
    confirmBox.style.top = '64px';
    confirmBox.style.right = '12px';
  }

  confirmBox.style.display = 'flex';
}

function ensureMcpPanel() {
  const existing = getMcpPanelElement();
  if (existing) return existing;
  bindMcpPanelViewportListeners();

  const panel = document.createElement('div');
  panel.id = 'tm-mcp-panel';
  panel.style.cssText = [
    'position:fixed',
    'left:16px',
    'top:16px',
    'z-index:2147483000',
    'width:min(540px,calc(100vw - 32px))',
    'max-height:min(72vh,680px)',
    'display:flex',
    'flex-direction:column',
    'border:1px solid rgba(0,0,0,.15)',
    'border-radius:12px',
    'background:#fff',
    'box-shadow:0 12px 30px rgba(0,0,0,.18)',
    'overflow:hidden',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif'
  ].join(';');

  panel.innerHTML = `
    <style>
      #tm-mcp-panel .tm-mcp-tab {
        border: 1px solid rgba(0,0,0,.15);
        background: #fff;
        border-radius: 8px;
        padding: 6px 12px;
        font-size: 12px;
        color: #475467;
        cursor: pointer;
        transition: all .16s ease;
      }
      #tm-mcp-panel .tm-mcp-tab:hover {
        background: #f8fafc;
      }
      #tm-mcp-panel .tm-mcp-tab.is-active {
        background: #111;
        border-color: #111;
        color: #fff;
      }
      #tm-mcp-panel .tm-mcp-tool-count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 36px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        border: 1px solid #d5d9e1;
        background: #f2f4f7;
        color: #475467;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: 0.2px;
        font-variant-numeric: tabular-nums;
      }
      #tm-mcp-panel .tm-mcp-tool-count-badge.is-idle {
        border-color: #d5d9e1;
        background: #f2f4f7;
        color: #475467;
      }
      #tm-mcp-panel .tm-mcp-tool-count-badge.is-active {
        border-color: #bfdbfe;
        background: #eff6ff;
        color: #1d4ed8;
      }
      #tm-mcp-panel .tm-mcp-server-delete-btn {
        border: none;
        background: transparent;
        color: #f04438;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        border-radius: 6px;
        padding: 0;
        transition: color .15s ease, background .15s ease, transform .15s ease;
      }
      #tm-mcp-panel .tm-mcp-server-delete-btn:hover {
        color: #b42318;
        background: rgba(240, 68, 56, 0.08);
        transform: translateY(-1px);
      }
      #tm-mcp-panel .tm-mcp-server-delete-btn:focus-visible {
        outline: 2px solid rgba(240, 68, 56, 0.28);
        outline-offset: 1px;
      }
      #tm-mcp-panel .tm-mcp-json-editor {
        position: relative;
        width: 100%;
        height: 180px;
        border: 1px solid rgba(0,0,0,.2);
        border-radius: 10px;
        background: #fff;
        overflow: hidden;
      }
      #tm-mcp-panel .tm-mcp-json-highlight,
      #tm-mcp-panel .tm-mcp-json-input {
        position: absolute;
        inset: 0;
        margin: 0;
        padding: 8px;
        white-space: pre;
        font-size: 12px;
        line-height: 1.5;
        font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        overflow: auto;
        tab-size: 2;
      }
      #tm-mcp-panel .tm-mcp-json-highlight {
        pointer-events: none;
        color: #101828;
      }
      #tm-mcp-panel .tm-mcp-json-input {
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: transparent;
        caret-color: #111827;
        -webkit-text-fill-color: transparent;
        overflow-wrap: normal;
        word-break: normal;
      }
      #tm-mcp-panel .tm-mcp-json-input::placeholder {
        color: #98a2b3;
        opacity: 1;
        -webkit-text-fill-color: #98a2b3;
      }
      #tm-mcp-panel .tm-mcp-json-input::selection {
        background: rgba(37, 99, 235, 0.2);
        color: transparent;
        -webkit-text-fill-color: transparent;
      }
      #tm-mcp-panel .tm-mcp-json-input::-moz-selection {
        background: rgba(37, 99, 235, 0.2);
        color: transparent;
      }
      #tm-mcp-panel .tm-mcp-json-input:focus-visible {
        outline: 2px solid rgba(2, 132, 199, 0.35);
        outline-offset: -2px;
      }
      #tm-mcp-panel #tm-mcp-json-parse-status {
        font-size: 11px;
        color: #667085;
        min-height: 14px;
      }
      #tm-mcp-panel .tm-mcp-json-token-key {
        color: #1d4ed8;
      }
      #tm-mcp-panel .tm-mcp-json-token-string {
        color: #067647;
      }
      #tm-mcp-panel .tm-mcp-json-token-number {
        color: #b54708;
      }
      #tm-mcp-panel .tm-mcp-json-token-boolean {
        color: #7a2e98;
      }
      #tm-mcp-panel .tm-mcp-json-token-null {
        color: #475467;
      }
      #tm-mcp-panel .tm-mcp-json-token-punctuation {
        color: #98a2b3;
      }
      #tm-mcp-panel .tm-mcp-json-token-bracket {
        font-weight: 700;
      }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-0 { color: #1d4ed8; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-1 { color: #7c3aed; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-2 { color: #0f766e; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-3 { color: #b45309; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-4 { color: #be123c; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-5 { color: #6d28d9; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.rb-6 { color: #0369a1; }
      #tm-mcp-panel .tm-mcp-json-token-bracket.is-active {
        background: rgba(251, 191, 36, 0.35);
        border-radius: 3px;
      }
      #tm-mcp-panel .tm-mcp-delete-confirm {
        position: absolute;
        display: none;
        flex-direction: column;
        gap: 8px;
        min-width: 180px;
        max-width: 260px;
        padding: 10px;
        background: #fff;
        border: 1px solid rgba(0,0,0,.14);
        border-radius: 10px;
        box-shadow: 0 10px 20px rgba(16,24,40,.18);
        z-index: 10;
      }
      #tm-mcp-panel .tm-mcp-delete-confirm-text {
        font-size: 12px;
        color: #101828;
      }
      #tm-mcp-panel .tm-mcp-delete-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      #tm-mcp-panel .tm-mcp-delete-confirm-btn {
        border: 1px solid rgba(0,0,0,.14);
        background: #fff;
        color: #344054;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 11px;
        cursor: pointer;
      }
      #tm-mcp-panel .tm-mcp-delete-confirm-btn.is-danger {
        border-color: rgba(240,68,56,.3);
        color: #b42318;
        background: rgba(240,68,56,.08);
      }
      #tm-mcp-panel .tm-mcp-tab-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #tm-mcp-panel .tm-mcp-policy-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #tm-mcp-panel .tm-mcp-policy-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      #tm-mcp-panel .tm-mcp-policy-field label {
        font-size: 11px;
        color: #475467;
      }
      #tm-mcp-panel .tm-mcp-policy-field input {
        border: 1px solid rgba(0,0,0,.2);
        border-radius: 8px;
        background: #fff;
        color: #111;
        height: 30px;
        padding: 0 8px;
        font-size: 12px;
      }
      #tm-mcp-panel .tm-mcp-policy-field input:focus-visible {
        outline: 2px solid rgba(2, 132, 199, 0.35);
        outline-offset: 1px;
      }
      @media (max-width: 640px) {
        #tm-mcp-panel .tm-mcp-policy-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.1);">
      <div style="font-size:13px;font-weight:600;color:#111;">MCP 工具配置</div>
      <button id="tm-mcp-close" type="button" style="border:none;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#666;">×</button>
    </div>
    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto;">
      <div role="tablist" aria-label="MCP 配置面板标签页" style="display:flex;gap:8px;">
        <button type="button" class="tm-mcp-tab is-active" data-mcp-tab="config" role="tab" aria-selected="true">配置</button>
        <button type="button" class="tm-mcp-tab" data-mcp-tab="tools" role="tab" aria-selected="false">工具</button>
      </div>
      <section class="tm-mcp-tab-panel" data-mcp-tab-panel="config" role="tabpanel" aria-hidden="false">
        <div style="font-size:12px;color:#667085;">MCP工具配置：（type 仅支持 sse 和 streamable-http）</div>
        <div class="tm-mcp-json-editor">
          <pre id="tm-mcp-json-highlight" class="tm-mcp-json-highlight" aria-hidden="true"></pre>
          <textarea id="tm-mcp-json" class="tm-mcp-json-input" wrap="off"></textarea>
        </div>
        <div id="tm-mcp-json-parse-status">等待输入 JSON 配置</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div class="tm-mcp-policy-grid">
            <div class="tm-mcp-policy-field">
              <label for="tm-mcp-tool-retries">失败重试次数</label>
              <input id="tm-mcp-tool-retries" type="number" min="0" max="20" step="1" value="${MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES}">
            </div>
            <div class="tm-mcp-policy-field">
              <label for="tm-mcp-tool-timeout-seconds">单次调用超时（秒）</label>
              <input id="tm-mcp-tool-timeout-seconds" type="number" min="5" max="600" step="1" value="${Math.floor(MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS / 1000)}">
            </div>
            <div class="tm-mcp-policy-field">
              <label for="tm-mcp-tool-result-max-chars">工具返回最大字符数（0=返回所有内容；默认0）</label>
              <input id="tm-mcp-tool-result-max-chars" type="number" min="0" max="${MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS}" step="1000" value="${MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS}" placeholder="0 ~ ${MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS}">
            </div>
            <div class="tm-mcp-policy-field">
              <label for="tm-mcp-tool-max-auto-rounds">连续自动工具调用上限（0=不限制；默认 ${MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS}）</label>
              <input id="tm-mcp-tool-max-auto-rounds" type="number" min="0" max="${MCP_TOOL_POLICY_MAX_AUTO_ROUNDS}" step="1" value="${MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS}" placeholder="0 ~ ${MCP_TOOL_POLICY_MAX_AUTO_ROUNDS}">
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-tm-mcp-action="save" style="border:none;background:#111;color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">保存配置并拉取工具</button>
        </div>
      </section>
      <section class="tm-mcp-tab-panel" data-mcp-tab-panel="tools" role="tabpanel" aria-hidden="true" style="display:none;">
        <div style="font-size:12px;color:#667085;">保存配置时会自动拉取每个 MCP 的工具列表。</div>
        <div id="tm-mcp-tool-list" style="display:flex;flex-direction:column;gap:10px;"></div>
      </section>
      <div id="tm-mcp-status" style="font-size:12px;color:#475467;min-height:16px;"></div>
    </div>
    <div id="tm-mcp-delete-confirm" class="tm-mcp-delete-confirm">
      <div id="tm-mcp-delete-confirm-text" class="tm-mcp-delete-confirm-text">确认删除？</div>
      <div class="tm-mcp-delete-confirm-actions">
        <button type="button" class="tm-mcp-delete-confirm-btn" data-tm-mcp-action="cancel-delete-server">取消</button>
        <button type="button" class="tm-mcp-delete-confirm-btn is-danger" data-tm-mcp-action="delete-server">删除</button>
      </div>
    </div>
  `;

  panel.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.id === 'tm-mcp-close') {
      state.mcpPanelOpen = false;
      removeMcpPanel();
      updateMcpButtonState();
      return;
    }

    const tabButton = target.closest('[data-mcp-tab]');
    if (tabButton) {
      setMcpPanelTab(panel, tabButton.getAttribute('data-mcp-tab'));
      return;
    }

    const action = target.closest('[data-tm-mcp-action]');
    if (action) {
      const actionType = action.getAttribute('data-tm-mcp-action');
      if (
        actionType === 'confirm-delete-server' ||
        actionType === 'cancel-delete-server' ||
        actionType === 'delete-server'
      ) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (actionType === 'save') {
        void saveMcpConfigFromPanel();
      } else if (actionType === 'confirm-delete-server') {
        const serverId = toSafeString(action.getAttribute('data-server-id'));
        const serverName = toSafeString(action.getAttribute('data-server-name'));
        showMcpDeleteConfirm(panel, serverId, serverName, action);
      } else if (actionType === 'cancel-delete-server') {
        hideMcpDeleteConfirm(panel);
      } else if (actionType === 'delete-server') {
        const confirmBox = panel.querySelector('#tm-mcp-delete-confirm');
        const serverId = toSafeString(confirmBox?.getAttribute('data-server-id'));
        hideMcpDeleteConfirm(panel);
        if (serverId) void deleteMcpServerFromPanel(serverId);
      }
      return;
    }

    const foldSummary = target.closest('[data-mcp-fold-toggle]');
    if (foldSummary instanceof HTMLElement) {
      const detailNode = foldSummary.closest('details[data-server-id]');
      if (detailNode instanceof HTMLDetailsElement) {
        const serverId = toSafeString(detailNode.getAttribute('data-server-id'));
        if (serverId) {
          const nextSet = state.mcpExpandedServerIds instanceof Set ? state.mcpExpandedServerIds : new Set();
          window.setTimeout(() => {
            if (detailNode.open) nextSet.add(serverId);
            else nextSet.delete(serverId);
            state.mcpExpandedServerIds = nextSet;
          }, 0);
        }
      }
    }

    const confirmBox = panel.querySelector('#tm-mcp-delete-confirm');
    if (confirmBox instanceof HTMLElement && !confirmBox.contains(target)) {
      hideMcpDeleteConfirm(panel);
    }
  });

  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'checkbox') return;
    const serverId = toSafeString(target.getAttribute('data-server-id'));
    const bulkAction = toSafeString(target.getAttribute('data-tool-bulk'));
    if (serverId && bulkAction) {
      if (bulkAction === 'all') {
        void toggleMcpServerToolsAll(serverId, target.checked);
        return;
      }
      if (bulkAction === 'none') {
        if (target.checked) {
          void toggleMcpServerToolsAll(serverId, false);
          return;
        }
        // “全不选”复选框作为快捷动作入口，取消勾选时回退到真实状态。
        renderMcpPanel();
        return;
      }
      return;
    }
    const toolName = toSafeString(target.getAttribute('data-tool-name'));
    if (!serverId || !toolName) return;
    void toggleMcpToolEnabled(serverId, toolName, target.checked);
  });

  document.body.appendChild(panel);
  const textarea = panel.querySelector('#tm-mcp-json');
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.placeholder = MCP_CONFIG_PLACEHOLDER_TEXT;
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    textarea.addEventListener('input', (event) => {
      syncMcpJsonAssistFromTextarea(panel);
      if (
        event instanceof InputEvent &&
        (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')
      ) {
        cancelMcpJsonAutoFormat(panel);
        return;
      }
      scheduleMcpJsonAutoFormat(panel);
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const nextValue = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
      textarea.value = nextValue;
      const cursor = start + 2;
      textarea.selectionStart = cursor;
      textarea.selectionEnd = cursor;
      syncMcpJsonAssistFromTextarea(panel);
      scheduleMcpJsonAutoFormat(panel);
    });
    textarea.addEventListener('scroll', () => {
      syncMcpJsonEditorScroll(panel);
    });
    textarea.addEventListener('click', () => {
      syncMcpJsonAssistFromTextarea(panel);
    });
    textarea.addEventListener('mouseup', () => {
      syncMcpJsonAssistFromTextarea(panel);
    });
    textarea.addEventListener('focus', () => {
      syncMcpJsonAssistFromTextarea(panel);
    });
    textarea.addEventListener('select', () => {
      syncMcpJsonAssistFromTextarea(panel);
    });
    textarea.addEventListener('keyup', () => {
      syncMcpJsonAssistFromTextarea(panel);
    });
  }
  syncMcpJsonAssistFromTextarea(panel);
  setMcpPanelTab(panel, MCP_PANEL_TAB_CONFIG);
  repositionMcpPanel(panel);
  return panel;
}

function renderMcpPanel() {
  if (!state.mcpPanelOpen) return;
  const panel = ensureMcpPanel();
  setMcpPanelTab(panel, getMcpPanelActiveTab(panel));
  const textarea = panel.querySelector('#tm-mcp-json');
  const retriesInput = panel.querySelector('#tm-mcp-tool-retries');
  const timeoutInput = panel.querySelector('#tm-mcp-tool-timeout-seconds');
  const resultMaxCharsInput = panel.querySelector('#tm-mcp-tool-result-max-chars');
  const maxAutoRoundsInput = panel.querySelector('#tm-mcp-tool-max-auto-rounds');
  const toolList = panel.querySelector('#tm-mcp-tool-list');
  if (
    !(textarea instanceof HTMLTextAreaElement) ||
    !(toolList instanceof HTMLElement) ||
    !(retriesInput instanceof HTMLInputElement) ||
    !(timeoutInput instanceof HTMLInputElement) ||
    !(resultMaxCharsInput instanceof HTMLInputElement) ||
    !(maxAutoRoundsInput instanceof HTMLInputElement)
  ) return;

  textarea.value = stringifyMcpConfig(state.mcpConfig);
  syncMcpJsonAssistFromTextarea(panel);
  const toolPolicy = normalizeMcpToolPolicy(state.mcpConfig.toolPolicy);
  retriesInput.value = String(toolPolicy.maxRetries);
  timeoutInput.value = String(Math.max(5, Math.floor(toolPolicy.timeoutMs / 1000)));
  resultMaxCharsInput.value = String(Math.max(0, toolPolicy.resultMaxChars));
  maxAutoRoundsInput.value = String(Math.max(0, toolPolicy.maxAutoRounds));
  hideMcpDeleteConfirm(panel);
  const servers = state.mcpConfig.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    toolList.innerHTML = '<div style=\"font-size:12px;color:#667085;\">暂无服务配置。请先在“配置”页填写并保存配置。</div>';
    repositionMcpPanel(panel);
    return;
  }

  toolList.innerHTML = servers.map((server) => {
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const enabledSet = new Set(Array.isArray(server.enabledTools) ? server.enabledTools : []);
    const expandedSet = state.mcpExpandedServerIds instanceof Set ? state.mcpExpandedServerIds : new Set();
    const fetchMeta = state.mcpDiscoveredToolsByServer?.[server.id];
    const totalToolCount = tools.length;
    const enabledToolCount = tools.reduce((count, tool) => (
      enabledSet.has(tool.name) ? count + 1 : count
    ), 0);
    const safeServerId = escapeHtmlText(server.id);
    const safeServerName = escapeHtmlText(server.name);
    const safeServerUrl = escapeHtmlText(server.url || '');
    const safeType = escapeHtmlText(server.type || MCP_TRANSPORT_STREAMABLE_HTTP);
    const safeStdioCommand = escapeHtmlText([server.command, ...(server.args || [])].filter(Boolean).join(' '));
    const safeDeleteLabel = escapeHtmlText(`删除 ${server.name || server.id}`);
    const badgeStateClass = enabledToolCount > 0 ? 'is-active' : 'is-idle';
    const shouldOpen = expandedSet.has(server.id);
    const allToolsEnabled = totalToolCount > 0 && enabledToolCount === totalToolCount;
    const noToolsEnabled = enabledToolCount === 0;
    const hasPartialToolSelection = enabledToolCount > 0 && enabledToolCount < totalToolCount;
    const toolsHtml = tools.length > 0
      ? `
        <div style=\"display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:1px dashed rgba(0,0,0,.14);border-radius:8px;background:#f9fafb;\">
          <span style=\"font-size:11px;color:#667085;\">批量选择</span>
          <span style=\"display:flex;align-items:center;gap:12px;flex-wrap:wrap;\">
            <label style=\"display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#111;cursor:pointer;\">
              <input type=\"checkbox\" data-server-id=\"${safeServerId}\" data-tool-bulk=\"all\" ${allToolsEnabled ? 'checked' : ''} ${hasPartialToolSelection ? 'data-indeterminate=\"true\"' : ''}>
              <span>全选</span>
            </label>
            <label style=\"display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#111;cursor:pointer;\">
              <input type=\"checkbox\" data-server-id=\"${safeServerId}\" data-tool-bulk=\"none\" ${noToolsEnabled ? 'checked' : ''}>
              <span>全不选</span>
            </label>
          </span>
        </div>
        ${tools.map((tool) => {
          const checked = enabledSet.has(tool.name) ? 'checked' : '';
          const safeName = escapeHtmlText(tool.name);
          const safeDesc = escapeHtmlText(tool.description || '');
          return `
            <label style=\"display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid rgba(0,0,0,.08);border-radius:8px;\">
              <input type=\"checkbox\" data-server-id=\"${safeServerId}\" data-tool-name=\"${safeName}\" ${checked} style=\"margin-top:2px;\">
              <span style=\"display:flex;flex-direction:column;gap:2px;\">
                <span style=\"font-size:12px;color:#111;font-weight:600;\">${safeName}</span>
                <span style=\"font-size:11px;color:#667085;\">${safeDesc || '无描述'}</span>
              </span>
            </label>
          `;
        }).join('')}
      `
      : server.type === MCP_TRANSPORT_STDIO
        ? '<div style=\"font-size:11px;color:#667085;\">浏览器扩展不支持 stdio 直连，请改用远程 streamable-http/sse 网关。</div>'
        : fetchMeta?.ok === false
          ? `<div style=\"font-size:11px;color:#b42318;\">${escapeHtmlText(fetchMeta.error || '工具拉取失败')}</div>`
          : '<div style=\"font-size:11px;color:#667085;\">保存配置后会自动拉取工具。</div>';

    return `
      <details data-server-id=\"${safeServerId}\" ${shouldOpen ? 'open' : ''} style=\"border:1px solid rgba(0,0,0,.1);border-radius:10px;padding:0;overflow:hidden;background:#fff;\">
        <summary data-mcp-fold-toggle=\"1\" style=\"display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:#f8fafc;\">
          <span style=\"display:flex;flex-direction:column;gap:2px;min-width:0;\">
            <span style=\"font-size:12px;font-weight:600;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\">${safeServerName} (${safeServerId})</span>
            <span style=\"font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\">${server.type === MCP_TRANSPORT_STDIO ? (safeStdioCommand || '未配置 command') : (safeServerUrl || '未配置 URL')}</span>
          </span>
          <span style=\"display:flex;align-items:center;gap:8px;flex-shrink:0;\">
            <span style=\"font-size:11px;color:#667085;white-space:nowrap;\">${safeType}</span>
            <span class=\"tm-mcp-tool-count-badge ${badgeStateClass}\" title=\"已启用/总工具\">${enabledToolCount}/${totalToolCount}</span>
            <button
              type=\"button\"
              class=\"tm-mcp-server-delete-btn\"
              data-tm-mcp-action=\"confirm-delete-server\"
              data-server-id=\"${safeServerId}\"
              data-server-name=\"${safeServerName}\"
              title=\"${safeDeleteLabel}\"
              aria-label=\"${safeDeleteLabel}\">
              <svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">
                <path d=\"M3 6h18\" />
                <path d=\"M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2\" />
                <path d=\"M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6\" />
                <path d=\"M10 11v6\" />
                <path d=\"M14 11v6\" />
              </svg>
            </button>
          </span>
        </summary>
        <div style=\"border-top:1px solid rgba(0,0,0,.08);padding:8px;display:flex;flex-direction:column;gap:6px;\">${toolsHtml}</div>
      </details>
    `;
  }).join('');
  toolList.querySelectorAll('input[type="checkbox"][data-tool-bulk="all"]').forEach((inputNode) => {
    if (!(inputNode instanceof HTMLInputElement)) return;
    inputNode.indeterminate = inputNode.getAttribute('data-indeterminate') === 'true';
  });
  repositionMcpPanel(panel);
}

async function autoDiscoverMcpToolsForCurrentConfig() {
  const nextConfig = normalizeMcpConfig(state.mcpConfig);
  const previousMeta = state.mcpDiscoveredToolsByServer && typeof state.mcpDiscoveredToolsByServer === 'object'
    ? state.mcpDiscoveredToolsByServer
    : {};
  const nextMeta = {};
  const failedServers = [];

  for (let index = 0; index < nextConfig.servers.length; index += 1) {
    const server = nextConfig.servers[index];
    const response = await sendRuntimeMessage({
      type: 'MCP_TOOLS_DISCOVER',
      serverId: server.id
    });

    if (!response?.ok) {
      nextConfig.servers[index].tools = [];
      nextMeta[server.id] = {
        ok: false,
        error: toSafeString(response?.error) || 'unknown error',
        fetchedAt: Date.now(),
        toolCount: 0
      };
      failedServers.push(`${server.id}: ${response?.error || 'unknown error'}`);
      continue;
    }

    const tools = Array.isArray(response.tools)
      ? response.tools.map(normalizeMcpTool).filter(Boolean)
      : [];
    nextConfig.servers[index].tools = tools;

    const existingEnabled = new Set(Array.isArray(nextConfig.servers[index].enabledTools) ? nextConfig.servers[index].enabledTools : []);
    nextConfig.servers[index].enabledTools = tools
      .map((tool) => tool.name)
      .filter((name) => existingEnabled.has(name));

    nextMeta[server.id] = {
      ok: true,
      error: '',
      fetchedAt: Number.isFinite(previousMeta?.[server.id]?.fetchedAt) ? previousMeta[server.id].fetchedAt : Date.now(),
      toolCount: tools.length
    };
  }

  state.mcpConfig = nextConfig;
  state.mcpDiscoveredToolsByServer = nextMeta;
  state.mcpExpandedServerIds = new Set(nextConfig.servers.map((server) => server.id));
  renderMcpPanel();
  const panel = getMcpPanelElement();
  if (panel) setMcpPanelTab(panel, MCP_PANEL_TAB_TOOLS);
  updateMcpButtonState();
  syncMcpStateToPage();

  return { failedServers };
}

async function saveMcpConfigFromPanel() {
  if (state.mcpPanelBusy) return;
  const parsed = parseMcpConfigFromPanel();
  if (!parsed.ok) {
    setMcpPanelStatus(parsed.error, true);
    return;
  }

  state.mcpPanelBusy = true;
  setMcpPanelStatus('正在保存配置...');

  const response = await sendRuntimeMessage({
    type: 'MCP_CONFIG_SAVE',
    config: parsed.config
  });

  if (!response?.ok) {
    state.mcpPanelBusy = false;
    setMcpPanelStatus(`保存失败：${response?.error || 'unknown error'}`, true);
    return;
  }

  state.mcpConfig = normalizeMcpConfig(response.config);
  state.mcpEnabledToolsByServer = response.enabledToolsByServer && typeof response.enabledToolsByServer === 'object'
    ? response.enabledToolsByServer
    : {};
  setMcpPanelStatus('配置已保存，正在自动拉取工具...');
  const discovery = await autoDiscoverMcpToolsForCurrentConfig();
  state.mcpPanelBusy = false;
  if (discovery.failedServers.length > 0) {
    setMcpPanelStatus(`已保存；部分 MCP 拉取失败：${discovery.failedServers.join(' | ')}`, true);
    return;
  }
  setMcpPanelStatus('配置已保存并已自动拉取工具');
}

async function deleteMcpServerFromPanel(serverId) {
  const targetServerId = toSafeString(serverId);
  if (!targetServerId) return;
  if (state.mcpPanelBusy) return;

  const targetServer = state.mcpConfig.servers.find((item) => item.id === targetServerId);
  if (!targetServer) {
    setMcpPanelStatus(`未找到服务：${targetServerId}`, true);
    return;
  }

  state.mcpPanelBusy = true;
  setMcpPanelStatus(`正在删除 ${targetServerId}...`);

  const nextConfig = normalizeMcpConfig({
    servers: state.mcpConfig.servers.filter((item) => item.id !== targetServerId),
    toolPolicy: normalizeMcpToolPolicy(state.mcpConfig.toolPolicy),
    updatedAt: Date.now()
  });

  const response = await sendRuntimeMessage({
    type: 'MCP_CONFIG_SAVE',
    config: nextConfig
  });

  state.mcpPanelBusy = false;
  if (!response?.ok) {
    setMcpPanelStatus(`删除失败：${response?.error || 'unknown error'}`, true);
    return;
  }

  state.mcpConfig = normalizeMcpConfig(response.config);
  state.mcpEnabledToolsByServer = response.enabledToolsByServer && typeof response.enabledToolsByServer === 'object'
    ? response.enabledToolsByServer
    : {};
  state.mcpDiscoveredToolsByServer = response.discoveredToolsByServer && typeof response.discoveredToolsByServer === 'object'
    ? response.discoveredToolsByServer
    : {};
  state.mcpExpandedServerIds = new Set(
    (state.mcpConfig.servers || [])
      .filter((item) => (state.mcpExpandedServerIds instanceof Set ? state.mcpExpandedServerIds.has(item.id) : false))
      .map((item) => item.id)
  );

  renderMcpPanel();
  updateMcpButtonState();
  syncMcpStateToPage();
  setMcpPanelStatus(`已删除服务 ${targetServerId}`);
}

async function toggleMcpToolEnabled(serverId, toolName, nextEnabled) {
  const server = state.mcpConfig.servers.find((item) => item.id === serverId);
  if (!server) return;

  const previousEnabledTools = Array.isArray(server.enabledTools) ? [...server.enabledTools] : [];
  const set = new Set(Array.isArray(server.enabledTools) ? server.enabledTools : []);
  if (nextEnabled) set.add(toolName);
  else set.delete(toolName);
  server.enabledTools = Array.from(set);
  state.mcpEnabledToolsByServer = {
    ...(state.mcpEnabledToolsByServer && typeof state.mcpEnabledToolsByServer === 'object' ? state.mcpEnabledToolsByServer : {}),
    [serverId]: [...server.enabledTools]
  };
  // 勾选后立即反映到徽章与注入提示，失败再回滚。
  renderMcpPanel();
  syncMcpStateToPage();
  updateMcpButtonState();

  const response = await sendRuntimeMessage({
    type: 'MCP_TOOLS_SET_ENABLED',
    serverId,
    enabledTools: server.enabledTools
  });

  if (!response?.ok) {
    server.enabledTools = previousEnabledTools;
    state.mcpEnabledToolsByServer = {
      ...(state.mcpEnabledToolsByServer && typeof state.mcpEnabledToolsByServer === 'object' ? state.mcpEnabledToolsByServer : {}),
      [serverId]: [...previousEnabledTools]
    };
    renderMcpPanel();
    syncMcpStateToPage();
    updateMcpButtonState();
    setMcpPanelStatus(`工具状态保存失败：${response?.error || 'unknown error'}`, true);
    return;
  }

  state.mcpEnabledToolsByServer = response.enabledToolsByServer && typeof response.enabledToolsByServer === 'object'
    ? response.enabledToolsByServer
    : state.mcpEnabledToolsByServer;
  renderMcpPanel();
  setMcpPanelStatus(`已更新 ${serverId} 的工具启用列表`);
}

async function toggleMcpServerToolsAll(serverId, enableAll) {
  const server = state.mcpConfig.servers.find((item) => item.id === serverId);
  if (!server) return;

  const toolNames = Array.isArray(server.tools)
    ? server.tools.map((tool) => toSafeString(tool?.name)).filter(Boolean)
    : [];
  if (toolNames.length === 0) {
    setMcpPanelStatus(`${serverId} 暂无可操作工具`, true);
    return;
  }

  const previousEnabledTools = Array.isArray(server.enabledTools) ? [...server.enabledTools] : [];
  const nextEnabledTools = enableAll ? [...toolNames] : [];
  const previousSet = new Set(previousEnabledTools);
  const unchanged = previousEnabledTools.length === nextEnabledTools.length
    && nextEnabledTools.every((name) => previousSet.has(name));
  if (unchanged) {
    setMcpPanelStatus(enableAll ? `${serverId} 已是全选状态` : `${serverId} 已是全不选状态`);
    renderMcpPanel();
    return;
  }

  server.enabledTools = nextEnabledTools;
  state.mcpEnabledToolsByServer = {
    ...(state.mcpEnabledToolsByServer && typeof state.mcpEnabledToolsByServer === 'object' ? state.mcpEnabledToolsByServer : {}),
    [serverId]: [...nextEnabledTools]
  };
  // 批量操作先乐观刷新，失败再回滚。
  renderMcpPanel();
  syncMcpStateToPage();
  updateMcpButtonState();

  const response = await sendRuntimeMessage({
    type: 'MCP_TOOLS_SET_ENABLED',
    serverId,
    enabledTools: nextEnabledTools
  });

  if (!response?.ok) {
    server.enabledTools = previousEnabledTools;
    state.mcpEnabledToolsByServer = {
      ...(state.mcpEnabledToolsByServer && typeof state.mcpEnabledToolsByServer === 'object' ? state.mcpEnabledToolsByServer : {}),
      [serverId]: [...previousEnabledTools]
    };
    renderMcpPanel();
    syncMcpStateToPage();
    updateMcpButtonState();
    setMcpPanelStatus(`批量更新失败：${response?.error || 'unknown error'}`, true);
    return;
  }

  state.mcpEnabledToolsByServer = response.enabledToolsByServer && typeof response.enabledToolsByServer === 'object'
    ? response.enabledToolsByServer
    : state.mcpEnabledToolsByServer;
  renderMcpPanel();
  setMcpPanelStatus(enableAll ? `已全选 ${serverId} 的工具` : `已取消全选 ${serverId} 的工具`);
}

function toggleMcpPanel() {
  state.mcpPanelOpen = !state.mcpPanelOpen;
  if (!state.mcpPanelOpen) {
    removeMcpPanel();
    updateMcpButtonState();
    return;
  }

  state.mcpExpandedServerIds = new Set();
  renderMcpPanel();
  updateMcpButtonState();
  void refreshMcpConfigFromBackground();
}
