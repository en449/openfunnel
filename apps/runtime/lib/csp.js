/**
 * @file The funnel page's boot script, its Content-Security-Policy, and the
 * handling of operator-pasted custom code.
 *
 * These three belong in one file because they are one mechanism. The policy
 * pins `script-src` to the SHA-256 of `FUNNEL_BOOT_SCRIPT`, so the constant and
 * the policy that hashes it must not be able to drift apart — put an
 * interpolated funnel value into the boot script and every funnel page silently
 * stops running its own JavaScript, with nothing thrown server-side. A test
 * recomputes the digest from the served bytes to catch exactly that.
 *
 * The same drift hazard applies to `customCode()`: `funnelPage()` (./html.js)
 * and `funnelCsp()` here MUST both read the operator's fields through it. They
 * ran the same `||` chain independently at first, and the moment those two
 * disagree the hash covers different bytes than are served.
 */

import { createHash } from "node:crypto";

/**
 * The funnel page's boot script, kept out of the template so its hash is stable.
 *
 * It is deliberately free of interpolation — the funnel document travels in a
 * separate `application/json` block that this reads — which is what makes a
 * strict `script-src` possible: the hash below is computed once and never
 * depends on which funnel is being served. Edit this and the CSP hash follows
 * automatically; interpolate a value into it and you break every funnel page.
 */
export const FUNNEL_BOOT_SCRIPT = `
      import { createFunnel } from "/_of/index.js";
      const mount = document.getElementById("app");
      const funnel = JSON.parse(document.getElementById("of-funnel").textContent);
      const isPreview = Boolean(
        window.parent !== window ||
        window.self !== window.top ||
        new URLSearchParams(location.search).get("preview") === "1" ||
        new URLSearchParams(location.search).get("admin") === "1"
      );
      const isEmbedded = window.parent !== window;
      let live = createFunnel(mount, funnel, {
        isPreview: isPreview,
        isEditor: isEmbedded,
        trackEvents: !isPreview && !isEmbedded,
        eventEndpoint: "/api/events",
        leadEndpoint: "/api/lead",
      });

      // Embedded in the builder: re-mount from the working document the builder
      // posts in, so an unsaved edit is visible immediately. Reloading the page
      // would only ever show what is already on disk.
      if (window.parent !== window) {
        addEventListener("message", (e) => {
          if (e.origin !== location.origin || e.data?.type !== "of:preview") return;
          if (live && typeof live.updateFunnel === "function") {
            live.updateFunnel(e.data.funnel, e.data.stepIndex);
          } else {
            try {
              if (live) live.destroy();
            } catch {}
            mount.innerHTML = "";
            live = createFunnel(mount, e.data.funnel, {
              stepIndex: e.data.stepIndex,
              isPreview: true,
              isEditor: true,
              trackEvents: false,
              resume: false,
            });
          }
        });
        parent.postMessage({ type: "of:preview-ready" }, location.origin);
      }
`;

/** base64 SHA-256 of the boot script, for `script-src 'sha256-…'`. */
export const FUNNEL_BOOT_HASH = createHash("sha256").update(FUNNEL_BOOT_SCRIPT, "utf8").digest("base64");

/**
 * Hosts each ad platform needs, added only for the pixels a funnel configures.
 * A funnel with no pixels gets no third-party script origin at all.
 *
 * @type {Record<string, { script?: string[], connect?: string[], img?: string[] }>}
 */
const PIXEL_CSP_HOSTS = {
  metaPixelId: {
    script: ["https://connect.facebook.net"],
    connect: ["https://www.facebook.com"],
    img: ["https://www.facebook.com"],
  },
  gtmId: {
    script: ["https://www.googletagmanager.com"],
    connect: ["https://www.google-analytics.com", "https://*.analytics.google.com"],
  },
  ga4Id: {
    script: ["https://www.googletagmanager.com"],
    connect: ["https://www.google-analytics.com", "https://*.analytics.google.com"],
  },
  tiktokPixelId: {
    script: ["https://analytics.tiktok.com"],
    connect: ["https://analytics.tiktok.com"],
  },
};

