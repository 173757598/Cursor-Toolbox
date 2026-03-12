// Bridge MCP runner: tool-code execution loop and run indicator UI

'use strict';

const MCP_TOOL_EVENT_DEDUPE_WINDOW_MS = 12 * 1000;
const MCP_AUTO_SEND_READY_TIMEOUT_MS = 12 * 1000;
const MCP_AUTO_SEND_POLL_MS = 120;
const MCP_TOOL_CANCELLED_BY_USER_ERROR = '工具调用已由用户手动暂停，本次未返回执行结果。';
const MCP_RESULT_TRUNCATE_SUFFIX = '...[truncated]';
const MCP_MERGED_TOOL_TRIGGER_DEDUPE_WINDOW_MS = 18 * 1000;
const TOOL_FORMAT_RETRY_SEND_TIMEOUT_MS = 18 * 1000;
const TOOL_FORMAT_RETRY_DEDUPE_WINDOW_MS = 15 * 1000;
const TOOL_FORMAT_RETRY_DEFAULT_MESSAGE = '请用用户最新规定的工具调用格式调用工具，而不是用系统规定的调用格式';
const CONTINUE_FROM_CUTOFF_FALLBACK_MESSAGE = [
  '请从上次截断的地方继续输出，不用从头开始。',
  '必须直接从断点后的下一个字符继续。',
  '如果断点在代码块内部，不要重新输出开头 ``` 或 ~~~，直接续写代码内容。'
].join('');
const CONTINUE_CUTOFF_TAIL_MAX_CHARS = 360;
const TOOL_CALL_START_PREFIX = '[TM_TOOL_CALL_START:';
const TOOL_CALL_END_PREFIX = '[TM_TOOL_CALL_END:';
const TOOL_CALL_MARKER_SUFFIX = ']';
let autoContinueFromCutoffInFlightAnchorToken = '';

function getActiveContinuationState() {
  const source = state?.streamContinuation;
  if (!source || typeof source !== 'object') return null;
  if (source.active !== true) return null;
  const sessionKey = toSafeString(source.sessionKey);
  const anchorToken = toSafeString(source.anchorToken);
  const tailText = toSafeString(source.tailText);
  if (!sessionKey || !anchorToken || !tailText) return null;
  return source;
}

function normalizeToolCallTokenList(tokens, { maxItems = 64 } = {}) {
  if (!Array.isArray(tokens) || tokens.length <= 0) return [];
  const safeMaxItems = Number.isFinite(maxItems)
    ? Math.max(1, Math.trunc(maxItems))
    : 64;
  const normalized = tokens
    .map((token) => toSafeString(token).trim())
    .filter((token) => isSafeToolCallToken(token));
  if (normalized.length <= safeMaxItems) return normalized;
  return normalized.slice(normalized.length - safeMaxItems);
}

function resetStreamContinuationState(options = {}) {
  const preserveToolCallState = options?.preserveToolCallState === true;
  const previous = state?.streamContinuation;
  const previousTrackerSessionKey = normalizeApiConversationKey(
    toSafeString(previous?.toolCallTrackerSessionKey) || toSafeString(previous?.sessionKey)
  );
  let toolCallOpenTokens = preserveToolCallState
    ? normalizeToolCallTokenList(previous?.toolCallOpenTokens)
    : [];
  const previousPendingToken = toSafeString(previous?.pendingToolCallToken).trim();
  if (preserveToolCallState
    && isSafeToolCallToken(previousPendingToken)
    && !toolCallOpenTokens.includes(previousPendingToken)) {
    toolCallOpenTokens = normalizeToolCallTokenList(toolCallOpenTokens.concat(previousPendingToken));
  }
  const pendingToolCallToken = toolCallOpenTokens.length > 0
    ? toSafeString(toolCallOpenTokens[toolCallOpenTokens.length - 1])
    : '';

  state.streamContinuation = {
    active: false,
    sessionKey: '',
    anchorToken: '',
    tailText: '',
    toolCallInProgress: Boolean(pendingToolCallToken),
    pendingToolCallToken,
    toolCallOpenTokens,
    toolCallTrackerSessionKey: preserveToolCallState ? previousTrackerSessionKey : '',
    updatedAt: 0,
    chainCount: 0
  };
  if (typeof updateContinueCutoffButtonUi === 'function') {
    updateContinueCutoffButtonUi();
  }
}

function updateStreamContinuationStateFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return;

  const sessionKey = normalizeApiConversationKey(toSafeString(payload.sessionKey));
  if (!sessionKey) return;
  const previousContinuation = state?.streamContinuation;
  const trackerSessionKey = normalizeApiConversationKey(
    toSafeString(previousContinuation?.toolCallTrackerSessionKey)
  );

  if (payload.receivedDoneEvent === true) {
    const active = getActiveContinuationState();
    const activeSessionKey = normalizeApiConversationKey(toSafeString(active?.sessionKey));
    const hasTrackedSession = Boolean(activeSessionKey || trackerSessionKey);
    if (!hasTrackedSession || activeSessionKey === sessionKey || trackerSessionKey === sessionKey) {
      resetStreamContinuationState();
    }
    return;
  }

  if (payload.likelyUpstreamCutoff !== true) return;
  const tailText = toSafeString(payload.cutoffTailText).trim();
  if (!tailText) return;

  const prevChainCount = Number.isFinite(state?.streamContinuation?.chainCount)
    ? Math.max(0, state.streamContinuation.chainCount)
    : 0;
  const chainCount = prevChainCount + 1;
  const compactTail = tailText.slice(-CONTINUE_CUTOFF_TAIL_MAX_CHARS);
  const anchorToken = `tmc-${shortHash(`${sessionKey}|${compactTail}|${Date.now()}|${chainCount}`)}`;
  const previousOpenTokens = trackerSessionKey === sessionKey
    ? normalizeToolCallTokenList(previousContinuation?.toolCallOpenTokens)
    : [];
  const toolCallOpenTokens = collectUnclosedToolCallTokens(toSafeString(payload.assistantText), {
    initialOpenTokens: previousOpenTokens
  });
  const pendingToolCallToken = toolCallOpenTokens.length > 0
    ? toSafeString(toolCallOpenTokens[toolCallOpenTokens.length - 1])
    : '';
  const toolCallInProgress = Boolean(pendingToolCallToken);

  state.streamContinuation = {
    active: true,
    sessionKey,
    anchorToken,
    tailText: compactTail,
    toolCallInProgress,
    pendingToolCallToken,
    toolCallOpenTokens,
    toolCallTrackerSessionKey: sessionKey,
    updatedAt: Date.now(),
    chainCount
  };
  if (typeof updateContinueCutoffButtonUi === 'function') {
    updateContinueCutoffButtonUi();
  }
  void maybeAutoContinueFromCutoff(anchorToken);
}

async function maybeAutoContinueFromCutoff(anchorToken = '') {
  if (!isPluginEnabled) return false;
  if (isAutoContinueFromCutoffEnabled !== true) return false;
  if (state?.streaming === true) return false;
  if (typeof sendContinueFromCutoffMessage !== 'function') return false;

  const active = getActiveContinuationState();
  if (!active) return false;
  const activeAnchorToken = toSafeString(active.anchorToken);
  const expectedToken = toSafeString(anchorToken) || activeAnchorToken;
  if (!activeAnchorToken || activeAnchorToken !== expectedToken) return false;
  if (autoContinueFromCutoffInFlightAnchorToken === expectedToken) return false;

  autoContinueFromCutoffInFlightAnchorToken = expectedToken;
  try {
    return await sendContinueFromCutoffMessage();
  } finally {
    if (autoContinueFromCutoffInFlightAnchorToken === expectedToken) {
      autoContinueFromCutoffInFlightAnchorToken = '';
    }
  }
}

