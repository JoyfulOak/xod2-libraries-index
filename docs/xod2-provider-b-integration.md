# XOD2 Provider B Integration Notes

This workspace does not include XOD2 application source code, so Part D cannot be applied directly here.  
Use this checklist and patch plan in the XOD2 repo.

## Provider B URL

`https://raw.githubusercontent.com/JoyfulOak/xod2-library-index/main/index/index.json`

## Required Behavior

- Keep Provider A (XOD.io) as install source of truth.
- Treat Provider B as read-only discovery metadata.
- Cache Provider B JSON with TTL 24h.
- Fallback order:
  1. Fresh network data
  2. Cached data
  3. Provider A only (graceful degradation)

## Data Additions

Add enhanced discovery fields to local library model:

- `tags: string[]`
- `interfaces: string[]`
- `mcu: string[]`
- `quality?: { hasExamples?: boolean; hasReadme?: boolean }`
- `updatedAt?: string | null`
- `source.provider` should display `xod.io` in UI

## Search + Filter

Search tokens should include:

- `id`
- `summary`
- `tags`
- `interfaces`
- `mcu`

Add multi-select filters:

- tags
- interfaces
- mcu

Sort options:

- default: `id` ascending
- optional: `updatedAt` descending (nulls last)

## Install Path

Do not change install transport.

- default: `owner/lib@latest`
- if selected version: `owner/lib@x.y.z`

## UI Labels

Per row:

- main text: `owner/lib`
- subtext: summary
- badges:
  - `Enhanced` if any of `tags/interfaces/mcu` non-empty
  - `XOD.io` always from source provider

