#!/usr/bin/env python3
"""给 launchd 调用的每日提醒：读生词本，有到期的词就弹一条系统通知。

不写文件、不联网，跑完就退。没有到期词时静默退出。
"""

import json
import os
import subprocess
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORDBOOK = os.path.join(BASE_DIR, "wordbook.json")


def due_words():
    try:
        with open(WORDBOOK, "r", encoding="utf-8") as f:
            items = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(items, list):
        return []
    now = time.time() * 1000
    return [i for i in items if not i.get("mastered") and (i.get("due") or 0) <= now]


def notify(count):
    words = due_words()[:3]
    sample = "、".join(w.get("word", "") for w in words if w.get("word"))
    body = "有 %d 个生词到了复习时间" % count
    if sample:
        body += "：" + sample
    script = (
        'display notification "%s" with title "该复习生词了" subtitle "外刊阅读器"'
        % body.replace('"', "'")
    )
    try:
        subprocess.run(["osascript", "-e", script], timeout=20)
    except (OSError, subprocess.SubprocessError):
        pass


def main():
    # launchd 拉起来的时候提醒脚本可能不在项目目录，认一下参数
    if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
        path = os.path.join(sys.argv[1], "wordbook.json")
    else:
        path = WORDBOOK
    try:
        with open(path, "r", encoding="utf-8") as f:
            items = json.load(f)
    except (OSError, ValueError):
        print("读不到生词本：%s" % path)
        return 0
    if not isinstance(items, list):
        print("生词本格式不对")
        return 0

    now = time.time() * 1000
    due = [i for i in items if not i.get("mastered") and (i.get("due") or 0) <= now]
    print("到期 %d 个，共 %d 个" % (len(due), len(items)))
    if not due:
        return 0
    notify(len(due))
    return 0


if __name__ == "__main__":
    sys.exit(main())
