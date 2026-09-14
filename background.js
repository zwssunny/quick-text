// Service worker:所有监听器必须顶层同步注册(MV3 休眠后才能被事件唤醒)
'use strict';

const MENU_ID = 'qt-open';
const BADGE_FAIL = '#c0392b';
const BADGE_WARN = '#e67e22';

chrome.runtime.onInstalled.addListener((details) => {
  // 右键菜单(removeAll 兼容扩展重载时的重复创建)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '插入快捷文本',
      contexts: ['editable'],
    });
  });
  if (details.reason === 'install') seedIfEmpty();
});

// 工具栏图标点击 + Alt+Q(_execute_action)都汇入这里
chrome.action.onClicked.addListener((tab) => {
  openPanel(tab, 'action');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openPanel(tab, 'context', info.frameId);
});

async function seedIfEmpty() {
  const { snippets } = await chrome.storage.local.get('snippets');
  if (Array.isArray(snippets) && snippets.length > 0) return;
  const now = Date.now();
  const seed = [
    { title: '常用邮箱', text: 'example@mail.com', keywords: ['邮箱', 'email'] },
    { title: '收到确认', text: '收到,我确认一下后尽快回复你。', keywords: ['收到', '确认'] },
    { title: '签名档', text: '谢谢!\n\n—— Sent via Quick Text', keywords: ['签名', '落款'] },
  ].map((s) => ({
    id: crypto.randomUUID(),
    title: s.title,
    text: s.text,
    keywords: s.keywords,
    createdAt: now,
  }));
  await chrome.storage.local.set({ snippets: seed });
}

function showBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function openPanel(tab, source, frameIdRaw) {
  // frameId 仅当真正指向子 frame 时才单发;-1/0/缺失 → 广播给所有 frame
  const frameId = typeof frameIdRaw === 'number' && frameIdRaw > 0 ? frameIdRaw : null;
  const tabId = tab && tab.id;
  if (typeof tabId !== 'number' || tabId < 0) return;
  const url = tab.url || '';
  if (!/^(https?:|file:)/i.test(url)) {
    // chrome:// / edge:// / 扩展商店 / PDF 查看器等受限页面
    showBadge(tabId, '✕', BADGE_FAIL);
    return;
  }

  // 1) 按需注入 content script(内部有 __qtLoaded 幂等守卫,重复注入无副作用)
  //    executeScript 的 Promise 在脚本于各 frame 执行完毕后才 resolve → 之后调用 __qtOpen 无竞态
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/content.js'],
    });
  } catch (e) {
    showBadge(tabId, '✕', BADGE_FAIL);
    return;
  }

  // 2) 让每个 frame 自行解析目标:只有"本 frame 有可编辑目标"才开面板
  //    (焦点在 iframe 时顶层 activeElement 是 <iframe>,天然去重)
  const callOpen = (opts, target) =>
    chrome.scripting.executeScript({
      target,
      func: (o) => {
        try {
          return window.__qtOpen ? window.__qtOpen(o) : { opened: false, reason: 'no-script' };
        } catch (e) {
          return { opened: false, reason: String(e) };
        }
      },
      args: [opts],
    });

  let results = [];
  try {
    results = await callOpen(
      { source },
      frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true }
    );
  } catch (e) {
    results = [];
  }

  if (results.some((r) => r && r.result && r.result.opened)) {
    showBadge(tabId, '', null);
    return;
  }

  // 3) 整个页面都没有输入框 → 顶层 frame 开"复制模式"(右键菜单指定了 frame 则不兜底)
  if (frameId == null) {
    try {
      const fb = await callOpen({ source, copyMode: true }, { tabId, frameIds: [0] });
      if (fb.some((r) => r && r.result && r.result.opened)) {
        showBadge(tabId, '', null);
        return;
      }
    } catch (e) {
      /* 忽略,走 badge 提示 */
    }
  }
  showBadge(tabId, '!', BADGE_WARN);
}
