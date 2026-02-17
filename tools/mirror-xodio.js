#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const INDEX_PATH = path.resolve(__dirname, '..', 'index', 'index.json');
const MIRROR_DIR = path.resolve(__dirname, '..', 'mirror');
const MIRROR_LIBS_DIR = path.resolve(MIRROR_DIR, 'libs');
const MIRROR_INDEX_PATH = path.resolve(MIRROR_DIR, 'index.json');
const MIRROR_STATE_PATH = path.resolve(MIRROR_DIR, 'state.json');

const PM_SWAGGER_URL = process.env.PM_SWAGGER_URL || 'https://pm.xod.io/swagger/';
const REQUEST_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_200;

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^\/+|\/+$/g, '');
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(cleaned) ? cleaned.toLowerCase() : null;
}

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function uniqStrings(values) {
  return [...new Set(values.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
}

function prependVIfNeeded(version) {
  const value = toNonEmptyString(version);
  if (!value) return null;
  if (value === 'latest') return value;
  return value.startsWith('v') ? value : `v${value}`;
}

function parseId(id) {
  const normalized = normalizeId(id);
  if (!normalized) return null;
  const [owner, libname] = normalized.split('/');
  return { id: normalized, owner, libname };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'xod2-library-index-mirror/1.0 (+https://github.com/JoyfulOak/xod2-libraries-index)',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url, retries = MAX_FETCH_RETRIES) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    attempt += 1;
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) {
        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new Error(`HTTP ${response.status}`);
        }
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
      if (error.message && /^HTTP\s\d+/.test(error.message) && !RETRYABLE_STATUS_CODES.has(Number(error.message.split(' ')[1]))) {
        break;
      }
    }

    if (attempt > retries) break;
    const delay = RETRY_BASE_DELAY_MS * attempt;
    console.warn(`Retrying ${url} (attempt ${attempt}/${retries}) after ${delay}ms due to ${lastError.message}`);
    await sleep(delay);
  }

  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${lastError && lastError.message ? lastError.message : 'unknown error'}`);
}

async function fetchSwaggerSpec(swaggerUrl) {
  const normalized = swaggerUrl.endsWith('/') ? swaggerUrl : `${swaggerUrl}/`;
  const candidates = [normalized, `${normalized}swagger.json`];
  let lastError = null;

  for (const url of candidates) {
    try {
      return await fetchJsonWithRetry(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to fetch swagger spec from ${candidates.join(', ')}: ${lastError && lastError.message ? lastError.message : 'unknown error'}`);
}

function resolveOperationPath(swaggerSpec, operationId) {
  if (!swaggerSpec || typeof swaggerSpec !== 'object' || !swaggerSpec.paths) {
    throw new Error('Invalid swagger spec, missing paths');
  }

  const paths = Object.keys(swaggerSpec.paths);
  for (const p of paths) {
    const methods = swaggerSpec.paths[p] || {};
    for (const method of Object.keys(methods)) {
      const op = methods[method];
      if (op && op.operationId === operationId) {
        return { pathTemplate: p, method: method.toUpperCase() };
      }
    }
  }

  throw new Error(`Operation ${operationId} not found in swagger spec`);
}

function buildPathFromTemplate(pathTemplate, params) {
  const aliases = {
    orgname: ['orgname', 'owner', 'org'],
    libname: ['libname', 'library', 'name'],
    semver_or_latest: ['semver_or_latest', 'version', 'semverOrLatest'],
  };

  return pathTemplate.replace(/\{([^}]+)\}/g, (_, key) => {
    const choices = aliases[key] || [key];
    const value = choices.find((choice) => choice in params);
    if (!value) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(params[value]);
  });
}

function buildBaseUrl(swaggerUrl) {
  const url = new URL(swaggerUrl);
  return `${url.protocol}//${url.host}`;
}

function toArtifactsFromState(state) {
  return Object.values(state)
    .filter((entry) => entry && entry.id && entry.version)
    .sort((a, b) => {
      const byId = a.id.localeCompare(b.id);
      if (byId !== 0) return byId;
      return a.version.localeCompare(b.version);
    });
}

