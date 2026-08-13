"""Central configuration: paths, project maps, model, Notion ids, tunables.

Everything environment-specific lives here. Secrets come from the environment
(`ANTHROPIC_API_KEY`, `NOTION_TOKEN`); paths can be overridden via `NOTER_VAULT`.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# --- repo / vault paths -----------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
DATASETS = REPO_ROOT / "datasets"
ALL_CSV = DATASETS / "all.csv"          # single combined classified-rows CSV
PROJECT_PROMPT = REPO_ROOT / "project_prompt.txt"
CATEGORY_PROMPT = REPO_ROOT / "category_prompt.txt"

VAULT = Path(
    os.environ.get(
        "NOTER_VAULT",
        "/Users/punmyidol/Library/Mobile Documents/iCloud~md~obsidian/Documents/elvis",
    )
)
NOTER_DAILIES = VAULT / "Noter" / "dailies"   # timestamped text-editor output
IDEAS_FILE = VAULT / "ideas.md"               # the note+other "ideas" bucket

# --- feedback-loop datasets -------------------------------------------------
GOLD_CSV = DATASETS / "gold.csv"              # all approved rows (final labels)
CORRECTIONS_CSV = DATASETS / "corrections.csv"  # rows the user changed
INCONSISTENCIES_MD = DATASETS / "INCONSISTENCIES.md"

# --- person profiles ---------------------------------------------------------
PROFILES_DIR = DATASETS / "profiles"          # per-person <name>.md fact files
PROFILES_CSV = DATASETS / "profiles.csv"      # registry of project-associated people

# --- Claude model -----------------------------------------------------------
MODEL = os.environ.get("NOTER_MODEL", "claude-opus-4-8")
EFFORT = os.environ.get("NOTER_EFFORT", "high")

# --- classifier closed project set -----------------------------------------
PROJECTS = [
    "helmet detection",
    "elvis",
    "mom's herbal tea",
    "garden",
    "land deed tracker",
    "umich",
    "noter",
    "other",
]

# --- project label -> Obsidian vault folder ---------------------------------
# note+project goes to "<folder>/Notes.md"; note+other goes to IDEAS_FILE.
PROJECT_VAULT_FOLDER = {
    "helmet detection": "Helmet Detection System",
    "elvis": "Elvis",
    "mom's herbal tea": "Mom's Herbal Tea Project",
    "garden": "Automatic Water Gardening",
    "land deed tracker": "Notion Land Deed Tracker",
    "umich": "U-M",
    "noter": "Noter",
    # "other" -> IDEAS_FILE (handled in route.py)
}

# --- project label -> Notion Projects-DB page id (relation target) ----------
# 32-hex ids as returned by the Notion API; dashify() before use in relations.
# None => no existing Notion project => empty relation (flagged, never created).
PROJECT_NOTION_PAGE = {
    "helmet detection": "37326f5d5d6080d5852ccc104e5c543b",
    "elvis": "37826f5d5d6080f7b6bae1df3972c3b3",
    "land deed tracker": "37326f5d5d6080569016f3bef9a683ad",
    "umich": "38726f5d5d608017a182ce8a9984d1f5",
    "noter": "38d26f5d5d608075ad98c42ad06ffd30",
    "mom's herbal tea": None,
    "garden": None,
    "other": None,
}

# --- task routing: project 'other' -> "/todo" catch-all relation ------------
# Tasks (only) whose project is 'other' get a relation to this Projects-DB
# "/todo" page instead of an empty relation, so stray to-dos land in one bucket
# rather than floating unlinked. Non-task rows with 'other' stay unlinked.
TODO_NOTION_PAGE = "37526f5d5d608085a006e7af18a92f68"  # Projects DB "/todo" page

# --- Notion workspace ids (confirmed live) ----------------------------------
DASHBOARD_PAGE_ID = "37226f5d5d608018b9eaf0a4dad1f358"
TASKS_DATABASE_ID = "37326f5d5d608038b826c84e148a15a7"     # ✅ Tasks (existing)
PROJECTS_DATABASE_ID = "37326f5d5d6080b09688e91833d099d8"  # Projects (relation target)
TASKS_DATA_SOURCE = "37326f5d-5d60-80ad-a398-000b425007cb"
PROJECTS_DATA_SOURCE = "37326f5d-5d60-80a8-84f2-000bef6bf847"
NOTION_VERSION = os.environ.get("NOTION_VERSION", "2022-06-28")

# Property names on the existing Tasks DB (confirmed live)
TASK_TITLE_PROP = "Task"
TASK_DUE_PROP = "Due Date"
TASK_RELATION_PROP = "relation"
TASK_DONE_PROP = "Done"
# Ids of the DBs this pipeline creates, cached here after first creation.
NOTION_IDS_CACHE = Path(__file__).resolve().parent / "notion_ids.json"

# --- confidence gate --------------------------------------------------------
# STRICT_CONFIDENCE True => a row is HIGH (auto-file) only with a strong project
# signal (tag / override / gold precedent) and no flags and not the ideas bucket.
# Loosen to False as gold/corrections grow and you trust the classifier more.
STRICT_CONFIDENCE = os.environ.get("NOTER_STRICT_CONFIDENCE", "1") != "0"
FEWSHOT_MAX = int(os.environ.get("NOTER_FEWSHOT_MAX", "20"))

# --- secrets ----------------------------------------------------------------
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
# ANTHROPIC_API_KEY is read by the anthropic SDK directly.


def dashify(page_id: str) -> str:
    """32-hex Notion id -> canonical 8-4-4-4-12 UUID the REST API expects."""
    s = page_id.replace("-", "")
    if len(s) != 32:
        return page_id
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"


def load_notion_ids() -> dict:
    """Ids of the pipeline-created DBs (Events / Profiles / Noter Review)."""
    if NOTION_IDS_CACHE.exists():
        return json.loads(NOTION_IDS_CACHE.read_text())
    return {}


def save_notion_ids(ids: dict) -> None:
    NOTION_IDS_CACHE.write_text(json.dumps(ids, indent=2))
