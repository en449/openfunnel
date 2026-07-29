/**
 * Minimal static file server for the zero-build demo. No dependencies — just
 * Node's http + fs. Serves the repo root so the demo can import the engine
 * source and fetch example JSON over http:// (ES modules don't load from file://).
 *
 * Usage: node scripts/serve.mjs [openDir] [port]
 *   node scripts/serve.mjs demo 4321
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const openDir = process.argv[2] || "demo";
const PORT = Number(process.argv[3] || 4321);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = `/${openDir}/index.html`;
    // Prevent path traversal outside the repo root.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let target = filePath;
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) target = join(target, "index.html");

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  OpenFunnel demo → http://localhost:${PORT}/  (serving ${openDir}/)\n`);
});