/* ===== operator-pasted custom code ====================================== *
 *
 *  The console can attach `customCss` / `customHead` / `customBody` to a funnel
 *  document, and `funnelPage()` injects them raw. Script inside them is refused
 *  by default, and that default is load-bearing rather than an oversight:
 *
 *  a funnel page is served from the SAME ORIGIN as the console, and the admin
 *  token lives in that origin's `localStorage`. So a script running on a funnel
 *  page can read the token and call `/api/admin/*` — the entire lead database.
 *  Funnel documents are also imported from templates, gists and bug reports, and
 *  the README tells operators to expect that. Executing whatever a document
 *  carries would turn "I imported a funnel JSON" into console takeover.
 *
 *  `ALLOW_CUSTOM_SCRIPTS=1` opts in, and even then the policy is not widened to
 *  `'unsafe-inline'`: each inline script is allowed by the SHA-256 of its exact
 *  bytes, and each external one by its own origin. Only what the operator pasted
 *  runs — `step.consent` and any XSS a future renderer introduces stay blocked,
 *  because their content was never hashed into the policy.
 * ======================================================================== */

const ALLOW_CUSTOM_SCRIPTS = /^(1|true|yes|on)$/i.test(process.env.ALLOW_CUSTOM_SCRIPTS || "");

/** Extra origins a pasted loader pulls further scripts from (it cannot be predicted). */
const CUSTOM_SCRIPT_ORIGINS = (process.env.CUSTOM_SCRIPT_ORIGINS || "")
  .split(/[\s,]+/)
  .filter(Boolean)
  .flatMap((raw) => {
    try {
      return [new URL(raw).origin];
    } catch {
      console.warn(`[openfunnel] ignoring unparseable CUSTOM_SCRIPT_ORIGINS entry: ${raw}`);
      return [];
    }
  });

// Non-greedy body, mirroring how the HTML parser ends a script at the first
// `</script>` — so the captured text is what the browser hashes.
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const TYPE_ATTR = ATTR_RE("type");
const SRC_ATTR = ATTR_RE("src");
// Anything else (application/json, text/template) is data the browser never
// executes, so it needs no grant.
const EXECUTABLE_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

/** @param {RegExpMatchArray|null} m */
const attrValue = (m) => (m ? (m[1] ?? m[2] ?? m[3] ?? "") : "");

/**
 * The custom code attached to a funnel, resolved once.
 *
 * Both `funnelPage()` and `funnelCsp()` MUST read it through here. They ran the
 * same `||` chain independently at first, and the moment those two drift the
 * hash is computed over different bytes than are served — which does not fail
 * loudly, it just silently stops the operator's script running.
 *
 * @param {any} funnel
 */
export function customCode(funnel) {
  const i = funnel?.integrations || {};
  return {
    css: funnel?.customCss || i.customCss || "",
    head: funnel?.customHead || i.customHead || "",
    body: funnel?.customBody || i.customBody || "",
  };
}

/**
 * Hashes for the inline scripts in `markup`, and origins for the external ones.
 *
 * A malformed tag this regex mis-reads yields a hash that matches nothing, so
 * the script is refused rather than wrongly allowed — the failure mode is a
 * script that does not run, never a policy that permits more than intended.
 *
 * @param {string} markup
 * @returns {{ hashes: string[], origins: string[], executable: number }}
 */
function collectCustomScriptSources(markup) {
  /** @type {string[]} */ const hashes = [];
  /** @type {string[]} */ const origins = [];
  let executable = 0;
  if (!markup) return { hashes, origins, executable };

  for (const match of markup.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] || "";
    const type = attrValue(attrs.match(TYPE_ATTR)).trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue;
    executable++;

    const src = attrValue(attrs.match(SRC_ATTR)).trim();
    if (src) {
      // A relative src is same-origin and already covered by 'self'.
      if (/^https?:\/\//i.test(src)) {
        try {
          origins.push(new URL(src).origin);
        } catch {
          /* unparseable — the browser will refuse it too */
        }
      }
      continue; // `src` wins over any inline body, so no hash for this one.
    }
    hashes.push(`'sha256-${createHash("sha256").update(match[2], "utf8").digest("base64")}'`);
  }
  return { hashes, origins, executable };
}

