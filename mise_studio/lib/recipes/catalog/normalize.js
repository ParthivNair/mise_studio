import { createHash } from 'node:crypto';
import { ApiError } from '../legacy/errors.js';

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref_src',
]);

function hash(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function cleanText(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

export function normalizeQuery(value, { locale = 'en-US', kind = 'recipe', version = 1 } = {}) {
  const query = cleanText(value);
  if (!query) throw new ApiError(400, 'INVALID_QUERY', 'A non-empty query is required.');
  if (!['recipe', 'web'].includes(kind)) throw new ApiError(400, 'INVALID_KIND', 'Kind must be web or recipe.');
  if (query.length > 600 || query.split(' ').length > 75) throw new ApiError(400, 'INVALID_QUERY', 'Query must contain at most 600 characters and 75 words.');
  return {
    query,
    folded: query.toLocaleLowerCase(locale),
    key: `${version}:${locale}:${kind}:${query.toLocaleLowerCase(locale)}`,
  };
}

export function canonicalizeSourceUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('source URL must be a public HTTP URL');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function parseNumber(value) {
  const vulgar = { '¼': .25, '½': .5, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };
  if (vulgar[value] !== undefined) return vulgar[value];
  const mixed = value.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (fraction && Number(fraction[2])) return Number(fraction[1]) / Number(fraction[2]);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const NUMBER = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])`;
const UNITS = String.raw`cups?|c\.?|tablespoons?|tbsp\.?|teaspoons?|tsp\.?|ounces?|oz\.?|pounds?|lbs?\.?|grams?|g|kilograms?|kg|millilit(?:er|re)s?|ml|lit(?:er|re)s?|l|cloves?|cans?|packages?|pinches?`;

function normalizeIngredient(item, recipeId, index) {
  const raw = cleanText(typeof item === 'string' ? item : item?.raw);
  const section = cleanText(item?.section) || null;
  const match = raw.match(new RegExp(`^(${NUMBER})(?:\\s*(?:-|–|—|to)\\s*(${NUMBER}))?\\s*(?:(${UNITS})\\b)?\\s*(.*)$`, 'iu'));
  let quantity = null;
  let unit = null;
  let name = raw || null;
  if (match) {
    const min = parseNumber(match[1]);
    const max = parseNumber(match[2] || match[1]);
    if (min !== null && max !== null && min >= 0 && max >= min) quantity = { min, max };
    unit = cleanText(match[3]) || null;
    name = cleanText(match[4]).replace(/^of\s+/i, '') || null;
  }
  let preparation = null;
  if (name?.includes(',')) {
    const at = name.indexOf(',');
    preparation = cleanText(name.slice(at + 1)) || null;
    name = cleanText(name.slice(0, at)) || null;
  }
  return { id: `ingredient-${hash(`${recipeId}:${index}:${raw}`)}`, raw, name, quantity, unit, preparation, ...(section ? { section } : {}) };
}

function normalizeWarning(value) {
  return {
    field: cleanText(value?.field) || 'recipe',
    code: cleanText(value?.code) || 'warning',
    message: cleanText(value?.message) || 'Review the imported recipe.',
  };
}

function normalizeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeExtractedRecipe(input, { sourceUrl, recipeNodeId = '0', fetchedAt = new Date().toISOString() } = {}) {
  const canonicalUrl = sourceUrl ? canonicalizeSourceUrl(sourceUrl) : null;
  const nodeIdentity = cleanText(input?.source?.nodeId || input?.source?.recipeNodeId || recipeNodeId) || '0';
  const recipeId = `recipe-${hash(`${canonicalUrl || 'pasted'}#${nodeIdentity}`)}`;
  const title = cleanText(input?.title);
  const ingredients = (Array.isArray(input?.ingredients) ? input.ingredients : []).map((item, index) => normalizeIngredient(item, recipeId, index)).filter(item => item.raw);
  const steps = (Array.isArray(input?.steps) ? input.steps : []).map((item, index) => {
    const text = cleanText(typeof item === 'string' ? item : item?.text);
    const minutes = normalizeMinutes(item?.minutes);
    return {
      id: `step-${hash(`${recipeId}:${index}:${text}`)}`,
      text,
      section: cleanText(item?.section) || null,
      minutes,
      durationSource: minutes === null ? 'unknown' : 'explicit',
      evidence: cleanText(item?.timingEvidence || item?.evidence) || null,
    };
  }).filter(item => item.text);
  const legacyTimes = input?.recipeTimes || {};
  const times = input?.times || {};
  const warnings = (Array.isArray(input?.warnings) ? input.warnings : []).map(normalizeWarning);
  if (!title) warnings.push({ field: 'title', code: 'missing_field', message: 'The source did not provide title.' });
  if (!ingredients.length) warnings.push({ field: 'ingredients', code: 'missing_field', message: 'The source did not provide ingredients.' });
  if (!steps.length) warnings.push({ field: 'steps', code: 'missing_field', message: 'The source did not provide steps.' });
  const publisher = cleanText(input?.source?.publisher) || (canonicalUrl ? new URL(canonicalUrl).hostname.replace(/^www\./, '') : null);
  const author = cleanText(input?.source?.author) || null;
  const extractorVersion = cleanText(input?.source?.extractorVersion || input?.source?.extractor || input?.source?.version) || 'legacy-1';
  const body = {
    title,
    yield: { raw: cleanText(input?.yield?.raw), servings: normalizeMinutes(input?.yield?.servings) },
    ingredients, steps,
    times: {
      prep: normalizeMinutes(times.prep ?? legacyTimes.prepMinutes),
      cook: normalizeMinutes(times.cook ?? legacyTimes.cookMinutes),
      total: normalizeMinutes(times.total ?? legacyTimes.totalMinutes),
    },
    warnings,
  };
  const contentHash = hash(JSON.stringify({ ...body, source: { publisher, author, extractorVersion } }), 64);
  return {
    schemaVersion: 1,
    recipeId,
    revisionId: `revision-${hash(`${recipeId}:${contentHash}`)}`,
    dishId: null,
    ...body,
    source: {
      url: canonicalUrl,
      publisher,
      author,
      fetchedAt,
      extractorVersion,
      contentHash,
    },
    completeness: title && ingredients.length && steps.length ? 'complete' : 'partial',
  };
}

export function toLegacyRecipe(recipe) {
  return {
    id: recipe.recipeId,
    recipeId: recipe.recipeId,
    revisionId: recipe.revisionId,
    title: recipe.title,
    source: { ...recipe.source, extractor: recipe.source.extractorVersion },
    yield: recipe.yield,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    times: recipe.times,
    recipeTimes: { prepMinutes: recipe.times.prep, cookMinutes: recipe.times.cook, totalMinutes: recipe.times.total },
    warnings: recipe.warnings,
    completeness: recipe.completeness,
  };
}
