import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { lookup } from "./dict.js";
import { speak, warmVoices } from "./speak.js";
import { translateSentence, getConfig, setConfig, testConfig } from "./translate.js";
// 用具名导入再组装成 wb，单文件版把所有模块拼进同一个作用域时照样能用
import {
  onChange,
  load,
  has,
  all,
  dueList,
  masteredList,
  nextDueLabel,
  add,
  remove,
  clearAll,
  review,
  resetProgress,
  exportBlob,
  exportAnki,
  exportIcs,
  downloadIcs,
  importJson,
} from "./wordbook.js";
import {
  shelfServer,
  shelfUrl,
  shelfList,
  shelfAdd,
  shelfUpdate,
  shelfUpdateNow,
  shelfRemove,
} from "./shelf.js";

const wb = {
  onChange,
  load,
  has,
  all,
  dueList,
  masteredList,
  nextDueLabel,
  add,
  remove,
  clearAll,
  review,
  resetProgress,
  exportBlob,
  exportAnki,
  exportIcs,
  downloadIcs,
  importJson,
};

// 单文件模式下 worker 是一段内嵌代码转出来的 blob 地址，服务器模式用同目录的 worker 文件
pdfjsLib.GlobalWorkerOptions.workerSrc =
  window.__PDFJS_WORKER_SRC__ || "./vendor/pdfjs/pdf.worker.mjs";

const el = (id) => document.getElementById(id);
const viewer = el("viewer");
const pagesBox = el("pages");
const popup = el("popup");
const toastEl = el("toast");
const drawer = el("drawer");
const reviewBox = el("review");

const state = {
  doc: null,
  sizes: [],
  scale: 1,
  fitMode: true,
  pageEls: [],
  io: null,
  current: 1,
  last: null, // 最近一次查词结果，收录时要用
  tab: "all",
  queue: [],
  qi: 0,
  mode: "word", // word 查词 / sentence 翻译
  sentence: "",
  savedWords: new Set(), // 生词本里的词，用来画下划线
  book: null, // 当前这本书在书架里的记录
  saveTimer: null,
};

// 单文件版没有服务端，从书架点书要重新选一次文件，这里暂存等着接
let pendingBook = null;

const settingsBox = el("settings");

/* ------------------------------------------------------------------ *
 * PDF 渲染
 * ------------------------------------------------------------------ */

function clearPages() {
  if (state.io) state.io.disconnect();
  pagesBox.innerHTML = "";
  state.pageEls = [];
  state.sizes = [];
}

function layoutPages() {
  state.pageEls.forEach((pageEl, i) => {
    const size = state.sizes[i];
    pageEl.style.width = Math.floor(size.width * state.scale) + "px";
    pageEl.style.height = Math.floor(size.height * state.scale) + "px";
    pageEl.style.setProperty("--scale-factor", state.scale);
  });
}

