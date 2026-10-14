import assert from "node:assert/strict";
import {
  bindRecipeImport,
  bindRecipeSearch,
  importedRecipeToDraft,
} from "../public/recipe-import.js";

function element(id = "") {
  return {
    id,
    value: "",
    hidden: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    disabled: false,
    setAttribute(name, value) { this[name] = value; },
    querySelector() { return null; },
  };
}

const revision = {
  schemaVersion: 1,
  recipeId: "recipe-1",
  revisionId: "revision-2",
  title: "Mapo tofu",
  source: { url: "https://example.test/mapo", publisher: "Example", author: "A. Cook" },
  yield: { raw: "Serves 4 generously", servings: 4 },
  ingredients: [{ id: "i1", raw: "450 g tofu", name: "tofu", quantity: { min: 450, max: 450 }, unit: "g", preparation: "cubed" }],
  steps: [
    { id: "s1", text: "Simmer.", section: null, minutes: 0, durationSource: "explicit", evidence: "0 minutes" },
    { id: "s2", text: "Serve.", section: null, minutes: null, durationSource: "unknown", evidence: null },
  ],
  times: { prep: 10, cook: null, total: null },
  warnings: [{ field: "times.cook", code: "MISSING", message: "Cook time missing" }],
};
const mapped = importedRecipeToDraft(revision);
assert.equal(mapped.ingredientQuantities[0], "", "raw ingredient text is not duplicated into the quantity field");
assert.equal(mapped.steps[0].minutes, 0, "an explicit zero duration is preserved");
assert.equal(mapped.steps[1].minutes, "", "an unknown duration stays blank");
assert.equal(mapped.importMetadata.recipeId, "recipe-1");
assert.equal(mapped.importMetadata.revisionId, "revision-2");
assert.equal(mapped.importMetadata.source.author, "A. Cook");
assert.equal(mapped.importMetadata.yield.raw, "Serves 4 generously");
assert.equal(mapped.importMetadata.times.prep, 10);
assert.equal(mapped.importMetadata.warnings[0].code, "MISSING");
assert.equal(mapped.ingredientMetadata[0].quantity.min, 450);
assert.equal(
  importedRecipeToDraft({ title: "Unknown yield", ingredients: [], steps: [] }).servings,
  "",
  "an unknown yield does not preserve or invent a serving count",
);
const sectioned = importedRecipeToDraft({
  title: "Section test",
  ingredients: [{ raw: "salt" }],
  steps: [{ text: "Stir.", section: "Sauce", minutes: null }],
});
assert.equal(sectioned.steps[0].text, "Stir.", "section labels are not duplicated into editable text");
assert.equal(sectioned.steps[0].section, "Sauce");

