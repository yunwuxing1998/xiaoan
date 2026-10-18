#!/usr/bin/env node
/**
 * sync-notion.mjs — 小安的手术配合知识库：Notion → 站点 data.js 自动同步
 *
 * 运行环境：GitHub Actions（ubuntu-latest + Node 22，零第三方依赖）
 * 认证：环境变量 NOTION_TOKEN（仓库 Secret），直连 api.notion.com
 *
 * 行为：
 *   - 递归遍历 Notion 根页面（ROOT_ID）下的全部页面
 *   - 站点树完全按 Notion 结构重建：网站结构 = Notion 结构（层级/顺序/移动/删除即时反映）
 *   - 无媒体页面（纯文字/链接）→ 整页按最新 Notion 内容重建
 *   - 有媒体页面（含图片/视频）→ 只同步文字，媒体节点原样保留（零重复下载）
 *   - 媒体合并 parseSegs 会把文本段中嵌入的 @@MED/@@COL 占位符拆出成独立媒体段
 *     （2026-10-18 修复：此前第 2 个起的连续媒体 token 被吞进文本段，合并时
 *     要么被新文字整段替换（静默丢媒体）、要么原样保留（@@MED 泄漏到线上）；
 *     另加保险丝：合并结果仍含 token 时该页自动升级完整重建）
 *   - 无媒体页/新页面在 Notion 出现新媒体（图片/视频/文件）→ 自动只升级该页为
 *     full 渲染并下载这些新媒体，无需整站 FULL_SYNC=1；此后该页按媒体页合并保留
 *   - Notion 新增页面 → 自动进树（图标取 Notion 页面 emoji；旧树已有图标按 id 继承）
 *   - removed.txt（脚本同目录，每行一个 Notion 页面 id，`#` 注释）：
 *     列出的页面整棵子树从站点彻底移除（树 + pages 内容），用于网站侧永久删除
 *   - 仅存在于网站的旧页面（Notion 已无）：内容保留在 pages 可直链访问，但不进树；
 *     确认不要时把 id 加进 removed.txt 即可彻底删除
 *   - 完整重建模式 FULL_SYNC=1：重下全部媒体（按文件路径哈希命名，可重复运行）、清理孤儿文件
 *   - 无变化不写文件、不产生提交
 *
 * 环境变量：
 *   NOTION_TOKEN   必填，Notion API 令牌
 *   FULL_SYNC=1    完整重建（含媒体下载与孤儿清理），默认 0
 *   DRY_RUN=1      只演练不写盘，默认 0
 *   REPO_ROOT      站点仓库根目录（含 data.js 与 assets/），默认取脚本所在仓库根
 *   REMOVED_FILE   黑名单文件路径，默认脚本同目录 removed.txt
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, unlinkSync, realpathSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------- 配置 ---------------- */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT
  ? process.env.REPO_ROOT
  : join(__dirname, "..", "..");
const DATA_FILE = join(REPO_ROOT, "data.js");
const ASSETS_DIR = join(REPO_ROOT, "assets");

/** 小安知识库 Notion 根页面 ID */
const ROOT_ID = "28777417-bfd8-810a-9fac-cee132e6dc2a";
/** 站点树里的合成节点「一些资料」（非真实 Notion 页面） */
const MISC_NODE_ID = "misc0000000000000000000000000000";
/** Notion 中「一些资料」容器页标题：其子页面挂到合成节点下 */
const MISC_CONTAINER_TITLE = "一些资料";

const NOTION_VERSION = "2022-06-28";
const UA = "xiaoan-kb-sync/1.0 (+https://github.com/yunwuxing1998/xiaoan)";
const MIN_CALL_INTERVAL = 340; // ms，Notion 限流约 3 req/s

const TOKEN = process.env.NOTION_TOKEN || "";
const FULL = process.env.FULL_SYNC === "1";
const DRY = process.env.DRY_RUN === "1";

