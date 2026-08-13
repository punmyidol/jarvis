#!/usr/bin/env python3
"""Embedding project-classifier (leave-one-out k-NN).

Features: date + content only (project is the target; category/group ignored).
Content is embedded with bge-m3; date is carried but not informative for project,
so the prediction is content-driven. Evaluated leave-one-out on the same file:
each row's project is predicted from its nearest OTHER row(s), then scored vs the
true project. Does NOT modify the input file; writes predictions to a side file.

Usage: python project_classify.py [train.csv] [--k 1]
"""
import csv, json, math, collections, argparse, urllib.request, statistics, os

OLLAMA = "http://localhost:11434/api/embeddings"
MODEL = "bge-m3"


def embed(text):
    req = urllib.request.Request(
        OLLAMA, data=json.dumps({"model": MODEL, "prompt": text}).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read())["embedding"]


def cos(a, b):
    return sum(x * y for x, y in zip(a, b)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?",
                    default=os.path.join(os.path.dirname(__file__), "train.csv"))
    ap.add_argument("--k", type=int, default=1)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.path, newline="", encoding="utf-8-sig")))
    n = len(rows)
    vecs = [embed(r["content"]) for r in rows]          # features: content (date non-informative)
    truth = [(r.get("project") or "").strip() for r in rows]

    pred = []
    for i in range(n):                                   # leave-one-out
        dists = sorted(((1 - cos(vecs[i], vecs[j]), truth[j]) for j in range(n) if j != i),
                       key=lambda x: x[0])
        knn = [lab for _, lab in dists[:args.k]]
        pred.append(collections.Counter(knn).most_common(1)[0][0])

    # write predictions to a side file (never overwrite the input)
    out = os.path.join(os.path.dirname(args.path), "preds-project.csv")
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "content", "project_true", "project_pred"])
        w.writeheader()
        for i, r in enumerate(rows):
            w.writerow({"date": r["date"], "content": r["content"],
                        "project_true": truth[i], "project_pred": pred[i]})

    labels = sorted(set(truth))
    correct = sum(1 for t, p in zip(truth, pred) if t == p)
    print(f"k={args.k}  leave-one-out on {n} rows -> {out}")
    print(f"accuracy: {correct/n:.3f} ({correct}/{n})\n")
    print(f"{'project':18}{'P':>7}{'R':>7}{'F1':>7}{'support':>9}")
    f1s = []
    for lab in labels:
        tp = sum(1 for t, p in zip(truth, pred) if t == lab == p)
        fp = sum(1 for t, p in zip(truth, pred) if p == lab and t != lab)
        fn = sum(1 for t, p in zip(truth, pred) if t == lab and p != lab)
        P = tp / (tp + fp) if tp + fp else 0
        R = tp / (tp + fn) if tp + fn else 0
        F = 2 * P * R / (P + R) if P + R else 0
        f1s.append(F)
        print(f"{lab:18}{P:7.3f}{R:7.3f}{F:7.3f}{sum(1 for t in truth if t==lab):>9}")
    print(f"\nmacro-F1:    {statistics.mean(f1s):.3f}")
    # weighted-F1
    wf = sum(f * sum(1 for t in truth if t == lab) for f, lab in zip(f1s, labels)) / n
    print(f"weighted-F1: {wf:.3f}")

    print("\nconfusion (row=true, col=pred):")
    cm = collections.Counter(zip(truth, pred))
    sl = [l[:9] for l in labels]
    print(f"{'':18}" + "".join(f"{l:>11}" for l in sl))
    for t in labels:
        print(f"{t:18}" + "".join(f"{cm[(t,p)]:>11}" for p in labels))


if __name__ == "__main__":
    main()
