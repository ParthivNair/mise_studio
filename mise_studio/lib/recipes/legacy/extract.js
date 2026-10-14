import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { ApiError } from './errors.js';

const LIMITS = Object.freeze({ htmlBytes: 2 * 1024 * 1024, textBytes: 256 * 1024, depth: 48, nodes: 20000, recipes: 12, ingredients: 300, steps: 300, field: 16000, warnings: 200 });
const VERSION = '1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const warning = (field, code, message) => ({ field, code, message });

function limit(message) {
  throw new ApiError(422, 'extraction_limit_exceeded', message);
}

function checkInput(value, name, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'invalid_input', `${name} must be a nonempty string.`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) limit(`${name} exceeds the extraction size limit.`);
}

function addWarning(warnings, entry) {
  if (warnings.some(item => item.field === entry.field && item.code === entry.code && item.message === entry.message)) return;
  if (warnings.length >= LIMITS.warnings) limit('The document produced too many extraction warnings.');
  warnings.push(entry);
}

function plain(value, maxLength = LIMITS.field) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value);
  if (raw.length > LIMITS.field) limit('A recipe field exceeds the extraction size limit.');
  const $ = cheerio.load(raw, null, false);
  $('script, style, noscript, iframe, object, template').remove();
  $('br').replaceWith('\n');
  const result = $.root().text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (result.length > maxLength) limit('A recipe field exceeds the extraction size limit.');
  return result;
}

function hasType(node, expected) {
  const values = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
  return values.some(value => typeof value === 'string' && value.replace(/\/$/, '').split(/[\/#]/).at(-1).toLowerCase() === expected.toLowerCase());
}

function safeSourceUrl(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function stringSteps(value) {
  if (typeof value !== 'string') return [];
  if (value.length > LIMITS.field) limit('An instruction field exceeds the extraction size limit.');
  const $ = cheerio.load(value, null, false);
  $('script, style, noscript, iframe, object, template').remove();
  const listItems = $('li').filter((_, el) => $(el).find('li').length === 0);
  if (listItems.length) return listItems.toArray().map(el => plain($(el).html())).filter(Boolean);
  $('br').replaceWith('\n');
  $('p, div').append('\n');
  return $.root().text().split(/\r?\n+/).map(line => plain(line)).filter(Boolean);
}

function ordered(values) {
  // Explicit position is meaningful only when every entry supplies one.
  if (values.length && values.every(value => isObject(value) && Number.isFinite(Number(value.position)) && Number(value.position) > 0)) {
    return [...values].sort((a, b) => Number(a.position) - Number(b.position));
  }
  return values;
}

function makeGraph(documents, warnings) {
  const ids = new Map();
  const candidates = [];
  let count = 0;
  function visit(value, depth) {
    if (depth > LIMITS.depth) limit('Structured recipe data is nested too deeply.');
    if (value === null || typeof value !== 'object') return;
    if (++count > LIMITS.nodes) limit('Structured recipe data contains too many objects.');
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value['@id'] === 'string') {
      const previous = ids.get(value['@id']);
      if (!previous || Object.keys(previous).length < Object.keys(value).length) ids.set(value['@id'], value);
    }
    if (hasType(value, 'Recipe')) candidates.push(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
  }
  for (const document of documents) visit(document, 0);
  function resolve(value, field) {
    if (!isObject(value) || typeof value['@id'] !== 'string') return value;
    const target = ids.get(value['@id']);
    if (target && target !== value) return { ...target, ...value };
    if (Object.keys(value).every(key => key === '@id')) addWarning(warnings, warning(field, 'unresolved_reference', 'Some structured recipe data references missing content.'));
    return value;
  }
  return { candidates, resolve };
}

function names(value, resolve, field) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => {
    const resolved = resolve(item, field);
    return plain(isObject(resolved) ? resolved.name : resolved, 1000);
  }).filter(Boolean).join(', ');
}

function parseYield(value, resolve, warnings) {
  const values = Array.isArray(value) ? value : [value];
  const pieces = values.map(item => {
    const resolved = resolve(item, 'yield');
    if (isObject(resolved)) {
      return plain([resolved.value, resolved.unitText || resolved.unitCode, resolved.name].filter(part => part !== undefined && part !== null).join(' '), 1000);
    }
    return plain(resolved, 1000);
  }).filter(Boolean);
  const raw = pieces.join('; ');
  let servings = null;
  for (const piece of pieces) {
    // A bare count or a count of loaves/cookies is not evidence of servings.
    const match = piece.match(/^(?:serves?|servings?\s*:?|yield\s*:?\s*serves?)\s*(\d+(?:\.\d+)?)\s*(?:people|persons?)?$/i)
      || piece.match(/^(\d+(?:\.\d+)?)\s*(?:servings?|people|persons?)$/i);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 10000) {
      if (servings !== null && servings !== Number(match[1])) {
        servings = null;
        addWarning(warnings, warning('yield', 'ambiguous_yield', 'The source gives conflicting serving counts.'));
        break;
      }
      servings = Number(match[1]);
    }
  }
  if (servings === null) addWarning(warnings, warning('yield', 'unknown_servings', 'A numeric serving count could not be established from the source.'));
  return { raw, servings };
}

function duration(value, field, warnings) {
  if (value === undefined || value === null || value === '') return null;
  const raw = plain(value, 500);
  const match = raw.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (match && match.slice(1).some(part => part !== undefined)) {
    const minutes = Number(match[1] || 0) * 1440 + Number(match[2] || 0) * 60 + Number(match[3] || 0) + Number(match[4] || 0) / 60;
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 525600) return minutes;
  }
  addWarning(warnings, warning(field, 'unparsed_duration', 'The source duration is not a supported ISO 8601 duration.'));
  return null;
}