/* ---------------- 基础工具 ---------------- */
function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }
function die(msg) { console.error("FATAL: " + msg); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function norm(id) { return String(id).replace(/-/g, ""); }

/**
 * removed.txt — 网站侧永久删除黑名单（与脚本同目录，随仓库版本走）。
 * 每行一个 Notion 页面 id（带横线不带都行），`#` 开头为注释、空行忽略。
 * 列出的页面：整棵子树不进站点树，pages 中的旧内容一并删除。
 */
const REMOVED_FILE = process.env.REMOVED_FILE || join(__dirname, "removed.txt");
const REMOVED = (() => {
  const set = new Set();
  if (!existsSync(REMOVED_FILE)) return set;
  for (const line of readFileSync(REMOVED_FILE, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    set.add(norm(s));
  }
  return set;
})();
if (REMOVED.size) log(`removed.txt 黑名单生效：${REMOVED.size} 个页面子树将从站点移除`);

function nowStr() {
  // 与线上 data.js 历史格式一致：YYYY-MM-DD HH:mm:ss（北京时间）
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const cn = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${cn.getFullYear()}-${p(cn.getMonth() + 1)}-${p(cn.getDate())} ${p(cn.getHours())}:${p(cn.getMinutes())}:${p(cn.getSeconds())}`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
function plain(rt) { return (rt || []).map((t) => t.plain_text ?? "").join(""); }

/** Notion 富文本 → 站点 HTML（颜色标注按线上惯例丢弃） */
function inline(rt) {
  return (rt || []).map((t) => {
    let s = esc(t.plain_text ?? "");
    const a = t.annotations || {};
    if (a.code) s = `<code>${s}</code>`;
    if (a.bold) s = `<strong>${s}</strong>`;
    if (a.italic) s = `<em>${s}</em>`;
    if (a.strikethrough) s = `<s>${s}</s>`;
    if (a.underline) s = `<u>${s}</u>`;
    if (t.href) s = `<a href="${escAttr(t.href)}">${s}</a>`;
    return s;
  }).join("");
}

/* ---------------- Notion API 层（可注入 mock 供单测） ---------------- */
let apiMock = null; // 仅测试用
export function __setApiMock(fn) { apiMock = fn; }

let lastCallAt = 0;

async function notionApi(path, attempt = 1) {
  if (apiMock) return apiMock(path);
  const gap = MIN_CALL_INTERVAL - (Date.now() - lastCallAt);
  if (gap > 0) await sleep(gap);
  lastCallAt = Date.now();
  let res;
  try {
    res = await fetch(`https://api.notion.com/v1/${path}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "User-Agent": UA,
      },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    if (attempt >= 6) throw new Error(`网络错误 ${path}: ${e.message}`);
    await sleep(1500 * attempt);
    return notionApi(path, attempt + 1);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Notion API ${path} -> HTTP ${res.status}，重试 6 次仍失败`);
    const backoff = Math.min(30000, 1500 * 2 ** (attempt - 1));
    warn(`  [限流/故障] HTTP ${res.status}，${backoff}ms 后第 ${attempt} 次重试: ${path}`);
    await sleep(backoff);
    return notionApi(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      die(`Notion API 认证失败（401）。请检查仓库 Secret NOTION_TOKEN 是否正确、以及该集成是否有知识库根页面访问权限。\n  ${body.slice(0, 300)}`);
    }
    throw new Error(`Notion API ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** 分页拉取某块的全部子块 */
async function getBlocks(id) {
  const out = [];
  let cursor = null;
  do {
    let p = `blocks/${id}/children?page_size=100`;
    if (cursor) p += `&start_cursor=${encodeURIComponent(cursor)}`;
    const d = await notionApi(p);
    out.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}

/** 拉页面属性（标题 / 标签），仅新页面用 */
async function getPageMeta(id) {
  const p = await notionApi(`pages/${id}`);
  let title = "";
  const tags = [];
  for (const v of Object.values(p.properties || {})) {
    if (!v || typeof v !== "object") continue;
    if (v.type === "title") title = plain(v.title);
    if (v.type === "multi_select") tags.push(...v.multi_select.map((x) => x.name).filter(Boolean));
    if (v.type === "select" && v.select) tags.push(v.select.name);
  }
  // 页面图标（emoji 型；外部/文件型图标不采集，树上沿用旧图标或默认）
  let icon = "";
  if (p.icon && p.icon.type === "emoji") icon = p.icon.emoji || "";
  return { title, tags, icon };
}

/* ---------------- 媒体（FULL 模式） ---------------- */
const mediaCache = new Map(); // fname -> 已处理
let imgCount = 0;

/**
 * 稳定哈希：Notion 文件链接的签名参数每次拉取都不同，取路径部分做 SHA1 前 10 位，
 * 保证同一文件重复 FULL 同步得到同一文件名（可跳过重复下载）。
 */
function stableHash(url) {
  const pathPart = String(url).split("?")[0];
  return createHash("sha1").update(pathPart).digest("hex").slice(0, 10);
}

function extFrom(url, contentType) {
  const ct = contentType || "";
  if (/jpeg/.test(ct)) return "jpg";
  if (/png/.test(ct)) return "png";
  if (/gif/.test(ct)) return "gif";
  if (/webp/.test(ct)) return "webp";
  if (/svg/.test(ct)) return "svg";
  if (/mp4/.test(ct)) return "mp4";
  if (/pdf/.test(ct)) return "pdf";
  const m = /\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/.exec(String(url).split("?")[0]);
  if (m) {
    const e = m[1].toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "pdf"].includes(e)) return e === "jpeg" ? "jpg" : e;
  }
  return "bin";
}

/** 生成 800px 宽变体（线上 picture/srcset 约定）；无 ImageMagick 时跳过 */
function makeW800(fname) {
  const w800 = fname.replace(/(\.\w+)$/, "-w800$1");
  try {
    execFileSync("convert", [join(ASSETS_DIR, fname), "-resize", "800x800>", "-quality", "82", join(ASSETS_DIR, w800)], {
      timeout: 60000, stdio: "ignore",
    });
    return w800;
  } catch {
    return null;
  }
}

/** 下载 Notion 媒体到 assets/，返回 (文件名 或 null) */
async function downloadMedia(url, kind, nameHint) {
  const hash = stableHash(url);
  const prefix = kind === "image" ? "img" : kind === "video" ? "vid" : "doc";
  const ext = extFrom(url, "");
  const fname = `${prefix}_${hash}.${ext}`;
  if (mediaCache.has(fname)) return mediaCache.get(fname);
  if (existsSync(join(ASSETS_DIR, fname))) {
    mediaCache.set(fname, fname);
    return fname;
  }
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000), redirect: "follow" });
  } catch (e) {
    warn(`  [媒体失败] ${fname}: ${e.message}`);
    mediaCache.set(fname, null);
    return null;
  }
  if (!res.ok) {
    warn(`  [媒体失败] ${fname}: HTTP ${res.status}`);
    mediaCache.set(fname, null);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 95 * 1024 * 1024) {
    warn(`  [媒体跳过] ${fname}: ${(buf.length / 1048576).toFixed(1)}MB 超过 95MB 上限（GitHub 单文件限制风险）`);
    mediaCache.set(fname, null);
    return null;
  }
  if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true }); // 增量模式的新媒体自动升级也可能触发下载
  writeFileSync(join(ASSETS_DIR, fname), buf);
  mediaCache.set(fname, fname);
  if (kind === "image") makeW800(fname);
  imgCount += 1;
  return fname;
}

