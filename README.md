# XOD2 Library Index

Mirror of the public XOD.io library catalog with optional, manually maintained discovery metadata for XOD2 search and filtering.

This repository is read-only with respect to XOD.io package content:
- Package ids and versions come from `https://xod.io/libs/`
- Extra metadata is defined locally in `index/overlay.json`
- Generated output is written to `index/index.json`
- Canonical install ids follow XOD library conventions: `owner/lib@latest` or `owner/lib@x.y.z` ([XOD docs](https://xod.io/docs/guide/using-libraries/))
- Optional artifact mirror output is written to `mirror/index.json` and `mirror/libs/**`

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
  mirror.yml
mirror/
  index.json
  state.json
  libs/
```

## Usage

```bash
npm install --prefix tools
node tools/sync-xodio.js
node tools/mirror-xodio.js
```

## Output Contract

- Output file: `index/index.json`
- Stable sort: by `libraries[].id` ascending
- Overlay merge policy: overlay wins on conflicts
- Install ids in XOD2 remain canonical, e.g. `owner/lib@latest` and `owner/lib@x.y.z`

## Incremental Mirror

- Workflow: `.github/workflows/mirror.yml`
- Script: `tools/mirror-xodio.js`
- Source of truth for candidate libraries: `index/index.json`
- First run: downloads available artifacts for all indexed library versions
- Next runs: only downloads new/missing versions; existing mirrored files are skipped
- Manifest/state:
  - `mirror/index.json` stores an artifact manifest
  - `mirror/state.json` stores keyed mirror state for incremental checks

Note: this mirror job does not change XOD2 install semantics by itself; canonical ids remain the same.
