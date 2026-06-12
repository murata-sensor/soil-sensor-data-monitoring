# Copilot Instructions

## Commit Message Rules

All commit messages **must** follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>
```

### Allowed types

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Build, CI, tooling, or config changes |
| `perf` | Performance improvement |
| `init` | Initial project setup (rare) |

### Rules

1. Type is **lowercase** — never `Fix`, `Feat`, `Improve`.
2. Scope is optional but encouraged: `feat(web):`, `fix(adapters):`, `docs(gas):`.
3. Summary is imperative mood, lowercase start, no period: `add X`, `fix Y`, not `Added X` or `Fixes Y.`
4. Keep the first line ≤ 72 characters.
5. Use a blank line + bullet list for details when needed.

### Examples

```
feat(adapters): add sensor_number field to NormalizedRow
fix: correct timezone-aware datetime comparison in ingest_ftp
docs: update README local dev instructions for Python 3.12 venv
chore: update .env.example for registry and proxy settings
test: add unit-suffix header test for remote-ftp adapter
refactor: rename location-specific references to generic names
```

### Anti-patterns (do NOT use)

```
Fix bug in parser          ← missing type prefix
Improve auth UX            ← missing type prefix
feat: Added new feature.   ← past tense + period
FEAT: do something         ← uppercase type
```
