#!/usr/bin/env python3
"""把 ECDICT 词库 CSV 切成前端按需加载的分片文本。

产出目录 data/dict/：
  words-a.tsv ... words-z.tsv, words-_.tsv   单词分片，按首字母分
  forms-a.tsv ... forms-z.tsv, forms-_.tsv   词形还原分片，复数、时态等变形映射回原形

每个分片都是 TSV，字段里的换行统一转义成字面 \\n，方便前端按行切分。
前端只需加载被查单词首字母对应的分片，全量词库不必一次进内存。

用法：
  python3 build_dict.py [--csv 路径] [--out 目录]
"""

import argparse
import csv
import os
import string
import sys

csv.field_size_limit(10 * 1024 * 1024)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CSV = os.path.join(HERE, "_data", "ecdict.csv")
DEFAULT_LEMMA = os.path.join(HERE, "_data", "lemma.en.txt")
DEFAULT_OUT = os.path.join(HERE, "data", "dict")

LETTERS = list(string.ascii_lowercase)
EXCHANGE_KEYS = ("p", "d", "i", "3", "r", "t", "s", "0", "1", "f", "a", "n", "v")
MAX_DEF = 700
MAX_TRANS = 900
MAX_PHONETIC = 120


def shard_key(word):
    c = word[0].lower()
    return c if c in LETTERS else "_"


def clean(text, limit):
    """压掉真正的换行和制表符，保留字面 \\n 作为释义分隔符，再截断长度。"""
    if not text:
        return ""
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit]


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def parse_exchange(exchange):
    forms = []
    if not exchange:
        return forms
    for part in exchange.split("/"):
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        if key not in EXCHANGE_KEYS:
            continue
        for w in value.split(","):
            w = w.strip().lower()
            if w:
                forms.append(w)
    return forms


def build(csv_path, lemma_path, out_dir):
    if not os.path.exists(csv_path):
        sys.exit("找不到词库 CSV：%s" % csv_path)

    if os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, name))
    os.makedirs(out_dir, exist_ok=True)

    word_files = {}
    for key in LETTERS + ["_"]:
        word_files[key] = open(os.path.join(out_dir, "words-%s.tsv" % key), "w", encoding="utf-8")

    seen = set()
    forms = {}
    count = 0

    with open(csv_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for rec in reader:
            word = (rec.get("word") or "").strip()
            if not word:
                continue
            low = word.lower().replace("\\", " ")
            low = " ".join(low.split())
            if not low or low in seen:
                continue
            seen.add(low)

            row = "\t".join(
                [
                    low,
                    clean(rec.get("phonetic"), MAX_PHONETIC),
                    clean(rec.get("definition"), MAX_DEF),
                    clean(rec.get("translation"), MAX_TRANS),
                    clean(rec.get("pos"), 40),
                    str(to_int(rec.get("collins"))),
                    str(to_int(rec.get("oxford"))),
                    str(to_int(rec.get("frq"))),
                    clean(rec.get("tag"), 60),
                ]
            )
            word_files[shard_key(low)].write(row + "\n")
            count += 1

            for f in parse_exchange(rec.get("exchange")):
                if f != low:
                    forms[f] = low

    for fh in word_files.values():
        fh.close()

    # 词形还原表，lemma.en.txt 每行形如「原形/词频 -> 变形1,变形2」
    if os.path.exists(lemma_path):
        with open(lemma_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith(";") or "->" not in line:
                    continue
                left, _, right = line.partition("->")
                base = left.split("/")[0].strip().lower()
                if not base:
                    continue
                for v in right.split(","):
                    v = v.strip().lower()
                    if v and v != base:
                        forms[v] = base

    form_files = {}
    for key in LETTERS + ["_"]:
        form_files[key] = open(os.path.join(out_dir, "forms-%s.tsv" % key), "w", encoding="utf-8")
    for form, base in forms.items():
        if not form or form not in seen and False:
            pass
        form_files[shard_key(form)].write("%s\t%s\n" % (form, base))
    for fh in form_files.values():
        fh.close()

    total = 0
    biggest = ("", 0)
    for name in sorted(os.listdir(out_dir)):
        size = os.path.getsize(os.path.join(out_dir, name))
        total += size
        if size > biggest[1]:
            biggest = (name, size)
    print("词条: %d 条，词形映射: %d 条" % (count, len(forms)))
    print("分片目录: %s" % out_dir)
    print("总大小: %.1f MB，最大分片: %s %.1f MB" % (total / 1048576, biggest[0], biggest[1] / 1048576))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--lemma", default=DEFAULT_LEMMA)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    build(args.csv, args.lemma, args.out)


if __name__ == "__main__":
    main()
