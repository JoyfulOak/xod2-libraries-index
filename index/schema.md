# `index/index.json` Schema

Top-level shape:

```json
{
  "generatedAt": "ISO_TIMESTAMP",
  "libraries": [Library]
}
```

Library object:

```json
{
  "id": "owner/lib",
  "source": {
    "provider": "xod.io",
    "url": "https://xod.io/libs/owner/lib/"
  },
  "latest": "0.0.0",
  "versions": ["0.0.0", "0.0.1"],
  "summary": "Short description",
  "updatedAt": "YYYY-MM-DD",
  "license": "MIT",
  "tags": ["sensor", "display"],
  "interfaces": ["i2c", "spi"],
  "mcu": ["avr", "esp32"],
  "boardCompatibility": {
    "esp32dev": {
      "status": "working",
      "notes": "Validated on ESP32 core 3.3.x"
    },
    "nano": {
      "status": "broken",
      "notes": "Timer conflict"
    },
    "rp2040": {
      "status": "untested"
    }
  },
  "compatibilitySummary": {
    "workingBoards": ["esp32dev"],
    "brokenBoards": ["nano"],
    "untestedBoards": ["rp2040"]
  },
  "supportStatus": "experimental",
  "quality": {
    "hasExamples": true,
    "hasReadme": true,
    "maintainerVerified": false
  }
}
```

## Notes

- `generatedAt` is ISO-8601 UTC timestamp.
- `libraries` is sorted by `id` ascending.
- `updatedAt` may be `null` if unknown.
- `license` may be `null` if unknown.
- `tags`, `interfaces`, `mcu` default to empty arrays.
- `boardCompatibility` defaults to `{}`.
- `compatibilitySummary` is accepted from overlay or derived from `boardCompatibility`.
- `supportStatus` allowed values: `stable`, `experimental`, `deprecated`.
- `quality` defaults to `{}`.
- `quality` supports: `hasExamples`, `hasReadme`, `maintainerVerified`.
- Overlay merge is deep and overlay values win.
- Overlay format is backward compatible:
  - map keyed by `id` (current preferred format),
  - array of records,
  - or `{ "libraries": [] }`.
- Overlay keys from `index/overlay.json` are merged into matching `id` records and win on conflicts.
