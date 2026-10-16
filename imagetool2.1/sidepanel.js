// 侧边栏主逻辑
'use strict';

const DEFAULTS = {
  saveFolder: 'resized_images',
  // 保持 v2.0 的默认行为：输出到下载目录下的 resized_images；清空输入框则直接存到下载目录
  selectedFolderPath: 'resized_images',
  savedWidth: 800,
  savedHeight: 600,
  outputFormat: 'original',
  convertMode: 'resize',
  aspectMode: 'contain',
  quality: 0.92,
  autoProcess: false,
  groupSize: 3,
  // 是否按组建子文件夹：输出为 <保存文件夹>/<组号>/<组号>（<组内序号>）.扩展名
  groupSubfolder: true,
  pageHint: true,
  // 命名模板：可用 {组号} {序号} {全局序号} {原名}，也认 {g} {i} {n} {name}
  filenameTemplate: '{组号}（{序号}）',
  // 常用尺寸预设
  sizePresets: [
    { name: '800×600', width: 800, height: 600 },
    { name: '1280×720', width: 1280, height: 720 },
    { name: '1920×1080', width: 1920, height: 1080 },
    { name: '头像 400×400', width: 400, height: 400 }
  ],
  clearAfterProcess: false,
  notifyOnDone: false,
  // 关闭侧边栏后仍保留未处理的列表（存 IndexedDB，处理完自动释放）
  persistQueue: true,
  // 'downloads' | 'custom'：自定义目录依赖浏览器授权的目录句柄，只能存在本机，故走 storage.local
  outputTarget: 'downloads'
};

const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

// outputTarget 是「本机属性」，不能跟着账号同步到别的电脑（那里没有对应的目录句柄）
const LOCAL_KEYS = ['outputTarget'];
const SYNC_KEYS = Object.keys(DEFAULTS).filter((key) => !LOCAL_KEYS.includes(key));

// 命名模板里 {中文} 与 {英文} 等价
const TEMPLATE_ALIASES = { 组号: 'g', 序号: 'i', 全局序号: 'n', 原名: 'name' };

const PENDING_TTL = 60 * 1000;

// 画布上限：Chrome 单边最大 16384，超了 canvas.toBlob 会直接返回 null
const MAX_CANVAS_SIDE = 16384;
// 拖入文件夹 / 列表持久化的保护上限
const MAX_DROP_FILES = 300;
const MAX_QUEUE_ITEMS = 100;
const MAX_QUEUE_BYTES = 150 * 1024 * 1024;
const MAX_PRESETS = 20;
const MAX_NAME_LENGTH = 150;
// 浏览器解不了、需要用户先转格式的图片
const UNDECODABLE_EXT = /\.(heic|heif|tiff?|avif|jxl|raw|cr2|nef|arw|dng)$/i;

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/*  - handles：持久化输出目录句柄（File System Access 的句柄可结构化克隆） */
/*  - queue：持久化待处理列表（File 也可结构化克隆），重开侧边栏不丢       */
/* ------------------------------------------------------------------ */

const IDB_NAME = 'wb-imagetool';
const IDB_VERSION = 2;
const STORE_HANDLES = 'handles';
const STORE_QUEUE = 'queue';
const HANDLE_KEY = 'outputDir';
const QUEUE_KEY = 'pendingList';

let idbPromise = null;

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      idbPromise = null; // 别把失败的连接缓存住
      reject(request.error);
    };
  });
  return idbPromise;
}

