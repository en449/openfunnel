/**
 * @file The ingest sinks and the fan-out that writes to all of them.
 *
 * `persist()` is where the "ingest must never fail a visitor" invariant is
 * actually implemented: `Promise.allSettled` means a dead webhook, a Supabase
 * outage or a mail failure is a `console.warn`, never an exception that reaches
 * the route handler. The route has already returned 202 by the time these run.
 *
 * Phase 1 demoted the fan-out rather than removing it. It is now the fallback
 * for when the delivery queue could not take a lead — see `fanOut` below — and
 * the reason it survives at all is that it is the only path a self-hoster with
 * no Supabase project ever uses. The legacy `supabaseInsert` that posted the
 * whole record into a flat `leads` table is gone: the schema in
 * `supabase/migrations/` replaced it, and leaving it in place meant every
 * ingest also fired a doomed request at a table that no longer exists.
 */

import { mkdir, appendFile, open, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { forwardMetaCapi } from "./capi.js";
import { DATA_DIR } from "./config.js";
import { notifyOperatorOfLead, sendLeadAutoresponder } from "./email.js";
import { loadFunnel } from "./funnels.js";
import { errSummary } from "./log.js";
import { forwardWebhook } from "./webhook.js";

/* ========================================================================== *
 *  Ceilings
 *
 *  `/api/lead` and `/api/events` are unauthenticated and take a body up to
 *  MAX_BODY, so without a bound the sinks are an anonymous write primitive
 *  against the operator's disk (300 events/min/IP × 64KB ≈ 28GB/day from one
 *  address), and the admin readers turn that into an OOM the moment the
 *  operator opens their own lead inbox.
 *
 *  Two independent bounds, because they fail differently: SINK caps what can be
 *  written, READ caps what is ever held in memory at once. Neither may make
 *  ingest fail a visitor, so the write side rotates rather than refusing.
 *
 *  Read per call, not captured at import — same reason `lib/db.js` does. These
 *  were module-level constants, so whichever module happened to import this file
 *  first decided their values for the whole process, and a test that sets the
 *  environment before its own dynamic import silently got the defaults as soon
 *  as an unrelated file imported the chain earlier. The production value never
 *  changes mid-process, so reading it per call costs nothing and removes an
 *  ordering dependency nobody can see in the file that breaks.
 * ========================================================================== */

/** Per-sink ceiling. At the cap the file rotates to `.1`, so disk peaks at 2×. */
const maxSinkBytes = () => Math.max(1_000_000, Number(process.env.MAX_SINK_BYTES) || 64 * 1024 * 1024);

/** Most bytes a reader will pull into memory — the newest tail of the file. */
const maxReadBytes = () => Math.max(1_000_000, Number(process.env.MAX_READ_BYTES) || 8 * 1024 * 1024);

/** Where the sinks live. Mirrors `config.js`, resolved per call for the same reason. */
const dataDir = () => resolve(process.env.DATA_DIR || DATA_DIR);

/** The sink directory cannot be created — a platform fact, warned about once. */
let warnedNoDataDir = false;

/**
 * Append one record to a JSONL file. Local-first storage: readable with `tail`,
 * importable anywhere, and impossible to lose to a bad migration.
 *
 * Rotates at MAX_SINK_BYTES: the current file becomes `${kind}.jsonl.1` and a
 * fresh one starts, so the pair is bounded and the newest records always survive.
 * Rotation rather than refusal because ingest must never fail a visitor — a full
 * sink has to keep taking the lead the operator paid for the click on. A previous
 * `.1` is overwritten; a deployment that must keep everything ships the file
 * onward (Supabase, webhook) rather than treating this directory as an archive.
 *
 * Mode 0600: these files hold names, emails and phone numbers, and the default
 * 0644 made them world-readable on any multi-user box. Only applied at creation,
 * so an existing sink keeps its mode — `chmod 600 .data/*.jsonl` once, if it
 * predates this.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
async function appendJsonl(kind, record) {
  const dir = dataDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    // A read-only filesystem — which is every serverless deployment — threw
    // here, BEFORE the append's own try/catch, so `persist`'s `allSettled`
    // swallowed it and the sink failed with nothing logged anywhere at all. The
    // lead is not lost (Postgres holds it, or the fan-out delivered it), but the
    // operator's own copy silently is not being written.
    //
    // Once per process, because this is a property of the deployment rather than
    // of this record: repeating it would print a line per lead forever.
    if (!warnedNoDataDir) {
      warnedNoDataDir = true;
      console.warn(
        `[runtime] cannot create ${dir} (${errSummary(err)}) — the JSONL sinks are off, so the ` +
          "console's lead inbox will read empty. Set DATA_DIR to a writable path, or rely on Postgres.",
      );
    }
    return;
  }
  const file = join(dir, `${kind}.jsonl`);

  try {
    const { size } = await stat(file);
    if (size >= maxSinkBytes()) {
      await rename(file, `${file}.1`);
      console.warn(`[runtime] ${kind}.jsonl hit ${maxSinkBytes()} bytes — rotated to ${kind}.jsonl.1`);
    }
  } catch (err) {
    // ENOENT is the normal first write, and the expected loser of a rotation
    // race. Anything else — a permission that blocks `rename` but not
    // `appendFile`, a read-only mount — means the ceiling is not being enforced,
    // and swallowing that silently is how a bounded sink grows unbounded anyway.
    if (/** @type {any} */ (err)?.code !== "ENOENT") {
      console.warn(`[runtime] ${kind}.jsonl rotation check failed: ${errSummary(err)}`);
    }
  }

  // Append failures were silent: `persist()` fans out with `allSettled`, so a
  // full disk or a bad permission dropped the lead with nothing logged at all.
  // Still non-fatal — ingest must not fail the visitor — but no longer invisible.
  try {
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(`[runtime] ${kind}.jsonl append failed: ${errSummary(err)}`);
  }
}

