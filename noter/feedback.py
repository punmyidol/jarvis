"""The learning loop: turn past corrections into few-shot examples, deterministic
overrides, and a confidence score.

- `fewshot_block(kind)`  -> worked examples appended to the project/category prompt
  at call time (prompt files themselves are never edited).
- `Overrides.apply(rows)` -> deterministic person->project and content->label rules
  derived from `corrections.csv`, applied after the LLM and before staging.
- `score_confidence(row)` -> "high" (auto-file) or "low" (send to review).

On a fresh install (no gold/corrections yet) everything degrades gracefully: no
examples, no overrides, and confidence falls back to the tag/flag heuristics.
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import config

# alias words that count as an explicit project mention in a line
PROJECT_ALIASES = {
    "noter": ["noter"],
    "helmet detection": ["helmet detection", "helmet-detection", "helmet"],
    "elvis": ["elvis"],
    "mom's herbal tea": ["herbal tea", "mom tea", "mom's herbal tea"],
    "garden": ["garden"],
    "land deed tracker": ["land deed", "deed tracker", "land deed tracker"],
    "umich": ["umich", "u-m", "u of m", "michigan"],
}


def _norm(text: str) -> str:
    """Normalize a line for near-duplicate matching."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (text or "").lower())).strip()


GOLD_COLUMNS = ["date", "datetime", "content", "project", "people",
                "category", "group", "due_date"]
CORR_COLUMNS = ["date", "content", "people",
                "proposed_project", "final_project",
                "proposed_category", "final_category",
                "proposed_group", "final_group"]


def _append_row(path, columns: list[str], row: dict) -> None:
    import json

    new_file = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        if new_file:
            w.writeheader()
        out = {k: row.get(k, "") for k in columns}
        if "people" in out and isinstance(out["people"], list):
            out["people"] = json.dumps(out["people"], ensure_ascii=False)
        w.writerow(out)


def append_gold(row: dict) -> None:
    """Append a confirmed/approved row (final labels) to gold.csv."""
    _append_row(config.GOLD_CSV, GOLD_COLUMNS, row)


def append_correction(row: dict) -> None:
    """Append a user correction (proposed vs final) to corrections.csv."""
    _append_row(config.CORRECTIONS_CSV, CORR_COLUMNS, row)


