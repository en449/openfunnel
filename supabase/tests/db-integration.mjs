/**
 * @file End-to-end check: lib/db.js → PostgREST → the Phase 1 Postgres functions.
 *
 * `apps/runtime/test/db.test.js` stubs `fetch`, so it pins how db.js behaves and
 * nothing about whether the SQL on the other side agrees with it. This script is
 * the other half: real HTTP, real PostgREST, real functions. It is deliberately
 * NOT part of `bun test`, because it needs a database and CI has none.
 *
 * Run it whenever the migrations or db.js change. Setup is in ../README.md;
 * the short version, with the cluster already up:
 *
 *   postgrest supabase/postgrest.local.conf &
 *   bun supabase/tests/db-integration.mjs
 *
 * It writes rows and leaves them; point it at a scratch database, never at one
 * holding real leads.
 */
import { createHmac } from "node:crypto";

/* Supabase's service-role key is an HS256 JWT and PostgREST verifies the
 * signature, so mint the local equivalent rather than bypassing auth — the
 * point of this script is that the path it exercises is the production one. */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const claims = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "postgres" })}`;
const secret = process.env.LOCAL_JWT_SECRET || "local-dev-only-not-a-real-secret-32chars";

/* Assigned, not defaulted with `||=`. Bun loads `.env` from the repo root, so a
 * developer with a real Supabase project configured had that URL win — and this
 * script writes rows. It pointed at production and only failed because the REST
 * path differed; with a matching path it would have quietly seeded a live
 * database with test leads. Override deliberately via OF_INTEGRATION_*, never by
 * leaving an environment lying around. */
process.env.SUPABASE_URL = process.env.OF_INTEGRATION_URL || "http://127.0.0.1:4598";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.OF_INTEGRATION_KEY ||
  `${claims}.${createHmac("sha256", secret).update(claims).digest("base64url")}`;
// Standalone PostgREST serves at the root; Supabase mounts it under /rest/v1.
process.env.SUPABASE_REST_PATH = process.env.OF_INTEGRATION_REST_PATH ?? "";

/* A scratch funnel directory, set before the first runtime import because
 * `lib/config.js` resolves it once. `loadFunnel` falls back to this directory
 * when Postgres has no row for a slug, so the fallback needs somewhere to fall
 * back TO that is not the repo's own `examples/`. */
const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
process.env.FUNNELS_DIR = await mkdtemp(join(tmpdir(), "of-integration-funnels-"));

const { rpc, select, dbErrorKind, dbConfigured } = await import("../../apps/runtime/lib/db.js");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures++;
};

check("db is configured", dbConfigured() === true);

/* --- ingest: lead and its delivery rows, atomically --------------------- */

const [ing] = await rpc("ingest_lead", {
  p_slug: "lead-gen",
  p_payload: { lead: { email: "integration@example.invalid", name: "Integration Test" } },
  p_utm: { utm_source: "check" },
  p_dedupe_key: `integration-${Date.now()}`,
});
check("ingest_lead queues one delivery per enabled target", ing.queued === 2, `queued=${ing.queued}`);
check("ingest_lead returns a lead id", typeof ing.lead_id === "string");
check("ingest_lead reports deduped=false on a first insert", ing.deduped === false);

/* --- claiming: the inline first-attempt path ---------------------------- */

const claimed = await rpc("claim_deliveries", { p_limit: 25, p_lead_id: ing.lead_id });
check("claim_deliveries returns both rows", claimed.length === 2, `got ${claimed.length}`);
check("claimed row carries the target kind", claimed.every((c) => typeof c.kind === "string"));
check("claimed row carries the target config", claimed.every((c) => typeof c.config?.url === "string"));
check("claimed row carries the lead payload", claimed[0]?.payload?.lead?.email === "integration@example.invalid");
check("claimed row carries an idempotency key", claimed.every((c) => typeof c.idempotency_key === "string"));
check("attempts is incremented at claim, not at response", claimed.every((c) => c.attempts === 1));

// The whole reason the claim is a single SKIP LOCKED statement.
const again = await rpc("claim_deliveries", { p_limit: 25, p_lead_id: ing.lead_id });
check("a claimed row is not claimable again", again.length === 0, `got ${again.length}`);

/* --- transitions -------------------------------------------------------- */

check(
  "complete_delivery applies to a delivering row",
  (await rpc("complete_delivery", {
    p_id: claimed[0].delivery_id,
    p_attempt: claimed[0].attempts,
    p_key: claimed[0].idempotency_key,
    p_status: 200,
  })) === true,
);
const failStatus = await rpc("fail_delivery", {
  p_id: claimed[1].delivery_id,
  p_attempt: claimed[1].attempts,
  p_key: claimed[1].idempotency_key,
  p_status: 502,
  p_error: "upstream 502",
});
check("fail_delivery reschedules rather than dropping", failStatus === "pending", `status=${failStatus}`);

// The fencing token. A dispatcher that outlived its lease must not be able to
// decide the outcome of a claim it no longer owns.
check(
  "a transition from a superseded attempt is refused",
  (await rpc("complete_delivery", {
    p_id: claimed[1].delivery_id,
    p_attempt: claimed[1].attempts,
    p_key: claimed[1].idempotency_key,
    p_status: 200,
  })) === false,
);

// Compared as a set: claim_deliveries makes no promise about the order it
// returns rows in, so claimed[0] is not necessarily the lower id.
const rows = await select("delivery", `lead_id=eq.${ing.lead_id}&select=status,attempts,last_status`);
check(
  "both states persisted as the state machine says",
  JSON.stringify(rows.map((r) => r.status).sort()) === '["done","pending"]',
  JSON.stringify(rows),
);

/* --- what routes/ingest.js actually sends -------------------------------- */

// `ip_hash` is a bytea column and PostgREST hands the RPC a JSON string, so the
// cast happens on the parameter's declared type using Postgres's `\x` hex input
// format. Get that wrong and every ingest fails with a 400 that reads as a bad
// request rather than as a formatting bug — which, being on the degrade-forward
// path, would silently move every lead in the system back onto the old fan-out.
const { createHash: sha } = await import("node:crypto");
const ipHash = `\\x${sha("sha256").update("salt:203.0.113.7").digest("hex")}`;

const [withIp] = await rpc("ingest_lead", {
  p_slug: "lead-gen",
  p_payload: { lead: { email: "hashed@example.invalid" } },
  p_ip_hash: ipHash,
  p_user_agent: "integration/1.0",
  p_dedupe_key: `iphash-${Date.now()}`,
});
check("a bytea ip_hash is accepted in Postgres hex input format", typeof withIp?.lead_id === "string");

const [storedIp] = await select("lead", `id=eq.${withIp.lead_id}&select=ip_hash,email_verified`);
check("...and round-trips as the same 32 bytes", storedIp?.ip_hash === ipHash, `got ${storedIp?.ip_hash}`);
check("email_verified defaults false when ingest does not assert it", storedIp?.email_verified === false);

// The dedupe key is what turns a double-tapped submit into one delivery.
const dupKey = `dupe-${Date.now()}`;
const first = (await rpc("ingest_lead", { p_slug: "lead-gen", p_payload: { lead: {} }, p_dedupe_key: dupKey }))[0];
const second = (await rpc("ingest_lead", { p_slug: "lead-gen", p_payload: { lead: {} }, p_dedupe_key: dupKey }))[0];
check("a repeated dedupe key returns the first lead", second.lead_id === first.lead_id);
check("...and queues nothing the second time", second.queued === 0 && second.deduped === true);

/* --- the classification /api/lead branches on --------------------------- */

try {
  await rpc("ingest_lead", { p_slug: "definitely-not-a-funnel", p_payload: {} });
  check("an unknown slug throws", false);
} catch (err) {
  // Pinned against the real server, not against what the docs claim: PostgREST
  // maps the PT404 SQLSTATE to HTTP 404, while a plain P0002 would arrive as a
  // generic 500 and read as "database down".
  check(
    "an unknown slug classifies as not_found, not as an outage",
    dbErrorKind(err) === "not_found",
    `kind=${dbErrorKind(err)} code=${err.code}`,
  );
  check("...and it really is an HTTP 404 on the wire", err.status === 404, `status=${err.status}`);
}

/* --- the limiter that replaces the in-process Map ----------------------- */

const key = `integration:${Date.now()}`;
const hits = [];
for (let i = 0; i < 3; i++) hits.push(await rpc("rate_hit", { p_key: key, p_max: 2, p_window_ms: 60000 }));
check("rate_hit binds at the ceiling", JSON.stringify(hits) === "[true,true,false]", JSON.stringify(hits));

/* --- funnel documents in Postgres --------------------------------------- */

const { loadFunnel, listFunnels, saveFunnel, removeFunnel } = await import("../../apps/runtime/lib/funnels.js");

const fSlug = `integration-funnel-${Date.now().toString(36)}`;
const fDoc = { id: fSlug, name: "Integration Funnel", steps: [{ id: "a", type: "content", headline: "Hi" }] };

await saveFunnel(fSlug, fDoc);
const loaded = await loadFunnel(fSlug);
check("saveFunnel creates a row loadFunnel can read back", loaded?.steps?.length === 1);
check("loadFunnel fills in the slug", loaded?.slug === fSlug, `slug=${loaded?.slug}`);
check("listFunnels includes it", (await listFunnels()).includes(fSlug));

await saveFunnel(fSlug, { ...fDoc, name: "Renamed" });
check("saveFunnel updates rather than duplicating", (await loadFunnel(fSlug))?.name === "Renamed");
check(
  "a second save does not create a second row",
  (await select("funnel", `slug=eq.${fSlug}&select=id`)).length === 1,
);

// Archive, not delete: `lead.funnel_id` references this row, so a real delete
// would either fail or take the client's leads with it.
await removeFunnel(fSlug);
check("removeFunnel archives rather than deleting", (await select("funnel", `slug=eq.${fSlug}&select=status`))[0]?.status === "archived");
check("an archived funnel is not served", (await loadFunnel(fSlug)) === null);
check("an archived funnel is not listed", !(await listFunnels()).includes(fSlug));

// ...but ingest still accepts it, on purpose: a visitor who loaded the page
// before it was archived must not lose their lead.
const [archivedIngest] = await rpc("ingest_lead", {
  p_slug: fSlug,
  p_payload: { lead: { email: "late@example.invalid" } },
});
check("ingest still stores a lead for an archived funnel", typeof archivedIngest?.lead_id === "string");

/* --- the directory is a fallback, not a second store --------------------- */

// Postgres holds the funnels once it is configured, but a slug it does not hold
// still comes off disk — otherwise pointing an existing install at a fresh
// Supabase project blanks out every funnel in `examples/`.
const diskSlug = `integration-disk-${Date.now().toString(36)}`;
await writeFile(
  join(process.env.FUNNELS_DIR, `${diskSlug}.json`),
  JSON.stringify({ id: diskSlug, steps: [{ id: "a", type: "content", headline: "From disk" }] }),
  "utf8",
);
check("a slug the database does not hold still loads from disk", (await loadFunnel(diskSlug))?.steps?.length === 1);
check("...and is listed alongside the database's own", (await listFunnels()).includes(diskSlug));

// The dangerous half of that fallback: archiving is a decision, and a decision
// must not be undone by a file the operator forgot about. `loadFromDb` returns
// a sentinel for archived rather than null for exactly this.
await saveFunnel(diskSlug, { id: diskSlug, steps: [{ id: "a", type: "content", headline: "From Postgres" }] });
await removeFunnel(diskSlug);
check("an archived funnel does not resurrect from disk", (await loadFunnel(diskSlug)) === null);
check("...and is not listed either", !(await listFunnels()).includes(diskSlug));

// Saving under an archived slug is an unambiguous statement that the funnel
// should exist again. The row is matched on slug alone, so without this the
// update left `status = 'archived'` forever: the API answered `{ ok: true }`,
// the archived sentinel kept refusing to serve it, and nothing surfaced an
// error anywhere. There is no restore endpoint, so the only way out was SQL.
await saveFunnel(diskSlug, { id: diskSlug, steps: [{ id: "a", type: "content", headline: "Back" }] });
check("saving an archived slug un-archives it", (await loadFunnel(diskSlug))?.steps?.[0]?.headline === "Back");
check(
  "...by moving it to draft rather than straight back to live",
  (await select("funnel", `slug=eq.${diskSlug}&select=status`))[0]?.status === "draft",
);

await rm(process.env.FUNNELS_DIR, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : "\nall integration checks passed");
process.exit(failures ? 1 : 0);