function timing(text) {
  const expressions = [];
  const suggestions = [];
  const pattern = /\b(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/gi;
  for (const match of text.matchAll(pattern)) {
    // A duration phrase is evidence about the source, never a whole-step estimate.
    const factor = /^s/i.test(match[3]) ? 1 / 60 : /^h/i.test(match[3]) ? 60 : /^d/i.test(match[3]) ? 1440 : 1;
    const min = Number(match[1]) * factor;
    const max = Number(match[2] ?? match[1]) * factor;
    if (min > 0 && max >= min && max <= 525600) {
      expressions.push(match[0]);
      suggestions.push({ min, max, unit: 'minutes' });
    }
    if (suggestions.length > 40) limit('An instruction contains too many timing expressions.');
  }
  return suggestions.length ? { timingEvidence: expressions.join('; '), timingSuggestions: suggestions } : {};
}

function flattenIngredients(value, resolve, warnings) {
  const result = [];
  let visits = 0;
  function visit(input, section, depth, path) {
    if (depth > LIMITS.depth || ++visits > LIMITS.nodes) limit('Ingredient structure exceeds the extraction limit.');
    if (Array.isArray(input)) {
      for (const item of ordered(input)) visit(item, section, depth + 1, path);
      return;
    }
    const node = resolve(input, 'ingredients');
    if (isObject(node)) {
      const key = node['@id'] || input;
      if (path.has(key)) {
        addWarning(warnings, warning('ingredients', 'circular_reference', 'A circular ingredient reference was skipped.'));
        return;
      }
      const next = new Set(path).add(key);
      if (node.itemListElement) {
        visit(node.itemListElement, plain(node.name, 500) || section, depth + 1, next);
      } else if (node.item) {
        visit(node.item, section, depth + 1, next);
      } else if (hasType(node, 'PropertyValue')) {
        const raw = plain([node.value, node.unitText || node.unitCode, node.name].filter(part => part !== undefined && part !== null).join(' '), 4000);
        if (raw) result.push({ raw, ...(section ? { section } : {}) });
      } else if (node.text || node.name) {
        const raw = plain(node.text || node.name, 4000);
        if (raw) result.push({ raw, ...(section ? { section } : {}) });
      }
    } else if (typeof node === 'string') {
      const lines = node.split(/\r?\n/).map(line => plain(line, 4000)).filter(Boolean);
      for (const raw of lines) result.push({ raw, ...(section ? { section } : {}) });
    }
    if (result.length > LIMITS.ingredients) limit('The recipe contains too many ingredient entries.');
  }
  visit(value, undefined, 0, new Set());
  return result;
}

function flattenSteps(value, resolve, warnings) {
  const result = [];
  let visits = 0;
  function add(text, section) {
    if (!text) return;
    result.push({ text, ...(section ? { section } : {}) });
    if (result.length > LIMITS.steps) limit('The recipe contains too many instruction steps.');
  }
  function visit(input, section, depth, path) {
    if (depth > LIMITS.depth || ++visits > LIMITS.nodes) limit('Instruction structure exceeds the extraction limit.');
    if (Array.isArray(input)) {
      for (const item of ordered(input)) visit(item, section, depth + 1, path);
      return;
    }
    const node = resolve(input, 'steps');
    if (typeof node === 'string') {
      for (const text of stringSteps(node)) add(text, section);
      return;
    }
    if (!isObject(node)) return;
    const key = node['@id'] || input;
    if (path.has(key)) {
      addWarning(warnings, warning('steps', 'circular_reference', 'A circular instruction reference was skipped.'));
      return;
    }
    const next = new Set(path).add(key);
    if (hasType(node, 'HowToSection')) {
      const label = plain(node.name, 500);
      const nextSection = label ? [section, label].filter(Boolean).join(' / ') : section;
      visit(node.itemListElement || node.steps || node.step || node.text, nextSection, depth + 1, next);
    } else if (node.item) {
      visit(node.item, section, depth + 1, next);
    } else if (node.itemListElement || node.steps || node.step) {
      const children = node.itemListElement || node.steps || node.step;
      if (typeof children === 'string') add(plain(children), section);
      else visit(children, section, depth + 1, next);
    } else if (node.text || node.name) {
      for (const text of stringSteps(String(node.text || node.name))) add(text, section);
    }
  }
  visit(value, undefined, 0, new Set());
  return result;
}

function normalize(candidate, { url, fetchedAt, extractor, resolve }) {
  const warnings = [];
  const title = plain(candidate.name, 500);
  const ingredients = flattenIngredients(candidate.recipeIngredient ?? candidate.ingredients, resolve, warnings);
  const rawSteps = flattenSteps(candidate.recipeInstructions ?? candidate.step, resolve, warnings);
  const sourceUrl = safeSourceUrl(url);
  const publisher = names(candidate.publisher, resolve, 'source.publisher') || (sourceUrl ? new URL(sourceUrl).hostname : '');
  const author = names(candidate.author, resolve, 'source.author');
  const id = `recipe_${hash(JSON.stringify([sourceUrl || null, title, ingredients, rawSteps]))}`;
  const steps = rawSteps.map((item, index) => ({
    id: `step_${hash(JSON.stringify([id, index, item]))}`,
    ...item,
    minutes: null,
    durationSource: 'unknown',
    ...timing(item.text),
  }));
  for (const [field, exists] of [['title', title], ['ingredients', ingredients.length], ['steps', steps.length]]) {
    if (!exists) addWarning(warnings, warning(field, 'missing_field', `The source did not provide ${field}.`));
  }
  const recipe = {
    id, title,
    source: { ...(sourceUrl ? { url: sourceUrl } : {}), ...(publisher ? { publisher } : {}), ...(author ? { author } : {}), fetchedAt, extractor, version: VERSION },
    yield: parseYield(candidate.recipeYield, resolve, warnings),
    ingredients, steps,
    recipeTimes: {
      prepMinutes: duration(candidate.prepTime, 'recipeTimes.prepMinutes', warnings),
      cookMinutes: duration(candidate.cookTime, 'recipeTimes.cookMinutes', warnings),
      totalMinutes: duration(candidate.totalTime, 'recipeTimes.totalMinutes', warnings),
    },
    warnings,
  };
  return recipe;
}

function microdataRecipes($) {
  const roots = $('[itemscope][itemtype]').filter((_, element) => ($(element).attr('itemtype') || '').split(/\s+/).some(type => /^https?:\/\/schema\.org\/Recipe\/?$/i.test(type)));
  return roots.toArray().map(root => {
    function properties(name) {
      return $(root).find('[itemprop]').filter((_, element) => {
        if (!($(element).attr('itemprop') || '').split(/\s+/).includes(name)) return false;
        return $(element).parents('[itemscope]').first()[0] === root;
      }).toArray();
    }
    function values(name, html = false) {
      return properties(name).map(element => {
        const $element = $(element);
        return $element.attr('content') ?? $element.attr('datetime') ?? (html ? $element.html() : $element.text());
      }).filter(value => value !== undefined && value !== null);
    }
    return {
      '@type': 'Recipe', name: values('name')[0], recipeIngredient: values('recipeIngredient'), recipeInstructions: values('recipeInstructions', true),
      recipeYield: values('recipeYield'), prepTime: values('prepTime')[0], cookTime: values('cookTime')[0], totalTime: values('totalTime')[0],
      author: values('author'), publisher: values('publisher'),
    };
  });
}

function envelope(recipes, warnings) {
  const distinct = [...new Map(recipes.map(recipe => [recipe.id, recipe])).values()];
  if (distinct.length > LIMITS.recipes) limit('The page contains too many recipes to import.');
  let status = 'not_recipe';
  if (distinct.length > 1) status = 'choose_recipe';
  else if (distinct.length === 1) status = distinct[0].title && distinct[0].ingredients.length && distinct[0].steps.length ? 'ready_for_review' : 'partial';
  return { status, recipes: distinct, warnings };
}

export function extractRecipes({ html, url } = {}) {
  checkInput(html, 'html', LIMITS.htmlBytes);
  const warnings = [];
  const $ = cheerio.load(html);
  const documents = [];
  $('script').each((_, element) => {
    if (($(element).attr('type') || '').split(';')[0].trim().toLowerCase() !== 'application/ld+json') return;
    const content = $(element).html()?.trim();
    if (!content) return;
    try {
      documents.push(JSON.parse(content));
    } catch {
      addWarning(warnings, warning('document', 'malformed_jsonld', 'A malformed structured-data block was skipped.'));
    }
  });
  const { candidates, resolve } = makeGraph(documents, warnings);
  const fetchedAt = new Date().toISOString();
  let recipes = candidates.map(candidate => normalize(resolve(candidate, 'recipe'), { url, fetchedAt, extractor: 'schema.org-jsonld', resolve }));
  if (!recipes.length) recipes = microdataRecipes($).map(candidate => normalize(candidate, { url, fetchedAt, extractor: 'schema.org-microdata', resolve: value => value }));
  return envelope(recipes, warnings);
}

export function extractTextRecipe({ text, sourceUrl, title } = {}) {
  checkInput(text, 'text', LIMITS.textBytes);
  const warnings = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let section = null;
  let sawIngredients = false;
  let sawDirections = false;
  const ingredients = [];
  const steps = [];
  const before = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^ingredients?\s*:?$/i.test(trimmed)) { section = 'ingredients'; sawIngredients = true; continue; }
    if (/^(?:directions?|instructions?|method|preparation|steps)\s*:?$/i.test(trimmed)) { section = 'steps'; sawDirections = true; continue; }
    if (/^(?:notes?|nutrition|nutrition facts|tips|storage|serving suggestions|equipment)\s*:?$/i.test(trimmed)) { section = 'other'; continue; }
    const content = trimmed.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '');
    if (section === 'ingredients') ingredients.push(content);
    else if (section === 'steps') steps.push(content);
    else if (section === null) before.push(content);
    if (ingredients.length > LIMITS.ingredients || steps.length > LIMITS.steps) limit('The pasted recipe contains too many entries.');
  }
  if (!sawIngredients && !sawDirections) {
    addWarning(warnings, warning('text', 'missing_section_labels', 'Paste a recipe with Ingredients and Directions or Instructions headings.'));
    return envelope([], warnings);
  }
  const extractedTitle = title === undefined ? (before.length === 1 ? before[0] : '') : title;
  const recipe = normalize({ name: extractedTitle, recipeIngredient: ingredients, recipeInstructions: steps }, {
    url: sourceUrl, fetchedAt: new Date().toISOString(), extractor: 'labelled-text', resolve: value => value,
  });
  addWarning(recipe.warnings, warning('steps', 'review_text_structure', 'Check the pasted ingredient and instruction boundaries before saving.'));
  return envelope([recipe], warnings);
}