def _read_csv(path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


# --------------------------------------------------------------------------- #
#  Few-shot examples                                                          #
# --------------------------------------------------------------------------- #
def _people_list(cell: str) -> list[str]:
    cell = (cell or "").strip()
    if not cell:
        return []
    try:
        import json

        v = json.loads(cell)
        if isinstance(v, list):
            return [str(x) for x in v]
    except Exception:
        pass
    return [p.strip() for p in re.split(r"[;,|]", cell) if p.strip()]


def fewshot_block(kind: str, limit: int | None = None) -> str:
    """Build a few-shot example block for `kind` in {'project','category'}.

    Prioritizes recent corrections (the cases the model got wrong), then fills
    with varied gold rows for coverage. Returns '' when there is nothing yet.
    """
    limit = limit or config.FEWSHOT_MAX
    corrections = _read_csv(config.CORRECTIONS_CSV)
    gold = _read_csv(config.GOLD_CSV)
    seen: set[str] = set()
    lines: list[str] = []

    def add_project(content, people, project):
        key = _norm(content)
        if not content or not project or key in seen:
            return
        seen.add(key)
        ppl = f"  (people: {', '.join(people)})" if people else ""
        lines.append(f'- "{content.strip()}"{ppl} -> project: {project}')

    def add_category(content, category, group):
        key = _norm(content)
        if not content or not category or key in seen:
            return
        seen.add(key)
        g = f", group: {group}" if group and group != "individual" else ""
        lines.append(f'- "{content.strip()}" -> category: {category}{g}')

    # corrections first (most informative), newest last in the file => reverse
    for r in reversed(corrections):
        if len(lines) >= limit:
            break
        if kind == "project":
            add_project(r.get("content", ""), _people_list(r.get("people", "")),
                        r.get("final_project", ""))
        else:
            add_category(r.get("content", ""), r.get("final_category", ""),
                         r.get("final_group", ""))

    # then a spread of gold rows for coverage across projects/categories
    bucket_field = "project" if kind == "project" else "category"
    by_bucket: dict[str, list[dict]] = defaultdict(list)
    for r in gold:
        by_bucket[r.get(bucket_field, "")].append(r)
    while len(lines) < limit and any(by_bucket.values()):
        for b in list(by_bucket):
            if not by_bucket[b] or len(lines) >= limit:
                continue
            r = by_bucket[b].pop()
            if kind == "project":
                add_project(r.get("content", ""), _people_list(r.get("people", "")),
                            r.get("project", ""))
            else:
                add_category(r.get("content", ""), r.get("category", ""),
                             r.get("group", ""))

    if not lines:
        return ""
    header = (
        "\nLEARNED EXAMPLES (from the user's past confirmed labels — follow these "
        "when a new line matches one closely):\n"
    )
    return header + "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
#  Deterministic overrides                                                    #
# --------------------------------------------------------------------------- #
@dataclass
class Overrides:
    person_project: dict[str, str]        # lower(person) -> project
    content_label: dict[str, dict]        # norm(content) -> {project?, category?}

    @classmethod
    def build(cls) -> "Overrides":
        corrections = _read_csv(config.CORRECTIONS_CSV)
        # person -> project only when the person's corrections agree
        votes: dict[str, Counter] = defaultdict(Counter)
        content_label: dict[str, dict] = {}
        for r in corrections:
            fin_proj = r.get("final_project", "")
            for person in _people_list(r.get("people", "")):
                if fin_proj and fin_proj != "other":
                    votes[person.lower()][fin_proj] += 1
            key = _norm(r.get("content", ""))
            if key:
                lab = {}
                if r.get("final_project"):
                    lab["project"] = r["final_project"]
                if r.get("final_category"):
                    lab["category"] = r["final_category"]
                if lab:
                    content_label[key] = lab
        person_project = {
            p: c.most_common(1)[0][0]
            for p, c in votes.items()
            if len(c) == 1 or c.most_common(1)[0][1] >= 2 * sum(c.values()) / 3
        }
        return cls(person_project, content_label)

    def apply(self, rows: list[dict]) -> list[dict]:
        """Mutate rows in place; append '(override)' evidence to `override`."""
        for row in rows:
            changed = []
            key = _norm(row.get("content", ""))
            lab = self.content_label.get(key)
            if lab:
                if lab.get("project") and lab["project"] != row.get("project"):
                    row["project"] = lab["project"]
                    changed.append(f"content->project={lab['project']}")
                if lab.get("category") and lab["category"] != row.get("category"):
                    row["category"] = lab["category"]
                    changed.append(f"content->category={lab['category']}")
            for person in row.get("people", []) or []:
                mapped = self.person_project.get(str(person).lower())
                if mapped and mapped != row.get("project") and not lab:
                    row["project"] = mapped
                    changed.append(f"{person}->project={mapped}")
            if changed:
                row["override"] = "; ".join(changed)
        return rows


# --------------------------------------------------------------------------- #
#  Confidence gate                                                            #
# --------------------------------------------------------------------------- #
def _gold_precedent() -> set[tuple[str, str]]:
    return {
        (_norm(r.get("content", "")), r.get("project", ""))
        for r in _read_csv(config.GOLD_CSV)
    }


def _has_tag_signal(content: str, project: str) -> bool:
    low = (content or "").lower()
    if "[[" in low:                      # any wikilink is a strong tag cue
        return True
    for alias in PROJECT_ALIASES.get(project, []):
        if alias in low:
            return True
    return False


def score_confidence(row: dict, precedent: set | None = None) -> str:
    """'high' => auto-file, 'low' => route to review."""
    precedent = _gold_precedent() if precedent is None else precedent
    flags = row.get("flags") or []
    project = row.get("project", "other")
    category = row.get("category", "note")

    # hard low: any uncertainty flag, the 'other' bucket, or the note+other ideas pile
    if flags:
        return "low"
    if project == "other":
        return "low"
    if category == "note" and project == "other":
        return "low"

    if not config.STRICT_CONFIDENCE:
        return "high"

    # strict: require a real project signal — tag, applied override, or gold precedent
    backed = (
        row.get("override")
        or _has_tag_signal(row.get("content", ""), project)
        or (_norm(row.get("content", "")), project) in precedent
    )
    return "high" if backed else "low"
