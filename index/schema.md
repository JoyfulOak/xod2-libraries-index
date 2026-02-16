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
  "quality": {
    "hasExamples": true,
    "hasReadme": true
  }
}
```

## Notes

- `generatedAt` is ISO-8601 UTC timestamp.
- `libraries` is sorted by `id` ascending.
- `updatedAt` may be `null` if unknown.
- `license` may be `null` if unknown.
- `tags`, `interfaces`, `mcu` default to empty arrays.
- `quality` defaults to `{}`.
- Overlay keys from `index/overlay.json` are merged into matching `id` records and win on conflicts.
