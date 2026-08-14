/**
 * @file `GET /r/:token` — the client's read-only report (PHASE-2-PLAN.md §3).
 *
 * PUBLIC, and the token in the path is the entire credential. Three consequences
 * shape this file:
 *
 *  - **Server-rendered, no JavaScript, no API.** A client-side page would have to
 *    hold the token and send it on every subrequest, putting it in `history`, in
 *    every `Referer` and in whatever the browser syncs. Here the token appears in
 *    exactly one request.
 *  - **Every refusal is the same 404 with the same body.** Expired, revoked,
 *    never existed, one character off — a report link that distinguishes them
 *    tells a prober which half of a guess was right.
 *  - **The token is never logged**, not in a warning and not in an error. The
 *    same rule the rest of the runtime applies to `err.path`.
 *
 * The page is refused on a mapped custom domain automatically, because
 * `handleFunnelHost` is an allowlist. That is deliberate, not incidental: the
 * report is the operator's surface for ONE client, and on a client's own ad
 * domain a single wrong mapping would serve one client's leads on another's
 * brand. Do not add `/r/` to that allowlist.
 */

import { REPORT_LEAD_LIMIT, loadClientReport, resolveReportToken } from "../lib/report.js";
import { clientIp, html } from "../lib/http.js";
import { EMAIL_RE } from "../lib/email.js";
import { esc } from "../lib/html.js";
import { loadFunnel } from "../lib/funnels.js";
import { rateLimit } from "../lib/ratelimit.js";

/**
 * Which language the report speaks, and which clock it shows.
 *
 * Two env vars rather than a locale framework: the client-facing string list is
 * eleven entries long, and the operator running this has one kind of client. The
 * repo's default is English, matching `funnel.lang || "en"` in `lib/html.js`;
 * Enno's deployment sets `REPORT_LANG=de`.
 *
 * `REPORT_TZ` matters more than it looks. Vercel runs UTC, so an unset timezone
 * shows a German client every lead one or two hours before it arrived — which
 * reads as a broken report rather than as a timezone.
 */
const LANG = /^de/i.test(process.env.REPORT_LANG || "") ? "de" : "en";
const TZ = process.env.REPORT_TZ || process.env.TZ || "UTC";

/** @type {Record<string, Record<string, string>>} */
const STRINGS = {
  en: {
    title: "Your enquiries",
    week: "Last 7 days",
    month: "Last 30 days",
    total: "Total",
    leads: "Enquiries",
    empty: "No enquiries yet. As soon as somebody submits the form, they appear here.",
    showing: "Showing the most recent %n of %t.",
    perFunnel: "By funnel",
    updated: "Updated",
    private: "This page is private. Anyone with the link can see it — please do not share it.",
    noAnswers: "No further answers.",
  },
  de: {
    title: "Ihre Anfragen",
    week: "Letzte 7 Tage",
    month: "Letzte 30 Tage",
    total: "Gesamt",
    leads: "Anfragen",
    empty: "Noch keine Anfragen. Sobald jemand das Formular abschickt, erscheint er hier.",
    showing: "Angezeigt werden die neuesten %n von %t.",
    perFunnel: "Nach Funnel",
    updated: "Stand",
    private: "Diese Seite ist privat. Wer den Link hat, sieht sie — bitte nicht weitergeben.",
    noAnswers: "Keine weiteren Angaben.",
  },
};

/** @param {string} key @returns {string} */
const t = (key) => STRINGS[LANG]?.[key] ?? STRINGS.en?.[key] ?? key;

/**
 * `default-src 'none'` and then nothing added back except inline style.
 *
 * There is no script, no font, no image and no third party on this page, so
 * there is nothing to allow. `form-action` and `base-uri` are closed for the
 * same reason they are on any page holding a credential in its URL, and
 * `frame-ancestors` is `'none'` — unlike a funnel page, which is meant to be
 * embedded, nothing legitimately frames a client's leads.
 */
const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Headers this route adds on top of `BASE_HTML_HEADERS`.
 *
 * `no-referrer` overrides the shared `strict-origin-when-cross-origin`, which is
 * right for a funnel page and not enough here: the secret is in the PATH, and a
 * click-out on a `mailto:` or a link a client pastes would carry it.
 */
const REPORT_HEADERS = {
  "content-security-policy": REPORT_CSP,
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "no-store, private",
};

/**
 * Byte-identical for every reason a report is not shown. Built once so a later
 * edit cannot make one branch more informative than another.
 */
const notFound = () => new Response("Not found", { status: 404 });

/**
 * @param {Request} req
 * @param {{ path: string, url: URL, server: any }} ctx
 * @returns {Promise<Response|null>} null when this is not a report request.
 */
