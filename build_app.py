#!/usr/bin/env python3
"""生成 macOS 应用包，并装到「应用程序」文件夹里。

用法：
    python3 build_app.py            # 生成并尝试安装到 /Applications
    python3 build_app.py --no-install

做的事：
  1. 画一个应用图标（蓝底白字「译」加一条红色下划线），转成 .icns
  2. 组装 外刊阅读器.app，启动脚本里把项目绝对路径写死，
     这样拷到 /Applications 之后照样找得到家
  3. 拷进 /Applications，写不进去就退回 ~/Applications
"""

import os
import shutil
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(BASE_DIR, "assets")
APP_NAME = "外刊阅读器.app"
ICONSET = os.path.join(ASSETS, "AppIcon.iconset")
ICNS = os.path.join(ASSETS, "AppIcon.icns")

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]

LAUNCHER = r'''#!/bin/bash
# 双击启动外刊阅读器：后台起本地服务，再用 Chrome 的应用窗口打开。
# 不开终端，不留窗口；服务已经在跑就直接开窗口。
set -u

APP_DIR="__APP_DIR__"
PORT=8731
LOG="/tmp/pdfreader-server.log"

alert() {
  osascript -e "display alert \"外刊阅读器\" message \"$1\" buttons {\"好\"} default button 1" >/dev/null 2>&1
}

# 环境里可能配了 HTTP 代理，localhost 也会被代理掉，这里绕开并且只认 200
up() {
  local code
  code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null)"
  [ "$code" = "200" ]
}

open_url() {
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="http://127.0.0.1:$PORT/"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -na "Microsoft Edge" --args --app="http://127.0.0.1:$PORT/"
  else
    open "http://127.0.0.1:$PORT/"
  fi
}

if up; then
  open_url
  exit 0
fi

PY=""
for c in python3 /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  alert "这台机器上没找到 python3，装一个再来。"
  exit 1
fi

cd "$APP_DIR" || exit 1
nohup "$PY" "$APP_DIR/serve.py" "$PORT" --no-open >"$LOG" 2>&1 &

for _ in $(seq 1 60); do
  if up; then
    open_url
    exit 0
  fi
  sleep 0.3
done

alert "服务没起来，看一下 $LOG"
exit 1
'''

INFO_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>外刊阅读器</string>
  <key>CFBundleDisplayName</key>
  <string>外刊阅读器</string>
  <key>CFBundleIdentifier</key>
  <string>local.pdfdictreader</string>
  <key>CFBundleVersion</key>
  <string>1.1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.1</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
"""


def pick_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_icon(size):
    from PIL import Image, ImageDraw, ImageFont

    top = (56, 138, 247)
    bottom = (18, 74, 152)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / max(1, size - 1)))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.2237), fill=255
    )
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    font_path = pick_font()
    glyph = "译"
    if font_path:
        fsize = int(size * 0.46)
        try:
            font = ImageFont.truetype(font_path, fsize)
        except OSError:
            font = None
    else:
        font = None

    if font:
        box = d.textbbox((0, 0), glyph, font=font)
        w = box[2] - box[0]
        h = box[3] - box[1]
        d.text(
            ((size - w) / 2 - box[0], size * 0.46 - h / 2 - box[1]),
            glyph,
            font=font,
            fill=(255, 255, 255, 255),
        )
    else:
        # 没有中文字体就画个方块，不至于图标空白
        d.rectangle(
            [size * 0.3, size * 0.28, size * 0.7, size * 0.62], fill=(255, 255, 255, 255)
        )

    # 红色下划线，呼应"收录的词加下划线"
    bar_w = int(size * 0.34)
    bar_h = max(2, int(size * 0.055))
    x0 = (size - bar_w) // 2
    y0 = int(size * 0.72)
    d.rounded_rectangle(
        [x0, y0, x0 + bar_w, y0 + bar_h], radius=bar_h // 2, fill=(232, 62, 48, 255)
    )
    return img


def build_icns():
    from PIL import Image

    if os.path.isdir(ICONSET):
        shutil.rmtree(ICONSET)
    os.makedirs(ICONSET, exist_ok=True)

    pairs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, px in pairs:
        draw_icon(px).save(os.path.join(ICONSET, name))

    if os.path.exists(ICNS):
        os.remove(ICNS)
    res = subprocess.run(
        ["iconutil", "-c", "icns", ICONSET, "-o", ICNS],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0 or not os.path.exists(ICNS):
        sys.exit("图标转换失败：" + (res.stderr or "").strip())
    return ICNS


def build_bundle():
    app = os.path.join(BASE_DIR, APP_NAME)
    macos = os.path.join(app, "Contents", "MacOS")
    resources = os.path.join(app, "Contents", "Resources")
    os.makedirs(macos, exist_ok=True)
    os.makedirs(resources, exist_ok=True)

    with open(os.path.join(app, "Contents", "Info.plist"), "w", encoding="utf-8") as f:
        f.write(INFO_PLIST)

    with open(os.path.join(macos, "launcher"), "w", encoding="utf-8") as f:
        f.write(LAUNCHER.replace("__APP_DIR__", BASE_DIR))
    os.chmod(os.path.join(macos, "launcher"), 0o755)

    shutil.copy(ICNS, os.path.join(resources, "AppIcon.icns"))
    return app


def install(app):
    for target_dir in ("/Applications", os.path.expanduser("~/Applications")):
        if not os.path.isdir(target_dir):
            try:
                os.makedirs(target_dir, exist_ok=True)
            except OSError:
                continue
        dst = os.path.join(target_dir, APP_NAME)
        try:
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(app, dst)
            return dst
        except OSError:
            continue
    return None


def main():
    do_install = "--no-install" not in sys.argv
    print("画图标…")
    build_icns()
    print("组装应用包…")
    app = build_bundle()
    print("  项目里的：", app)
    if do_install:
        dst = install(app)
        if dst:
            print("  已安装到：", dst)
        else:
            print("  没能写进应用程序文件夹，手动把项目里的 外刊阅读器.app 拖过去即可")
    print("完成。双击应用图标就能打开阅读器。")


if __name__ == "__main__":
    main()