function figCaption(captionRt) {
  const c = inline(captionRt);
  return c ? `<figcaption>${c}</figcaption>` : "";
}

/* ---------------- 块 → HTML 渲染器 ----------------
 * 输出与线上 data.js 现有方言保持一致：
 *   p / h2(一级标题) / h3(二三级) / ul.bulleted-list / ol.numbered-list /
 *   table.simple-table / blockquote.kb-callout / details[open] /
 *   div.column-list > div.column / p.kb-pagelink / figure.kb-figure / video.kb-video
 * ctx.mode: "text"（丢弃媒体，交给合并逻辑保留旧媒体）| "full"（下载媒体）
 */
export async function renderBlocks(blocks, ctx) {
  const out = [];
  let list = null; // { kind: "ul" | "ol", items: [] }
  const flush = async () => {
    if (list) { out.push(await renderList(list, ctx)); list = null; }
  };
  for (const b of blocks) {
    const t = b.type;
    if (t === "bulleted_list_item" || t === "numbered_list_item" || t === "to_do") {
      const kind = t === "numbered_list_item" ? "ol" : "ul";
      if (!list || list.kind !== kind) { await flush(); list = { kind, items: [] }; }
      list.items.push(b);
      continue;
    }
    await flush();
    const h = await renderBlock(b, ctx);
    if (h) out.push(h);
  }
  await flush();
  return out.join("\n");
}

async function renderList(list, ctx) {
  const cls = list.kind === "ol" ? "numbered-list" : "bulleted-list";
  const lis = [];
  for (const it of list.items) {
    const field = it.type === "to_do" ? "to_do" : it.type;
    const prefix = it.type === "to_do" ? (it.to_do?.checked ? "[x] " : "[ ] ") : "";
    const txt = prefix + inline(it[field]?.rich_text);
    const sub = it.has_children ? "\n" + await renderBlocks(await getBlocks(it.id), ctx) : "";
    lis.push(`<li>${txt}${sub}</li>`);
  }
  return `<${list.kind} class="${cls}">${lis.join("")}</${list.kind}>`;
}

async function renderTable(b, ctx) {
  if (!b.has_children) return "";
  const rows = (await getBlocks(b.id)).filter((r) => r.type === "table_row");
  const rowHtml = (r, tag) =>
    `<tr>${(r.table_row?.cells || []).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("")}</tr>`;
  const head = b.table?.has_column_header && rows.length
    ? `<thead class="simple-table-header">${rowHtml(rows.shift(), "th")}</thead>` : "";
  const body = rows.length ? `<tbody>${rows.map((r) => rowHtml(r, "td")).join("")}</tbody>` : "";
  return `<table class="simple-table" dir="ltr">${head}${body}</table>`;
}

function countMedia(b, ctx, kind) {
  ctx.newMedia.push({ kind, id: norm(b.id), title: "" });
  return "";
}

