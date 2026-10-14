# Recipe discovery and import plan

Planning document based on the current checkout and official documentation reviewed September 10, 2026. This document proposes changes; the application has not been modified or an importer benchmarked.

Build URL import into the existing recipe editor first, then add a search dropdown. Keep discovery, extraction, and scheduling separate so a searchable recipe does not become a promise of a complete, accurately timed import.

## What the current app already provides

| Area | Current behavior | Integration consequence |
| --- | --- | --- |
| Runtime | Node 22+, vanilla browser JavaScript, no runtime packages | Add small server modules; a framework rewrite is unnecessary. |
| Server | `server.mjs` only serves allowlisted assets; accepts GET/HEAD; CSP has `connect-src 'none'` | Add explicit API routes, scoped POST handling, and same-origin browser connectivity. |
| Recipe library | `public/app.js:486` searches saved recipes by tag only | Add title/tag matching and a shared search component in the library and dish-selection view. |
| Editor | `startRecipe` at `public/app.js:506`, save logic at `:752` | Populate an ordinary draft and preserve its project/dish return context. |
| Storage | `public/storage.js:15` validates recipes and drafts; `sourceUrl` is supported | Validate added metadata and preserve it when saving. The save function reconstructs objects, so new fields would otherwise disappear. |
| Timeline | `public/timeline-model.js:53` requires every step duration; scheduling is serial, backward from service | Unknown timing requires review. Current scheduling does not manage shared ovens, burners, or cook capacity. |
| Groceries | `public/app.js:917` deduplicates ingredient text | Separate quantity fields and serving scaling are currently ignored. Importing quantities alone will not produce summed shopping totals. |

## Source strategy

Use **selected-page import plus a replaceable web-search provider**. Start with direct URLs and pasted recipe text so the core feature works without a search subscription. Add Brave Web Search for recipe discovery once ingestion is useful. Search supplies candidate titles and URLs; the importer reads a selected recipe page. [Brave Web Search documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)

