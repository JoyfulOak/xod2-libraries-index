#!/usr/bin/env node

const fs = require("fs").promises;
const path = require("path");

const XOD_LIBS_BASE_URL = "https://xod.io/libs/";
const OUTPUT_PATH = path.resolve(__dirname, "..", "index", "index.json");
const OVERLAY_PATH = path.resolve(__dirname, "..", "index", "overlay.json");
const REQUEST_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_500;

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^\/+|\/+$/g, "");
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(cleaned) ? cleaned.toLowerCase() : null;
}

function uniqStrings(values) {
  return [...new Set(values.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))];
}

function semverCompareDesc(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = String(v).split("-");
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pb.parts[i] - pa.parts[i];
  }
  if (!pa.pre && pb.pre) return -1;
  if (pa.pre && !pb.pre) return 1;
  return pa.pre.localeCompare(pb.pre);
}

function extractVersionsFromText(text, id) {
  const versions = [];
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specificPattern = new RegExp(`${escaped}@([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)`, "gi");
  const genericPattern = /@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g;

  for (const m of text.matchAll(specificPattern)) versions.push(m[1]);
  if (versions.length === 0) {
    for (const m of text.matchAll(genericPattern)) versions.push(m[1]);
  }
  return uniqStrings(versions).sort(semverCompareDesc);
}

function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return m ? m[1].trim() : "";
}

function extractUpdatedAt(html) {
  const direct = html.match(/\b(20\d{2}-\d{2}-\d{2})\b/g);
  if (!direct || direct.length === 0) return null;
  return direct.sort().at(-1) || null;
}

function extractLicense(html) {
  const byLabel = html.match(/license[^a-z0-9]+([A-Za-z0-9.\-+ ]{2,40})/i);
  if (byLabel) return byLabel[1].trim();
  const known = html.match(/\b(MIT|BSD(?:-?\d-Clause)?|Apache(?:-?2\.0)?|GPL(?:-?\d(?:\.\d)?)?|LGPL(?:-?\d(?:\.\d)?)?|MPL(?:-?2\.0)?)\b/i);
  return known ? known[1].trim() : null;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "xod2-library-index-sync/1.0 (+https://github.com/JoyfulOak/xod2-library-index)"
      }
    });
    if (!response.ok) {
      return { ok: false, status: response.status, url };
    }
    const text = await response.text();
    return { ok: true, status: response.status, url, text };
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtmlWithRetry(url, retries = MAX_FETCH_RETRIES) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    attempt += 1;
    try {
      const result = await fetchHtml(url);
      if (result.ok || !RETRYABLE_STATUS_CODES.has(result.status)) {
        return result;
      }
      lastError = new Error(`HTTP ${result.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt > retries) break;
    const delay = RETRY_BASE_DELAY_MS * attempt;
    console.warn(
      `Retrying ${url} (attempt ${attempt}/${retries}) after ${delay}ms due to ${lastError.message}`
    );
    await sleep(delay);
  }

  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${lastError.message}`);
}

async function fetchListPage(pageNumber) {
  const candidates = pageNumber === 1
    ? [XOD_LIBS_BASE_URL]
    : [
      `${XOD_LIBS_BASE_URL}?page=${pageNumber}`,
      `${XOD_LIBS_BASE_URL}page/${pageNumber}/`
    ];

  let saw404 = false;
  for (const url of candidates) {
    const res = await fetchHtmlWithRetry(url);
    if (res.ok) return res.text;
    if (res.status === 404) {
      saw404 = true;
      continue;
    }
    throw new Error(`Failed to fetch library list page ${pageNumber} (${url}): HTTP ${res.status}`);
  }

  if (saw404) return null;
  return null;
}

