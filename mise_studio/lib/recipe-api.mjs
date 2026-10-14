import { extractTextRecipe } from "./recipes/legacy/extract.js";
import { fetchRecipePage, validatePublicUrl } from "./recipes/legacy/safe-fetch.js";
import { createRecipeProvider } from "./recipes/providers/index.js";
import { createRecipeCatalog } from "./recipes/catalog/index.js";
import { fileURLToPath } from "node:url";
import { ApiError } from "./recipes/legacy/errors.js";

const maxBodyBytes = 300000;
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function send(res, status, body, method) {
  if (res.destroyed || res.writableEnded) return;
  const output = JSON.stringify(body);
  res.writeHead(status, {
    ...jsonHeaders,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(output),
  });
  res.end(method === "HEAD" ? undefined : output);
}

function callerAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      return (
        url.host === req.headers.host &&
        ["http:", "https:"].includes(url.protocol)
      );
    } catch {
      return false;
    }
  }
  const ip = req.socket.remoteAddress;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

async function readJsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send an application/json request body.",
    );
  }
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_ENCODING",
      "Compressed request bodies are not supported.",
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.resume();
      throw new ApiError(
        413,
        "REQUEST_TOO_LARGE",
        "The request body exceeds 300000 bytes.",
      );
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "The body must be a JSON object.");
  }
  return value;
}

function extractionInput(body) {
  const keys = new Set(["url", "text", "sourceUrl", "title", "recipeId"]);
  if (Object.keys(body).some((key) => !keys.has(key))) {
    throw new ApiError(400, "INVALID_REQUEST", "Unexpected request field.");
  }
  const hasUrl = typeof body.url === "string" && body.url.trim().length > 0;
  const hasText = typeof body.text === "string" && body.text.trim().length > 0;
  if (body.recipeId && !hasUrl && !hasText && Object.keys(body).length === 1) {
    if (typeof body.recipeId !== "string" || !/^[a-zA-Z0-9-]+$/.test(body.recipeId))
      throw new ApiError(400, "INVALID_REQUEST", "Invalid recipe identifier.");
    return "stored";
  }
  if (hasUrl === hasText || ("url" in body && "text" in body)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Provide exactly one of url or text.",
    );
  }
  return hasUrl ? "url" : "text";
}