function buildContinueFromCutoffMessage() {
  const active = getActiveContinuationState();
  if (!active) return CONTINUE_FROM_CUTOFF_FALLBACK_MESSAGE;

  const anchorToken = toSafeString(active.anchorToken);
  const tailText = toSafeString(active.tailText);
  if (!anchorToken || !tailText) return CONTINUE_FROM_CUTOFF_FALLBACK_MESSAGE;
  const toolCallInProgress = active.toolCallInProgress === true;
  const pendingToolCallToken = toSafeString(active.pendingToolCallToken);
  const ackMarker = `${CONTINUE_ACK_PREFIX}${anchorToken}${CONTINUE_MARKER_SUFFIX}`;
  const startMarker = `${CONTINUE_START_PREFIX}${anchorToken}${CONTINUE_MARKER_SUFFIX}`;
  const endMarker = `${CONTINUE_END_PREFIX}${anchorToken}${CONTINUE_MARKER_SUFFIX}`;
  const toolCallInProgressHint = toolCallInProgress && pendingToolCallToken
    ? `补充状态：检测到当前仍在工具调用中（未闭合 token: ${pendingToolCallToken}）。请牢记你现在是在调用工具，不要只顾输出普通正文；把本次工具调用所需的内容/参数写完后，在检查是否有括号、引号，或者还有其他工具参数没填完的，先填完这些括号和引号等，再输出 [TM_TOOL_CALL_END:${pendingToolCallToken}] 这个标记符来完成工具闭合，最后记得再输出 ${endMarker} 作为续写协议尾部来标记续写完毕。`
    : `补充状态：当前未检测到未闭合的工具调用 token（token: 无）。请按普通正文续写；仅当你在断点后正文中明确看到了未闭合的 [TM_TOOL_CALL_START:某个token] 时，才使用同一个实际 token 输出 [TM_TOOL_CALL_END:某个token] 完成闭合，最后再输出 ${endMarker} 作为续写协议尾部来标记续写完毕。`;

  return [
    CONTINUE_REQUEST_PREFIX,
    '上一条回答在流式输出中疑似被上游截断。这是正常现象，请严格按下面协议续写，不要重写前文。也不要换成说用简单的形式表达，就按之前的你要输出的内容往后续写就好。',
    toolCallInProgressHint,
    '必须按顺序原样输出以下标记：',
    ackMarker,
    startMarker,
    '(从上一条断点开始续写正文，只写新内容，不要解释规则)',
    endMarker,
    '要求：',
    '- START 之后的第一个字符，必须是断点后的下一个字符',
    '- 只在 START 与 END 之间写续写正文',
    '- 续写完成后必须输出 END 标记（续写协议尾部），严禁省略',
    '- 不要重复锚点之前已经输出的内容',
    '- 如果断点在未闭合代码块内：直接续写代码内容，不要重新输出 opening fence（```/~~~）',
    '- 只有在续写内容确实需要闭合当前代码块时，才输出对应 closing fence',
    '- 如需代码块或工具调用，按正常格式输出在正文中',
    '- 如果再次被截断，下次会基于新的锚点继续',
    '',
    '断点前最后文本片段（用于定位，不要整段复述）：',
    '[TAIL_SNIPPET_BEGIN]',
    tailText,
    '[TAIL_SNIPPET_END]'
  ].join('');
}

function collectUnclosedToolCallTokens(text, { initialOpenTokens = [] } = {}) {
  const source = toSafeString(text);
  const openTokens = normalizeToolCallTokenList(initialOpenTokens);
  if (!source) return openTokens;
  const markerRegex = /\[TM_TOOL_CALL_(START|END):([a-z0-9_-]{4,80})\]/ig;
  let match = null;

  while ((match = markerRegex.exec(source))) {
    const markerType = toSafeString(match[1]).toUpperCase();
    const token = toSafeString(match[2]).trim();
    if (!isSafeToolCallToken(token)) continue;

    if (markerType === 'START') {
      openTokens.push(token);
      continue;
    }

    const closeIndex = openTokens.lastIndexOf(token);
    if (closeIndex >= 0) {
      openTokens.splice(closeIndex, 1);
    }
  }

  return normalizeToolCallTokenList(openTokens);
}

function getLastUnclosedToolCallToken(text, { initialOpenTokens = [] } = {}) {
  const openTokens = collectUnclosedToolCallTokens(text, { initialOpenTokens });
  return openTokens.length > 0 ? toSafeString(openTokens[openTokens.length - 1]) : '';
}

function isSafeToolCallToken(token) {
  return /^[a-z0-9_-]{4,80}$/i.test(String(token || ''));
}

function findToolCallMarker(source, markerPrefix, { fromIndex = 0, expectedToken = '' } = {}) {
  const text = String(source || '');
  let cursor = Math.max(0, fromIndex);
  while (cursor < text.length) {
    const startIndex = text.indexOf(markerPrefix, cursor);
    if (startIndex < 0) return null;
    const tokenStart = startIndex + markerPrefix.length;
    const tokenEnd = text.indexOf(TOOL_CALL_MARKER_SUFFIX, tokenStart);
    if (tokenEnd < 0) return null;
    const token = text.slice(tokenStart, tokenEnd).trim();
    const matched = isSafeToolCallToken(token)
      && (!expectedToken || token === expectedToken);
    if (matched) {
      return {
        token,
        startIndex,
        endIndex: tokenEnd + TOOL_CALL_MARKER_SUFFIX.length
      };
    }
    cursor = tokenEnd + 1;
  }
  return null;
}

function extractToolCallProtocolSegments(text, { maxSegments = 24 } = {}) {
  const source = String(text || '');
  if (!source) return [];
  const safeMaxSegments = Number.isFinite(maxSegments)
    ? Math.max(1, Math.trunc(maxSegments))
    : 24;

  const segments = [];
  let cursor = 0;
  let safety = 0;

  while (cursor < source.length && safety < safeMaxSegments) {
    const startMarker = findToolCallMarker(source, TOOL_CALL_START_PREFIX, {
      fromIndex: cursor
    });
    if (!startMarker) break;

    const endMarker = findToolCallMarker(source, TOOL_CALL_END_PREFIX, {
      fromIndex: startMarker.endIndex,
      expectedToken: startMarker.token
    });
    if (!endMarker) break;

    const code = extractFirstAwaitMcpCall(source.slice(startMarker.endIndex, endMarker.startIndex));
    if (code) {
      segments.push({
        token: startMarker.token,
        code,
        startIndex: startMarker.startIndex,
        endIndex: endMarker.endIndex
      });
    }

    cursor = endMarker.endIndex;
    safety += 1;
  }

  return segments;
}

function extractToolCallProtocolContent(text) {
  const segments = extractToolCallProtocolSegments(text, { maxSegments: 1 });
  if (segments.length <= 0) return '';
  return toSafeString(segments[0]?.code);
}

