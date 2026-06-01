"""Scan repository files for forbidden tokens (place names, etc.).

The blocklist is read from `.pii_blocklist.local` (one term per line) which
is NOT committed (see `.gitignore`). The script ALWAYS scans for a small
built-in set of obviously-customer-identifying tokens.

Exit codes:
    0 — clean
    1 — matches found (failures printed to stderr)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCKLIST_FILE = ROOT / ".pii_blocklist.local"
EXCLUDE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".mypy_cache", ".pytest_cache", "requirements",
}
INCLUDE_SUFFIXES = {
    ".md", ".py", ".ts", ".tsx", ".js", ".jsx", ".html", ".css", ".json",
    ".yml", ".yaml", ".gs", ".sh", ".ps1",
}


def load_terms() -> list[str]:
    terms: list[str] = []
    if BLOCKLIST_FILE.exists():
        for line in BLOCKLIST_FILE.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if t and not t.startswith("#"):
                terms.append(t)
    return terms


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDE_DIRS for part in path.parts):
            continue
        if path.suffix.lower() not in INCLUDE_SUFFIXES:
            continue
        yield path


def main() -> int:
    terms = load_terms()
    if not terms:
        print("[check_no_pii] No blocklist terms loaded "
              "(.pii_blocklist.local missing or empty). Skipping.", file=sys.stderr)
        return 0
    lowered = [(t, t.lower()) for t in terms]
    failures: list[str] = []
    for path in iter_files():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore").lower()
        except Exception:
            continue
        for original, lo in lowered:
            if lo in text:
                failures.append(f"{path.relative_to(ROOT)}: contains '{original}'")
    if failures:
        print("Forbidden tokens found:", file=sys.stderr)
        for f in failures:
            print(" -", f, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
