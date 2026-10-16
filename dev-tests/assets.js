// 给每个 Release 挂一个「解压即用」的 zip 资产，并把下载说明写进 Release 正文。
//
// 用法（在项目根目录）：
//   export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
//   node dev-tests/assets.js
//
// zip 用 git archive 从仓库内容现打（不依赖工作区），产物落在 dev-tests/.dist/（已 gitignore）。
// 脚本幂等：同名资产会先删再传，Release 正文可反复覆盖。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
const REPO = 'worldconfig/imagetool';
const API = `https://api.github.com/repos/${REPO}`;
const REPO_ROOT = path.join(__dirname, '..');
const DIST = process.env.DIST_DIR || path.join(__dirname, '.dist');

// 从仓库内容打 zip，扩展文件位于压缩包根目录 → 解压后可直接「加载已解压的扩展程序」
function buildZip(versionDir) {
  fs.mkdirSync(DIST, { recursive: true });
  const target = path.join(DIST, `${versionDir}.zip`);
  execSync(`git archive --format=zip -o "${target}" HEAD:${versionDir}`, { cwd: REPO_ROOT });
  return target;
}

const jsonHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wb-imagetool-release',
  'Content-Type': 'application/json'
};

const DOWNLOAD_21 = `### 下载

- **\`imagetool2.1.zip\`**（推荐）— 解压即用，加载扩展时直接选择解压出来的文件夹
- 或页面底部的 Source code (zip)：解压后需要再进入内层的 \`imagetool2.1/\` 目录

`;

const DOWNLOAD_20 = `### 下载

- **\`imagetool2.0.zip\`** — 解压即用，加载扩展时直接选择解压出来的文件夹
- 或页面底部的 Source code (zip)：解压后需要再进入内层的 \`imagetool2.0/\` 目录

`;

const BODY_21 = `从 2.0 起的一次完整重构，代码位于 \`imagetool2.1/\`。

### 新增
- 尺寸预设，一键套用
- 命名模板 \`{组号}\` \`{序号}\` \`{全局序号}\` \`{原名}\`，带实时预览
- 等比裁剪（cover）适配方式；JPEG / WebP 画质可调
- 支持拖入整个文件夹、\`Ctrl + V\` 粘贴图片
- 输出到电脑上任意文件夹（File System Access API）
- 按组建立子文件夹，多组图片不再混在一起
- 批量进度与中途停止、重新处理全部、处理完成系统通知
- 未处理列表持久化，关闭侧边栏后自动恢复

### 修复
- 状态栏自动隐藏后永久不再显示
- 图片解码失败时 Promise 永久挂起，导致批量处理卡死
- 透明 PNG 转 JPEG 出现黑底
- 输出扩展名与实际内容不符（GIF / SVG 产物损坏）
- 下载前转 base64 导致内存翻倍；Object URL 未回收造成内存泄漏
- 右键菜单重复创建报错、右键发图因竞态丢图
- 连点处理会重复处理同一张图、甚至跑出并发批次
- 拖拽网页图片进面板失效
- 内容脚本覆盖站点 \`img.title\`，破坏原网页提示

### 变更
- 点击工具栏图标直接打开侧边栏，不再弹出小窗口
- 处理过程中锁定参数控件，保证整批参数一致
- 尺寸上限校验 16384，超限提前报错
- 错误提示细化到可操作建议（防盗链、HEIC、目录不可写等）
- 兼容不支持侧边栏 API 的 Chromium 浏览器，退化为标签页打开
- 移除 popup，设置入口统一到侧边栏；移除未使用的 scripting / activeTab 权限

### 安装

1. 下载下方的 **\`imagetool2.1.zip\`** 并解压（或下载 Source code 后进入 \`imagetool2.1/\` 目录）
2. 打开 \`chrome://extensions\`，开启**开发者模式**
3. 点**加载已解压的扩展程序**，选择解压出来的文件夹
4. 需要 Chrome / Edge 116 以上

完整说明见 [README](https://github.com/${REPO}#readme)。`;

const BODY_20 = `初始版本，代码保留在 \`imagetool2.0/\` 仅作归档，**不再更新**。

> 建议直接使用 [v2.1](https://github.com/${REPO}/releases/tag/v2.1)：
> 功能更完整，且修复了若干会导致产物损坏（扩展名与实际内容不符）、
> 批量处理卡死、内存泄漏等问题。`;

async function api(url, method, body, headers = jsonHeaders) {
  const res = await fetch(url, {
    method,
    headers,
    body: body && typeof body !== 'string' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json: parsed, text };
}

async function uploadAsset(release, zipName, label, versionDir) {
  // 已存在同名资产就先删掉，保证脚本可重复执行
  const existing = await api(`${API}/releases/${release.id}/assets`, 'GET');
  for (const asset of existing.json || []) {
    if (asset.name === zipName) {
      await api(`${API}/releases/assets/${asset.id}`, 'DELETE');
      console.log(`  ${zipName}：已删除旧资产，重新上传`);
    }
  }

  const zipPath = buildZip(versionDir);
  const buf = fs.readFileSync(zipPath);
  console.log(`  ${zipName}：已用 git archive 重新打包（${(buf.length / 1024).toFixed(0)} KB）`);
  const url = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(zipName)}&label=${encodeURIComponent(label)}`;
  const res = await api(url, 'POST', buf, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wb-imagetool-release',
    'Content-Type': 'application/zip'
  });

  if (res.ok) {
    console.log(`  ${zipName}：上传成功（${(res.json.size / 1024).toFixed(0)} KB，下载数 ${res.json.download_count}）`);
  } else {
    console.log(`  ${zipName}：上传失败 HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
}

(async () => {
  const releases = (await api(`${API}/releases`, 'GET')).json || [];
  const byTag = Object.fromEntries(releases.map((r) => [r.tag_name, r]));

  console.log('上传压缩包：');
  await uploadAsset(byTag['v2.1'], 'imagetool2.1.zip', 'v2.1 扩展包（解压即用）', 'imagetool2.1');
  await uploadAsset(byTag['v2.0'], 'imagetool2.0.zip', 'v2.0 扩展包（归档）', 'imagetool2.0');

  console.log('\n更新 Release 说明：');
  const p1 = await api(`${API}/releases/${byTag['v2.1'].id}`, 'PATCH', {
    body: DOWNLOAD_21 + BODY_21
  });
  console.log(`  v2.1 说明：${p1.ok ? '已更新' : '失败 HTTP ' + p1.status}`);
  const p0 = await api(`${API}/releases/${byTag['v2.0'].id}`, 'PATCH', {
    body: DOWNLOAD_20 + BODY_20
  });
  console.log(`  v2.0 说明：${p0.ok ? '已更新' : '失败 HTTP ' + p0.status}`);

  // 复核
  const final = (await api(`${API}/releases`, 'GET')).json || [];
  console.log('\n最终状态：');
  for (const r of final) {
    console.log(`  ${r.tag_name} — ${r.name}`);
    for (const a of r.assets || []) {
      console.log(`      📦 ${a.name}  ${(a.size / 1024).toFixed(0)} KB  ${a.label || ''}`);
    }
    if (!(r.assets || []).length) console.log('      （无资产）');
  }
})();