function extractFirstAwaitMcpCall(text) {
  const source = String(text || '');
  if (!source) return '';

  const startRe = /await\s+mcp\.call\(/ig;
  let startMatch = null;
  while ((startMatch = startRe.exec(source))) {
    let cursor = startMatch.index + startMatch[0].length;
    let depth = 1;
    let quote = '';
    let escaping = false;

    while (cursor < source.length) {
      const ch = source[cursor];
      if (quote) {
        if (escaping) {
          escaping = false;
          cursor += 1;
          continue;
        }
        if (ch === '\\') {
          escaping = true;
          cursor += 1;
          continue;
        }
        if (ch === quote) {
          quote = '';
        }
        cursor += 1;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        cursor += 1;
        continue;
      }
      if (ch === '(') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (ch === ')') {
        depth -= 1;
        cursor += 1;
        if (depth === 0) {
          while (cursor < source.length && /\s/.test(source[cursor])) {
            cursor += 1;
          }
          if (source[cursor] === ';') cursor += 1;
          const callText = source.slice(startMatch.index, cursor).trim();
          if (/^\s*await\s+mcp\.call\(\s*(["'])[^"']+\1\s*,[\s\S]*\)\s*;?\s*$/i.test(callText)) {
            return callText;
          }
          break;
        }
        continue;
      }
      cursor += 1;
    }
  }

  return '';
}

function extractToolCodeBlocksFromFencedCode(text, { maxBlocks = 24 } = {}) {
  const source = String(text || '');
  if (!source) return [];
  const safeMaxBlocks = Number.isFinite(maxBlocks)
    ? Math.max(1, Math.trunc(maxBlocks))
    : 24;
  const blockRe = /```[^\n`]*\r?\n([\s\S]*?)```/g;
  const codes = [];
  let match = null;
  while ((match = blockRe.exec(source)) && codes.length < safeMaxBlocks) {
    const blockContent = toSafeString(match[1]).trim();
    if (!blockContent) continue;
    const call = extractFirstAwaitMcpCall(blockContent);
    if (!call) continue;
    const normalized = blockContent.replace(/\s+/g, '');
    const normalizedCall = call.replace(/\s+/g, '');
    if (normalized !== normalizedCall) continue;
    codes.push(call);
  }
  return codes;
}

function extractToolCodeBlocks(text, { maxBlocks = 24 } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const segments = extractToolCallProtocolSegments(text, { maxSegments: maxBlocks });
  const protocolCodes = segments
    .map((segment) => toSafeString(segment?.code))
    .filter(Boolean);
  if (protocolCodes.length > 0) return protocolCodes;

  const fencedCodes = extractToolCodeBlocksFromFencedCode(text, { maxBlocks });
  if (fencedCodes.length > 0) return fencedCodes;

  const inlineCall = extractFirstAwaitMcpCall(text);
  if (inlineCall) return [inlineCall];
  return [];
}

function extractToolCodeBlock(text) {
  const codes = extractToolCodeBlocks(text, { maxBlocks: 1 });
  return codes.length > 0 ? codes[0] : null;
}

function maybeExecuteToolCodeFromMergedAssistant(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!isPluginEnabled) return false;

  const sessionKey = normalizeApiConversationKey(toSafeString(payload.sessionKey));
  const assistantText = toSafeString(payload.assistantText);
  if (!sessionKey || !assistantText) return false;

  const toolCodes = extractToolCodeBlocks(assistantText);
  if (toolCodes.length <= 0) return false;
  const mergedCodeFingerprint = toolCodes.join('\n[TM_TOOL_CALL_SPLIT]\n');

  const fingerprint = shortHash(`${sessionKey}|${mergedCodeFingerprint}`);
  const now = Date.now();
  const lastFingerprint = toSafeString(state.mcpMergedToolTriggerLastFingerprint);
  const lastAt = Number.isFinite(state.mcpMergedToolTriggerLastAt)
    ? state.mcpMergedToolTriggerLastAt
    : 0;
  if (lastFingerprint === fingerprint && (now - lastAt) < MCP_MERGED_TOOL_TRIGGER_DEDUPE_WINDOW_MS) {
    return false;
  }

  state.mcpMergedToolTriggerLastFingerprint = fingerprint;
  state.mcpMergedToolTriggerLastAt = now;
  void executeToolCodeAndContinue({
    sessionKey,
    assistantText,
    toolCodes
  });
  return true;
}

function stringifyToolResultForModel(value) {
  const seen = new WeakSet();
  const json = JSON.stringify(
    value,
    (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]';
        seen.add(nested);
      }
      return nested;
    },
    2
  );
  const toolPolicy = typeof normalizeMcpToolPolicy === 'function'
    ? normalizeMcpToolPolicy(state?.mcpConfig?.toolPolicy)
    : { resultMaxChars: MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS };
  const maxChars = Number.isFinite(toolPolicy?.resultMaxChars)
    ? Math.max(0, Math.trunc(toolPolicy.resultMaxChars))
    : MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS;
  if (maxChars <= 0 || json.length <= maxChars) return json;
  if (maxChars <= MCP_RESULT_TRUNCATE_SUFFIX.length) {
    return MCP_RESULT_TRUNCATE_SUFFIX.slice(0, maxChars);
  }

  const keep = maxChars - MCP_RESULT_TRUNCATE_SUFFIX.length;
  return `${json.slice(0, keep)}${MCP_RESULT_TRUNCATE_SUFFIX}`;
}

function formatToolExecutionResultForModel(result) {
  const status = result?.ok ? 'ok' : 'error';
  const toolRef = toSafeString(result?.toolRef) || 'unknown';
  const payload = result?.ok
    ? {
        status,
        toolRef,
        data: result?.data ?? null
      }
    : {
        status,
        toolRef,
        error: toSafeString(result?.error) || 'Tool execution failed'
      };
  const payloadJson = stringifyToolResultForModel(payload);

  return [
    '[MCP_TOOL_RESULT]',
    `status: ${status}`,
    `tool: ${toolRef}`,
    'result_json:',
    payloadJson,
    '',
    'This payload is machine context. Never paste it verbatim to the user.',
    'Continue your response based on the tool result above.',
    'Do NOT output XML tool tags such as <tool_response>, <function_calls>, or <invoke>.',
    'Do NOT echo back result_json or large JSON blobs — summarize key conclusions for the user.',
    'If another tool call is needed, output exactly this protocol (no markdown code fence):',
    '[TM_TOOL_CALL_START:tool-1]',
    'await mcp.call("serverId/toolName", {"key":"value"})',
    '[TM_TOOL_CALL_END:tool-1]',
    'Use the same token in START/END and output only one await mcp.call(...) between markers.',
    'Otherwise, provide your final answer directly.'
  ].join('\n');
}

function formatToolExecutionResultsForModel(results) {
  const source = Array.isArray(results)
    ? results.filter((item) => item && typeof item === 'object')
    : [];
  if (source.length <= 1) {
    return formatToolExecutionResultForModel(source[0] || {
      ok: false,
      toolRef: 'unknown',
      error: 'Tool execution failed'
    });
  }

  const normalized = source.map((item) => {
    const status = item?.ok ? 'ok' : 'error';
    const toolRef = toSafeString(item?.toolRef) || 'unknown';
    if (status === 'ok') {
      return {
        status,
        toolRef,
        data: item?.data ?? null
      };
    }
    return {
      status,
      toolRef,
      error: toSafeString(item?.error) || 'Tool execution failed'
    };
  });

  const okCount = normalized.filter((item) => item.status === 'ok').length;
  const errorCount = Math.max(0, normalized.length - okCount);
  const status = errorCount <= 0 ? 'ok' : 'error';
  const payload = {
    status,
    toolRef: `batch/${normalized.length}`,
    summary: {
      total: normalized.length,
      ok: okCount,
      error: errorCount
    },
    results: normalized
  };
  const payloadJson = stringifyToolResultForModel(payload);

  return [
    '[MCP_TOOL_RESULT]',
    `status: ${status}`,
    `tool: batch/${normalized.length}`,
    'result_json:',
    payloadJson,
    '',
    'This payload is machine context. Never paste it verbatim to the user.',
    'Continue your response based on the tool result above.',
    'Do NOT output XML tool tags such as <tool_response>, <function_calls>, or <invoke>.',
    'Do NOT echo back result_json or large JSON blobs — summarize key conclusions for the user.',
    'If another tool call is needed, output exactly this protocol (no markdown code fence):',
    '[TM_TOOL_CALL_START:tool-1]',
    'await mcp.call("serverId/toolName", {"key":"value"})',
    '[TM_TOOL_CALL_END:tool-1]',
    'Use the same token in START/END and output only one await mcp.call(...) between markers.',
    'Otherwise, provide your final answer directly.'
  ].join('\n');
}

function setTextareaValue(textarea, nextValue) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, nextValue);
  } else {
    textarea.value = nextValue;
  }
}

function scheduleMcpToolResultBubbleUpgrade(messageText) {
  const source = toSafeString(messageText).trimStart();
  if (!source.startsWith(TM_FAB_MCP_TOOL_RESULT_PREFIX)) return;
  if (typeof ensureUserMessageMarkers !== 'function') return;

  const delays = [0, 28, 80, 150, 260, 430, 680, 980, 1380, 1960, 2620];
  for (const delay of delays) {
    window.setTimeout(() => {
      if (!isPluginEnabled) return;
      const scope = (typeof getActiveCenteredElement === 'function' ? getActiveCenteredElement() : null) || document.body;
      if (!scope) return;
      ensureUserMessageMarkers(scope);
    }, delay);
  }
}

function resolveComposerControls() {
  const textarea = typeof findComposerTextarea === 'function'
    ? findComposerTextarea()
    : document.querySelector(TEXTAREA_SELECTOR);
  const sendBtn = typeof findSendButton === 'function'
    ? (findSendButton({ allowDisabled: false }) || findSendButton())
    : null;
  return {
    textarea: textarea instanceof HTMLTextAreaElement ? textarea : null,
    sendBtn: sendBtn instanceof HTMLButtonElement ? sendBtn : null
  };
}

function isLikelyStopButton(button) {
  if (!(button instanceof HTMLButtonElement)) return false;
  const signal = normalizeSpace([
    button.textContent || '',
    button.getAttribute('aria-label') || '',
    button.getAttribute('title') || '',
    button.className || ''
  ].join(' ')).toLowerCase();
  return /(stop|停止|中止|终止|abort|cancel|取消生成|暂停)/i.test(signal);
}

function triggerComposerSend(textarea, sendBtn) {
  const stopButton = isLikelyStopButton(sendBtn);
  const buttonAvailable = sendBtn instanceof HTMLButtonElement
    && !sendBtn.disabled
    && sendBtn.getAttribute('aria-disabled') !== 'true'
    && !stopButton;
  if (buttonAvailable) {
    sendBtn.click();
    return true;
  }

  const form = textarea?.closest('form') || sendBtn?.closest?.('form') || null;
  if (form && typeof form.requestSubmit === 'function' && !stopButton) {
    try {
      form.requestSubmit(buttonAvailable ? sendBtn : undefined);
      return true;
    } catch (_error) {
      // fall through to Enter key
    }
  }

  if (!(textarea instanceof HTMLTextAreaElement) || textarea.readOnly || textarea.disabled) return false;

  const eventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  };
  const keydown = new KeyboardEvent('keydown', eventInit);
  textarea.dispatchEvent(keydown);
  textarea.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  return true;
}

function sendAutoMessageToComposer(text) {
  const { textarea, sendBtn } = resolveComposerControls();
  if (!(textarea instanceof HTMLTextAreaElement)) return false;

  setTextareaValue(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  if (!triggerComposerSend(textarea, sendBtn)) {
    return false;
  }

  scheduleMcpToolResultBubbleUpgrade(text);
  return true;
}

function waitForDuration(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
  });
}

async function sendAutoMessageToComposerWhenReady(text, options = {}) {
  const timeoutMs = Number.isFinite(options?.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : MCP_AUTO_SEND_READY_TIMEOUT_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (!isPluginEnabled) return false;
    const { textarea, sendBtn } = resolveComposerControls();
    const ready = !state.streaming
      && textarea instanceof HTMLTextAreaElement
      && !textarea.readOnly
      && !textarea.disabled;
    if (ready) {
      const sent = sendAutoMessageToComposer(text);
      if (sent) return true;
    }

    await waitForDuration(MCP_AUTO_SEND_POLL_MS);
  }
  return false;
}

function getToolFormatRetryMessage(payload) {
  const message = toSafeString(payload?.message);
  return message || TOOL_FORMAT_RETRY_DEFAULT_MESSAGE;
}

function buildToolFormatRetryFingerprint(payload, messageText) {
  const sessionKey = toSafeString(payload?.sessionKey) || 'session:unknown';
  const eventType = toSafeString(payload?.eventType).toLowerCase() || 'tool-input-start';
  const toolCallId = toSafeString(payload?.toolCallId) || 'tool:unknown';
  const messageHash = shortHash(toSafeString(messageText));
  return `${sessionKey}|${eventType}|${toolCallId}|${messageHash}`;
}

async function autoSendToolFormatRetryMessage(payload) {
  const messageText = getToolFormatRetryMessage(payload);
  const fingerprint = buildToolFormatRetryFingerprint(payload, messageText);
  const now = Date.now();

  const lastFingerprint = toSafeString(state.mcpToolFormatRetryLastFingerprint);
  const lastAt = Number.isFinite(state.mcpToolFormatRetryLastAt) ? state.mcpToolFormatRetryLastAt : 0;
  if (lastFingerprint === fingerprint && (now - lastAt) < TOOL_FORMAT_RETRY_DEDUPE_WINDOW_MS) {
    return true;
  }

  const inFlightFingerprint = toSafeString(state.mcpToolFormatRetryInFlightFingerprint);
  const inFlightPromise = state.mcpToolFormatRetryInFlightPromise;
  if (inFlightFingerprint === fingerprint && inFlightPromise && typeof inFlightPromise.then === 'function') {
    try {
      return await inFlightPromise;
    } catch (_error) {
      return false;
    }
  }

  const sendTask = (async () => {
    const sent = await sendAutoMessageToComposerWhenReady(messageText, {
      timeoutMs: TOOL_FORMAT_RETRY_SEND_TIMEOUT_MS
    });
    if (sent) {
      state.mcpToolFormatRetryLastFingerprint = fingerprint;
      state.mcpToolFormatRetryLastAt = Date.now();
    }
    return sent;
  })();

  state.mcpToolFormatRetryInFlightFingerprint = fingerprint;
  state.mcpToolFormatRetryInFlightPromise = sendTask;
  try {
    return await sendTask;
  } finally {
    if (toSafeString(state.mcpToolFormatRetryInFlightFingerprint) === fingerprint) {
      state.mcpToolFormatRetryInFlightFingerprint = '';
      state.mcpToolFormatRetryInFlightPromise = null;
    }
  }
}

function extractToolRefFromCode(code) {
  const source = toSafeString(code);
  if (!source) return '';
  const match = source.match(/await\s+mcp\.call\(\s*(["'])([^"']+)\1\s*,/i);
  if (!match || !match[2]) return '';
  return toSafeString(match[2]);
}

function isCancellationError(result) {
  if (result?.cancelled === true) return true;
  const text = toSafeString(result?.error).toLowerCase();
  if (!text) return false;
  return text.includes('cancel')
    || text.includes('abort')
    || text.includes('paused')
    || text.includes('取消')
    || text.includes('暂停')
    || text.includes('中止')
    || text.includes('终止');
}

function formatElapsedDuration(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ensureMcpRunIndicatorStyle() {
  if (document.getElementById('tm-mcp-run-indicator-style')) return;
  const style = document.createElement('style');
  style.id = 'tm-mcp-run-indicator-style';
  style.textContent = `
    #tm-mcp-run-indicator {
      display: none;
      align-items: center;
      gap: 8px;
      border-radius: 11px;
      border: 1px solid rgba(133, 124, 108, 0.32);
      background: linear-gradient(156deg, rgba(251, 249, 244, 0.97), rgba(245, 241, 232, 0.94));
      color: #383229;
      min-height: 36px;
      padding: 5px 6px 5px 7px;
      max-width: min(600px, calc(100vw - 42px));
      font-size: 12px;
      line-height: 1.35;
      box-sizing: border-box;
      box-shadow: 0 1px 2px rgba(79, 72, 62, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.62);
      margin-right: 6px;
      position: relative;
      overflow: hidden;
    }
    #tm-mcp-run-indicator.is-active {
      display: inline-flex;
    }
    #tm-mcp-run-indicator .tm-mcp-run-badge {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(122, 113, 100, 0.34);
      background: rgba(255, 255, 255, 0.66);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
      flex: 0 0 auto;
    }
    #tm-mcp-run-indicator .tm-mcp-run-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #6d6559;
      box-shadow: 0 0 0 0 rgba(109, 101, 89, 0.36);
      animation: tm-mcp-run-pulse 1.5s ease-out infinite;
    }
    #tm-mcp-run-indicator .tm-mcp-run-copy {
      display: flex;
      flex-direction: column;
      gap: 1px;
      flex: 1;
      min-width: 0;
    }
    #tm-mcp-run-indicator .tm-mcp-run-main {
      color: #3e372d;
      font-size: 11.5px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: .01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #tm-mcp-run-indicator .tm-mcp-run-meta {
      color: #7a7265;
      font-size: 11px;
      line-height: 1.2;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #tm-mcp-run-indicator .tm-mcp-run-pause {
      border: 1px solid rgba(122, 113, 100, 0.38);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.74);
      color: #433c31;
      padding: 0 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .01em;
      line-height: 1.2;
      min-width: 54px;
      min-height: 26px;
      height: 26px;
      cursor: pointer;
      flex: 0 0 auto;
      transition: background-color .18s ease, border-color .18s ease, color .18s ease, box-shadow .18s ease;
    }
    #tm-mcp-run-indicator .tm-mcp-run-pause:hover {
      background: rgba(255, 255, 255, 0.95);
      border-color: rgba(106, 97, 85, 0.52);
      color: #342f27;
    }
    #tm-mcp-run-indicator .tm-mcp-run-pause:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px rgba(74, 79, 87, 0.26);
      outline-offset: 1px;
    }
    #tm-mcp-run-indicator .tm-mcp-run-pause:disabled {
      opacity: .58;
      cursor: not-allowed;
      background: rgba(246, 242, 234, 0.88);
      color: rgba(92, 84, 74, 0.82);
    }
    textarea.tm-mcp-input-locked {
      cursor: not-allowed !important;
    }
    @keyframes tm-mcp-run-pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(109, 101, 89, 0.34);
      }
      100% {
        box-shadow: 0 0 0 8px rgba(109, 101, 89, 0);
      }
    }
    @media (max-width: 860px) {
      #tm-mcp-run-indicator {
        max-width: min(78vw, 480px);
      }
      #tm-mcp-run-indicator .tm-mcp-run-meta {
        max-width: 42vw;
      }
    }
    @media (max-width: 640px) {
      #tm-mcp-run-indicator {
        gap: 6px;
        min-height: 34px;
        padding: 4px 5px 4px 6px;
        max-width: min(92vw, 420px);
      }
      #tm-mcp-run-indicator .tm-mcp-run-main {
        font-size: 11px;
      }
      #tm-mcp-run-indicator .tm-mcp-run-meta {
        font-size: 10px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #tm-mcp-run-indicator .tm-mcp-run-dot {
        animation: none;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureMcpRunIndicator() {
  ensureMcpRunIndicatorStyle();
  let indicator = document.getElementById('tm-mcp-run-indicator');
  const indicatorMarkup = `
      <span class="tm-mcp-run-badge" aria-hidden="true"><span class="tm-mcp-run-dot"></span></span>
      <span class="tm-mcp-run-copy">
        <span class="tm-mcp-run-main"></span>
        <span class="tm-mcp-run-meta"></span>
      </span>
      <button type="button" class="tm-mcp-run-pause" aria-label="暂停工具调用">暂停</button>
    `.trim();
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'tm-mcp-run-indicator';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.innerHTML = indicatorMarkup;
  } else if (!indicator.querySelector('.tm-mcp-run-main') || !indicator.querySelector('.tm-mcp-run-meta')) {
    indicator.innerHTML = indicatorMarkup;
  }

  if (!indicator.dataset.tmMcpRunPauseBound) {
    const pauseButton = indicator.querySelector('.tm-mcp-run-pause');
    if (pauseButton instanceof HTMLButtonElement) {
      pauseButton.addEventListener('click', () => {
        void requestPauseActiveMcpToolCall();
      });
      indicator.dataset.tmMcpRunPauseBound = '1';
    }
  }

  const sendButton = findSendButton();
  if (sendButton?.parentElement) {
    const parent = sendButton.parentElement;
    if (indicator.parentNode !== parent) {
      parent.insertBefore(indicator, sendButton);
    } else if (indicator.nextSibling !== sendButton) {
      parent.insertBefore(indicator, sendButton);
    }
  } else if (!indicator.parentNode) {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    const form = textarea?.closest('form') || document.querySelector('form');
    if (form) form.insertBefore(indicator, form.firstChild);
  }

  return indicator;
}