async function renderPage(i) {
  const pageEl = state.pageEls[i];
  if (!pageEl || pageEl.dataset.state === "rendered") return;
  pageEl.dataset.state = "rendering";

  const page = await state.doc.getPage(i + 1);
  const viewport = page.getViewport({ scale: state.scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let canvas = pageEl.querySelector("canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    pageEl.appendChild(canvas);
  }
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  try {
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (err) {
    pageEl.dataset.state = "empty";
    return;
  }

  let layer = pageEl.querySelector(".textLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "textLayer";
    pageEl.appendChild(layer);
  } else {
    layer.innerHTML = "";
  }
  try {
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent ? page.streamTextContent() : await page.getTextContent(),
      container: layer,
      viewport,
    });
    await textLayer.render();
  } catch (err) {
    /* 文本层失败不影响阅读 */
  }

  pageEl.dataset.state = "rendered";
  markSavedWords(pageEl);
}

/* ------------------------------------------------------------------ *
 * 生词下划线：把生词本里的词在页面上标出来
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refreshSavedWords() {
  state.savedWords = new Set(wb.all().map((it) => String(it.word || "").toLowerCase()).filter(Boolean));
}

function markSavedWords(pageEl) {
  if (!pageEl) return;
  pageEl.querySelectorAll(".wb-ul").forEach((n) => n.remove());
  if (!state.savedWords.size) return;

  const layer = pageEl.querySelector(".textLayer");
  if (!layer) return;

  const words = [...state.savedWords].sort((a, b) => b.length - a.length);
  const re = new RegExp(
    "(?<![a-zA-Z])(" + words.map(escapeRe).join("|") + ")(?![a-zA-Z])",
    "gi"
  );
  const base = pageEl.getBoundingClientRect();
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return /[a-zA-Z]/.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(value))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        const line = document.createElement("div");
        line.className = "wb-ul";
        line.style.left = r.left - base.left + "px";
        line.style.top = r.bottom - base.top - 2 + "px";
        line.style.width = r.width + "px";
        pageEl.appendChild(line);
      }
      if (m.index + m[0].length >= value.length) break;
    }
  }
}

function markAllPages() {
  state.pageEls.forEach((p) => {
    if (p.dataset.state === "rendered") markSavedWords(p);
  });
}

function unrenderPage(i) {
  const pageEl = state.pageEls[i];
  if (!pageEl || pageEl.dataset.state !== "rendered") return;
  const canvas = pageEl.querySelector("canvas");
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  const layer = pageEl.querySelector(".textLayer");
  if (layer) layer.innerHTML = "";
  pageEl.dataset.state = "empty";
}

function observePages() {
  if (state.io) state.io.disconnect();
  state.io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.index);
        if (e.isIntersecting) renderPage(i);
        else unrenderPage(i);
      }
    },
    { root: viewer, rootMargin: "1400px 0px" }
  );
  state.pageEls.forEach((p) => state.io.observe(p));
}

// 跳到第 n 页，顺便把那一页渲染出来
async function goToPage(n) {
  const idx = Math.max(0, Math.min(state.pageEls.length - 1, n - 1));
  const pageEl = state.pageEls[idx];
  if (!pageEl) return;
  viewer.scrollTop = Math.max(0, pageEl.offsetTop - 8);
  updatePageLabel();
  await renderPage(idx);
  updatePageLabel();
}

// 打开的书自动进书架；架上已经有的直接复用，不重复上传
async function attachBook(file, doc) {
  const list = await shelfList();
  let book = list.find((b) => b.name === file.name && b.size === file.size);
  if (!book) {
    book = await shelfAdd(file, { pageCount: doc.numPages });
  } else if (book.pageCount !== doc.numPages) {
    await shelfUpdate(book.id, { pageCount: doc.numPages });
  }
  state.book = book || null;
  return book;
}

async function openFile(file, preset) {
  if (!file || !/pdf$/i.test(file.name)) {
    toast("请选择 PDF 文件");
    return;
  }
  toast("正在打开 " + file.name);
  const buf = await file.arrayBuffer();
  let doc;
  try {
    const opts = { data: buf };
    // 单文件模式下这两个目录取不到，不强求，拉丁字体的 PDF 不受影响
    if (!window.__DICT_SHARDS__) {
      opts.cMapsUrl = "./vendor/pdfjs/cmaps/";
      opts.standardFontDataUrl = "./vendor/pdfjs/standard_fonts/";
    }
    doc = await pdfjsLib.getDocument(opts).promise;
  } catch (err) {
    toast("这个 PDF 打不开：" + err.message);
    return;
  }

  clearPages();
  state.doc = doc;
  el("fileName").textContent = file.name;
  el("emptyState").hidden = true;

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  fitScale(base.width);

  for (let i = 0; i < doc.numPages; i++) {
    const p = await doc.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    state.sizes.push({ width: vp.width, height: vp.height });

    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.dataset.index = String(i);
    pageEl.style.width = Math.floor(vp.width * state.scale) + "px";
    pageEl.style.height = Math.floor(vp.height * state.scale) + "px";
    pageEl.style.setProperty("--scale-factor", state.scale);
    pagesBox.appendChild(pageEl);
    state.pageEls.push(pageEl);
  }

  el("zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  updatePageLabel();
  observePages();
  toast("");

  // 入架并回到上次那一页
  let book = preset || null;
  if (book) state.book = book;
  else book = await attachBook(file, doc);

  if (book) {
    if (book.pageCount !== doc.numPages) {
      await shelfUpdate(book.id, { pageCount: doc.numPages });
      book.pageCount = doc.numPages;
    }
    if (book.scale > 0.4 && Math.abs(book.scale - state.scale) > 0.01) {
      setScale(book.scale, !!book.fitMode);
    }
    if (book.page > 1) {
      await goToPage(book.page);
      toast("已回到第 " + book.page + " 页");
    }
  }
}

function fitScale(pageWidth) {
  const avail = viewer.clientWidth - 48;
  state.scale = Math.max(0.4, Math.min(2.5, avail / pageWidth));
  state.fitMode = true;
}

// 翻页和缩放都记一下，节流写回书架
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (!state.book) return;
    shelfUpdate(state.book.id, {
      page: state.current,
      scale: state.scale,
      fitMode: state.fitMode,
    });
  }, 700);
}

function setScale(next, keepFit = false) {
  if (!state.doc) return;
  state.scale = Math.max(0.4, Math.min(4, next));
  state.fitMode = keepFit;
  layoutPages();
  state.pageEls.forEach((p) => {
    p.dataset.state = "empty";
    const c = p.querySelector("canvas");
    if (c) {
      c.width = 0;
      c.height = 0;
    }
    const l = p.querySelector(".textLayer");
    if (l) l.innerHTML = "";
  });
  el("zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  observePages();
  scheduleSave();
}

function updatePageLabel() {
  if (!state.doc) {
    el("pageLabel").textContent = "—";
    return;
  }
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let best = 0;
  let bestDist = Infinity;
  state.pageEls.forEach((p, i) => {
    const top = p.offsetTop;
    const bottom = top + p.offsetHeight;
    const c = (top + bottom) / 2;
    const d = Math.abs(c - mid);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  state.current = best + 1;
  el("pageLabel").textContent = state.current + " / " + state.doc.numPages;
}

/* ------------------------------------------------------------------ *
 * 取词
 * ------------------------------------------------------------------ */

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 行尾连字符：把被换行拆开的词拼回去
 * ------------------------------------------------------------------ */

function layerOf(node) {
  const p = node && node.parentElement;
  return p ? p.closest(".textLayer") : null;
}

function textNodesOf(layer) {
  const out = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.trim()) out.push(n);
  }
  return out;
}

function nodeTop(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const box = r.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom };
}

// 下一行开头那段，用来接在连字符后面
function nextLineHead(node) {
  const layer = layerOf(node);
  if (!layer) return null;
  const nodes = textNodesOf(layer);
  const i = nodes.indexOf(node);
  if (i < 0) return null;
  const cur = nodeTop(node).top;
  for (let j = i + 1; j < nodes.length; j++) {
    if (nodeTop(nodes[j]).top - cur <= 2) continue; // 还在同一行
    const t = (nodes[j].nodeValue || "").trim();
    if (t === "-" && j + 1 < nodes.length) {
      const m2 = /^([A-Za-z]+)/.exec((nodes[j + 1].nodeValue || "").trim());
      return m2 ? m2[1] : null;
    }
    const m = /^([A-Za-z]+)/.exec(t);
    return m ? m[1] : null;
  }
  return null;
}

// 上一行结尾那段，用来接在连字符前面
function prevLineTail(node) {
  const layer = layerOf(node);
  if (!layer) return null;
  const nodes = textNodesOf(layer);
  const i = nodes.indexOf(node);
  if (i <= 0) return null;
  const cur = nodeTop(node).top;
  for (let j = i - 1; j >= 0; j--) {
    if (cur - nodeTop(nodes[j]).top <= 2) continue; // 还在同一行
    const t = (nodes[j].nodeValue || "").trim();
    const m = /([A-Za-z]+)\s*-$/.exec(t);
    if (m) return m[1];
    if (t === "-" && j - 1 >= 0) {
      const m2 = /([A-Za-z]+)$/.exec((nodes[j - 1].nodeValue || "").trim());
      return m2 ? m2[1] : null;
    }
    return null;
  }
  return null;
}

