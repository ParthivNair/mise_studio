import { createSearchProvider } from '../legacy/search.js';
import { createSafeFetcher } from '../legacy/safe-fetch.js';
import { createMonidTinyFishProvider } from './monid.js';

/**
 * Server-only recipe discovery boundary. TinyFish is enabled only when Monid
 * credentials exist; otherwise the proven local/Brave provider remains live.
 */
export function createRecipeProvider({
  monidApiKey = process.env.MONID_API_KEY,
  braveApiKey = process.env.BRAVE_SEARCH_API_KEY,
  fetchImpl = fetch,
  fallbackProvider,
  safeFetcher,
  ...monidOptions
} = {}) {
  const fallback = fallbackProvider ?? createSearchProvider({ apiKey: braveApiKey, fetchImpl });
  const fetchRecipePage = safeFetcher ?? createSafeFetcher();
  if (typeof monidApiKey !== 'string' || !monidApiKey.trim()) {
    const suggest = fallbackProvider
      ? typeof fallbackProvider.suggest === 'function' && fallbackProvider.capabilities?.suggest !== false
      : typeof braveApiKey === 'string' && Boolean(braveApiKey.trim());
    return {
      ...fallback,
      fetchPage: fetchRecipePage,
      capabilities: { provider: fallback.capabilities?.provider ?? 'legacy', liveSearch: true, renderedFetch: false, authenticated: false, suggest },
    };
  }
  return createMonidTinyFishProvider({ apiKey: monidApiKey, fetchImpl, ...monidOptions });
}

export { createMonidTinyFishProvider } from './monid.js';
export { extractMarkdownRecipe } from './markdown.js';
