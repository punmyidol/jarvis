#!/usr/bin/env python3
"""Classify each logs.csv entry with qwen2.5:32b via Ollama, write datasets/preds-qwen.csv.

Uses the category_prompt.txt template (single {content} slot) and constrains
output to the fixed label set {task, event, note}.
"""
import csv, json, os, urllib.request

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
PROMPT = open(os.path.join(ROOT, "category_prompt.txt"), encoding="utf-8").read()
IN = os.path.join(HERE, "dev.csv")
OUT = os.path.join(HERE, "preds-qwen.csv")
MODEL = "qwen2.5:32b"
VALID = {"task", "event", "note"}


def classify(content):
    prompt = PROMPT.replace("{content}", content)
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=json.dumps({
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0, "num_predict": 8},
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    raw = json.loads(urllib.request.urlopen(req, timeout=120).read())["response"]
    # take first valid label found in the response
    low = raw.strip().lower()
    for lab in VALID:
        if lab in low:
            return lab
    return "note"  # documented default


def main():
    rows = list(csv.DictReader(open(IN, newline="", encoding="utf-8-sig")))
    total = len(rows)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "content", "category"])
        w.writeheader()
        for i, r in enumerate(rows, 1):
            cat = classify(r.get("content", ""))
            w.writerow({"date": r.get("date", ""), "content": r.get("content", ""), "category": cat})
            f.flush()
            print(f"[{i}/{total}] {cat:5} | {r.get('content','')[:60]}")
    print(f"\nWrote {total} rows to {OUT}")


if __name__ == "__main__":
    main()
