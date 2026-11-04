#!/usr/bin/env python3
"""把所有东西压进一个 HTML，双击就能用，不用起服务。

产出：外刊阅读器-单文件版.html

要点：
  pdf.js 原本用 type:"module" 的 worker，file:// 下起不来，这里改成经典 worker；
  pdf.mjs 结尾的 export 换成 const pdfjsLib = {...}，这样能塞进普通 module 脚本；
  词库分片逐个 gzip + base64 内嵌，用到哪个字母才解哪个。
"""

import base64
import gzip
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE_DIR, "外刊阅读器-单文件版.html")
PDFJS = os.path.join(BASE_DIR, "vendor", "pdfjs")
DICT_DIR = os.path.join(BASE_DIR, "data", "dict")


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def b64(data):
    return base64.b64encode(data).decode("ascii")


def strip_imports(src):
    """去掉 import 语句，内嵌时所有模块在同一个作用域里。多行 import 也要整段清掉。"""
    src = re.sub(
        r'^[ \t]*import\s+[\s\S]*?from\s+["\'][^"\']+["\'];?[ \t]*$',
        "",
        src,
        flags=re.M,
    )
    leftover = [l for l in src.split("\n") if re.match(r"^[ \t]*import\b", l)]
    if leftover:
        sys.exit("还有没清掉的 import：" + leftover[0][:80])
    return src


def pdfjs_main():
    src = read(os.path.join(PDFJS, "pdf.mjs"))

    # file:// 下只能起经典 worker，模块 worker 会被拦
    src, n = re.subn(
        r'new Worker\(workerSrc,\s*\{\s*type:\s*"module"\s*\}\)',
        "new Worker(workerSrc)",
        src,
    )
    if n != 1:
        sys.exit("没找到 worker 创建处，pdf.js 版本可能变了，n=%d" % n)

    # 结尾的 export 换成同作用域的常量
    m = None
    for m in re.finditer(r"^export \{([^}]*)\};\s*$", src, re.M):
        pass
    if not m:
        sys.exit("没找到 pdf.mjs 的 export 语句")
    pairs = []
    for part in m.group(1).split(","):
        part = part.strip()
        if not part:
            continue
        if " as " in part:
            local, _, exported = part.partition(" as ")
        else:
            local = exported = part
        pairs.append((exported.strip(), local.strip()))
    const_line = "const pdfjsLib = {%s};\n" % ", ".join(
        "%s: %s" % (e, l) for e, l in pairs
    )
    src = src[: m.start()] + const_line + src[m.end() :]
    return src


def pdfjs_worker():
    """worker 源码去掉 export，转 base64 内嵌。

    不 gzip：解压只能异步做，而 worker 要在页面脚本跑起来之前就位。
    """
    src = read(os.path.join(PDFJS, "pdf.worker.mjs"))
    src = re.sub(r"^[ \t]*export \{[^}]*\};[ \t]*$", "", src, flags=re.M)
    leftover = [l for l in src.split("\n") if re.match(r"^[ \t]*export\b", l)]
    if leftover:
        sys.exit("worker 里还有没清掉的 export：" + leftover[0][:80])
    return b64(src.encode("utf-8")), len(src)


def dict_shards():
    out = {}
    total_raw = 0
    total_b64 = 0
    for name in sorted(os.listdir(DICT_DIR)):
        if not name.endswith(".tsv"):
            continue
        raw = read_bytes(os.path.join(DICT_DIR, name))
        packed = gzip.compress(raw, 9)
        out[name[: -len(".tsv")]] = b64(packed)
        total_raw += len(raw)
        total_b64 += len(out[name[: -len(".tsv")]])
    return out, total_raw, total_b64


def main():
    css = read(os.path.join(BASE_DIR, "style.css"))
    html = read(os.path.join(BASE_DIR, "index.html"))

    m = re.search(r"<body>(.*)</body>", html, re.S)
    if not m:
        sys.exit("index.html 里没找到 body")
    body = m.group(1)
    # 外链脚本和样式都换成本地的，样式单独提到 head
    body = re.sub(r'<script type="module" src="app\.js"></script>\s*', "", body)

    shards, raw_size, b64_size = dict_shards()
    worker_b64, worker_size = pdfjs_worker()

    app_src = "\n".join(
        [
            strip_imports(read(os.path.join(BASE_DIR, f)))
            for f in (
                "dict.js",
                "speak.js",
                "translate.js",
                "wordbook.js",
                "shelf.js",
                "app.js",
            )
        ]
    )

    boot = """
<script>
(function () {
  var workerTag = document.getElementById("pdfWorkerSrc");
  var workerText = atob(workerTag.textContent.trim());
  workerTag.textContent = "";

  // 先把 worker 源码按普通脚本跑一遍，它会挂上 globalThis.pdfjsWorker。
  // 这样即使 Worker 起不来，pdf.js 也能退回主线程解析，file:// 下必定可用。
  var s = document.createElement("script");
  s.textContent = workerText;
  document.head.appendChild(s);

  // 同时备一个 blob 地址，能起真 worker 时就用真的
  window.__PDFJS_WORKER_SRC__ = URL.createObjectURL(
    new Blob([workerText], { type: "text/javascript" })
  );

  window.__DICT_SHARDS__ = JSON.parse(document.getElementById("dictShards").textContent);
  document.getElementById("dictShards").textContent = "";
})();
</script>
""".strip()

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>外刊阅读器 · 点词查义</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
{css}
</style>
</head>
<body>
{body}
<script type="text/plain" id="pdfWorkerSrc">{worker_b64}</script>
<script type="text/plain" id="dictShards">{json.dumps(shards, ensure_ascii=False)}</script>
{boot}
<script type="module">
{pdfjs_main()}
{app_src}
</script>
</body>
</html>
"""

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)

    size = os.path.getsize(OUT)
    print("产出：" + OUT)
    print("  词库 %d 个分片，原始 %.1f MB，内嵌 %.1f MB" % (len(shards), raw_size / 1048576, b64_size / 1048576))
    print("  pdf.js worker %.1f MB" % (worker_size / 1048576))
    print("  成品 %.1f MB" % (size / 1048576))


if __name__ == "__main__":
    main()