async function renderBlock(b, ctx) {
  const t = b.type;
  switch (t) {
    case "paragraph": {
      const h = inline(b.paragraph?.rich_text);
      return h ? `<p>${h}</p>` : "";
    }
    case "heading_1": return `<h2>${inline(b.heading_1?.rich_text)}</h2>`;
    case "heading_2":
    case "heading_3": return `<h3>${inline(b[t]?.rich_text)}</h3>`;
    case "quote": return `<blockquote>${inline(b.quote?.rich_text)}</blockquote>`;
    case "callout": {
      const inner = b.has_children ? await renderBlocks(await getBlocks(b.id), ctx) : "";
      return `<blockquote class="kb-callout">${inner}</blockquote>`;
    }
    case "code":
      return `<pre><code>${esc(plain(b.code?.rich_text))}</code></pre>`;
    case "divider":
      return "";
    case "bulleted_list_item":
    case "numbered_list_item":
    case "to_do":
      return await renderList({ kind: t === "numbered_list_item" ? "ol" : "ul", items: [b] }, ctx);
    case "table":
      return await renderTable(b, ctx);
    case "toggle": {
      const summary = inline(b.toggle?.rich_text);
      const inner = b.has_children ? await renderBlocks(await getBlocks(b.id), ctx) : "";
      return `<details open><summary>${summary}</summary>${inner}</details>`;
    }
    case "column_list": {
      const inner = b.has_children ? await renderBlocks(await getBlocks(b.id), ctx) : "";
      return inner ? `<div class="column-list">${inner}</div>` : "";
    }
    case "column": {
      const inner = b.has_children ? await renderBlocks(await getBlocks(b.id), ctx) : "";
      return `<div class="column" style="width:50%">${inner}</div>`;
    }
    case "synced_block": {
      if (!b.has_children) return "";
      return await renderBlocks(await getBlocks(b.id), ctx);
    }
    case "child_page": {
      const title = b.child_page?.title || "未命名";
      return `<p class="kb-pagelink"><a href="#/p/${norm(b.id)}">${esc(title)}</a></p>`;
    }
    case "bookmark":
    case "link_preview":
    case "embed": {
      const url = b[t]?.url || "";
      return url ? `<p><a href="${escAttr(url)}">${esc(url)}</a></p>` : "";
    }
    case "image": {
      if (ctx.mode !== "full") return countMedia(b, ctx, "image");
      const im = b.image || {};
      const url = (im.type === "file" ? im.file?.url : im.external?.url) || "";
      if (!url) return countMedia(b, ctx, "image");
      const fname = await downloadMedia(url, "image");
      if (!fname) return "";
      const w800 = existsSync(join(ASSETS_DIR, fname.replace(/(\.\w+)$/, "-w800$1")))
        ? fname.replace(/(\.\w+)$/, "-w800$1") : null;
      const cap = figCaption(im.caption);
      const alt = esc(plain(im.caption) || "image");
      const pic = w800
        ? `<picture><source media="(max-width: 860px)" srcset="assets/${w800}"><img src="assets/${fname}" alt="${alt}" loading="lazy" decoding="async"></picture>`
        : `<img src="assets/${fname}" alt="${alt}" loading="lazy" decoding="async">`;
      return `<figure class="kb-figure">${pic}${cap}</figure>`;
    }
    case "video": {
      if (ctx.mode !== "full") return countMedia(b, ctx, "video");
      const vd = b.video || {};
      const url = (vd.type === "file" ? vd.file?.url : vd.external?.url) || "";
      if (!url) return countMedia(b, ctx, "video");
      const fname = await downloadMedia(url, "video");
      if (!fname) return "";
      const type = fname.endsWith(".webm") ? "video/webm" : "video/mp4";
      return `<figure class="kb-figure"><video controls preload="metadata" class="kb-video" playsinline><source src="assets/${fname}" type="${type}"/>${figCaption(vd.caption)}</video></figure>`;
    }
    case "file":
    case "pdf": {
      if (ctx.mode !== "full") return countMedia(b, ctx, "pdf");
      const fb = b[t] || {};
      const url = (fb.type === "file" ? fb.file?.url : fb.external?.url) || "";
      if (!url) return countMedia(b, ctx, "pdf");
      const fname = await downloadMedia(url, "file");
      if (!fname) return "";
      const name = fb.name || fb.file?.name || plain(fb.caption) || basename(String(url).split("?")[0]);
      return `<p class="kb-file"><a href="assets/${fname}" target="_blank" rel="noopener">\u{1F4CE} ${esc(name)}</a></p>`;
    }
    case "table_row":
      return ""; // 由 table 统一处理
    case "child_database":
    case "link_to_page":
    case "template":
    case "breadcrumb":
    case "table_of_contents":
    case "unsupported":
      ctx.skipped.push(t);
      return "";
    default: {
      const body = b[t] || {};
      if (Array.isArray(body.rich_text)) return `<p>${inline(body.rich_text)}</p>`;
      ctx.skipped.push(t);
      return "";
    }
  }
}

/* ---------------- 媒体保留合并（移植自线上 sync_notion.py，已对拍验证） ---------------- */
const CONTAINER_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "details",
  "blockquote", "aside", "figure", "div", "picture", "section", "span",
]);

function findClose(html, start, tag) {
  const pat = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, "gs");
  pat.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = pat.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else if (m[1] === "/") {
      if (depth === 0) return m.index + m[0].length;
    } else {
      depth += 1;
    }
  }
  return html.length;
}

function tokenizeMedia(html) {
  const media = [];
  let h = html.replace(/<figure[^>]*>.*?<\/figure>/gs, (m0) => { media.push(m0); return `@@MED${media.length}@@`; });
  h = h.replace(/<video[^>]*>.*?<\/video>/gs, (m0) => { media.push(m0); return `@@MED${media.length}@@`; });
  h = h.replace(/<img[^>]+src="assets\/[^>]*>/g, (m0) => { media.push(m0); return `@@MED${media.length}@@`; });
  const cols = [];
  const colOpen = /<div\b[^>]*class="column-list"[^>]*>/g;
  let pos = 0;
  for (;;) {
    colOpen.lastIndex = pos;
    const m = colOpen.exec(h);
    if (!m) break;
    const end = findClose(h, m.index, "div");
    if (end <= m.index) break;
    cols.push(h.slice(m.index, end));
    h = h.slice(0, m.index) + `@@COL${cols.length}@@` + h.slice(end);
    pos = m.index + 8;
  }
  const openPat = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const skipTags = new Set(["br", "hr", "img", "source", "input", "video", "figure", "picture"]);
  let guard = 0;
  while (guard < 300) {
    guard += 1;
    let absorbed = false;
    openPat.lastIndex = 0;
    let m;
    while ((m = openPat.exec(h)) !== null) {
      const tag = m[1].toLowerCase();
      if (m[2] === "/" || skipTags.has(tag)) continue;
      const end = findClose(h, m.index, tag);
      const blk = h.slice(m.index, end);
      if (blk.includes("@@MED") || blk.includes("@@COL")) {
        media.push(blk);
        h = h.slice(0, m.index) + `@@MED${media.length}@@` + h.slice(end);
        absorbed = true;
        break;
      }
    }
    if (!absorbed) break;
  }
  return [h, media, cols];
}

function parseSegs(html) {
  const segs = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)(\/?)>/;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const mm = /^@@(MED|COL)(\d+)@@/.exec(html.slice(i));
    if (mm) {
      segs.push([mm[1] === "MED" ? "media" : "col", Number(mm[2])]);
      i += mm[0].length;
      continue;
    }
    if (html[i] !== "<") {
      let nxt = html.indexOf("<", i);
      if (nxt < 0) nxt = n;
      const chunk = html.slice(i, nxt);
      // 文本段里可能嵌有连续的 @@MED/@@COL 占位符（顶层媒体块之间只隔空白时，
      // 第 2 个起的 token 会被吞进同一个文本段）。必须先拆出来：
      //  - 不拆 → 合并时整段被新文字替换 = 静默丢失媒体（页面"只剩一页内容"）；
      //  - 不拆 → 新文字不够时整段原样保留 = 占位符泄漏到线上（@@MED2@@…）。
      const tokRe = /@@(MED|COL)(\d+)@@/g;
      let last = 0;
      let tm2;
      while ((tm2 = tokRe.exec(chunk)) !== null) {
        const pre = chunk.slice(last, tm2.index);
        if (pre.trim()) segs.push(["text", pre]);
        segs.push([tm2[1] === "MED" ? "media" : "col", Number(tm2[2])]);
        last = tm2.index + tm2[0].length;
      }
      const tail = chunk.slice(last);
      if (tail.trim()) segs.push(["text", tail]);
      i = nxt;
      continue;
    }
    const tm = tagRe.exec(html.slice(i));
    if (!tm) { segs.push(["text", html[i]]); i += 1; continue; }
    const tag = tm[1].toLowerCase();
    if (tm[3] === "/" || !CONTAINER_TAGS.has(tag)) {
      segs.push(["text", tm[0]]);
      i += tm[0].length;
      continue;
    }
    const end = findClose(html, i, tag);
    segs.push(["text", html.slice(i, end)]);
    i = end;
  }
  return segs;
}

