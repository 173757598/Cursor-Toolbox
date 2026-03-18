// Thinking renderer, plugin lifecycle, and initialization

'use strict';

let thinkingBlockIdCounter = 0;
const THINKING_START_MARKERS = ['<thinking>', '&lt;thinking&gt;'];
const THINKING_END_MARKERS = ['</thinking>', '&lt;/thinking&gt;'];
const TOOL_CODE_CLASS_MARKERS = ['language-tool_code', 'lang-tool_code', 'tool_code'];
const ASSISTANT_MCP_LEAK_PREFIX = '[MCP_TOOL_RESULT]';
const RUNTIME_TOOL_CALL_START_PREFIX = '[TM_TOOL_CALL_START:';
const RUNTIME_TOOL_CALL_END_PREFIX = '[TM_TOOL_CALL_END:';
const RUNTIME_TOOL_CALL_MARKER_SUFFIX = ']';
const ASSISTANT_CONTINUATION_FRAGMENT_ATTR = 'data-tm-assistant-continuation-fragment';
const ASSISTANT_CONTINUATION_FRAGMENT_ID_ATTR = 'data-tm-assistant-continuation-fragment-id';
const ASSISTANT_CONTINUATION_MERGED_ATTR = 'data-tm-assistant-continuation-merged';
const ASSISTANT_CONTINUATION_TARGET_IDS_ATTR = 'data-tm-assistant-continuation-ids';
const ASSISTANT_CONTINUATION_SOURCE_HIDDEN_CLASS = 'tm-assistant-continuation-source-hidden';
const processedToolCodePre = new WeakSet();

function generateThinkingBlockId() {
  return `tm-thinking-${Date.now()}-${thinkingBlockIdCounter++}`;
}

function isProseContainer(el) {
  if (!el || !el.classList) return false;
  for (const cls of el.classList) {
    if (cls === 'prose' || cls.startsWith('prose-')) return true;
  }
  return false;
}

function findThinkingMarker(container, markers, { fromEnd = false } = {}) {
  if (!container) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node || !node.nodeValue) continue;
    textNodes.push(node);
  }
  if (textNodes.length === 0) return null;

  const scanNodes = fromEnd ? textNodes.reverse() : textNodes;
  for (const node of scanNodes) {
    const source = node.nodeValue.toLowerCase();
    let best = null;

    for (const marker of markers) {
      const markerLower = marker.toLowerCase();
      const idx = fromEnd ? source.lastIndexOf(markerLower) : source.indexOf(markerLower);
      if (idx === -1) continue;
      if (!best) {
        best = { index: idx, marker };
        continue;
      }
      if (!fromEnd && idx < best.index) best = { index: idx, marker };
      if (fromEnd && idx > best.index) best = { index: idx, marker };
    }

    if (best) {
      return {
        node,
        index: best.index,
        marker: best.marker
      };
    }
  }

  return null;
}

function isValidThinkingMarkerPair(startMatch, endMatch) {
  if (!startMatch || !endMatch) return false;

  if (startMatch.node === endMatch.node) {
    return startMatch.index + startMatch.marker.length <= endMatch.index;
  }

  const relation = startMatch.node.compareDocumentPosition(endMatch.node);
  return Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
}

function insertPlaceholderAtMarker(match, placeholderLabel) {
  if (!match?.node || !match.node.parentNode) return null;

  let markerNode = match.node;
  if (match.index > 0) {
    markerNode = markerNode.splitText(match.index);
  }

  if (match.marker.length < markerNode.nodeValue.length) {
    markerNode.splitText(match.marker.length);
  }

  const placeholder = document.createComment(placeholderLabel);
  markerNode.parentNode.insertBefore(placeholder, markerNode);
  markerNode.remove();
  return placeholder;
}

function insertPlaceholdersForSameTextNode(startMatch, endMatch) {
  if (!startMatch?.node || startMatch.node !== endMatch?.node) return null;
  const node = startMatch.node;
  const parent = node.parentNode;
  if (!parent) return null;

  const source = node.nodeValue || '';
  const before = source.slice(0, startMatch.index);
  const middle = source.slice(startMatch.index + startMatch.marker.length, endMatch.index);
  const after = source.slice(endMatch.index + endMatch.marker.length);

  const startPlaceholder = document.createComment('tm-thinking-start');
  const endPlaceholder = document.createComment('tm-thinking-end');

  if (before) parent.insertBefore(document.createTextNode(before), node);
  parent.insertBefore(startPlaceholder, node);
  if (middle) parent.insertBefore(document.createTextNode(middle), node);
  parent.insertBefore(endPlaceholder, node);
  if (after) parent.insertBefore(document.createTextNode(after), node);
  node.remove();

  return { startPlaceholder, endPlaceholder };
}