function setComposerInputLocked(locked) {
  const textarea = typeof findComposerTextarea === 'function'
    ? findComposerTextarea()
    : document.querySelector(TEXTAREA_SELECTOR);
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  const dataKeyReadonly = 'tmMcpLockReadonly';
  const dataKeyAria = 'tmMcpLockAriaDisabled';
  if (locked) {
    if (!(dataKeyReadonly in textarea.dataset)) {
      textarea.dataset[dataKeyReadonly] = textarea.readOnly ? '1' : '0';
    }
    if (!(dataKeyAria in textarea.dataset)) {
      textarea.dataset[dataKeyAria] = textarea.getAttribute('aria-disabled') ?? '__none__';
    }
    textarea.readOnly = true;
    textarea.setAttribute('aria-disabled', 'true');
    textarea.classList.add('tm-mcp-input-locked');
    return;
  }

  if (textarea.dataset[dataKeyReadonly] === '1') textarea.readOnly = true;
  else if (textarea.dataset[dataKeyReadonly] === '0') textarea.readOnly = false;
  delete textarea.dataset[dataKeyReadonly];

  const previousAria = textarea.dataset[dataKeyAria];
  if (previousAria === '__none__') textarea.removeAttribute('aria-disabled');
  else if (typeof previousAria === 'string') textarea.setAttribute('aria-disabled', previousAria);
  delete textarea.dataset[dataKeyAria];
  textarea.classList.remove('tm-mcp-input-locked');
}