function substTokens(s, media, cols) {
  for (let k = 0; k < 6; k++) {
    if (!s.includes("@@MED") && !s.includes("@@COL")) break;
    s = s.replace(/@@COL(\d+)@@/g, (_m, d) => {
      const c = cols[Number(d) - 1];
      return c === undefined ? "" : substTokens(c, media, cols); // 越界 token（旧数据已损坏）→ 丢弃，不崩
    });
    s = s.replace(/@@MED(\d+)@@/g, (_m, d) => {
      const m = media[Number(d) - 1];
      return m === undefined ? "" : substTokens(m, media, cols); // 同上
    });
  }
  return s;
}

/** 把新文字合并进旧 HTML：旧媒体节点原位保留，文字块按序替换 */
export function mergeHtml(oldHtml, newHtml) {
  const [tok, media, cols] = tokenizeMedia(oldHtml);
  const oldSegs = parseSegs(tok);
  const newSegs = parseSegs(newHtml);
  const newText = newSegs.filter((s) => s[0] === "text").map((s) => s[1]);
  let ni = 0;
  const res = [];
  for (const [t, v] of oldSegs) {
    if (t === "media") {
      const m = media[v - 1];
      res.push(m === undefined ? "" : substTokens(m, media, cols));
    } else if (t === "col") {
      const c = cols[v - 1];
      res.push(c === undefined ? "" : substTokens(c, media, cols));
    } else {
      if (ni < newText.length) { res.push(newText[ni]); ni += 1; }
      else res.push(v); // 新文字不够 → 保留旧文字，不丢内容
    }
  }
  if (ni < newText.length) res.push(...newText.slice(ni)); // 多余新文字补到末尾
  return res.join("");
}

/* ---------------- 纯文本提取（page.text 用） ---------------- */
const ENTITY_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};
function unescapeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[e] !== undefined ? ENTITY_MAP[e] : m;
  });
}

export function textOf(html) {
  let t = String(html || "").replace(/<(script|style)[^>]*>.*?<\/\1>/gs, "");
  t = t.replace(/<[^>]+>/g, " ");
  t = unescapeEntities(t);
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  return t.trim();
}

/* ---------------- data.js 读写 ---------------- */
function loadData() {
  const raw = readFileSync(DATA_FILE, "utf8");
  const eq = raw.indexOf("=");
  if (eq < 0 || !raw.startsWith("window.KB_DATA")) die(`data.js 格式异常: ${DATA_FILE}`);
  let json = raw.slice(eq + 1).trim();
  if (json.endsWith(";")) json = json.slice(0, -1);
  const data = JSON.parse(json);
  const prefix = raw.slice(0, eq + 1); // "window.KB_DATA ="
  const suffix = raw.endsWith("\n") ? "\n" : "";
  return { data, prefix, suffix, raw };
}

/* ---------------- Notion 遍历 ---------------- */
/** 递归拉取页面结构（含每页顶层 blocks，一次拉取两用） */
async function fetchNode(id) {
  const blocks = await getBlocks(id);
  const node = { id, blocks, children: [] };
  for (const b of blocks) {
    if (b.type === "child_page") {
      node.children.push(await fetchNode(b.id));
    }
  }
  return node;
}

/** 递归收集子树下所有页面 normId（removed.txt 删除 pages 旧内容用） */
function collectSubtreeIds(node, acc) {
  for (const cp of node.children) {
    acc.add(norm(cp.id));
    collectSubtreeIds(cp, acc);
  }
}

/** misc 节点的子页面全被 removed.txt 清掉时，把空 misc 节点从树里摘除 */
export function dropEmptyMisc(tree, miscNode) {
  if (!miscNode || miscNode.children.length) return;
  const i = tree.indexOf(miscNode);
  if (i >= 0) tree.splice(i, 1);
}

