// 生词本：收录、艾宾浩斯排期、导出、每日提醒。
// 数据存在 localStorage；服务器模式下额外同步一份到磁盘，供提醒脚本读取。

const KEY = "pdf-dict-reader.wordbook.v1";
const DAY = 86400000;

// 艾宾浩斯复习间隔，单位是天。下标就是阶段号，走完最后一档标记已掌握。
export const INTERVALS = [1, 2, 4, 7, 15, 30, 60];

let items = [];
const listeners = new Set();

/* ---------------------------------------------------------------- *
 * 存取
 * ---------------------------------------------------------------- */

export function onChange(fn) {
  listeners.add(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      /* 单个监听出错不影响其他 */
    }
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    items = raw ? JSON.parse(raw) : [];
  } catch (err) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  return items;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch (err) {
    /* 存不下就算了，不影响本次使用 */
  }
  syncToServer();
  emit();
}

let syncTimer = null;
function syncToServer() {
  if (!location.protocol.startsWith("http")) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await fetch("api/wordbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
    } catch (err) {
      /* 服务器没开就算了 */
    }
  }, 400);
}

export function all() {
  return items;
}

export function has(word) {
  const w = String(word || "").toLowerCase();
  return items.some((it) => it.word.toLowerCase() === w);
}

export function get(word) {
  const w = String(word || "").toLowerCase();
  return items.find((it) => it.word.toLowerCase() === w) || null;
}

/* ---------------------------------------------------------------- *
 * 收录
 * ---------------------------------------------------------------- */

export function add(fields) {
  const word = String(fields.word || "").trim();
  if (!word) return null;

  const key = word.toLowerCase();
  const now = Date.now();
  const existing = items.find((it) => it.word.toLowerCase() === key);

  if (existing) {
    // 重复收录只补出处信息，不动复习进度
    if (fields.source && !existing.sources) existing.sources = [];
    if (fields.source) {
      existing.sources = existing.sources || [];
      const mark = fields.source + " p." + (fields.page || "?");
      if (!existing.sources.includes(mark)) existing.sources.push(mark);
    }
    if (fields.context && !existing.context) existing.context = fields.context;
    persist();
    return { item: existing, duplicate: true };
  }

  const item = {
    word,
    phonetic: fields.phonetic || "",
    cn: fields.cn || "",
    en: fields.en || "",
    pos: fields.pos || "",
    source: fields.source || "",
    page: fields.page || 0,
    context: fields.context || "",
    sources: fields.source ? [fields.source + " p." + (fields.page || "?")] : [],
    added: now,
    stage: 0,
    due: now + INTERVALS[0] * DAY,
    reviews: [],
    mastered: false,
  };
  items.unshift(item);
  persist();
  return { item, duplicate: false };
}

export function remove(word) {
  const key = String(word || "").toLowerCase();
  items = items.filter((it) => it.word.toLowerCase() !== key);
  persist();
}

export function clearAll() {
  items = [];
  persist();
}

/* ---------------------------------------------------------------- *
 * 复习
 * ---------------------------------------------------------------- */

export function dueList() {
  const now = Date.now();
  return items
    .filter((it) => !it.mastered && it.due <= now)
    .sort((a, b) => a.due - b.due);
}

export function masteredList() {
  return items.filter((it) => it.mastered);
}

export function nextDueLabel(item) {
  if (item.mastered) return "已掌握";
  const left = item.due - Date.now();
  if (left <= 0) return "待复习";
  const d = Math.ceil(left / DAY);
  return d <= 1 ? "明天" : d + " 天后";
}

// ok=true 前进一档，ok=false 打回第一档
export function review(word, ok) {
  const it = get(word);
  if (!it) return null;
  it.reviews = it.reviews || [];
  it.reviews.push({ t: Date.now(), ok: !!ok });

  if (ok) {
    it.stage = (it.stage || 0) + 1;
    if (it.stage >= INTERVALS.length) {
      it.mastered = true;
      it.due = Date.now();
    } else {
      it.due = Date.now() + INTERVALS[it.stage] * DAY;
    }
  } else {
    it.stage = 0;
    it.mastered = false;
    it.due = Date.now() + INTERVALS[0] * DAY;
  }
  persist();
  return it;
}

export function resetProgress(word) {
  const it = get(word);
  if (!it) return null;
  it.stage = 0;
  it.mastered = false;
  it.due = Date.now() + INTERVALS[0] * DAY;
  persist();
  return it;
}

