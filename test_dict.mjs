// 词典冒烟测试：node test_dict.mjs
// 需要本地服务器已启动，默认 http://127.0.0.1:8731/

import { configure, lookup, normalize } from "./dict.js";

const base = process.argv[2] || "http://127.0.0.1:8731/";
configure(base);

const cases = [
  "serendipity",
  "running",
  "went",
  "batteries",
  "studies",
  "deforestation",
  "readily",
  "world's",
  "state-of-the-art",
  "——Triso——",
  "hyperscale",
  "AI",
];

let hit = 0;
for (const w of cases) {
  const t0 = Date.now();
  const res = await lookup(w);
  const ms = Date.now() - t0;
  if (!res) {
    console.log(`${w.padEnd(18)} -> null`);
    continue;
  }
  if (res.entry) hit++;
  const cn = (res.entry?.translation || "").split("\\n")[0] || "";
  const en = (res.entry?.definition || "").split("\\n")[0] || "";
  console.log(
    `${w.padEnd(18)} -> [${res.from}] ${res.entry?.word || "-"} ${ms}ms\n` +
      `                  中文: ${cn.slice(0, 60)}\n` +
      `                  英文: ${en.slice(0, 70)}`
  );
}

console.log(`\n命中 ${hit}/${cases.length}`);
