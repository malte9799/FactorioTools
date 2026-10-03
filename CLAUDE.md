# Notes for Claude

## Pull requests and commits

- Every PR description includes the branch's preview link:
  `https://malte9799.github.io/FactorioTools/preview/<slug>/`, where `<slug>` is
  the branch name with `/` and any other character outside `A-Za-z0-9._-`
  turned into `-` (see `.github/scripts/pages-store.sh`). For example,
  `claude/foo-bar` → `https://malte9799.github.io/FactorioTools/preview/claude-foo-bar/`.
- Never put a Claude session link (`claude.ai/code/session_…`) in a commit
  message, PR description or GitHub comment.