/**
 * Content-Security-Policy for a funnel page.
 *
 * This is the backstop for the engine's one deliberate HTML sink (`step.consent`
 * is rendered as markup so an operator can put a link in it) and for any XSS a
 * future renderer introduces: with `script-src` pinned to the boot script's hash
 * plus same-origin modules, injected markup cannot execute.
 *
 * What is deliberately loose, and why:
 *   style-src   'unsafe-inline' — the theme writes inline `style` attributes and
 *               the engine sets `node.style` directly. Style injection is not in
 *               the same risk class as script injection.
 *   img/media   `https:` — image and video blocks take arbitrary operator URLs.
 *   frame-src   `https:` — YouTube/Vimeo embeds.
 * `frame-ancestors` is intentionally absent: funnels are meant to be embedded on
 * the operator's marketing site, and the builder previews one in an iframe.
 *
 * @param {any} funnel
 * @returns {string}
 */
export function funnelCsp(funnel) {
  const script = new Set(["'self'", `'sha256-${FUNNEL_BOOT_HASH}'`]);
  const connect = new Set(["'self'"]);
  const img = new Set(["'self'", "https:", "data:"]);

  const integrations = funnel?.integrations || {};
  for (const [key, hosts] of Object.entries(PIXEL_CSP_HOSTS)) {
    if (!integrations[key]) continue;
    hosts.script?.forEach((h) => script.add(h));
    hosts.connect?.forEach((h) => connect.add(h));
    hosts.img?.forEach((h) => img.add(h));
  }

  // `integrations.leadEndpoint` gets NO allowance here. It used to add its own
  // origin to `connect-src`, which meant a funnel document could name where the
  // leads go and then authorise the browser to send them there — the CSP
  // certifying the exfiltration it exists to prevent. `publicFunnel()` now keeps
  // the field only when it is a path on this server, so `'self'` already covers
  // every endpoint a browser can be told to use. An operator forwarding leads
  // elsewhere does it server-side through the webhook, where the destination
  // comes from the environment rather than from a document someone imported.

  // Operator-pasted script, only where the deployment has opted in.
  const custom = customCode(funnel);
  const pasted = collectCustomScriptSources(`${custom.head}\n${custom.body}`);
  if (pasted.executable) {
    if (ALLOW_CUSTOM_SCRIPTS) {
      pasted.hashes.forEach((h) => script.add(h));
      // Analytics scripts beacon back to their own host, so an origin allowed to
      // load but not to connect is a script that runs and silently reports
      // nothing — the exact failure this whole feature exists to stop being.
      for (const origin of [...pasted.origins, ...CUSTOM_SCRIPT_ORIGINS]) {
        script.add(origin);
        connect.add(origin);
      }
    } else {
      // Without this the operator gets a CSP violation in the visitor's console
      // and nothing at all on the server — the field saves, the script never
      // runs, and there is no way to tell from the app that it was refused.
      console.warn(
        `[openfunnel] funnel "${funnel?.slug || funnel?.id || "?"}" carries ${pasted.executable} custom <script> tag(s); ` +
          "refusing to execute them. Funnel pages share an origin with the console, so a script here can read the " +
          "admin token. Set ALLOW_CUSTOM_SCRIPTS=1 to allow the exact scripts you pasted.",
      );
    }
  }

  return [
    "default-src 'none'",
    `script-src ${[...script].join(" ")}`,
    // No Google hosts. The preset webfonts are served from this origin
    // (PHASE-1-PLAN.md §4.9), so `'self'` is the whole permission a funnel page
    // needs for type — and leaving the two hosts here would keep PRE-AUTHORISING
    // a third party on every funnel, including the ones that never ask for it.
    // The CSP is the second half of that gate: even a funnel document that
    // somehow got a Google URL into a style could not fetch it.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src ${[...img].join(" ")}`,
    `connect-src ${[...connect].join(" ")}`,
    "media-src 'self' https: data:",
    "frame-src https:",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
