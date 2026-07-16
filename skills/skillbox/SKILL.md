---
name: skillbox
description: Use when the user asks to use Skillbox or simply 'box'
---

# Skillbox

Use Skillbox to find task-specific skills on demand. Do not preload or guess skills; search, inspect, then fetch only what the task needs.

## Commands

```bash
skillbox search "<task>"          # natural-language search
skillbox list --category frontend # browse by category
skillbox info <skill>             # source, resources, token estimate
skillbox fetch <skill> --print    # read SKILL.md
skillbox fetch <skill> --to-temp  # full folder when resources exist
skillbox cleanup                  # remove temp fetches
```

If `info` or list output shows resources, prefer `--to-temp` and read only the referenced support files the fetched skill asks for.

## Registries

Resolution order is project, installed external, remote/default:

1. `.agents/skillbox.yaml`
2. `~/.config/skillbox/installed.yaml`
3. `~/.config/skillbox/config.yaml`
4. `hhushhas/skillbox-registry`

saved skills live in `~/code/skillbox-registry`.

## External Skills

Use `skillbox search "<query>" --web` only when skills.sh discovery is useful. External skills are unvetted; fetch by full id, skim before following, and promote anything durable into the shared registry.