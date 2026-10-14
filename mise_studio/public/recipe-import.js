const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function importedRecipeToDraft(recipe) {
  const servings = recipe.yield?.servings;
  const ingredients = recipe.ingredients?.length ? recipe.ingredients : null;
  const steps = recipe.steps?.length ? recipe.steps : null;
  return {
    title: recipe.title || "",
    servings:
      Number.isInteger(servings) && servings >= 1 && servings <= 999
        ? servings
        : "",
    ingredients: ingredients ? ingredients.map((item) => item.raw || item.name || "") : [""],
    ingredientQuantities: ingredients
      ? ingredients.map(() => "")
      : [""],
    ingredientMetadata: ingredients ? ingredients.map((item) => ({ ...item })) : [],
    steps: steps
      ? steps.map((step) => ({
          text: step.text,
          minutes:
            typeof step.minutes === "number" && Number.isFinite(step.minutes)
              ? step.minutes
              : "",
          durationSource: step.durationSource || (step.minutes == null ? "unknown" : "explicit"),
          evidence: step.evidence ?? null,
          sourceId: step.id || null,
          section: step.section ?? null,
        }))
      : [{ text: "", minutes: "" }],
    sourceUrl: recipe.source?.url || "",
    importMetadata: {
      schemaVersion: recipe.schemaVersion || 1,
      recipeId: recipe.recipeId || recipe.id || null,
      revisionId: recipe.revisionId || null,
      dishId: recipe.dishId || null,
      source: recipe.source ? { ...recipe.source } : null,
      yield: recipe.yield ? { ...recipe.yield } : null,
      times: recipe.times ? { ...recipe.times } : null,
      warnings: (recipe.warnings || []).map((warning) => ({ ...warning })),
      completeness: recipe.completeness || null,
      ingredients: ingredients ? ingredients.map((item) => ({ ...item })) : [],
    },
  };
}

export function applyImportedRecipe(draft, recipe) {
  const mapped = importedRecipeToDraft(recipe);
  if (mapped.title) draft.title = mapped.title;
  draft.servings = mapped.servings;
  draft.ingredients = mapped.ingredients;
  draft.ingredientQuantities = mapped.ingredientQuantities;
  draft.steps = mapped.steps;
  if (mapped.sourceUrl) draft.sourceUrl = mapped.sourceUrl;
  draft.ingredientMetadata = mapped.ingredientMetadata;
  draft.importMetadata = mapped.importMetadata;
  return mapped;
}

export function formatImportNotice(result, recipe) {
  if (result.status === "not_recipe") {
    return "No recipe was found in that source. Paste labelled Ingredients and Instructions, or try another URL.";
  }
  if (result.status === "choose_recipe") {
    return "This page contains more than one recipe. Choose which one to import.";
  }
  const warnings = [
    ...(result.warnings || []),
    ...(recipe?.warnings || []),
  ].map((item) => item.message);
  const parts = [];
  if (result.status === "partial") {
    parts.push("Some fields are missing. Review this draft before saving.");
  } else {
    parts.push(
      `Imported ${recipe.ingredients.length} ingredients and ${recipe.steps.length} steps.`,
    );
  }
  if (recipe?.steps?.some((step) => step.minutes == null))
    parts.push("Some step times are unknown and can be reviewed later.");
  if (warnings.length) parts.push(warnings.slice(0, 4).join(" "));
  return parts.join(" ");
}

export async function requestRecipeImport(body, signal) {
  const response = await fetch("/api/recipe-import", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The import service returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(
      payload.error?.message || "The recipe could not be imported.",
    );
  }
  return payload;
}

export function looksLikeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const url = new URL(text);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host)
    );
  } catch {
    return false;
  }
}

export function matchSavedRecipes(recipes, query) {
  const list = Object.values(recipes || {});
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  if (!needle) return list;
  return list.filter((recipe) => {
    if (String(recipe?.title || "").toLowerCase().includes(needle)) return true;
    return (recipe?.tags || []).some((tag) =>
      String(tag).toLowerCase().includes(needle),
    );
  });
}