function syncMcpRunIndicatorUi() {
  let indicator = document.getElementById('tm-mcp-run-indicator');
  if (!state.mcpToolRunActive && !(indicator instanceof HTMLElement)) {
    setComposerInputLocked(false);
    return;
  }
  if (!(indicator instanceof HTMLElement)) {
    indicator = ensureMcpRunIndicator();
  } else {
    ensureMcpRunIndicatorStyle();
    const sendButton = findSendButton();
    if (sendButton?.parentElement && indicator.parentNode !== sendButton.parentElement) {
      sendButton.parentElement.insertBefore(indicator, sendButton);
    }
  }
  const mainNode = indicator.querySelector('.tm-mcp-run-main');
  const metaNode = indicator.querySelector('.tm-mcp-run-meta');
  const pauseButton = indicator.querySelector('.tm-mcp-run-pause');
  if (!(mainNode instanceof HTMLElement) || !(metaNode instanceof HTMLElement) || !(pauseButton instanceof HTMLButtonElement)) return;

  if (!state.mcpToolRunActive) {
    indicator.classList.remove('is-active');
    indicator.classList.remove('is-pausing');
    mainNode.textContent = '';
    metaNode.textContent = '';
    pauseButton.disabled = false;
    pauseButton.textContent = '暂停';
    pauseButton.setAttribute('aria-busy', 'false');
    setComposerInputLocked(false);
    return;
  }

  const elapsed = formatElapsedDuration(Date.now() - state.mcpToolRunStartedAt);
  const toolRef = state.mcpToolRunToolRef || 'unknown';
  const pausing = state.mcpToolRunPauseRequested;
  mainNode.textContent = pausing ? '正在暂停工具调用…' : '工具运行中';
  metaNode.textContent = `${toolRef} · 已用时 ${elapsed}`;
  pauseButton.disabled = state.mcpToolRunPauseRequested;
  pauseButton.textContent = state.mcpToolRunPauseRequested ? '暂停中…' : '暂停';
  pauseButton.setAttribute('aria-busy', state.mcpToolRunPauseRequested ? 'true' : 'false');
  indicator.classList.add('is-active');
  indicator.classList.toggle('is-pausing', pausing);
  setComposerInputLocked(true);
}

