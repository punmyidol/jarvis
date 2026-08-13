"""noter — daily idea-dump classification + routing pipeline.

Reads the text-editor's timestamped daily note, classifies each line (project +
category/group/due_date) with Claude, then routes each entry to its destination:
tasks/events -> Notion databases, remember+person -> local profiles.csv/profiles/*.md,
project notes -> the Obsidian vault, loose ideas -> ideas.md. Confident rows auto-file;
uncertain rows wait in a Notion review database whose edits feed a learning loop.
"""

__version__ = "0.1.0"
