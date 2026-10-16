// 背景脚本（MV3 Service Worker）
// 职责：点击扩展图标打开界面 + 右键菜单注册 + 把网页图片转交给界面
'use strict';

const MENU_ID = 'resizeImage';
const PENDING_KEY = 'pendingImage';
const PENDING_TTL = 60 * 1000; // 暂存的图片 URL 60 秒内有效
const PANEL_PATH = 'sidepanel.html';

/* ------------------------------------------------------------------ */
/* 兼容层                                                              */
/* sidePanel 是 Chrome / Edge 特有的 API，在其它 Chromium 系浏览器里       */
/* chrome.sidePanel 是 undefined，直接访问 .open 会抛 TypeError。        */
/* ------------------------------------------------------------------ */

function hasSidePanel() {
  return Boolean(chrome.sidePanel && typeof chrome.sidePanel.open === 'function');
}

function openAsTab() {
  return chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
}

// 统一入口：优先侧边栏，不支持时退化成独立标签页（功能照常可用）
function openPanel(windowId) {
  if (!hasSidePanel()) return openAsTab();

  return chrome.sidePanel.open({ windowId }).catch((err) => {
    console.warn('[图片调整器] 打开侧边栏失败，改用标签页:', err);
    return openAsTab();
  });
}

// 让「点击工具栏图标」直接开侧边栏，而不是弹一个小窗口。
// 注意：manifest 的 action 里不能有 default_popup，否则这个设置不生效。
function enableActionOpensPanel() {
  if (!hasSidePanel() || typeof chrome.sidePanel.setPanelBehavior !== 'function') return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[图片调整器] 设置图标点击行为失败:', err));
}

// storage.session 在个别实现里可能缺失，退化到 local（反正只在小段时间内有效）
const pendingStore = chrome.storage.session || chrome.storage.local;
const savePending = (url) => pendingStore.set({ [PENDING_KEY]: { url, at: Date.now() } });
const readPending = () => pendingStore.get(PENDING_KEY).then((stored) => stored[PENDING_KEY]);
const clearPending = () => pendingStore.remove(PENDING_KEY);

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

enableActionOpensPanel();

chrome.runtime.onInstalled.addListener(() => {
  enableActionOpensPanel();

  // 重建右键菜单（先清空，否则重复 id 会报错）
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: '用「图片尺寸调整器」处理此图片',
        contexts: ['image']
      },
      () => {
        // 读取 lastError 避免控制台出现未捕获的报错
        if (chrome.runtime.lastError) {
          console.warn('[图片调整器] 创建右键菜单失败:', chrome.runtime.lastError.message);
        }
      }
    );
  });
});

// 兜底：万一 openPanelOnActionClick 没生效，图标点击仍然能打开界面
chrome.action.onClicked.addListener((tab) => {
  openPanel(tab?.windowId);
});

// 右键菜单：把图片 URL 暂存起来再打开界面
// 界面可能尚未加载，所以不能只靠 sendMessage（会丢消息）
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;

  try {
    await savePending(info.srcUrl);
  } catch (err) {
    console.warn('[图片调整器] 暂存图片失败:', err);
  }

  await openPanel(tab?.windowId);

  // 界面已经打开时，走消息通道立即插入（未打开时由上面的暂存兜底）
  chrome.runtime
    .sendMessage({ action: 'addImageFromWeb', url: info.srcUrl })
    .catch(() => { /* 没有接收方，忽略 */ });
});

// 清理过期的暂存记录，避免界面很久之后才打开时误插入旧图
async function clearStalePending() {
  try {
    const pending = await readPending();
    if (pending && Date.now() - pending.at > PENDING_TTL) await clearPending();
  } catch { /* storage 不可用时忽略 */ }
}

chrome.runtime.onStartup.addListener(clearStalePending);
chrome.runtime.onInstalled.addListener(clearStalePending);
