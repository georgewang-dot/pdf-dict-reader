#!/usr/bin/env python3
"""本地静态服务器，给阅读器提供页面、pdf.js 和词库分片，顺便把生词本和书架落盘。

用法：
    python3 serve.py [端口] [--no-open]

默认从 8731 开始，端口被占用就往后找。生词本存到 BASE_DIR/wordbook.json，
给每日提醒脚本读取。书架的 PDF 副本存 BASE_DIR/library/，元数据存 shelf.json。
--no-open 只起服务不开浏览器，给 .app 启动器用。
"""

import base64
import hashlib
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORDBOOK = os.path.join(BASE_DIR, "wordbook.json")
REMINDER = os.path.join(BASE_DIR, "reminder.py")
LIB_DIR = os.path.join(BASE_DIR, "library")
SHELF = os.path.join(BASE_DIR, "shelf.json")
SHELF_LOCK = threading.Lock()
LABEL = "local.pdfdictreader.review"
PLIST_DIR = os.path.expanduser("~/Library/LaunchAgents")
PLIST = os.path.join(PLIST_DIR, LABEL + ".plist")

PLIST_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python}</string>
    <string>{script}</string>
    <string>{base}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>{hour}</integer>
    <key>Minute</key><integer>{minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/pdfreader-reminder.log</string>
  <key>StandardErrorPath</key><string>/tmp/pdfreader-reminder.log</string>
</dict>
</plist>
"""


def run(cmd):
    """launchctl 失败时也可能返回 0，所以要把 stderr 也带回来判断。"""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as err:
        return None


def _failed(res):
    if res is None:
        return True
    if res.returncode != 0:
        return True
    return "failed" in (res.stderr or "").lower()


def reminder_status():
    if not os.path.exists(PLIST):
        return {"installed": False}
    hour = minute = None
    try:
        with open(PLIST, "r", encoding="utf-8") as f:
            text = f.read()
        import re

        h = re.search(r"<key>Hour</key>\s*<integer>(\d+)</integer>", text)
        m = re.search(r"<key>Minute</key>\s*<integer>(\d+)</integer>", text)
        hour = int(h.group(1)) if h else None
        minute = int(m.group(1)) if m else None
    except OSError:
        pass
    return {"installed": True, "hour": hour, "minute": minute}


def reminder_install(hour, minute, python=None):
    py = python or sys.executable or "/usr/bin/python3"
    os.makedirs(PLIST_DIR, exist_ok=True)
    with open(PLIST, "w", encoding="utf-8") as f:
        f.write(
            PLIST_TEMPLATE.format(
                label=LABEL, python=py, script=REMINDER, base=BASE_DIR, hour=hour, minute=minute
            )
        )
    run(["launchctl", "unload", PLIST])
    res = run(["launchctl", "load", PLIST])
    if _failed(res):
        # 新一点的 macOS 走 bootstrap
        uid = str(os.getuid())
        run(["launchctl", "bootout", "gui/" + uid + "/" + LABEL])
        res = run(["launchctl", "bootstrap", "gui/" + uid, PLIST])

    if _failed(res):
        # 装不上就把配置文件删掉，免得界面显示成已开启
        try:
            os.remove(PLIST)
        except OSError:
            pass
        detail = ((res.stderr if res else "") or "").strip().split("\n")[0]
        return {"ok": False, "error": detail or "launchctl 加载失败"}
    return {"ok": True, "hour": hour, "minute": minute}


def reminder_uninstall():
    uid = str(os.getuid())
    run(["launchctl", "unload", PLIST])
    run(["launchctl", "bootout", "gui/" + uid + "/" + LABEL])
    try:
        os.remove(PLIST)
    except OSError:
        pass
    return {"ok": True}


SYSTEM_PROMPT = (
    "你是资深中英科技译者，长期翻译 MIT Technology Review、The Economist 这类刊物。"
    "把用户给出的英文译成简体中文：忠实原文，句子完整通顺，符合中文科技媒体的表达习惯，不要翻译腔。"
    "专有名词、机构名、技术术语用通行中文译名，首次出现可在括号里附原文。"
    "只输出译文本身，不要解释、不要加引号、不要前后缀说明。"
)

MM_URL = "https://api.mymemory.translated.net/get"
TRANS_CACHE = {}


def http_json(url, payload=None, headers=None, timeout=25):
    data = None
    hdrs = {"User-Agent": "pdf-dict-reader/1.0"}
    if headers:
        hdrs.update(headers)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def split_chunks(text, size=400):
    parts = re.split(r"(?<=[.!?;:])\s+", str(text))
    out, buf = [], ""
    for p in parts:
        if buf and len(buf) + len(p) + 1 > size:
            out.append(buf)
            buf = p
        else:
            buf = buf + " " + p if buf else p
        while len(buf) > size:
            out.append(buf[:size])
            buf = buf[size:]
    if buf:
        out.append(buf)
    return out or [str(text)]


def translate_by_llm(text, cfg):
    base = str(cfg.get("baseUrl", "")).rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    data = http_json(
        url,
        payload={
            "model": cfg.get("model") or "gpt-4o-mini",
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
        },
        headers={"Authorization": "Bearer " + str(cfg.get("apiKey", ""))},
    )
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("大模型接口没返回内容")
    msg = choices[0].get("message") or {}
    out = (msg.get("content") or choices[0].get("text") or "").strip()
    if not out:
        raise RuntimeError("大模型接口返回了空译文")
    return out, "大模型 " + (cfg.get("model") or "自定义")


def translate_by_free(text):
    outs = []
    for part in split_chunks(text):
        url = MM_URL + "?" + urllib.parse.urlencode({"q": part, "langpair": "en|zh-CN"})
        data = http_json(url)
        got = (data.get("responseData") or {}).get("translatedText") or ""
        if not got:
            raise RuntimeError("在线翻译没给结果")
        outs.append(got.strip())
    return re.sub(r"，\s*$", "。", "".join(outs)).strip(), "MyMemory 在线翻译"


def do_translate(text, client_cfg=None):
    """服务器模式走这里：Python 出网比浏览器稳，还能缓存。"""
    text = str(text or "").strip()
    if not text:
        raise RuntimeError("没有要翻译的内容")
    if len(text) > 4000:
        text = text[:4000]

    cfg = dict(client_cfg or {})
    if not (cfg.get("provider") == "llm" and cfg.get("baseUrl") and cfg.get("apiKey")):
        cfg = {}
        cfg_path = os.path.join(BASE_DIR, "translate.json")
        if os.path.exists(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
            except (OSError, ValueError):
                cfg = {}

    cache_key = (cfg.get("model") or "free") + "|" + text
    if cache_key in TRANS_CACHE:
        return TRANS_CACHE[cache_key]

    if cfg.get("provider") == "llm" and cfg.get("baseUrl") and cfg.get("apiKey"):
        try:
            out, who = translate_by_llm(text, cfg)
            TRANS_CACHE[cache_key] = (out, who)
            return out, who
        except Exception:
            pass

    out, who = translate_by_free(text)
    TRANS_CACHE[cache_key] = (out, who)
    return out, who


def load_shelf():
    """书架元数据。读不到就当空书架，不给页面抛错。"""
    try:
        with open(SHELF, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return data


def save_shelf(books):
    with SHELF_LOCK:
        tmp = SHELF + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(books, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SHELF)


def sorted_shelf():
    books = load_shelf()
    return sorted(books, key=lambda b: b.get("lastRead") or "", reverse=True)


def decode_name(header):
    """书名走 base64 头，中文和空格都不会在 HTTP 头里出乱子。"""
    raw = header or ""
    if not raw:
        return "未命名.pdf"
    try:
        name = base64.b64decode(raw).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        name = raw
    name = os.path.basename(name.strip()) or "未命名.pdf"
    return name[:180]


def shelf_add(data, name):
    """存一份 PDF 副本进书架。同一份文件重复添加只更新元数据，进度不丢。"""
    os.makedirs(LIB_DIR, exist_ok=True)
    book_id = hashlib.md5(data).hexdigest()[:16]
    path = os.path.join(LIB_DIR, book_id + ".pdf")

    books = load_shelf()
    old = next((b for b in books if b["id"] == book_id), None)
    if old is None:
        books.append(
            {
                "id": book_id,
                "name": name,
                "size": len(data),
                "pageCount": 0,
                "page": 1,
                "scale": 0,
                "fitMode": True,
                "addedAt": time.strftime("%Y-%m-%d %H:%M"),
                "lastRead": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        )
        book = books[-1]
    else:
        old["name"] = name
        old["lastRead"] = time.strftime("%Y-%m-%d %H:%M:%S")
        book = old

    if not os.path.exists(path):
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)

    save_shelf(books)
    return book


def shelf_update(book_id, patch):
    books = load_shelf()
    for b in books:
        if b["id"] == book_id:
            for key in ("page", "pageCount", "scale", "fitMode"):
                if key in patch and patch[key] is not None:
                    b[key] = patch[key]
            b["lastRead"] = time.strftime("%Y-%m-%d %H:%M:%S")
            save_shelf(books)
            return b
    return None


def shelf_remove(book_id):
    books = load_shelf()
    left = [b for b in books if b["id"] != book_id]
    save_shelf(left)
    path = os.path.join(LIB_DIR, book_id + ".pdf")
    try:
        os.remove(path)
    except OSError:
        pass
    return {"ok": True}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".tsv": "text/plain; charset=utf-8",
        ".json": "application/json",
        ".wasm": "application/wasm",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _binary(self, data, ctype, filename=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            # 头只能走 latin-1，中文书名得按 RFC 5987 转义，否则整条响应会崩
            ascii_name = "".join(c if ord(c) < 128 else "_" for c in filename)
            self.send_header(
                "Content-Disposition",
                "inline; filename=\"%s\"; filename*=UTF-8''%s"
                % (ascii_name.replace('"', ""), urllib.parse.quote(filename)),
            )
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/books":
            return self._json({"ok": True, "books": sorted_shelf(), "storage": "server"})
        m = re.match(r"^/api/books/([A-Za-z0-9_-]+)/file$", path)
        if m:
            file_path = os.path.join(LIB_DIR, m.group(1) + ".pdf")
            if not os.path.exists(file_path):
                self.send_error(404, "书架里没有这本书")
                return
            with open(file_path, "rb") as f:
                data = f.read()
            book = next((b for b in load_shelf() if b["id"] == m.group(1)), None)
            return self._binary(
                data, "application/pdf", (book or {}).get("name", "book.pdf")
            )
        if path == "/api/reminder":
            return self._json(reminder_status())
        if path == "/api/wordbook":
            try:
                with open(WORDBOOK, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                data = []
            return self._json(data)
        return super().do_GET()

    def do_DELETE(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/reminder":
            return self._json(reminder_uninstall())
        m = re.match(r"^/api/books/([A-Za-z0-9_-]+)$", path)
        if m:
            return self._json(shelf_remove(m.group(1)))
        return self._json({"ok": False, "error": "没有这个接口"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/books":
            # 原始字节直接 POST 上来，书名放 base64 头里，省掉 multipart 的麻烦
            data = self._read_body()
            if not data:
                return self._json({"ok": False, "error": "没有收到文件内容"}, 400)
            name = decode_name(self.headers.get("X-Book-Name"))
            try:
                return self._json({"ok": True, "book": shelf_add(data, name)})
            except OSError as err:
                return self._json({"ok": False, "error": "存不进书架：" + str(err)}, 500)
        m = re.match(r"^/api/books/([A-Za-z0-9_-]+)$", path)
        if m:
            try:
                patch = json.loads(self._read_body().decode("utf-8"))
            except ValueError:
                return self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            book = shelf_update(m.group(1), patch)
            if not book:
                return self._json({"ok": False, "error": "书架里没有这本书"}, 404)
            return self._json({"ok": True, "book": book})
        if path == "/api/reminder":
            try:
                payload = json.loads(self._read_body().decode("utf-8"))
            except ValueError:
                return self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            hour = int(payload.get("hour", 9))
            minute = int(payload.get("minute", 0))
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                return self._json({"ok": False, "error": "时间不合法"}, 400)
            return self._json(reminder_install(hour, minute))
        if path == "/api/wordbook":
            try:
                payload = json.loads(self._read_body().decode("utf-8"))
            except ValueError:
                return self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            if not isinstance(payload, list):
                return self._json({"ok": False, "error": "期望一个词条数组"}, 400)
            try:
                with open(WORDBOOK, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
            except OSError as err:
                return self._json({"ok": False, "error": str(err)}, 500)
            return self._json({"ok": True, "count": len(payload)})
        if path == "/api/translate":
            try:
                payload = json.loads(self._read_body().decode("utf-8"))
            except ValueError:
                return self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            try:
                out, who = do_translate(payload.get("text", ""), payload.get("cfg"))
            except Exception as err:
                return self._json({"ok": False, "error": str(err), "offline": True})
            return self._json({"ok": True, "text": out, "provider": who})
        return self._json({"ok": False, "error": "没有这个接口"}, 404)


def main():
    args = [a for a in sys.argv[1:]]
    start = 8731
    for a in args:
        if a.isdigit():
            start = int(a)
    open_browser = "--no-open" not in args

    for port in range(start, start + 30):
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("找不到可用端口")

    url = "http://127.0.0.1:%d/" % port
    print("阅读器已启动：" + url)
    print("关闭这个窗口即可退出。", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
