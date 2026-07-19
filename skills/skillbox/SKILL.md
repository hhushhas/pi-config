---
name: skillbox
description: Use when the user asks to use Skillbox or simply 'box'
---

# Skillbox

Use Skillbox to find task-specific skills on demand. Do not preload or guess skills; search, inspect, then fetch only what the task needs.

## Commands

```bash
skillbox list                         # browse all trusted skills
skillbox list --category frontend     # browse a trusted category
skillbox search "<task>"               # natural-language trusted search
skillbox info <skill>                  # source, resources, token estimate
skillbox fetch <skill>                 # print SKILL.md and prepare support files
skillbox search "<task>" --web         # search unverified skills.sh results
skillbox cleanup                       # remove temp fetches
```

`fetch` prints `SKILL.md` directly. When a skill has support files, it also copies the full folder to Skillbox's temp directory and reports the file counts and exact path; read only the support files that `SKILL.md` asks for.

## Registries

Resolution order is project, global local, installed external, then configured remote:

1. `.agents/skillbox.yaml`
2. `~/.skillbox/skillbox.yaml`
3. `~/.skillbox/installed.yaml`
4. Remotes in `~/.skillbox/config.yaml`

Shared registry skills live in `~/code/skillbox-registry`.

## External Skills

`--web` is explicit because skills.sh content is unvetted. Use it only when public discovery is useful, fetch a result by its full `owner/repo/skill` id, skim the returned instructions before following them, and promote anything durable into a trusted registry.
