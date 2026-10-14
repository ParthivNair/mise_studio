# Dish search → reusable recipe → editable draft

Development plan, September 18, 2026. This supersedes the implementation sequence in `recipe-import-plan.md`. Status: repository review and plan complete; feature changes proposed, not implemented.

## Objective

Search for a dish from the recipe library or a project's dish screen, select a matching recipe, and immediately populate the normal recipe editor. Preserve ingredient quantities, ordered instructions, yield, attribution, and available timing. The user edits and saves the draft; importing does not silently save or attach it. Reusing a previously resolved recipe must not require searching and scraping it again.

Support open-ended dish queries, including regional names. Search does not guarantee that every dish has an accessible source, and a search snippet is not a recipe. Offer alternatives or pasted text when a source cannot be resolved. Never substitute an unrelated dish or fabricate missing instructions.

## What the audit found

- The application is in `mise_studio/mise_studio`; its Git root is the outer `mise_studio`. The sibling `recipe-discovery-service` is outside that Git root. `lib/recipe-api.mjs` imports directly from that sibling, so a clean application checkout is not self-contained.
- Existing search, URL/text import, editable drafts, local persistence, project attachment, and timeline behavior already work under the current automated tests. Keep these capabilities.
- `public/recipe-import.js` retains only one search result set per binding. This does not survive navigation or process restarts and is not a reusable recipe catalog. The import API fetches and extracts the selected URL each time.
- The draft adapter discards author, publisher, raw yield, recipe-level times, warnings, and structured source metadata. It blanks every step duration. Save reconstruction in `public/app.js` retains only `sourceUrl` from import metadata.
- Saving requires a duration on every step. `public/storage.js`, recipe summaries, and `public/timeline-model.js` need coordinated changes before supporting explicit unknown durations. In particular, `Number(null)` is zero: simply adding nullable storage would incorrectly schedule unknown times.
- `src/search.js` combines Brave, public catalog lookups, and DuckDuckGo HTML parsing. Consolidate around a provider boundary rather than adding another branch to this file.
- Search requests are invalidated when the next network search starts, rather than immediately on every query change. An old response can repaint during the debounce window. Selection and unmount also need explicit cancellation and disposal.
- There are pre-existing modified and untracked application files. Preserve that work; no reset or blanket deletion. The old planning document describes several now-implemented features as future work.

Baseline: application `npm test` and `npm run build` passed during this review. The Sol audit also ran the sibling service's 61 tests and syntax check successfully. The app tests use a simulated DOM and HTTP checks, not a real browser. No live Monid recipe extraction has been demonstrated.

The Sol audit also confirmed that `src/extract.js` currently derives recipe IDs from source URL, title, ingredients, and steps. These IDs change with content edits and must not become durable catalog identities. Preserve the existing ingredient section metadata in the new contract alongside raw text.

## Monid decision

Use Monid/TinyFish as a replaceable server-side discovery and rendered-fetch provider. It supplies source material; our application owns recipe identity, normalization, persistence, and draft behavior.