function normalizeEscapedBrInFragment(fragment) {
  if (!fragment) return;
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node?.nodeValue && /<br\s*\/?>/i.test(node.nodeValue)) {
      targets.push(node);
    }
  }

  for (const textNode of targets) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const parts = textNode.nodeValue.split(/<br\s*\/?>/gi);
    if (parts.length <= 1) continue;

    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) {
        parent.insertBefore(document.createTextNode(parts[i]), textNode);
      }
      if (i < parts.length - 1) {
        parent.insertBefore(document.createElement('br'), textNode);
      }
    }

    textNode.remove();
  }
}

function processThinkingInContainer(container) {
  if (!container || container.nodeType !== Node.ELEMENT_NODE) return false;
  if (container.classList?.contains('tm-thinking-block')) return false;
  if (processedThinkingContainers.has(container)) return false;

  const startMatch = findThinkingMarker(container, THINKING_START_MARKERS, { fromEnd: false });
  if (!startMatch) return false;

  const endMatch = findThinkingMarker(container, THINKING_END_MARKERS, { fromEnd: true });
  if (!endMatch) return false;
  if (!isValidThinkingMarkerPair(startMatch, endMatch)) return false;

  let startPlaceholder = null;
  let endPlaceholder = null;

  if (startMatch.node === endMatch.node) {
    const pair = insertPlaceholdersForSameTextNode(startMatch, endMatch);
    if (!pair) return false;
    startPlaceholder = pair.startPlaceholder;
    endPlaceholder = pair.endPlaceholder;
  } else {
    startPlaceholder = insertPlaceholderAtMarker(startMatch, 'tm-thinking-start');
    endPlaceholder = insertPlaceholderAtMarker(endMatch, 'tm-thinking-end');
  }

  if (!startPlaceholder || !endPlaceholder || !startPlaceholder.parentNode || !endPlaceholder.parentNode) {
    return false;
  }

  const extractionRange = document.createRange();
  extractionRange.setStartAfter(startPlaceholder);
  extractionRange.setEndBefore(endPlaceholder);
  const contentFragment = extractionRange.extractContents();
  normalizeEscapedBrInFragment(contentFragment);

  const blockId = generateThinkingBlockId();
  const thinkingBlock = document.createElement('div');
  thinkingBlock.className = 'tm-thinking-block';
  thinkingBlock.id = blockId;

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
    '</svg>' +
    '思考过程';

  const content = document.createElement('div');
  content.className = 'tm-thinking-content';
  content.appendChild(contentFragment);

  details.appendChild(summary);
  details.appendChild(content);
  thinkingBlock.appendChild(details);

  endPlaceholder.parentNode.insertBefore(thinkingBlock, endPlaceholder);
  startPlaceholder.remove();
  endPlaceholder.remove();

  processedThinkingContainers.add(container);
  return true;
}

function processThinkingInAllProseContainers(fullScan = false) {
  const candidates = document.querySelectorAll('.prose, [class^="prose-"], [class*=" prose-"]');
  const startIndex = fullScan ? 0 : Math.max(0, candidates.length - RECENT_PROSE_SCAN_LIMIT);

  for (let i = startIndex; i < candidates.length; i += 1) {
    const el = candidates[i];
    if (!isProseContainer(el)) continue;
    processThinkingInContainer(el);
  }
}

function scheduleThinkingRender(fullScan = false) {
  if (fullScan) {
    state.thinkingNeedsFullScan = true;
  }

  clearThinkingRenderTimer();
  state.thinkingRenderTimer = setTimeout(() => {
    state.thinkingRenderTimer = null;
    if (!isPluginEnabled) {
      state.thinkingNeedsFullScan = false;
      return;
    }

    const shouldFullScan = state.thinkingNeedsFullScan;
    state.thinkingNeedsFullScan = false;
    processThinkingInAllProseContainers(shouldFullScan);
  }, 180);
}

