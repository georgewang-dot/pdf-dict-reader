#!/bin/bash
cd "$(dirname "$0")" || exit 1

for PY in python3 python3.13 python3.12 python3.11 python3.10 python3.9 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$PY" >/dev/null 2>&1; then
    exec "$PY" serve.py
  fi
done

echo "没找到 Python 3。先去 https://www.python.org/downloads/ 装一个，再双击本文件。"
read -n 1 -s -r -p "按任意键关闭窗口"
exit 1
