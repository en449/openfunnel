/**
 * @file Outbound webhook delivery, and the egress guard that decides where this
 * server is willing to open a socket.
 *
 * `resolveSafeTarget` is the important export and the rule is: any new outbound
 * call to an operator-supplied URL goes through it. `isSafeWebhookTarget` alone
 * is only the textual half — it cannot see what a hostname resolves to.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { loadFunnel } from "./funnels.js";
import { errSummary, oneLine } from "./log.js";

/* ========================================================================== *
 *  Egress guard
 * ========================================================================== */

/** Names that resolve to the local machine even though they are not literals. */
const BLOCKED_NAME_RE = /^(localhost|.*\.localhost|.*\.internal|.*\.local|.*\.home\.arpa)$/i;

/**
 * Reserved IPv4 ranges we refuse to POST to, as `[firstOctet, test]` predicates.
 * Deliberately spelled out rather than crammed into one regex — the previous
 * single-regex version silently missed several of these.
 */
function isBlockedIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (parts.some((p) => !/^\d{1,3}$/.test(p)) || [a, b].some((n) => Number.isNaN(n))) return false;
  if (a === 0 || a === 127) return true;                    // this-host, loopback
  if (a === 10) return true;                                // private
  if (a === 169 && b === 254) return true;                  // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;         // private
  if (a === 192 && b === 168) return true;                  // private
  if (a === 100 && b >= 64 && b <= 127) return true;        // RFC 6598 carrier-grade NAT
  return false;
}

/**
 * @param {string} host  An IPv6 literal WITHOUT surrounding brackets, lower-cased.
 */
function isBlockedIpv6(host) {
  if (host === "::1" || host === "::") return true;          // loopback, unspecified
  // IPv4-mapped (`::ffff:127.0.0.1`, which the URL parser rewrites to
  // `::ffff:7f00:1`). No webhook has a legitimate reason to be one, and letting
  // them through was a straight loopback bypass — the old regex missed it.
  if (host.startsWith("::ffff:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;          // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;          // fe80::/10 link-local
  return false;
}

/**
 * Is this a destination we are willing to POST lead data to?
 *
 * Blocks non-HTTP schemes and anything addressed at the loopback interface, the
 * private ranges, or the cloud metadata endpoint. The URL parser normalises the
 * decimal/hex/octal IPv4 spellings (`http://2130706433/`) before we see them, so
 * those arrive here as plain dotted quads.
 *
 * Still a literal-address check: it does not defeat a hostname that RESOLVES to
 * a private IP (DNS rebinding), which needs resolution-time filtering to close
 * properly. The destination is operator-owned, so that residual gap is a
 * misconfiguration risk rather than something a visitor can reach.
 */
export function isSafeWebhookTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return !isBlockedIpv6(host.slice(1, -1));
  if (BLOCKED_NAME_RE.test(host)) return false;
  return !isBlockedIpv4(host);
}

/** Host of a URL, for log lines that must not carry the path or query. */
function hostOf(raw) {
  try {
    return new URL(String(raw)).host;
  } catch {
    return "(unparseable)";
  }
}

/**
 * The literal check above, plus what the hostname actually RESOLVES to.
 *
 * `webhook.example.com` passes every textual test and can still have an A record
 * pointing at 169.254.169.254. Resolving first and rejecting a private answer
 * closes the practical version of that: a DNS entry aimed at the local network
 * or the cloud metadata service no longer receives lead data.
 *
 * It does not close the theoretical version. Between this lookup and the socket
 * connecting, a hostile resolver can answer differently (DNS rebinding), and Bun
 * exposes no way to pin the resolved address for a `fetch`. Since the
 * destination is operator-owned rather than visitor-supplied, what remains is a
 * misconfiguration and compromised-DNS risk, not something a stranger can steer.
 *
 * A lookup failure is treated as unsafe: a destination we cannot resolve is one
 * we cannot vet, and the `fetch` would fail anyway.
 *
 * @param {string} raw
 * @returns {Promise<boolean>}
 */
export async function isSafeWebhookTargetResolved(raw) {
  return (await resolveSafeTarget(raw)) !== null;
}

/**
 * Vet a webhook destination and return a request that connects to the exact
 * address that was vetted.
 *
 * Checking the hostname and then handing the hostname to `fetch` leaves a gap:
 * the resolver can answer differently when the socket actually opens, so a name
 * that vetted clean resolves to 169.254.169.254 a moment later. That is DNS
 * rebinding, and it is closed here rather than documented as unavoidable —
 * for `http://` the request is aimed at the resolved IP with the original `Host`
 * header preserved, so virtual-host routing still works but the destination
 * cannot change underneath us.
 *
 * `https://` is deliberately left on the hostname. It does not need pinning:
 * TLS already defeats the harmful case, because a rebound address would have to
 * present a valid certificate for the operator's configured hostname, which the
 * metadata endpoint and anything on the private network cannot do. Pinning it
 * would mean overriding SNI and certificate validation on a path this project
 * cannot exercise in tests, which is a worse trade than relying on TLS.
 *
 * @param {string} raw
 * @returns {Promise<{ url: string, headers: Record<string,string> } | null>} null when unsafe.
 */
export async function resolveSafeTarget(raw) {
  if (!isSafeWebhookTarget(raw)) return null;

  const url = new URL(String(raw));
  const host = url.hostname.toLowerCase();

  // An IP literal was already checked against the ranges directly — nothing to
  // resolve, and nothing that can change.
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { url: url.toString(), headers: {} };
  }

  /** @type {Array<{ address: string, family: number }>} */
  let answers;
  try {
    answers = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    return null; // a destination we cannot resolve is one we cannot vet
  }
  if (!answers.length) return null;

  const anyBlocked = answers.some(({ address, family }) =>
    family === 6 ? isBlockedIpv6(String(address).toLowerCase()) : isBlockedIpv4(String(address))
  );
  if (anyBlocked) return null;

  if (url.protocol !== "http:") return { url: url.toString(), headers: {} };

  const { address, family } = answers[0];
  const pinned = new URL(url);
  pinned.hostname = family === 6 ? `[${address}]` : address;
  // `url.host` keeps any non-default port, so the origin server still routes it.
  return { url: pinned.toString(), headers: { host: url.host } };
}