function startMcpToolRunUi(operationId, toolRef) {
  if (state.mcpToolRunTimer) {
    clearInterval(state.mcpToolRunTimer);
    state.mcpToolRunTimer = null;
  }
  state.mcpToolRunActive = true;
  state.mcpToolRunOperationId = toSafeString(operationId);
  state.mcpToolRunToolRef = toSafeString(toolRef) || 'unknown';
  state.mcpToolRunStartedAt = Date.now();
  state.mcpToolRunPauseRequested = false;
  state.mcpToolRunCancelNoticeSent = false;
  state.mcpToolRunCancelNoticeOperationId = '';
  state.mcpToolRunCancelRequestedOperationId = '';
  state.mcpToolRunCancelNoticeInFlightOperationId = '';
  state.mcpToolRunCancelNoticePromise = null;
  syncMcpRunIndicatorUi();
  state.mcpToolRunTimer = window.setInterval(() => {
    syncMcpRunIndicatorUi();
  }, 1000);
}

function stopMcpToolRunUi(operationId = '') {
  const activeOperationId = toSafeString(state.mcpToolRunOperationId);
  const targetOperationId = toSafeString(operationId);
  if (targetOperationId && activeOperationId && targetOperationId !== activeOperationId) return;
  if (state.mcpToolRunTimer) {
    clearInterval(state.mcpToolRunTimer);
    state.mcpToolRunTimer = null;
  }
  state.mcpToolRunActive = false;
  state.mcpToolRunOperationId = '';
  state.mcpToolRunToolRef = '';
  state.mcpToolRunStartedAt = 0;
  state.mcpToolRunPauseRequested = false;
  syncMcpRunIndicatorUi();
}

function buildCancelledToolMessage(toolRef) {
  return formatToolExecutionResultForModel({
    ok: false,
    toolRef: toSafeString(toolRef) || 'unknown',
    error: MCP_TOOL_CANCELLED_BY_USER_ERROR
  });
}

function getMcpAutoMaxRoundsFromToolPolicy() {
  const toolPolicy = typeof normalizeMcpToolPolicy === 'function'
    ? normalizeMcpToolPolicy(state?.mcpConfig?.toolPolicy)
    : { maxAutoRounds: MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS };
  const maxAutoRounds = Number.isFinite(toolPolicy?.maxAutoRounds)
    ? Math.max(0, Math.trunc(toolPolicy.maxAutoRounds))
    : MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS;
  return maxAutoRounds;
}

function buildAutoToolLoopLimitErrorMessage(maxAutoRounds) {
  return [
    `连续工具调用已达到安全上限（${maxAutoRounds} 轮），本轮自动执行已暂停。`,
    '请先基于现有结果给出阶段性结论，必要时再发起下一轮工具调用。'
  ].join('');
}

function hasCancelledNoticeBeenSentForOperation(operationId) {
  const safeOperationId = toSafeString(operationId);
  if (!safeOperationId) return false;
  if (state.mcpToolRunCancelNoticeSent !== true) return false;
  return toSafeString(state.mcpToolRunCancelNoticeOperationId) === safeOperationId;
}

function markCancelledNoticeSentForOperation(operationId) {
  const safeOperationId = toSafeString(operationId);
  if (!safeOperationId) return;
  state.mcpToolRunCancelNoticeSent = true;
  state.mcpToolRunCancelNoticeOperationId = safeOperationId;
}

function isUserRequestedCancellationForOperation(operationId) {
  const safeOperationId = toSafeString(operationId);
  if (!safeOperationId) return false;
  return safeOperationId === toSafeString(state.mcpToolRunCancelRequestedOperationId);
}

async function sendCancelledToolMessageOnce(operationId, toolRef) {
  const safeOperationId = toSafeString(operationId);
  if (!safeOperationId) return false;
  if (hasCancelledNoticeBeenSentForOperation(safeOperationId)) return true;

  const inFlightOperationId = toSafeString(state.mcpToolRunCancelNoticeInFlightOperationId);
  const inFlightPromise = state.mcpToolRunCancelNoticePromise;
  if (inFlightOperationId === safeOperationId && inFlightPromise && typeof inFlightPromise.then === 'function') {
    try {
      await inFlightPromise;
    } catch (_error) {
      // ignored: caller will handle false result
    }
    return hasCancelledNoticeBeenSentForOperation(safeOperationId);
  }

  const safeToolRef = toSafeString(toolRef) || 'unknown';
  const sendTask = (async () => {
    const sent = await sendAutoMessageToComposerWhenReady(buildCancelledToolMessage(safeToolRef));
    if (sent) {
      markCancelledNoticeSentForOperation(safeOperationId);
      postToPage('CONTENT_AUTO_SEND_TOOL_RESULT', {
        ok: false,
        toolRef: safeToolRef,
        error: MCP_TOOL_CANCELLED_BY_USER_ERROR
      });
    }
    return sent;
  })();

  state.mcpToolRunCancelNoticeInFlightOperationId = safeOperationId;
  state.mcpToolRunCancelNoticePromise = sendTask;
  try {
    return await sendTask;
  } finally {
    if (toSafeString(state.mcpToolRunCancelNoticeInFlightOperationId) === safeOperationId) {
      state.mcpToolRunCancelNoticeInFlightOperationId = '';
      state.mcpToolRunCancelNoticePromise = null;
    }
  }
}