The [announcement](https://monid.ai/blog/tinyfish) advertises free live search and browser-rendered Markdown fetches. At review time the linked [TinyFish catalog](https://monid.ai/tools/tinyfish) says “No endpoints here yet.” This does not establish that the service is unavailable, but it does mean its request/response contract is unverified. The page does not establish the claimed launch date either.

The general [inspect API](https://monid.ai/docs/api/inspect) documents authenticated schema and price inspection. The [run API](https://monid.ai/docs/api/run) supports immediate results and asynchronous jobs. Product integration must verify whether the advertised keyless access applies to server applications or only agent setup; do not assume it from the blog. Use the [direct integration documentation](https://monid.ai/docs/integrations/direct/setup) for server credentials where required.

First integration checkpoint: discover and inspect the actual TinyFish endpoints; record sanitized input/output fixtures, authentication, price, limits, permitted persistence, and error states. Demonstrate one dish query and one selected recipe fetch. Do not guess endpoint paths or claim a working integration from mocks. Keep the existing working provider available until this checkpoint passes. Runtime access is limited to configured search/fetch endpoints, with no automatic paid escalation.

Markdown may omit JSON-LD. Retain the current protected HTML fetch and structured-data extractor as a useful ingestion path. Route rendered text through a distinct text adapter; do not feed Markdown into the HTML JSON-LD parser. If deterministic parsing is insufficient, evaluate a constrained extraction model against the fixture corpus before adding it. Such a model must preserve source evidence, emit validated JSON, and leave absent fields unknown; its output is cached after validation.

## Data model and identity

Use three separate entities:

1. **Dish:** a searchable concept, such as “mapo tofu,” with curated/confirmed aliases and optional cuisine/variant information. “Vegan mapo tofu” remains distinguishable. Queries can return recipes before a dish concept has been confidently linked.
2. **Recipe revision:** a normalized version of one source recipe. Different publishers' versions remain separate, even when their titles match.
3. **User recipe/draft:** an editable copy referencing its source revision. Refreshing the catalog never overwrites user edits or silently updates recipes already attached to projects.

Proposed normalized contract:

```ts
type RecipeRevision = {
  schemaVersion: 1;
  recipeId: string;
  revisionId: string;
  dishId: string | null;
  title: string;
  source: {
    url: string | null;
    publisher: string | null;
    author: string | null;
    fetchedAt: string;
    extractorVersion: string;
    contentHash: string;
  };
  yield: { raw: string; servings: number | null };
  ingredients: Array<{
    id: string;
    raw: string;
    name: string | null;
    quantity: { min: number; max: number } | null;
    unit: string | null;
    preparation: string | null;
  }>;
  steps: Array<{
    id: string;
    text: string;
    section: string | null;
    minutes: number | null;
    durationSource: 'explicit' | 'unknown';
    evidence: string | null;
  }>;
  times: { prep: number | null; cook: number | null; total: number | null };
  completeness: 'complete' | 'partial';
  warnings: Array<{ field: string; code: string; message: string }>;
};
```

User edits can additionally label durations `user`; estimates, if later added, require a distinct label. Preserve raw ingredient text even when quantity parsing succeeds. Fractions, ranges, package sizes, alternatives, and “to taste” must retain their meaning. Missing is `null`, not zero. Recipe-level time is never divided between steps. Instruction order and repetitions are preserved.

Query keys use Unicode normalization, whitespace normalization, case folding, locale, filters, and query-contract version. Do not strip meaningful words or merge regional variants automatically. Use explicit alias mappings to connect equivalent queries. Source identity uses validated canonical URL plus source recipe-node identity when a page contains multiple recipes. Strip known tracking parameters only; do not discard arbitrary query parameters. Content hashes detect revision changes, not equivalence between every recipe with the same title. Generate storage-compatible IDs; current workspace validation accepts alphanumeric characters and hyphens.

## Persistence and request flow

Add a small SQLite catalog within the application, outside public assets and ignored by Git, with migrations and indexes. Pin a supported runtime/driver during the initial packaging phase. Keep browser-owned projects and personal edits in their current local storage with a versioned migration and recoverable backup. Shared hosting would require workspace isolation; this release retains the existing local application model.

Tables: `dishes`, `dish_aliases`, `recipes`, `recipe_revisions`, `query_results`, and `resolution_jobs`. Index normalized title/alias lookup and canonical source keys. Do not publish pasted personal recipes into a shared catalog.

Request flow:

1. Show matching saved recipes immediately in the browser. Query the local catalog next.
2. Return cached candidates immediately when present. A stale candidate list can refresh in the background; it must not block opening a stored recipe.
3. On a genuine miss, perform one bounded provider search. Normalize candidate metadata and cache the result under the query key.
4. Selecting a candidate resolves its recipe ID/source key. If a validated revision exists, return it immediately. Otherwise fetch, extract, validate, and persist it once.
5. Copy the revision into a new draft, retaining project/dish return context and source identity. Save/attach remains an explicit user action.

Initial policies, configurable and subject to verified provider terms: search results fresh for 24 hours; recipe revisions eligible for background refresh after 30 days; no-result cache 5 minutes; transient-error cooldown 30 seconds. Stale validated recipes remain usable during outages. Failed or partial refreshes must not replace a good revision. Store bounded records and enforce a catalog size limit; never evict browser-owned drafts or saved recipes.

Use a shared in-flight promise per normalized search/source key and a database uniqueness constraint for persisted results. Persist asynchronous job state so a reload can reconnect; expire abandoned jobs after restart with a retryable status. A single user's cancellation detaches that observer without canceling a job still needed elsewhere. Bound provider concurrency, timeouts, response sizes, and retries. Prefer one selected-page fetch over fetching every result while the user types.

Retain `/api/recipe-search` and `/api/recipe-import` as compatibility facades during migration. Add `GET /api/recipes/:id`, `POST /api/recipe-resolve`, and `GET /api/recipe-jobs/:id`. Resolution returns a revision immediately or HTTP 202 with an application job ID. Expose cache/refresh state and structured errors without leaking provider credentials. Search status reports actual provider capabilities.

## Editor behavior

- One shared search component across library, dish chooser, and editor, with saved/catalog results before web results. Prefill the project's dish name.
- Selecting a result opens/populates the editor with actual extracted fields. Show source attribution, unresolved fields, and a small “Needs timing review” indicator where relevant.
- Preserve keyboard navigation, IME composition, focus, and live status announcements. Assign instance-specific option IDs. Invalidate requests on query change, selection, navigation, and disposal; check both request sequence and current query before painting.
- Protect edits made while resolution is running with a draft revision token. Apply automatically only to the unchanged target draft. If the user has typed, show a field-level application choice so late results cannot erase their work.
- Allow saving recipes with unknown durations; the timeline lists the missing timing and excludes those dishes from scheduling until resolved. Fix all duration totals/rendering to avoid reporting unknown as zero.
- Preserve new metadata through draft refresh, save, project attachment, and reload. Keep ingredients useful even before scheduling is complete.

## Sol subagent execution plan

Use `gpt-5.6-sol` for implementation subagents. The primary agent owns shared contracts, integration, review, and acceptance. At most three Sol workers run together. Workers get bounded file ownership and fixture contracts; they do not simultaneously edit `app.js`, storage migrations, or shared API types.

| Wave / owner | Work and ownership | Completion gate |
| --- | --- | --- |
| 0 — primary | Preserve current working tree; document baseline; bring required sibling modules/tests/dependencies inside Git; pin runtime; define schema and provider interfaces. | Clean checkout installs and existing tests pass without sibling folder. |
| 1 — Sol A: provider | Own `lib/recipes/providers/`; verify Monid endpoints and add adapter, bounded async handling, and sanitized contract fixtures. Retain one working fallback until verified. | Live search/fetch evidence plus mocked timeout/auth/rate-limit/terminal-state tests. |
| 1 — Sol B: catalog | Own `lib/recipes/catalog/` and normalization fixtures; implement schema validation, identity, SQLite migration, cached query lookup, revisions, and request deduplication. | Restart, concurrent resolution, alias separation, failed refresh, and migration tests pass. |
| 1 — Sol C: editor | Own `public/recipe-search.js`, draft adapter, and component tests; build against agreed API fixtures. | Cached and asynchronous selection populate editable drafts; stale responses cannot overwrite newer state. |
| 2 — primary | Wire API and `app.js`; coordinate storage migration, save changes, quantity metadata, and timeline readiness. | End-to-end import/save/attach/reload works with unknown times. |
| 3 — Sol A | Remove replaced provider/transport code after reference audit and parity checks; update package/runtime docs. | No app dependency on sibling service or deleted symbols. |
| 3 — Sol B | Exercise cache/identity/concurrency and malformed-source regression corpus. | Measured cache behavior and deterministic fixture results. |
| 3 — Sol C | Real-browser keyboard, navigation, draft-race, refresh, offline, and narrow-screen checks. | Reviewable browser evidence and corrected regressions. |
| Final — primary | Review diffs, run combined acceptance suite, report verified behavior and remaining live-provider limitations. | Release criteria below satisfied. |

## Deletion and retention decisions

**Keep:** protected fetching and its network tests; useful JSON-LD/text extraction; source validation and escaping; local persistence safeguards; project/recipe editor behavior; scheduling and grocery workflows.

**Replace:** external relative imports; monolithic provider orchestration; one-query UI cache as the only reuse mechanism; metadata-dropping draft/save adapters; mandatory-duration save gate; duplicate provider/API validation where a shared contract can own it.

**Remove after replacement passes:** DuckDuckGo HTML scraping and catalog fallback chains superseded by the verified provider; unused autosuggest plumbing if reference checks confirm no consumer; duplicate standalone HTTP/client/setup surfaces once in-repo integration passes. Remove dependencies only after checking remaining imports—Cheerio and network libraries may still be needed for extraction/protected fetching. Keep the sibling service intact until migration is verified and its consumers are checked; move/copy tested behavior before any deletion.

Update the older planning document to point here once implementation begins. Do not rewrite the whole application, replace the scheduler, add a vector database, or build a multi-provider agent framework for this feature. Basic indexed title/alias lookup and persistent recipe revisions solve the immediate problem.

## Acceptance criteria

1. Search “mapo tofu,” select a real source, and receive an editable attributed recipe. Also cover a regional dish, a vegan variant, a non-Latin query, a multi-recipe page, and a no-result query.
2. Repeat a warm query and open a stored recipe after browser refresh and server restart: zero outbound provider calls while fresh. Stale recipe open remains immediate while optional refresh runs separately.
3. Twenty concurrent selections of the same uncached source produce one resolution job/fetch, with no duplicate recipe record.
4. For local development hardware, target warm API p95 under 150 ms and editor population under 300 ms after selecting a cached result. Measure over at least 100 warm operations; report cold latency separately instead of inventing a provider guarantee.
5. Preserve source ingredients, quantities, instruction ordering, raw yield, attribution, and warnings across save/reload. Unknown times stay unknown; zero remains valid. Imported recipes can save and contribute groceries before timing review.
6. Editing during import, changing queries quickly, switching dishes, and leaving/reopening the editor never applies results to the wrong draft or overwrites new edits.
7. Provider outage, invalid output, partial extraction, rate limits, timeouts, and interrupted jobs leave stored recipes accessible and expose actionable states. Search snippets never become full instructions.
8. Existing workspace migration, corrupt-data protection, stale-tab checks, source URL protections, project attachment, ingredient editing, and timeline regressions remain green.
9. Build a roughly 30-case deterministic extraction/normalization corpus and keep live provider calls outside routine tests. Record live source accessibility separately from extraction correctness.
10. Run app and migrated service tests, build, and real-browser QA. Deliver a clean-checkout run procedure, migration/rollback instructions, changed/deleted-file summary, live Monid evidence, and cache measurements.

The release is complete when search reliably yields an editable recipe and subsequent use reuses a persisted, standardized revision. A provider adapter alone does not satisfy the objective.