/**
 * 单次遍历 Notion 结构，同时产出两样东西（网站结构 = Notion 结构）：
 *   1) ctx.out: normId -> { id, title, parent, blocks } —— 待同步页面（removed.txt 子树除外）
 *   2) outChildren 数组 —— 按 Notion 层级与顺序重建的站点树
 * 规则：
 *   - 「一些资料」容器页（标题命中、旧树中不是真实节点、自身无 pages 条目）不建页面条目，
 *     其子页面挂到合成 misc 节点下（懒创建，位置跟随容器所在层级）
 *   - removed.txt 中的 id：整棵子树跳过（不进树、不进 out；调用方负责删 pages 旧内容）
 *   - 旧树 icon 按 id 继承（ctx.oldIcons）；新页面 icon 由同步循环经 getPageMeta 回填
 */
export function walkNotion(node, parentNorm, outChildren, ctx) {
  for (const cp of node.children) {
    const nid = norm(cp.id);
    const title = cpTitle(cp);
    if (ctx.removed.has(nid)) {
      ctx.removedIds.add(nid);
      collectSubtreeIds(cp, ctx.removedIds);
      ctx.removedTitles.push(`${title} [${nid}]`);
      continue; // 整棵子树移除
    }
    const isContainer = title === MISC_CONTAINER_TITLE
      && !ctx.oldNodeIds.has(nid) && !ctx.pages[nid];
    if (isContainer) {
      if (!cp.children.length) continue; // 空容器不占位
      if (!ctx.misc) {
        const m = { id: MISC_NODE_ID, title: MISC_CONTAINER_TITLE };
        const miscIcon = ctx.oldIcons.get(MISC_NODE_ID);
        if (miscIcon) m.icon = miscIcon;
        m.children = [];
        ctx.misc = m;
        outChildren.push(m);
      }
      walkNotion(cp, MISC_NODE_ID, ctx.misc.children, ctx);
      continue;
    }
    ctx.out.set(nid, { id: cp.id, title, parent: parentNorm, blocks: cp.blocks });
    const child = { id: nid, title };
    const icon = ctx.oldIcons.get(nid);
    if (icon) child.icon = icon;
    ctx.newNodeById.set(nid, child);
    outChildren.push(child);
    if (cp.children.length) {
      child.children = [];
      walkNotion(cp, nid, child.children, ctx);
    }
  }
}

function cpTitle(cp) {
  // child_page 块本身不带标题；标题存在父级 blocks 的 child_page.title 中不可靠，
  // 统一由调用方在展开时用块内 title（Notion child_page 块带 title 字段）。
  return cp.blockTitle || "未命名";
}