function isLikelyToolCodePre(preNode) {
  if (!(preNode instanceof Element)) return false;
  if (preNode.closest('.tm-tool-code-block')) return false;
  const codeNode = preNode.querySelector('code');
  if (!(codeNode instanceof Element)) return false;

  const classText = `${codeNode.className || ''} ${preNode.className || ''}`.toLowerCase();
  if (TOOL_CODE_CLASS_MARKERS.some((marker) => classText.includes(marker))) {
    return true;
  }

  const dataLang = `${codeNode.getAttribute('data-language') || ''} ${preNode.getAttribute('data-language') || ''}`.toLowerCase();
  if (dataLang.includes('tool_code')) return true;

  const rawText = (codeNode.textContent || '').trim();
  if (!rawText) return false;
  if (typeof extractFirstAwaitMcpCall === 'function') {
    const parsed = String(extractFirstAwaitMcpCall(rawText) || '');
    if (!parsed) return false;
    const normalizedRaw = rawText.replace(/\s+/g, '');
    const normalizedParsed = parsed.replace(/\s+/g, '');
    return normalizedRaw === normalizedParsed;
  }
  return /^\s*await\s+mcp\.call\(\s*(["'])[^"']+\1\s*,[\s\S]*\)\s*;?\s*$/i.test(rawText);
}

function createToolCodeDisclosure(rawCode) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tm-tool-code-block';

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'tm-tool-code-summary';
  const summaryMain = document.createElement('span');
  summaryMain.className = 'tm-tool-summary-main';
  summaryMain.textContent = '工具调用';
  const summaryMeta = document.createElement('span');
  summaryMeta.className = 'tm-tool-summary-meta';
  summaryMeta.textContent = '点击展开';
  summary.appendChild(summaryMain);
  summary.appendChild(summaryMeta);

  const content = document.createElement('div');
  content.className = 'tm-tool-code-content';

  const cleanPre = document.createElement('pre');
  const cleanCode = document.createElement('code');
  cleanCode.textContent = String(rawCode || '');
  cleanPre.appendChild(cleanCode);
  content.appendChild(cleanPre);
  details.appendChild(summary);
  details.appendChild(content);
  wrapper.appendChild(details);
  return wrapper;
}

function isSafeToolCallToken(token) {
  return /^[a-z0-9_-]{4,80}$/i.test(String(token || ''));
}

function findToolCallMarkerInText(source, markerPrefix, { fromIndex = 0, expectedToken = '' } = {}) {
  const text = String(source || '');
  let cursor = Math.max(0, fromIndex);
  while (cursor < text.length) {
    const startIndex = text.indexOf(markerPrefix, cursor);
    if (startIndex < 0) return null;
    const tokenStart = startIndex + markerPrefix.length;
    const tokenEnd = text.indexOf(RUNTIME_TOOL_CALL_MARKER_SUFFIX, tokenStart);
    if (tokenEnd < 0) return null;
    const token = text.slice(tokenStart, tokenEnd).trim();
    const matched = isSafeToolCallToken(token) && (!expectedToken || token === expectedToken);
    if (matched) {
      return {
        token,
        startIndex,
        endIndex: tokenEnd + RUNTIME_TOOL_CALL_MARKER_SUFFIX.length
      };
    }
    cursor = tokenEnd + 1;
  }
  return null;
}

function extractToolCallProtocolPayload(text, { requireStandalone = false } = {}) {
  const source = String(text || '');
  if (!source) return null;

  if (typeof extractToolCallProtocolSegments === 'function') {
    const segments = extractToolCallProtocolSegments(source, { maxSegments: 1 });
    const first = Array.isArray(segments) && segments.length > 0 ? segments[0] : null;
    if (first && typeof first === 'object' && typeof first.code === 'string') {
      const beforeText = source.slice(0, Number(first.startIndex) || 0);
      const afterText = source.slice(Number(first.endIndex) || 0);
      if (requireStandalone && (beforeText.trim() || afterText.trim())) {
        return null;
      }
      return {
        token: first.token,
        code: first.code,
        startIndex: Number(first.startIndex) || 0,
        endIndex: Number(first.endIndex) || 0
      };
    }
  }

  const startMarker = findToolCallMarkerInText(source, RUNTIME_TOOL_CALL_START_PREFIX);
  if (!startMarker) return null;
  const endMarker = findToolCallMarkerInText(source, RUNTIME_TOOL_CALL_END_PREFIX, {
    fromIndex: startMarker.endIndex,
    expectedToken: startMarker.token
  });
  if (!endMarker) return null;

  const beforeText = source.slice(0, startMarker.startIndex);
  const codeText = source.slice(startMarker.endIndex, endMarker.startIndex).trim();
  const afterText = source.slice(endMarker.endIndex);
  if (!/^\s*await\s+mcp\.call\(\s*(["'])[^"']+\1\s*,[\s\S]*\)\s*;?\s*$/i.test(codeText)) {
    return null;
  }
  if (requireStandalone && (beforeText.trim() || afterText.trim())) {
    return null;
  }

  return {
    token: startMarker.token,
    code: codeText.trim(),
    startIndex: startMarker.startIndex,
    endIndex: endMarker.endIndex
  };
}

function collapseToolCodeInContainer(container) {
  if (!(container instanceof Element)) return false;
  const preNodes = container.querySelectorAll('pre');
  let modified = false;

  preNodes.forEach((preNode) => {
    if (!(preNode instanceof HTMLElement)) return;
    if (processedToolCodePre.has(preNode)) return;
    if (!isLikelyToolCodePre(preNode)) return;
    const rawCode = preNode.querySelector('code')?.textContent || preNode.textContent || '';
    const wrapper = createToolCodeDisclosure(rawCode);
    preNode.replaceWith(wrapper);
    processedToolCodePre.add(preNode);
    modified = true;
  });

  return modified;
}

function resolveTextOffsetInContainer(container, targetOffset) {
  if (!(container instanceof Element)) return null;
  const offset = Math.max(0, Number(targetOffset) || 0);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let lastNode = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = String(node?.nodeValue || '').length;
    if (offset <= traversed + len) {
      return {
        node,
        offsetInNode: Math.max(0, offset - traversed)
      };
    }
    traversed += len;
    lastNode = node;
  }

  if (lastNode) {
    return {
      node: lastNode,
      offsetInNode: String(lastNode.nodeValue || '').length
    };
  }
  return null;
}

function collapseToolCallProtocolInContainer(container) {
  if (!(container instanceof Element)) return false;
  if (container.closest(USER_MESSAGE_BUBBLE_SELECTOR)) return false;
  let modified = false;
  let safety = 0;

  while (safety < 8) {
    const payload = extractToolCallProtocolPayload(container.textContent || '', { requireStandalone: false });
    if (!payload || !payload.code) break;

    const startPos = resolveTextOffsetInContainer(container, payload.startIndex);
    const endPos = resolveTextOffsetInContainer(container, payload.endIndex);
    if (!startPos || !endPos) break;

    const range = document.createRange();
    try {
      range.setStart(startPos.node, startPos.offsetInNode);
      range.setEnd(endPos.node, endPos.offsetInNode);
    } catch (_error) {
      break;
    }
    range.deleteContents();
    range.insertNode(createToolCodeDisclosure(payload.code));
    modified = true;
    safety += 1;
  }

  return modified;
}

function trimAssistantMcpLeakInContainer(container) {
  if (!(container instanceof Element)) return false;
  const rawText = String(container.textContent || '');
  if (!rawText.includes(ASSISTANT_MCP_LEAK_PREFIX)) return false;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let targetNode = null;
  let targetIndex = -1;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const idx = String(node?.nodeValue || '').indexOf(ASSISTANT_MCP_LEAK_PREFIX);
    if (idx >= 0) {
      targetNode = node;
      targetIndex = idx;
      break;
    }
  }

  if (!targetNode || targetIndex < 0) return false;

  const range = document.createRange();
  range.setStart(targetNode, targetIndex);
  range.setEnd(container, container.childNodes.length);
  range.deleteContents();
  return true;
}

function trimAssistantContinuationProtocolInContainer(container) {
  if (!(container instanceof Element)) return false;
  const rawText = String(container.textContent || '');
  if (!rawText.includes(CONTINUE_START_PREFIX)) {
    const hasContinuationMark = container.getAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ATTR) === '1';
    if (hasContinuationMark) {
      const existingFragmentId = String(container.getAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ID_ATTR) || '');
      const currentTextHash = `txt:${shortHash(rawText.slice(0, 2400))}`;
      if (existingFragmentId.includes(currentTextHash)) {
        return false;
      }
    }

    container.removeAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ATTR);
    container.removeAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ID_ATTR);
    container.removeAttribute(ASSISTANT_CONTINUATION_MERGED_ATTR);
    container.classList.remove(ASSISTANT_CONTINUATION_SOURCE_HIDDEN_CLASS);
    return false;
  }

  if (typeof extractContinuationPayload !== 'function') return false;
  const completePayload = extractContinuationPayload(rawText, {
    requireComplete: true,
    preserveWhitespace: true
  });
  const payload = completePayload || extractContinuationPayload(rawText, {
    requireComplete: false,
    preserveWhitespace: true
  });
  if (!payload || typeof payload.content !== 'string') return false;
  const isCompletePayload = payload.isComplete === true
    && payload.hasAckMarker === true
    && payload.hasEndMarker === true;
  let continuationText = payload.content;
  const token = String(payload.token || '').trim();
  if (isCompletePayload && token && typeof getCompletedContinuationContent === 'function') {
    const exactContent = getCompletedContinuationContent(token);
    if (typeof exactContent === 'string') {
      continuationText = exactContent;
    }
  }
  const textHash = `txt:${shortHash(continuationText.slice(0, 2400))}`;
  const fragmentId = token
    ? `tok:${token}|${textHash}`
    : textHash;

  container.textContent = continuationText;
  container.setAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ATTR, '1');
  container.setAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ID_ATTR, fragmentId);
  container.removeAttribute(ASSISTANT_CONTINUATION_MERGED_ATTR);
  return true;
}

