import assert from "node:assert/strict";
import { createAppServer } from "./server.mjs";
import { validateWorkspace, loadWorkspace } from "./public/storage.js";
import { once } from "node:events";
const ddgHtml = `<!doctype html><html><body>
<form action="/html/" method="post"></form>
<div class="result web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frecipes.example.com%2Fsoup">Test soup</a><a class="result__snippet">A bowl of soup.</a></div>
</body></html>`;
const server = createAppServer({
  recipe: {
    databasePath: ":memory:",
    searchApiKey: "",
    searchFetch: async (url) => {
      const href = String(url);
      if (href.includes("html.duckduckgo.com")) {
        return new Response(ddgHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }
      if (href.includes("forkify-api.herokuapp.com")) {
        return new Response(JSON.stringify({ error: "no" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("themealdb.com")) {
        return new Response(JSON.stringify({ meals: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected search fetch " + href);
    },
  },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + server.address().port;
try {
  for (const path of [
    "/",
    "/recipes",
    "/project/test",
    "/recipe/new/test",
    "/recipe/edit/test",
    "/app.js",
    "/recipe-import.js",
    "/timeline-model.js",
    "/storage.js",
    "/style.css",
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.ok(body.length);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      res.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.match(
      res.headers.get("content-security-policy"),
      /connect-src 'self'/,
    );
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(
      head.headers.get("content-length"),
      res.headers.get("content-length"),
    );
    const cached = await fetch(base + path, {
      headers: { "If-None-Match": res.headers.get("etag") },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  }
  const compressed = await fetch(base + "/app.js", {
    headers: { "Accept-Encoding": "gzip" },
  });
  const plain = await fetch(base + "/app.js", {
    headers: { "Accept-Encoding": "identity" },
  });
  assert.equal(compressed.headers.get("content-encoding"), "gzip");
  assert.ok(
    Number(compressed.headers.get("content-length")) <
      Number(plain.headers.get("content-length")),
  );
  assert.equal(await compressed.text(), await plain.text());
  for (const path of [
    "/.env",
    "/server.mjs",
    "/../server.mjs",
    "/%2e%2e/server.mjs",
    "/missing",
    "/api/import-recipe",
    "/api/recipes",
  ])
    assert.equal((await fetch(base + path)).status, 404, path);
  const post = await fetch(base + "/", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  const importGet = await fetch(base + "/api/recipe-import");
  assert.equal(importGet.status, 405);
  assert.equal(importGet.headers.get("allow"), "POST");
  const imported = await fetch(base + "/api/recipe-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "Sample soup\n\nIngredients\n- 1 onion\n\nInstructions\n1. Simmer.",
    }),
  });
  assert.equal(imported.status, 200);
  const importedBody = await imported.json();
  assert.equal(importedBody.status, "ready_for_review");
  assert.equal(importedBody.recipes[0].title, "Sample soup");
  assert.equal(importedBody.recipes[0].steps[0].minutes, null);
  const mixed = await fetch(base + "/api/recipe-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/", text: "nope" }),
  });
  assert.equal(mixed.status, 400);
  const status = await fetch(base + "/api/recipe-status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    import: true,
    search: true,
    suggest: false,
    catalog: true,
    provider: "legacy",
  });
  const search = await fetch(base + "/api/recipe-search?q=soup");
  assert.equal(search.status, 200);
  assert.equal((await search.json()).results[0].title, "Test soup");
  const searchWithKind = await fetch(
    base + "/api/recipe-search?q=soup&count=6&kind=recipe",
  );
  assert.equal(searchWithKind.status, 200);
  const badSearch = await fetch(
    base + "/api/recipe-search?q=soup&kind=recipe&extra=1",
  );
  assert.equal(badSearch.status, 400);
} finally {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
}
const searchable = createAppServer({
  recipe: {
    databasePath: ":memory:",
    searchProvider: {
      async search({ query, kind }) {
        assert.equal(kind, "recipe");
        return {
          query,
          provider: "test",
          results: [
            {
              id: "soup1",
              url: "https://recipes.example.com/soup",
              title: "Test soup",
              source: "recipes.example.com",
              snippet: "A bowl of soup.",
            },
          ],
          hasMore: false,
        };
      },
      async suggest() {
        return { query: "", provider: "test", suggestions: [] };
      },
    },
  },
});
searchable.listen(0, "127.0.0.1");
await once(searchable, "listening");
try {
  const found = await fetch(
    "http://127.0.0.1:" + searchable.address().port + "/api/recipe-search?q=soup",
  );
  assert.equal(found.status, 200);
  const body = await found.json();
  assert.equal(body.results[0].title, "Test soup");
} finally {
  searchable.close();
  searchable.closeAllConnections();
  await once(searchable, "close");
}
const good = {
  projects: {
    p: { id: "p", name: "Dinner", guests: 4, date: "2026-09-07", courses: [] },
  },
  recipes: {},
  drafts: {},
};
assert.equal(validateWorkspace(good).projects.p.name, "Dinner");
assert.equal(Object.getPrototypeOf(validateWorkspace(good).projects), null);
assert.throws(() => validateWorkspace({ projects: [] }));
assert.throws(() =>
  validateWorkspace({
    projects: { p: { ...good.projects.p, guests: '"><img src=x>' } },
  }),
);
assert.throws(() =>
  validateWorkspace({
    projects: {
      p: {
        ...good.projects.p,
        courses: [{ id: 'bad"id', name: "", time: "", dishes: [] }],
      },
    },
  }),
);
assert.equal(
  loadWorkspace(
    {
      getItem: (k) =>
        k === "mise-studio-projects-v1" ? JSON.stringify(good.projects) : null,
    },
    "current",
  ).projects.p.name,
  "Dinner",
);
assert.throws(() => loadWorkspace({ getItem: () => "{invalid" }, "current"));
console.log(
  "PASS: production HTTP routes, HEAD, conditional caching, security headers, private-file denial, removed endpoints, method handling, legacy storage migration, schema validation and safe record maps.",
);