/* ========================================================================== *
 *  Delivery
 * ========================================================================== */

/**
 * Forward a captured lead to a Webhook URL (Zapier, Make, GoHighLevel, HubSpot, CRM).
 *
 * @param {Record<string, any>} record
 */
export async function forwardWebhook(record) {
  // Deliberately NOT read from the record. /api/lead is public, so honouring a
  // webhookUrl from the request body let any caller aim the server at a host of
  // their choosing — both an open redirector for lead data and an SSRF probe
  // against whatever the server can reach. The destination is operator-owned:
  // the environment, or the funnel document (written through the admin API).
  let webhookUrl = process.env.WEBHOOK_URL || process.env.ZAPIER_WEBHOOK_URL || "";
  let webhookSecret = process.env.WEBHOOK_SECRET || "";

  if (record.funnelId) {
    const funnel = await loadFunnel(record.funnelId);
    if (!webhookUrl) {
      webhookUrl = funnel?.integrations?.webhookUrl || funnel?.integrations?.webhook || "";
    }
    webhookSecret ||= funnel?.integrations?.webhookSecret || "";
  }
  if (!webhookUrl) return;

  const target = await resolveSafeTarget(webhookUrl);
  if (!target) {
    // Logs the host, not the URL: a webhook URL routinely carries a token in
    // its path, and this line would copy it into the log.
    console.warn(`[runtime] refusing webhook to blocked target: ${oneLine(hostOf(webhookUrl), 120)}`);
    return;
  }

  try {
    /** @type {Record<string,string>} */
    // `target.headers` carries the original `Host` when the request was pinned
    // to a resolved address, so the receiving vhost still routes it correctly.
    const headers = { "content-type": "application/json", ...target.headers };
    // The console advertises this header, so send it: it lets the receiving
    // automation prove the delivery came from this server.
    if (webhookSecret) headers["x-webhook-secret"] = oneLine(webhookSecret, 512);

    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
      redirect: "manual", // a 302 would sidestep the target check above
    });
    if (!res.ok) console.warn(`[runtime] webhook dispatch HTTP ${res.status}`);
  } catch (err) {
    // Never log the error object: a fetch failure carries the full request URL
    // on `err.path`, and webhook URLs routinely embed a token in the path, so
    // printing it would copy an operator's credential into the log.
    console.warn(`[runtime] webhook error: ${errSummary(err)}`);
  }
}
