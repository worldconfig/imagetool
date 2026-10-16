// 纯逻辑冒烟测试（缩放几何 / 命名模板 / 输出格式 / 画布上限 / 自定义目录写入）
//
// 用法：在项目根目录执行
//   node dev-tests/smoke.js
//
// 做法：用 vm + 桩 DOM 加载 imagetool2.1/sidepanel.js，取出类后直接调纯方法，
// 不依赖浏览器、不产生任何文件。改完代码先跑这个，再考虑上真机。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIDEPANEL = path.join(__dirname, '..', 'imagetool2.1', 'sidepanel.js');
const src = fs.readFileSync(SIDEPANEL, 'utf8')
  + '\nglobalThis.__ImageResizer = ImageResizer;';

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  Image: class {},
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { getContext: () => ({ drawImage() {} }), toDataURL: () => '' }; }
  },
  chrome: { storage: { sync: { get: async () => ({}), set: async () => {} }, session: {} }, runtime: {} },
  window: {}
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const C = ctx.__ImageResizer;
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}\n      exp ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
}

function makeInst(size, aspectMode, convertMode, groupSize, groupSubfolder = true) {
  const inst = Object.create(C.prototype);
  inst.currentSize = size;
  inst.settings = { groupSize, convertMode, groupSubfolder };
  inst.$ = (id) => ({
    aspectMode: { value: aspectMode },
    convertMode: { value: convertMode },
    outputFormat: { value: 'original' },
    quality: { value: '0.92' }
  }[id]);
  return inst;
}

const img = { naturalWidth: 1000, naturalHeight: 500 };
const geometry = (mode) => {
  const p = makeInst({ width: 800, height: 600 }, mode, 'resize', 3).planDraw(img, 'resize');
  return [p.canvasW, p.canvasH, p.dx, p.dy, p.dw, p.dh];
};

// 原图 1000x500（宽扁），目标 800x600
check('contain 长边贴合', geometry('contain'), [800, 400, 0, 0, 800, 400]);
check('cover 居中裁剪', geometry('cover'), [800, 600, -200, 0, 1200, 600]);
check('stretch 强制精确', geometry('stretch'), [800, 600, 0, 0, 800, 600]);

// 竖图 500x1000 → 800x600
const tall = { naturalWidth: 500, naturalHeight: 1000 };
const tallPlan = makeInst({ width: 800, height: 600 }, 'cover', 'resize', 3).planDraw(tall, 'resize');
// 500x1000 cover 到 800x600：scale = max(1.6, 0.6) = 1.6 → 800x1600，上下各裁 500
check('cover 竖图居中裁剪', [tallPlan.canvasW, tallPlan.canvasH, tallPlan.dx, tallPlan.dy, tallPlan.dw, tallPlan.dh],
  [800, 600, 0, -500, 800, 1600]);

const foPlan = makeInst({ width: 800, height: 600 }, 'contain', 'format_only', 3).planDraw(img, 'format_only');
check('仅转格式保持原尺寸', [foPlan.canvasW, foPlan.canvasH], [1000, 500]);

// 命名规则
const name = (groupIndex, indexInGroup, groupSize, ext) => {
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', groupSize);
  return inst.buildFilename({ groupIndex, indexInGroup }, ext);
};
check('命名 1（001）', name(0, 0, 3, 'jpg'), '1（001）.jpg');
check('命名 2（003）', name(1, 2, 3, 'png'), '2（003）.png');
check('组大小 12 → 补零 3 位', name(0, 11, 12, 'webp'), '1（012）.webp');
check('组大小 1200 → 补零 4 位', name(0, 1199, 1200, 'jpg'), '1（1200）.jpg');
check('第 4 组首位', name(3, 0, 3, 'jpg'), '4（001）.jpg');

// 输出格式解析
const fmt = (requested, type) => {
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3);
  inst.$ = (id) => ({ outputFormat: { value: requested } }[id]);
  return inst.resolveOutputFormat({ type, name: 'a' });
};
check('保持原格式 jpeg→jpg', fmt('original', 'image/jpeg'), { mime: 'image/jpeg', ext: 'jpg' });
check('保持原格式 gif→png', fmt('original', 'image/gif'), { mime: 'image/png', ext: 'png' });
check('保持原格式 svg→png', fmt('original', 'image/svg+xml'), { mime: 'image/png', ext: 'png' });
check('强制 webp', fmt('webp', 'image/png'), { mime: 'image/webp', ext: 'webp' });
check('强制 jpeg', fmt('jpeg', 'image/png'), { mime: 'image/jpeg', ext: 'jpg' });

