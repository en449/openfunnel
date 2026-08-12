/**
 * @file Where the delivery queue's `delivery_target` rows come from.
 *
 * Until this file existed, nothing created one — so `ingest_lead` returned
 * `queued = 0` for every deployment, `/api/lead` fell through to the legacy
 * fan-out, and the durable queue that is the whole point of Phase 1 stayed
 * empty for anyone who was not writing SQL by hand.
 *
 * TARGETS ARE DERIVED, NOT AUTHORED SEPARATELY
 * A webhook destination already lives in `WEBHOOK_URL` or the funnel document's
 * `integrations.webhookUrl`, and the operator's alert address already lives in
 * the mail settings. Asking for them a second time would create two sources of
 * truth for one question, and the fan-out is what the queue DEGRADES TO — so the
 * day they disagree is the day a database outage starts delivering leads
 * somewhere the operator has not looked in months. `webhookConfigFor` is
 * therefore shared with `forwardWebhook` rather than reimplemented here.
 *
 * EVERY CHANNEL THE FAN-OUT HAD NEEDS AN EQUIVALENT HERE
 * Creating the first target flips `queueOwnsIt` to true, which switches the
 * fan-out off. Anything the fan-out delivered that has no target goes silently
 * dark at that moment — the same failure as the `queued === 0` bug in WO4, from
 * the other direction. The fan-out sends a webhook, an operator notification and
 * a visitor autoresponder; the first two are targets, and the third moved out of
 * the fan-out branch entirely (see `lib/store.js`) because it is a courtesy mail
 * to the visitor rather than a delivery of the lead.
 *
 * A sync failure is never allowed to fail the save it followed. The worst case
 * of not syncing is the fan-out keeping the lead moving — which is exactly what
 * it did before this file — and refusing an operator's funnel save because a
 * derived row could not be written trades a working console for a tidy database.
 */

import { dbConfigured, rpc, select } from "./db.js";
import { getEmailSettings, hasUnusableNotifyOverride, notifyEmailFor } from "./email.js";
import { errSummary, oneLine } from "./log.js";
import { isSafeWebhookTarget, webhookConfigFor } from "./webhook.js";

/**
 * @typedef {{ kind: "webhook"|"email", config: Record<string, string> }} DerivedTarget
 */

/**
 * What this funnel's leads should be delivered to, right now.
 *
 * Pure and synchronous so it can be asserted against directly: this is the
 * decision, and the RPC below is only the write.
 *
 * @param {any} funnel  The UNREDACTED funnel document — `publicFunnel()` strips
 *   exactly the two fields this reads, so passing a redacted copy silently
 *   derives no webhook target at all.
 * @param {{ notifyEnabled?: boolean, notifyEmail?: string }} mail  Email settings.
 * @param {string} [slug]  For log lines only.
 * @returns {DerivedTarget[]}
 */
export function deriveTargets(funnel, mail, slug = "?") {
  /** @type {DerivedTarget[]} */
  const targets = [];
  const name = oneLine(slug || funnel?.slug || "?", 80);

  const { url, secret } = webhookConfigFor(funnel);
  if (url) {
    // Vetted before the row exists, not only at send time. The dispatcher checks
    // again and that check is the load-bearing one — but a target that can never
    // deliver would sit in the dead-letter list looking like an outage, so a URL
    // the egress guard already refuses is named here instead.
    //
    // The textual check, deliberately: `resolveSafeTarget` needs DNS, and a
    // resolver having a bad minute must not decide whether the operator's
    // webhook gets configured at all.
    if (isSafeWebhookTarget(url)) {
      targets.push({ kind: "webhook", config: secret ? { url, secret } : { url } });
    } else {
      // The host, never the URL: a webhook URL routinely carries a token in its
      // path and this line would copy it into the log.
      console.warn(`[targets] funnel "${name}" names a blocked webhook host — no webhook target created`);
    }
  }

  // `notifyEmailFor` is shared with the fan-out's own alert (`lib/email.js`), so
  // the queue and the path it degrades to cannot deliver a lead alert to two
  // different addresses. Per funnel first, falling back to the install-wide one;
  // `notifyEnabled` is the master switch and gates both.
  const to = notifyEmailFor(funnel, mail);
  if (to) {
    targets.push({ kind: "email", config: { to } });
  } else if (hasUnusableNotifyOverride(funnel, mail, to)) {
    console.warn(`[targets] funnel "${name}" has an unusable notification address — no email target created`);
  }

  return targets;
}

/**
 * Bring one funnel's managed targets in line with its document.
 *
 * @param {string} slug
 * @param {any} funnel  The unredacted document.
 * @returns {Promise<number|null>} enabled target count, or null when the sync
 *   did not happen (no database, or it failed — both mean the fan-out still owns
 *   delivery, which is the state this whole file is replacing).
 */
export async function syncFunnelTargets(slug, funnel) {
  if (!dbConfigured()) return null;
  try {
    const targets = deriveTargets(funnel, await getEmailSettings(), slug);
    const enabled = await rpc("sync_delivery_targets", { p_slug: slug, p_targets: targets });
    if (!enabled) {
      console.warn(
        `[targets] funnel "${oneLine(slug, 80)}" has no delivery target — its leads are stored, and ` +
          "delivered by the direct fan-out rather than the retrying queue. Set a webhook URL or a " +
          "notification address.",
      );
    }
    return Number(enabled) || 0;
  } catch (err) {
    console.warn(`[targets] sync failed for funnel "${oneLine(slug, 80)}": ${errSummary(err)}`);
    return null;
  }
}

/**
 * Re-derive every non-archived funnel's targets.
 *
 * Two callers, one reason: the derivation reads global mail settings, so an
 * address changed in the console would otherwise keep mailing the old one until
 * every funnel happened to be saved again. It is also the backfill for funnels
 * that already existed when this shipped, which is why it has a route.
 *
 * Archived funnels are skipped rather than disabled: ingest still accepts a lead
 * for one (a visitor who loaded the page seconds before it was archived), and
 * that lead still has to be delivered.
 *
 * @returns {Promise<{ synced: number, failed: number }>}
 */
export async function syncAllFunnelTargets() {
  if (!dbConfigured()) return { synced: 0, failed: 0 };
  let synced = 0;
  let failed = 0;
  /** @type {{ slug: string, doc: any }[]} */
  let rows = [];
  try {
    rows = await select("funnel", "status=neq.archived&select=slug,doc");
  } catch (err) {
    console.warn(`[targets] could not list funnels to sync: ${errSummary(err)}`);
    return { synced: 0, failed: 0 };
  }

  // Sequential. This runs behind the admin gate on a handful of funnels, and a
  // parallel burst against a free-tier connection pool is how a settings save
  // takes the ingest path down with it.
  for (const row of rows) {
    if ((await syncFunnelTargets(row.slug, row.doc)) === null) failed++;
    else synced++;
  }
  return { synced, failed };
}
