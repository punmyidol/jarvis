"""Notion REST client (integration-token) for the unattended daily job.

Creates the Events / Profiles / Noter Review databases under the Dashboard page if
absent, resolves classifier projects to Projects-DB relations, and upserts rows
idempotently (Tasks/Events by title+date; Profiles by person with appended fact
bullets; Review by content+date).

Auth: set NOTION_TOKEN and share the Dashboard page with the integration. Uses the
stable `2022-06-28` API version (`/v1/databases`, `/v1/pages`, `/v1/blocks`).
"""
from __future__ import annotations

import requests

from . import config

API = "https://api.notion.com/v1"


class NotionError(RuntimeError):
    pass


class Notion:
    def __init__(self, token: str | None = None):
        self.token = token or config.NOTION_TOKEN
        if not self.token:
            raise NotionError("NOTION_TOKEN is not set")
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {self.token}",
            "Notion-Version": config.NOTION_VERSION,
            "Content-Type": "application/json",
        })
        self._ids = config.load_notion_ids()

    # -- low level ----------------------------------------------------------
    def _req(self, method: str, path: str, **body) -> dict:
        r = self.s.request(method, f"{API}{path}", json=body or None)
        if r.status_code >= 300:
            raise NotionError(f"{method} {path} -> {r.status_code}: {r.text[:400]}")
        return r.json() if r.text else {}

    def _paged(self, path: str, **body) -> list[dict]:
        out, cursor = [], None
        while True:
            payload = dict(body)
            if cursor:
                payload["start_cursor"] = cursor
            data = self._req("POST", path, **payload)
            out.extend(data.get("results", []))
            if not data.get("has_more"):
                return out
            cursor = data.get("next_cursor")

    # -- property builders --------------------------------------------------
    @staticmethod
    def _title(s): return {"title": [{"text": {"content": (s or "")[:2000]}}]}

    @staticmethod
    def _text(s): return {"rich_text": [{"text": {"content": (s or "")[:2000]}}]} if s else {"rich_text": []}

    @staticmethod
    def _date(s): return {"date": {"start": s}} if s else {"date": None}

    @staticmethod
    def _check(b): return {"checkbox": bool(b)}

    @staticmethod
    def _select(s): return {"select": {"name": s}} if s else {"select": None}

    def project_relation(self, label: str) -> dict:
        pid = config.PROJECT_NOTION_PAGE.get(label)
        return {"relation": [{"id": config.dashify(pid)}] if pid else []}

    def task_relation(self, label: str) -> dict:
        """Relation for a Task row: project=='other' -> the "/todo" catch-all
        page; every other label routes as usual (empty if it has no Notion page)."""
        if label == "other":
            return {"relation": [{"id": config.dashify(config.TODO_NOTION_PAGE)}]}
        return self.project_relation(label)

    # -- database bootstrap -------------------------------------------------
    def _find_database(self, title: str) -> str | None:
        for res in self._paged("/search", query=title,
                               filter={"value": "database", "property": "object"}):
            t = "".join(x.get("plain_text", "") for x in res.get("title", []))
            if t.strip() == title and res.get("object") == "database":
                return res["id"]
        return None

    def _create_database(self, title: str, properties: dict) -> str:
        data = self._req("POST", "/databases",
                         parent={"type": "page_id", "page_id": config.dashify(config.DASHBOARD_PAGE_ID)},
                         title=[{"type": "text", "text": {"content": title}}],
                         properties=properties)
        return data["id"]

    def _ensure(self, key: str, title: str, properties: dict) -> str:
        if self._ids.get(key):
            return self._ids[key]
        db_id = self._find_database(title) or self._create_database(title, properties)
        self._ids[key] = db_id
        config.save_notion_ids(self._ids)
        return db_id

    def _projects_relation_prop(self) -> dict:
        return {"relation": {"database_id": config.dashify(config.PROJECTS_DATABASE_ID),
                             "single_property": {}}}

    def ensure_events_db(self) -> str:
        return self._ensure("events", "Events", {
            "Name": {"title": {}},
            "Date": {"date": {}},
            "Project": self._projects_relation_prop(),
        })

    def ensure_review_db(self) -> str:
        return self._ensure("review", "Noter Review", {
            "Content": {"title": {}},
            "Category": {"select": {"options": [
                {"name": "task"}, {"name": "event"},
                {"name": "note"}, {"name": "remember"}]}},
            "Project": self._projects_relation_prop(),
            "Due": {"date": {}},
            "Group": {"rich_text": {}},
            "People": {"rich_text": {}},
            "Reason": {"rich_text": {}},
            "Date": {"date": {}},
            "Approved": {"checkbox": {}},
            "Committed": {"checkbox": {}},
        })

    # -- queries ------------------------------------------------------------
    def _query(self, database_id: str, filter_: dict | None = None) -> list[dict]:
        body = {"filter": filter_} if filter_ else {}
        return self._paged(f"/databases/{config.dashify(database_id)}/query", **body)

    def _find_page(self, database_id: str, title_prop: str, title: str,
                   date_prop: str | None = None, date_val: str | None = None) -> str | None:
        """Id of the first page whose title matches (and date-part matches, if given)."""
        hits = self._query(database_id, {"property": title_prop, "title": {"equals": title[:2000]}})
        if not date_prop or not date_val:
            return hits[0]["id"] if hits else None
        for h in hits:
            d = (h["properties"].get(date_prop, {}).get("date") or {})
            if (d.get("start") or "")[:10] == date_val[:10]:
                return h["id"]
        return None

    def _title_exists(self, database_id: str, title_prop: str, title: str,
                      date_prop: str | None = None, date_val: str | None = None) -> bool:
        return self._find_page(database_id, title_prop, title, date_prop, date_val) is not None

    # -- creators (idempotent) ---------------------------------------------
    def upsert_task(self, row: dict, bullets: list[str] | None = None) -> tuple[bool, int]:
        """Create a Task page unless one with same title (+due) exists.

        The page body carries the task's context: `task_context` (a URL/reference the
        LLM pulled off the line) first, then `bullets` (its group's supporting notes).
        On a dup, only the still-missing body bullets are appended (idempotent backfill).
        Returns (created?, n_body_bullets_written).
        """
        due = row.get("due_date") or ""
        # A clock time from the content extends the Due Date into a datetime start
        # (e.g. 2026-08-05T07:30:00); dedup compares only the date part, so a time
        # never spawns a duplicate. No date -> no time attaches.
        time = (row.get("due_time") or "") if due else ""
        start = f"{due}T{time}:00" if time else (due or "")
        # The category LLM emits a short action name (clean_content) for every task; the
        # raw line lives in `content` and its date in the Due Date property. Dedup on the
        # SAME string we write as the title.
        title = row.get("clean_content") or row["content"]
        # Body = the task's own context, then its supporting-note bullets.
        body = [t for t in ([row.get("task_context") or ""] + list(bullets or [])) if t]

        page_id = self._find_page(config.TASKS_DATABASE_ID, config.TASK_TITLE_PROP,
                                  title, config.TASK_DUE_PROP, start)
        if page_id:
            existing = self._block_texts(page_id) if body else set()
            new = [b for b in body if b not in existing]
            self._append_bullets(page_id, new)
            return False, len(new)
        self._req("POST", "/pages",
                  parent={"database_id": config.dashify(config.TASKS_DATABASE_ID)},
                  properties={
                      config.TASK_TITLE_PROP: self._title(title),
                      config.TASK_DUE_PROP: self._date(start or None),
                      config.TASK_RELATION_PROP: self.task_relation(row.get("project", "other")),
                      config.TASK_DONE_PROP: self._check(False),
                  },
                  children=self._bullet_blocks(body))
        return True, len(body)

    def upsert_event(self, row: dict) -> bool:
        db = self.ensure_events_db()
        # The event's OWN date (extracted by the category LLM into due_date) wins; only
        # if none was inferable do we fall back to the note's logging date. A clock time
        # attaches solely to a real event date, never to the logging-date fallback; dedup
        # compares only the date part (see _find_page), so a time never spawns a dup.
        due = row.get("due_date") or ""
        time = (row.get("due_time") or "") if due else ""
        when = (f"{due}T{time}:00" if time else due) or row.get("date") or ""
        if self._title_exists(db, "Name", row["content"], "Date", when):
            return False
        self._req("POST", "/pages",
                  parent={"database_id": config.dashify(db)},
                  properties={
                      "Name": self._title(row["content"]),
                      "Date": self._date(when or None),
                      "Project": self.project_relation(row.get("project", "other")),
                  })
        return True

    def upsert_shopping_item(self, row: dict) -> bool:
        """Create a Shopping List page unless one with the same title exists."""
        title = row.get("clean_content") or row["content"]
        if self._title_exists(config.SHOPPING_DATABASE_ID, config.SHOPPING_TITLE_PROP, title):
            return False
        self._req("POST", "/pages",
                  parent={"database_id": config.dashify(config.SHOPPING_DATABASE_ID)},
                  properties={
                      config.SHOPPING_TITLE_PROP: self._title(title),
                      config.SHOPPING_CHECK_PROP: self._check(False),
                  })
        return True

    def shopping_items(self) -> list[dict]:
        """All Shopping List rows as {"name": str, "checked": bool}."""
        pages = self._query(config.SHOPPING_DATABASE_ID)
        out = []
        for p in pages:
            pr = p["properties"]
            name = _plain(pr.get(config.SHOPPING_TITLE_PROP, {}).get("title", []))
            checked = bool(pr.get(config.SHOPPING_CHECK_PROP, {}).get("checkbox"))
            out.append({"name": name, "checked": checked})
        return out

    def _block_texts(self, page_id: str) -> set[str]:
        data = self._req("GET", f"/blocks/{config.dashify(page_id)}/children?page_size=100")
        out = set()
        for b in data.get("results", []):
            if b.get("type") == "bulleted_list_item":
                out.add("".join(t.get("plain_text", "")
                                for t in b["bulleted_list_item"].get("rich_text", [])))
        return out

    @staticmethod
    def _bullet_blocks(texts: list[str]) -> list[dict]:
        return [{"object": "block", "type": "bulleted_list_item",
                 "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": t[:2000]}}]}}
                for t in texts if t]

    def _append_bullets(self, page_id: str, texts: list[str]) -> None:
        children = self._bullet_blocks(texts)
        if children:
            self._req("PATCH", f"/blocks/{config.dashify(page_id)}/children", children=children)

    # -- review staging + commit -------------------------------------------
    def stage_review(self, row: dict) -> bool:
        db = self.ensure_review_db()
        if self._title_exists(db, "Content", row["content"], "Date", row.get("date")):
            return False
        people = ", ".join(row.get("people", []) or [])
        self._req("POST", "/pages",
                  parent={"database_id": config.dashify(db)},
                  properties={
                      "Content": self._title(row["content"]),
                      "Category": self._select(row.get("category", "note")),
                      "Project": self.project_relation(row.get("project", "other")),
                      "Due": self._date(row.get("due_date") or None),
                      "Group": self._text(row.get("group", "")),
                      "People": self._text(people),
                      "Reason": self._text(row.get("reason", "")),
                      "Date": self._date(row.get("date") or None),
                      "Approved": self._check(False),
                      "Committed": self._check(False),
                  })
        return True

    def approved_review_rows(self) -> list[dict]:
        """Return Approved && !Committed review rows as plain dicts (+ _page_id)."""
        db = self.ensure_review_db()
        pages = self._query(db, {"and": [
            {"property": "Approved", "checkbox": {"equals": True}},
            {"property": "Committed", "checkbox": {"equals": False}}]})
        rows = []
        for p in pages:
            pr = p["properties"]
            rel = pr.get("Project", {}).get("relation", [])
            rows.append({
                "_page_id": p["id"],
                "content": _plain(pr.get("Content", {}).get("title", [])),
                "category": (pr.get("Category", {}).get("select") or {}).get("name", "note"),
                "project_page_id": rel[0]["id"] if rel else None,
                "due_date": ((pr.get("Due", {}).get("date") or {}).get("start") or ""),
                "group": _plain(pr.get("Group", {}).get("rich_text", [])),
                "people": [s.strip() for s in _plain(pr.get("People", {}).get("rich_text", [])).split(",") if s.strip()],
                "date": ((pr.get("Date", {}).get("date") or {}).get("start") or ""),
            })
        return rows

    def mark_committed(self, page_id: str) -> None:
        self._req("PATCH", f"/pages/{config.dashify(page_id)}",
                  properties={"Committed": self._check(True)})


def _plain(rich: list) -> str:
    return "".join(t.get("plain_text", "") for t in rich)


# map a Notion project page id back to a classifier label (for committed review rows)
def label_for_page(page_id: str | None) -> str:
    if not page_id:
        return "other"
    norm = (page_id or "").replace("-", "")
    for label, pid in config.PROJECT_NOTION_PAGE.items():
        if pid and pid.replace("-", "") == norm:
            return label
    return "other"
