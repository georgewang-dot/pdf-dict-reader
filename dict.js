// 词典查询：按需加载分片，命中后建索引缓存。不依赖 DOM，可单独测试。
//
// 两种数据来源：
//   1. 服务器模式：fetch data/dict/words-a.tsv
//   2. 单文件模式：window.__DICT_SHARDS__ 里的 gzip + base64 分片，file:// 下也能用

let DICT_BASE = "";

export function configure(base) {
  DICT_BASE = base.endsWith("/") ? base : base + "/";
}

function embedded() {
  return (typeof window !== "undefined" && window.__DICT_SHARDS__) || null;
}

export function isEmbedded() {
  return !!embedded();
}

const shardCache = new Map();

function shardChar(word) {
  const c = (word[0] || "_").toLowerCase();
  return c >= "a" && c <= "z" ? c : "_";
}

async function decodeShard(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function loadShard(kind, ch) {
  const key = kind + "-" + ch;
  if (shardCache.has(key)) return shardCache.get(key);

  let text;
  const emb = embedded();
  if (emb && emb[key]) {
    text = await decodeShard(emb[key]);
  } else {
    const url = new URL(`data/dict/${key}.tsv`, DICT_BASE || document.baseURI).href;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("词库分片缺失：" + key);
    text = await resp.text();
  }

  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (kind === "words") {
      if (f.length < 4) continue;
      map.set(f[0], {
        word: f[0],
        phonetic: f[1] || "",
        definition: f[2] || "",
        translation: f[3] || "",
        pos: f[4] || "",
        collins: parseInt(f[5], 10) || 0,
        oxford: parseInt(f[6], 10) || 0,
        frq: parseInt(f[7], 10) || 0,
        tag: f[8] || "",
      });
    } else if (f.length >= 2) {
      map.set(f[0], f[1]);
    }
  }
  shardCache.set(key, map);
  return map;
}

export function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[‘’ʼ']/g, "'")
    .replace(/[^a-z'-]+/g, " ")
    .trim()
    .split(/\s+/)[0]
    .replace(/^[-']+|[-']+$/g, "")
    .replace(/'s$/, "");
}

function* stemGuesses(w) {
  if (w.length < 4) return;
  if (w.endsWith("ies")) yield w.slice(0, -3) + "y";
  if (w.endsWith("es")) {
    yield w.slice(0, -2);
    yield w.slice(0, -1);
  } else if (w.endsWith("s") && !w.endsWith("ss")) {
    yield w.slice(0, -1);
  }
  if (w.endsWith("ing")) {
    yield w.slice(0, -3);
    yield w.slice(0, -3) + "e";
  }
  if (w.endsWith("ed")) {
    yield w.slice(0, -2);
    yield w.slice(0, -1);
    yield w.slice(0, -2) + "e";
  }
  if (w.endsWith("ly")) yield w.slice(0, -2);
  if (w.endsWith("est")) yield w.slice(0, -3);
  if (w.endsWith("er")) yield w.slice(0, -2);
}

export async function lookup(raw) {
  const q = normalize(raw);
  if (!q) return null;

  const direct = (await loadShard("words", shardChar(q))).get(q);
  if (direct) return { entry: direct, query: q, via: null, from: "exact" };

  const base = (await loadShard("forms", shardChar(q))).get(q);
  if (base) {
    const e = (await loadShard("words", shardChar(base))).get(base);
    if (e) return { entry: e, query: q, via: base, from: "lemma" };
  }

  for (const cand of stemGuesses(q)) {
    if (!cand || cand === q) continue;
    const e = (await loadShard("words", shardChar(cand))).get(cand);
    if (e) return { entry: e, query: q, via: cand, from: "guess" };
  }

  return { entry: null, query: q, via: base || null, from: "miss" };
}
