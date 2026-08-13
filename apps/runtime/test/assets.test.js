/**
 * @file The asset routes (`/api/admin/assets/*`), with `fetch` stubbed.
 *
 * What is worth pinning here is the PATH, because it is the only part of an
 * upload this server decides. The bytes go browser → Supabase directly
 * (PHASE-2-PLAN.md §1), so nothing below can assert on file content — and
 * nothing in production handles any either.
 *
 *  - The object path is built from a validated slug and the CONTENT TYPE, never
 *    from a filename. The bucket is public, so a filename in the path is a
 *    person's name in a URL anyone can read.
 *  - The delete route takes a path from the console, which makes it the one
 *    place a `..` could reach outside the prefix this console may manage.
 *
 * `lib/db.js` and `lib/storage.js` read their connection per call, so the
 * environment is set at import and UNSET at the end — never restored.
 * `server.test.js` spawns a real server with a copy of this environment.
 */
import { afterAll, afterEach, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

const { handleAdmin } = await import("../routes/admin.js");
const { ASSET_TYPES, MAX_ASSET_BYTES, assetPath } = await import("../lib/storage.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stub `fetch`, recording every call. Rate limiting answers true throughout. */
function stub(responder) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/rpc/rate_hit")) return jsonResponse(true);
      return responder(String(url), init);
    }
  );
  return calls;
}

const SIGNED = { url: `/object/upload/sign/funnel-assets/funnel/lead-gen/${"a".repeat(32)}.webp?token=tok` };

const sign = (body) =>
  handleAdmin(
    new Request("http://console.test/api/admin/assets/sign", { method: "POST", body: JSON.stringify(body) }),
    { path: "/api/admin/assets/sign", url: new URL("http://console.test/api/admin/assets/sign"), server: null },
  );

const remove = (body) =>
  handleAdmin(new Request("http://console.test/api/admin/assets", { method: "DELETE", body: JSON.stringify(body) }), {
    path: "/api/admin/assets",
    url: new URL("http://console.test/api/admin/assets"),
    server: null,
  });

test("signing returns an absolute upload URL and the public URL the document will carry", async () => {
  const calls = stub(() => jsonResponse(SIGNED));

  const res = await sign({ slug: "lead-gen", contentType: "image/webp", size: 120_000 });
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.uploadUrl).toStartWith("https://db.test.invalid/storage/v1/object/upload/sign/funnel-assets/");
  expect(body.publicUrl).toStartWith("https://db.test.invalid/storage/v1/object/public/funnel-assets/funnel/lead-gen/");
  expect(body.path).toMatch(/^funnel\/lead-gen\/[0-9a-f]{32}\.webp$/);

  const signCall = calls.find((c) => c.url.includes("/object/upload/sign/"));
  expect(signCall?.init.method).toBe("POST");
  expect(signCall?.init.headers.authorization).toBe("Bearer service-role-key-not-real");
});

// The extension follows the declared type, not the file the operator picked. A
// public bucket serving `.html` from a field labelled "Image URL" is a different
// object than an image, and the browser owns the filename.
test("the extension comes from the content type", async () => {
  stub(() => jsonResponse(SIGNED));

  for (const [type, ext] of Object.entries(ASSET_TYPES)) {
    const body = await (await sign({ slug: "lead-gen", contentType: type, size: 1000 })).json();
    expect(body.path.endsWith(`.${ext}`)).toBe(true);
  }
  expect(assetPath("lead-gen", "image/png")).toMatch(/\.png$/);
});

test("two uploads for the same funnel never collide", async () => {
  stub(() => jsonResponse(SIGNED));

  const a = await (await sign({ slug: "lead-gen", contentType: "image/webp", size: 10 })).json();
  const b = await (await sign({ slug: "lead-gen", contentType: "image/webp", size: 10 })).json();
  expect(a.path).not.toBe(b.path);
});

test("a slug that is not a slug is refused before anything is signed", async () => {
  const calls = stub(() => jsonResponse(SIGNED));

  for (const slug of ["../../etc", "lead gen", "", "a".repeat(65), "../lead-gen"]) {
    const res = await sign({ slug, contentType: "image/webp", size: 10 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_slug" });
  }
  expect(calls.some((c) => c.url.includes("/object/upload/sign/"))).toBe(false);
});

test("a type outside the allowlist is refused, and so is an oversized declaration", async () => {
  stub(() => jsonResponse(SIGNED));

  for (const contentType of ["text/html", "application/pdf", "image/tiff", ""]) {
    expect((await sign({ slug: "lead-gen", contentType, size: 10 })).status).toBe(400);
  }

  const tooBig = await sign({ slug: "lead-gen", contentType: "image/jpeg", size: MAX_ASSET_BYTES + 1 });
  expect(tooBig.status).toBe(413);
  expect((await sign({ slug: "lead-gen", contentType: "image/jpeg", size: 0 })).status).toBe(413);
});

// The signed URL carries its token in the query string. A Storage failure must
// therefore never reach the log as an error object, and never reach the console
// as a body — the route answers a code and logs `errSummary`.
test("a Storage failure answers 503 and carries no token outward", async () => {
  stub(() => new Response("upstream said no", { status: 500 }));

  const res = await sign({ slug: "lead-gen", contentType: "image/webp", size: 10 });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "storage_unavailable" });
});

test("delete accepts only the path shape this console writes", async () => {
  const calls = stub(() => new Response(null, { status: 204 }));

  const good = `funnel/lead-gen/${"b".repeat(32)}.webp`;
  expect((await remove({ path: good })).status).toBe(200);
  expect(calls.some((c) => c.url.endsWith(`/object/funnel-assets/${good}`) && c.init.method === "DELETE")).toBe(true);

  const before = calls.length;
  for (const bad of [
    `funnel/lead-gen/../../${"b".repeat(32)}.webp`,
    "funnel/lead-gen/../../../etc/passwd",
    `other-bucket/lead-gen/${"b".repeat(32)}.webp`,
    `funnel/lead-gen/${"b".repeat(32)}.phtml`,
    "funnel/lead-gen/notrandom.webp",
    "",
  ]) {
    const res = await remove({ path: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
  }
  // Nothing reached Storage for any of them.
  expect(calls.length).toBe(before);
});

// The operator clicked "remove" and it is not there. That is the outcome they
// asked for, not an error to show them.
test("deleting something already gone reports success", async () => {
  stub(() => new Response("{}", { status: 404 }));

  const res = await remove({ path: `funnel/lead-gen/${"c".repeat(32)}.png` });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, missing: true });
});