// 判断这一点是不是落在文字上。caretPositionFromPoint 在空白区也会返回最近的文本位置，
// 光靠它分不出"点了空白"，得看命中的元素本身是不是文本层的 span。
function isBlankPoint(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !hit.closest) return true;
  if (hit.classList && hit.classList.contains("endOfContent")) return true;
  return !hit.closest(".textLayer span");
}

function wordFromPoint(x, y) {
  if (isBlankPoint(x, y)) return null;
  const caret = caretAt(x, y);
  if (!caret) return null;
  const text = caret.node.nodeValue || "";
  const isLetter = (c) => /[a-zA-ZÀ-ɏ'-]/.test(c);

  let start = caret.offset;
  let end = caret.offset;
  while (start > 0 && isLetter(text[start - 1])) start--;
  while (end < text.length && isLetter(text[end])) end++;
  if (start === end) {
    // 点在了标点或空白处，向两侧各看一个字符
    if (start > 0) start--;
    else if (end < text.length) end++;
  }
  let word = text.slice(start, end).replace(/^[-'.]+|[-'.]+$/g, "");
  if (!word) return null;

  const range = document.createRange();
  range.setStart(caret.node, start);
  range.setEnd(caret.node, end);
  const rect = range.getBoundingClientRect();

  // 行尾连字符把词拆成了两半，点哪一半都拼出整个词
  let joined = false;
  let alt = null;
  const tail = text.slice(end);
  if (/^-/.test(tail) || (end >= text.length && /-$/.test(text))) {
    const head = nextLineHead(caret.node);
    if (head) {
      alt = word + "-" + head;
      word = word + head;
      joined = true;
    }
  }
  if (!joined && start === 0) {
    const tailPart = prevLineTail(caret.node);
    if (tailPart) {
      alt = tailPart + "-" + word;
      word = tailPart + word;
      joined = true;
    }
  }

  return { word, rect, node: caret.node, joined, alt };
}

// 从整页文本里切一段上下文，收进生词本时能看到原句
function contextAround(node, word) {
  const layer = node && node.parentElement && node.parentElement.closest(".textLayer");
  if (!layer) return "";
  const full = (layer.textContent || "").replace(/\s+/g, " ");
  const i = full.toLowerCase().indexOf(String(word).toLowerCase());
  if (i < 0) return full.slice(0, 180);
  return full.slice(Math.max(0, i - 120), i + String(word).length + 120).trim();
}

function pageIndexAt(node) {
  const page = node && node.parentElement && node.parentElement.closest(".page");
  return page ? Number(page.dataset.index) + 1 : 0;
}

/* ------------------------------------------------------------------ *
 * 释义卡片
 * ------------------------------------------------------------------ */

let hitBox = null;

function clearHit() {
  if (hitBox) {
    hitBox.remove();
    hitBox = null;
  }
}

function showHit(rect) {
  clearHit();
  if (!rect || !rect.width) return;
  hitBox = document.createElement("div");
  hitBox.className = "hit-box";
  hitBox.style.left = rect.left + "px";
  hitBox.style.top = rect.top + "px";
  hitBox.style.width = rect.width + "px";
  hitBox.style.height = rect.height + "px";
  document.body.appendChild(hitBox);
}

function closePopup() {
  popup.hidden = true;
  clearHit();
}

function splitLines(s) {
  return String(s || "")
    .split("\\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function renderEntry(res) {
  const { entry, query, via, from } = res;
  el("pwWord").textContent = entry ? entry.word : query;
  el("pwPhonetic").textContent = entry && entry.phonetic ? entry.phonetic : "";

  const body = el("pwBody");
  body.innerHTML = "";

  if (!entry) {
    const miss = document.createElement("div");
    miss.className = "miss";
    miss.innerHTML = `词库里没有 <b></b>`;
    miss.querySelector("b").textContent = query;
    body.appendChild(miss);
    const note = document.createElement("div");
    note.className = "lemma-note";
    note.textContent = via
      ? "已试过原形 " + via + "，同样没有收录"
      : "缩写、专有名词或新造词常会查不到";
    body.appendChild(note);
    return;
  }

  const cn = splitLines(entry.translation);
  const en = splitLines(entry.definition);

  if (cn.length) body.appendChild(section("中文释义", cn, false));
  if (en.length) body.appendChild(section("英文释义", en, true));
  if (!cn.length && !en.length) {
    const d = document.createElement("div");
    d.className = "miss";
    d.textContent = "这个词条只有词头，没有释义";
    body.appendChild(d);
  }

  if (from === "lemma" || from === "guess") {
    const note = document.createElement("div");
    note.className = "lemma-note";
    note.textContent =
      from === "lemma" ? "按原形 " + via + " 查到" : "按 " + via + " 推断，可能不完全准确";
    body.appendChild(note);
  }

  const tags = document.createElement("div");
  tags.className = "tags";
  if (entry.collins > 0) tags.appendChild(tag("柯林斯 " + entry.collins + " 星", "star"));
  if (entry.oxford === 1) tags.appendChild(tag("牛津核心词", "ox"));
  if (entry.frq > 0) tags.appendChild(tag("词频 " + entry.frq, ""));
  if (entry.tag) tags.appendChild(tag(entry.tag, ""));
  if (tags.children.length) body.appendChild(tags);
}

function section(title, lines, isEn) {
  const wrap = document.createElement("div");
  const h = document.createElement("div");
  h.className = "sect-title";
  h.textContent = title;
  wrap.appendChild(h);
  const ul = document.createElement("ul");
  ul.className = "def-list" + (isEn ? " en" : "");
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function tag(text, cls) {
  const s = document.createElement("span");
  s.className = "tag " + cls;
  s.textContent = text;
  return s;
}

/* ------------------------------------------------------------------ *
 * 句子翻译
 * ------------------------------------------------------------------ */

function setPopupMode(mode) {
  state.mode = mode;
  const wordMode = mode === "word";
  el("speakUk").hidden = !wordMode;
  el("speakUs").hidden = !wordMode;
  el("saveWord").hidden = !wordMode;
  el("copyTr").hidden = wordMode;
  el("retryTr").hidden = wordMode;
  el("pwTrans").hidden = wordMode;
  el("pwBody").hidden = !wordMode;
}

function showSentenceWaiting(text, rect) {
  setPopupMode("sentence");
  state.sentence = text;
  state.sentenceRect = rect;
  el("pwWord").textContent = "句子翻译";
  el("pwPhonetic").textContent = text.length + " 字符";
  el("trSrc").textContent = text;
  el("trOut").className = "tr-out is-waiting";
  el("trOut").textContent = "翻译中…";
  el("trBy").textContent = "";
  placePopup(rect);
}

function firstSense(s) {
  const first = String(s || "").split("\\n")[0].trim();
  return first.split(/[；;，,]/)[0].replace(/^[a-z]+\.\s*/i, "");
}

// 联网翻译全挂了时的兜底：给一份逐词对照，至少能看懂句子
async function offlineGlossary(text) {
  const raw = String(text).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const seen = [];
  for (const t of raw) {
    const k = t.toLowerCase();
    if (!seen.includes(k)) seen.push(k);
  }
  const rows = [];
  for (const t of seen.slice(0, 16)) {
    const r = await lookup(t);
    if (r && r.entry && r.entry.translation) rows.push(t + "  " + firstSense(r.entry.translation));
  }
  return rows;
}

async function runTranslation(text, rect) {
  showSentenceWaiting(text, rect);
  const res = await translateSentence(text);
  if (res) {
    el("trOut").className = "tr-out";
    el("trOut").textContent = res.text;
    el("trBy").textContent = "由 " + res.provider + " 翻译";
    placePopup(rect);
    return;
  }
  const rows = await offlineGlossary(text);
  el("trOut").className = "tr-out is-failed";
  el("trOut").textContent = rows.length
    ? "联网翻译没连上，下面是本地词典的逐词对照：\n" + rows.join("\n")
    : "联网翻译没连上，本地词典也没查到这个词句里的词。";
  el("trBy").textContent = "检查网络，或者到设置里填一个大模型接口";
  placePopup(rect);
}

function placePopup(rect) {
  popup.hidden = false;
  const w = popup.offsetWidth;
  const h = popup.offsetHeight;
  let left = rect.right + 14;
  let top = rect.bottom + 10;
  if (left + w > window.innerWidth - 8) {
    left = Math.max(8, rect.left - w - 14);
  }
  if (top + h > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - h - 12);
  }
  popup.style.left = left + "px";
  popup.style.top = top + "px";
}

function showWaiting(rect) {
  setPopupMode("word");
  el("pwWord").textContent = "…";
  el("pwPhonetic").textContent = "";
  const body = el("pwBody");
  body.innerHTML = "";
  const d = document.createElement("div");
  d.className = "loading-dots";
  d.textContent = "查词中";
  body.appendChild(d);
  popup.hidden = false;
  const w = popup.offsetWidth;
  let left = rect.right + 14;
  if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 14);
  popup.style.left = left + "px";
  popup.style.top = Math.min(rect.bottom + 10, window.innerHeight - 120) + "px";
}

function refreshSaveButton() {
  const btn = el("saveWord");
  if (!state.last || !state.last.entry) {
    btn.textContent = "收录";
    btn.classList.remove("is-on");
    return;
  }
  const word = state.last.entry.word;
  if (wb.has(word)) {
    btn.textContent = "已收录";
    btn.classList.add("is-on");
  } else {
    btn.textContent = "收录";
    btn.classList.remove("is-on");
  }
}

/* ------------------------------------------------------------------ *
 * 发音
 * ------------------------------------------------------------------ */

async function sayWord(word, accent) {
  if (!word) return;
  const how = await speak(word, accent);
  if (!how) toast("这个环境发不出声音，换个浏览器试试");
}

/* ------------------------------------------------------------------ *
 * 生词本界面
 * ------------------------------------------------------------------ */

function visibleItems() {
  const list = wb.all();
  if (state.tab === "due") return wb.dueList();
  if (state.tab === "mastered") return wb.masteredList();
  return list;
}

function renderWordbook() {
  const list = visibleItems();
  const allItems = wb.all();
  const due = wb.dueList().length;

  el("wbStats").textContent =
    `共 ${allItems.length} 词 · 待复习 ${due} · 已掌握 ${wb.masteredList().length}`;

  const badge = el("wbDue");
  if (due > 0) {
    badge.textContent = String(due);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  const box = el("wbList");
  box.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "wb-empty";
    empty.textContent =
      state.tab === "due"
        ? "今天没有到期要复习的词"
        : state.tab === "mastered"
        ? "还没有标记为已掌握的词"
        : "还没有收录单词，点词后按「收录」加进来";
    box.appendChild(empty);
    return;
  }

  for (const it of list) {
    const row = document.createElement("div");
    row.className = "wb-row" + (it.mastered ? " is-mastered" : "");

    const main = document.createElement("div");
    main.className = "wb-main";

    const top = document.createElement("div");
    top.className = "wb-top";
    const w = document.createElement("span");
    w.className = "wb-word";
    w.textContent = it.word;
    const ph = document.createElement("span");
    ph.className = "wb-ph";
    ph.textContent = it.phonetic || "";
    top.appendChild(w);
    top.appendChild(ph);

    const cn = document.createElement("div");
    cn.className = "wb-cn";
    cn.textContent = (it.cn || "").replace(/\\n/g, " / ").slice(0, 90);

    const meta = document.createElement("div");
    meta.className = "wb-meta";
    meta.textContent =
      (it.mastered ? "已掌握" : "第 " + (it.stage + 1) + " 档 · " + wb.nextDueLabel(it)) +
      (it.source ? " · " + it.source : "");

    main.appendChild(top);
    main.appendChild(cn);
    main.appendChild(meta);

    const ops = document.createElement("div");
    ops.className = "wb-ops";
    ops.appendChild(miniBtn("英音", () => sayWord(it.word, "uk")));
    ops.appendChild(miniBtn("美音", () => sayWord(it.word, "us")));
    ops.appendChild(miniBtn("重来", () => {
      wb.resetProgress(it.word);
      toast(it.word + " 已回到第一档");
      renderWordbook();
    }));
    ops.appendChild(miniBtn("删", () => {
      wb.remove(it.word);
      renderWordbook();
    }));

    row.appendChild(main);
    row.appendChild(ops);
    box.appendChild(row);
  }
}

function miniBtn(text, fn) {
  const b = document.createElement("button");
  b.className = "btn tiny";
  b.textContent = text;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function openDrawer() {
  drawer.hidden = false;
  renderWordbook();
  refreshReminderButton();
}

/* ------------------------------------------------------------------ *
 * 书架
 * ------------------------------------------------------------------ */

const shelfBox = el("shelf");

function sizeLabel(n) {
  if (!n) return "—";
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

function coverChar(name) {
  const s = String(name || "").replace(/\.pdf$/i, "").trim();
  const m = /[A-Za-z]/.exec(s);
  return (m ? m[0] : s.slice(0, 1) || "?").toUpperCase();
}

async function renderShelf() {
  const list = await shelfList();
  el("shelfNote").textContent = shelfServer()
    ? "书会留在书架上，下次打开自动回到上次那一页。"
    : "单文件版存不下文件本体，重开时要再选一次同一份文件，选完自动跳回原来的页码。";

  const box = el("shelfList");
  box.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "shelf-empty";
    empty.textContent = "书架还是空的，打开一份 PDF 就会自动加进来";
    box.appendChild(empty);
    return;
  }

  for (const b of list) {
    const current = state.book && state.book.id === b.id;
    const total = b.pageCount || 0;
    const page = Math.min(Math.max(1, b.page || 1), total || 1);

    const row = document.createElement("div");
    row.className = "shelf-item" + (current ? " is-current" : "");

    const cover = document.createElement("div");
    cover.className = "shelf-cover";
    cover.textContent = coverChar(b.name);

    const main = document.createElement("div");
    main.className = "shelf-main";

    const name = document.createElement("div");
    name.className = "shelf-name";
    name.textContent = b.name;

    const meta = document.createElement("div");
    meta.className = "shelf-meta";
    meta.textContent =
      (total ? total + " 页 · " : "") +
      sizeLabel(b.size) +
      " · 读到第 " +
      page +
      " 页" +
      (b.lastRead ? " · " + b.lastRead : "");

    const bar = document.createElement("div");
    bar.className = "shelf-bar";
    const fill = document.createElement("i");
    fill.style.width = total ? Math.max(2, Math.round((page / total) * 100)) + "%" : "0%";
    bar.appendChild(fill);

    main.appendChild(name);
    main.appendChild(meta);
    main.appendChild(bar);

    const ops = document.createElement("div");
    ops.className = "shelf-ops";
    ops.appendChild(miniBtn(current ? "在读" : "继续", () => openShelfBook(b)));
    ops.appendChild(miniBtn("移除", () => removeShelfBook(b)));

    row.appendChild(cover);
    row.appendChild(main);
    row.appendChild(ops);
    box.appendChild(row);
  }
}

async function openShelfBook(book) {
  if (shelfServer()) {
    shelfBox.hidden = true;
    toast("正在打开 " + book.name);
    try {
      const r = await fetch(shelfUrl(book.id));
      if (!r.ok) throw new Error("服务器上已经没有这份文件了");
      const blob = await r.blob();
      await openFile(new File([blob], book.name, { type: "application/pdf" }), book);
    } catch (err) {
      toast("打不开：" + err.message);
    }
    return;
  }
  // 没有服务端就存不下文件本体，只能请用户再选一次
  pendingBook = book;
  shelfBox.hidden = true;
  toast("再选一次《" + book.name + "》，选完自动跳回第 " + (book.page || 1) + " 页");
  el("fileInput").click();
}

async function removeShelfBook(book) {
  if (!confirm("把《" + book.name + "》从书架上拿掉？阅读进度也会一起丢。")) return;
  await shelfRemove(book.id);
  if (state.book && state.book.id === book.id) state.book = null;
  await renderShelf();
  toast("已移出书架");
}

el("shelfBtn").addEventListener("click", () => {
  shelfBox.hidden = false;
  renderShelf();
});
el("shelfClose").addEventListener("click", () => (shelfBox.hidden = true));
el("shelfDismiss").addEventListener("click", () => (shelfBox.hidden = true));
el("shelfAdd").addEventListener("click", () => {
  pendingBook = null;
  shelfBox.hidden = true;
  el("fileInput").click();
});
shelfBox.addEventListener("click", (e) => {
  if (e.target === shelfBox) shelfBox.hidden = true;
});

/* ------------------------------------------------------------------ *
 * 复习模式
 * ------------------------------------------------------------------ */

function startReview() {
  state.queue = wb.dueList();
  if (!state.queue.length) {
    const pending = wb.all().filter((i) => !i.mastered);
    if (!pending.length) {
      toast("生词本还是空的");
      return;
    }
    toast("今天没有到期的词，先复习全部 " + pending.length + " 个");
    state.queue = pending;
  }
  state.qi = 0;
  reviewBox.hidden = false;
  drawer.hidden = true;
  showCard();
}

function showCard() {
  const it = state.queue[state.qi];
  if (!it) {
    finishReview();
    return;
  }
  el("rvProgress").textContent = `第 ${state.qi + 1} / ${state.queue.length}`;
  el("rvWord").textContent = it.word;
  el("rvPhonetic").textContent = it.phonetic || "";
  el("rvCn").textContent = (it.cn || "").replace(/\\n/g, "\n");
  el("rvEn").textContent = (it.en || "").replace(/\\n/g, "\n");
  el("rvCtx").textContent = it.context
    ? "原句：" + it.context + (it.source ? "（" + it.source + " p." + it.page + "）" : "")
    : it.source
    ? "出处：" + it.source + " p." + it.page
    : "";
  el("rvAnswer").hidden = true;
  el("rvShow").hidden = false;
  el("rvOk").hidden = true;
  el("rvNo").hidden = true;
  el("rvHint").textContent = "";
  sayWord(it.word, "us");
}

function finishReview() {
  el("rvWord").textContent = "复习完了";
  el("rvPhonetic").textContent = "";
  el("rvCn").textContent = "";
  el("rvEn").textContent = "";
  el("rvCtx").textContent = "";
  el("rvAnswer").hidden = true;
  el("rvShow").hidden = true;
  el("rvOk").hidden = true;
  el("rvNo").hidden = true;
  el("rvHint").textContent = "关掉这个窗口就回到阅读";
  el("rvProgress").textContent = "完成 " + state.queue.length + " 个";
}

function answerReview(ok) {
  const it = state.queue[state.qi];
  if (!it) return;
  const updated = wb.review(it.word, ok);
  el("rvHint").textContent = updated
    ? updated.mastered
      ? it.word + " 已掌握"
      : it.word + " 下次 " + wb.nextDueLabel(updated)
    : "";
  state.qi++;
  setTimeout(() => {
    if (state.qi >= state.queue.length) finishReview();
    else showCard();
  }, 420);
}

/* ------------------------------------------------------------------ *
 * 提示条
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg) {
  clearTimeout(toastTimer);
  if (!msg) {
    toastEl.hidden = true;
    return;
  }
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

el("openBtn").addEventListener("click", () => {
  pendingBook = null;
  el("fileInput").click();
});
el("fileInput").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  // 单文件版从书架点书要重新选文件，选中的是同一份才接上进度
  const preset =
    pendingBook && pendingBook.name === f.name && pendingBook.size === f.size
      ? pendingBook
      : null;
  pendingBook = null;
  e.target.value = "";
  openFile(f, preset);
});

el("zoomIn").addEventListener("click", () => setScale(state.scale * 1.15));
el("zoomOut").addEventListener("click", () => setScale(state.scale / 1.15));
el("fitBtn").addEventListener("click", () => {
  if (!state.doc) return;
  fitScale(state.sizes[0].width);
  setScale(state.scale, true);
});

el("pwClose").addEventListener("click", closePopup);
el("speakUk").addEventListener("click", () => {
  const w = state.last && state.last.entry ? state.last.entry.word : state.last && state.last.query;
  sayWord(w, "uk");
});
el("speakUs").addEventListener("click", () => {
  const w = state.last && state.last.entry ? state.last.entry.word : state.last && state.last.query;
  sayWord(w, "us");
});

el("saveWord").addEventListener("click", () => {
  const last = state.last;
  if (!last || !last.entry) {
    toast("这个词没查到，没法收录");
    return;
  }
  const e = last.entry;
  const r = wb.add({
    word: e.word,
    phonetic: e.phonetic || "",
    cn: e.translation || "",
    en: e.definition || "",
    pos: e.pos || "",
    source: el("fileName").textContent,
    page: last.page || 0,
    context: last.context || "",
  });
  refreshSaveButton();
  toast(r.duplicate ? e.word + " 已经在生词本里" : "已收录 " + e.word);
});

el("wbBtn").addEventListener("click", () => {
  if (drawer.hidden) openDrawer();
  else drawer.hidden = true;
});
el("drawerClose").addEventListener("click", () => (drawer.hidden = true));

document.querySelectorAll(".drawer-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".drawer-tabs .tab").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    state.tab = btn.dataset.tab;
    renderWordbook();
  });
});

el("reviewBtn").addEventListener("click", startReview);
el("rvClose").addEventListener("click", () => {
  reviewBox.hidden = true;
  renderWordbook();
});
el("rvShow").addEventListener("click", () => {
  el("rvAnswer").hidden = false;
  el("rvShow").hidden = true;
  el("rvOk").hidden = false;
  el("rvNo").hidden = false;
});
el("rvOk").addEventListener("click", () => answerReview(true));
el("rvNo").addEventListener("click", () => answerReview(false));
el("rvUk").addEventListener("click", () => {
  const it = state.queue[state.qi];
  if (it) sayWord(it.word, "uk");
});
el("rvUs").addEventListener("click", () => {
  const it = state.queue[state.qi];
  if (it) sayWord(it.word, "us");
});

el("expAnki").addEventListener("click", () => {
  if (!wb.all().length) return toast("生词本是空的");
  toast("已导出 " + wb.exportBlob("anki"));
});
el("expCsv").addEventListener("click", () => {
  if (!wb.all().length) return toast("生词本是空的");
  toast("已导出 " + wb.exportBlob("csv"));
});
el("expJson").addEventListener("click", () => {
  if (!wb.all().length) return toast("生词本是空的");
  toast("已备份 " + wb.exportBlob("json"));
});
el("impJson").addEventListener("click", () => el("impInput").click());
el("impInput").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const r = wb.importJson(await f.text());
    renderWordbook();
    toast(`导入完成，新增 ${r.added} 个，合并 ${r.merged} 个`);
  } catch (err) {
    toast("导入失败：" + err.message);
  }
  e.target.value = "";
});

// 系统级每日提醒只有服务器模式装得上，单文件版退回到导出日历文件
async function refreshReminderButton() {
  const btn = el("remindBtn");
  if (!location.protocol.startsWith("http")) {
    btn.textContent = "每日提醒";
    btn.dataset.state = "ics";
    return;
  }
  try {
    const r = await fetch("api/reminder");
    const j = await r.json();
    if (j.installed) {
      btn.textContent = `提醒 ${j.hour}:${String(j.minute || 0).padStart(2, "0")} ✓`;
      btn.dataset.state = "on";
    } else {
      btn.textContent = "每日提醒";
      btn.dataset.state = "off";
    }
  } catch (err) {
    btn.textContent = "每日提醒";
    btn.dataset.state = "ics";
  }
}

el("remindBtn").addEventListener("click", async () => {
  const st = el("remindBtn").dataset.state;

  if (st === "on") {
    if (!confirm("关掉每日提醒？")) return;
    try {
      const r = await fetch("api/reminder", { method: "DELETE" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "关闭失败");
      toast("已关掉每日提醒");
    } catch (err) {
      toast("关闭失败：" + err.message);
    }
    refreshReminderButton();
    return;
  }

  const input = prompt("每天几点提醒？填 0 到 23，例如 9", "9");
  if (input === null) return;
  const hour = Number(input);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    toast("时间要在 0 到 23 之间");
    return;
  }

  if (st === "off") {
    try {
      const r = await fetch("api/reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hour, minute: 0 }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "安装失败");
      toast(`已设置每天 ${hour} 点提醒`);
      refreshReminderButton();
      return;
    } catch (err) {
      toast("装不上系统提醒，改成导出日历文件");
    }
  }
  const name = wb.downloadIcs(hour, 0);
  toast("已生成 " + name + "，双击导入日历即可每天提醒");
});

el("icsBtn").addEventListener("click", () => {
  const input = prompt("每天几点提醒？填 0 到 23，例如 9", "9");
  if (input === null) return;
  const hour = Number(input);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    toast("时间要在 0 到 23 之间");
    return;
  }
  const name = wb.downloadIcs(hour, 0);
  toast("已生成 " + name + "，双击导入日历即可每天提醒");
});

el("clearBtn").addEventListener("click", () => {
  if (!wb.all().length) return toast("生词本已经是空的");
  if (!confirm("清空整个生词本？导出的备份文件不受影响。")) return;
  wb.clearAll();
  renderWordbook();
  toast("已清空");
});

/* ------------------------------------------------------------------ *
 * 设置：句子翻译引擎
 * ------------------------------------------------------------------ */

function openSettings() {
  const cfg = getConfig();
  el("setProvider").value = cfg.provider === "llm" ? "llm" : "free";
  el("setBase").value = cfg.baseUrl || "";
  el("setKey").value = cfg.apiKey || "";
  el("setModel").value = cfg.model || "";
  el("llmFields").hidden = el("setProvider").value !== "llm";
  el("setMsg").textContent = "";
  el("setMsg").className = "set-msg";
  settingsBox.hidden = false;
}

function readSettingsForm() {
  return {
    provider: el("setProvider").value,
    baseUrl: el("setBase").value.trim(),
    apiKey: el("setKey").value.trim(),
    model: el("setModel").value.trim(),
  };
}

el("setBtn").addEventListener("click", openSettings);
el("setClose").addEventListener("click", () => (settingsBox.hidden = true));
el("setCancel").addEventListener("click", () => (settingsBox.hidden = true));
el("setProvider").addEventListener("change", () => {
  el("llmFields").hidden = el("setProvider").value !== "llm";
});
el("setSave").addEventListener("click", () => {
  const cfg = readSettingsForm();
  setConfig(cfg);
  settingsBox.hidden = true;
  toast(cfg.provider === "llm" ? "已保存，句子翻译走自定义接口" : "已保存，句子翻译走免费在线接口");
});
el("setTest").addEventListener("click", async () => {
  const msg = el("setMsg");
  msg.className = "set-msg";
  msg.textContent = "测试中…";
  const r = await testConfig({ ...readSettingsForm(), provider: "llm" });
  if (r.ok) {
    msg.className = "set-msg ok";
    msg.textContent = "通了，试译：" + r.sample.slice(0, 36);
  } else {
    msg.className = "set-msg err";
    msg.textContent = r.error;
  }
});

el("copyTr").addEventListener("click", async () => {
  const text = el("trOut").textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    toast("译文已复制");
  } catch (err) {
    toast("复制失败，手动选中吧");
  }
});

el("retryTr").addEventListener("click", () => {
  if (state.sentence) runTranslation(state.sentence, state.sentenceRect);
});

document.addEventListener("click", (e) => {
  if (popup.hidden) return;
  if (popup.contains(e.target)) return;
  if (e.target.closest(".page")) return;
  closePopup();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!shelfBox.hidden) {
      shelfBox.hidden = true;
      return;
    }
    if (!settingsBox.hidden) {
      settingsBox.hidden = true;
      return;
    }
    if (!reviewBox.hidden) {
      reviewBox.hidden = true;
      renderWordbook();
      return;
    }
    closePopup();
  }
});