/* ---------------- 主流程 ---------------- */
export async function main() {
  if (!TOKEN) {
    die("缺少环境变量 NOTION_TOKEN。\n" +
      "本地仓库 Settings → Secrets and variables → Actions → New repository secret，name 填 NOTION_TOKEN。");
  }
  if (!existsSync(DATA_FILE)) die(`找不到 data.js: ${DATA_FILE}`);
  if (FULL && !existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

  log(`模式: ${FULL ? "完整重建（含媒体下载）" : "增量同步（保留媒体）"}${DRY ? " + DRY_RUN（不写盘）" : ""}`);
  log(`读取 ${DATA_FILE}`);
  const { data, prefix, suffix, raw } = loadData();
  const pages = data.pages;
  const before = JSON.stringify({ pages, tree: data.tree });

  log(`遍历 Notion 根页面 ${ROOT_ID} ...`);
  const rootNode = await fetchNode(ROOT_ID);

  // child_page 块带 title，回填到 node 上
  (function fill(node) {
    for (const b of node.blocks) {
      if (b.type !== "child_page") continue;
      const kid = node.children.find((c) => c.id === b.id);
      if (kid) kid.blockTitle = b.child_page?.title || "未命名";
    }
    node.children.forEach(fill);
  })(rootNode);

  // 旧树索引：icon 按 id 继承（防整站图标丢失）；oldNodeIds 用于容器判定
  const oldIcons = new Map();
  const oldNodeIds = new Set();
  (function indexOld(nodes) {
    for (const n of nodes) {
      if (n.id) {
        const nid = norm(n.id);
        oldNodeIds.add(nid);
        if (n.icon) oldIcons.set(nid, n.icon);
      }
      if (n.children) indexOld(n.children);
    }
  })(data.tree);

  // 单次遍历 Notion：重建站点树 + 收集待同步页面
  const walkCtx = {
    out: new Map(),           // normId -> { id, title, parent, blocks }
    pages,                    // 容器判定：有页面条目的「一些资料」视为真实页面
    removed: REMOVED,
    removedIds: new Set(),    // removed.txt 命中的全部子树 id（删 pages 旧内容用）
    removedTitles: [],        // 日志用：标题 [id]
    oldIcons,
    oldNodeIds,
    newNodeById: new Map(),   // 新树 normId -> node（新页面 icon/标题回写用）
    misc: null,               // 合成 misc 节点（懒创建）
  };
  const newTree = [];
  walkNotion(rootNode, norm(ROOT_ID), newTree, walkCtx);
  // 容器子页面全被 removed.txt 清掉时，不留下空 misc 节点
  dropEmptyMisc(newTree, walkCtx.misc);
  // 黑名单里但 Notion 已没有的 id（先在 Notion 删了、后又想起删网站内容的）：
  // 遍历不到，但 pages 旧内容同样要删；标题从旧 pages 取，保证日志可读
  for (const nid of REMOVED) {
    walkCtx.removedIds.add(nid);
    if (pages[nid] && !walkCtx.removedTitles.some((t) => t.endsWith(`[${nid}]`))) {
      walkCtx.removedTitles.push(`${pages[nid].title || nid} [${nid}]`);
    }
  }
  const notionPages = walkCtx.out;
  log(`Notion 共 ${notionPages.size} 个页面，站点树按 Notion 结构重建（顶层 ${newTree.length} 个节点）`);
  if (!notionPages.size) {
    die("Notion 遍历结果为空：根页面无权访问或结构异常，已中止（保留原 data.js，不清空树）。");
  }

  const stats = {
    rebuilt: [], merged: [], added: [], unchanged: [],
    removed: walkCtx.removedTitles, // removed.txt 黑名单移除（整棵子树）
    failed: [], newMediaWarn: [], legacy: [], skippedTypes: {},
  };

  // 逐页同步
  for (const [nid, np] of notionPages) {
    const ctx = { mode: FULL ? "full" : "text", newMedia: [], skipped: [] };
    let html;
    try {
      html = await renderBlocks(np.blocks, ctx);
    } catch (e) {
      warn(`[渲染失败] ${np.title} (${nid}): ${e.message} — 保留旧内容`);
      stats.failed.push(np.title);
      continue;
    }
    for (const s of ctx.skipped) stats.skippedTypes[s] = (stats.skippedTypes[s] || 0) + 1;

    const existing = pages[nid];
    const hasMedia = existing
      ? /<figure[\s>]|<video[\s>]|<img[^>]+src="assets\//i.test(existing.html || "")
      : false;

    // 鸡生蛋修复：无媒体页（含从未同步过的新页面）在 Notion 里出现新媒体时，
    // 增量模式下只把这一页升级为 full 渲染——下载的仅是这一页的新媒体
    // （已存在文件由 downloadMedia 的 existsSync 短路，不重复下载）。
    // 渲染后该页带上媒体节点，此后同步即按媒体页走合并保留，不再依赖整站 FULL_SYNC=1。
    // 下载失败时该块渲染为空、本页维持文字版，下次同步自动重试（自愈）。
    if (!FULL && !hasMedia && ctx.newMedia.length) {
      const kinds = {};
      for (const m of ctx.newMedia) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
      const desc = Object.entries(kinds)
        .map(([k, n]) => `${n} 个${k === "image" ? "图片" : k === "video" ? "视频" : "文件"}`)
        .join("、");
      log(`[新媒体] ${np.title}：Notion 新增 ${desc}，自动下载写入`);
      try {
        html = await renderBlocks(np.blocks, { mode: "full", newMedia: [], skipped: [] });
        ctx.newMedia = []; // 已处理，不再计入 newMediaWarn
      } catch (e) {
        warn(`[新媒体升级失败] ${np.title}: ${e.message} — 本页维持文字版，下次同步重试`);
      }
    }

    if (existing) {
      let newHtml;
      let rebuiltByGuard = false;
      // 旧数据污染（历史 bug 曾把 @@MED token 写进 data.js）：残留 token 的页面
      // 无法靠合并自愈（媒体节点已不在旧 html 里），直接升级完整重建
      const oldCorrupt = /@@(MED|COL)\d+@@/.test(existing.html || "");
      if (!FULL && oldCorrupt) {
        warn(`[旧数据损坏] ${np.title}：旧 html 残留占位符，本页升级为完整重建`);
        try {
          newHtml = await renderBlocks(np.blocks, { mode: "full", newMedia: [], skipped: [] });
          rebuiltByGuard = true;
          ctx.newMedia = []; // 媒体已进 html，不再计入 newMediaWarn
        } catch (e) {
          warn(`[完整重建失败] ${np.title}: ${e.message} — 保留旧内容，下次同步重试`);
          newHtml = existing.html;
        }
      } else if (!hasMedia || FULL) {
        newHtml = html;
      } else {
        newHtml = mergeHtml(existing.html, html); // 媒体页：文字合并、媒体保留
        // 保险丝：合并结果若仍残留占位符（异常嵌套等极端情况），
        // 本页升级为完整重建——保证 @@MED/@@COL token 永远不落进 data.js
        if (/@@(MED|COL)\d+@@/.test(newHtml)) {
          warn(`[合并异常] ${np.title}：合并结果仍含占位符，本页升级为完整重建`);
          try {
            newHtml = await renderBlocks(np.blocks, { mode: "full", newMedia: [], skipped: [] });
            rebuiltByGuard = true;
            ctx.newMedia = [];
          } catch (e) {
            warn(`[完整重建失败] ${np.title}: ${e.message} — 保留旧内容，不下发损坏结果`);
            newHtml = existing.html;
          }
        }
      }
      const newText = textOf(newHtml).slice(0, 6000);
      const titleChanged = np.title && np.title !== existing.title;
      if (existing.html === newHtml && existing.text === newText && !titleChanged) {
        stats.unchanged.push(np.title);
        if (ctx.newMedia.length && !FULL) {
          stats.newMediaWarn.push(`  ${np.title}: Notion 新增 ${ctx.newMedia.length} 个媒体（需 FULL 重建后显示）`);
        }
        continue;
      }
      existing.html = newHtml;
      existing.text = newText;
      if (np.title) existing.title = np.title;
      (hasMedia && !FULL && !rebuiltByGuard ? stats.merged : stats.rebuilt).push(np.title);
      if (ctx.newMedia.length && !FULL) {
        stats.newMediaWarn.push(`  ${np.title}: Notion 新增 ${ctx.newMedia.length} 个媒体（需 FULL 重建后显示）`);
      }
    } else {
      // 新页面
      let tags = [];
      try { // 新页面取属性（增量/完整两种模式都取，保持一致）
        const meta = await getPageMeta(np.id);
        if (meta.title) np.title = meta.title;
        tags = meta.tags;
        const tn = walkCtx.newNodeById.get(nid);
        if (tn) {
          if (np.title) tn.title = np.title; // 树上标题以页面属性为准
          if (meta.icon && !tn.icon) tn.icon = meta.icon;
        }
      } catch (e) {
        warn(`[新页面属性失败] ${np.title}: ${e.message}`);
      }
      pages[nid] = { title: np.title || "未命名", html, tags, text: textOf(html).slice(0, 6000) };
      stats.added.push(np.title || nid);
    }
  }

  // 站点树整体重建：网站结构 = Notion 结构
  data.tree = newTree;

  // removed.txt 黑名单：删掉这些页面在 pages 里的旧内容（新树已不含）
  for (const nid of walkCtx.removedIds) {
    if (pages[nid]) delete pages[nid];
  }

  // 仅存在于网站的旧页面（Notion 已无）：内容保留在 pages 可直链访问，但不进树；
  // 确认不要时把 id 加进 removed.txt，下次同步彻底删除
  const miscNorm = norm(MISC_NODE_ID);
  for (const pid of Object.keys(pages)) {
    if (pid === miscNorm) continue;            // 合成节点「一些资料」着陆页
    if (walkCtx.removedIds.has(pid)) continue; // 黑名单已删
    if (!notionPages.has(pid)) stats.legacy.push(`${pages[pid].title || pid} [${pid}]`);
  }

  // 汇总 meta
  const after = JSON.stringify({ pages, tree: data.tree });
  const contentChanged = before !== after;
  let pruned = 0;
  if (FULL) {
    const referenced = new Set();
    for (const p of Object.values(pages)) {
      for (const m of String(p.html || "").matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) referenced.add(m[1]);
    }
    for (const f of readdirSync(ASSETS_DIR)) {
      if (!referenced.has(`assets/${f}`)) {
        try { unlinkSync(join(ASSETS_DIR, f)); pruned += 1; } catch { /* 忽略 */ }
      }
    }
  }

  if (contentChanged || pruned > 0) {
    const allHtml = Object.values(pages).map((p) => p.html || "").join("");
    data.meta.count = Object.keys(pages).length;
    data.meta.media = (allHtml.match(/<img\b/gi) || []).length + (allHtml.match(/<video\b/gi) || []).length;
    data.meta.source = "Notion 知识库";
    data.meta.generatedAt = nowStr();
  }

  // 汇总日志
  log("\n========== 同步结果 ==========");
  log(`整页重建 ${stats.rebuilt.length} | 文字合并 ${stats.merged.length} | 新增 ${stats.added.length} | 移除 ${stats.removed.length} | 未变化 ${stats.unchanged.length} | 失败 ${stats.failed.length}`);
  if (stats.rebuilt.length) log("重建: " + stats.rebuilt.join("、"));
  if (stats.merged.length) log("合并: " + stats.merged.join("、"));
  if (stats.added.length) log("新增: " + stats.added.join("、"));
  if (stats.removed.length) log("移除（removed.txt 黑名单，整棵子树）: " + stats.removed.join("、"));
  if (stats.failed.length) log("失败: " + stats.failed.join("、"));
  if (stats.newMediaWarn.length) {
    log("新媒体提醒（有媒体页新增的媒体，增量不下载，FULL 重建后显示；无媒体页/新页面已自动下载）:");
    stats.newMediaWarn.forEach((l) => log(l));
  }
  if (stats.legacy.length) {
    log(`仅存在于网站的旧页面（Notion 已无；内容保留、可直链访问，未进树）: ${stats.legacy.length} 个`);
    for (const l of stats.legacy) log("  - " + l);
    log("  确认不要时：把对应 id 加进 .github/workflows/removed.txt，下次同步彻底删除");
  }
  if (Object.keys(stats.skippedTypes).length) {
    log("跳过的块类型: " + Object.entries(stats.skippedTypes).map(([k, v]) => `${k}×${v}`).join(", "));
  }
  if (FULL) log(`FULL: 下载媒体 ${imgCount} 个，清理孤儿文件 ${pruned} 个`);
  log(`meta: count=${data.meta.count} media=${data.meta.media} generatedAt=${data.meta.generatedAt}`);

  if (!contentChanged && pruned === 0) {
    log("\n内容无变化，不写文件、不产生提交。");
    return;
  }
  if (DRY) {
    log("\nDRY_RUN=1：内容有变化，但按设置不写盘。");
    return;
  }
  const out = prefix + JSON.stringify(data) + ";" + suffix;
  writeFileSync(DATA_FILE, out, "utf8");
  log(`\n已写入 ${DATA_FILE}（${(out.length / 1024).toFixed(0)} KB）`);
}

/* ---------------- 入口 ---------------- */
const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (isMain) {
  main().catch((e) => {
    console.error("FATAL: " + (e?.stack || e?.message || e));
    process.exit(1);
  });
}