// 组子目录（同一组的图落进同一个子目录）
const relPath = (groupIndex, indexInGroup, groupSize, groupSubfolder) => {
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', groupSize, groupSubfolder);
  const image = { groupIndex, indexInGroup };
  return inst.buildRelativePath(image, inst.buildFilename(image, 'jpg'));
};
check('按组子目录 第1组', relPath(0, 0, 3, true), '1/1（001）.jpg');
check('按组子目录 第1组第3张', relPath(0, 2, 3, true), '1/1（003）.jpg');
check('按组子目录 第3组', relPath(2, 1, 3, true), '3/3（002）.jpg');
check('关闭子目录则平铺', relPath(2, 1, 3, false), '3（002）.jpg');
check('组大小 12 子目录补零', relPath(0, 11, 12, true), '1/1（012）.jpg');

// 命名模板
const named = (pattern, groupIndex, indexInGroup, seq, fileName) => {
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3, true);
  if (pattern !== undefined) inst.settings.filenameTemplate = pattern;
  return inst.buildFilename(
    { groupIndex, indexInGroup, sequenceNumber: seq, name: fileName || '原图.jpg' },
    'jpg'
  );
};
check('模板：默认（空模板走默认）', named('', 0, 0, 1), '1（001）.jpg');
check('模板：中文变量', named('{原名}_{序号}', 0, 0, 1, '照片.png'), '照片_001.jpg');
check('模板：英文变量', named('IMG_{n}', 0, 4, 5), 'IMG_005.jpg');
check('模板：组号+全局序号', named('{组号}-{全局序号}', 2, 1, 8), '3-008.jpg');
check('模板：同时用多种变量', named('{name}_{g}_{i}', 1, 2, 6, 'a.b.png'), 'a.b_2_003.jpg');
check('模板：路径分隔符被清理', named('子目录/{i}', 0, 0, 1), '子目录_001.jpg');
check('模板：非法字符被清理', named('a:b*c?d"e<f>g|h', 0, 0, 1), 'a_b_c_d_e_f_g_h.jpg');
check('模板：未知变量原样保留', named('{xx}_{i}', 0, 0, 1), '{xx}_001.jpg');
check('模板：全非法字符回落默认', named('///', 0, 0, 1), '1（001）.jpg');
check('模板：首尾点被去掉', named(' .x. ', 0, 0, 1), 'x.jpg');

// 画布上限前置校验
const huge = { naturalWidth: 10, naturalHeight: 10 };
let overLimit = false;
try {
  makeInst({ width: 20000, height: 20000 }, 'stretch', 'resize', 3).planDraw(huge, 'resize');
} catch { overLimit = true; }
check('超出画布上限提前报错（而不是 toBlob 拿到 null）', overLimit, true);

let atLimit = true;
try {
  makeInst({ width: 16384, height: 16384 }, 'stretch', 'resize', 3).planDraw(huge, 'resize');
} catch { atLimit = false; }
check('恰好等于上限时放行', atLimit, true);

let overByContain = false;
try {
  // contain：长边贴合，10x10 放大到 20000x20000
  makeInst({ width: 20000, height: 20000 }, 'contain', 'resize', 3).planDraw(huge, 'resize');
} catch { overByContain = true; }
check('contain 放大后超限也要拦', overByContain, true);

// 工具函数
check('escapeHtml 转义', ctx.escapeHtml('<img src="x" onerror=\'1\'>'), '&lt;img src=&quot;x&quot; onerror=&#39;1&#39;&gt;');
check('formatBytes 0', ctx.formatBytes(0), '0 B');
check('formatBytes 1536', ctx.formatBytes(1536), '1.5 KB');

// isImageFile
const ii = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3);
check('isImageFile 靠 MIME', ii.isImageFile({ type: 'image/png', name: 'a.bin' }), true);
check('isImageFile 靠扩展名', ii.isImageFile({ type: '', name: 'a.JPEG' }), true);
check('isImageFile 拒绝非图片', ii.isImageFile({ type: 'text/plain', name: 'a.txt' }), false);
check('isImageFile 拒绝 null', ii.isImageFile(null), false);

// 预设被写坏时要过滤掉，而不是渲染出 NaN
const badPreset = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3);
badPreset.settings.sizePresets = [
  { name: 'ok', width: 800, height: 600 },
  { name: 'no-size' },
  { name: 'text', width: 'abc', height: 10 },
  { name: '负数', width: -5, height: 10 },
  { name: '超限', width: 99999, height: 10 },
  { width: 320, height: 240 }
];
check('预设：过滤非法条目', badPreset.getPresets().map((p) => p.name), ['ok', '320×240']);
check('预设：非数组也不炸', (() => { const i = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3); i.settings.sizePresets = 'xxx'; return i.getPresets(); })(), []);

