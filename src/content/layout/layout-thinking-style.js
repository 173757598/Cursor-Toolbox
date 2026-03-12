// Layout thinking style injection

'use strict';

function injectThinkingStyle() {
  if (document.getElementById('tm-thinking-style')) return;

  const style = document.createElement('style');
  style.id = 'tm-thinking-style';
  style.textContent = `
    .tm-thinking-block {
      margin: 8px 0;
      border: 1px solid rgba(128, 128, 128, 0.3);
      border-radius: 6px;
      background: rgba(128, 128, 128, 0.05);
      overflow: hidden;
    }
    .tm-thinking-block details {
      margin: 0;
      padding: 0;
    }
    .tm-thinking-block summary {
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 500;
      font-size: 13px;
      color: #666;
      background: rgba(128, 128, 128, 0.08);
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tm-thinking-block summary::-webkit-details-marker {
      display: none;
    }
    .tm-thinking-block summary:hover {
      background: rgba(128, 128, 128, 0.12);
    }
    .tm-thinking-block .tm-thinking-content {
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.6;
      color: #555;
      border-top: 1px solid rgba(128, 128, 128, 0.2);
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .tm-thinking-block details[open] summary {
      border-bottom: 1px solid rgba(128, 128, 128, 0.2);
    }
    .tm-thinking-content p { margin: 4px 0; }
    .tm-thinking-content ul,
    .tm-thinking-content ol { margin: 4px 0; padding-left: 20px; }
    .tm-thinking-content li { margin: 2px 0; }
    .tm-thinking-content h1,
    .tm-thinking-content h2,
    .tm-thinking-content h3,
    .tm-thinking-content h4,
    .tm-thinking-content h5,
    .tm-thinking-content h6 { margin: 6px 0 4px; font-weight: 600; }
    .tm-thinking-content code {
      background: rgba(128, 128, 128, 0.12);
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .tm-thinking-content pre {
      background: rgba(128, 128, 128, 0.1);
      border-radius: 4px;
      padding: 8px 10px;
      margin: 4px 0;
      overflow-x: auto;
    }
    .tm-thinking-content pre code {
      background: none;
      padding: 0;
      font-size: 12px;
    }
    .tm-thinking-content blockquote {
      border-left: 3px solid rgba(128, 128, 128, 0.4);
      margin: 4px 0;
      padding: 2px 8px;
      color: #777;
    }
    .tm-thinking-content strong { font-weight: 600; }
    .tm-thinking-content em { font-style: italic; }
    .tm-thinking-content a { color: #4a9eff; text-decoration: underline; }
    .tm-thinking-content hr {
      border: none;
      border-top: 1px solid rgba(128, 128, 128, 0.3);
      margin: 6px 0;
    }
    .tm-tool-code-block {
      --tm-tool-border: rgba(133, 124, 108, 0.28);
      --tm-tool-header: rgba(242, 237, 227, 0.95);
      --tm-tool-text: #474035;
      --tm-tool-muted: #7f786b;
      --tm-tool-content-bg: rgba(251, 249, 244, 0.72);
      margin: 8px 0;
      border: 1px solid var(--tm-tool-border);
      border-radius: 10px;
      background: var(--tm-tool-content-bg);
      overflow: hidden;
    }
    .tm-tool-code-block details {
      margin: 0;
      padding: 0;
    }
    .tm-tool-code-block summary {
      position: relative;
      padding: 8px 10px;
      cursor: pointer;
      list-style: none;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      line-height: 1.2;
      font-weight: 600;
      color: var(--tm-tool-text);
      background: var(--tm-tool-header);
      transition: background-color .16s ease;
    }
    .tm-tool-code-block summary::-webkit-details-marker {
      display: none;
    }
    .tm-tool-code-block summary::before {
      content: '';
      width: 8px;
      height: 8px;
      border-right: 1.8px solid rgba(72, 66, 57, 0.78);
      border-bottom: 1.8px solid rgba(72, 66, 57, 0.78);
      transform: rotate(-45deg);
      transform-origin: 58% 58%;
      transition: transform .18s ease;
      flex: 0 0 auto;
      margin-right: 2px;
    }
    .tm-tool-code-block details[open] summary::before {
      transform: rotate(45deg) translateY(-1px);
    }
    .tm-tool-code-block summary:hover {
      background: rgba(238, 233, 223, 0.96);
    }
    .tm-tool-code-block summary:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px rgba(74, 79, 87, 0.28);
    }
    .tm-tool-code-block .tm-tool-summary-main {
      font-weight: 700;
      letter-spacing: .01em;
      white-space: nowrap;
    }
    .tm-tool-code-block .tm-tool-summary-meta {
      margin-left: auto;
      color: var(--tm-tool-muted);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }
    .tm-tool-code-content {
      border-top: 1px solid rgba(133, 124, 108, 0.22);
      background: var(--tm-tool-content-bg);
    }
    .tm-tool-code-content pre {
      margin: 0 !important;
      padding: 10px 11px !important;
      border-radius: 0 !important;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      color: #39342d;
      font-size: 12px;
      line-height: 1.56;
      font-family: "IBM Plex Mono", "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-height: min(42vh, 380px);
      overflow: auto;
    }
    .tm-tool-code-content pre code {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
      color: inherit;
      font-family: inherit;
      white-space: pre-wrap !important;
    }
    .tm-mcp-tool-result-block {
      margin: 0;
      --tm-tool-border: rgba(118, 132, 90, 0.3);
      --tm-tool-header: rgba(237, 243, 226, 0.96);
      --tm-tool-content-bg: rgba(248, 251, 240, 0.72);
    }
    .tm-mcp-tool-result-block.is-status-error {
      --tm-tool-border: rgba(183, 93, 93, 0.32);
      --tm-tool-header: rgba(246, 235, 232, 0.96);
      --tm-tool-content-bg: rgba(252, 246, 245, 0.76);
    }
    .tm-mcp-tool-result-block.is-status-unknown {
      --tm-tool-border: rgba(136, 126, 110, 0.28);
      --tm-tool-header: rgba(241, 236, 226, 0.95);
      --tm-tool-content-bg: rgba(250, 247, 239, 0.74);
    }
    .tm-mcp-tool-result-content pre {
      max-height: min(44vh, 420px);
    }
    @media (max-width: 640px) {
      .tm-tool-code-block summary {
        padding: 8px 10px;
        gap: 6px;
      }
      .tm-tool-code-block .tm-tool-summary-meta {
        display: none;
      }
      .tm-tool-code-content pre {
        padding: 10px;
      }
    }
    .prose p { margin-top: 4px !important; margin-bottom: 4px !important; }
    .prose ul,
    .prose ol { margin-top: 4px !important; margin-bottom: 4px !important; }
    .prose li { margin-top: 2px !important; margin-bottom: 2px !important; }
    .prose li > p { margin-top: 2px !important; margin-bottom: 2px !important; }
    .prose h1, .prose h2, .prose h3,
    .prose h4, .prose h5, .prose h6 { margin-top: 8px !important; margin-bottom: 4px !important; }
    .prose pre { margin-top: 6px !important; margin-bottom: 6px !important; }
    .prose blockquote { margin-top: 4px !important; margin-bottom: 4px !important; }
    .prose hr { margin-top: 8px !important; margin-bottom: 8px !important; }
  `;

  document.head.appendChild(style);
}