async function run() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Please run with Node.js 20+.');
  }

  const indexData = await readJson(INDEX_PATH, null);
  if (!indexData || !Array.isArray(indexData.libraries)) {
    throw new Error(`Invalid index file at ${INDEX_PATH}`);
  }

  await fs.mkdir(MIRROR_LIBS_DIR, { recursive: true });
  const stateData = await readJson(MIRROR_STATE_PATH, { artifacts: {} });
  const priorArtifacts = stateData && stateData.artifacts && typeof stateData.artifacts === 'object'
    ? stateData.artifacts
    : {};

  const swaggerSpec = await fetchSwaggerSpec(PM_SWAGGER_URL);
  const { pathTemplate } = resolveOperationPath(swaggerSpec, 'getLibVersionXodball');
  const apiBase = buildBaseUrl(PM_SWAGGER_URL);

  const nextArtifacts = { ...priorArtifacts };
  const stats = {
    totalCandidates: 0,
    downloaded: 0,
    skippedExisting: 0,
    failed: 0,
  };

  const sortedLibraries = [...indexData.libraries]
    .filter((lib) => normalizeId(lib && lib.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const lib of sortedLibraries) {
    const parsed = parseId(lib.id);
    if (!parsed) continue;

    const versions = uniqStrings(
      (Array.isArray(lib.versions) ? lib.versions : [lib.latest])
        .map(prependVIfNeeded)
        .filter(Boolean)
    );

    for (const version of versions) {
      stats.totalCandidates += 1;
      const key = `${parsed.id}@${version}`;

      const relativePath = path.posix.join('mirror', 'libs', parsed.owner, parsed.libname, `${version}.xodball.json`);
      const absolutePath = path.resolve(MIRROR_LIBS_DIR, parsed.owner, parsed.libname, `${version}.xodball.json`);

      const existing = nextArtifacts[key];
      if (existing && existing.path === relativePath) {
        try {
          await fs.access(absolutePath);
          stats.skippedExisting += 1;
          continue;
        } catch (error) {
          // Artifact metadata exists but file missing, re-download.
        }
      }

      try {
        const endpointPath = buildPathFromTemplate(pathTemplate, {
          orgname: parsed.owner,
          libname: parsed.libname,
          semver_or_latest: version,
        });
        const sourceUrl = `${apiBase}${endpointPath}`;

        const xodball = await fetchJsonWithRetry(sourceUrl);
        const content = `${JSON.stringify(xodball, null, 2)}\n`;
        const sha256 = crypto.createHash('sha256').update(content).digest('hex');

        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, 'utf8');

        nextArtifacts[key] = {
          id: parsed.id,
          owner: parsed.owner,
          libname: parsed.libname,
          version,
          sourceProvider: 'xod.io',
          sourceUrl,
          path: relativePath,
          sha256,
          bytes: Buffer.byteLength(content, 'utf8'),
          mirroredAt: new Date().toISOString(),
        };

        stats.downloaded += 1;
        console.log(`Mirrored ${key}`);
      } catch (error) {
        stats.failed += 1;
        console.warn(`Failed ${key}: ${error.message}`);
      }
    }
  }

  const artifacts = toArtifactsFromState(nextArtifacts);
  const mirrorIndex = {
    generatedAt: new Date().toISOString(),
    sourceIndexGeneratedAt: indexData.generatedAt || null,
    stats: {
      ...stats,
      totalMirroredArtifacts: artifacts.length,
    },
    artifacts,
  };

  const mirrorState = {
    generatedAt: mirrorIndex.generatedAt,
    sourceIndexGeneratedAt: mirrorIndex.sourceIndexGeneratedAt,
    artifacts: artifacts.reduce((acc, item) => {
      acc[`${item.id}@${item.version}`] = item;
      return acc;
    }, {}),
  };

  await writeJson(MIRROR_INDEX_PATH, mirrorIndex);
  await writeJson(MIRROR_STATE_PATH, mirrorState);

  console.log(`Mirror complete: downloaded=${stats.downloaded}, skippedExisting=${stats.skippedExisting}, failed=${stats.failed}, totalArtifacts=${artifacts.length}`);
}

run().catch((error) => {
  console.error(`Mirror failed: ${error.message}`);
  process.exitCode = 1;
});