export function recipeSearchMarkup({
  id = "recipe-search",
  listId = "recipe-search-list",
  statusId = "recipe-search-status",
  label = "Find a recipe or paste a link",
  placeholder = "Search for a dish, or paste a link",
  value = "",
} = {}) {
  return `<div class="recipe-search"><label for="${esc(id)}">${esc(label)}</label><div class="recipe-search-box"><input id="${esc(id)}" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(listId)}" autocomplete="off" spellcheck="false" maxlength="400" placeholder="${esc(placeholder)}" value="${esc(value)}"><ul id="${esc(listId)}" class="recipe-search-list" role="listbox" aria-label="Recipe suggestions" hidden></ul></div><p id="${esc(statusId)}" class="recipe-search-status" role="status"></p></div>`;
}

function isOffline() {
  return globalThis.navigator?.onLine === false;
}

function searchErrorMessage(error) {
  const code = error?.code;
  if (code === "SEARCH_NOT_CONFIGURED")
    return "Web search is not configured on this server. Paste a link, or pick one of your recipes.";
  if (code === "PROVIDER_RATE_LIMITED")
    return "The search quota was reached. Try again later, or paste a link.";
  if (isOffline())
    return "You appear to be offline. Saved recipes and pasted links still work.";
  if (
    code === "PROVIDER_UNAVAILABLE" ||
    code === "PROVIDER_BAD_RESPONSE" ||
    code === "PROVIDER_TIMEOUT" ||
    code === "PROVIDER_AUTH_FAILED"
  )
    return "Web search is unavailable right now. Paste a link, or pick one of your recipes.";
  return error?.message || "Recipes could not be searched.";
}

