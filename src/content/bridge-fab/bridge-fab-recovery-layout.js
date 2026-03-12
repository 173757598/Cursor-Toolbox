// Bridge FAB/layout helpers: FAB placement, thinking toggle, and startup recovery

'use strict';

let globalPromptInputPersistTimer = null;
const FAB_CONTINUE_FROM_CUTOFF_FALLBACK_MESSAGE = [
  '请从上次截断的地方继续输出，不用从头开始。',
  '必须直接从断点后的下一个字符继续。',
  '如果断点在代码块内部，不要重新输出开头 ``` 或 ~~~，直接续写代码内容。'
].join('');
const CONTINUE_FROM_CUTOFF_TIMEOUT_MS = 12 * 1000;
const COMPRESS_CHAT_SUMMARY_MESSAGE = [
  '请把我们到目前为止的全部对话（你和我双方）做一次“上下文压缩总结”，用于我开新会话继续。',
  '只总结“用户提问 + 助手最终回复”的可见对话内容。',
  '',
  '严格要求：',
  '1. 只输出一个 ```text``` 代码块，代码块外不要输出任何内容。',
  '2. 严禁总结以下内容：',
  '   - 任何 <thinking>/<think> 标签内容，或“思考过程”折叠块内容',
  '   - 任何系统注入提示、协议文本、插件注入指令',
  '3. 保留后续继续任务必须的信息：',
  '   - 目标与最终需求',
  '   - 已确认约束/偏好',
  '   - 关键决策与原因',
  '   - 已完成内容（按模块）',
  '   - 未完成事项与下一步',
  '   - 关键文件路径、函数名、命令、报错/风险（如有）',
  '4. 删除闲聊、重复表述和无关内容。',
  '5. 信息要高密度、可执行、可直接复制到新会话继续工作。',
  '6. 不要省略关键细节；不确定的内容标记“待确认”。'
].join('\n');