export async function handleReport(req, ctx) {
  const { path, server } = ctx;
  if (req.method !== "GET" || !path.startsWith("/r/")) return null;

  const token = path.slice(3);
  // One segment. A token with a slash in it is not a token, and matching loosely
  // here would make `/r/<token>/anything` a second URL for the same page — one
  // more shape for the credential to be pasted in.
  if (!token || token.includes("/")) return notFound();

  const ip = clientIp(req, server) || "unknown";

  // Two ceilings, and they measure different things. The wide one bounds the
  // work any single caller can make this endpoint do — every view is a database
  // round trip. The tight one is on MISSES, because token entropy is the whole
  // access control (Art. 32) and an endpoint that can be walked defeats it; a
  // client refreshing their own report is not the thing to limit, while a caller
  // producing 404s at this path is doing exactly one thing.
  //
  // `rateLimit` hashes its own key before writing a row, so keying a bucket on a
  // caller here does not put anything readable into `rate_bucket`.
  //
  // The wide one answers 429 and not the silent 404, and that is safe precisely
  // because it fires BEFORE the token is resolved: it says the same thing to a
  // valid link and an invented one, so it leaks nothing. Making it a 404 would —
  // a client behind an office NAT would be told their link is dead when it is
  // merely busy, and "it stopped working" is the one support call this feature
  // exists to prevent.
  if (!(await rateLimit(`report:${ip}`, 240, 60 * 60 * 1000))) {
    return new Response("Too many requests", { status: 429, headers: { "retry-after": "600" } });
  }

  const holder = await resolveReportToken(token);
  if (!holder) {
    await rateLimit(`report-miss:${ip}`, 30, 60 * 60 * 1000);
    return notFound();
  }

  const report = await loadClientReport(holder.clientId, REPORT_LEAD_LIMIT);
  // A database that answered the token lookup and then failed the report is a
  // real error, not a bad link — but it is still not something to explain to a
  // client, and the 404 above is what every other failure looks like. It is
  // logged without the token.
  if (!report) {
    console.warn(`[report] resolved a token but could not build the report for client ${holder.clientId}`);
    return notFound();
  }

  return html(await renderReport(holder, report), 200, REPORT_HEADERS);
}

/* ========================================================================== *
 *  Rendering
 * ========================================================================== */

/**
 * Answer keys are STEP IDS, so a raw report reads `garden_size: 200-500`. The
 * step's own headline is what the visitor actually answered, and it lives in the
 * funnel document — so the documents behind this report's leads are loaded once
 * (through `loadFunnel`, which caches) and flattened into one lookup.
 *
 * Best-effort by design: a lead whose funnel has since been archived, or whose
 * step has been renamed, falls back to a humanised key rather than failing the
 * page. A report that 500s because a step id moved is worse than one that says
 * `Garden size`.
 *
 * @param {any[]} leads
 * @returns {Promise<Map<string, string>>} `<slug> <stepId>` → headline.
 */
async function answerLabels(leads) {
  /** @type {Map<string, string>} */
  const labels = new Map();
  const slugs = [...new Set(leads.map((l) => l?.slug).filter((s) => typeof s === "string" && s))];

  for (const slug of slugs) {
    let doc = null;
    try {
      doc = await loadFunnel(slug);
    } catch {
      /* a document that will not load costs labels, never the page */
    }
    for (const step of doc?.steps || []) {
      if (!step?.id) continue;
      const label = step.headline || step.label || step.title;
      if (typeof label === "string" && label.trim()) labels.set(`${slug} ${step.id}`, label.trim());
    }
  }
  return labels;
}

/**
 * `garden_size` → `Garden size`. The fallback, never the first choice.
 * @param {string} key
 */
const humanise = (key) =>
  String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

/**
 * One answer value as a string. Arrays are multiselect; anything else that is
 * not a primitive is skipped rather than JSON-dumped, because a client reading
 * `{"a":1}` in their report learns nothing and it is how internal shapes leak
 * into a client-facing page.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function answerText(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === "string" || typeof v === "number").map(String);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "boolean") return value ? "✓" : "–";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

/** Contact keys that get an actionable link rather than plain text. */
const EMAIL_KEYS = new Set(["email", "e-mail", "mail"]);
const PHONE_KEYS = new Set(["phone", "tel", "telefon", "mobile", "handy"]);

