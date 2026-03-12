(() => {
  'use strict';

  const toggle = document.getElementById('plugin-toggle');
  const statusIndicator = document.getElementById('status-indicator');

  /**
   * 更新 UI 显示状态
   * @param {{enabled: boolean}} state
   */
  function updateUI(state) {
    const pluginEnabled = state.enabled === true;

    toggle.checked = pluginEnabled;

    if (pluginEnabled) {
      statusIndicator.classList.add('enabled');
    } else {
      statusIndicator.classList.remove('enabled');
    }
  }

  /**
   * 向当前活动标签页发送消息
   * @param {{action: string, enabled: boolean}} payload
   */
  function notifyContentScript(payload) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, payload, () => {
        if (chrome.runtime.lastError) {
          // 静默忽略连接错误（如页面未注入内容脚本）
        }
      });
    });
  }

  // ========== 初始化：读取存储状态 ==========
  chrome.storage.local.get({ enabled: true }, (result) => {
    updateUI({
      enabled: result.enabled !== false
    });
  });

  // ========== 监听开关点击 ==========
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    updateUI({ enabled });

    // 保存总开关状态
    chrome.storage.local.set({ enabled }, () => {
      if (chrome.runtime.lastError) {
        console.error('[Cursor Toolbox Popup] storage.set error:', chrome.runtime.lastError.message);
      }
    });

    // 通知内容脚本总开关变化
    notifyContentScript({ action: 'togglePlugin', enabled });
  });

})();