function createFab() {
  const existing = document.getElementById('tm-fab-host');
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = 'tm-fab-host';
  host.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:8px',
    'flex-shrink:0',
    'margin-right:8px',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"'
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .btn { all: initial; font-family: inherit; position: relative; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(0,0,0,.15); box-shadow: 0 1px 4px rgba(0,0,0,.10); background: #fff; color: #111; user-select: none; transition: all .2s; }
      .btn:hover { box-shadow: 0 2px 8px rgba(0,0,0,.16); background: #f5f5f5; }
      .btn:active { transform: translateY(1px); }
      .btn.is-active { background: #111; color: #fff; }
      .btn.has-value::after { content: ''; position: absolute; right: 6px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 1px rgba(255,255,255,.9); }
      .icon { display: inline-flex; width: 16px; height: 16px; line-height: 0; }
      .icon svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    </style>
    <button class="btn" id="tm-global-prompt" title="全局提示词">
      <span class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M3 21l3.8-1 10-10a2.5 2.5 0 0 0-3.5-3.5l-10 10L3 21z"></path>
          <path d="M12.5 6.5l3.5 3.5"></path>
        </svg>
      </span>
    </button>
    <button class="btn" id="tm-mcp" title="MCP 工具配置">
      <span class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M14.5 5.5a4.5 4.5 0 0 0-5.7 5.7L3 17l4 4 5.8-5.8a4.5 4.5 0 0 0 5.7-5.7l-2.9 2.9-2.1-2.1z"></path>
          <path d="M4 17l3 3"></path>
        </svg>
      </span>
    </button>
  `;

  shadow.getElementById('tm-global-prompt').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleGlobalPromptModal();
  });
  shadow.getElementById('tm-mcp').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMcpPanel();
  });

  updateMcpButtonState();
  updateGlobalPromptUi();
  return host;
}

function isVisibleComposerElement(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (!node.isConnected || node.hidden) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findComposerTextarea() {
  const all = Array.from(document.querySelectorAll(TEXTAREA_SELECTOR))
    .filter((node) => node instanceof HTMLTextAreaElement);
  if (all.length === 0) return null;

  const visible = all.filter((node) => isVisibleComposerElement(node));
  const pool = visible.length > 0 ? visible : all;

  if (document.activeElement instanceof HTMLTextAreaElement && pool.includes(document.activeElement)) {
    return document.activeElement;
  }

  const centered = getActiveCenteredElement();
  if (centered) {
    const inCentered = pool.filter((node) => centered.contains(node));
    if (inCentered.length > 0) {
      return inCentered[inCentered.length - 1];
    }
  }

  return pool[pool.length - 1] || null;
}

function collectSendButtons(scope) {
  if (!(scope instanceof Element) && scope !== document) return [];
  const seen = new Set();
  const result = [];
  for (const selector of SEND_BTN_SELECTORS) {
    const buttons = scope.querySelectorAll(selector);
    for (const button of buttons) {
      if (!(button instanceof HTMLButtonElement)) continue;
      if (seen.has(button)) continue;
      seen.add(button);
      result.push(button);
    }
  }
  return result;
}

function scoreSendButton(button, textarea) {
  let score = 0;
  if (isVisibleComposerElement(button)) score += 30;
  else score -= 60;

  if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
    score -= 25;
  } else {
    score += 8;
  }

  const buttonSignal = normalizeSpace([
    button.getAttribute('aria-label') || '',
    button.getAttribute('title') || '',
    button.className || ''
  ].join(' ')).toLowerCase();
  if (/(send|发送|submit|提交)/i.test(buttonSignal)) score += 6;

  if (textarea instanceof HTMLTextAreaElement) {
    const textareaForm = textarea.closest('form');
    const buttonForm = button.closest('form');
    if (textareaForm && buttonForm === textareaForm) score += 35;

    const tRect = textarea.getBoundingClientRect();
    const bRect = button.getBoundingClientRect();
    const tCx = tRect.left + tRect.width / 2;
    const tCy = tRect.top + tRect.height / 2;
    const bCx = bRect.left + bRect.width / 2;
    const bCy = bRect.top + bRect.height / 2;
    const dx = Math.abs(tCx - bCx);
    const dy = Math.abs(tCy - bCy);
    score -= dx / 180;
    score -= dy / 24;
  }

  return score;
}

function findComposerMetaRow() {
  const textarea = findComposerTextarea();
  const form = textarea?.closest('form') || document.querySelector('form');
  if (!form) return null;

  const candidates = form.querySelectorAll('div.flex.items-center.gap-1, div[class*="items-center"][class*="gap-1"]');
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    let score = 0;
    if (candidate.querySelector('button[data-slot="popover-trigger"]')) score += 4;
    if (candidate.querySelector('button[aria-haspopup="dialog"]')) score += 2;
    if (candidate.querySelector('svg')) score += 1;
    if (/agent/i.test(normalizeSpace(candidate.textContent || ''))) score += 2;
    if (candidate.closest('form') === form) score += 1;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= 4 ? best : null;
}

function updateThinkingToggleUi() {
  const btn = document.getElementById('tm-thinking-toggle-btn');
  if (!btn) return;

  const enabled = isThinkingInjectionEnabled;
  btn.classList.toggle('is-on', enabled);
  btn.classList.toggle('is-off', !enabled);
  btn.setAttribute('aria-checked', enabled ? 'true' : 'false');
  btn.setAttribute('title', enabled ? '思考模式：已开启' : '思考模式：已关闭');
}

function updateContinueAutoToggleUi() {
  const btn = document.getElementById('tm-continue-auto-toggle-btn');
  if (!(btn instanceof HTMLButtonElement)) return;

  const enabled = isAutoContinueFromCutoffEnabled === true;
  btn.classList.toggle('is-on', enabled);
  btn.classList.toggle('is-off', !enabled);
  btn.setAttribute('aria-checked', enabled ? 'true' : 'false');
  btn.setAttribute('title', enabled ? '自动续写：已开启' : '自动续写：已关闭');
}

function hasContinueCutoffAnchorReady() {
  const source = state?.streamContinuation;
  if (!source || typeof source !== 'object') return false;
  if (source.active !== true) return false;
  const token = toSafeString(source.anchorToken);
  const tail = toSafeString(source.tailText);
  return Boolean(token && tail);
}

function updateContinueCutoffButtonUi() {
  const btn = document.getElementById('tm-continue-cutoff-btn');
  if (!(btn instanceof HTMLButtonElement)) return;

  const streaming = state?.streaming === true;
  const ready = hasContinueCutoffAnchorReady() && !streaming;
  const statusText = ready ? '可续写' : (streaming ? '回复中' : '无断点');
  btn.classList.toggle('is-ready', ready);
  btn.classList.toggle('is-empty', !ready);
  btn.disabled = !ready;
  btn.setAttribute('data-cutoff-status', ready ? 'ready' : 'empty');
  btn.textContent = `续写(${statusText})`;
  btn.title = ready
    ? '检测到上次输出断点：点击可按锚点协议续写'
    : (streaming ? '正在等待本轮回复，续写按钮暂不可用' : '当前没有可用断点锚点');
  btn.setAttribute('aria-label', `从截断处继续输出，状态：${statusText}`);
}

async function sendContinueFromCutoffMessage() {
  if (!hasContinueCutoffAnchorReady()) return false;
  if (state?.streaming === true) return false;
  const message = resolveContinueFromCutoffMessage();
  const sent = await sendQuickComposerMessage(message);
  if (sent && typeof resetStreamContinuationState === 'function') {
    resetStreamContinuationState({ preserveToolCallState: true });
  } else if (sent) {
    const continuation = state?.streamContinuation;
    if (continuation && typeof continuation === 'object') {
      continuation.active = false;
      continuation.anchorToken = '';
      continuation.tailText = '';
    }
    if (typeof updateContinueCutoffButtonUi === 'function') {
      updateContinueCutoffButtonUi();
    }
  }
  return sent;
}

function resolveContinueFromCutoffMessage() {
  if (typeof buildContinueFromCutoffMessage === 'function') {
    try {
      const built = toSafeString(buildContinueFromCutoffMessage()).trim();
      if (built) return built;
    } catch (_error) {
      // fall back to default message
    }
  }
  return FAB_CONTINUE_FROM_CUTOFF_FALLBACK_MESSAGE;
}

async function sendCompressChatSummaryMessage() {
  return sendQuickComposerMessage(COMPRESS_CHAT_SUMMARY_MESSAGE);
}

async function sendQuickComposerMessage(message) {
  const text = toSafeString(message);
  if (!text) return false;

  if (typeof sendAutoMessageToComposerWhenReady === 'function') {
    try {
      const sent = await sendAutoMessageToComposerWhenReady(text, {
        timeoutMs: CONTINUE_FROM_CUTOFF_TIMEOUT_MS
      });
      if (sent) return true;
    } catch (_error) {
      // fall back to immediate send path
    }
  }

  if (typeof sendAutoMessageToComposer === 'function') {
    try {
      return sendAutoMessageToComposer(text);
    } catch (_error) {
      return false;
    }
  }

  return false;
}

function bindQuickSendButton(button, sendAction, warnMessage) {
  if (!(button instanceof HTMLButtonElement)) return;
  if (typeof sendAction !== 'function') return;

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    button.classList.add('is-pending');
    try {
      const sent = await sendAction();
      if (!sent && warnMessage) {
        console.warn(warnMessage);
      }
    } finally {
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.classList.remove('is-pending');
        if (typeof updateContinueCutoffButtonUi === 'function') {
          updateContinueCutoffButtonUi();
        }
      }, 240);
    }
  });
}

function clearGlobalPromptInputPersistTimer() {
  if (!globalPromptInputPersistTimer) return;
  clearTimeout(globalPromptInputPersistTimer);
  globalPromptInputPersistTimer = null;
}

function scheduleGlobalPromptInstructionPersist() {
  clearGlobalPromptInputPersistTimer();
  globalPromptInputPersistTimer = setTimeout(() => {
    globalPromptInputPersistTimer = null;
    persistGlobalPromptInstruction();
  }, 360);
}

function getGlobalPromptModalElement() {
  const el = document.getElementById('tm-global-prompt-modal');
  return el instanceof HTMLElement ? el : null;
}

function isGlobalPromptModalOpen() {
  return Boolean(getGlobalPromptModalElement());
}

function updateGlobalPromptModalCount(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const modal = getGlobalPromptModalElement();
  if (!modal) return;
  const count = modal.querySelector('#tm-global-prompt-count');
  if (!(count instanceof HTMLElement)) return;
  count.textContent = `${textarea.value.length}/1200`;
}

function syncGlobalPromptModalValue({ force = false } = {}) {
  const modal = getGlobalPromptModalElement();
  if (!modal) return;
  const textarea = modal.querySelector('#tm-global-prompt-textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  if (!force && document.activeElement === textarea) return;
  if (textarea.value !== globalPromptInstruction) {
    textarea.value = globalPromptInstruction;
  }
  updateGlobalPromptModalCount(textarea);
}

function closeGlobalPromptModal() {
  const modal = getGlobalPromptModalElement();
  if (!modal) {
    updateGlobalPromptUi();
    return;
  }
  const textarea = modal.querySelector('#tm-global-prompt-textarea');
  if (textarea instanceof HTMLTextAreaElement) {
    clearGlobalPromptInputPersistTimer();
    setGlobalPromptInstruction(textarea.value, { persist: true, sync: true });
  }
  modal.remove();
  document.body.classList.remove('tm-global-prompt-modal-open');
  updateGlobalPromptUi();
}

function openGlobalPromptModal() {
  const existing = getGlobalPromptModalElement();
  if (existing) {
    const existingTextarea = existing.querySelector('#tm-global-prompt-textarea');
    if (existingTextarea instanceof HTMLTextAreaElement) {
      existingTextarea.focus();
      existingTextarea.setSelectionRange(existingTextarea.value.length, existingTextarea.value.length);
    }
    updateGlobalPromptUi();
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'tm-global-prompt-modal';
  modal.className = 'tm-global-prompt-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'tm-global-prompt-title');
  modal.innerHTML = `
    <div class="tm-global-prompt-mask" data-global-prompt-dismiss="mask"></div>
    <section class="tm-global-prompt-panel" role="document">
      <header class="tm-global-prompt-header">
        <div class="tm-global-prompt-title-wrap">
          <h3 id="tm-global-prompt-title">全局提示词</h3>
          <p>将追加到每轮注入提示中；留空则不注入。</p>
        </div>
        <button class="tm-global-prompt-close" type="button" aria-label="关闭" data-global-prompt-dismiss="close">×</button>
      </header>
      <div class="tm-global-prompt-body">
        <textarea
          id="tm-global-prompt-textarea"
          class="tm-global-prompt-textarea"
          maxlength="1200"
          spellcheck="false"
          placeholder="请输入全局提示词..."
          aria-label="全局提示词输入"
        ></textarea>
      </div>
      <footer class="tm-global-prompt-footer">
        <div id="tm-global-prompt-count" class="tm-global-prompt-count">0/1200</div>
        <div class="tm-global-prompt-actions">
          <button class="tm-global-prompt-btn is-ghost" type="button" data-global-prompt-action="clear">清空</button>
          <button class="tm-global-prompt-btn is-primary" type="button" data-global-prompt-action="done">完成</button>
        </div>
      </footer>
    </section>
  `.trim();

  document.body.appendChild(modal);
  document.body.classList.add('tm-global-prompt-modal-open');

  const textarea = modal.querySelector('#tm-global-prompt-textarea');
  const clearBtn = modal.querySelector('[data-global-prompt-action="clear"]');
  const doneBtn = modal.querySelector('[data-global-prompt-action="done"]');

  modal.addEventListener('click', (event) => {
    const target = event.target;
    const dismissTrigger = target instanceof Element
      ? target.closest('[data-global-prompt-dismiss]')
      : null;
    if (!dismissTrigger) return;
    closeGlobalPromptModal();
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGlobalPromptModal();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (doneBtn instanceof HTMLButtonElement) {
        doneBtn.click();
      }
    }
  });

  if (textarea instanceof HTMLTextAreaElement) {
    textarea.value = globalPromptInstruction;
    updateGlobalPromptModalCount(textarea);
    textarea.addEventListener('input', () => {
      setGlobalPromptInstruction(textarea.value, { persist: false, sync: true });
      scheduleGlobalPromptInstructionPersist();
      updateGlobalPromptModalCount(textarea);
    });
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  if (clearBtn instanceof HTMLButtonElement) {
    clearBtn.addEventListener('click', () => {
      clearGlobalPromptInputPersistTimer();
      setGlobalPromptInstruction('', { persist: true, sync: true });
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.value = '';
        updateGlobalPromptModalCount(textarea);
        textarea.focus();
      }
    });
  }
  if (doneBtn instanceof HTMLButtonElement) {
    doneBtn.addEventListener('click', () => {
      if (textarea instanceof HTMLTextAreaElement) {
        clearGlobalPromptInputPersistTimer();
        setGlobalPromptInstruction(textarea.value, { persist: true, sync: true });
      }
      closeGlobalPromptModal();
    });
  }

  updateGlobalPromptUi();
}

function toggleGlobalPromptModal() {
  if (isGlobalPromptModalOpen()) {
    closeGlobalPromptModal();
    return;
  }
  openGlobalPromptModal();
}

function updateGlobalPromptUi() {
  const host = document.getElementById('tm-fab-host');
  const promptBtn = host?.shadowRoot?.getElementById('tm-global-prompt');
  const open = isGlobalPromptModalOpen();
  const hasValue = Boolean(globalPromptInstruction);
  if (promptBtn instanceof HTMLButtonElement) {
    promptBtn.classList.toggle('is-active', open || hasValue);
    promptBtn.classList.toggle('has-value', hasValue);
    promptBtn.title = hasValue ? '全局提示词：已设置（点击编辑）' : '全局提示词：未设置（点击设置）';
  }
  syncGlobalPromptModalValue();
}

function createThinkingToggle() {
  const existing = document.getElementById('tm-thinking-toggle-host');
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = 'tm-thinking-toggle-host';
  host.className = 'tm-thinking-toggle-host';
  host.innerHTML = `
    <button id="tm-thinking-toggle-btn" class="tm-thinking-toggle-btn is-off" type="button" role="switch" aria-checked="false" aria-label="思考模式开关">
      <span class="tm-thinking-toggle-label">思考模式</span>
      <span class="tm-thinking-toggle-switch" aria-hidden="true">
        <span class="tm-thinking-toggle-knob"></span>
      </span>
    </button>
    <button id="tm-continue-cutoff-btn" class="tm-continue-cutoff-btn" type="button" aria-label="从截断处继续输出" title="从上次截断处继续输出">续写</button>
    <button id="tm-continue-auto-toggle-btn" class="tm-continue-auto-toggle-btn is-off" type="button" role="switch" aria-checked="false" aria-label="自动续写开关">
      <span class="tm-continue-auto-label">自动续写</span>
      <span class="tm-continue-auto-switch" aria-hidden="true">
        <span class="tm-continue-auto-knob"></span>
      </span>
    </button>
    <button id="tm-summary-chat-btn" class="tm-summary-chat-btn" type="button" aria-label="压缩总结全部对话" title="压缩总结全部对话（发送总结提示词）">压缩总结</button>
  `.trim();

  const btn = host.querySelector('#tm-thinking-toggle-btn');
  if (btn) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setThinkingInjectionEnabled(!isThinkingInjectionEnabled);
    });
  }
  const continueBtn = host.querySelector('#tm-continue-cutoff-btn');
  bindQuickSendButton(
    continueBtn,
    sendContinueFromCutoffMessage,
    '[Cursor Toolbox] failed to auto-send continue-from-cutoff message.'
  );
  const continueAutoToggleBtn = host.querySelector('#tm-continue-auto-toggle-btn');
  if (continueAutoToggleBtn) {
    continueAutoToggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setAutoContinueFromCutoffEnabled(!isAutoContinueFromCutoffEnabled);
    });
  }

  const summaryBtn = host.querySelector('#tm-summary-chat-btn');
  bindQuickSendButton(
    summaryBtn,
    sendCompressChatSummaryMessage,
    '[Cursor Toolbox] failed to auto-send compress-summary message.'
  );

  updateThinkingToggleUi();
  updateContinueCutoffButtonUi();
  updateContinueAutoToggleUi();
  updateGlobalPromptUi();
  return host;
}

function ensureThinkingToggleNearModel() {
  const row = findComposerMetaRow();
  if (!row) return false;

  const host = createThinkingToggle();
  if (host.parentNode !== row || row.lastElementChild !== host) {
    row.appendChild(host);
  }

  updateThinkingToggleUi();
  updateContinueCutoffButtonUi();
  updateContinueAutoToggleUi();
  updateGlobalPromptUi();
  return true;
}

function removeThinkingToggle() {
  clearGlobalPromptInputPersistTimer();
  closeGlobalPromptModal();
  const host = document.getElementById('tm-thinking-toggle-host');
  if (host) host.remove();
}

function findSendButton({ allowDisabled = true } = {}) {
  const textarea = findComposerTextarea();
  const scopes = [];
  const form = textarea?.closest('form');
  if (form) scopes.push(form);
  const centered = getActiveCenteredElement();
  if (centered) scopes.push(centered);
  scopes.push(document);

  const seen = new Set();
  const candidates = [];
  for (const scope of scopes) {
    const buttons = collectSendButtons(scope);
    for (const button of buttons) {
      if (seen.has(button)) continue;
      seen.add(button);
      if (!allowDisabled && (button.disabled || button.getAttribute('aria-disabled') === 'true')) continue;
      candidates.push(button);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    return scoreSendButton(right, textarea) - scoreSendButton(left, textarea);
  });
  const best = candidates[0];
  if (best) {
    return best;
  }
  return null;
}

function isConnectedElement(node) {
  return Boolean(
    node &&
    node.nodeType === Node.ELEMENT_NODE &&
    node.isConnected &&
    document.documentElement.contains(node)
  );
}

function getActiveCenteredElement() {
  const el = state.centeredElement;
  if (isConnectedElement(el)) return el;
  if (!el) return null;

  if (state.underlayHost) {
    state.underlayHost.classList.remove('tm-shell-underlay-hidden');
    state.underlayHost = null;
  }

  if (document.body) {
    document.body.style.overflow = state.prevBodyOverflow || '';
  }
  document.documentElement.style.overflow = state.prevHtmlOverflow || '';

  state.centered = false;
  state.centeredElement = null;
  state.centeredPlaceholder = null;
  state.centeredOriginalStyle = null;
  state.underlayHost = null;
  state.prevBodyOverflow = '';
  state.prevHtmlOverflow = '';
  return null;
}

function collectLayoutCandidatesFromAncestors(startNode, candidates, maxDepth = 10) {
  let cur = startNode instanceof Element ? startNode : null;
  let depth = 0;

  while (cur && cur !== document.body && depth < maxDepth) {
    if (
      cur.matches?.(LAYOUT_TARGET_SELECTOR) ||
      cur.matches?.(LAYOUT_FALLBACK_SELECTOR) ||
      cur.matches?.('main, [role="main"], section, aside')
    ) {
      candidates.add(cur);
    }
    cur = cur.parentElement;
    depth += 1;
  }
}

function scoreLayoutCandidate(candidate) {
  if (!isConnectedElement(candidate)) return Number.NEGATIVE_INFINITY;
  if (candidate === document.body || candidate === document.documentElement) return Number.NEGATIVE_INFINITY;

  const rect = candidate.getBoundingClientRect?.();
  if (rect && (rect.width < 260 || rect.height < 220)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (candidate.matches(LAYOUT_TARGET_SELECTOR)) score += 8;
  if (candidate.matches('div[role="region"]')) score += 2;
  if (candidate.matches('#main-content')) score += 2;
  if (candidate.querySelector(TEXTAREA_SELECTOR)) score += 6;
  if (candidate.querySelector(SEND_BTN_SELECTORS.join(', '))) score += 6;
  if (candidate.querySelector(CHAT_VIEWPORT_SELECTOR)) score += 4;

  const className = typeof candidate.className === 'string' ? candidate.className.toLowerCase() : '';
  if (className.includes('chat') || className.includes('sidebar') || className.includes('thread')) {
    score += 2;
  }

  return score;
}

function hasCoreUiReady() {
  const centeredEl = getActiveCenteredElement();
  const hasChatTarget = Boolean(centeredEl || findLayoutTarget());
  const textarea = document.querySelector(TEXTAREA_SELECTOR);
  const hasInput = Boolean(textarea);
  const sendButton = findSendButton();
  const fab = document.getElementById('tm-fab-host');
  const thinkingRow = findComposerMetaRow();
  const thinkingToggle = document.getElementById('tm-thinking-toggle-host');
  const fabReady = !sendButton || Boolean(fab && fab.parentNode === sendButton.parentNode && fab.nextSibling === sendButton);
  const thinkingToggleReady = !thinkingRow || Boolean(thinkingToggle && thinkingToggle.parentNode === thinkingRow);
  const layoutReady = Boolean(centeredEl && centeredEl.classList.contains('tm-centered50'));
  const placeholderReady = Boolean(textarea && textarea.placeholder === PLACEHOLDER_TEXT);
  return hasChatTarget && hasInput && fabReady && thinkingToggleReady && layoutReady && placeholderReady;
}

function kickstartFeatureRecovery(reason = 'kickstart') {
  if (!isPluginEnabled) return;
  if (state.streaming) return;
  if (hasCoreUiReady()) return;

  startDomObserver();
  scheduleAutoExpand(60, true);
  scheduleReconcile(reason, 60);
  scheduleStartupRecovery(true);
}

function scheduleStartupRecovery(resetAttempts = false) {
  if (!isPluginEnabled) return;

  if (resetAttempts) {
    state.startupRecoveryAttempts = 0;
    clearStartupRecoveryTimer();
  }

  if (state.startupRecoveryTimer) return;

  const tick = () => {
    state.startupRecoveryTimer = null;
    if (!isPluginEnabled) return;
    if (state.streaming) {
      scheduleStartupRecovery(false);
      return;
    }

    reconcileUi('startup_recovery');

    if (hasCoreUiReady()) {
      state.startupRecoveryAttempts = 0;
      return;
    }

    if (state.startupRecoveryAttempts >= STARTUP_RECOVERY_MAX_ATTEMPTS) {
      return;
    }

    state.startupRecoveryAttempts += 1;
    state.startupRecoveryTimer = setTimeout(tick, STARTUP_RECOVERY_INTERVAL_MS);
  };

  state.startupRecoveryTimer = setTimeout(tick, STARTUP_RECOVERY_INTERVAL_MS);
}

function ensureFabNearSendButton() {
  const sendBtn = findSendButton();
  if (!sendBtn || !sendBtn.parentNode) return false;

  const host = createFab();
  if (host.nextSibling !== sendBtn || host.parentNode !== sendBtn.parentNode) {
    sendBtn.parentNode.insertBefore(host, sendBtn);
  }

  syncMcpRunIndicatorUi();
  updateGlobalPromptUi();
  if (state.mcpPanelOpen) {
    const panel = getMcpPanelElement();
    if (panel) repositionMcpPanel(panel);
  }
  return true;
}

function countEnabledMcpTools() {
  return state.mcpConfig.servers.reduce((count, server) => {
    if (!Array.isArray(server.enabledTools)) return count;
    return count + server.enabledTools.length;
  }, 0);
}

function updateMcpButtonState() {
  const host = document.getElementById('tm-fab-host');
  if (!host?.shadowRoot) return;
  const btn = host.shadowRoot.getElementById('tm-mcp');
  if (!btn) return;
  btn.classList.toggle('is-active', state.mcpPanelOpen);
  btn.title = `MCP 工具配置（已启用 ${countEnabledMcpTools()} 个工具）`;
}