/**
 * `mailto:<addr>` for a value that is ONLY an address, or null.
 *
 * Parsed, never pattern-matched — the rule this repo already applies to every
 * other URL check (`sameOriginPath`, `isNavigableUrl`, `embedUrl`), and this is
 * why. `EMAIL_RE.test(value)` alone was the first version and it is not enough:
 * `mailto:` takes header parameters after a `?`, and
 * `victim@example.com?cc=attacker%40evil.invalid` satisfies "no whitespace, one
 * `@`, a dot" — the second address is percent-encoded, so the pattern never sees
 * it. The browser does: it resolves that href to a link which silently CCs a
 * stranger on the client's reply to their own customer. Any anonymous visitor
 * can type it into the public lead form.
 *
 * So the parser is asked what the string BECOMES, and anything it peels off into
 * a query or a fragment means the value was not just an address. A bare `&`
 * survives on purpose: header parameters only begin after a `?`, so `a@b.c&x=1`
 * is one (invalid) address rather than an injection.
 *
 * @param {string} text
 * @returns {string|null}
 */
function mailtoHref(text) {
  if (!EMAIL_RE.test(text)) return null;
  // No percent-escapes. RFC 6068 splits the header fields off at a LITERAL `?`
  // and only then percent-decodes, so `%3F` cannot become a separator and this
  // is not the injection guard — the parse below is. It is here because what a
  // value like `a@b.c%3Fcc=x` DOES produce is a link that opens the client's
  // mail app addressed to nonsense, and plain text is a better answer than a
  // button that fails. A literal `%` in a real address is legal and effectively
  // never seen; the cost of refusing one is that it renders as text.
  if (text.includes("%")) return null;
  try {
    const url = new URL(`mailto:${text}`);
    if (url.search || url.hash || url.pathname !== text) return null;
    return `mailto:${text}`;
  } catch {
    return null;
  }
}

/**
 * Keys in `payload.lead` that are plumbing, not something the client asked for.
 * `email_verified` in particular is a server-derived boolean and reads as a
 * judgement about the person.
 */
const HIDDEN_LEAD_KEYS = new Set(["email_verified", "consent", "id", "funnelid", "sessionid", "ip", "ip_hash"]);

/**
 * @param {{ clientName: string }} holder
 * @param {{ funnels: any[], total: number, d7: number, d30: number, leads: any[] }} report
 * @returns {Promise<string>}
 */