function buildToolEventFingerprint(payload, codeHash) {
  const sessionKey = toSafeString(payload?.sessionKey) || 'session:unknown';
  const assistantText = toSafeString(payload?.assistantText);
  const assistantHash = shortHash(assistantText.slice(0, 2400));
  return `${sessionKey}|${codeHash}|${assistantHash}`;
}

function shouldSkipToolExecution(payload, codeHash) {
  const now = Date.now();
  const fingerprint = buildToolEventFingerprint(payload, codeHash);
  const lastFingerprint = toSafeString(state.mcpLastToolEventFingerprint);
  const lastEventAt = Number.isFinite(state.mcpLastToolEventAt) ? state.mcpLastToolEventAt : 0;
  if (lastFingerprint && lastFingerprint === fingerprint && (now - lastEventAt) < MCP_TOOL_EVENT_DEDUPE_WINDOW_MS) {
    return {
      skip: true,
      reason: 'duplicate_event_fingerprint',
      fingerprint,
      elapsedMs: now - lastEventAt
    };
  }

  return {
    skip: false,
    reason: '',
    fingerprint
  };
}

function markToolEventSeen(payload, codeHash) {
  state.mcpLastToolEventFingerprint = buildToolEventFingerprint(payload, codeHash);
  state.mcpLastToolEventAt = Date.now();
}

function markToolExecutionSettled(payload, codeHash) {
  state.mcpLastToolHash = codeHash;
  state.mcpLastToolSessionKey = toSafeString(payload?.sessionKey);
  state.mcpLastToolExecutedAt = Date.now();
}

async function requestPauseActiveMcpToolCall() {
  if (!state.mcpToolRunActive || !state.mcpToolRunOperationId) return;
  if (state.mcpToolRunPauseRequested) return;

  state.mcpToolRunPauseRequested = true;
  syncMcpRunIndicatorUi();

  const operationId = state.mcpToolRunOperationId;
  const toolRef = state.mcpToolRunToolRef || 'unknown';
  state.mcpToolRunCancelRequestedOperationId = toSafeString(operationId);
  const response = await sendRuntimeMessage({
    type: 'MCP_TOOLCODE_CANCEL',
    operationId
  });

  if (!response?.ok) {
    state.mcpToolRunPauseRequested = false;
    if (toSafeString(state.mcpToolRunCancelRequestedOperationId) === toSafeString(operationId)) {
      state.mcpToolRunCancelRequestedOperationId = '';
    }
    syncMcpRunIndicatorUi();
    setMcpPanelStatus(`暂停失败：${toSafeString(response?.error) || 'unknown error'}`, true);
    return;
  }

  // Avoid deadlock: composer is locked as readOnly while tool-run UI is active.
  // Unlock first, then auto-send cancellation notice.
  stopMcpToolRunUi(operationId);
  if (!await sendCancelledToolMessageOnce(operationId, toolRef)) {
    console.warn('[Cursor Toolbox:MCP] failed to auto-send tool cancellation result to composer.');
  }
}

async function executeToolCodeAndContinue(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (!isPluginEnabled) return;

  const assistantText = toSafeString(payload.assistantText);
  const rawCodes = Array.isArray(payload?.toolCodes)
    ? payload.toolCodes.map((code) => toSafeString(code)).filter(Boolean)
    : extractToolCodeBlocks(assistantText);
  if (rawCodes.length <= 0) return;
  const mergedCodes = rawCodes.join('\n[TM_TOOL_CALL_SPLIT]\n');
  const executionFingerprint = shortHash(`${toSafeString(payload?.sessionKey)}|${mergedCodes}`);
  if (state.mcpAutoInFlight) {
    const queuedFingerprint = toSafeString(state.mcpPendingExecutionFingerprint);
    if (queuedFingerprint !== executionFingerprint) {
      state.mcpPendingExecutionPayload = {
        ...payload,
        assistantText,
        toolCodes: rawCodes
      };
      state.mcpPendingExecutionFingerprint = executionFingerprint;
    }
    return;
  }
  state.mcpPendingExecutionPayload = null;
  state.mcpPendingExecutionFingerprint = '';

  const codeHash = shortHash(mergedCodes);
  const dedupe = shouldSkipToolExecution(payload, codeHash);
  if (dedupe.skip) {
    console.warn('[Cursor Toolbox:MCP] skip duplicate tool_code event.', dedupe.reason);
    return;
  }
  const maxAutoRounds = getMcpAutoMaxRoundsFromToolPolicy();
  if (maxAutoRounds > 0 && state.mcpAutoRoundCount >= maxAutoRounds) {
    const loopLimitError = buildAutoToolLoopLimitErrorMessage(maxAutoRounds);
    const loopGuardToolRef = 'cursor-toolbox/loop-guard';
    const loopGuardMessage = formatToolExecutionResultForModel({
      ok: false,
      toolRef: loopGuardToolRef,
      error: loopLimitError
    });
    console.warn(`[Cursor Toolbox:MCP] tool loop exceeded max rounds (${maxAutoRounds}).`);
    setMcpPanelStatus(loopLimitError, true);
    postToPage('CONTENT_AUTO_SEND_TOOL_RESULT', {
      ok: false,
      toolRef: loopGuardToolRef,
      error: loopLimitError
    });
    if (!await sendAutoMessageToComposerWhenReady(loopGuardMessage)) {
      console.warn('[Cursor Toolbox:MCP] failed to auto-send tool loop-limit result to composer.');
    }
    resetMcpRuntimeState();
    return;
  }

  markToolEventSeen(payload, codeHash);
  state.mcpAutoInFlight = true;
  const round = state.mcpAutoRoundCount + 1;
  const batchSeed = mergedCodes;
  const operationBaseId = `mcp-${Date.now()}-${shortHash(`${batchSeed}|${round}|${Math.random()}`).slice(0, 8)}`;
  const executionResults = [];
  const totalToolCalls = rawCodes.length;
  let activeOperationId = '';
  let uiStopped = false;
  const stopUiOnce = () => {
    if (uiStopped) return;
    stopMcpToolRunUi(activeOperationId);
    uiStopped = true;
  };
  const updateActiveToolRunStep = (operationId, toolRef, index) => {
    const safeOperationId = toSafeString(operationId);
    const safeToolRef = toSafeString(toolRef) || 'unknown';
    const displayRef = totalToolCalls > 1
      ? `${safeToolRef} (${index + 1}/${totalToolCalls})`
      : safeToolRef;

    activeOperationId = safeOperationId;
    if (!state.mcpToolRunActive) {
      startMcpToolRunUi(safeOperationId, displayRef);
      return;
    }

    state.mcpToolRunOperationId = safeOperationId;
    state.mcpToolRunToolRef = displayRef;
    state.mcpToolRunPauseRequested = false;
    syncMcpRunIndicatorUi();
  };

  try {
    for (let index = 0; index < rawCodes.length; index += 1) {
      const rawCode = rawCodes[index];
      const operationId = `${operationBaseId}-${index + 1}`;
      const toolRef = extractToolRefFromCode(rawCode);

      if (toSafeString(state.mcpToolRunCancelRequestedOperationId)
        && toSafeString(state.mcpToolRunCancelRequestedOperationId) !== operationId) {
        state.mcpToolRunCancelRequestedOperationId = '';
      }
      updateActiveToolRunStep(operationId, toolRef, index);

      const response = await sendRuntimeMessage({
        type: 'MCP_TOOLCODE_EXECUTE',
        tabId: Number.isInteger(payload?.tabId) ? payload.tabId : undefined,
        round,
        operationId,
        code: rawCode,
        context: {
          url: window.location.href,
          sessionKey: toSafeString(payload?.sessionKey)
        }
      });

      if (!response || response.ok === false) {
        const cancellationError = isCancellationError(response);
        const userRequestedCancellation = cancellationError && isUserRequestedCancellationForOperation(operationId);
        if (userRequestedCancellation) {
          stopUiOnce();
          const cancelledToolRef = response?.toolRef || toolRef || '';
          if (!await sendCancelledToolMessageOnce(operationId, cancelledToolRef)) {
            console.warn('[Cursor Toolbox:MCP] failed to auto-send tool cancellation result to composer.');
          }
          state.mcpAutoRoundCount = round;
          markToolExecutionSettled(payload, codeHash);
          return;
        }

        const failedResult = {
          ok: false,
          toolRef: response?.toolRef || toolRef || '',
          error: response?.error || 'Tool execution failed'
        };
        executionResults.push(failedResult);
        postToPage('CONTENT_AUTO_SEND_TOOL_RESULT', {
          ok: false,
          toolRef: failedResult.toolRef,
          error: failedResult.error
        });
        continue;
      }

      const successResult = {
        ok: true,
        toolRef: response.toolRef || toolRef || '',
        data: response.data || null
      };
      executionResults.push(successResult);
      postToPage('CONTENT_AUTO_SEND_TOOL_RESULT', {
        ok: true,
        toolRef: successResult.toolRef,
        data: successResult.data
      });
    }

    if (executionResults.length <= 0) {
      stopUiOnce();
      state.mcpAutoRoundCount = round;
      markToolExecutionSettled(payload, codeHash);
      return;
    }

    const toolMessage = formatToolExecutionResultsForModel(executionResults);
    stopUiOnce();
    if (!await sendAutoMessageToComposerWhenReady(toolMessage)) {
      console.warn('[Cursor Toolbox:MCP] failed to auto-send tool result to composer.');
      state.mcpAutoRoundCount = round;
      markToolExecutionSettled(payload, codeHash);
      return;
    }

    state.mcpAutoRoundCount = round;
    markToolExecutionSettled(payload, codeHash);
  } finally {
    if (!uiStopped) {
      stopMcpToolRunUi(activeOperationId);
    }
    state.mcpAutoInFlight = false;
    const queuedPayload = state.mcpPendingExecutionPayload;
    state.mcpPendingExecutionPayload = null;
    state.mcpPendingExecutionFingerprint = '';
    if (queuedPayload && typeof queuedPayload === 'object' && isPluginEnabled) {
      void executeToolCodeAndContinue(queuedPayload);
    }
  }
}

function onPageMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE_PAGE || !data.type) return;

  if (data.type === 'PAGE_HOOK_READY') {
    state.pageHookReady = true;
    syncEnabledStateToPage();
    syncThinkingInjectionStateToPage();
    syncGlobalPromptInstructionStateToPage();
    syncMcpStateToPage();
    kickstartFeatureRecovery('page_hook_ready');
    return;
  }

  if (data.type === 'PAGE_HOOK_CHAT_REQUEST') {
    if (isPluginEnabled) {
      upsertSessionFromApiRequest(data.payload);
    }
    return;
  }

  if (data.type === 'PAGE_HOOK_STREAM_START') {
    const startSessionKey = normalizeApiConversationKey(toSafeString(data.payload?.sessionKey));
    const activeContinuation = getActiveContinuationState();
    const activeContinuationSessionKey = normalizeApiConversationKey(
      toSafeString(activeContinuation?.sessionKey)
    );
    const trackerSessionKey = normalizeApiConversationKey(
      toSafeString(state?.streamContinuation?.toolCallTrackerSessionKey)
    );
    const trackedSessionKey = activeContinuationSessionKey || trackerSessionKey;
    if (trackedSessionKey && startSessionKey && trackedSessionKey !== startSessionKey) {
      resetStreamContinuationState();
    }
    state.streaming = true;
    stopDomObserver();
    clearReconcileTimer();
    clearAutoExpandTimer();
    clearStartupRecoveryTimer();
    clearSessionSyncTimer();
    if (isPluginEnabled) {
      renderSessionSidebar();
    }
    if (typeof updateContinueCutoffButtonUi === 'function') {
      updateContinueCutoffButtonUi();
    }
    return;
  }

  if (data.type === 'PAGE_HOOK_STREAM_DONE') {
    const assistantText = typeof data.payload?.assistantText === 'string'
      ? data.payload.assistantText
      : '';
    const streamHasDoneEvent = data.payload?.receivedDoneEvent === true;
    const interruptedByToolCode = data.payload?.cutByToolCode === true;
    const shouldRenderAfterStreamDone = streamHasDoneEvent || interruptedByToolCode;
    state.streaming = false;
    if (typeof updateContinueCutoffButtonUi === 'function') {
      updateContinueCutoffButtonUi();
    }
    if (isPluginEnabled) {
      finalizeSessionFromApiStream(data.payload);
      updateStreamContinuationStateFromPayload(data.payload);
      renderSessionSidebar();
      if (shouldRenderAfterStreamDone) {
        scheduleThinkingRender(false);
        scheduleToolCodeRender(false);
        scheduleReconcile('stream_done', 80);
      }
      startDomObserver();
      scheduleStartupRecovery(false);
      if (SESSION_CAPTURE_MODE !== 'api') {
        scheduleSessionSync(120);
      }
    }

    if (extractToolCodeBlocks(assistantText).length <= 0 && !state.mcpAutoInFlight && !state.mcpToolRunActive) {
      resetMcpRuntimeState();
    }
    return;
  }

  if (data.type === 'PAGE_HOOK_TOOLCODE_FOUND') {
    if (isPluginEnabled) {
      void executeToolCodeAndContinue(data.payload);
    }
    return;
  }

  if (data.type === 'PAGE_HOOK_TOOL_FORMAT_RETRY_REQUIRED') {
    if (isPluginEnabled) {
      void (async () => {
        const sent = await autoSendToolFormatRetryMessage(data.payload);
        if (!sent) {
          console.warn('[Cursor Toolbox:MCP] failed to auto-send tool format retry user message.');
        }
      })();
    }
    return;
  }

  if (!isPluginEnabled) return;

  if (data.type === 'PAGE_HOOK_LOG' && data.payload?.message) {
    console.log('[Cursor Toolbox:PageHook]', data.payload.message);
  }
}