export function createRecipeApi({
  fetchPage,
  searchProvider,
  searchApiKey = process.env.BRAVE_SEARCH_API_KEY || "",
  searchFetch,
  monidApiKey = process.env.MONID_API_KEY || "",
  databasePath = process.env.RECIPE_CATALOG_PATH || fileURLToPath(new URL("../data/recipes.sqlite", import.meta.url)),
  catalogOptions = {},
  timeoutMs = 10000,
  maxPageBytes = 2000000,
  allowedDomains = (process.env.ALLOWED_RECIPE_DOMAINS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
} = {}) {
  const provider = createRecipeProvider({
      monidApiKey,
      braveApiKey: searchApiKey,
      fallbackProvider: searchProvider,
      safeFetcher: fetchPage || fetchRecipePage,
      timeoutMs,
      ...(searchFetch ? { fetchImpl: searchFetch } : {}),
    });
  const search = searchProvider || provider;
  const suggestEnabled = searchProvider
    ? typeof searchProvider.suggest === "function" && searchProvider.capabilities?.suggest !== false
    : provider.capabilities?.suggest === true;
  const suggestCache = new Map();
  const suggestFlights = new Map();
  const suggestTtlMs = 10 * 60 * 1000;
  function cachedSuggest(query, count) {
    const key = `${query.trim().replace(/\s+/g, " ").toLowerCase()}|${count}`;
    const cached = suggestCache.get(key);
    if (cached && Date.now() - cached.at < suggestTtlMs) return cached.value;
    if (cached) suggestCache.delete(key);
    const pending = suggestFlights.get(key);
    if (pending) return pending;
    const flight = Promise.resolve()
      .then(() => search.suggest({ query, count }))
      .then((value) => {
        suggestCache.set(key, { value, at: Date.now() });
        if (suggestCache.size > 200) suggestCache.delete(suggestCache.keys().next().value);
        return value;
      })
      .finally(() => {
        suggestFlights.delete(key);
      });
    suggestFlights.set(key, flight);
    return flight;
  }
  const catalog = createRecipeCatalog({
    ...catalogOptions,
    databasePath,
    searchProvider: search,
    fetchPage: (url, options = {}) => {
      validatePublicUrl(url, { allowedDomains });
      return (fetchPage || provider.fetchPage)(url, { ...options, timeoutMs, maxBytes: maxPageBytes, allowedDomains });
    },
  });
  const methods = new Map([
    ["/api/recipe-status", "GET"],
    ["/api/recipe-search", "GET"],
    ["/api/recipe-suggest", "GET"],
    ["/api/recipe-import", "POST"],
    ["/api/recipe-resolve", "POST"],
  ]);

  const handleRecipeApi = async function(req, res) {
    const url = new URL(req.url, "http://service.local");
    const entity = /^\/api\/(recipes|recipe-jobs)\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
    const method = methods.get(url.pathname) || (entity ? "GET" : null);
    if (!method) return false;
    if (req.method !== method && !(method === "GET" && req.method === "HEAD")) {
      res.setHeader("Allow", method === "GET" ? "GET, HEAD" : method);
      send(res, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Method not allowed for this endpoint.",
        },
      }, req.method);
      return true;
    }
    try {
      if (!callerAllowed(req)) {
        throw new ApiError(
          403,
          "FORBIDDEN_ORIGIN",
          "This API only accepts same-origin browser requests.",
        );
      }
      if (url.pathname === "/api/recipe-status") {
        send(res, 200, {
          import: true,
          search: true,
          suggest: suggestEnabled,
          catalog: true,
          provider: provider.capabilities?.provider || "custom",
        }, req.method);
        return true;
      }
      if (entity) {
        const value = entity[1] === "recipes" ? catalog.getRecipe(entity[2]) : catalog.getJob(entity[2]);
        if (!value) throw new ApiError(404, "NOT_FOUND", "This recipe or job was not found.");
        send(res, 200, value, req.method);
        return true;
      }
      if (url.pathname === "/api/recipe-search" || url.pathname === "/api/recipe-suggest") {
        const accepted = new Set(
          url.pathname === "/api/recipe-search"
            ? ["q", "count", "kind"]
            : ["q", "count"],
        );
        if (
          [...url.searchParams.keys()].some(
            (key) =>
              !accepted.has(key) || url.searchParams.getAll(key).length !== 1,
          )
        ) {
          throw new ApiError(
            400,
            "INVALID_REQUEST",
            "Unknown or repeated query parameter.",
          );
        }
        const query = url.searchParams.get("q") || "";
        const count = url.searchParams.has("count")
          ? Number(url.searchParams.get("count"))
          : 6;
        if (url.pathname === "/api/recipe-suggest" && !suggestEnabled) {
          send(res, 200, {
            query: query.trim(),
            provider: provider.capabilities?.provider || "custom",
            suggestions: [],
          }, req.method);
          return true;
        }
        const result =
          url.pathname === "/api/recipe-search"
            ? await catalog.search({
                query,
                count,
                kind: url.searchParams.get("kind") || "recipe",
              })
            : await cachedSuggest(query, count);
        send(res, 200, result, req.method);
        return true;
      }
      const body = await readJsonBody(req);
      const mode = extractionInput(body);
      let result;
      if (mode === "stored") {
        const recipe = catalog.getRecipe(body.recipeId);
        if (!recipe) throw new ApiError(404, "RECIPE_NOT_FOUND", "This stored recipe was not found.");
        result = { status: recipe.completeness === "complete" ? "ready_for_review" : "partial", recipes: [{ ...recipe, id: recipe.recipeId }], warnings: [], cache: { state: "fresh" } };
      } else if (mode === "url") {
        validatePublicUrl(body.url, { allowedDomains });
        if (url.pathname === "/api/recipe-resolve") {
          const job = catalog.startResolve({ url: body.url, recipeId: body.recipeId });
          send(res, 202, job, req.method);
          return true;
        }
        result = await catalog.resolve({ url: body.url, recipeId: body.recipeId });
      } else result = extractTextRecipe(body);
      if (body.recipeId && mode !== "stored") {
        const selected = result.recipes.find(
          (recipe) => recipe.id === body.recipeId,
        );
        if (!selected) {
          throw new ApiError(
            422,
            "RECIPE_NOT_FOUND",
            "The selected recipe was not found in the supplied content.",
          );
        }
        result = {
          ...result,
          status:
            selected.title &&
            selected.ingredients.length &&
            selected.steps.length
              ? "ready_for_review"
              : "partial",
          recipes: [selected],
        };
      }
      send(res, 200, result, req.method);
    } catch (error) {
      const known = error instanceof ApiError;
      send(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known
            ? error.message
            : "The service could not complete this request.",
        },
      }, req.method);
    }
    return true;
  };
  handleRecipeApi.close = () => catalog.close();
  return handleRecipeApi;
}