function extractLibraryIdsFromList(html) {
  const ids = [];
  const pattern = /href=["']\/libs\/([a-z0-9._-]+\/[a-z0-9._-]+)\/?["']/gi;
  for (const match of html.matchAll(pattern)) {
    const id = normalizeId(match[1]);
    if (id) ids.push(id);
  }
  return uniqStrings(ids).sort((a, b) => a.localeCompare(b));
}

async function fetchLibraryDetail(id) {
  const url = `${XOD_LIBS_BASE_URL}${id}/`;
  const res = await fetchHtmlWithRetry(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch library detail for ${id} (${url}): HTTP ${res.status}`);
  }

  const html = res.text;
  const versions = extractVersionsFromText(html, id);
  const latest = versions[0] || "latest";

  return {
    id,
    source: {
      provider: "xod.io",
      url
    },
    latest,
    versions: versions.length ? versions : [latest],
    summary: extractMetaDescription(html),
    updatedAt: extractUpdatedAt(html),
    license: extractLicense(html),
    tags: [],
    interfaces: [],
    mcu: [],
    quality: {}
  };
}

async function readOverlay() {
  let overlayRaw = "{}";
  try {
    overlayRaw = await fs.readFile(OVERLAY_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parsed = JSON.parse(overlayRaw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Overlay must be an object map keyed by library id");
  }
  return parsed;
}

function mergeOverlay(baseLib, overlayEntry = {}) {
  const merged = { ...baseLib, ...overlayEntry };
  merged.id = baseLib.id;
  merged.source = { ...baseLib.source, ...(overlayEntry.source || {}) };
  merged.latest = typeof merged.latest === "string" && merged.latest ? merged.latest : baseLib.latest;

  const overlayVersions = Array.isArray(overlayEntry.versions) ? overlayEntry.versions : [];
  const versions = uniqStrings([...(Array.isArray(baseLib.versions) ? baseLib.versions : []), ...overlayVersions]);
  versions.sort(semverCompareDesc);
  merged.versions = versions.length ? versions : [merged.latest];

  merged.summary = typeof merged.summary === "string" ? merged.summary : "";
  merged.updatedAt = merged.updatedAt || null;
  merged.license = merged.license || null;
  merged.tags = uniqStrings(Array.isArray(merged.tags) ? merged.tags : []);
  merged.interfaces = uniqStrings(Array.isArray(merged.interfaces) ? merged.interfaces : []);
  merged.mcu = uniqStrings(Array.isArray(merged.mcu) ? merged.mcu : []);
  merged.quality = merged.quality && typeof merged.quality === "object" && !Array.isArray(merged.quality)
    ? merged.quality
    : {};

  return merged;
}

async function run() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Please run with Node.js 20+.");
  }

  console.log("Sync started");

  const overlay = await readOverlay();
  const discoveredIds = [];
  const seenIds = new Set();
  let page = 1;

  while (true) {
    const html = await fetchListPage(page);
    if (html === null) {
      if (page === 1) {
        throw new Error("Unable to fetch initial XOD.io library list page");
      }
      break;
    }

    const ids = extractLibraryIdsFromList(html);
    if (ids.length === 0) break;
    if (ids.every((id) => seenIds.has(id))) break;

    discoveredIds.push(...ids);
    for (const id of ids) seenIds.add(id);
    console.log(`Page ${page}: found ${ids.length} library ids`);
    page += 1;
  }

  const uniqueIds = uniqStrings(discoveredIds).sort((a, b) => a.localeCompare(b));
  if (uniqueIds.length === 0) {
    throw new Error("No libraries were discovered from XOD.io pages");
  }

  const libraries = [];
  for (const id of uniqueIds) {
    const detail = await fetchLibraryDetail(id);
    libraries.push(mergeOverlay(detail, overlay[id]));
    console.log(`Processed ${id}`);
  }

  libraries.sort((a, b) => a.id.localeCompare(b.id));

  const duplicateIds = libraries
    .map((lib) => lib.id)
    .filter((id, i, arr) => arr.indexOf(id) !== i);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate ids detected: ${uniqStrings(duplicateIds).join(", ")}`);
  }

  for (const lib of libraries) {
    if (!lib.id || !lib.source || !lib.latest) {
      throw new Error(`Invalid library record detected: ${JSON.stringify(lib)}`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    libraries
  };

  const stableJson = `${JSON.stringify(output, null, 2)}\n`;
  JSON.parse(stableJson);

  const tempPath = `${OUTPUT_PATH}.tmp`;
  await fs.writeFile(tempPath, stableJson, "utf8");
  await fs.rename(tempPath, OUTPUT_PATH);

  console.log(`Wrote ${libraries.length} libraries to ${OUTPUT_PATH}`);
}

run().catch((error) => {
  console.error(`Sync failed: ${error.message}`);
  process.exitCode = 1;
});
