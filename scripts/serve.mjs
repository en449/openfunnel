/**
 * Minimal static file server for the zero-build demo. No dependencies — just
 * Node's http + fs.
 *
 * The demo imports engine source and example JSON over http:// (ES modules do
 * not load from file://), so this has to serve more than `demo/`. It used to
 * serve the whole repo root, which meant `.env`, `.data/leads.jsonl` — real lead
 * PII — and `.git/` were all readable, and `listen(PORT)` binds every interface,
 * so anyone on the same network could read them while the demo was running. The
 * banner said "localhost" and was wrong.
 *
 * Now: loopback only unless explicitly overridden, and only the three
 * directories the demo actually needs.
 *
 * Usage: node scripts/serve.mjs [openDir] [port]
 *   node scripts/serve.mjs demo 4321
 *   DEMO_HOST=0.0.0.0 node scripts/serve.mjs   # opt in to LAN exposure
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd());
const openDir = process.argv[2] || "demo";
const PORT = Number(process.argv[3] || 4321);
// Loopback by default. A static server pointed at a source tree is not something
// to put on a network without saying so out loud.
const HOST = process.env.DEMO_HOST || "127.0.0.1";

/** The only directories the demo needs. Everything else is 404, not 403 — no
 *  point confirming to a prober which paths exist. */
const SERVABLE = [openDir, "packages/engine", "examples"].map((d) => resolve(ROOT, d));

/** Inside `root`, requiring a separator so `/repo-backup` cannot pass for `/repo`. */
const isInside = (target, root) => target === root || target.startsWith(root + sep);

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
    // `req.url` is the raw request target — unlike a WHATWG URL it still holds
    // any `..`, so `normalize` below is what resolves them and the containment
    // check is what stops them.
    const filePath = normalize(join(ROOT, urlPath));
    if (!SERVABLE.some((dir) => isInside(filePath, dir))) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    if (filePath.split(sep).some((part) => part.startsWith("."))) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
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

server.listen(PORT, HOST, () => {
  console.log(`\n  OpenFunnel demo → http://${HOST}:${PORT}/  (serving ${openDir}/, packages/engine/, examples/)\n`);
});