// 输出格式：MIME 缺失时按扩展名判断，而不是一律压成 PNG
const fmt2 = (requested, type, name) => {
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3);
  inst.$ = (id) => ({ outputFormat: { value: requested } }[id]);
  return inst.resolveOutputFormat({ type, name });
};
check('空 MIME + .jpg 扩展名 → jpeg', fmt2('original', '', 'a.jpg'), { mime: 'image/jpeg', ext: 'jpg' });
check('空 MIME + .webp 扩展名 → webp', fmt2('original', '', 'a.webp'), { mime: 'image/webp', ext: 'webp' });
check('空 MIME + 无扩展名 → png', fmt2('original', '', 'noext'), { mime: 'image/png', ext: 'png' });
check('仅转格式不需要目标尺寸', (() => {
  const inst = makeInst(null, 'contain', 'format_only', 3);
  return inst.planDraw({ naturalWidth: 40, naturalHeight: 20 }, 'format_only').canvasW;
})(), 40);
check('缩尺寸模式缺目标尺寸会报错', (() => {
  const inst = makeInst(null, 'contain', 'resize', 3);
  try { inst.planDraw({ naturalWidth: 40, naturalHeight: 20 }, 'resize'); return false; } catch { return true; }
})(), true);

// 异常输入
let threw = false;
try {
  makeInst({ width: 800, height: 600 }, 'contain', 'resize', 3).planDraw({ naturalWidth: 0, naturalHeight: 0 }, 'resize');
} catch { threw = true; }
check('零尺寸图片抛错而不是算出 NaN', threw, true);

// 内存版 FileSystemDirectoryHandle，用来验证自定义目录的写入行为
function makeFs() {
  const makeDir = (name) => {
    const dir = {
      name,
      files: new Map(),
      dirs: new Map(),
      async getDirectoryHandle(n, opts) {
        if (!dir.dirs.has(n)) {
          if (!opts || !opts.create) throw new Error('NotFound');
          dir.dirs.set(n, makeDir(n));
        }
        return dir.dirs.get(n);
      },
      async getFileHandle(n, opts) {
        const key = n.toLowerCase();
        if (!dir.files.has(key)) {
          if (!opts || !opts.create) {
            const err = new Error('NotFound');
            err.name = 'NotFoundError';
            throw err;
          }
          dir.files.set(key, { name: n, content: null });
        }
        const entry = dir.files.get(key);
        return {
          name: entry.name,
          async createWritable() {
            let buffer = null;
            let open = true;
            return {
              async write(blob) {
                if (!open) throw new Error('已关闭');
                buffer = blob;
              },
              async close() {
                entry.content = buffer;
                open = false;
              },
              async abort() {
                open = false;
              }
            };
          }
        };
      }
    };
    return dir;
  };
  return makeDir('root');
}

(async () => {
  const root = makeFs();
  const inst = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3, true);

  const path1 = await inst.writeToDirectory(root, { groupIndex: 1 }, '2（001）.jpg', 'BLOB-A');
  check('自定义目录：按组写入路径', path1, '2/2（001）.jpg');
  check('自定义目录：确实建了组子目录', [...root.dirs.keys()], ['2']);
  check('自定义目录：内容写入成功', root.dirs.get('2').files.get('2（001）.jpg').content, 'BLOB-A');

  const path2 = await inst.writeToDirectory(root, { groupIndex: 1 }, '2（001）.jpg', 'BLOB-B');
  check('自定义目录：同名自动顺延', path2, '2/2（001）(1).jpg');
  check('自定义目录：原文件未被覆盖', root.dirs.get('2').files.get('2（001）.jpg').content, 'BLOB-A');

  const flat = makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3, false);
  const path3 = await flat.writeToDirectory(root, { groupIndex: 1 }, 'x.png', 'BLOB-C');
  check('自定义目录：关闭子目录则平铺', path3, 'x.png');

  // 组子目录建不出来时给可读的错误（目标位置被同名文件占用会走到这里）
  const fsBroken = makeFs();
  fsBroken.getDirectoryHandle = async () => {
    throw new Error('TypeMismatch');
  };
  let groupErr = '';
  try {
    await makeInst({ width: 1, height: 1 }, 'contain', 'resize', 3, true)
      .writeToDirectory(fsBroken, { groupIndex: 0 }, '1（001）.jpg', 'BLOB');
  } catch (err) {
    groupErr = err.message;
  }
  check('组子目录创建失败时错误可读', /无法创建组子目录「1」/.test(groupErr), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

