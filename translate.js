// 句子翻译。
//
// 顺序：自配的大模型接口 → 服务器代理的免费在线接口 → 浏览器直连免费在线接口。
// 全都拿不到就返回 null，由调用方退回本地词典直译。
//
// 不依赖 DOM，可在 node 里单独测。

const CFG_KEY = "pdf-dict-reader.translate.v1";

const SYSTEM =
  "你是资深中英科技译者，长期翻译 MIT Technology Review、The Economist 这类刊物。" +
  "把用户给出的英文译成简体中文：忠实原文，句子完整通顺，符合中文科技媒体的表达习惯，不要翻译腔。" +
  "专有名词、机构名、技术术语用通行中文译名，首次出现可在括号里附原文。" +
  "只输出译文本身，不要解释、不要加引号、不要前后缀说明。";

export function getConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

export function setConfig(cfg) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {}));
  } catch (err) {
    /* 存不下不影响本次使用 */
  }
}

function ready(cfg) {
  return cfg && cfg.provider === "llm" && cfg.baseUrl && cfg.apiKey;
}

function endpoint(base) {
  const b = String(base || "").replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : b + "/chat/completions";
}

// MyMemory 单次请求有长度上限，按句子切成小块再拼回去
function splitChunks(text, size = 400) {
  const parts = String(text).split(/(?<=[.!?;:])\s+/);
  const out = [];
  let buf = "";
  for (const p of parts) {
    if (buf && (buf.length + p.length + 1 > size)) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + " " + p : p;
    }
    // 单句本身就超长，硬切
    while (buf.length > size) {
      out.push(buf.slice(0, size));
      buf = buf.slice(size);
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [String(text)];
}

function pickContent(data) {
  const c =
    data &&
    data.choices &&
    data.choices[0] &&
    (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
  return c ? String(c).trim() : "";
}

async function callLLM(text, cfg) {
  const resp = await fetch(endpoint(cfg.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify({
      model: cfg.model || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error("大模型接口返回 " + resp.status + (detail ? " " + detail.slice(0, 120) : ""));
  }
  const out = pickContent(await resp.json());
  if (!out) throw new Error("大模型接口没返回译文");
  return { text: out, provider: "大模型 " + (cfg.model || "自定义") };
}

async function callFree(text) {
  const chunks = splitChunks(text);
  const outs = [];
  for (const part of chunks) {
    const url =
      "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(part) +
      "&langpair=en%7Czh-CN";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("在线翻译返回 " + resp.status);
    const data = await resp.json();
    const t = data && data.responseData && data.responseData.translatedText;
    if (!t) throw new Error("在线翻译没给结果");
    outs.push(String(t).trim());
  }
  // 接口偶尔会在末尾多带一个中文逗号
  const joined = outs.join("").replace(/，\s*$/, "。").trim();
  return { text: joined, provider: "MyMemory 在线翻译" };
}

async function callServer(text, cfg) {
  const resp = await fetch("api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, cfg: cfg || {} }),
  });
  if (!resp.ok) throw new Error("本地服务返回 " + resp.status);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "本地服务翻译失败");
  return { text: data.text, provider: data.provider };
}

export async function translateSentence(text) {
  const cfg = getConfig();

  if (ready(cfg)) {
    try {
      return await callLLM(text, cfg);
    } catch (err) {
      /* 掉到下一档 */
    }
  }
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    try {
      return await callServer(text, cfg);
    } catch (err) {
      /* 掉到下一档 */
    }
  }
  try {
    return await callFree(text);
  } catch (err) {
    return null;
  }
}

// 设置页里试一下接口通不通
export async function testConfig(cfg) {
  if (!ready(cfg)) return { ok: false, error: "还没填全接口地址、密钥和模型名" };
  try {
    const r = await callLLM("The pilot plant is expected to start up next quarter.", cfg);
    return { ok: true, sample: r.text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
