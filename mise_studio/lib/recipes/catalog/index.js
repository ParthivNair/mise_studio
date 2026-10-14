import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { extractRecipes } from '../legacy/extract.js';
import { ApiError } from '../legacy/errors.js';
import { canonicalizeSourceUrl, normalizeExtractedRecipe, normalizeQuery, toLegacyRecipe } from './normalize.js';

const DEFAULTS = Object.freeze({
  searchFreshMs: 24 * 60 * 60 * 1000,
  emptyFreshMs: 5 * 60 * 1000,
  recipeFreshMs: 30 * 24 * 60 * 60 * 1000,
  errorCooldownMs: 30 * 1000,
  maxQueryEntries: 2_000,
  maxRecipeEntries: 5_000,
  maxJobEntries: 5_000,
  maxRevisionsPerRecipe: 10,
});

function json(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.recipes)) throw new TypeError('extractor returned an invalid recipe envelope');
  return value;
}

export function createRecipeCatalog(options = {}) {
  const {
    databasePath = ':memory:', searchProvider, fetchPage,
    extract = extractRecipes, now = () => Date.now(), aliases = {},
  } = options;
  if (!searchProvider?.search) throw new TypeError('searchProvider.search is required');
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const policy = { ...DEFAULTS, ...options };
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dishes (id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dish_aliases (alias_key TEXT PRIMARY KEY, query_key TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recipes (recipe_id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, current_revision_id TEXT, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recipe_revisions (revision_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE, content_hash TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(recipe_id, content_hash));
    CREATE INDEX IF NOT EXISTS recipe_revisions_recipe ON recipe_revisions(recipe_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS recipes_title ON recipes(title);
    CREATE TABLE IF NOT EXISTS query_results (query_key TEXT PRIMARY KEY, query_text TEXT NOT NULL, payload TEXT, result_count INTEGER NOT NULL DEFAULT 0, provider TEXT, updated_at INTEGER NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS query_results_updated ON query_results(updated_at);
    CREATE TABLE IF NOT EXISTS resolution_jobs (job_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, status TEXT NOT NULL, recipe_id TEXT, revision_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS resolution_jobs_source ON resolution_jobs(source_key, updated_at DESC);
  `);
  const schemaRow = db.prepare("SELECT value FROM catalog_meta WHERE key='schema_version'").get();
  if (schemaRow && schemaRow.value !== '1') {
    db.close();
    throw new Error(`Unsupported recipe catalog schema version ${schemaRow.value}.`);
  }
  db.prepare("INSERT OR IGNORE INTO catalog_meta(key,value) VALUES('schema_version','1')").run();
  db.prepare("UPDATE resolution_jobs SET status='retryable', error='Resolution interrupted by server restart', updated_at=? WHERE status='pending'").run(now());

  const searchFlights = new Map();
  const resolveFlights = new Map();
  const background = new Set();
  let closed = false;

  function assertOpen() { if (closed) throw new Error('recipe catalog is closed'); }
  function queryAlias(key) { return db.prepare('SELECT query_key FROM dish_aliases WHERE alias_key=?').get(key)?.query_key || key; }
  function setAlias(alias, canonical, settings = {}) {
    assertOpen();
    const aliasKey = normalizeQuery(alias, settings).key;
    const queryKey = normalizeQuery(canonical, settings).key;
    db.prepare('INSERT OR REPLACE INTO dish_aliases(alias_key,query_key,created_at) VALUES(?,?,?)').run(aliasKey, queryKey, now());
  }
  for (const [alias, canonical] of Object.entries(aliases)) setAlias(alias, canonical);

  function prune() {
    db.prepare('DELETE FROM query_results WHERE query_key IN (SELECT query_key FROM query_results ORDER BY updated_at DESC LIMIT -1 OFFSET ?)').run(policy.maxQueryEntries);
    db.prepare('DELETE FROM recipes WHERE recipe_id IN (SELECT recipe_id FROM recipes ORDER BY updated_at DESC LIMIT -1 OFFSET ?)').run(policy.maxRecipeEntries);
    db.prepare('DELETE FROM resolution_jobs WHERE job_id IN (SELECT job_id FROM resolution_jobs ORDER BY updated_at DESC LIMIT -1 OFFSET ?)').run(policy.maxJobEntries);
    db.prepare(`DELETE FROM recipe_revisions WHERE revision_id IN (
      SELECT revision_id FROM (
        SELECT rr.revision_id,r.current_revision_id,ROW_NUMBER() OVER (PARTITION BY rr.recipe_id ORDER BY rr.fetched_at DESC) AS position
        FROM recipe_revisions rr JOIN recipes r ON r.recipe_id=rr.recipe_id
      ) WHERE position>? AND revision_id<>current_revision_id
    )`).run(policy.maxRevisionsPerRecipe);
  }

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => {});
  }

  async function refreshSearch({ normalized, key, count, kind, locale }) {
    if (searchFlights.has(key)) return searchFlights.get(key);
    const promise = (async () => {
      try {
        const result = await searchProvider.search({ query: normalized.query, count, kind });
        if (!result || !Array.isArray(result.results)) throw new TypeError('search provider returned invalid results');
        const value = { query: normalized.query, provider: result.provider || 'catalog', results: result.results.slice(0, count), hasMore: result.hasMore === true };
        db.prepare(`INSERT INTO query_results(query_key,query_text,payload,result_count,provider,updated_at,error) VALUES(?,?,?,?,?,?,NULL)
          ON CONFLICT(query_key) DO UPDATE SET query_text=excluded.query_text,payload=excluded.payload,result_count=excluded.result_count,provider=excluded.provider,updated_at=excluded.updated_at,error=NULL`)
          .run(key, normalized.query, JSON.stringify(value), value.results.length, value.provider, now());
        prune();
        return { ...value, cache: { state: 'miss', key, updatedAt: new Date(now()).toISOString() } };
      } catch (error) {
        db.prepare(`INSERT INTO query_results(query_key,query_text,result_count,updated_at,error) VALUES(?,?,0,?,?)
          ON CONFLICT(query_key) DO UPDATE SET updated_at=excluded.updated_at,error=excluded.error`).run(key, normalized.query, now(), message(error));
        throw error;
      }
    })().finally(() => searchFlights.delete(key));
    searchFlights.set(key, promise);
    return promise;
  }

  async function search({ query, count = 6, kind = 'recipe', locale = 'en-US' } = {}) {
    assertOpen();
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new ApiError(400, 'INVALID_COUNT', 'Count must be an integer between 1 and 20.');
    const normalized = normalizeQuery(query, { locale, kind });
    const key = `${queryAlias(normalized.key)}:count=${count}`;
    const row = db.prepare('SELECT * FROM query_results WHERE query_key=?').get(key);
    const payload = row?.payload ? json(row.payload) : null;
    const age = row ? now() - row.updated_at : Infinity;
    const ttl = row?.result_count === 0 ? policy.emptyFreshMs : policy.searchFreshMs;
    if (payload && age <= ttl) return { ...payload, results: payload.results.slice(0, count), cache: { state: 'fresh', key, updatedAt: new Date(row.updated_at).toISOString() } };
    if (payload) {
      const refresh = refreshSearch({ normalized, key, count, kind, locale });
      track(refresh);
      return { ...payload, results: payload.results.slice(0, count), cache: { state: 'stale', key, updatedAt: new Date(row.updated_at).toISOString(), refreshing: true } };
    }
    const local = db.prepare(`SELECT r.recipe_id,r.title,rr.payload FROM recipes r
      JOIN recipe_revisions rr ON rr.revision_id=r.current_revision_id ORDER BY r.updated_at DESC LIMIT 500`).all()
      .map(entry => ({ entry, recipe: json(entry.payload) }))
      .filter(({ entry }) => entry.title.normalize('NFC').toLocaleLowerCase(locale).includes(normalized.folded))
      .slice(0, count)
      .map(({ entry, recipe }) => ({
        id: entry.recipe_id, recipeId: entry.recipe_id, url: recipe.source.url, title: entry.title,
        source: recipe.source.publisher || (recipe.source.url ? new URL(recipe.source.url).hostname : 'catalog'),
        snippet: 'Saved in recipe catalog', catalog: true,
      }));
    if (local.length) return { query: normalized.query, provider: 'catalog', results: local, hasMore: false, cache: { state: 'fresh', key, local: true } };
    if (row?.error && age <= policy.errorCooldownMs) {
      const error = new Error(row.error); error.code = 'SEARCH_COOLDOWN'; throw error;
    }
    return refreshSearch({ normalized, key, count, kind, locale });
  }

  function getRecipe(recipeId) {
    assertOpen();
    const row = db.prepare(`SELECT rr.payload FROM recipes r JOIN recipe_revisions rr ON rr.revision_id=r.current_revision_id WHERE r.recipe_id=?`).get(recipeId);
    return row ? json(row.payload) : null;
  }

  function cachedByUrl(canonicalUrl) {
    return db.prepare(`SELECT r.updated_at,rr.payload FROM recipes r JOIN recipe_revisions rr ON rr.revision_id=r.current_revision_id ORDER BY r.updated_at DESC LIMIT 500`).all()
      .map(row => ({ recipe: json(row.payload), updatedAt: row.updated_at }))
      .filter(row => row.recipe?.source?.url === canonicalUrl);
  }

  function storeRevision(recipe, sourceKey) {
    const stamp = now();
    const currentRow = db.prepare(`SELECT rr.payload FROM recipes r LEFT JOIN recipe_revisions rr ON rr.revision_id=r.current_revision_id WHERE r.recipe_id=?`).get(recipe.recipeId);
    const current = currentRow?.payload ? json(currentRow.payload) : null;
    const promote = current?.completeness !== 'complete' || recipe.completeness === 'complete';
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO recipes(recipe_id,source_key,current_revision_id,title,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(recipe_id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`).run(recipe.recipeId, sourceKey, recipe.revisionId, recipe.title, stamp);
      db.prepare('INSERT OR IGNORE INTO recipe_revisions(revision_id,recipe_id,content_hash,payload,fetched_at) VALUES(?,?,?,?,?)')
        .run(recipe.revisionId, recipe.recipeId, recipe.source.contentHash, JSON.stringify(recipe), stamp);
      if (promote) db.prepare('UPDATE recipes SET current_revision_id=?,updated_at=? WHERE recipe_id=?').run(recipe.revisionId, stamp, recipe.recipeId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    prune();
  }

  async function performResolution(sourceKey, url, requestedRecipeId) {
    const fetched = await fetchPage(url, {});
    const finalUrl = canonicalizeSourceUrl(fetched?.url || url);
    const envelope = fetched?.recipes ? validateEnvelope(fetched) : validateEnvelope(extract({ html: typeof fetched === 'string' ? fetched : fetched?.html, url: finalUrl }));
    const normalized = envelope.recipes.map((recipe, index) => normalizeExtractedRecipe(recipe, { sourceUrl: finalUrl, recipeNodeId: recipe?.source?.nodeId || String(index), fetchedAt: new Date(now()).toISOString() }));
    const selected = requestedRecipeId ? normalized.find(recipe => recipe.recipeId === requestedRecipeId) : normalized[0];
    if (requestedRecipeId && !selected && normalized.length) throw new Error('requested recipe was not found on the source page');
    for (const recipe of normalized) storeRevision(recipe, `${finalUrl}#${recipe.recipeId}`);
    if (!selected) return { status: envelope.status || 'not_recipe', recipes: [], warnings: envelope.warnings || [], cache: { state: 'miss', sourceKey } };
    // The URL-only key always points to the default recipe, while node-specific keys remain distinct.
    if (!requestedRecipeId) {
      db.prepare('UPDATE recipes SET source_key=? WHERE recipe_id=?').run(sourceKey, selected.recipeId);
    }
    const returned = requestedRecipeId ? [selected] : normalized;
    const status = returned.length > 1 ? 'choose_recipe' : selected.completeness === 'complete' ? 'ready_for_review' : 'partial';
    return { status, recipes: returned.map(toLegacyRecipe), warnings: envelope.warnings || [], cache: { state: 'miss', sourceKey } };
  }

  function resolutionFlight(sourceKey, url, requestedRecipeId) {
    if (resolveFlights.has(sourceKey)) return resolveFlights.get(sourceKey);
    const recentFailure = db.prepare("SELECT error,updated_at FROM resolution_jobs WHERE source_key=? AND status='retryable' ORDER BY updated_at DESC LIMIT 1").get(sourceKey);
    if (recentFailure && now() - recentFailure.updated_at <= policy.errorCooldownMs) {
      const error = new Error(recentFailure.error); error.code = 'RESOLUTION_COOLDOWN'; return Promise.reject(error);
    }
    const promise = performResolution(sourceKey, url, requestedRecipeId).catch(error => {
      const stamp = now();
      db.prepare("INSERT INTO resolution_jobs(job_id,source_key,status,error,created_at,updated_at) VALUES(?,?,'retryable',?,?,?)")
        .run(`job-${randomUUID()}`, sourceKey, message(error), stamp, stamp);
      throw error;
    }).finally(() => resolveFlights.delete(sourceKey));
    resolveFlights.set(sourceKey, promise);
    return promise;
  }

  async function resolve({ url, recipeId, signal } = {}) {
    assertOpen();
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
    if (!url && recipeId) {
      const cached = getRecipe(recipeId);
      if (!cached) throw new ApiError(404, 'RECIPE_NOT_FOUND', 'The stored recipe was not found.');
      return { status: cached.completeness === 'complete' ? 'ready_for_review' : 'partial', recipes: [toLegacyRecipe(cached)], warnings: [], cache: { state: 'fresh', sourceKey: `recipe:${recipeId}`, refreshEligible: false } };
    }
    if (!url) throw new ApiError(400, 'INVALID_URL', 'A recipe URL or stored recipe ID is required.');
    let canonical;
    try { canonical = canonicalizeSourceUrl(url); }
    catch { throw new ApiError(400, 'INVALID_URL', 'A valid HTTP recipe URL is required.'); }
    const sourceKey = `${canonical}#${recipeId || 'default'}`;
    const cachedRecipes = recipeId ? [getRecipe(recipeId)].filter(recipe => recipe?.source?.url === canonical) : cachedByUrl(canonical).map(entry => entry.recipe);
    if (cachedRecipes.length) {
      const age = Math.max(...cachedRecipes.map(recipe => now() - Date.parse(recipe.source.fetchedAt)));
      if (age > policy.recipeFreshMs) track(resolutionFlight(sourceKey, canonical, recipeId));
      const status = cachedRecipes.length > 1 ? 'choose_recipe' : cachedRecipes[0].completeness === 'complete' ? 'ready_for_review' : 'partial';
      return { status, recipes: cachedRecipes.map(toLegacyRecipe), warnings: [], cache: { state: age > policy.recipeFreshMs ? 'stale' : 'fresh', sourceKey, refreshing: age > policy.recipeFreshMs } };
    }
    return resolutionFlight(sourceKey, canonical, recipeId);
  }

  function getJob(jobId) {
    assertOpen();
    const row = db.prepare('SELECT * FROM resolution_jobs WHERE job_id=?').get(jobId);
    return row ? { jobId: row.job_id, status: row.status, recipeId: row.recipe_id || null, revisionId: row.revision_id || null, error: row.error || null, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } : null;
  }

  function startResolve({ url, recipeId } = {}) {
    assertOpen();
    if (!url && !recipeId) throw new ApiError(400, 'INVALID_URL', 'A recipe URL or stored recipe ID is required.');
    let canonical = null;
    if (url) {
      try { canonical = canonicalizeSourceUrl(url); }
      catch { throw new ApiError(400, 'INVALID_URL', 'A valid HTTP recipe URL is required.'); }
    }
    const sourceKey = canonical ? `${canonical}#${recipeId || 'default'}` : `recipe:${recipeId}`;
    const existing = db.prepare("SELECT job_id FROM resolution_jobs WHERE source_key=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(sourceKey);
    if (existing) return getJob(existing.job_id);
    const jobId = `job-${randomUUID()}`;
    const stamp = now();
    db.prepare("INSERT INTO resolution_jobs(job_id,source_key,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(jobId, sourceKey, stamp, stamp);
    const work = resolve({ ...(canonical ? { url: canonical } : {}), recipeId }).then(result => {
      const recipe = result.recipes[0];
      db.prepare("UPDATE resolution_jobs SET status='complete',recipe_id=?,revision_id=?,updated_at=? WHERE job_id=?").run(recipe?.recipeId || null, recipe?.revisionId || null, now(), jobId);
    }, error => {
      db.prepare("UPDATE resolution_jobs SET status='retryable',error=?,updated_at=? WHERE job_id=?").run(message(error), now(), jobId);
    });
    track(work);
    return getJob(jobId);
  }

  async function close() {
    if (closed) return;
    await Promise.allSettled([...background]);
    closed = true;
    db.close();
  }

  return { search, resolve, startResolve, getRecipe, getJob, setAlias, close };
}

export { canonicalizeSourceUrl, normalizeExtractedRecipe, normalizeQuery, toLegacyRecipe } from './normalize.js';
