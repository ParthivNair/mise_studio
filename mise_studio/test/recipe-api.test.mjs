import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { ApiError } from "../lib/recipes/legacy/errors.js";

const temporary = await mkdtemp(join(tmpdir(), "mise-recipe-api-"));
after(() => rm(temporary, { recursive: true, force: true }));

const sourceUrl = "https://recipes.example.com/mapo-tofu";
const recipeHtml = `<!doctype html><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Weeknight mapo tofu",
  author: { "@type": "Person", name: "Test Cook" },
  recipeYield: "4 servings",
  prepTime: "PT10M",
  recipeIngredient: ["450 g tofu", "2 tbsp chile bean paste"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Simmer the tofu.", totalTime: "PT8M" },
    { "@type": "HowToStep", text: "Serve with rice." },
  ],
})}</script>`;

async function runningServer(recipe) {
  const server = createAppServer({ recipe });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}

async function json(base, path, options) {
  const response = await fetch(base + path, options);
  return { response, body: await response.json() };
}

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("fresh query and resolved recipe survive restart without provider calls", async () => {
  const databasePath = join(temporary, "restart.sqlite");
  let searches = 0;
  let fetches = 0;
  const recipe = {
    databasePath,
    searchProvider: {
      async search({ query }) {
        searches += 1;
        return { query, provider: "fixture", results: [{ id: "candidate", title: "Weeknight mapo tofu", url: sourceUrl, source: "Fixture" }], hasMore: false };
      },
    },
    async fetchPage(url) {
      fetches += 1;
      return { url, html: recipeHtml };
    },
  };
  let app = await runningServer(recipe);
  const coldSearch = await json(app.base, "/api/recipe-search?q=mapo%20tofu");
  assert.equal(coldSearch.response.status, 200);
  assert.equal(coldSearch.body.cache.state, "miss");
  const coldImport = await json(app.base, "/api/recipe-import", post({ url: sourceUrl }));
  assert.equal(coldImport.response.status, 200);
  assert.equal(coldImport.body.recipes[0].title, "Weeknight mapo tofu");
  const recipeId = coldImport.body.recipes[0].recipeId;
  assert.equal(searches, 1);
  assert.equal(fetches, 1);
  await app.close();

  searches = 0;
  fetches = 0;
  app = await runningServer(recipe);
  try {
    const warmSearch = await json(app.base, "/api/recipe-search?q=mapo%20tofu");
    assert.equal(warmSearch.body.cache.state, "fresh");
    const warmImport = await json(app.base, "/api/recipe-import", post({ url: sourceUrl }));
    assert.equal(warmImport.body.cache.state, "fresh");
    assert.equal(searches, 0);
    assert.equal(fetches, 0);

    const byId = await json(app.base, "/api/recipe-import", post({ recipeId }));
    assert.equal(byId.response.status, 200);
    assert.equal(byId.body.recipes[0].recipeId, recipeId);
    const direct = await json(app.base, `/api/recipes/${recipeId}`);
    assert.equal(direct.response.status, 200);
    assert.equal(direct.body.source.author, "Test Cook");
  } finally {
    await app.close();
  }
});

test("twenty concurrent imports share one source fetch", async () => {
  let fetches = 0;
  const app = await runningServer({
    databasePath: join(temporary, "concurrent.sqlite"),
    searchProvider: { search: async () => ({ results: [] }) },
    async fetchPage(url) {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { url, html: recipeHtml };
    },
  });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      json(app.base, "/api/recipe-import", post({ url: sourceUrl })),
    ));
    assert.equal(fetches, 1);
    assert.ok(results.every(({ response }) => response.status === 200));
    assert.equal(new Set(results.map(({ body }) => body.recipes[0].recipeId)).size, 1);
  } finally {
    await app.close();
  }
});