For extraction, read Schema.org Recipe JSON-LD first. It has explicit ingredient and instruction fields; instructions may be text, ordered steps, or sections containing steps. This provides a standard contract across publishers. [Google recipe structured-data documentation](https://developers.google.com/search/docs/appearance/structured-data/recipe), [Schema.org recipeInstructions](https://schema.org/recipeInstructions)

If measured gaps justify another runtime, add a small Python worker using `recipe-scrapers`, passing already fetched HTML to `scrape_html`. It supports schema formats and publisher-specific parsing, and leaves fetching to the application. Its supported-site list includes Allrecipes and NYT Cooking; this describes parsing support, not guaranteed page access. The library does not bypass bot protection. Keep the worker behind the same import interface. [recipe-scrapers documentation](https://docs.recipe-scrapers.com/), [supported sites](https://docs.recipe-scrapers.com/getting-started/supported-sites/)

Commercial catalog APIs are optional adapters only after their storage permissions fit the product. Edamam's standard web recipes deliberately omit instructions; separately licensed recipes are available. Spoonacular's current standard terms prohibit retaining ingredients, instructions, and derived data, with only narrow exceptions. A persistent local recipe library therefore needs a suitable agreement before using that content. [Edamam documentation](https://developer.edamam.com/edamam-docs-recipe-api), [Spoonacular terms](https://spoonacular.com/food-api/terms)

For each supported publisher, establish the allowed access/use before enabling automated imports. Structured markup is a format, not a content license. Preserve attribution and source links. Use licensed content or user-provided material where appropriate; do not promise universal NYT or Allrecipes access. [recipe-scrapers copyright and usage guidance](https://docs.recipe-scrapers.com/copyright-and-usage/)

## Phase 1: import a URL into a reviewable draft

Proposed modules:

```text
server.mjs                     Explicit API routes and response handling
lib/recipe-fetch.mjs            Bounded outbound HTTP and source policy
lib/recipe-extract.mjs          JSON-LD traversal and optional parser adapters
lib/recipe-normalize.mjs        Shared import contract and warnings
public/recipe-import.js         Import UI and draft adapter
```

Use `POST /api/recipe-import` with either `{ url }` or `{ text, sourceUrl? }`. Pasted text uses the same normalizer, with missing sections left for review. Return a validated draft payload and warnings; saving remains a browser action. Register any new public modules in the server asset allowlist and syntax checks.

Extraction sequence:

1. Fetch an eligible public HTTP(S) page through the server, with no account cookies. Use a proper HTML parser to read `script[type="application/ld+json"]`; do not run page scripts or parse HTML with a single regex.
2. Parse JSON blocks independently so one malformed block does not discard valid siblings. Traverse arrays, `@graph`, array-valued `@type`, nested nodes and local `@id` references with depth/cycle limits.
3. Select the relevant Recipe node. Match the selected page and its main entity when unambiguous; if several plausible recipes exist, let the user choose. Never merge several recipes into one.
4. Normalize title, author/publisher, canonical source URL, ingredients, ordered instructions, yield, and recipe-level times. Support text, `HowToStep`, `HowToSection`, and `itemListElement`/`ListItem` wrappers. Preserve original order, section labels, units, fractions, and preparation notes.
5. Convert HTML in fields to plain text while retaining paragraph/list boundaries. Do not split all prose at periods or remove repeated steps; those operations can change instructions.
6. Preserve the raw yield, such as "12 cookies" or "4–6 servings". Only fill the numeric serving field when the interpretation is clear. Recipe-level prep/cook/total times remain separate from step times.
7. Validate the output and return `ready_for_review`, `partial`, `choose_recipe`, `not_recipe`, `unavailable`, `timeout`, or `unsupported` as appropriate. HTTP/API errors also carry machine-readable codes. Missing instructions are a partial import, never a complete import.

The initial normalized response can have this shape; this is a proposed contract rather than existing code:

```ts
type ImportedRecipe = {
  title: string;
  source: {
    url?: string;
    publisher?: string;
    author?: string;
    fetchedAt: string;
    extractor: string;
    version: string;
  };
  yield: { raw: string; servings: number | null };
  ingredients: { raw: string }[];
  steps: {
    id: string;
    text: string;
    section?: string;
    minutes: number | null;
    durationSource: "explicit" | "estimated" | "user" | "unknown";
    timingEvidence?: string;
    durationRange?: { min: number; max: number };
  }[];
  recipeTimes: {
    prepMinutes: number | null;
    cookMinutes: number | null;
    totalMinutes: number | null;
  };
  warnings: { field: string; code: string; message: string }[];
};
```

For the smallest compatible release, map unknown minutes to the existing draft value `""`, keep full ingredient lines in `ingredients`, and leave their separate quantity entries blank to avoid duplication. Preserve source and timing metadata in explicitly validated additional fields. Use a fresh local UUID and retain `returnTo` when importing for a project dish. Confirmed imports become ordinary saved recipes attached with `provider: "custom"`, which current ingredient and timeline lookups already support.

The draft survives refresh, while the existing save gate requires the user to finish missing durations. A subsequent improvement can allow recipes to be saved with `minutes: null` and display “Needs timing review”; that requires coordinated changes to storage validation, save validation, recipe totals, and timeline readiness checks. Unknown is never zero: zero is already a valid supported duration.

Canonical URLs help detect a previously imported recipe. Offer the existing recipe or a new copy; do not silently refresh and overwrite a saved recipe used by other projects.

## Phase 2: a search dropdown

Use one search box labeled “Find a recipe or paste a link,” shared by Saved recipes and each project's recipe-selection screen. Prefill a project's search with the dish name.

- Show saved title/tag matches immediately, grouped above online candidates.
- After 3 characters and approximately 300 ms idle, request `GET /api/recipe-search?q=...`. Keep this delay configurable.
- Return 5–8 candidates with title, source domain, URL, and optional metadata actually supplied by the provider. Do not invent serving counts, cooking times, or importability badges from snippets.
- Fetch a candidate's full recipe only when selected. Show an import preview, source link, ingredient/step counts, and unresolved fields before saving.
- Cancel old requests with AbortController and use a request sequence check so a late result cannot replace a newer query. Ignore input-method composition until committed.
- Support Up/Down, Enter, Escape, visible keyboard selection, and the combobox/listbox ARIA pattern. Include loading, no-match, offline, quota, and unavailable-provider states. Local matches and direct import remain available when external search is unavailable. [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)

Matching recipe results are enough for the first Google-style dropdown. If literal query completion is wanted later, use a separate `GET /api/recipe-suggest?q=...` adapter; Brave offers an autosuggest endpoint. Selecting a query suggestion searches; selecting a recipe starts its preview. [Brave Autosuggest documentation](https://api-dashboard.search.brave.com/app/documentation/suggest/get-started)

Keep search keys on the server. Provider-result caching is a separate concern from saved recipes, and must follow the selected plan's storage terms. Use bounded transient caches only where permitted; do not build a permanent search-result catalog by default. [Brave API terms](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service)

## Phase 3: reliable steps and useful timing

Extraction should preserve what the author wrote. Scheduling is a separate interpretation of that text.

For example, “Bake for 20–25 minutes, then cool completely” supplies a baking range but no cooling duration. It does not justify a 25-minute duration for the whole step. Preserve the instruction, propose separate tasks if useful, retain the evidence, and ask the user to confirm the missing cooling time.

Start with deterministic recognition of explicit time phrases and ranges, presented as suggestions where a step contains several actions. Never divide `totalTime` by the number of steps. Treat “until golden,” “overnight,” and “while the sauce simmers” as unresolved timing or dependency information.

An optional model can turn available source text into a constrained JSON proposal for actions, dependencies, equipment, and estimated durations. Give it no browsing or execution tools; treat page text as data. Require each proposed task to refer to a source step, retain the original instruction, validate outputs, and label estimates. Never generate absent recipe instructions and present them as extracted. Use this only after deterministic extraction has been measured and only when the content can be sent to the chosen service.

Keep the existing serial scheduler for the first release. Later add stable task IDs, source-step references, duration ranges, active/passive phases, dependencies, equipment requirements and service deadlines. “Chop vegetables while potatoes boil” needs parallel tasks; two dishes needing an oven at different temperatures need resource constraints. Validate dependency cycles and capacity conflicts. Start-time suggestions remain dependent on confirmed durations and kitchen assumptions.

## Phase 4: grocery quantities

First fix the current omission of `ingredientQuantities`: display each complete ingredient entry with its contributing dishes. Avoid silently merging contributions in ways that lose quantities. This is necessary even for recipes entered manually.

Then add optional structured fields such as ingredient identity, quantity range, unit, preparation, and raw text. Scale only after confirming recipe yield and the desired servings for that dish. Sum compatible units for equivalent ingredients; retain ambiguous entries separately. “Two 14-oz cans,” “salt to taste,” alternatives, and volume-to-mass conversions must retain their meaning. This should be tested independently of page extraction.

## API boundaries

The new import endpoint performs outbound requests, so make the network behavior bounded from the start:

- Only public HTTP(S) destinations; reject embedded credentials, localhost, private/link-local/reserved IPv4/IPv6 targets and unexpected ports. Revalidate every redirect and bind the connection to the checked DNS result to avoid DNS-rebinding gaps.
- Bound redirect count, connect/overall timeout, decompressed response size, JSON nesting, recipe count and field sizes. Return a clear failure instead of silently truncating ingredients or steps to editor limits.
- Return normalized JSON rather than arbitrary fetched HTML. Render imported strings as text and validate all link protocols.
- Allow same-origin API calls through CSP (`connect-src 'self'`), keep API secrets server-side, bound request bodies, check Host/Origin as appropriate, and apply request/concurrency limits. Retain the localhost bind by default; shared deployment needs access controls for paid endpoints.
- Avoid arbitrary image proxying in the first release. Text-and-source results work with the existing image policy.

## Validation and release order

1. Build a corpus of approximately 30 representative recipes and failure cases. Start with synthetic/minimized fixtures and include permitted publisher samples. Cover multiple JSON-LD blocks, graph references, nested sections, prose instructions, fractions, non-serving yields, missing fields, HTML entities, malformed markup, oversized content and unavailable pages. Include Allrecipes and NYT as desired targets, recording fetchability separately from parsing.
2. Implement URL/text import and round-trip it through draft persistence, review, save, project attachment, groceries and timeline. Preserve corruption protection, stale-tab detection, manual editing, zero/fractional durations, and midnight behavior.
3. Add search with mocked provider responses. Test cancellation, out-of-order responses, keyboard selection, no results, unavailable keys, quota errors and offline local search.
4. Verify fetch protections with controlled fixtures for redirects, private targets and size/time bounds. Keep live publisher requests out of routine CI.
5. Measure fetch success, complete ingredient/step extraction, field errors and timing completeness separately. A recipe with correct instructions and unknown times is an extraction success with incomplete scheduling. Do not advertise a reliability percentage before this evaluation.
6. Run the existing build and test suites plus browser keyboard/visual QA. Update the current tests that assert import/search controls are absent and API paths return 404; replace those checks with the new route and failure contracts.

The first deliverable is a selected URL becoming an editable, attributed draft with intact ingredients and ordered steps. Search, richer timing, and quantitative groceries can then build on that tested path.