function displayQuery(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function queryKey(value) {
  return displayQuery(value).toLowerCase();
}

function highlightQuery(text, query) {
  const raw = String(text ?? "");
  const needle = displayQuery(query);
  if (!needle) return esc(raw);
  const lowerRaw = raw.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (lowerRaw.length !== raw.length || lowerNeedle.length !== needle.length)
    return esc(raw);
  const at = lowerRaw.indexOf(lowerNeedle);
  if (at < 0) return esc(raw);
  return (
    esc(raw.slice(0, at)) +
    '<mark class="recipe-search-mark">' +
    esc(raw.slice(at, at + needle.length)) +
    "</mark>" +
    esc(raw.slice(at + needle.length))
  );
}

function titleRank(title, key) {
  const text = String(title || "").toLowerCase();
  if (!key) return 3;
  if (text.startsWith(key)) return 0;
  const words = text.match(/[a-z0-9]+/g) || [];
  if (words.some((word) => word.startsWith(key))) return 1;
  if (text.includes(key)) return 2;
  return 3;
}

function byRank(items, key, titleOf) {
  return items
    .map((item, index) => ({
      item,
      index,
      rank: titleRank(titleOf(item), key),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

const responseCaches = new WeakMap();
const RESPONSE_CACHE_LIMIT = 50;
const RESPONSE_CACHE_TTL = 5 * 60 * 1000;

function responseCache(fn) {
  let cache = responseCaches.get(fn);
  if (!cache) {
    cache = new Map();
    responseCaches.set(fn, cache);
  }
  return cache;
}

function readCached(fn, key) {
  if (!fn) return undefined;
  const cache = responseCache(fn);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RESPONSE_CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function storeCached(fn, key, value) {
  if (!fn) return;
  const cache = responseCache(fn);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > RESPONSE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function asSuggestions(payload) {
  const list = Array.isArray(payload?.suggestions)
    ? payload.suggestions
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  return list
    .map((item) =>
      typeof item === "string" ? item : item?.query || item?.text || "",
    )
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function asResults(payload) {
  const list = payload?.results || payload?.recipes || [];
  return Array.isArray(list) ? list : [];
}

function isStoredResult(result) {
  return Boolean(
    result?.catalog === true ||
      typeof result?.recipeId === "string" ||
      result?.kind === "catalog" ||
      result?.cached === true ||
      result?.revisionId,
  );
}

let suggestAvailability;

export function recipeSuggestAvailable() {
  if (!suggestAvailability) {
    suggestAvailability = Promise.resolve()
      .then(() =>
        fetch("/api/recipe-status", { headers: { Accept: "application/json" } }),
      )
      .then(async (response) => {
        let payload;
        try {
          payload = await response.json();
        } catch {
          return false;
        }
        if (!response.ok) return false;
        return payload?.suggest === true;
      })
      .catch(() => false);
  }
  return suggestAvailability;
}

export async function requestRecipeSearch(
  query,
  { count = 6, kind = "recipe", signal } = {},
) {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    kind,
  });
  const response = await fetch("/api/recipe-search?" + params, {
    headers: { Accept: "application/json" },
    signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error(
      "The search service returned an unreadable response.",
    );
    error.code = "BAD_RESPONSE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      payload.error?.message || "Recipes could not be searched.",
    );
    error.code = payload.error?.code || "SEARCH_FAILED";
    throw error;
  }
  return payload;
}

export async function requestRecipeSuggest(query, { count = 4, signal } = {}) {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });
  const response = await fetch("/api/recipe-suggest?" + params, {
    headers: { Accept: "application/json" },
    signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error(
      "The search service returned an unreadable response.",
    );
    error.code = "BAD_RESPONSE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      payload.error?.message || "Recipes could not be searched.",
    );
    error.code = payload.error?.code || "SEARCH_FAILED";
    throw error;
  }
  return payload;
}

export function bindRecipeSearch({
  input,
  listbox,
  status,
  getSaved,
  includeSaved = true,
  onSelectSaved,
  onSelectOnline,
  onQuery,
  delayMs = 250,
  minChars = 3,
  search = requestRecipeSearch,
  suggest = requestRecipeSuggest,
  canSuggest = recipeSuggestAvailable,
  suggestDelayMs = 100,
  suggestMinChars = 2,
  loadingDelayMs = 150,
} = {}) {
  if (!input || !listbox) return { dispose() {} };
  let searchTimer;
  let suggestTimer;
  let loadingTimer;
  let searchController;
  let suggestController;
  let searchSeq = 0;
  let suggestSeq = 0;
  let searchInFlight = "";
  let suggestInFlight = "";
  let active = -1;
  let activeKey = "";
  let items = [];
  let open = false;
  let composing = false;
  let disposed = false;
  let dismissed = false;
  let stickOpen = false;
  let showLoading = false;
  let suggestDisabled = false;
  let suggestKnown = false;
  let suggestSupported = false;
  let suggestProbe = null;
  let suggestSoon = false;
  let activeQueryKey = "";
  let searchNote = null;
  let shownSuggest = { key: "", items: [] };
  let shownSearch = { key: "", items: [] };
  const searchSettled = new Set();
  const optionPrefix = `${input.id || "recipe-search"}-option-`;

  const setExpanded = (value) => {
    open = value;
    listbox.hidden = !value;
    input.setAttribute("aria-expanded", value ? "true" : "false");
  };

  const syncActiveDescendant = () => {
    input.setAttribute(
      "aria-activedescendant",
      open && active >= 0 ? optionPrefix + active : "",
    );
  };

  const close = () => {
    setExpanded(false);
    items = [];
    active = -1;
    activeKey = "";
    listbox.innerHTML = "";
    if (status) status.textContent = "";
    syncActiveDescendant();
  };

  const invalidateSearch = () => {
    searchSeq += 1;
    clearTimeout(searchTimer);
    clearTimeout(loadingTimer);
    showLoading = false;
    searchController?.abort();
    searchController = null;
    searchInFlight = "";
  };

  const invalidateSuggest = () => {
    suggestSeq += 1;
    clearTimeout(suggestTimer);
    suggestController?.abort();
    suggestController = null;
    suggestInFlight = "";
  };

  const optionTitle = (item) => {
    if (item.kind === "saved") return item.recipe.title || "Untitled recipe";
    if (item.kind === "url") return "Import this link";
    if (item.kind === "suggest") return item.text;
    return item.result?.title || "";
  };

  const optionMeta = (item) => {
    if (item.kind === "saved")
      return (item.recipe.tags && item.recipe.tags[0]) || "";
    if (item.kind === "url") {
      try {
        return new URL(item.url).hostname;
      } catch {
        return "";
      }
    }
    if (item.kind === "suggest") return "";
    return item.result?.source || "";
  };

  const stableKey = (item) => {
    if (item.kind === "saved") return "saved:" + (item.recipe?.id ?? "");
    if (item.kind === "suggest") return "suggest:" + item.text;
    if (item.kind === "catalog") return "catalog:" + (item.result?.recipeId ?? "");
    if (item.kind === "web") return "web:" + (item.result?.url ?? "");
    return "url:" + (item.url ?? "");
  };

  const applyActive = (nextItems) => {
    if (!activeKey) {
      active = -1;
      return;
    }
    const index = nextItems.findIndex((item) => stableKey(item) === activeKey);
    active = index;
    if (index < 0) activeKey = "";
  };

  const findOption = (id) =>
    globalThis.document?.querySelector("#" + id) ||
    listbox.querySelector?.("#" + id);

  const savedTitleKeys = () => {
    const keys = new Set();
    if (!includeSaved) return keys;
    for (const recipe of Object.values(getSaved?.() || {})) {
      const titleKey = queryKey(recipe?.title || "");
      if (titleKey) keys.add(titleKey);
    }
    return keys;
  };

  const savedRows = (key, text) => {
    if (!includeSaved || !key) return [];
    const recipes = matchSavedRecipes(getSaved?.() || {}, text);
    return byRank(recipes, key, (recipe) => recipe?.title || "")
      .slice(0, 5)
      .map((recipe) => ({ kind: "saved", recipe }));
  };

  const suggestRows = (key, list) => {
    const blocked = savedTitleKeys();
    const seen = new Set();
    const unique = [];
    for (const text of list) {
      const textKey = queryKey(text);
      if (!textKey || textKey === key || blocked.has(textKey) || seen.has(textKey))
        continue;
      seen.add(textKey);
      unique.push(text);
    }
    return byRank(unique, key, (text) => text)
      .slice(0, 4)
      .map((text) => ({ kind: "suggest", text }));
  };

  const remoteRows = (key, results) => {
    const seen = new Set();
    const unique = [];
    for (const result of results) {
      const id =
        (typeof result?.recipeId === "string" && result.recipeId) || result?.url;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(result);
    }
    const stored = [];
    const web = [];
    for (const result of unique) {
      if (isStoredResult(result)) stored.push(result);
      else web.push(result);
    }
    const rankedStored = byRank(stored, key, (result) => result?.title || "");
    const rankedWeb = byRank(web, key, (result) => result?.title || "");
    const cappedStored = rankedStored.slice(0, 6);
    const cappedWeb = rankedWeb.slice(0, Math.max(0, 6 - cappedStored.length));
    return {
      stored: cappedStored.map((result) => ({ kind: "catalog", result })),
      web: cappedWeb.map((result) => ({ kind: "web", result })),
    };
  };

  const channelTexts = (shown, key, textOf) => {
    if (!shown.key || !key.startsWith(shown.key)) return [];
    if (key === shown.key) return shown.items;
    return shown.items.filter((item) =>
      String(textOf(item) || "")
        .toLowerCase()
        .includes(key),
    );
  };

  const pastedUrl = (raw) => {
    const text = String(raw || "").trim();
    return looksLikeHttpUrl(text) ? text : "";
  };

  const eligibleSuggest = (raw) => {
    const text = displayQuery(raw);
    return (
      text.length >= suggestMinChars &&
      !looksLikeHttpUrl(String(raw || "").trim()) &&
      !isOffline() &&
      !suggestDisabled
    );
  };

  const eligibleSearch = (raw) => {
    const text = displayQuery(raw);
    return (
      text.length >= minChars &&
      !looksLikeHttpUrl(String(raw || "").trim()) &&
      !isOffline()
    );
  };

  const paint = () => {
    if (disposed) return;
    const raw = input.value || "";
    const key = queryKey(raw);
    const text = displayQuery(raw);
    if (!key) {
      close();
      return;
    }
    const url = pastedUrl(raw);
    const groups = [];
    if (url) {
      groups.push({
        label: "Paste a link",
        items: [{ kind: "url", url }],
      });
    } else {
      const saved = savedRows(key, text);
      if (saved.length) groups.push({ label: "Your recipes", items: saved });
      const suggestCached = readCached(suggest, key);
      const searchCached = readCached(search, key);
      let suggestions;
      if (suggestCached !== undefined) {
        suggestions = asSuggestions(suggestCached);
        shownSuggest = { key, items: suggestions };
      } else suggestions = channelTexts(shownSuggest, key, (item) => item);
      let results;
      if (searchCached !== undefined) {
        results = asResults(searchCached);
        shownSearch = { key, items: results };
      } else results = channelTexts(shownSearch, key, (item) => item?.title);
      const suggestionsShown = suggestRows(key, suggestions);
      if (suggestionsShown.length)
        groups.push({ label: "Searches", items: suggestionsShown });
      const remote = remoteRows(key, results);
      if (remote.stored.length)
        groups.push({ label: "Stored recipes", items: remote.stored });
      if (remote.web.length)
        groups.push({ label: "From the web", items: remote.web });
    }
    items = groups.flatMap((group) => group.items);
    applyActive(items);
    const remoteCount = items.filter(
      (item) =>
        item.kind === "suggest" || item.kind === "catalog" || item.kind === "web",
    ).length;
    let note = "";
    if (showLoading && searchInFlight === key && remoteCount === 0)
      note = "Searching…";
    else if (!url && isOffline() && key.length >= suggestMinChars)
      note = searchErrorMessage({});
    else if (searchNote && searchNote.key === key) {
      if (searchNote.kind === "error") {
        if (readCached(search, key) === undefined && remoteCount === 0)
          note = searchNote.text;
      } else if (searchNote.kind === "empty" && items.length === 0)
        note = searchNote.text;
    }
    if (!items.length && !note && !stickOpen) {
      close();
      return;
    }
    let index = 0;
    listbox.innerHTML =
      groups
        .map(
          (group) =>
            `<li class="recipe-search-group" role="presentation">${esc(group.label)}</li>` +
            group.items
              .map((item) => {
                const current = index;
                const selected = current === active;
                const meta = optionMeta(item);
                const html = `<li class="recipe-search-option${selected ? " is-active" : ""}" data-kind="${item.kind}" role="option" id="${esc(optionPrefix + current)}" aria-selected="${selected ? "true" : "false"}"><span class="recipe-search-option-title">${highlightQuery(optionTitle(item), text)}</span>${meta ? `<span class="recipe-search-option-meta">${esc(meta)}</span>` : ""}</li>`;
                index += 1;
                return html;
              })
              .join(""),
        )
        .join("") +
      (note
        ? `<li class="recipe-search-message" role="presentation" aria-hidden="true">${esc(note)}</li>`
        : "");
    items.forEach((item, optionIndex) => {
      const option = findOption(optionPrefix + optionIndex);
      if (!option) return;
      option.onclick = () => choose(item);
    });
    setExpanded(true);
    syncActiveDescendant();
    if (status) status.textContent = note;
    if (active >= 0) {
      const option = findOption(optionPrefix + active);
      option?.scrollIntoView?.({ block: "nearest" });
    }
  };

  const runSearch = (key, text) => {
    if (disposed || queryKey(input.value) !== key) return;
    if (readCached(search, key) !== undefined) {
      shownSearch = { key, items: asResults(readCached(search, key)) };
      paint();
      return;
    }
    if (searchInFlight === key) return;
    const my = ++searchSeq;
    const controller = new AbortController();
    searchController = controller;
    searchInFlight = key;
    clearTimeout(loadingTimer);
    showLoading = false;
    loadingTimer = setTimeout(() => {
      if (disposed || dismissed || queryKey(input.value) !== key) return;
      if (searchInFlight !== key) return;
      showLoading = true;
      paint();
    }, loadingDelayMs);
    let pending;
    try {
      pending = search(text, { count: 6, kind: "recipe", signal: controller.signal });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending)
      .then((payload) => {
        if (my !== searchSeq || queryKey(input.value) !== key) return;
        storeCached(search, key, payload);
        searchSettled.add(key);
        searchInFlight = "";
        clearTimeout(loadingTimer);
        showLoading = false;
        if (disposed || dismissed) return;
        const results = asResults(payload);
        shownSearch = { key, items: results };
        searchNote = results.length
          ? null
          : {
              key,
              kind: "empty",
              text: `No recipes found for "${text}".`,
            };
        paint();
      })
      .catch((error) => {
        if (my !== searchSeq || queryKey(input.value) !== key) return;
        searchInFlight = "";
        clearTimeout(loadingTimer);
        showLoading = false;
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        searchSettled.add(key);
        if (disposed || dismissed) return;
        if (readCached(search, key) !== undefined) {
          shownSearch = { key, items: asResults(readCached(search, key)) };
          searchNote = null;
          paint();
          return;
        }
        searchNote = {
          key,
          kind: "error",
          text: searchErrorMessage(error),
        };
        paint();
      });
  };

  const runSuggest = (key, text) => {
    if (disposed || suggestDisabled || queryKey(input.value) !== key) return;
    if (readCached(suggest, key) !== undefined) {
      shownSuggest = { key, items: asSuggestions(readCached(suggest, key)) };
      paint();
      return;
    }
    if (suggestInFlight === key) return;
    const my = ++suggestSeq;
    const controller = new AbortController();
    suggestController = controller;
    suggestInFlight = key;
    let pending;
    try {
      pending = suggest(text, { count: 4, signal: controller.signal });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending)
      .then((payload) => {
        if (my !== suggestSeq || queryKey(input.value) !== key) return;
        storeCached(suggest, key, payload);
        suggestInFlight = "";
        if (disposed || dismissed) return;
        shownSuggest = { key, items: asSuggestions(payload) };
        paint();
      })
      .catch((error) => {
        if (my !== suggestSeq || queryKey(input.value) !== key) return;
        suggestInFlight = "";
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        suggestDisabled = true;
      });
  };

  const armSuggest = (raw, immediate) => {
    const key = queryKey(raw);
    const text = displayQuery(raw);
    if (!eligibleSuggest(raw)) return;
    if (readCached(suggest, key) !== undefined) return;
    if (suggestInFlight === key) return;
    clearTimeout(suggestTimer);
    if (immediate) runSuggest(key, text);
    else suggestTimer = setTimeout(() => runSuggest(key, text), suggestDelayMs);
  };

  const finishSuggestProbe = (ok) => {
    suggestKnown = true;
    suggestSupported = ok === true;
    if (!suggestSupported || disposed || suggestDisabled || dismissed) return;
    const current = input.value || "";
    if (!eligibleSuggest(current)) return;
    const immediate = suggestSoon;
    suggestSoon = false;
    armSuggest(current, immediate);
  };

  const considerSuggest = (raw, immediate) => {
    if (immediate) suggestSoon = true;
    if (!eligibleSuggest(raw)) return;
    if (!suggestKnown) {
      if (suggestProbe) return;
      let result;
      try {
        result = canSuggest();
      } catch {
        finishSuggestProbe(false);
        return;
      }
      if (result && typeof result.then === "function") {
        suggestProbe = Promise.resolve(result).then(
          (ok) => finishSuggestProbe(ok === true),
          () => finishSuggestProbe(false),
        );
        return;
      }
      finishSuggestProbe(result === true);
      return;
    }
    if (!suggestSupported) return;
    armSuggest(raw, immediate);
    if (immediate) suggestSoon = false;
  };

  const considerSearch = (raw, immediate) => {
    if (!eligibleSearch(raw)) return;
    const key = queryKey(raw);
    const text = displayQuery(raw);
    if (readCached(search, key) !== undefined) return;
    if (searchInFlight === key) return;
    clearTimeout(searchTimer);
    if (immediate) runSearch(key, text);
    else searchTimer = setTimeout(() => runSearch(key, text), delayMs);
  };

  const searchOutstanding = (raw) => {
    const key = queryKey(raw);
    if (!eligibleSearch(raw)) return false;
    if (readCached(search, key) !== undefined) return false;
    if (searchSettled.has(key)) return false;
    return true;
  };

  const choose = (item) => {
    if (!item || disposed) return;
    if (item.kind === "suggest") {
      const text = item.text;
      invalidateSearch();
      invalidateSuggest();
      input.value = text;
      active = -1;
      activeKey = "";
      stickOpen = true;
      dismissed = false;
      searchNote = null;
      activeQueryKey = queryKey(text);
      onQuery?.(text);
      paint();
      considerSuggest(text, true);
      considerSearch(text, true);
      return;
    }
    invalidateSearch();
    invalidateSuggest();
    stickOpen = false;
    close();
    if (item.kind === "saved") onSelectSaved?.(item.recipe);
    else if (item.kind === "url") onSelectOnline?.({ url: item.url, title: "" });
    else onSelectOnline?.(item.result);
  };

  const schedule = (raw, { immediateSearch = false, immediateSuggest = false, keepOpen = false } = {}) => {
    if (disposed) return;
    onQuery?.(raw);
    stickOpen = keepOpen;
    const key = queryKey(raw);
    if (!key) {
      invalidateSearch();
      invalidateSuggest();
      activeQueryKey = "";
      shownSuggest = { key: "", items: [] };
      shownSearch = { key: "", items: [] };
      searchNote = null;
      showLoading = false;
      stickOpen = false;
      close();
      return;
    }
    if (key !== activeQueryKey) {
      invalidateSearch();
      invalidateSuggest();
      searchNote = null;
      showLoading = false;
      activeQueryKey = key;
    }
    dismissed = false;
    if (pastedUrl(raw)) {
      paint();
      return;
    }
    if (isOffline()) {
      paint();
      return;
    }
    paint();
    considerSuggest(raw, immediateSuggest);
    considerSearch(raw, immediateSearch);
  };

  const readQuery = (event) => {
    if (event?.target && typeof event.target.value === "string") {
      if (input.value !== event.target.value) input.value = event.target.value;
      return event.target.value;
    }
    return input.value || "";
  };

  const ignoreKey = (event) =>
    event?.isComposing || composing || event?.keyCode === 229;

  const moveHighlight = (direction, opening) => {
    dismissed = false;
    paint();
    if (!items.length) return;
    if (opening) active = direction === "ArrowDown" ? 0 : items.length - 1;
    else if (direction === "ArrowDown") {
      if (active < 0) active = 0;
      else if (active >= items.length - 1) active = -1;
      else active += 1;
    } else if (active < 0) active = items.length - 1;
    else if (active === 0) active = -1;
    else active -= 1;
    activeKey = active >= 0 ? stableKey(items[active]) : "";
    paint();
  };

  listbox.onmousedown = (event) => event.preventDefault?.();
  input.oninput = (event) => {
    if (ignoreKey(event)) return;
    schedule(readQuery(event));
  };
  input.oncompositionstart = () => {
    composing = true;
  };
  input.oncompositionend = (event) => {
    composing = false;
    schedule(readQuery(event));
  };
  input.onfocus = () => {
    if (composing) return;
    dismissed = false;
    const raw = input.value || "";
    const key = queryKey(raw);
    if (!key) return;
    if (
      readCached(search, key) !== undefined ||
      readCached(suggest, key) !== undefined
    ) {
      paint();
      return;
    }
    schedule(raw);
  };
  input.onblur = () => {
    dismissed = true;
    close();
  };
  input.onkeydown = (event) => {
    if (ignoreKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault?.();
      dismissed = true;
      close();
      return;
    }
    if (event.key === "Tab") {
      dismissed = true;
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault?.();
      const opening = !open;
      moveHighlight(event.key, opening);
      return;
    }
    if (event.key !== "Enter") return;
    const raw = input.value || "";
    if (!queryKey(raw)) return;
    event.preventDefault?.();
    if (active >= 0 && items[active]) {
      choose(items[active]);
      return;
    }
    if (pastedUrl(raw)) {
      choose({ kind: "url", url: pastedUrl(raw) });
      return;
    }
    if (!open) {
      schedule(raw, { immediateSearch: true, keepOpen: true });
      return;
    }
    if (searchOutstanding(raw)) {
      schedule(raw, { immediateSearch: true, keepOpen: true });
      return;
    }
    if (items.length) {
      active = 0;
      activeKey = stableKey(items[0]);
      paint();
    }
  };
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(searchTimer);
      clearTimeout(suggestTimer);
      clearTimeout(loadingTimer);
      invalidateSearch();
      invalidateSuggest();
      close();
      input.oninput = null;
      input.oncompositionstart = null;
      input.oncompositionend = null;
      input.onfocus = null;
      input.onblur = null;
      input.onkeydown = null;
      listbox.onmousedown = null;
    },
  };
}

export function bindRecipeImport(draft, redraw, { request = requestRecipeImport } = {}) {
  const status = document.querySelector("#import-status");
  const choices = document.querySelector("#import-choices");
  const urlInput = document.querySelector("#import-url");
  const textInput = document.querySelector("#import-text");
  const urlButton = document.querySelector("#import-from-url");
  const textButton = document.querySelector("#import-from-text");
  if (!status || !urlButton) return { run() {}, dispose() {} };
  let active;
  let disposed = false;

  const editableFields = ["title", "servings", "ingredients", "ingredientQuantities", "steps", "sourceUrl"];
  const snapshot = () => Object.fromEntries(
    editableFields.map((field) => [field, JSON.stringify(draft[field])]),
  );

  const setStatus = (message, kind) => {
    status.textContent = message;
    status.dataset.kind = kind || "info";
  };

  const apply = (result, recipe, before) => {
    if (disposed) return;
    const mapped = importedRecipeToDraft(recipe);
    const conflicts = [];
    for (const field of editableFields) {
      if ((field === "title" || field === "sourceUrl") && !mapped[field]) continue;
      if (JSON.stringify(draft[field]) === before[field]) draft[field] = mapped[field];
      else conflicts.push(field);
    }
    draft.ingredientMetadata = mapped.ingredientMetadata;
    draft.importMetadata = mapped.importMetadata;
    const statusName =
      recipe.title && recipe.ingredients.length && recipe.steps.length
        ? "ready_for_review"
        : "partial";
    draft.importNotice = formatImportNotice(
      { ...result, status: statusName },
      recipe,
    );
    redraw("#recipe-title");
    if (conflicts.length) {
      const currentStatus = document.querySelector("#import-status");
      const currentChoices = document.querySelector("#import-choices");
      if (currentStatus)
        currentStatus.textContent = `${draft.importNotice} Your edits were kept. Choose any imported fields you want to use.`;
      if (currentChoices) {
        currentChoices.innerHTML = conflicts.map((field, index) =>
          `<button type="button" class="secondary" id="import-field-${index}">Use imported ${esc(field.replace(/([A-Z])/g, " $1").toLowerCase())}</button>`,
        ).join("");
        conflicts.forEach((field, index) => {
          const button = document.querySelector("#import-field-" + index);
          if (button) button.onclick = () => {
            draft[field] = mapped[field];
            redraw(field === "title" ? "#recipe-title" : undefined);
          };
        });
      }
    }
  };

  const run = async (body) => {
    if (disposed) return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const before = snapshot();
    choices.innerHTML = "";
    setStatus("Importing…");
    urlButton.disabled = true;
    if (textButton) textButton.disabled = true;
    try {
      const result = await request(body, controller.signal);
      if (disposed || controller.signal.aborted) return;
      if (result.status === "choose_recipe") {
        setStatus(formatImportNotice(result), "info");
        choices.innerHTML = result.recipes
          .map(
            (recipe, index) =>
              `<button type="button" class="secondary" id="import-choice-${index}">${esc(recipe.title || "Untitled recipe")}</button>`,
          )
          .join("");
        result.recipes.forEach((recipe, index) => {
          document.querySelector("#import-choice-" + index).onclick = () =>
            apply(result, recipe, before);
        });
        return;
      }
      if (result.status === "not_recipe" || !result.recipes[0]) {
        setStatus(formatImportNotice(result), "error");
        return;
      }
      apply(result, result.recipes[0], before);
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      setStatus(error.message || "The recipe could not be imported.", "error");
    } finally {
      if (!disposed && active === controller) {
        urlButton.disabled = false;
        if (textButton) textButton.disabled = false;
      }
    }
  };

  urlButton.onclick = () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus("Enter a recipe URL to import.", "error");
      return;
    }
    return run({ url });
  };
  if (textButton) {
    textButton.onclick = () => {
      const text = textInput.value.trim();
      if (!text) {
        setStatus(
          "Paste a recipe with Ingredients and Instructions headings.",
          "error",
        );
        return;
      }
      return run({ text });
    };
  }
  return {
    run,
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.abort();
      urlButton.onclick = null;
      if (textButton) textButton.onclick = null;
      choices.innerHTML = "";
    },
  };
}