function parseContinuationMergeIds(container) {
  if (!(container instanceof Element)) return [];
  const raw = String(container.getAttribute(ASSISTANT_CONTINUATION_TARGET_IDS_ATTR) || '');
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function hasContinuationMergeId(container, fragmentId) {
  if (!(container instanceof Element)) return false;
  const key = String(fragmentId || '').trim();
  if (!key) return false;
  return parseContinuationMergeIds(container).includes(key);
}

function rememberContinuationMergeId(container, fragmentId) {
  if (!(container instanceof Element)) return;
  const key = String(fragmentId || '').trim();
  if (!key) return;
  const ids = parseContinuationMergeIds(container);
  if (ids.includes(key)) return;
  ids.push(key);
  container.setAttribute(ASSISTANT_CONTINUATION_TARGET_IDS_ATTR, ids.slice(-40).join(','));
}

function looksLikeCodeContinuationText(text) {
  const source = String(text || '').trim();
  if (!source) return false;

  const firstLine = source.split('\n')[0].trim();
  if (!firstLine) return false;
  if (/^(?:[)}\]>,.;:+\-*/%|&!?]|=>|::|#include|<\/)/.test(firstLine)) return true;
  if (/^(?:if|for|while|switch|return|const|let|var|function|class|try|catch)\b/.test(firstLine)) return true;
  if (/^[a-z_$][\w$]*\s*(?:[.(\[]|[=+\-*/%|&<>!?])/.test(firstLine)) return true;

  const signal = source.slice(0, 240);
  if (/[{}();]/.test(signal)) return true;
  if (/\/\/|\/\*/.test(signal)) return true;
  return false;
}

function normalizeContinuationLineBreaks(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function trimLeadingFenceLineForCodeDisplay(text) {
  const source = normalizeContinuationLineBreaks(text);
  const match = source.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n?/);
  if (!match) return source;
  return source.slice(match[0].length);
}

function trimTrailingClosingFenceLineForCodeDisplay(text) {
  const source = normalizeContinuationLineBreaks(text);
  if (!source) return source;
  const match = source.match(/(?:\n|^)[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!match) return source;
  if (!match[1]) return source;
  const startIndex = Math.max(0, source.length - match[0].length);
  if (startIndex === 0) return '';
  return source.slice(0, startIndex);
}

function normalizeCodeContinuationForDisplay(text) {
  const source = normalizeContinuationLineBreaks(text);
  const withoutLeadingFence = trimLeadingFenceLineForCodeDisplay(source);
  const withoutTrailingFence = trimTrailingClosingFenceLineForCodeDisplay(withoutLeadingFence);
  return withoutTrailingFence;
}

function getLastPreCodeNode(container) {
  if (!(container instanceof Element)) return null;
  const nodes = container.querySelectorAll('pre code');
  if (!nodes.length) return null;
  return nodes[nodes.length - 1];
}

function shouldAppendContinuationIntoLastCodeBlock(targetContainer, sourceContainer) {
  if (!(targetContainer instanceof Element) || !(sourceContainer instanceof Element)) return false;
  if (sourceContainer.querySelector('pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6')) {
    return false;
  }

  const codeNode = getLastPreCodeNode(targetContainer);
  if (!codeNode) return false;

  const sourceText = String(sourceContainer.textContent || '');
  return looksLikeCodeContinuationText(sourceText);
}

function appendContinuationIntoLastCodeBlock(targetContainer, sourceContainer) {
  const codeNode = getLastPreCodeNode(targetContainer);
  if (!(codeNode instanceof Element)) return false;

  const sourceText = normalizeContinuationLineBreaks(String(sourceContainer.textContent || ''));
  if (!sourceText) return false;

  const withoutLeadingFence = trimLeadingFenceLineForCodeDisplay(sourceText);
  const lines = withoutLeadingFence.split('\n');
  let closeFenceLineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(String(lines[i] || ''))) {
      closeFenceLineIndex = i;
      break;
    }
  }

  const codePart = closeFenceLineIndex >= 0
    ? lines.slice(0, closeFenceLineIndex).join('\n')
    : withoutLeadingFence;
  const restPart = closeFenceLineIndex >= 0
    ? lines.slice(closeFenceLineIndex + 1).join('\n')
    : '';

  let merged = false;
  if (codePart) {
    codeNode.appendChild(document.createTextNode(codePart));
    merged = true;
  }

  if (restPart) {
    sourceContainer.textContent = restPart;
    if (appendContinuationNodes(targetContainer, sourceContainer)) {
      merged = true;
    }
  }

  return merged;
}

function appendContinuationNodes(targetContainer, sourceContainer) {
  if (!(targetContainer instanceof Element) || !(sourceContainer instanceof Element)) return false;
  if (!sourceContainer.firstChild) return false;

  const fragment = document.createDocumentFragment();
  while (sourceContainer.firstChild) {
    fragment.appendChild(sourceContainer.firstChild);
  }

  if (!fragment.firstChild) return false;
  targetContainer.appendChild(fragment);
  return true;
}

function findPreviousAssistantProseNode(proseNodes, startIndex) {
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const candidate = proseNodes[i];
    if (!(candidate instanceof Element)) continue;
    if (!candidate.isConnected) continue;
    if (candidate.closest(USER_MESSAGE_BUBBLE_SELECTOR)) continue;
    if (!String(candidate.textContent || '').trim()) continue;
    return candidate;
  }
  return null;
}

