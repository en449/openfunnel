/**
 * @file The ingest sinks and the fan-out that writes to all of them.
 *
 * `persist()` is where the "ingest must never fail a visitor" invariant is
 * actually implemented: `Promise.allSettled` means a dead webhook, a Supabase
 * outage or a mail failure is a `console.warn`, never an exception that reaches
 * the route handler. The route has already returned 202 by the time these run.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { forwardMetaCapi } from "./capi.js";
import { DATA_DIR, SUPABASE_KEY, SUPABASE_ON, SUPABASE_URL } from "./config.js";
import { processLeadEmailNotifications } from "./email.js";
import { errSummary } from "./log.js";
import { forwardWebhook } from "./webhook.js";

/**
 * Append one record to a JSONL file. Local-first storage: readable with `tail`,
 * importable anywhere, and impossible to lose to a bad migration.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
async function appendJsonl(kind, record) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(join(DATA_DIR, `${kind}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
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

/** Read a JSONL sink back, for the admin readers. Missing file reads as empty. */
export async function readJsonlRecords(filename) {
  try {
    const file = join(DATA_DIR, filename);
    const content = await readFile(file, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
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