async function showWord(word, rect, picked) {
  showHit(rect);
  showWaiting(rect);
  try {
    let res = await lookup(word);
    // 连字符拼起来的词查不到，再试试保留连字符的写法
    if (picked && picked.alt && (!res || !res.entry)) res = await lookup(picked.alt);
    if (!res) {
      closePopup();
      return;
    }
    const node = picked ? picked.node : null;
    state.last = {
      entry: res.entry,
      query: res.query,
      page: pageIndexAt(node),
      context: contextAround(node, res.query),
    };
    renderEntry(res);
    if (picked && picked.joined) {
      const note = document.createElement("div");
      note.className = "lemma-note";
      note.textContent = "这个词被换行拆开了，已按整词查询";
      el("pwBody").appendChild(note);
    }
    refreshSaveButton();
    placePopup(rect);
  } catch (err) {
    closePopup();
    toast("查词失败：" + err.message);
  }
}

// 取词放在 mouseup 上：拖选句子和单击取词都要走这里，click 会被拖选搅乱
pagesBox.addEventListener("mouseup", async (e) => {
  if (!state.doc || e.button !== 0) return;
  await new Promise((r) => setTimeout(r, 0));

  const sel = window.getSelection();
  const selected = sel && !sel.isCollapsed ? String(sel.toString()).trim() : "";

  if (selected) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    sel.removeAllRanges();
    const tokens = selected.split(/\s+/).filter(Boolean);
    // 两个词以上，或者单个很长的一串，按句子翻译
    if (tokens.length >= 2 || selected.length >= 24) {
      showHit(rect);
      await runTranslation(selected, rect);
      return;
    }
    await showWord(tokens[0], rect, null);
    return;
  }

  const picked = wordFromPoint(e.clientX, e.clientY);
  if (!picked || !picked.word) {
    closePopup(); // 点在空白处就收起卡片
    return;
  }
  await showWord(picked.word, picked.rect, picked);
});

