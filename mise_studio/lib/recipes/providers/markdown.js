import { extractTextRecipe } from '../legacy/extract.js';

const MAX_MARKDOWN_BYTES = 256 * 1024;

function inlineText(value) {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert labelled recipe Markdown into the existing normalized envelope. */
export function extractMarkdownRecipe({ markdown, sourceUrl, title } = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string.');
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new RangeError('Markdown recipe exceeds the extraction limit.');
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let recipeTitle = typeof title === 'string' ? inlineText(title) : '';
  let section = null;
  const ingredients = [];
  const steps = [];
  for (const raw of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const label = inlineText(heading[1]);
      if (/^ingredients?\s*:?$/i.test(label)) section = 'ingredients';
      else if (/^(?:directions?|instructions?|method|preparation|steps)\s*:?$/i.test(label)) section = 'steps';
      else {
        if (!recipeTitle && section === null) recipeTitle = label;
        section = 'other';
      }
      continue;
    }
    if (!raw.trim()) continue;
    const bullet = /^\s{0,3}(?:[-+*]\s+|\d+[.)]\s+)(.+)$/.exec(raw);
    if (!bullet || !section || section === 'other') continue;
    const content = inlineText(bullet[1]);
    if (!content) continue;
    if (section === 'ingredients') ingredients.push(content);
    else steps.push(content);
  }
  const labelled = [
    recipeTitle,
    'Ingredients',
    ...ingredients.map(value => `- ${value}`),
    'Instructions',
    ...steps.map((value, index) => `${index + 1}. ${value}`),
  ].filter(Boolean).join('\n');
  return extractTextRecipe({ text: labelled, sourceUrl, title: recipeTitle });
}