/**
 * Read a JSONL sink back, for the admin readers. Missing file reads as empty.
 *
 * Reads only the last MAX_READ_BYTES rather than the whole file. `/api/admin/stats`
 * calls this twice, so an unbounded read let an anonymous writer decide how much
 * memory the operator's own dashboard allocates — the sink is public, the reader
 * is not, and the process dies on the reader's side.
 *
 * Consequences of the tail: the first line of a truncated read is dropped because
 * it is almost certainly a partial record, and a malformed line is skipped rather
 * than aborting the whole read. That last part was a live bug independent of the
 * cap — one bad line made `JSON.parse` throw and the inbox came back empty with
 * nothing logged.
 */
export async function readJsonlRecords(filename) {
  let fh;
  try {
    fh = await open(join(dataDir(), filename), "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxReadBytes());
    const buf = Buffer.alloc(size - start);
    // Trust the count, not the buffer length: a short read would otherwise leave
    // a tail of zero bytes that parses as one more empty line.
    const { bytesRead } = buf.length ? await fh.read(buf, 0, buf.length, start) : { bytesRead: 0 };

    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        // `ip` dropped on the way out as well as on the way in. Nothing writes it
        // any more, but a sink written before that change still holds one on
        // disk, and every admin reader — the lead inbox, the CSV export, the
        // drawer's "Copy JSON" — reads these records verbatim. Stripping here
        // means the upgrade takes effect on the existing file too, without
        // rewriting a file the operator may be tailing.
        const parsed = JSON.parse(line);
        // Object-guarded before the destructure. Rest-destructuring a primitive
        // boxes it — a stray `"hello"` line would come back as
        // `{0:"h",1:"e",…}` rather than being skipped — and every reader here
        // expects a record.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
        const { ip: _ip, ...record } = parsed;
        return [record];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

/**
 * Persist a record to every configured sink. Never throws — a failed write must
 * not turn into a 500 that breaks the visitor's funnel.
 *
 * `fanOut` is what the delivery queue turned from an always into a decision.
 * When a lead made it into Postgres its deliveries are queued rows with retries
 * and a dead-letter state, so sending here as well would deliver the same lead
 * twice — once durably, once not. The route passes `false` in exactly that case
 * and `true` whenever the queue did not take the lead, which is what makes an
 * outage a degraded delivery rather than a lost one.
 *
 * The JSONL sink is written either way. It is the operator's own copy and the
 * console's lead inbox, not a delivery channel.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 * @param {{ fanOut?: boolean }} [opts]
 */
export async function persist(kind, record, opts = {}) {
  const { fanOut = true } = opts;

  // The sink copy carries no raw IP (PLAN.md §10, REALITY-CHECK.md §3). The
  // Postgres column has always been a salted hash and `lib/delivery.js` strips
  // the address off every outbound payload — but `.data/*.jsonl` was written
  // from the record verbatim, so the one store a deployment with no database
  // has was also the one store still holding the address in the clear. Stripped
  // here rather than at the call site because `record.ip` still has an in-process
  // consumer: `forwardMetaCapi` reads it below, consent-gated and opt-in.
  const { ip: _ip, ...sinkRecord } = record;
  const tasks = [appendJsonl(kind, sinkRecord), forwardMetaCapi(record)];
  if (kind === "leads") {
    // The autoresponder is outside the `fanOut` decision on purpose. It is a
    // courtesy mail to the VISITOR, not a delivery of the lead to the operator,
    // so the queue has no target for it — and leaving it in the branch below
    // meant it went silently dark the moment a funnel got its first delivery
    // target. Its own rate limits are inside it and are the ones that matter,
    // since the recipient comes from a public request body.
    tasks.push(sendLeadAutoresponder(record));
    if (fanOut) {
      // Resolved once, here, and handed to both channels. The webhook
      // destination and the lead-alert address both live in this document, and
      // two independent lookups are two chances to disagree — plus `CACHE_MS` is
      // 0 in dev, so it was also two round trips per lead.
      //
      // `.catch` because this is the only `await` before `Promise.allSettled`,
      // so it is the only thing that can make `persist()` itself reject. That
      // would skip both `tasks.push` lines below — losing the fan-out for the
      // lead — and on the Vercel entry point the rejection lands in the
      // platform's `waitUntil` with nothing to catch it. `loadFunnel` swallows
      // its own errors today; the guarantee above should not depend on that
      // staying true.
      const funnel = record.funnelId ? await loadFunnel(String(record.funnelId)).catch(() => null) : null;
      tasks.push(forwardWebhook(record, funnel));
      tasks.push(notifyOperatorOfLead(record, funnel));
    }
  }
  await Promise.allSettled(tasks);
}