/* ------------------------------------------------------------------ *
 * 触控板捏合缩放：两指捏合在浏览器里就是带 ctrlKey 的 wheel
 * ------------------------------------------------------------------ */

function zoomAt(factor, clientX, clientY) {
  const before = state.scale;
  const next = Math.max(0.4, Math.min(4, before * factor));
  if (Math.abs(next - before) < 0.0005) return;

  const box = viewer.getBoundingClientRect();
  const cx = clientX - box.left;
  const cy = clientY - box.top;
  const contentX = viewer.scrollLeft + cx;
  const contentY = viewer.scrollTop + cy;

  setScale(next);
  const k = next / before;
  viewer.scrollLeft = contentX * k - cx;
  viewer.scrollTop = contentY * k - cy;
}

viewer.addEventListener(
  "wheel",
  (e) => {
    if (!state.doc) return;
    if (!e.ctrlKey) return;
    e.preventDefault();
    // 捏开时 deltaY 是负的，正好对应放大
    zoomAt(Math.exp(-e.deltaY * 0.012), e.clientX, e.clientY);
  },
  { passive: false }
);

viewer.addEventListener(
  "scroll",
  () => {
    updatePageLabel();
    scheduleSave();
    if (!popup.hidden) closePopup();
  },
  { passive: true }
);

