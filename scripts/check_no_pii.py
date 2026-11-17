"""Scan public repository files for credential patterns and optional private names.

Credential patterns are always checked. Optional organization-specific terms
come from the ignored `.pii_blocklist.local` file (one term per line).

Exit codes:
    0 — clean
    1 — matches found (failures printed to stderr)
"""

from __future__ import annotations

import re
import subprocess
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
    ".yml", ".yaml", ".gs", ".sh", ".ps1", ".cjs", ".mjs", ".txt", ".toml", ".csv",
    ".pem", ".key",
}
SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    "GitHub fine-grained token": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,255}\b"),
    "Google API key": re.compile(r"\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
    "Google OAuth client secret": re.compile(r"\bGOCSPX-[A-Za-z0-9_-]{28,}(?![A-Za-z0-9_-])"),
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
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    for name in sorted(set(result.stdout.split("\0")) - {""}):
        path = ROOT / name
        if not path.is_file():
            continue
        if any(part in EXCLUDE_DIRS for part in Path(name).parts):
            continue
        if path.suffix and path.suffix.lower() not in INCLUDE_SUFFIXES and not path.name.startswith(".env"):
            continue
        yield path


def find_issues(text: str, terms: list[str]) -> list[tuple[int, str]]:
    issues: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), 1):
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(line):
                issues.append((number, label))
        folded = line.casefold()
        for index, term in enumerate(terms, 1):
            if term.casefold() in folded:
                issues.append((number, f"custom restricted term #{index}"))
    return issues


def main() -> int:
    terms = load_terms()
    if not terms:
        print("[check_no_pii] Credential-pattern checks are enabled. "
              "Custom names/addresses are not configured; they cannot be checked automatically.")
    failures: list[str] = []
    for path in iter_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            failures.append(f"{path.relative_to(ROOT)}: could not inspect text")
            continue
        for number, label in find_issues(text, terms):
            failures.append(f"{path.relative_to(ROOT)}:{number}: {label}")
    if failures:
        print("Potential private information found (values are not logged):", file=sys.stderr)
        for f in failures:
            print(" -", f, file=sys.stderr)
        return 1
    print("[check_no_pii] No matches in the configured checks; this is not a guarantee of no private information.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