async function idbWrite(storeName, mode, run) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = run(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const idbGet = (store, key) => idbWrite(store, 'readonly', (s) => s.get(key));
const idbSet = (store, key, value) => idbWrite(store, 'readwrite', (s) => s.put(value, key));
const idbRemove = (store, key) => idbWrite(store, 'readwrite', (s) => s.delete(key));

/* ------------------------------------------------------------------ */
/* 纯函数工具                                                          */
/* ------------------------------------------------------------------ */

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败，文件可能已损坏或格式不受支持'));
    img.src = src;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    const args = mime === 'image/png' || quality == null ? [mime] : [mime, quality];
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('画布导出失败，图片可能过大'));
      }, ...args);
    } catch (err) {
      reject(err); // 例如画布被跨域图片污染
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* 主类                                                                */
/* ------------------------------------------------------------------ */

class ImageResizer {
  constructor() {
    this.images = [];
    this.currentSize = null;
    this.settings = { ...DEFAULTS };
    this.isProcessing = false;
    this.cancelRequested = false;
    this.objectUrls = [];
    this.statusTimer = null;
    this.uid = 0;
    // 自定义输出目录（File System Access API）
    this.fsaSupported = false;
    this.customRoot = null;
    this.customPerm = null;
    this.persistTimer = null;
    this.queueOversized = false;
    this.batchRunning = false;
  }

  $(id) {
    return document.getElementById(id);
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    this.renderPresets();
    this.renderList();
    this.updateUI();
    await this.restoreQueue();
    await this.consumePendingImage();
  }

  /* ---------------- 设置 ---------------- */

  async loadSettings() {
    const [synced, local] = await Promise.all([
      chrome.storage.sync.get(SYNC_KEYS),
      chrome.storage.local.get(LOCAL_KEYS)
    ]);
    // 兼容旧版本：keepAspect 复选框已升级为 aspectMode
    if (synced.aspectMode === undefined && typeof synced.keepAspect === 'boolean') {
      synced.aspectMode = synced.keepAspect ? 'contain' : 'stretch';
    }
    this.settings = { ...DEFAULTS, ...synced, ...local };

    const width = parseInt(this.settings.savedWidth, 10);
    const height = parseInt(this.settings.savedHeight, 10);
    if (width > 0 && height > 0) {
      // 存过的值可能超出画布上限（旧版本允许填 20000），这里夹一下，免得每张图都报错
      this.currentSize = {
        width: Math.min(width, MAX_CANVAS_SIDE),
        height: Math.min(height, MAX_CANVAS_SIDE)
      };
    }

    this.syncSettingsToUI();
    await this.refreshCustomFolderState();
  }

  syncSettingsToUI() {
    this.$('customWidth').value = this.settings.savedWidth || '';
    this.$('customHeight').value = this.settings.savedHeight || '';
    this.$('outputFormat').value = this.settings.outputFormat;
    this.$('convertMode').value = this.settings.convertMode;
    this.$('aspectMode').value = this.settings.aspectMode;
    this.$('quality').value = this.settings.quality;
    this.$('groupSize').value = this.settings.groupSize;
    this.$('groupSubfolder').checked = this.settings.groupSubfolder !== false;
    this.$('autoProcess').checked = !!this.settings.autoProcess;
    this.$('clearAfterProcess').checked = !!this.settings.clearAfterProcess;
    this.$('notifyOnDone').checked = !!this.settings.notifyOnDone;
    this.$('persistQueue').checked = this.settings.persistQueue !== false;
    this.$('filenameTemplate').value = this.settings.filenameTemplate || '';
    this.$('pageHint').checked = this.settings.pageHint !== false;
    this.$('currentFolder').value = this.settings.selectedFolderPath || '';
    this.updateQualityLabel();
  }

  async patchSettings(patch) {
    Object.assign(this.settings, patch);

    const syncPatch = {};
    const localPatch = {};
    for (const [key, value] of Object.entries(patch)) {
      (LOCAL_KEYS.includes(key) ? localPatch : syncPatch)[key] = value;
    }

    // 存不进去（配额、权限）不该把设置界面一起搞崩：内存里的值已经生效，照常继续
    try {
      if (Object.keys(syncPatch).length) await chrome.storage.sync.set(syncPatch);
      if (Object.keys(localPatch).length) await chrome.storage.local.set(localPatch);
    } catch (err) {
      console.warn('[图片调整器] 保存设置失败（本次设置仍在本会话生效）:', err);
      this.showStatus('设置没能写入浏览器存储，本次会话内有效', 'error');
    }

    this.updateUI();
  }

  updateQualityLabel() {
    const value = Math.round(parseFloat(this.$('quality').value) * 100);
    this.$('qualityValue').textContent = `${value}%`;
  }

  /* ---------------- 事件 ---------------- */

  bindEvents() {
    const dropZone = this.$('dropZone');
    const fileInput = this.$('fileInput');

    dropZone.addEventListener('click', (e) => {
      if (e.target.id !== 'browseButton') fileInput.click();
    });
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    this.$('browseButton').addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      fileInput.value = '';
      await this.addFiles(files);
    });

    // 整块面板都接收拖拽：否则拖到列表区/设置区会被浏览器当成「用浏览器打开这个文件」直接跳走
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dropZone.classList.add('drag-over');
    });
    document.addEventListener('dragleave', (e) => {
      // 只有真正离开文档时才取消高亮，否则在子元素之间移动会疯狂闪烁
      if (!e.relatedTarget || !document.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
      }
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      this.handleDrop(e);
    });

    // 剪贴板粘贴（截图、复制的图片）
    document.addEventListener('paste', (e) => this.handlePaste(e));

    // 尺寸
    this.$('applyCustom').addEventListener('click', () => this.applyCustomSize());
    for (const id of ['customWidth', 'customHeight']) {
      this.$(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.applyCustomSize();
      });
    }

    // 设置项
    this.$('convertMode').addEventListener('change', async (e) => {
      await this.patchSettings({ convertMode: e.target.value });
      if (this.currentSize) this.applyCustomSize(true);
    });
    this.$('aspectMode').addEventListener('change', (e) => this.patchSettings({ aspectMode: e.target.value }));
    this.$('outputFormat').addEventListener('change', (e) => this.patchSettings({ outputFormat: e.target.value }));
    this.$('quality').addEventListener('input', () => this.updateQualityLabel());
    this.$('quality').addEventListener('change', (e) =>
      this.patchSettings({ quality: parseFloat(e.target.value) })
    );
    this.$('groupSize').addEventListener('change', async (e) => {
      const size = Math.min(999, Math.max(1, parseInt(e.target.value, 10) || 3));
      e.target.value = size;
      await this.patchSettings({ groupSize: size });
      this.recomputeGroups();
      this.renderList();
    });
    this.$('groupSubfolder').addEventListener('change', async (e) => {
      await this.patchSettings({ groupSubfolder: e.target.checked });
      this.renderList(); // 列表里的「输出」路径会跟着变
      this.showStatus(e.target.checked ? '将按组分别存进子文件夹' : '所有图片存到同一文件夹', 'success');
    });
    this.$('autoProcess').addEventListener('change', async (e) => {
      await this.patchSettings({ autoProcess: e.target.checked });
      this.showStatus(e.target.checked ? '已开启自动处理' : '已关闭自动处理', 'success');
    });
    this.$('clearAfterProcess').addEventListener('change', async (e) => {
      await this.patchSettings({ clearAfterProcess: e.target.checked });
      this.showStatus(
        e.target.checked ? '处理完成后会自动从列表移除已处理项' : '处理完成后会保留列表',
        'success'
      );
    });
    this.$('notifyOnDone').addEventListener('change', async (e) => {
      await this.patchSettings({ notifyOnDone: e.target.checked });
      if (e.target.checked) await this.notify('处理完成通知已开启', '批量处理结束后会在这里提醒你');
      else this.showStatus('已关闭处理完成通知', 'success');
    });
    this.$('persistQueue').addEventListener('change', async (e) => {
      await this.patchSettings({ persistQueue: e.target.checked });
      // 开关本身就是「存 or 清」的语义，直接复用持久化逻辑
      this.persistQueue().catch(() => {});
      this.showStatus(
        e.target.checked ? '会记住未处理的列表，重开侧边栏可恢复' : '不再记忆列表，重开侧边栏会清空',
        'success'
      );
    });

    // 命名模板：输入时只更新工作副本做实时预览，失焦才落盘，避免每敲一个字都写 storage
    const templateInput = this.$('filenameTemplate');
    templateInput.addEventListener('input', () => {
      this.settings.filenameTemplate = templateInput.value;
      this.updatePathPreview();
    });
    templateInput.addEventListener('change', () => {
      const value = templateInput.value.trim() || DEFAULTS.filenameTemplate;
      templateInput.value = value;
      this.patchSettings({ filenameTemplate: value });
    });

    // 尺寸预设
    this.$('savePresetBtn').addEventListener('click', () => this.savePreset());
    this.$('presetName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.savePreset();
    });
    this.$('presetList').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-index]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (button.classList.contains('preset-remove')) this.removePreset(index);
      else this.applyPreset(index);
    });
    this.$('pageHint').addEventListener('change', (e) => this.patchSettings({ pageHint: e.target.checked }));

    // 保存文件夹（下载目录相对路径）
    this.$('saveFolderBtn').addEventListener('click', () => this.saveFolderPath());
    this.$('currentFolder').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveFolderPath();
    });

    // 输出位置切换
    this.$('targetDownloads').addEventListener('change', () => this.patchSettings({ outputTarget: 'downloads' }));
    this.$('targetCustom').addEventListener('change', () =>
      this.customRoot ? this.patchSettings({ outputTarget: 'custom' }) : this.pickCustomFolder()
    );
    this.$('pickFolderBtn').addEventListener('click', () => this.pickCustomFolder());
    this.$('reauthFolderBtn').addEventListener('click', () => this.reauthFolder());

    // 列表操作（事件委托）
    this.$('imageList').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      if (button.dataset.action === 'process') this.processSingle(id);
      if (button.dataset.action === 'delete') this.deleteImage(id);
    });

    // 批量 / 停止
    this.$('processAll').addEventListener('click', () => {
      if (this.isProcessing) {
        this.cancelRequested = true;
        this.showStatus('正在停止…', 'processing');
      } else {
        this.processAll();
      }
    });

    this.$('clearAll').addEventListener('click', () => this.clearAll());

    // 右键菜单发来的图片（侧边栏已打开时走这里）
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.action === 'addImageFromWeb' && message.url) {
        chrome.storage.session.remove('pendingImage').catch(() => {});
        this.addImageFromURL(message.url);
      }
    });

    window.addEventListener('unload', () => {
      for (const url of this.objectUrls) URL.revokeObjectURL(url);
    });

    // 兜底：没被捕获的异常也显示到状态栏，别让面板静默失灵
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[图片调整器] 未处理的 Promise 拒绝:', e.reason);
      this.showStatus(`出错了：${e.reason?.message || e.reason}`, 'error');
    });
    window.addEventListener('error', (e) => {
      if (!e.error && !e.message) return; // 资源加载失败也会触发，忽略掉
      console.error('[图片调整器] 未捕获错误:', e.error || e.message);
      this.showStatus(`出错了：${e.message}`, 'error');
    });

    // 页面被隐藏/关闭前把还没落盘的队列刷出去（debounce 可能还没到点）
    const flushPersist = () => {
      if (!this.persistTimer) return;
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistQueue().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPersist();
    });
    window.addEventListener('pagehide', flushPersist);
  }

  /* ---------------- 添加图片 ---------------- */

  async handleDrop(e) {
    e.preventDefault();
    this.$('dropZone').classList.remove('drag-over');

    // 关键：DataTransfer 只在事件分发期间可读，一旦 await 过就失效（getData 返回空串、
    // webkitGetAsEntry 也不再可用）。所以所有内容必须在第一个 await 之前同步取出来。
    const dataTransfer = e.dataTransfer;
    const plainFiles = Array.from(dataTransfer?.files || []);
    const entries = Array.from(dataTransfer?.items || [])
      .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
      .filter(Boolean);
    const rawUrls = [dataTransfer?.getData('text/uri-list'), dataTransfer?.getData('text/plain')]
      .filter(Boolean)
      .join('\n');

    try {
      const files = await this.collectFiles(plainFiles, entries);
      if (files.length) {
        await this.addFiles(files);
        return;
      }

      const urls = rawUrls
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^(https?:|data:image\/)/i.test(s));

      if (!urls.length) {
        this.showStatus('没有识别到图片，请拖入图片文件、文件夹或网页图片', 'error');
        return;
      }
      for (const url of urls) await this.addImageFromURL(url);
    } catch (err) {
      console.error('[图片调整器] 处理拖入内容失败:', err);
      this.showStatus(`拖入的内容处理失败：${err.message}`, 'error');
    }
  }

  async handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    // 同样在 await 之前把文本读出来
    const text = files.length ? '' : (e.clipboardData?.getData('text/plain') || '').trim();

    try {
      if (files.length) {
        e.preventDefault();
        await this.addFiles(files);
        return;
      }
      if (text && /^(https?:|data:image\/)/i.test(text)) {
        e.preventDefault();
        await this.addImageFromURL(text);
      }
    } catch (err) {
      console.error('[图片调整器] 处理粘贴内容失败:', err);
      this.showStatus(`粘贴内容处理失败：${err.message}`, 'error');
    }
  }

  isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('image/')) return true;
    // 有些系统/来源给不出 MIME，只能靠扩展名兜底
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
  }

  // 拖入的可能是文件、也可能是文件夹（dataTransfer.files 拿不到目录内容，得走 webkitGetAsEntry）
  // 注意：plainFiles / entries 必须由调用方在事件分发期间同步取好再传进来
  async collectFiles(plainFiles, entries) {
    const dirs = entries.filter((entry) => entry.isDirectory);
    if (!dirs.length) return plainFiles;

    const collected = [];
    for (const dir of dirs) {
      if (collected.length >= MAX_DROP_FILES) break;
      await this.walkEntry(dir, collected, 0);
    }

    // 目录里一张图都没有时，退回普通文件列表，别让用户以为拖拽没反应
    if (!collected.length) return plainFiles;

    for (const file of plainFiles) {
      if (collected.length >= MAX_DROP_FILES) break;
      if (this.isImageFile(file)) collected.push(file);
    }

    if (collected.length >= MAX_DROP_FILES) {
      this.showStatus(`文件夹里图片太多，只取了前 ${MAX_DROP_FILES} 张`, 'error');
    }
    return collected;
  }

  async walkEntry(entry, out, depth) {
    if (out.length >= MAX_DROP_FILES) return;

    if (entry.isFile) {
      try {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        if (this.isImageFile(file)) out.push(file);
      } catch { /* 单个文件读不出来就跳过 */ }
      return;
    }

    if (!entry.isDirectory || depth >= 5) return;

    const reader = entry.createReader();
    // readEntries 一次最多给 100 条，必须反复读到空为止
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) return;
      for (const child of batch) {
        if (out.length >= MAX_DROP_FILES) return;
        await this.walkEntry(child, out, depth + 1);
      }
    }
  }

  async addFiles(files) {
    const incoming = files || [];
    const list = incoming.filter((file) => file && file.size > 0);
    if (!list.length) {
      if (incoming.length) this.showStatus('这些文件是空的，已忽略', 'error');
      return;
    }

    // 一次拖进来几百个文件会逐张解码预览，先切一刀，别让面板长时间没反应
    const accepted = list.slice(0, MAX_DROP_FILES);
    if (list.length > accepted.length) {
      this.showStatus(`一次最多处理 ${MAX_DROP_FILES} 张，多余的已忽略`, 'error');
    }

    let added = 0;
    let failed = 0;
    let skipped = 0;

    for (const file of accepted) {
      if (!this.isImageFile(file)) {
        skipped += 1;
        continue;
      }
      const ok = await this.addFile(file);
      if (ok) added += 1;
      else failed += 1; // addFile 已经给出具体原因，这里只做汇总
    }

    const parts = [];
    if (added) parts.push(`已添加 ${added} 张`);
    if (failed) parts.push(`失败 ${failed} 张`);
    if (skipped) parts.push(`忽略 ${skipped} 个非图片文件`);
    // 自动处理开启时，处理结果会覆盖这条汇总，就不要再抢一句了
    if (parts.length && !(this.settings.autoProcess && added && !failed)) {
      this.showStatus(parts.join('，'), failed ? 'error' : 'success');
    }
  }

  async addFile(file) {
    let meta;
    try {
      meta = await this.buildPreview(file);
    } catch (err) {
      // HEIC / TIFF 这类浏览器根本解不了的格式，给一句能落地的建议，别只说「解码失败」
      const hint = UNDECODABLE_EXT.test(file.name || '')
        ? '浏览器无法解码该格式，请先转成 JPG / PNG 再处理'
        : err.message;
      this.showStatus(`无法读取「${file.name}」：${hint}`, 'error');
      return false;
    }

    const image = {
      id: ++this.uid,
      file,
      name: file.name || '未命名图片',
      size: file.size,
      width: meta.width,
      height: meta.height,
      preview: meta.preview,
      processed: false,
      failed: false,
      groupIndex: 0,
      indexInGroup: 0,
      outputName: ''
    };

    this.images.push(image);
    this.recomputeGroups();
    this.renderList();
    this.updateUI();
    this.schedulePersist();

    if (this.settings.autoProcess) {
      await this.processSingle(image.id, { quiet: true });
    }
    return true;
  }

  async addImageFromURL(url) {
    this.showStatus('正在获取网页图片…', 'processing');
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.type && !blob.type.startsWith('image/') && !blob.type.startsWith('application/octet-stream')) {
        throw new Error('返回内容不是图片');
      }
      const name = this.fileNameFromURL(url, blob.type);
      const file = new File([blob], name, { type: blob.type || 'image/png' });
      this.showStatus(`已获取网页图片：${name}`, 'success');
      return await this.addFile(file);
    } catch (err) {
      this.showStatus(`网页图片加载失败：${err.message}。可能受防盗链或跨域限制，可先另存为本地文件再拖入`, 'error');
      return false;
    }
  }

  fileNameFromURL(url, mime) {
    let base = 'web_image';
    try {
      if (url.startsWith('data:')) {
        base = 'pasted_image';
      } else {
        const pathname = new URL(url).pathname;
        base = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1)) || 'web_image';
      }
    } catch { /* 保留默认名 */ }

    base = base.replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
      const ext = (mime || '').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      base = `${base}.${ext}`;
    }
    return base;
  }

  async buildPreview(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImageEl(objectUrl);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      // 缩略图按最长边 160px 生成，避免列表持有原始大图
      const max = 160;
      const scale = Math.min(max / width, max / height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器无法创建画布，可能是内存不足');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      let preview;
      try {
        preview = canvas.toDataURL('image/webp', 0.75);
      } catch {
        preview = canvas.toDataURL('image/png');
      }
      return { preview, width, height };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  /* ---------------- 分组与渲染 ---------------- */

  recomputeGroups() {
    const groupSize = Math.max(1, parseInt(this.settings.groupSize, 10) || 3);
    this.images.forEach((image, index) => {
      image.groupIndex = Math.floor(index / groupSize);
      image.indexInGroup = index % groupSize;
      image.sequenceNumber = index + 1;
    });
  }

  renderList() {
    const list = this.$('imageList');
    const total = this.images.length;
    const done = this.images.filter((i) => i.processed).length;
    const failed = this.images.filter((i) => i.failed).length;

    this.$('listSummary').textContent = total ? `共 ${total} 张 · 已处理 ${done} 张` : '列表为空';
    this.$('itemCount').textContent = failed ? `失败 ${failed} 张` : '';
    this.$('itemCount').className = failed ? 'item-count has-error' : 'item-count';

    if (!total) {
      list.innerHTML = '<p class="empty">还没有图片，拖进来试试吧</p>';
      return;
    }

    const groupSize = Math.max(1, parseInt(this.settings.groupSize, 10) || 3);
    list.innerHTML = this.images
      .map((image) => {
        const tag = image.processed
          ? `<span class="tag ok">已处理</span>`
          : image.failed
            ? `<span class="tag err">失败</span>`
            : `<span class="tag wait">待处理</span>`;

        const groupLabel =
          image.indexInGroup === 0
            ? `<div class="group-label">第 ${image.groupIndex + 1} 组</div>`
            : '';

        const output = image.outputName
          ? `<div class="meta">输出：${escapeHtml(image.outputName)}</div>`
          : '';

        const willUpscale =
          this.settings.convertMode === 'resize' &&
          this.currentSize &&
          this.currentSize.width > image.width;
        const upscaleHint = willUpscale ? '（会放大，可能变模糊）' : '';

        const actionLabel = image.processed ? '重处理' : image.failed ? '重试' : '处理';
        // 恢复的队列可能没有缩略图，用 1px 透明图兜底，免得列表出现裂图
        const thumb = image.preview || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

        return `
          <div class="image-item${image.failed ? ' is-failed' : ''}">
            <img class="image-preview" src="${thumb}" alt="">
            <div class="image-info">
              ${groupLabel}
              <div class="name" title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</div>
              <div class="meta">${image.width}×${image.height} · ${formatBytes(image.size)}${upscaleHint}</div>
              <div class="meta">序号 ${image.sequenceNumber} · 组内 ${image.indexInGroup + 1}/${groupSize}</div>
              ${output}
              ${tag}
            </div>
            <div class="item-actions">
              <button type="button" class="process-button" data-action="process" data-id="${image.id}">${actionLabel}</button>
              <button type="button" class="delete-button" data-action="delete" data-id="${image.id}">删除</button>
            </div>
          </div>`;
      })
      .join('');
  }

  updateUI() {
    const convertMode = this.$('convertMode').value;
    const needsSize = convertMode === 'resize';
    const processAll = this.$('processAll');

    if (this.batchRunning) {
      processAll.disabled = false;
      processAll.textContent = '停止处理';
      processAll.classList.add('is-stopping');
    } else {
      const allDone = this.images.length > 0 && this.images.every((image) => image.processed);
      processAll.disabled = this.isProcessing || this.images.length === 0 || (needsSize && !this.currentSize);
      processAll.textContent = this.isProcessing ? '处理中…' : allDone ? '重新处理全部' : '批量处理';
      processAll.classList.remove('is-stopping');
    }

    this.$('aspectGroup').hidden = !needsSize;
    this.$('qualityGroup').hidden = !['jpeg', 'webp'].includes(this.$('outputFormat').value);
    this.$('clearAll').disabled = this.isProcessing;

    this.updateOutputTargetUI();
    this.updatePathPreview();

    // updateOutputTargetUI 会按能力重算 disabled，处理中要把它重新锁回去
    if (this.isProcessing) this.setConfigLocked(true);
  }

  updateOutputTargetUI() {
    const custom = this.settings.outputTarget === 'custom';

    this.$('targetCustom').checked = custom;
    this.$('targetDownloads').checked = !custom;
    this.$('targetCustom').disabled = !this.fsaSupported;
    this.$('targetCustom').closest('label')?.classList.toggle('is-disabled', !this.fsaSupported);

    this.$('downloadsRow').hidden = custom;
    this.$('downloadsHint').hidden = custom;
    this.$('customRow').hidden = !custom;
    this.$('customHint').hidden = !(custom || !this.fsaSupported);
    this.$('pickFolderBtn').textContent = this.customRoot ? '更换…' : '选择…';
    this.$('reauthRow').hidden = !(custom && this.customRoot && this.customPerm !== 'granted');

    if (!this.fsaSupported) {
      this.$('customHint').textContent =
        '当前浏览器不支持 File System Access API，无法选择电脑上的任意文件夹；可改用下载目录，或调整 Chrome 的默认下载位置。';
    } else if (custom && this.customPerm !== 'granted') {
      this.$('customHint').textContent =
        '权限需要重新确认：直接点「批量处理」，浏览器会弹出授权提示，同意即可写入；也可以先点上面的「重新授权访问此文件夹」。';
    } else {
      this.$('customHint').textContent =
        '可选电脑上任意可写目录（例如 D:\\图片\\已处理）。浏览器不会把完整路径告诉扩展，所以这里只显示文件夹名。';
    }
  }

  // 实时展示输出路径与文件名示例，避免用户对落点没概念
  updatePathPreview() {
    const el = this.$('pathPreview');
    if (!el) return;

    const sampleName = this.buildFilename(
      { groupIndex: 0, indexInGroup: 0, sequenceNumber: 1, name: '原图.jpg' },
      'jpg'
    );

    const templatePreview = this.$('templatePreview');
    if (templatePreview) {
      templatePreview.innerHTML = `文件名示例：<code>${escapeHtml(sampleName)}</code>`;
    }

    if (this.settings.outputTarget === 'custom') {
      const root = this.customRoot ? this.customRoot.name : '（未选择文件夹）';
      const warn = this.customPerm === 'granted' ? '' : '　（处理时会请求授权）';
      const sample = [this.groupFolderFor({ groupIndex: 0 }), sampleName].filter(Boolean).join('/');
      el.innerHTML = `输出示例：<code>${escapeHtml(`${root}/${sample}`)}</code>${warn}`;
      return;
    }

    const sample = this.buildRelativePath({ groupIndex: 0 }, sampleName);
    const parts = [this.settings.selectedFolderPath || '', sample].filter(Boolean);
    el.innerHTML = `输出示例：<code>${escapeHtml(parts.join('/'))}</code>（相对浏览器下载目录）`;
  }

  /* ---------------- 尺寸设置 ---------------- */

  async applyCustomSize(silent = false) {
    // 预设按钮在 <div> 里，disabled 传不下去，这里兜一道
    if (!this.canEditConfig()) return;

    const width = parseInt(this.$('customWidth').value, 10);
    const height = parseInt(this.$('customHeight').value, 10);

    if (!(width > 0) || !(height > 0)) {
      this.currentSize = null;
      this.showStatus('请输入有效的宽度和高度', 'error');
      this.updateUI();
      return;
    }

    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
      this.showStatus(`宽高不能超过 ${MAX_CANVAS_SIDE}（浏览器画布单边上限），请改小一些`, 'error');
      return;
    }

    this.currentSize = { width, height };
    this.$('customWidth').value = width;
    this.$('customHeight').value = height;
    // 走 patchSettings 统一写盘，顺带拿到 storage 异常的保护
    await this.patchSettings({ savedWidth: width, savedHeight: height });
    if (!silent) this.showStatus(`目标尺寸已设为 ${width} × ${height}`, 'success');
    this.renderList();
    this.updateUI();
  }

  /* ---------------- 尺寸预设 ---------------- */

  getPresets() {
    if (!Array.isArray(this.settings.sizePresets)) return [];
    // storage 里的内容可能被手改坏（同步过来、旧版本遗留），过滤掉不合法条目，免得渲染出 NaN
    return this.settings.sizePresets
      .map((preset) => ({
        name: String(preset?.name || '').trim() || `${preset?.width}×${preset?.height}`,
        width: parseInt(preset?.width, 10),
        height: parseInt(preset?.height, 10)
      }))
      .filter(
        (preset) =>
          preset.width > 0 && preset.height > 0 &&
          preset.width <= MAX_CANVAS_SIDE && preset.height <= MAX_CANVAS_SIDE
      );
  }

  renderPresets() {
    const list = this.$('presetList');
    const presets = this.getPresets();

    if (!presets.length) {
      list.innerHTML = '<span class="preset-empty">暂无预设：填好上面的宽高后点「存为预设」</span>';
      return;
    }

    list.innerHTML = presets
      .map(
        (preset, index) => `
        <span class="preset-chip">
          <button type="button" class="preset-apply" data-index="${index}" title="应用到目标尺寸">${escapeHtml(preset.name)}</button>
          <button type="button" class="preset-remove" data-index="${index}" title="删除此预设" aria-label="删除预设">×</button>
        </span>`
      )
      .join('');
  }

  applyPreset(index) {
    const preset = this.getPresets()[index];
    if (!preset) return;
    this.$('customWidth').value = preset.width;
    this.$('customHeight').value = preset.height;
    this.applyCustomSize();
  }

  async removePreset(index) {
    if (!this.canEditConfig()) return;
    const presets = this.getPresets().slice();
    const [removed] = presets.splice(index, 1);
    if (!removed) return;
    await this.patchSettings({ sizePresets: presets });
    this.renderPresets();
    this.showStatus(`已删除预设「${removed.name}」`, 'success');
  }

  async savePreset() {
    if (!this.canEditConfig()) return;

    const width = parseInt(this.$('customWidth').value, 10);
    const height = parseInt(this.$('customHeight').value, 10);
    if (!(width > 0) || !(height > 0)) {
      this.showStatus('请先填写有效的宽度和高度', 'error');
      return;
    }

    const name = this.$('presetName').value.trim() || `${width}×${height}`;
    const presets = this.getPresets().slice();
    const existing = presets.findIndex((p) => p.width === width && p.height === height);

    if (existing < 0 && presets.length >= MAX_PRESETS) {
      this.showStatus(`最多保存 ${MAX_PRESETS} 个预设，请先删掉几个`, 'error');
      return;
    }

    if (existing >= 0) presets[existing] = { name, width, height };
    else presets.push({ name, width, height });

    await this.patchSettings({ sizePresets: presets });
    this.$('presetName').value = '';
    this.renderPresets();
    this.showStatus(existing >= 0 ? `已更新预设「${name}」` : `已保存预设「${name}」`, 'success');
  }

  async saveFolderPath() {
    const raw = this.$('currentFolder').value.trim();
    const clean = raw
      .split(/[\\/]+/)
      .map((segment) => segment.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_').trim())
      .filter(Boolean)
      .join('/');
    this.$('currentFolder').value = clean;
    await this.patchSettings({ selectedFolderPath: clean, saveFolder: clean || DEFAULTS.saveFolder });
    this.showStatus(clean ? `保存位置已设为：${clean}` : '将保存到浏览器下载目录', 'success');
  }

  /* ---------------- 自定义输出目录（File System Access API） ---------------- */

  // 读取已保存的目录句柄并查询权限状态
  async refreshCustomFolderState() {
    this.fsaSupported = typeof window.showDirectoryPicker === 'function';
    try {
      this.customRoot = (await idbGet(STORE_HANDLES, HANDLE_KEY)) || null;
    } catch (err) {
      console.warn('[图片调整器] 读取目录句柄失败:', err);
      this.customRoot = null;
    }

    if (this.customRoot) {
      try {
        this.customPerm = await this.customRoot.queryPermission({ mode: 'readwrite' });
      } catch {
        this.customPerm = 'denied';
      }
    } else {
      this.customPerm = null;
    }

    this.$('customFolderName').value = this.customRoot ? this.customRoot.name : '';

    // 句柄丢了（换设备、清了站点数据）就明确退回下载目录，绝不悄悄写到别的地方
    if (this.settings.outputTarget === 'custom' && !this.customRoot) {
      await this.patchSettings({ outputTarget: 'downloads' });
      this.showStatus('之前选择的自定义文件夹已失效，已切回浏览器下载目录，请重新选择', 'error');
    }
  }

  async pickCustomFolder() {
    if (!this.fsaSupported) {
      this.showStatus('当前浏览器不支持选择文件夹，请改用下载目录', 'error');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: 'wbImageToolOutput',
        mode: 'readwrite',
        startIn: 'downloads'
      });
      await idbSet(STORE_HANDLES, HANDLE_KEY, handle);
      this.customRoot = handle;
      this.customPerm = 'granted';
      this.$('customFolderName').value = handle.name;
      await this.patchSettings({ outputTarget: 'custom' });
      this.showStatus(`输出位置已设为「${handle.name}」，之后会直接写入该文件夹`, 'success');
    } catch (err) {
      if (err?.name === 'AbortError') {
        this.updateUI(); // 用户取消：把单选按钮状态同步回来
        return;
      }
      console.error('[图片调整器] 选择文件夹失败:', err);
      this.showStatus(`选择文件夹失败：${err.message}`, 'error');
      this.updateUI();
    }
  }

  // 权限过期后重新申请；requestPermission 必须在用户手势里调用，所以只能由按钮触发
  async reauthFolder() {
    if (!this.customRoot) {
      this.showStatus('还没有选择文件夹，请先点「选择…」', 'error');
      return;
    }
    try {
      this.customPerm = await this.customRoot.requestPermission({ mode: 'readwrite' });
      this.showStatus(
        this.customPerm === 'granted' ? `已授权：${this.customRoot.name}` : '未获得授权，无法写入该文件夹',
        this.customPerm === 'granted' ? 'success' : 'error'
      );
    } catch (err) {
      this.showStatus(`授权失败：${err.message}`, 'error');
    }
    this.updateUI();
  }

  // 返回这次处理该用的自定义目录句柄；未启用自定义目录时返回 null（走下载目录）
  async resolveOutputRoot() {
    if (this.settings.outputTarget !== 'custom') return null;
    if (!this.customRoot) {
      throw new Error('自定义文件夹已失效，请重新选择或切回浏览器下载目录');
    }

    this.customPerm = await this.customRoot.queryPermission({ mode: 'readwrite' });

    // 文件系统权限是按会话记的：新开一次侧边栏后通常会回到 prompt 状态。
    // 「点处理」本身就是用户手势，可以就地申请，省掉一次多余的点击。
    // 若浏览器判定没有用户手势（例如自动处理），会抛错，那就退回手动授权按钮。
    if (this.customPerm === 'prompt') {
      try {
        this.customPerm = await this.customRoot.requestPermission({ mode: 'readwrite' });
      } catch (err) {
        console.warn('[图片调整器] 自动申请目录权限失败，需要手动授权:', err);
        this.customPerm = 'prompt';
      }
    }

    if (this.customPerm !== 'granted') {
      this.updateUI();
      throw new Error('自定义文件夹未授权，请点「重新授权访问此文件夹」，或切回浏览器下载目录');
    }
    return this.customRoot;
  }

  // 同名时不覆盖已有文件，按 (1)(2)… 顺延，与下载目录下的 uniquify 行为保持一致
  async uniqueFileName(dirHandle, filename) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';

    let candidate = filename;
    for (let i = 1; i <= 200; i++) {
      try {
        await dirHandle.getFileHandle(candidate);
        candidate = `${stem}(${i})${ext}`;
      } catch {
        return candidate; // 不存在，可用
      }
    }
    return `${stem}(${Date.now()})${ext}`;
  }

  async writeToDirectory(root, image, filename, blob) {
    const useSubfolder = this.settings.groupSubfolder !== false;
    const folderName = String(image.groupIndex + 1);

    let dir = root;
    if (useSubfolder) {
      try {
        dir = await root.getDirectoryHandle(folderName, { create: true });
      } catch (err) {
        // 目标位置已经有同名的「文件」时这里会抛 TypeMismatchError，提示得说人话
        throw new Error(`无法创建组子目录「${folderName}」：${err.message}（该名称可能已被同名文件占用）`);
      }
    }

    const finalName = await this.uniqueFileName(dir, filename);
    const fileHandle = await dir.getFileHandle(finalName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      try {
        await writable.abort();
      } catch { /* 已经关掉了，忽略 */ }
      throw err;
    }

    return [useSubfolder ? folderName : '', finalName].filter(Boolean).join('/');
  }

  /* ---------------- 列表操作 ---------------- */

  // 用 id 定位，避免和数组自带的 findIndex 混在一起看不懂
  indexOfId(id) {
    return this.images.findIndex((image) => image.id === id);
  }

  deleteImage(id) {
    if (this.isProcessing) {
      this.showStatus('处理中，暂时不能删除', 'error');
      return;
    }
    const index = this.indexOfId(id);
    if (index < 0) return;
    const [removed] = this.images.splice(index, 1);
    this.recomputeGroups();
    this.renderList();
    this.updateUI();
    this.schedulePersist();
    this.showStatus(`已移除：${removed.name}`, 'success');
  }

  clearAll() {
    if (!this.images.length) return;
    if (this.isProcessing) {
      this.showStatus('处理中，暂时不能清空', 'error');
      return;
    }
    if (!confirm(`确定要清空列表里的 ${this.images.length} 张图片吗？（已下载的文件不受影响）`)) return;
    this.images = [];
    this.renderList();
    this.updateUI();
    this.schedulePersist();
    this.showStatus('列表已清空', 'success');
  }

  /* ---------------- 处理 ---------------- */

  async processSingle(id, options = {}) {
    const image = this.images[this.indexOfId(id)];
    if (!image) return;

    // 同步占锁：下面全是 await，不在这里提前置位的话连点两次会同时跑两遍同一张图
    if (this.isProcessing) {
      // 自动处理被前面的活儿挡下时不需要弹错，用户没在等这一张
      if (!options.quiet) this.showStatus('正在处理，等这批跑完再操作', 'error');
      return;
    }
    this.isProcessing = true; // 已处理过的也允许再点：改完参数可重处理，靠 uniquify 不覆盖旧文件
    this.setConfigLocked(true);
    this.updateUI();

    try {
      const problem = this.validateReady();
      if (problem) {
        this.showStatus(problem, 'error');
        return;
      }

      let root;
      try {
        root = await this.resolveOutputRoot();
      } catch (err) {
        this.showStatus(err.message, 'error');
        return;
      }

      const wasProcessed = image.processed;
      try {
        const result = await this.renderAndSave(image, root);
        image.processed = true;
        image.failed = false;
        image.outputName = result.path;
        if (!options.quiet) {
          const prefix = wasProcessed ? '重新处理完成' : '完成';
          this.showStatus(
            `${prefix}：${result.path}（${result.width}×${result.height}，${formatBytes(result.size)}）`,
            'success'
          );
        }
      } catch (err) {
        image.failed = true;
        console.error('[图片调整器] 处理失败:', err);
        this.showStatus(`处理失败（${image.name}）：${err.message}`, 'error');
      }
    } catch (err) {
      console.error('[图片调整器] 单张处理异常:', err);
      this.showStatus(`处理异常：${err.message}`, 'error');
    } finally {
      // 无论中途怎么返回，锁和控件状态都必须复原
      this.isProcessing = false;
      this.setConfigLocked(false);
      this.pruneProcessed(); // 内部自带重绘；顺带处理「处理完自动清理」
      this.schedulePersist();
    }
  }

  validateReady() {
    const convertMode = this.$('convertMode').value;
    if (convertMode === 'resize' && !this.currentSize) return '请先设置目标尺寸';
    return '';
  }

  // 处理完自动清理：只移除已成功的条目，失败的留在列表里方便重试
  pruneProcessed() {
    let removed = 0;

    if (this.settings.clearAfterProcess) {
      const before = this.images.length;
      this.images = this.images.filter((image) => !image.processed);
      removed = before - this.images.length;
      if (removed) this.recomputeGroups();
    }

    this.renderList();
    this.updateUI();
    return removed;
  }

  async notify(title, message) {
    if (!this.settings.notifyOnDone) return;
    try {
      await chrome.notifications.create(`wb-imagetool-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message
      });
    } catch (err) {
      console.warn('[图片调整器] 发送系统通知失败:', err);
    }
  }

  async processAll() {
    // 同步占锁：后面有 await，不提前置位的话连点两次会跑出两个并发批次
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.batchRunning = true;
    this.cancelRequested = false;
    this.setConfigLocked(true); // 处理中锁住参数控件，免得同一批前后用了不同设置
    this.updateUI();

    try {
      const problem = this.validateReady();
      if (problem) {
        this.showStatus(problem, 'error');
        return;
      }

      let pending = this.images.filter((image) => !image.processed);
      let rerun = false;
      if (!pending.length) {
        // 全都处理过了：再点一次就是「用当前参数重新跑一遍」，靠 uniquify / (1) 顺延不覆盖旧文件
        pending = this.images.slice();
        rerun = true;
      }
      if (!pending.length) {
        this.showStatus('列表里还没有图片', 'error');
        return;
      }

      // 输出目标在整批开始前一次性确认，避免每张图各失败一次
      let root;
      try {
        root = await this.resolveOutputRoot();
      } catch (err) {
        this.showStatus(err.message, 'error');
        return;
      }

      this.showProgress(0, pending.length);
      if (rerun) {
        this.showStatus(`重新处理全部 ${pending.length} 张（会生成新文件，不覆盖原有文件）`, 'processing');
      }

      let ok = 0;
      let failed = 0;
      let lastRenderAt = 0;

      for (let i = 0; i < pending.length; i++) {
        if (this.cancelRequested) break;
        const image = pending[i];
        this.showStatus(`处理中 ${i + 1}/${pending.length}：${image.name}`, 'processing');
        try {
          const result = await this.renderAndSave(image, root);
          image.processed = true;
          image.failed = false;
          image.outputName = result.path;
          ok += 1;
        } catch (err) {
          image.failed = true;
          failed += 1;
          console.error('[图片调整器] 处理失败:', image.name, err);
        }
        this.showProgress(i + 1, pending.length);
        // 长列表不必每张都全量重绘（O(n²)），进度条已经能反映进度；结束时再补一次完整渲染
        if (this.images.length <= 50 || Date.now() - lastRenderAt > 300) {
          this.renderList();
          lastRenderAt = Date.now();
        }
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程，保持界面响应
      }

      this.renderList();

      const parts = [`成功 ${ok} 张`];
      if (failed) parts.push(`失败 ${failed} 张`);
      if (this.cancelRequested) parts.push('已手动停止');

      const removed = this.pruneProcessed();
      if (removed) parts.push(`已从列表移除 ${removed} 张`);

      const summary = parts.join('，');
      this.showStatus(summary, failed || this.cancelRequested ? 'error' : 'success');
      // 批量跑完时用户往往已经切去别的窗口了，补一条系统通知
      await this.notify('图片处理完成', summary);
    } catch (err) {
      console.error('[图片调整器] 批量处理异常:', err);
      this.showStatus(`批量处理异常：${err.message}`, 'error');
    } finally {
      this.isProcessing = false;
      this.batchRunning = false;
      this.setConfigLocked(false);
      this.hideProgress();
      this.updateUI();
      this.schedulePersist();
      this.cancelRequested = false;
    }
  }

  // 处理中不允许改会影响输出的参数：否则同一批里前后图片用的设置不一样
  canEditConfig() {
    if (!this.isProcessing) return true;
    this.showStatus('正在处理，等这批跑完再改参数', 'error');
    return false;
  }

  // 处理中锁住会影响输出结果的控件（尺寸/格式/命名/输出位置），保证整批参数一致
  setConfigLocked(locked) {
    const ids = [
      'customWidth', 'customHeight', 'applyCustom', 'convertMode', 'aspectMode', 'outputFormat',
      'quality', 'groupSize', 'filenameTemplate', 'presetList', 'savePresetBtn', 'presetName',
      'currentFolder', 'saveFolderBtn', 'targetDownloads', 'targetCustom', 'pickFolderBtn',
      'reauthFolderBtn', 'groupSubfolder'
    ];
    for (const id of ids) {
      const el = this.$(id);
      if (el) el.disabled = locked;
    }
  }

  showProgress(current, total) {
    const progress = this.$('progress');
    progress.hidden = false;
    this.$('progressBar').style.width = `${total ? Math.round((current / total) * 100) : 0}%`;
    this.$('progressText').textContent = `${current} / ${total}`;
  }

  hideProgress() {
    this.$('progress').hidden = true;
    this.$('progressBar').style.width = '0%';
    this.$('progressText').textContent = '';
  }

  /* ---------------- 渲染与保存 ---------------- */

  resolveOutputFormat(file) {
    const format = this.$('outputFormat').value;
    if (format !== 'original') {
      return { mime: MIME_BY_FORMAT[format], ext: format === 'jpeg' ? 'jpg' : format };
    }

    const type = (file.type || '').toLowerCase();
    if (type === 'image/jpeg' || type === 'image/jpg') return { mime: 'image/jpeg', ext: 'jpg' };
    if (type === 'image/png') return { mime: 'image/png', ext: 'png' };
    if (type === 'image/webp') return { mime: 'image/webp', ext: 'webp' };

    // 有些来源给不出 MIME（type 为空），退回按扩展名判断，别一律压成 PNG
    if (!type) {
      const ext = String(file.name || '').split('.').pop()?.toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return { mime: 'image/jpeg', ext: 'jpg' };
      if (ext === 'png') return { mime: 'image/png', ext: 'png' };
      if (ext === 'webp') return { mime: 'image/webp', ext: 'webp' };
    }

    // gif / bmp / avif / svg 等画布只能安全输出为 PNG
    return { mime: 'image/png', ext: 'png' };
  }

  // 先算尺寸再卡上限：超了会在 canvas.toBlob 阶段拿到 null，报「导出失败」根本看不出原因
  planDraw(img, convertMode) {
    const plan = this.computeDrawPlan(img, convertMode);
    const longestSide = Math.max(plan.canvasW, plan.canvasH);
    if (longestSide > MAX_CANVAS_SIDE) {
      throw new Error(`输出尺寸 ${plan.canvasW}×${plan.canvasH} 超出浏览器上限（单边最大 ${MAX_CANVAS_SIDE}px）`);
    }
    return plan;
  }

  computeDrawPlan(img, convertMode) {
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (!iw || !ih) throw new Error('无法读取图片尺寸（可能是无内在尺寸的 SVG）');

    if (convertMode === 'format_only') {
      return { canvasW: iw, canvasH: ih, sw: iw, sh: ih, dx: 0, dy: 0, dw: iw, dh: ih };
    }

    if (!this.currentSize) throw new Error('请先设置目标尺寸');
    const { width: tw, height: th } = this.currentSize;
    const mode = this.$('aspectMode').value;

    if (mode === 'stretch') {
      return { canvasW: tw, canvasH: th, sw: iw, sh: ih, dx: 0, dy: 0, dw: tw, dh: th };
    }

    const scale = mode === 'cover' ? Math.max(tw / iw, th / ih) : Math.min(tw / iw, th / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));

    if (mode === 'cover') {
      return {
        canvasW: tw,
        canvasH: th,
        sw: iw,
        sh: ih,
        dx: Math.round((tw - dw) / 2),
        dy: Math.round((th - dh) / 2),
        dw,
        dh
      };
    }
    // contain：画布贴合缩放后的实际尺寸，不留白边
    return { canvasW: dw, canvasH: dh, sw: iw, sh: ih, dx: 0, dy: 0, dw, dh };
  }

  // root 为自定义输出目录句柄；为空则走浏览器下载目录
  async renderAndSave(image, root = null) {
    const convertMode = this.$('convertMode').value;
    const { mime, ext } = this.resolveOutputFormat(image.file);
    const quality = parseFloat(this.$('quality').value) || DEFAULTS.quality;

    const objectUrl = URL.createObjectURL(image.file);
    let blob;
    let width;
    let height;

    try {
      const img = await loadImageEl(objectUrl);
      const plan = this.planDraw(img, convertMode);

      const canvas = document.createElement('canvas');
      canvas.width = plan.canvasW;
      canvas.height = plan.canvasH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器无法创建画布，可能是内存不足');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // JPEG 没有透明通道，透明区域会被编码成黑色，先铺白底
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      ctx.drawImage(img, 0, 0, plan.sw, plan.sh, plan.dx, plan.dy, plan.dw, plan.dh);
      blob = await canvasToBlob(canvas, mime, mime === 'image/png' ? null : quality);
      width = plan.canvasW;
      height = plan.canvasH;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    const filename = this.buildFilename(image, ext);

    // 自定义目录（File System Access）：直接写盘，不受下载目录限制
    if (root) {
      const path = await this.writeToDirectory(root, image, filename, blob);
      return { filename, path, size: blob.size, width, height };
    }

    const relativePath = this.buildRelativePath(image, filename);
    await this.saveBlob(blob, relativePath, filename);
    return { filename, path: relativePath, size: blob.size, width, height };
  }

  // 按组建立子文件夹时，子目录名取组号
  groupFolderFor(image) {
    return this.settings.groupSubfolder !== false ? String(image.groupIndex + 1) : '';
  }

  buildRelativePath(image, filename) {
    return [this.groupFolderFor(image), filename].filter(Boolean).join('/');
  }

  // 模板里的非法字符统一清理；顺带干掉路径分隔符，防止模板意外建出子目录
  sanitizeFileNamePart(value) {
    return String(value)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, MAX_NAME_LENGTH)
      .trim();
  }

  buildFilename(image, ext) {
    const groupSize = Math.max(1, parseInt(this.settings.groupSize, 10) || 3);
    const pad = Math.max(3, String(groupSize).length);
    const tokens = {
      g: String(image.groupIndex + 1),
      i: String(image.indexInGroup + 1).padStart(pad, '0'),
      n: String(image.sequenceNumber || 1).padStart(pad, '0'),
      name: String(image.name || '').replace(/\.[^.]+$/, '')
    };

    const pattern = String(this.settings.filenameTemplate || DEFAULTS.filenameTemplate);
    const filled = pattern.replace(/\{([^{}]*)\}/g, (match, rawKey) => {
      const key = TEMPLATE_ALIASES[rawKey.trim()] || rawKey.trim();
      return key in tokens ? tokens[key] : match; // 不认识的变量原样保留，用户一眼能看出拼错了
    });

    const safe = this.sanitizeFileNamePart(filled);
    // 清理完连一个字母/数字都不剩（比如模板只填了 ///），回落到默认命名
    if (!/[\p{L}\p{N}]/u.test(safe)) return `${tokens.g}（${tokens.i}）.${ext}`;
    return `${safe}.${ext}`;
  }

  async saveBlob(blob, relativePath, displayName = relativePath) {
    const folder = (this.settings.selectedFolderPath || '').trim();
    const path = folder ? `${folder}/${relativePath}` : relativePath;
    let objectUrl = null;

    try {
      // 直接用 blob URL 交给下载 API，避免 base64 转换导致的内存翻倍
      objectUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url: objectUrl,
        filename: path,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      this.releaseLater(objectUrl);
    } catch (err) {
      console.warn('[图片调整器] downloads API 失败，改用链接下载:', err);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const fallbackUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = fallbackUrl;
      // 注：a 标签下载无法写入子目录，只能落到默认下载目录，所以这里只保留文件名
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.releaseLater(fallbackUrl);
    }
  }

  releaseLater(url) {
    this.objectUrls.push(url);
    setTimeout(() => {
      const index = this.objectUrls.indexOf(url);
      if (index >= 0) this.objectUrls.splice(index, 1);
      URL.revokeObjectURL(url);
    }, 60 * 1000);
  }

  /* ---------------- 与后台/内容脚本联动 ---------------- */

  /* ---------------- 待处理列表持久化 ---------------- */

  // 增删很频繁，合并成一次写入
  schedulePersist() {
    if (!this.settings.persistQueue) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistQueue().catch((err) => console.warn('[图片调整器] 保存待处理列表失败:', err));
    }, 500);
  }

  async persistQueue() {
    // 只存未处理的：处理完立刻释放，不让它长期占磁盘
    const pending = this.images.filter((image) => !image.processed);

    if (!this.settings.persistQueue || !pending.length) {
      await idbRemove(STORE_QUEUE, QUEUE_KEY);
      return;
    }

    const bytes = pending.reduce((sum, image) => sum + (image.size || 0), 0);
    if (pending.length > MAX_QUEUE_ITEMS || bytes > MAX_QUEUE_BYTES) {
      await idbRemove(STORE_QUEUE, QUEUE_KEY);
      if (!this.queueOversized) {
        this.queueOversized = true;
        this.showStatus(
          `列表太大（${pending.length} 张）不做记忆，重开侧边栏会丢；可以先处理掉一部分`,
          'error'
        );
      }
      return;
    }

    this.queueOversized = false;
    await idbSet(
      STORE_QUEUE,
      QUEUE_KEY,
      pending.map((image) => ({
        id: image.id,
        file: image.file,
        name: image.name,
        size: image.size,
        width: image.width,
        height: image.height,
        preview: image.preview
      }))
    );
  }

  async restoreQueue() {
    if (!this.settings.persistQueue) return;

    let payload;
    try {
      payload = await idbGet(STORE_QUEUE, QUEUE_KEY);
    } catch (err) {
      console.warn('[图片调整器] 读取待处理列表失败:', err);
      return;
    }
    if (!Array.isArray(payload) || !payload.length) return;

    this.images = payload
      // 只接受真正的 File / Blob，存储被写坏时不至于在后面 createObjectURL 处炸掉
      .filter((item) => item && item.file instanceof Blob)
      .map((item) => ({
        id: item.id || ++this.uid,
        file: item.file,
        name: item.name || item.file.name || '未命名图片',
        size: item.size ?? item.file.size,
        width: item.width || 0,
        height: item.height || 0,
        preview: item.preview || '',
        processed: false,
        failed: false,
        groupIndex: 0,
        indexInGroup: 0,
        outputName: ''
      }));

    if (!this.images.length) return;

    this.uid = Math.max(this.uid, ...this.images.map((image) => image.id || 0));
    this.recomputeGroups();
    this.renderList();
    this.updateUI();
    this.showStatus(`已恢复上次未处理的 ${this.images.length} 张图片`, 'success');
  }

  async consumePendingImage() {
    try {
      const stored = await chrome.storage.session.get('pendingImage');
      const pending = stored.pendingImage;
      if (!pending) return;
      await chrome.storage.session.remove('pendingImage');
      if (Date.now() - pending.at > PENDING_TTL) return;
      await this.addImageFromURL(pending.url);
    } catch (err) {
      console.warn('[图片调整器] 读取暂存图片失败:', err);
    }
  }

  /* ---------------- 状态提示 ---------------- */

  showStatus(message, type = 'info') {
    const status = this.$('status');
    status.textContent = message;
    status.className = `status ${type}`;
    clearTimeout(this.statusTimer);
    if (type !== 'processing') {
      this.statusTimer = setTimeout(() => {
        status.textContent = '';
        status.className = 'status';
      }, 4000);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ImageResizer().init();
});