function hideMergedContinuationSource(sourceContainer) {
  if (!(sourceContainer instanceof Element)) return;
  sourceContainer.setAttribute(ASSISTANT_CONTINUATION_MERGED_ATTR, '1');
  sourceContainer.classList.add(ASSISTANT_CONTINUATION_SOURCE_HIDDEN_CLASS);
}

function mergeAssistantContinuationFragments(proseNodes) {
  if (!Array.isArray(proseNodes) || proseNodes.length === 0) return;

  for (let i = 0; i < proseNodes.length; i += 1) {
    const sourceContainer = proseNodes[i];
    if (!(sourceContainer instanceof Element)) continue;
    if (sourceContainer.getAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ATTR) !== '1') continue;
    if (sourceContainer.getAttribute(ASSISTANT_CONTINUATION_MERGED_ATTR) === '1') continue;
    if (sourceContainer.closest(USER_MESSAGE_BUBBLE_SELECTOR)) continue;

    const targetContainer = findPreviousAssistantProseNode(proseNodes, i);
    if (!(targetContainer instanceof Element)) continue;
    if (targetContainer === sourceContainer) continue;

    const fragmentId = String(
      sourceContainer.getAttribute(ASSISTANT_CONTINUATION_FRAGMENT_ID_ATTR)
      || shortHash(String(sourceContainer.textContent || '').slice(0, 2400))
    ).trim();

    if (fragmentId && hasContinuationMergeId(targetContainer, fragmentId)) {
      hideMergedContinuationSource(sourceContainer);
      continue;
    }

    const merged = shouldAppendContinuationIntoLastCodeBlock(targetContainer, sourceContainer)
      ? appendContinuationIntoLastCodeBlock(targetContainer, sourceContainer)
      : appendContinuationNodes(targetContainer, sourceContainer);

    if (!merged) continue;

    if (fragmentId) {
      rememberContinuationMergeId(targetContainer, fragmentId);
    }
    hideMergedContinuationSource(sourceContainer);
  }
}