{
  const input = element("search-a");
  const listbox = element("list-a");
  const status = element("status-a");
  const calls = [];
  const pending = new Map();
  const binding = bindRecipeSearch({
    input,
    listbox,
    status,
    delayMs: 0,
    search(query, { signal }) {
      calls.push({ query, signal });
      return new Promise((resolve) => pending.set(query, resolve));
    },
  });
  input.value = "mapo";
  input.oninput({ target: input });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  input.value = "ramen";
  input.oninput({ target: input });
  assert.equal(calls[0].signal.aborted, true, "query changes abort immediately");
  pending.get("mapo")({ results: [{ title: "Stale mapo", url: "https://old.test" }] });
  await Promise.resolve();
  assert.doesNotMatch(listbox.innerHTML, /Stale mapo/, "a late response cannot repaint a new query");
  await new Promise((resolve) => setTimeout(resolve, 0));
  binding.dispose();
  assert.equal(calls[1].signal.aborted, true, "dispose aborts the active request");
  assert.equal(input.oninput, null);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const optionTitles = (html) =>
  [...html.matchAll(/recipe-search-option-title">([\s\S]*?)<\/span>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, ""),
  );

{
  const input = element("saved-one");
  const listbox = element("saved-one-list");
  const status = element("saved-one-status");
  let searches = 0;
  bindRecipeSearch({
    input,
    listbox,
    status,
    canSuggest: () => false,
    getSaved: () => ({ a: { id: "a", title: "Mapo tofu", tags: ["Sichuan"] } }),
    search() {
      searches += 1;
      return Promise.resolve({ results: [] });
    },
  });
  input.oninput({ target: { value: "m" } });
  assert.match(listbox.innerHTML, /<mark class="recipe-search-mark">M<\/mark>apo tofu/);
  assert.match(listbox.innerHTML, /data-kind="saved"/);
  assert.equal(searches, 0, "one character paints a saved row before any search");
}

{
  const input = element("rank");
  const listbox = element("rank-list");
  bindRecipeSearch({
    input,
    listbox,
    status: element("rank-status"),
    canSuggest: () => false,
    getSaved: () => ({
      pad: { id: "pad", title: "Pad thai", tags: [] },
      curry: { id: "curry", title: "Thai curry", tags: ["Dinner"] },
    }),
    search: () => Promise.resolve({ results: [] }),
  });
  input.oninput({ target: { value: "thai" } });
  assert.deepEqual(optionTitles(listbox.innerHTML), ["Thai curry", "Pad thai"]);
}

{
  const input = element("stable");
  const listbox = element("stable-list");
  let resolveSearch;
  bindRecipeSearch({
    input,
    listbox,
    status: element("stable-status"),
    delayMs: 0,
    canSuggest: () => false,
    getSaved: () => ({ curry: { id: "curry", title: "Thai curry", tags: ["Dinner"] } }),
    search: () => new Promise((resolve) => {
      resolveSearch = resolve;
    }),
  });
  input.oninput({ target: { value: "thai" } });
  const before = listbox.innerHTML.match(/<li\b[^>]*data-kind="saved"[\s\S]*?<\/li>/)[0];
  await tick();
  resolveSearch({
    results: [{ title: "Weeknight thai", url: "https://web.test/thai", source: "Web", snippet: "Do not copy" }],
  });
  await Promise.resolve();
  const after = listbox.innerHTML.match(/<li\b[^>]*data-kind="saved"[\s\S]*?<\/li>/)[0];
  assert.equal(after, before, "saved row markup stays identical when web results arrive");
  assert.match(listbox.innerHTML, /From the web/);
}

{
  const input = element("suggest-pick");
  const listbox = element("suggest-pick-list");
  const queries = [];
  const searches = [];
  bindRecipeSearch({
    input,
    listbox,
    status: element("suggest-pick-status"),
    delayMs: 5000,
    suggestDelayMs: 0,
    canSuggest: () => true,
    onQuery: (value) => queries.push(value),
    suggest: () => Promise.resolve({ suggestions: ["pad thai", "pasta"] }),
    search(query) {
      searches.push(query);
      return new Promise(() => {});
    },
  });
  input.oninput({ target: { value: "pa" } });
  await tick();
  assert.equal(searches.length, 0, "a two-character query suggests without searching");
  assert.match(listbox.innerHTML, /data-kind="suggest"/);
  assert.equal(optionTitles(listbox.innerHTML)[0], "pad thai");
  input.onkeydown({ key: "ArrowDown", preventDefault() {} });
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(input.value, "pad thai");
  assert.deepEqual(queries, ["pa", "pad thai"]);
  assert.deepEqual(searches, ["pad thai"]);
  assert.equal(input["aria-expanded"], "true");
}

{
  const input = element("suggest-fail");
  const listbox = element("suggest-fail-list");
  const status = element("suggest-fail-status");
  let suggests = 0;
  bindRecipeSearch({
    input,
    listbox,
    status,
    minChars: 9,
    suggestDelayMs: 0,
    canSuggest: () => true,
    suggest() {
      suggests += 1;
      return Promise.reject(new Error("suggest down"));
    },
    search: () => Promise.resolve({ results: [] }),
  });
  input.oninput({ target: { value: "pa" } });
  await tick();
  assert.equal(suggests, 1);
  assert.equal(status.textContent, "");
  assert.doesNotMatch(listbox.innerHTML, /suggest down|unavailable|could not/i);
  input.oninput({ target: { value: "pasta" } });
  await tick();
  assert.equal(suggests, 1, "a failed suggest call is not retried");
  assert.equal(status.textContent, "");
}

{
  const input = element("search-a");
  const listbox = element("arrows-list");
  bindRecipeSearch({
    input,
    listbox,
    status: element("arrows-status"),
    canSuggest: () => false,
    getSaved: () => ({
      alpha: { id: "alpha", title: "Alpha", tags: [] },
      beta: { id: "beta", title: "Beta plate", tags: [] },
    }),
    search: () => Promise.resolve({ results: [] }),
  });
  input.oninput({ target: { value: "a" } });
  assert.match(listbox.innerHTML, /recipe-search-group/);
  assert.equal(input.value, "a");
  const press = (key) => {
    let prevented = false;
    input.onkeydown({
      key,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true, key);
    assert.equal(input.value, "a");
  };
  press("ArrowDown");
  assert.equal(input["aria-activedescendant"], "search-a-option-0");
  press("ArrowDown");
  assert.equal(input["aria-activedescendant"], "search-a-option-1");
  press("ArrowDown");
  assert.equal(input["aria-activedescendant"], "");
  press("ArrowDown");
  assert.equal(input["aria-activedescendant"], "search-a-option-0");
  press("ArrowUp");
  assert.equal(input["aria-activedescendant"], "");
  press("ArrowUp");
  assert.equal(input["aria-activedescendant"], "search-a-option-1");
}

{
  const input = element("keys");
  const listbox = element("keys-list");
  bindRecipeSearch({
    input,
    listbox,
    status: element("keys-status"),
    canSuggest: () => false,
    getSaved: () => ({ a: { id: "a", title: "Mapo tofu", tags: [] } }),
    search: () => Promise.resolve({ results: [] }),
  });
  input.oninput({ target: { value: "mapo" } });
  assert.equal(listbox.hidden, false);
  let prevented = false;
  input.onkeydown({
    key: "Escape",
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(listbox.hidden, true);
  assert.equal(input.value, "mapo");
  input.oninput({ target: { value: "mapo" } });
  assert.equal(listbox.hidden, false);
  let tabPrevented = false;
  input.onkeydown({
    key: "Tab",
    preventDefault() {
      tabPrevented = true;
    },
  });
  assert.equal(tabPrevented, false);
  assert.equal(listbox.hidden, true);
  assert.equal(input.value, "mapo");
}

{
  const input = element("enter-twice");
  const listbox = element("enter-twice-list");
  let selects = 0;
  bindRecipeSearch({
    input,
    listbox,
    status: element("enter-twice-status"),
    canSuggest: () => false,
    getSaved: () => ({ a: { id: "a", title: "Mapo tofu", tags: [] } }),
    onSelectSaved() {
      selects += 1;
    },
    search: () => Promise.resolve({ results: [] }),
  });
  input.oninput({ target: { value: "m" } });
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(selects, 0, "enter with nothing highlighted does not select");
  assert.equal(input["aria-activedescendant"], "enter-twice-option-0");
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(selects, 1);
}

{
  const input = element("paste-url");
  const listbox = element("paste-url-list");
  let searches = 0;
  let suggests = 0;
  let probes = 0;
  bindRecipeSearch({
    input,
    listbox,
    status: element("paste-url-status"),
    canSuggest() {
      probes += 1;
      return true;
    },
    suggest() {
      suggests += 1;
      return Promise.resolve({ suggestions: ["ignored"] });
    },
    search() {
      searches += 1;
      return Promise.resolve({ results: [] });
    },
  });
  input.oninput({ target: { value: "https://recipes.example.com/pad-thai" } });
  assert.equal((listbox.innerHTML.match(/data-kind="/g) || []).length, 1);
  assert.match(listbox.innerHTML, /data-kind="url"/);
  assert.match(listbox.innerHTML, /Import this link/);
  assert.match(listbox.innerHTML, /recipes\.example\.com/);
  assert.equal(searches, 0);
  assert.equal(suggests, 0);
  assert.equal(probes, 0);
}

{
  const input = element("cache-query");
  const listbox = element("cache-query-list");
  const calls = [];
  bindRecipeSearch({
    input,
    listbox,
    status: element("cache-query-status"),
    delayMs: 0,
    canSuggest: () => false,
    search(query) {
      calls.push(query);
      return Promise.resolve({
        results: [{ title: "Pad Thai Bowl", url: "https://example.test/pad", source: "Example" }],
      });
    },
  });
  input.oninput({ target: { value: "Pad  Thai " } });
  await tick();
  input.oninput({ target: { value: "pad thai" } });
  await tick();
  assert.deepEqual(calls, ["Pad Thai"]);
  input.onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(listbox.hidden, true);
  input.onfocus();
  assert.match(listbox.innerHTML, /Pad Thai Bowl|Bowl/);
  assert.equal(listbox.hidden, false);
  assert.deepEqual(calls, ["Pad Thai"]);
}

{
  const input = element("ime");
  const listbox = element("ime-list");
  const calls = [];
  bindRecipeSearch({
    input,
    listbox,
    status: element("ime-status"),
    delayMs: 0,
    canSuggest: () => false,
    search(query) {
      calls.push(query);
      return new Promise(() => {});
    },
  });
  listbox.innerHTML = "";
  input.oncompositionstart();
  input.oninput({ isComposing: true, target: { value: "mapo" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, []);
  assert.equal(listbox.innerHTML, "");
  input.oncompositionend({ target: { value: "mapo" } });
  await tick();
  assert.deepEqual(calls, ["mapo"]);
}

{
  const input = element("stale-both");
  const listbox = element("stale-both-list");
  const searches = [];
  const suggests = [];
  let resolveSearch;
  let resolveSuggest;
  let selected;
  const binding = bindRecipeSearch({
    input,
    listbox,
    status: element("stale-both-status"),
    delayMs: 0,
    suggestDelayMs: 0,
    canSuggest: () => true,
    getSaved: () => ({ a: { id: "a", title: "Mapo tofu", tags: ["Hot"] } }),
    onSelectSaved(recipe) {
      selected = recipe;
    },
    search(query, { signal }) {
      searches.push({ query, signal });
      return new Promise((resolve) => {
        resolveSearch = resolve;
      });
    },
    suggest(query, { signal }) {
      suggests.push({ query, signal });
      return new Promise((resolve) => {
        resolveSuggest = resolve;
      });
    },
  });
  input.oninput({ target: { value: "ma" } });
  await tick();
  const firstSuggest = resolveSuggest;
  input.oninput({ target: { value: "mapo" } });
  assert.equal(suggests[0].signal.aborted, true, "a new key aborts suggest immediately");
  firstSuggest({ suggestions: ["stale ma noodles"] });
  await Promise.resolve();
  assert.doesNotMatch(listbox.innerHTML, /stale ma noodles/);
  await tick();
  const searchSignal = searches[0].signal;
  const suggestSignal = suggests.at(-1).signal;
  input.onkeydown({ key: "ArrowDown", preventDefault() {} });
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(selected.id, "a");
  assert.equal(searchSignal.aborted, true, "select aborts the search");
  assert.equal(suggestSignal.aborted, true, "select aborts suggest");
  resolveSearch({ results: [{ title: "Stale search", url: "https://stale.test/s" }] });
  resolveSuggest({ suggestions: ["stale suggestion"] });
  await Promise.resolve();
  assert.doesNotMatch(listbox.innerHTML, /Stale search|stale suggestion/);
  input.oninput({ target: { value: "soup" } });
  await tick();
  const disposeSignal = searches.at(-1).signal;
  binding.dispose();
  assert.equal(disposeSignal.aborted, true);
  assert.equal(input.onblur, null);
  assert.equal(listbox.onmousedown, null);
}

{
  const input = element("catalog");
  const listbox = element("catalog-list");
  const result = {
    catalog: true,
    recipeId: "rid-9",
    title: "Catalog stew",
    url: "https://example.test/stew",
    source: "Shelf",
  };
  let selected;
  bindRecipeSearch({
    input,
    listbox,
    status: element("catalog-status"),
    delayMs: 0,
    canSuggest: () => false,
    onSelectOnline(item) {
      selected = item;
    },
    search: () => Promise.resolve({ results: [result] }),
  });
  input.oninput({ target: { value: "stew" } });
  await tick();
  assert.match(listbox.innerHTML, /Stored recipes/);
  assert.match(listbox.innerHTML, /data-kind="catalog"/);
  assert.doesNotMatch(listbox.innerHTML, /From the web/);
  input.onkeydown({ key: "ArrowDown", preventDefault() {} });
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(selected, result);
  assert.equal(selected.recipeId, "rid-9");
}

{
  const input = element("escape-late");
  const listbox = element("escape-late-list");
  let resolveSearch;
  bindRecipeSearch({
    input,
    listbox,
    status: element("escape-late-status"),
    delayMs: 0,
    loadingDelayMs: 1000,
    canSuggest: () => false,
    search: () => new Promise((resolve) => {
      resolveSearch = resolve;
    }),
  });
  input.oninput({ target: { value: "abcd" } });
  await tick();
  input.onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(listbox.hidden, true);
  assert.equal(input.value, "abcd");
  resolveSearch({ results: [{ title: "Late dish", url: "https://late.test/d", source: "Late" }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(listbox.hidden, true, "a late response after Escape does not reopen the list");
  assert.doesNotMatch(listbox.innerHTML, /Late dish/);
  assert.equal(input.value, "abcd");
}

{
  const input = element("loading");
  const listbox = element("loading-list");
  const status = element("loading-status");
  let resolveSearch;
  bindRecipeSearch({
    input,
    listbox,
    status,
    delayMs: 0,
    loadingDelayMs: 40,
    canSuggest: () => false,
    search: () => new Promise((resolve) => {
      resolveSearch = resolve;
    }),
  });
  input.oninput({ target: { value: "soup" } });
  await tick();
  assert.doesNotMatch(listbox.innerHTML, /Searching/);
  assert.notEqual(status.textContent, "Searching…");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.match(listbox.innerHTML, /Searching…/);
  assert.equal(status.textContent, "Searching…");
  resolveSearch({ results: [{ title: "Soup bowl", url: "https://example.test/soup", source: "Example" }] });
  await Promise.resolve();
  assert.doesNotMatch(listbox.innerHTML, /Searching/);
}

{
  const nodes = Object.fromEntries([
    "#import-status", "#import-choices", "#import-url", "#import-text",
    "#import-from-url", "#import-from-text", "#recipe-title",
  ].map((id) => [id, element(id.slice(1))]));
  const generated = new Map();
  globalThis.document = {
    querySelector(selector) {
      if (nodes[selector]) return nodes[selector];
      if (selector.startsWith("#import-field-")) {
        if (!generated.has(selector)) generated.set(selector, element(selector.slice(1)));
        return generated.get(selector);
      }
      return null;
    },
  };
  let resolveImport;
  const draft = { title: "", servings: 2, ingredients: [""], ingredientQuantities: [""], steps: [{ text: "", minutes: "" }], sourceUrl: "" };
  const binding = bindRecipeImport(draft, () => {}, {
    request: () => new Promise((resolve) => { resolveImport = resolve; }),
  });
  const running = binding.run({ url: revision.source.url });
  draft.title = "My edited title";
  resolveImport({ status: "ready_for_review", warnings: [], recipes: [revision] });
  await running;
  assert.equal(draft.title, "My edited title", "a late import preserves an edited field");
  assert.deepEqual(draft.ingredients, ["450 g tofu"], "unchanged fields still populate");
  assert.match(nodes["#import-choices"].innerHTML, /Use imported title/);
  assert.equal(typeof generated.get("#import-field-0").onclick, "function");
  generated.get("#import-field-0").onclick();
  assert.equal(draft.title, "Mapo tofu", "the user can apply an imported conflicting field explicitly");
  binding.dispose();
}

{
  const nodes = Object.fromEntries([
    "#import-status", "#import-choices", "#import-url", "#import-text",
    "#import-from-url", "#import-from-text",
  ].map((id) => [id, element(id.slice(1))]));
  globalThis.document = { querySelector: (selector) => nodes[selector] || null };
  let resolveImport;
  const draft = { title: "Keep me", servings: "", ingredients: [""], ingredientQuantities: [""], steps: [{ text: "", minutes: "" }], sourceUrl: "" };
  const binding = bindRecipeImport(draft, () => {}, {
    request: () => new Promise((resolve) => { resolveImport = resolve; }),
  });
  const running = binding.run({ recipeId: "recipe-1" });
  binding.dispose();
  resolveImport({ status: "ready_for_review", warnings: [], recipes: [revision] });
  await running;
  assert.equal(draft.title, "Keep me", "disposing an importer prevents a late result from applying");
}

console.log("PASS: recipe import metadata, explicit/unknown timing, search races, disposal, and draft edit guards.");
