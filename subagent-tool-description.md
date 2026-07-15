{{compact}}

By default, child runs have no turn, token, tool-call-count, or total-runtime budget and continue until completion or explicit interruption. Only set `turnBudget`, `toolBudget`, `timeoutMs`, or `maxRuntimeMs` when the user explicitly requests a limit.