function processToolCodeInAllProseContainers(fullScan = false) {
  const allCandidates = Array.from(document.querySelectorAll('.prose, [class^="prose-"], [class*=" prose-"]'));
  const startIndex = fullScan ? 0 : Math.max(0, allCandidates.length - RECENT_PROSE_SCAN_LIMIT);
  for (let i = startIndex; i < allCandidates.length; i += 1) {
    const node = allCandidates[i];
    trimAssistantContinuationProtocolInContainer(node);
    trimAssistantMcpLeakInContainer(node);
    collapseToolCodeInContainer(node);
    collapseToolCallProtocolInContainer(node);
  }
  mergeAssistantContinuationFragments(allCandidates);
}

function scheduleToolCodeRender(fullScan = false) {
  if (fullScan) {
    state.toolCodeNeedsFullScan = true;
  }

  clearToolCodeRenderTimer();
  state.toolCodeRenderTimer = setTimeout(() => {
    state.toolCodeRenderTimer = null;
    if (!isPluginEnabled) {
      state.toolCodeNeedsFullScan = false;
      return;
    }

    const shouldFullScan = state.toolCodeNeedsFullScan;
    state.toolCodeNeedsFullScan = false;
    processToolCodeInAllProseContainers(shouldFullScan);
  }, 180);
}

