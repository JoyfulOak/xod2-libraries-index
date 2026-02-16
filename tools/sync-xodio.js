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
const MAX_NORMALIZE_RETRIES = 3;
const COMPATIBILITY_STATUSES = ["working", "broken", "untested"];
const SUPPORT_STATUSES = ["stable", "experimental", "deprecated"];

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^\/+|\/+$/g, "");
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(cleaned) ? cleaned.toLowerCase() : null;
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function uniqStrings(values) {
  return [...new Set(values.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))];
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return uniqStrings(list.map(toNonEmptyString).filter(Boolean)).sort((a, b) => a.localeCompare(b));
}

function toBoolOrNull(value) {
  return typeof value === "boolean" ? value : null;
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

function normalizeVersions(versions, latest) {
  const normalized = uniqStrings(
    (Array.isArray(versions) ? versions : []).map(toNonEmptyString).filter(Boolean)
  );

  if (latest && !normalized.includes(latest)) {
    normalized.unshift(latest);
  }

  normalized.sort(semverCompareDesc);
  return normalized.length > 0 ? normalized : [latest || "latest"];
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

function normalizeCompatibilityStatus(status) {
  return COMPATIBILITY_STATUSES.includes(status) ? status : null;
}

function normalizeSupportStatus(value) {
  const supportStatus = toNonEmptyString(value);
  return SUPPORT_STATUSES.includes(supportStatus) ? supportStatus : null;
}

function sortObjectKeys(value) {
  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, key) => ({ ...acc, [key]: value[key] }), {});
}

function normalizeBoardCompatibility(rawValue) {
  const input =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue
      : {};

  const normalized = Object.keys(input).reduce((acc, boardIdRaw) => {
    const boardId = toNonEmptyString(boardIdRaw);
    const entry = input[boardIdRaw];
    const parsed =
      entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const status = normalizeCompatibilityStatus(parsed.status);
    if (!boardId || !status) return acc;

    return {
      ...acc,
      [boardId]: {
        status,
        ...(toNonEmptyString(parsed.notes)
          ? { notes: toNonEmptyString(parsed.notes) }
          : {}),
      },
    };
  }, {});

  return sortObjectKeys(normalized);
}

function deriveCompatibilitySummary(boardCompatibility) {
  const summary = {
    workingBoards: [],
    brokenBoards: [],
    untestedBoards: [],
  };

  Object.keys(boardCompatibility).forEach((boardId) => {
    const status = boardCompatibility[boardId].status;
    if (status === "working") summary.workingBoards.push(boardId);
    if (status === "broken") summary.brokenBoards.push(boardId);
    if (status === "untested") summary.untestedBoards.push(boardId);
  });

  return {
    workingBoards: normalizeStringList(summary.workingBoards),
    brokenBoards: normalizeStringList(summary.brokenBoards),
    untestedBoards: normalizeStringList(summary.untestedBoards),
  };
}

function normalizeCompatibilitySummary(rawValue, boardCompatibility) {
  const input =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue
      : {};

  const normalized = {
    workingBoards: normalizeStringList(input.workingBoards),
    brokenBoards: normalizeStringList(input.brokenBoards),
    untestedBoards: normalizeStringList(input.untestedBoards),
  };

  const hasExplicitSummary =
    normalized.workingBoards.length > 0 ||
    normalized.brokenBoards.length > 0 ||
    normalized.untestedBoards.length > 0;

  return hasExplicitSummary
    ? normalized
    : deriveCompatibilitySummary(boardCompatibility);
}

function normalizeQuality(record) {
  const quality =
    record.quality && typeof record.quality === "object" && !Array.isArray(record.quality)
      ? { ...record.quality }
      : {};

  const hasExamples = toBoolOrNull(
    quality.hasExamples !== undefined ? quality.hasExamples : record.hasExamples
  );
  const hasReadme = toBoolOrNull(
    quality.hasReadme !== undefined ? quality.hasReadme : record.hasReadme
  );
  const maintainerVerified = toBoolOrNull(
    quality.maintainerVerified !== undefined
      ? quality.maintainerVerified
      : record.maintainerVerified
  );

  return {
    ...quality,
    ...(hasExamples === null ? {} : { hasExamples }),
    ...(hasReadme === null ? {} : { hasReadme }),
    ...(maintainerVerified === null ? {} : { maintainerVerified }),
  };
}

