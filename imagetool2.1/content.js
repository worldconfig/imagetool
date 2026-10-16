// 内容脚本：让网页图片可以拖进扩展面板
// 原则：不修改宿主页面的语义（不覆盖 img.title / 不写内联样式），只加一个类名，样式交给 content.css
'use strict';

const HINT_CLASS = 'wb-img-hint';
const processed = new WeakSet();
let hintEnabled = true;

/* ------------------------------------------------------------------ */
/* 拖拽数据                                                            */
/* ------------------------------------------------------------------ */

// 拖拽时补齐 uri-list，保证面板能拿到图片地址。
// 只写数据、不改 effectAllowed，尽量少干扰站点自己的拖放逻辑（站点在冒泡阶段仍可覆盖）。
document.addEventListener(
  'dragstart',
  (e) => {
    const target = e.target;
    if (!(target instanceof HTMLImageElement) || !target.src) return;
    try {
      e.dataTransfer.setData('text/uri-list', target.src);
      e.dataTransfer.setData('text/plain', target.src);
    } catch { /* 某些页面会锁定 dataTransfer，忽略 */ }
  },
  true
);

/* ------------------------------------------------------------------ */
/* 提示样式                                                            */
/* ------------------------------------------------------------------ */

function addDragHint(img) {
  if (!(img instanceof HTMLImageElement)) return;
  if (processed.has(img)) return;
  processed.add(img);
  if (hintEnabled) img.classList.add(HINT_CLASS);
}

function scan(root) {
  if (!root) return;
  if (root instanceof HTMLImageElement) {
    addDragHint(root);
    return;
  }
  if (root.querySelectorAll) root.querySelectorAll('img').forEach(addDragHint);
}

function applyHintState() {
  if (hintEnabled) {
    scan(document.body);
  } else {
    document.querySelectorAll(`.${HINT_CLASS}`).forEach((el) => el.classList.remove(HINT_CLASS));
  }
}

/* ------------------------------------------------------------------ */
/* 设置：读取 / 跟随变化                                                */
/* 扩展被重载后，页面里残留的旧内容脚本再调 chrome.* 会抛                */
/* "Extension context invalidated"，所以每次调用都要兜住。               */
/* ------------------------------------------------------------------ */

function readHintSetting() {
  try {
    chrome.storage.sync.get(['pageHint'], (result) => {
      if (chrome.runtime?.lastError) return;
      hintEnabled = result.pageHint !== false; // 默认开启
      applyHintState();
    });
  } catch { /* 上下文已失效，保持默认行为 */ }
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.pageHint) return;
    hintEnabled = changes.pageHint.newValue !== false;
    applyHintState();
  });
} catch { /* 上下文已失效，不影响拖拽本身 */ }

/* ------------------------------------------------------------------ */
/* 动态图片：按帧合并处理                                               */
/* 无限滚动页面会高频插入节点，逐个同步 querySelectorAll 会拖死主线程。    */
/* ------------------------------------------------------------------ */

const pendingRoots = new Set();
let flushScheduled = false;

function scheduleScan(node) {
  pendingRoots.add(node);
  if (flushScheduled) return;
  flushScheduled = true;

  const flush = () => {
    flushScheduled = false;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) scan(root);
  };

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function startObserver() {
  if (!document.body) return;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scheduleScan(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body);
}

// document_idle 时 body 通常已存在，仍做一次防御
if (document.body) {
  readHintSetting();
  startObserver();
} else {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      readHintSetting();
      startObserver();
    },
    { once: true }
  );
}