function clearHiddenMarks() {
  document.querySelectorAll('.tm-hidden-by-toolbox').forEach((el) => {
    el.classList.remove('tm-hidden-by-toolbox');
  });
}

function removeDisclaimerBadge() {
  document.querySelectorAll('#tm-header-disclaimer').forEach((el) => {
    if (typeof el._tmStopTypewriter === 'function') {
      el._tmStopTypewriter();
    }
    el.remove();
  });
}

function removeFab() {
  const fab = document.getElementById('tm-fab-host');
  if (fab) fab.remove();
  const mcpPanel = document.getElementById('tm-mcp-panel');
  if (mcpPanel) mcpPanel.remove();
  const mcpRunIndicator = document.getElementById('tm-mcp-run-indicator');
  if (mcpRunIndicator) mcpRunIndicator.remove();
}

function disablePluginFeatures() {
  state.streaming = false;
  state.autoExpandAttempts = 0;
  state.startupRecoveryAttempts = 0;
  state.shellMenuOpen = false;
  state.pendingApiSessions = {};
  state.pendingContinuationBySession = {};
  state.completedContinuationTokens = [];
  state.completedContinuationContentByToken = {};
  state.mcpPanelOpen = false;
  state.mcpExpandedServerIds = new Set();
  state.mcpAutoRoundCount = 0;
  state.mcpAutoInFlight = false;
  state.mcpPendingExecutionPayload = null;
  state.mcpPendingExecutionFingerprint = '';
  state.mcpLastToolHash = '';
  state.mcpLastToolSessionKey = '';
  state.mcpLastToolExecutedAt = 0;
  state.mcpMergedToolTriggerLastFingerprint = '';
  state.mcpMergedToolTriggerLastAt = 0;
  state.mcpLastToolEventFingerprint = '';
  state.mcpLastToolEventAt = 0;
  state.mcpToolRunActive = false;
  state.mcpToolRunOperationId = '';
  state.mcpToolRunToolRef = '';
  state.mcpToolRunStartedAt = 0;
  state.mcpToolRunPauseRequested = false;
  state.mcpToolRunCancelNoticeSent = false;
  state.mcpToolRunCancelNoticeOperationId = '';
  state.mcpToolRunCancelRequestedOperationId = '';
  state.mcpToolRunCancelNoticeInFlightOperationId = '';
  state.mcpToolRunCancelNoticePromise = null;
  if (typeof stopMcpToolRunUi === 'function') {
    stopMcpToolRunUi();
  }

  clearAutoExpandTimer();
  clearStartupRecoveryTimer();
  clearReconcileTimer();
  clearThinkingRenderTimer();
  clearToolCodeRenderTimer();
  clearSessionSyncTimer();
  clearSessionPersistTimer();
  stopDomObserver();

  setBodyEnabledClass(false);
  restoreInputPlaceholder();
  restoreCenteredLayout();
  removeFab();
  removeThinkingToggle();
  removeDisclaimerBadge();
  removeHistoryModal();
  clearUserMessageMarkers();
  clearHiddenMarks();
  document.body?.classList?.remove('tm-shell-menu-open');
  document.documentElement.style.removeProperty('--tm-shell-top');
}

