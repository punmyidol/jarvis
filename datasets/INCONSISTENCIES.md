# Noter — flagged inconsistencies

Auto-generated. Spec (CLAUDE.md) vs. what's on disk / in Notion.

1. **CSV schema drift** — CLAUDE.md §3 mandates 11 columns incl. `due_date` and no
   `session_id`. On disk `datasets/2026-06-28.csv` still has `session_id` / no
   `due_date`; `2026-06-28-nobge.csv` also lacks `due_date`. This pipeline emits the
   current 11-column schema.
2. **`normalize_prompt.txt` missing** — listed in CLAUDE.md's Components table but no
   such file exists.
3. **Wrong paths in CLAUDE.md** — `embed_cluster.py` / `project_classify.py` /
   `project_fill.py` live in `scripts/`, not `datasets/from-22-jun/`.
4. **Dangling references** — `datasets/preds-qwen.gen.py` and `sort.ipynb` read
   `datasets/preds-qwen.csv` and `datasets/since22jun.csv`; neither exists.
5. **`profiles.csv` (3 people) vs `profiles/` (8 files)** — 5 unregistered (expected
   for non-project people, but noted).
6. **Classifier projects with no Notion project** — `mom's herbal tea` and `garden`
   are in the closed classifier set (and exist as vault folders) but have no page in
   the Notion Projects DB, so their tasks/events get an **empty project relation**
   (never auto-created).
