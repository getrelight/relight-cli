# Relight AI Skill

Teach your AI coding assistant how to use the Relight CLI. One file gives it full knowledge of every command, flag, workflow, and cloud provider.

## Install

### Claude Code

```bash
cp -r skill/dist/claude-code/relight ~/.claude/skills/
```

Or add to your project (version-controlled):

```bash
cp -r skill/dist/claude-code/relight .claude/skills/
```

Then use `/relight` or just ask Claude to deploy, manage databases, etc.

### Codex

```bash
cp -r skill/dist/codex/relight ~/.codex/skills/
```

Or add to your project:

```bash
cp -r skill/dist/codex/relight codex/skills/
```

### Cursor

```bash
cp skill/dist/cursor/relight.mdc .cursor/rules/
```

The rule is set to `alwaysApply: true` so Cursor always has Relight context.

### OpenCode

```bash
cp skill/dist/opencode/AGENTS.md .
```

Or set globally:

```bash
cp skill/dist/opencode/AGENTS.md ~/.config/opencode/
```

## What's included

The skill teaches the AI assistant:

- All 40+ CLI commands with flags and options
- Cloud-specific defaults (Cloudflare, GCP, AWS, Azure)
- Common workflows (deploy, database, domains, secrets, multi-cloud)
- Architecture (clouds vs services, `.relight.yaml` linking)
- Tips and gotchas

## Building from source

All formats are generated from a single `relight.md` source file:

```bash
cd skill && ./build.sh
```

Output goes to `skill/dist/`.
