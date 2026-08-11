/**
 * @file The ingest sinks and the fan-out that writes to all of them.
 *
 * `persist()` is where the "ingest must never fail a visitor" invariant is
 * actually implemented: `Promise.allSettled` means a dead webhook, a Supabase
 * outage or a mail failure is a `console.warn`, never an exception that reaches
 * the route handler. The route has already returned 202 by the time these run.
 */

import { mkdir, appendFile, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { forwardMetaCapi } from "./capi.js";
import { DATA_DIR, SUPABASE_KEY, SUPABASE_ON, SUPABASE_URL } from "./config.js";
import { processLeadEmailNotifications } from "./email.js";
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
 * ========================================================================== */

/** Per-sink ceiling. At the cap the file rotates to `.1`, so disk peaks at 2×. */
const MAX_SINK_BYTES = Math.max(1_000_000, Number(process.env.MAX_SINK_BYTES) || 64 * 1024 * 1024);

/** Most bytes a reader will pull into memory — the newest tail of the file. */
const MAX_READ_BYTES = Math.max(1_000_000, Number(process.env.MAX_READ_BYTES) || 8 * 1024 * 1024);

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
  await mkdir(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `${kind}.jsonl`);

  try {
    const { size } = await stat(file);
    if (size >= MAX_SINK_BYTES) {
      await rename(file, `${file}.1`);
      console.warn(`[runtime] ${kind}.jsonl hit ${MAX_SINK_BYTES} bytes — rotated to ${kind}.jsonl.1`);
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
 * Best-effort insert into a Supabase table via PostgREST. Skipped entirely when
 * the service-role key is absent, so self-hosters get file storage for free.
 *
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
async function supabaseInsert(table, row) {
  if (!SUPABASE_ON) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.warn(`[runtime] supabase ${table} insert ${res.status}`);
  } catch (err) {
    console.warn(`[runtime] supabase ${table} insert failed: ${errSummary(err)}`);
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
    fh = await open(join(DATA_DIR, filename), "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - MAX_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    // Trust the count, not the buffer length: a short read would otherwise leave
    // a tail of zero bytes that parses as one more empty line.
    const { bytesRead } = buf.length ? await fh.read(buf, 0, buf.length, start) : { bytesRead: 0 };

    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
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
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
export async function persist(kind, record) {
  const tasks = [appendJsonl(kind, record), supabaseInsert(kind, record), forwardMetaCapi(record)];
  if (kind === "leads") {
    tasks.push(forwardWebhook(record));
    tasks.push(processLeadEmailNotifications(record));
  }
  await Promise.allSettled(tasks);
}
