import http from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRecipeApi } from "./lib/recipe-api.mjs";

const routes = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/recipe-import.js", ["recipe-import.js", "text/javascript"]],
  ["/timeline-model.js", ["timeline-model.js", "text/javascript"]],
  ["/storage.js", ["storage.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
const pageRoute =
  /^\/(?:recipes\/?|recipe\/(?:new|edit)\/[a-zA-Z0-9-]+\/?|project\/[a-zA-Z0-9-]+\/?)$/;
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export function createAppServer(options = {}) {
  const handleRecipeApi =
    options.handleRecipeApi || createRecipeApi(options.recipe);
  const cache = new Map();
  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders))
      res.setHeader(name, value);
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (await handleRecipeApi(req, res)) return;
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end("Method not allowed");
        return;
      }
      const route =
        routes.get(pathname) ||
        (pageRoute.test(pathname) ? routes.get("/") : null);
      if (!route) {
        res.writeHead(404);
        res.end(req.method === "HEAD" ? undefined : "Not found");
        return;
      }
      const [name, type] = route;
      const file = new URL(`./public/${name}`, import.meta.url);
      const info = await stat(file);
      let entry = cache.get(name);
      if (
        !entry ||
        entry.modified !== info.mtimeMs ||
        entry.size !== info.size
      ) {
        const body = await readFile(file);
        entry = {
          body,
          modified: info.mtimeMs,
          size: info.size,
          etag:
            '"' + createHash("sha256").update(body).digest("base64url") + '"',
        };
        if (body.length > 1024) {
          const compressed = gzipSync(body);
          entry.gzip = {
            body: compressed,
            etag:
              '"' +
              createHash("sha256").update(compressed).digest("base64url") +
              '"',
          };
        }
        cache.set(name, entry);
      }
      res.setHeader("Vary", "Accept-Encoding");
      const gzip =
        /(?:^|,)\s*gzip\s*(?:,|$)/.test(req.headers["accept-encoding"] || "") &&
        entry.gzip;
      if (gzip) {
        res.setHeader("Content-Encoding", "gzip");
        entry = gzip;
      }
      res.setHeader("Content-Type", `${type}; charset=utf-8`);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("ETag", entry.etag);
      if (
        req.headers["if-none-match"]
          ?.split(",")
          .map((s) => s.trim().replace(/^W\//, ""))
          .some((tag) => tag === entry.etag || tag === "*")
      ) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.setHeader("Content-Length", entry.body.length);
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : entry.body);
    } catch {
      if (!res.headersSent)
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Unable to load Mise Studio");
    }
  });
  server.on("close", () => { handleRecipeApi.close?.(); });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

function applyEnvFile(fileUrl) {
  let text;
  try {
    text = readFileSync(fileUrl, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    process.env[key] = value;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  applyEnvFile(new URL("./.env", import.meta.url));
  applyEnvFile(
    new URL("../../../recipe-discovery-service/.env", import.meta.url),
  );
  const port = Number(process.env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  const host = process.env.HOST || "127.0.0.1";
  const server = createAppServer();
  server.on("error", (error) => {
    console.error(
      `Mise Studio could not start: ${error.code || "server error"}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, host, () =>
    console.log(
      `Mise Studio is running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
}