test("resolve jobs become readable and point to the stored recipe", async () => {
  const app = await runningServer({
    databasePath: join(temporary, "jobs.sqlite"),
    searchProvider: { search: async () => ({ results: [] }) },
    fetchPage: async (url) => ({ url, html: recipeHtml }),
  });
  try {
    const started = await json(app.base, "/api/recipe-resolve", post({ url: sourceUrl }));
    assert.equal(started.response.status, 202);
    assert.match(started.body.jobId, /^job-/);
    let job;
    for (let index = 0; index < 30; index += 1) {
      job = (await json(app.base, `/api/recipe-jobs/${started.body.jobId}`)).body;
      if (job.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.status, "complete");
    assert.match(job.recipeId, /^recipe-/);
    assert.equal((await fetch(app.base + `/api/recipes/${job.recipeId}`)).status, 200);
  } finally {
    await app.close();
  }
});

test("malformed requests and private URLs are rejected before provider work", async () => {
  let searches = 0;
  let fetches = 0;
  const app = await runningServer({
    databasePath: join(temporary, "validation.sqlite"),
    searchProvider: { async search() { searches += 1; return { results: [] }; } },
    async fetchPage() { fetches += 1; return { url: sourceUrl, html: recipeHtml }; },
  });
  try {
    const repeated = await json(app.base, "/api/recipe-search?q=mapo&q=tofu");
    assert.equal(repeated.response.status, 400);
    const badCount = await json(app.base, "/api/recipe-search?q=mapo&count=0");
    assert.equal(badCount.response.status, 400);
    const privateImport = await json(app.base, "/api/recipe-import", post({ url: "http://127.0.0.1/recipe" }));
    assert.equal(privateImport.response.status, 400);
    assert.equal(searches, 0);
    assert.equal(fetches, 0);
  } finally {
    await app.close();
  }
});

test("suggest is off when the provider cannot suggest", async () => {
  const app = await runningServer({
    databasePath: join(temporary, "suggest-off.sqlite"),
    searchProvider: { async search() { return { results: [] }; } },
  });
  try {
    const status = await json(app.base, "/api/recipe-status");
    assert.equal(status.body.suggest, false);
    const suggested = await json(app.base, "/api/recipe-suggest?q=mapo");
    assert.equal(suggested.response.status, 200);
    assert.deepEqual(suggested.body, { query: "mapo", provider: "legacy", suggestions: [] });
  } finally {
    await app.close();
  }
});

test("suggest caches equivalent queries and retries failed calls", async () => {
  const seen = [];
  const app = await runningServer({
    databasePath: join(temporary, "suggest-on.sqlite"),
    searchProvider: {
      async search() { return { results: [] }; },
      async suggest({ query, count }) {
        seen.push(query);
        if (query.trim().toLowerCase() === "boom") {
          throw new ApiError(503, "PROVIDER_UNAVAILABLE", "Suggest is unavailable.");
        }
        return { query, count, provider: "fixture", suggestions: ["mapo tofu"] };
      },
    },
  });
  try {
    const status = await json(app.base, "/api/recipe-status");
    assert.equal(status.body.suggest, true);
    const first = await json(app.base, "/api/recipe-suggest?q=Mapo");
    const second = await json(app.base, "/api/recipe-suggest?q=mapo%20");
    assert.equal(first.response.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(seen, ["Mapo"]);
    const extra = await json(app.base, "/api/recipe-suggest?q=Mapo&extra=1");
    assert.equal(extra.response.status, 400);
    assert.deepEqual(seen, ["Mapo"]);
    const failed = await json(app.base, "/api/recipe-suggest?q=boom");
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.error.code, "PROVIDER_UNAVAILABLE");
    const retried = await json(app.base, "/api/recipe-suggest?q=boom");
    assert.equal(retried.response.status, 503);
    assert.deepEqual(seen, ["Mapo", "boom", "boom"]);
  } finally {
    await app.close();
  }
});

test("search reports a catalog hit after a sourced import", async () => {
  const app = await runningServer({
    databasePath: join(temporary, "catalog-hit.sqlite"),
    searchProvider: { async search() { throw new Error("live search should not run"); } },
    async fetchPage(url) { return { url, html: recipeHtml }; },
  });
  try {
    const imported = await json(app.base, "/api/recipe-import", post({ url: sourceUrl }));
    assert.equal(imported.response.status, 200);
    const found = await json(app.base, "/api/recipe-search?q=weeknight");
    assert.equal(found.response.status, 200);
    const hit = found.body.results[0];
    assert.equal(hit.catalog, true);
    assert.equal(hit.recipeId, imported.body.recipes[0].recipeId);
    assert.equal(hit.url, sourceUrl);
    assert.equal(hit.title, "Weeknight mapo tofu");
    assert.equal(hit.source, "recipes.example.com");
  } finally {
    await app.close();
  }
});
