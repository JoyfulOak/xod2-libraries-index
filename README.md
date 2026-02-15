# XOD2 Libraries Index Starter

This folder is a starter for the GitHub repo:

- `JoyfulOak/xod2-libraries-index`

## Files

- `index.json`: library catalog read by XOD2
- `libs/*.xodball.json`: raw xodball JSON files

## Required schema (per version)

- `version`: string like `v1.0.0`
- `xodballUrl`: raw GitHub URL to a `.xodball.json` file
- `dependencies`: array of strings in format `owner/lib@version`

## Quick publish steps

1. Copy these files into your `xod2-libraries-index` repo.
2. Replace `libs/joyfuloak-blink-tools-v1.0.0.xodball.json` with a real XOD export.
3. Keep the URL in `index.json` exactly in raw form:
   `https://raw.githubusercontent.com/JoyfulOak/xod2-libraries-index/main/...`
4. Commit and push.

## Verify

Open in browser:

- `https://raw.githubusercontent.com/JoyfulOak/xod2-libraries-index/main/index.json`
- the `xodballUrl` from your version record

Both must return valid JSON.
