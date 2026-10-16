// 创建 / 更新两个版本的 GitHub Release（v2.1 主发布、v2.0 归档），并设置仓库简介与 Topics。
//
// 用法（在项目根目录，需先确保标签已推送到远端）：
//   export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
//   node dev-tests/publish.js
//
// 脚本幂等：Release 已存在则更新，不存在则创建。发版前记得先改
// imagetool2.1/manifest.json 的 version、更新 CHANGELOG.md、打标签并推送。
// 通过 GitHub API 完成（不需要 gh CLI），token 从环境变量读取，不落盘。
const TOKEN = process.env.GH_TOKEN;
const REPO = 'worldconfig/imagetool';
const API = 'https://api.github.com';

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wb-imagetool-release',
  'Content-Type': 'application/json'
};

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

1. 下载本页的 Source code (zip) 并解压，或 \`git clone\` 仓库
2. 打开 \`chrome://extensions\`，开启**开发者模式**
3. 点**加载已解压的扩展程序**，选择 **\`imagetool2.1\`** 文件夹
4. 需要 Chrome / Edge 116 以上

完整说明见 [README](https://github.com/${REPO}#readme)。`;

const BODY_20 = `初始版本，代码保留在 \`imagetool2.0/\` 仅作归档，**不再更新**。

> 建议直接使用 [v2.1](https://github.com/${REPO}/releases/tag/v2.1)：
> 功能更完整，且修复了若干会导致产物损坏（扩展名与实际内容不符）、
> 批量处理卡死、内存泄漏等问题。`;

async function api(path, method, body) {
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

(async () => {
  // 已有的 release 先查出来，保证可重复执行
  const existing = await api(`/repos/${REPO}/releases`, 'GET');
  const byTag = new Map((existing.json || []).map((r) => [r.tag_name, r]));

  // 1) v2.1（最新版本）
  const r21Payload = {
    tag_name: 'v2.1',
    name: 'v2.1 — 批量处理、命名模板与自定义输出目录',
    body: BODY_21,
    draft: false,
    prerelease: false,
    make_latest: 'true'
  };
  if (byTag.has('v2.1')) {
    const r = await api(`/repos/${REPO}/releases/${byTag.get('v2.1').id}`, 'PATCH', r21Payload);
    console.log(`v2.1 Release：已存在，更新完成（HTTP ${r.status}）`);
  } else {
    const r = await api(`/repos/${REPO}/releases`, 'POST', r21Payload);
    console.log(`v2.1 Release：创建${r.ok ? '成功' : '失败'}（HTTP ${r.status}）${r.ok ? '' : ' ' + r.text.slice(0, 300)}`);
  }

  // 2) v2.0（归档，不设为 latest）
  const r20Payload = {
    tag_name: 'v2.0',
    name: 'v2.0 — 初始版本（归档）',
    body: BODY_20,
    draft: false,
    prerelease: false,
    make_latest: 'false'
  };
  const r20 = await api(`/repos/${REPO}/releases`, 'POST', r20Payload);
  if (r20.status === 422) {
    console.log('v2.0 Release：已存在，跳过');
  } else {
    console.log(`v2.0 Release：创建${r20.ok ? '成功' : '失败'}（HTTP ${r20.status}）${r20.ok ? '' : ' ' + r20.text.slice(0, 300)}`);
  }

  // 3) 仓库简介
  const repo = await api(`/repos/${REPO}`, 'PATCH', {
    description: '浏览器图片批量尺寸调整 / 格式转换插件（Chrome·MV3）。拖进侧边栏即用，支持命名模板、按组归档、输出到指定文件夹。'
  });
  console.log(`仓库简介：${repo.ok ? '已更新' : '更新失败'}（HTTP ${repo.status}）`);

  // 4) Topics
  const topics = await api(`/repos/${REPO}/topics`, 'PUT', {
    names: ['chrome-extension', 'manifest-v3', 'image-resizer', 'image-processing', 'side-panel', 'javascript']
  });
  console.log(`Topics：${topics.ok ? '已设置 ' + (topics.json?.names || []).join(', ') : '设置失败（HTTP ' + topics.status + '）'}`);

  // 5) 复核
  const final = await api(`/repos/${REPO}/releases`, 'GET');
  console.log('\n当前 Releases：');
  for (const r of final.json || []) {
    console.log(`  ${r.tag_name}  ${r.name}  (latest=${r.tag_name === (await api(`/repos/${REPO}/releases/latest`, 'GET')).json?.tag_name})`);
  }
})();
