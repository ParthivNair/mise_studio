# Mise Studio

Run `node server.mjs`, then visit http://localhost:8000. Node.js 22+; no packages or API keys required. Typing a dish name searches public recipe indexes (TheMealDB, Forkify, and DuckDuckGo when available). A Brave search key is optional.

## Projects

Create a project and set its name, guest count, and date. Add named courses with serving times, drag their handles to reorder, and add dishes. Enter in a dish field creates the next dish. Projects save locally and can be resumed or deleted from the homepage.

## Saved recipes

Open Saved recipes on the homepage and type a dish name the way you would in Google. Matching saved recipes appear immediately, then public web recipes. Select a web result or paste a link to open a new recipe draft filled with whatever the source provides. That draft is not added to your library until you choose Save recipe, so you can edit ingredients, steps, and times first. Imported instructions keep their original wording; each step still needs a duration in minutes before you can save (zero and fractional minutes are supported). You can also create a recipe from scratch with New recipe. Enter in an ingredient field adds the next line. Save recipe adds it to your library; click its card to edit it.

Unfinished recipes and edits are stored as drafts and survive refreshing their editor URL. They become available in the saved library only after Save recipe succeeds.

## Attach recipes to projects

Finalize the planner to open Recipes. Select a saved recipe for each dish, or use Create new recipe. A recipe created from a project is attached to that dish on save, and you return to the same project. Recipes created from the homepage return to the library. Skip for now leaves a dish unassigned; use the dish buttons to revisit it.

Continue opens Ingredients and combines ingredients from attached saved recipes. Full ingredient text is preserved, including alternatives, quantities, and preparation notes. Repeated entries are merged ignoring capitalization and whitespace; differently worded ingredients remain separate. Editing a saved recipe updates every project using it.

Existing projects are migrated from the previous storage format. Previous online selections remain in the data, but must be replaced with saved recipes to contribute to the new ingredient list. Recipes can be typed by hand, found by searching a dish name, or imported from a public recipe URL or labelled text in the recipe editor. Imported steps keep their wording; durations stay blank until you fill them in. No browser-side API credentials are used.

All projects, drafts, and recipes are stored in this browser on this device. Clearing site data removes them; there is no cloud synchronization.

## Validation

Run `node test.mjs` and `node infrastructure.test.mjs` (or `npm test`) for the workflow and infrastructure suites. The former uses a simulated DOM for workflow tests covering the planner, persistence, deletion, recipe creation and editing, tags, validation, failed storage writes, project attachment and return, skipping, and ingredient aggregation. Run `node --check public/app.js`, `node --check public/recipe-import.js`, and `node --check server.mjs` for syntax checks. Browser visual QA is not part of this test suite.

## Ingredient list editing

Use row checkboxes or Select all to apply bulk actions to a project's ingredient list. Omit grays out selected entries and the row’s Include button restores them. Combine joins selected names with commas and preserves their dish labels. Use a combined entry’s Separate button to restore its original entries, including ingredient names that already contain commas. These changes persist with the project and do not edit the saved recipes.

## Timeline

Open a project's Timeline tab for a full-width, horizontally scrollable cooking schedule. Steps run sequentially backward from each course's serving time. Each dish has its own color and legend entry; overlapping blocks occupy separate lanes. Hover or focus a block to read the full instructions, duration, and start/end times.

All dishes appear beside their labels on the left axis. Use the zoom slider to change the time scale. Labels remain pinned to the left while scrolling horizontally. Each visible row expands to fit overlapping steps of that dish, then contracts when the overlap is removed. Drag a block horizontally to shift it and every downstream step of that dish. Dragged block start times snap to five-minute clock marks. Left/right arrows move the focused step to the previous/next five-minute mark. Downstream steps retain their durations and relative spacing. Edits and zoom save with the project. Reset timeline clears timing edits and reconstructs the schedule from the current recipes and serving times. Changed recipe instructions or durations invalidate that dish's old timing edits.

Cooking planner opens the right-hand drawer with a chronological start-time list for all scheduled dishes. It updates after timeline edits. Missing recipes, serving times, or step durations are listed as items needing attention. No duration is guessed. Courses are interpreted in planner order; when a subsequent course has an earlier clock time, it is treated as the next day. Earlier prep times and overnight courses show day offsets next to the clock time.

Timeline tests exercise scheduling, stacking, service markers, visibility, zoom, dragging downstream steps, persistence, reset, chronological list ordering, hover details, zero-duration steps, missing data, recipe edits, and midnight rollover.

## Runtime and maintenance

The app remains a local-first, single-device application. There is no account system, database, or cloud backup. The production hardening here does not change that model. For public deployment, terminate HTTPS at a reverse proxy, run Node under a process supervisor, and set HOST and PORT explicitly; localhost:8000 remains the default. Browser storage is isolated by origin, so changing the hostname, port, or protocol does not migrate existing projects.

The server serves only allowlisted assets and application routes, accepts GET and HEAD for pages, and POST for recipe import. Same-origin `connect-src 'self'` allows the app to call `/api/recipe-import` and `/api/recipe-search`. Import and search reuse the sibling recipe-discovery-service modules. Fonts continue to load from Google Fonts with the existing local fallbacks.

Saved data is validated before rendering. If stored data is malformed or unreadable, it is preserved and writes are blocked. A stale tab cannot overwrite changes saved by a newer tab; retain any unsaved text before reloading it. Ordinary edits retain immediate local persistence. Do not clear browser storage to troubleshoot without first backing it up through browser tools.

Source layout: public/app.js contains UI workflows; public/recipe-import.js adapts imported recipes into drafts; public/storage.js owns saved-data validation and legacy migration; public/timeline-model.js contains pure scheduling calculations; public/style.css contains presentation; server.mjs is the HTTP server; lib/recipe-api.mjs handles recipe import and search. test.mjs covers user workflows, and infrastructure.test.mjs covers storage and HTTP contracts.

Formatting: pnpm dlx prettier@3.6.2 --write public/*.js public/style.css server.mjs lib/*.mjs *.test.mjs test.mjs. The formatter is a development tool, not an application dependency. npm run build checks JavaScript syntax. Automated tests exercise DOM handlers and HTTP responses; they are not a browser visual regression suite.