async function renderReport(holder, report) {
  const labels = await answerLabels(report.leads);
  const when = new Intl.DateTimeFormat(LANG, { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

  const heading = holder.clientName ? `${holder.clientName} — ${t("title")}` : t("title");
  const showing =
    report.leads.length < report.total
      ? t("showing").replace("%n", String(report.leads.length)).replace("%t", String(report.total))
      : "";

  return `<!doctype html>
<html lang="${LANG}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="no-referrer" />
    <title>${esc(heading)}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
      <header class="head">
        <h1>${esc(heading)}</h1>
        <p class="muted">${esc(t("updated"))} ${esc(when.format(new Date()))}</p>
      </header>

      <section class="cards" aria-label="${esc(t("leads"))}">
        ${statCard(t("week"), report.d7)}
        ${statCard(t("month"), report.d30)}
        ${statCard(t("total"), report.total)}
      </section>

      ${renderFunnelTable(report.funnels)}

      <section>
        <h2>${esc(t("leads"))}</h2>
        ${showing ? `<p class="muted">${esc(showing)}</p>` : ""}
        ${
          report.leads.length
            ? report.leads.map((lead) => renderLead(lead, labels, when)).join("\n")
            : `<p class="empty">${esc(t("empty"))}</p>`
        }
      </section>

      <footer class="muted">${esc(t("private"))}</footer>
    </main>
  </body>
</html>`;
}

/** @param {string} label @param {number} value */
const statCard = (label, value) =>
  `<div class="card"><span class="n">${esc(String(value))}</span><span class="l">${esc(label)}</span></div>`;

/**
 * The per-funnel breakdown, and only when there is more than one funnel — with a
 * single funnel every row would repeat the numbers directly above it.
 *
 * @param {any[]} funnels
 */
function renderFunnelTable(funnels) {
  if (!Array.isArray(funnels) || funnels.length < 2) return "";
  const rows = funnels
    .map(
      (f) =>
        `<tr><th scope="row">${esc(String(f?.name || f?.slug || ""))}</th>` +
        `<td>${esc(String(f?.d7 ?? 0))}</td><td>${esc(String(f?.d30 ?? 0))}</td><td>${esc(String(f?.total ?? 0))}</td></tr>`,
    )
    .join("");

  return `<section>
        <h2>${esc(t("perFunnel"))}</h2>
        <table>
          <thead><tr><th scope="col"></th><th scope="col">${esc(t("week"))}</th><th scope="col">${esc(
            t("month"),
          )}</th><th scope="col">${esc(t("total"))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

/**
 * One lead card: when it came in, which funnel, the contact details as things a
 * phone can act on, then the answers.
 *
 * @param {any} lead
 * @param {Map<string, string>} labels
 * @param {Intl.DateTimeFormat} when
 */
function renderLead(lead, labels, when) {
  const payload = lead?.payload && typeof lead.payload === "object" ? lead.payload : {};
  const contact = payload.lead && typeof payload.lead === "object" ? payload.lead : {};
  const answers = payload.answers && typeof payload.answers === "object" ? payload.answers : {};

  const at = lead?.createdAt ? new Date(lead.createdAt) : null;
  const stamp = at && !Number.isNaN(at.getTime()) ? when.format(at) : "";

  const contactRows = Object.entries(contact)
    .filter(([key]) => !HIDDEN_LEAD_KEYS.has(String(key).toLowerCase()))
    .map(([key, value]) => {
      const text = answerText(value);
      if (text == null) return "";
      const low = String(key).toLowerCase();
      // A link only when the value is actually the thing the key claims, and
      // `esc` on both halves either way — every character came out of a public
      // form body, and `esc` escapes quotes so nothing breaks out of the
      // attribute. The address is checked by `mailtoHref` (parsed, see there);
      // the number is REBUILT from the digits rather than checked, which is the
      // same rule reached by a different route — there is nothing left of the
      // input to smuggle a parameter in.
      const mailto = EMAIL_KEYS.has(low) ? mailtoHref(text) : null;
      const tel = text.replace(/[^\d+]/g, "");
      const shown = mailto
        ? `<a href="${esc(mailto)}">${esc(text)}</a>`
        : PHONE_KEYS.has(low) && tel.length >= 5
          ? `<a href="tel:${esc(tel)}">${esc(text)}</a>`
          : esc(text);
      return `<div class="row"><span class="k">${esc(humanise(key))}</span><span class="v">${shown}</span></div>`;
    })
    .join("");

  const answerRows = Object.entries(answers)
    .map(([key, value]) => {
      const text = answerText(value);
      if (text == null) return "";
      const label = labels.get(`${lead?.slug} ${key}`) || humanise(key);
      return `<div class="row"><span class="k">${esc(label)}</span><span class="v">${esc(text)}</span></div>`;
    })
    .join("");

  return `<article class="lead">
          <div class="meta"><time>${esc(stamp)}</time>${
            lead?.funnel ? `<span class="tag">${esc(String(lead.funnel))}</span>` : ""
          }</div>
          ${contactRows}
          ${answerRows || `<div class="row muted">${esc(t("noAnswers"))}</div>`}
        </article>`;
}

/**
 * Inline, because the page is allowed no external resource at all — and one
 * stylesheet request is one more place the URL carrying the token would appear
 * as a `Referer`. System fonts, so nothing is fetched and nothing is a third
 * party (§8.2 applies here exactly as it does to a funnel page).
 */
const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#12161c; --card:#fff; --line:#e4e7ec; --muted:#5f6b7a; --accent:#1f6feb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1319; --fg:#e8ecf2; --card:#161b23; --line:#252c37; --muted:#93a0b1; --accent:#5b9dff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.45rem; line-height:1.25; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 32px 0 12px; }
  .head { margin-bottom: 24px; }
  .muted { color: var(--muted); font-size: .875rem; margin: 0; }
  .cards { display:grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 12px; text-align:center; }
  .card .n { display:block; font-size:1.75rem; font-weight:650; letter-spacing:-.02em; }
  .card .l { display:block; font-size:.75rem; color:var(--muted); margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { padding:10px 12px; text-align:right; font-size:.9rem; border-top:1px solid var(--line); }
  thead th { border-top:0; color:var(--muted); font-weight:500; font-size:.75rem; }
  th[scope="row"] { text-align:left; font-weight:550; }
  .lead { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:14px 16px; margin-bottom:10px; }
  .meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;
          color:var(--muted); font-size:.8rem; }
  .tag { border:1px solid var(--line); border-radius:99px; padding:1px 8px; }
  .row { display:flex; gap:12px; padding:5px 0; border-top:1px solid var(--line); font-size:.925rem; }
  /* Not :first-of-type — .meta is a div too, so it is the first of its type and
     no .row would ever match. Adjacency does. */
  .meta + .row { border-top:0; }
  .k { flex:0 0 40%; color:var(--muted); }
  .v { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
  a { color:var(--accent); }
  .empty { background:var(--card); border:1px dashed var(--line); border-radius:12px;
           padding:24px 16px; color:var(--muted); text-align:center; }
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); }
`;
