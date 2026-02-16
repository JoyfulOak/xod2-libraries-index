# XOD2 Library Index

Mirror of the public XOD.io library catalog with optional, manually maintained discovery metadata for XOD2 search and filtering.

This repository is read-only with respect to XOD.io package content:
- Package ids and versions come from `https://xod.io/libs/`
- Extra metadata is defined locally in `index/overlay.json`
- Generated output is written to `index/index.json`
- Canonical install ids follow XOD library conventions: `owner/lib@latest` or `owner/lib@x.y.z` ([XOD docs](https://xod.io/docs/guide/using-libraries/))

## Layout

```
index/
  index.json
  overlay.json
  schema.md
tools/
  sync-xodio.js
  package.json
  package-lock.json
.github/workflows/
  sync.yml
```

## Usage

```bash
npm install --prefix tools
node tools/sync-xodio.js
```

## Output Contract

- Output file: `index/index.json`
- Stable sort: by `libraries[].id` ascending
- Overlay merge policy: overlay wins on conflicts
- Install ids in XOD2 remain canonical, e.g. `owner/lib@latest` and `owner/lib@x.y.z`