function deepMerge(base, overlay) {
  const out = { ...(base || {}) };
  Object.keys(overlay || {}).forEach((key) => {
    const baseValue = out[key];
    const overlayValue = overlay[key];

    if (
      baseValue
      && overlayValue
      && typeof baseValue === "object"
      && typeof overlayValue === "object"
      && !Array.isArray(baseValue)
      && !Array.isArray(overlayValue)
    ) {
      out[key] = deepMerge(baseValue, overlayValue);
      return;
    }

    out[key] = overlayValue;
  });
  return out;
}

function parseLibIdFromRecord(record) {
  const fromId = normalizeId(record && record.id);
  if (fromId) return fromId;

  const owner = toNonEmptyString(record && record.owner);
  const libname = toNonEmptyString(record && record.libname);
  if (owner && libname) {
    return normalizeId(`${owner}/${libname}`);
  }
  return null;
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

function retry(fn, attempts = MAX_NORMALIZE_RETRIES) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
    boardCompatibility: {},
    compatibilitySummary: {
      workingBoards: [],
      brokenBoards: [],
      untestedBoards: []
    },
    quality: {}
  };
}

async function readOverlayMap() {
  let overlayRaw = "{}";
  try {
    overlayRaw = await fs.readFile(OVERLAY_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const parsed = JSON.parse(overlayRaw);

  if (Array.isArray(parsed)) {
    return parsed.reduce((acc, record) => {
      const id = parseLibIdFromRecord(record || {});
      if (!id) return acc;
      return { ...acc, [id]: record };
    }, {});
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.libraries)) {
    return parsed.libraries.reduce((acc, record) => {
      const id = parseLibIdFromRecord(record || {});
      if (!id) return acc;
      return { ...acc, [id]: record };
    }, {});
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Overlay must be an object map keyed by library id or libraries array");
  }

  return Object.keys(parsed).reduce((acc, rawId) => {
    const id = normalizeId(rawId) || parseLibIdFromRecord(parsed[rawId] || {});
    if (!id) return acc;
    return { ...acc, [id]: parsed[rawId] };
  }, {});
}

function normalizeLibraryRecord(baseLib, overlayEntry = {}) {
  const merged = deepMerge(baseLib, overlayEntry);

  const id = baseLib.id;
  const source =
    merged.source && typeof merged.source === "object" && !Array.isArray(merged.source)
      ? merged.source
      : {};

  const latest = toNonEmptyString(merged.latest) || baseLib.latest || "latest";
  const versions = normalizeVersions(merged.versions, latest);
  const boardCompatibility = normalizeBoardCompatibility(merged.boardCompatibility);
  const compatibilitySummary = normalizeCompatibilitySummary(
    merged.compatibilitySummary,
    boardCompatibility
  );
  const supportStatus = normalizeSupportStatus(merged.supportStatus);
  const quality = normalizeQuality(merged);

  return {
    id,
    source: {
      provider: toNonEmptyString(source.provider) || "xod.io",
      url: toNonEmptyString(source.url) || `${XOD_LIBS_BASE_URL}${id}/`
    },
    latest,
    versions,
    summary: toNonEmptyString(merged.summary) || "",
    updatedAt: toNonEmptyString(merged.updatedAt) || null,
    license: toNonEmptyString(merged.license) || null,
    tags: normalizeStringList(merged.tags),
    interfaces: normalizeStringList(merged.interfaces),
    mcu: normalizeStringList(merged.mcu),
    boardCompatibility,
    compatibilitySummary,
    ...(supportStatus ? { supportStatus } : {}),
    quality
  };
}

async function run() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Please run with Node.js 20+.");
  }

  console.log("Sync started");

  const overlay = await readOverlayMap();
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
  const skippedIds = [];
  for (const id of uniqueIds) {
    try {
      const detail = await fetchLibraryDetail(id);
      const normalized = retry(() => normalizeLibraryRecord(detail, overlay[id] || {}));
      libraries.push(normalized);
      console.log(`Processed ${id}`);
    } catch (error) {
      skippedIds.push(id);
      console.warn(`Skipped ${id}: ${error.message}`);
    }
  }

  libraries.sort((a, b) => a.id.localeCompare(b.id));

  if (libraries.length === 0) {
    throw new Error(
      `All library detail fetches failed. Skipped ${skippedIds.length} libraries.`
    );
  }

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
  if (skippedIds.length > 0) {
    console.warn(
      `Skipped ${skippedIds.length} libraries due to fetch errors: ${skippedIds.join(", ")}`
    );
  }
}

run().catch((error) => {
  console.error(`Sync failed: ${error.message}`);
  process.exitCode = 1;
});
