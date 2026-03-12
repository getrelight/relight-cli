#!/bin/bash
# Build skill files for all AI coding tools from the shared relight.md source.
# Output goes to skill/dist/ — each subdirectory is ready to copy into a project.

set -e
cd "$(dirname "$0")"

BODY="$(cat relight.md)"
DESCRIPTION="Deploy and manage Docker containers across clouds with the Relight CLI. Use when the user wants to deploy apps, manage cloud providers, configure databases, set environment variables, manage domains, or work with multi-cloud infrastructure using Relight."

rm -rf dist
mkdir -p dist/claude-code/relight dist/codex/relight dist/cursor dist/opencode

# --- Claude Code (.claude/skills/relight/SKILL.md) ---
cat > dist/claude-code/relight/SKILL.md << FRONTMATTER
---
name: relight
description: ${DESCRIPTION}
argument-hint: [command or question]
---

${BODY}
FRONTMATTER

# --- Codex (codex/skills/relight/SKILL.md — same Agent Skills spec) ---
cat > dist/codex/relight/SKILL.md << FRONTMATTER
---
name: relight
description: ${DESCRIPTION}
---

${BODY}
FRONTMATTER

# --- Cursor (.cursor/rules/relight.mdc) ---
cat > dist/cursor/relight.mdc << FRONTMATTER
---
description: ${DESCRIPTION}
globs:
alwaysApply: true
---

${BODY}
FRONTMATTER

# --- OpenCode (AGENTS.md — placed in project root or ~/.config/opencode/) ---
cat > dist/opencode/AGENTS.md << EOF
${BODY}
EOF

echo "Built skill files in skill/dist/"
echo ""
echo "  Claude Code:  dist/claude-code/relight/SKILL.md"
echo "  Codex:        dist/codex/relight/SKILL.md"
echo "  Cursor:       dist/cursor/relight.mdc"
echo "  OpenCode:     dist/opencode/AGENTS.md"