/* ---------------------------------------------------------------- *
 * 导入导出
 * ---------------------------------------------------------------- */

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function flat(s) {
  return String(s || "").replace(/\\n/g, " ").replace(/[\r\n\t]+/g, " ").trim();
}

// Anki / 不背单词 / 墨墨 都能直接导入的制表符文本
export function exportAnki() {
  const lines = items.map((it) =>
    [it.word, flat(it.phonetic), flat(it.cn), flat(it.en), flat(it.source || "")].join("\t")
  );
  return {
    name: `生词本-${stamp()}-anki.txt`,
    text: lines.join("\n"),
    mime: "text/plain;charset=utf-8",
  };
}

function csvCell(s) {
  const v = String(s === undefined || s === null ? "" : s).replace(/\\n/g, " ");
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// 带 BOM，Excel 打开不乱码
export function exportCsv() {
  const head = ["单词", "音标", "中文释义", "英文释义", "出处", "复习阶段", "下次复习", "收录时间"];
  const rows = items.map((it) =>
    [
      it.word,
      it.phonetic,
      flat(it.cn),
      flat(it.en),
      flat(it.source || ""),
      it.mastered ? "已掌握" : "第 " + ((it.stage || 0) + 1) + " 档",
      it.mastered ? "—" : new Date(it.due).toLocaleDateString("zh-CN"),
      new Date(it.added).toLocaleDateString("zh-CN"),
    ]
      .map(csvCell)
      .join(",")
  );
  return {
    name: `生词本-${stamp()}.csv`,
    text: "﻿" + [head.map(csvCell).join(","), ...rows].join("\r\n"),
    mime: "text/csv;charset=utf-8",
  };
}

export function exportJson() {
  return {
    name: `生词本备份-${stamp()}.json`,
    text: JSON.stringify({ version: 1, exported: Date.now(), items }, null, 2),
    mime: "application/json",
  };
}

export function exportBlob(kind) {
  const f = kind === "csv" ? exportCsv() : kind === "anki" ? exportAnki() : exportJson();
  download(f.name, f.text, f.mime);
  return f.name;
}

export function importJson(text) {
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(incoming)) throw new Error("文件格式不对，里面没有词条列表");

  let added = 0;
  let merged = 0;
  for (const raw of incoming) {
    if (!raw || !raw.word) continue;
    const key = String(raw.word).toLowerCase();
    const existing = items.find((it) => it.word.toLowerCase() === key);
    if (existing) {
      // 保留更靠后的复习进度
      if ((raw.stage || 0) > (existing.stage || 0)) {
        existing.stage = raw.stage;
        existing.due = raw.due || existing.due;
        existing.mastered = !!raw.mastered;
      }
      merged++;
    } else {
      items.push({
        word: raw.word,
        phonetic: raw.phonetic || "",
        cn: raw.cn || "",
        en: raw.en || "",
        pos: raw.pos || "",
        source: raw.source || "",
        page: raw.page || 0,
        context: raw.context || "",
        sources: Array.isArray(raw.sources) ? raw.sources : [],
        added: raw.added || Date.now(),
        stage: raw.stage || 0,
        due: raw.due || Date.now() + INTERVALS[0] * DAY,
        reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
        mastered: !!raw.mastered,
      });
      added++;
    }
  }
  persist();
  return { added, merged };
}

/* ---------------------------------------------------------------- *
 * 每日提醒：导出 ics，导入系统日历后每天弹一次
 * ---------------------------------------------------------------- */

export function exportIcs(hour = 9, minute = 0) {
  const p = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
  const end = new Date(start.getTime() + 15 * 60000);
  const fmt = (d) =>
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  const utc = (d) =>
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
      d.getUTCMinutes()
    )}${p(d.getUTCSeconds())}Z`;

  const due = dueList().length;
  const total = items.filter((i) => !i.mastered).length;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//pdf-dict-reader//wordbook//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:pdf-dict-reader-review@local",
    `DTSTAMP:${utc(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `RRULE:FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`,
    "SUMMARY:复习生词本",
    `DESCRIPTION:当前待复习 ${due} 个，在记 ${total} 个。打开外刊阅读器开始复习。`,
    "BEGIN:VALARM",
    "TRIGGER:-PT0M",
    "ACTION:DISPLAY",
    "DESCRIPTION:该复习生词了",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return {
    name: `生词本每日提醒-${hour}点${p(minute)}分.ics`,
    text: lines.join("\r\n") + "\r\n",
    mime: "text/calendar;charset=utf-8",
  };
}

export function downloadIcs(hour, minute) {
  const f = exportIcs(hour, minute);
  download(f.name, f.text, f.mime);
  return f.name;
}