// 关页面前补一次，用 keepalive 保证请求发得出去
window.addEventListener("beforeunload", () => {
  if (!state.book) return;
  clearTimeout(state.saveTimer);
  shelfUpdateNow(state.book.id, {
    page: state.current,
    scale: state.scale,
    fitMode: state.fitMode,
  });
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.doc || !state.fitMode) return;
    fitScale(state.sizes[0].width);
    setScale(state.scale, true);
  }, 200);
});

["dragenter", "dragover"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    el("dropMask").hidden = false;
  })
);
["dragleave", "drop"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop" || e.target === document.documentElement) el("dropMask").hidden = true;
  })
);
window.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

wb.onChange(() => {
  if (!drawer.hidden) renderWordbook();
  const due = wb.dueList().length;
  const badge = el("wbDue");
  badge.textContent = String(due);
  badge.hidden = due === 0;
  refreshSavedWords();
  markAllPages();
});

wb.load();
refreshSavedWords();
warmVoices();
renderWordbook();
refreshReminderButton();

// 打开时有到期的词就提醒一句
setTimeout(() => {
  const due = wb.dueList().length;
  if (due > 0) toast(`有 ${due} 个生词到复习时间了，点右上角「生词本」`);
}, 900);

/* ------------------------------------------------------------------ *
 * 自检模式：?pdf=相对路径 自动打开，?selftest=1 再模拟点一次词
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function finishSelfTest(report) {
  // 只在 DOM 上留一份不可见的报告，给无头自检读取，不污染界面
  const div = document.createElement("div");
  div.id = "selftest";
  div.hidden = true;
  div.setAttribute("data-report", JSON.stringify(report));
  document.body.appendChild(div);
}

async function runSelfTest() {
  const report = { steps: [] };

  const pageIdx = Math.max(
    0,
    Math.min(state.pageEls.length - 1, Number(params.get("page") || 1) - 1)
  );
  if (pageIdx > 0) state.pageEls[pageIdx].scrollIntoView({ block: "start" });

  const page0 = await waitFor(() => {
    const p = state.pageEls[pageIdx];
    return p && p.dataset.state === "rendered" ? p : null;
  });
  if (!page0) {
    report.steps.push("第一页没有渲染出来");
    finishSelfTest(report);
    return;
  }
  report.pages = state.pageEls.length;
  report.rendered = true;

  const spans = [...page0.querySelectorAll(".textLayer span")].filter(
    (s) => s.textContent && /[a-zA-Z]{4,}/.test(s.textContent)
  );
  report.textSpans = spans.length;
  if (!spans.length) {
    report.steps.push("文本层里没找到英文词");
    finishSelfTest(report);
    return;
  }

  // 只点视口范围内的词，视口外点不到，测出来的是脚本问题不是应用问题
  const inView = spans.filter((s) => {
    const r = s.getBoundingClientRect();
    return r.top > 80 && r.bottom < window.innerHeight - 80 && r.width > 4;
  });
  const span = inView[0] || spans[0];
  const node = span.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    report.steps.push("文本层结构不是文本节点");
    finishSelfTest(report);
    return;
  }

  const m = /[a-zA-Z]{4,}/.exec(node.nodeValue);
  const idx = m.index + Math.floor(m[0].length / 2);
  const range = document.createRange();
  range.setStart(node, idx);
  range.setEnd(node, idx);
  const rect = range.getBoundingClientRect();
  const x = rect.left + 1;
  const y = rect.top + (rect.height || 12) / 2;
  report.clickAt = [Math.round(x), Math.round(y)];
  report.expected = m[0];

  const target = document.elementFromPoint(x, y) || span;
  target.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button: 0, bubbles: true }));

  const done = await waitFor(() => !popup.hidden && el("pwWord").textContent !== "…");
  report.popupShown = !popup.hidden;
  report.word = el("pwWord").textContent;
  report.phonetic = el("pwPhonetic").textContent;
  report.body = (popup.innerText || "").replace(/\s+/g, " ").slice(0, 260);
  report.hitBox = !!document.querySelector(".hit-box");
  if (!done) report.steps.push("点了词但卡片一直没出内容");

  // 收录流程
  if (report.word && report.word !== "…") {
    el("saveWord").click();
    report.saved = wb.all().length;
    report.savedWord = wb.all()[0] && wb.all()[0].word;
    report.dueCount = wb.dueList().length;
    const anki = wb.exportAnki();
    report.ankiLine = anki.text.split("\n")[0].slice(0, 140);
    const ics = wb.exportIcs(9, 0);
    report.icsOk = ics.text.includes("RRULE:FREQ=DAILY") && ics.text.startsWith("BEGIN:VCALENDAR");
  }

  finishSelfTest(report);
}

// 单文件版没法用 fetch 取本地 PDF，把入口挂到 window 上，由外部注入文件后手动触发
if (params.get("selftest") === "1") window.__runSelfTest = runSelfTest;

if (params.get("pdf")) {
  (async () => {
    try {
      const resp = await fetch(params.get("pdf"));
      const blob = await resp.blob();
      const name = params.get("pdf").split("/").pop();
      await openFile(new File([blob], name, { type: "application/pdf" }));
      if (params.get("selftest") === "1") await runSelfTest();
    } catch (err) {
      finishSelfTest({ steps: ["自检失败：" + err.message] });
    }
  })();
} else {
  // 没有指定测试文件，就把上次在读的那本直接打开
  (async () => {
    try {
      const list = await shelfList();
      if (!list.length) return;
      if (shelfServer()) {
        await openShelfBook(list[0]);
      } else {
        setTimeout(
          () => toast("书架上有 " + list.length + " 本书，点左上角「书架」接着读"),
          1500
        );
      }
    } catch (err) {
      /* 书架读不出来就停在空状态，不影响使用 */
    }
  })();
}
