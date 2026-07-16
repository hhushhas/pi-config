# Reading Room

The Reading Room is the local triage page for generated spec companions and debriefs. Open `index.html` directly in a browser and keep it pinned if useful.

## Registration

Append exactly one `READING_ROOM.push({...});` line to `registry.js` for every generated artifact. Never rewrite or reorder prior entries. Use all fields shown below:

```js
READING_ROOM.push({ id: "<unique-slug>", type: "<spec|debrief>", title: "<title>", project: "<project>", path: "<absolute-html-path>", format: "<document|deck>", date: "YYYY-MM-DD", verdict: "<status>", risk: "<none|minor|major|blocker>", minutes: 5, summary: "<one sentence>" });
```

Read state and notes remain in browser localStorage and are not part of the shared setup.