function enablePluginFeatures({ fullThinkingScan = false, forceAutoExpand = false } = {}) {
  if (!isPluginEnabled) return;

  state.autoExpandAttempts = 0;
  state.startupRecoveryAttempts = 0;
  setBodyEnabledClass(true);

  startDomObserver();
  scheduleAutoExpand(0, forceAutoExpand);
  scheduleReconcile('enable', 0);
  scheduleStartupRecovery(true);
  scheduleSessionSync(420);

  if (fullThinkingScan) {
    scheduleThinkingRender(true);
    scheduleToolCodeRender(true);
  }
}

function init() {
  window.addEventListener('message', onPageMessage, false);
  document.addEventListener('pointerdown', onGlobalButtonPointerDown, true);
  document.addEventListener('click', onGlobalButtonPointerDown, true);

  window.addEventListener('load', () => {
    kickstartFeatureRecovery('window_load');
  });
  window.addEventListener('pageshow', () => {
    kickstartFeatureRecovery('pageshow');
  });
  window.addEventListener('focus', () => {
    kickstartFeatureRecovery('window_focus');
  });
  window.addEventListener('resize', () => {
    if (!isPluginEnabled) return;
    scheduleReconcile('viewport_resize', 80);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      kickstartFeatureRecovery('visibility_visible');
    }
  });
  injectPageHookScript();
  injectThinkingStyle();
  loadSessionStore();
  void refreshMcpConfigFromBackground();
  patchHistoryOnce();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === 'togglePlugin') {
      isPluginEnabled = message.enabled === true;
      syncEnabledStateToPage();
      syncThinkingInjectionStateToPage();
      syncGlobalPromptInstructionStateToPage();
      syncMcpStateToPage();

      if (isPluginEnabled) {
        enablePluginFeatures({ fullThinkingScan: false, forceAutoExpand: true });
      } else {
        disablePluginFeatures();
      }

      sendResponse({ ok: true, enabled: isPluginEnabled });
    }
  });

  syncEnabledStateToPage();
  syncThinkingInjectionStateToPage();
  syncGlobalPromptInstructionStateToPage();
  syncMcpStateToPage();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isPluginEnabled) {
        enablePluginFeatures({ fullThinkingScan: true, forceAutoExpand: true });
        setTimeout(() => kickstartFeatureRecovery('delayed_after_domcontent_1500ms'), 1500);
        setTimeout(() => kickstartFeatureRecovery('delayed_after_domcontent_4000ms'), 4000);
      }
    }, { once: true });
    return;
  }

  if (isPluginEnabled) {
    enablePluginFeatures({ fullThinkingScan: true, forceAutoExpand: true });
    setTimeout(() => kickstartFeatureRecovery('delayed_after_init_1500ms'), 1500);
    setTimeout(() => kickstartFeatureRecovery('delayed_after_init_4000ms'), 4000);
  }
}

chrome.storage.local.get({
  enabled: true,
  [THINKING_INJECTION_STORAGE_KEY]: false,
  [GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY]: ''
}, (result) => {
  isPluginEnabled = result.enabled !== false;
  const storedThinkingToggle = result[THINKING_INJECTION_STORAGE_KEY];
  isThinkingInjectionEnabled = storedThinkingToggle === true;
  isAutoContinueFromCutoffEnabled = true;
  globalPromptInstruction = normalizeGlobalPromptInstructionText(result[GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY]);
  if (storedThinkingToggle === undefined) {
    chrome.storage.local.set({ [THINKING_INJECTION_STORAGE_KEY]: false });
  }
  if (result[GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY] === undefined) {
    chrome.storage.local.set({ [GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY]: '' });
  }
  runInit();
});
