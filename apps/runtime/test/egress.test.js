/**
 * @file Guards on where the runtime is willing to send data, and which files it
 * is willing to read.
 *
 * `isSafeWebhookTarget` is the only thing standing between a webhook URL and the
 * machine the server runs on — the cloud metadata endpoint, a database bound to
 * localhost, anything on the private network. It was previously one long regex
 * and quietly allowed four different ways of naming the local host, so these are
 * spelled out per-case: a bypass that nobody has a test for is a bypass that
 * comes back.
 *
 * Importing the server module deliberately does NOT start it (see the
 * `import.meta.main` guard in server.js).
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isInside, isPreviewRecord, isSafeWebhookTarget, isSafeWebhookTargetResolved, resolveSafeTarget } from "../server.js";

describe("isSafeWebhookTarget", () => {
  test("allows ordinary public destinations", () => {
    for (const url of [
      "https://hooks.zapier.com/hooks/catch/123/abc",
      "https://example.com/webhook",
      "http://example.com/webhook",
      "https://sub.domain.example.co.uk/path?q=1",
      "http://172.32.0.1/", // just outside the 172.16/12 private block
      "http://8.8.8.8/",
    ]) {
      expect(isSafeWebhookTarget(url)).toBe(true);
    }
  });

  test("refuses non-HTTP schemes and unparseable input", () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.com/",
      "ftp://example.com/",
      "javascript:alert(1)",
      "data:text/plain,hi",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(isSafeWebhookTarget(/** @type {any} */ (url))).toBe(false);
    }
  });

  test("refuses the loopback interface, however it is spelled", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://localhost/",
      "http://LOCALHOST/",
      // The URL parser normalises these to 127.0.0.1 before the check sees them.
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://0/",
      "http://[::1]/",
      // IPv4-mapped IPv6. The parser rewrites this to [::ffff:7f00:1], which the
      // old single-regex check did not match — a straight loopback bypass.
      "http://[::ffff:127.0.0.1]/",
      // Resolves to loopback on most resolvers.
      "http://foo.localhost/",
    ]) {
      expect(isSafeWebhookTarget(url)).toBe(false);
    }
  });

  test("refuses private, link-local and metadata addresses", () => {
    for (const url of [
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      // AWS/GCP/Azure instance metadata — the classic SSRF credential target.
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://100.64.0.1/", // RFC 6598 carrier-grade NAT
      "http://[fc00::1]/", // unique-local
      "http://[fe80::1]/", // link-local
      "http://[::]/",
      "http://db.internal/",
      "http://printer.local/",
    ]) {
      expect(isSafeWebhookTarget(url)).toBe(false);
    }
  });
});

describe("isInside", () => {
  const root = resolve("/srv/app/public");

  test("accepts the root itself and paths within it", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(resolve(root, "index.html"), root)).toBe(true);
    expect(isInside(resolve(root, "a/b/c.js"), root)).toBe(true);
  });

  test("rejects an escape to a parent or unrelated directory", () => {
    expect(isInside(resolve("/srv/app/secret.env"), root)).toBe(false);
    expect(isInside(resolve("/etc/passwd"), root)).toBe(false);
  });

  test("rejects a sibling that merely shares the root's name prefix", () => {
    // The reason this helper exists rather than a bare `startsWith`: with a root
    // of `/srv/app/public`, `/srv/app/public-backup` passes a prefix test.
    expect(isInside(resolve("/srv/app/public-backup/dump.sql"), root)).toBe(false);
    expect(isInside(resolve("/srv/app/publicX"), root)).toBe(false);
  });
});

describe("isSafeWebhookTargetResolved", () => {
  test("refuses a hostname whose DNS answer points at the local network", async () => {
    // The whole point: this name passes every textual check. Only resolving it
    // reveals that it lands on loopback — the DNS-rebinding shape that the
    // literal check cannot see. `localtest.me` is a public domain whose records
    // resolve to 127.0.0.1 by design.
    expect(await isSafeWebhookTargetResolved("https://localtest.me/hook")).toBe(false);
  });

  test("still refuses everything the literal check refuses", async () => {
    for (const url of ["http://169.254.169.254/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd"]) {
      expect(await isSafeWebhookTargetResolved(url)).toBe(false);
    }
  });

  test("refuses a name that does not resolve at all", async () => {
    expect(await isSafeWebhookTargetResolved("https://no-such-host.invalid-tld-zz/hook")).toBe(false);
  });

  test("allows a public IP literal without a lookup", async () => {
    expect(await isSafeWebhookTargetResolved("https://8.8.8.8/hook")).toBe(true);
  });
});

describe("resolveSafeTarget — DNS rebinding", () => {
  /**
   * Vetting a hostname and then handing the HOSTNAME to fetch leaves a window:
   * the resolver can answer differently when the socket opens. For http:// the
   * request is aimed at the address that was actually vetted, with the original
   * Host preserved so virtual-host routing still works.
   *
   * These tolerate a machine with no DNS: an unresolvable name yields null,
   * which is the safe outcome, so the assertions branch rather than flake.
   */
  test("http:// is pinned to the resolved address, preserving Host", async () => {
    const target = await resolveSafeTarget("http://example.com/hook?t=1");
    if (target === null) return; // no DNS available; refusing is the safe answer

    expect(target.url).toMatch(/^http:\/\/(\d{1,3}\.){3}\d{1,3}|^http:\/\/\[/);
    expect(target.url).toContain("/hook?t=1");
    expect(target.headers.host).toBe("example.com");
  });

  test("https:// keeps the hostname — TLS already defeats the rebound case", async () => {
    const target = await resolveSafeTarget("https://example.com/hook");
    if (target === null) return;

    expect(target.url).toBe("https://example.com/hook");
    expect(target.headers.host).toBeUndefined();
  });

  test("an IP literal needs no lookup and is passed through unchanged", async () => {
    const target = await resolveSafeTarget("https://8.8.8.8/hook");
    expect(target).not.toBeNull();
    expect(target?.url).toBe("https://8.8.8.8/hook");
  });

  test("a name resolving to the local network is still refused", async () => {
    expect(await resolveSafeTarget("http://localtest.me/hook")).toBeNull();
    expect(await resolveSafeTarget("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });
});

describe("isPreviewRecord — suppression must need a real flag", () => {
  /**
   * This predicate decides whether a lead is persisted at all, so a false
   * positive silently destroys the operator's primary asset. It used to
   * substring-match, which meant anyone who circulated a link to the funnel with
   * "preview=1" buried in an unrelated value — `?utm_campaign=spring-preview=1-sale`
   * — discarded every lead that came through it, with no log and a 202 back to
   * the visitor so the funnel looked fine.
   */
  test("a real preview flag suppresses", () => {
    expect(isPreviewRecord({ preview: true })).toBe(true);
    expect(isPreviewRecord({ isPreview: true })).toBe(true);
    expect(isPreviewRecord({ meta: { preview: true } })).toBe(true);
    expect(isPreviewRecord({ referer: "https://x.test/f/q?preview=1" })).toBe(true);
    expect(isPreviewRecord({ referer: "https://x.test/f/q?admin=1" })).toBe(true);
    expect(isPreviewRecord({ meta: { url: "https://x.test/f/q?a=b&preview=1" } })).toBe(true);
  });

  test("a coincidental substring does NOT suppress a real lead", () => {
    for (const referer of [
      "https://shop.test/f/q?utm_campaign=spring-preview=1-sale",
      "https://shop.test/f/q?ref=badmin=1",
      "https://shop.test/preview=1/landing",
      "https://shop.test/f/q#preview=1",
      "https://shop.test/f/q?notpreview=1",
    ]) {
      expect(isPreviewRecord({ referer })).toBe(false);
    }
    expect(isPreviewRecord({ meta: { url: "https://shop.test/f/q?utm_term=admin=1x" } })).toBe(false);
  });

  test("a non-string url or referer is not a crash", () => {
    // `meta` is attacker-supplied JSON. An unguarded `.includes` threw out of the
    // ingest handler and returned 500, breaking "ingest must never fail a visitor".
    for (const url of [123, {}, null, ["x"], true]) {
      expect(() => isPreviewRecord({ meta: { url } })).not.toThrow();
      expect(isPreviewRecord({ meta: { url } })).toBe(false);
    }
    expect(isPreviewRecord(null)).toBe(false);
    expect(isPreviewRecord("nonsense")).toBe(false);
  });

  test("a truthy non-boolean marker does not suppress", () => {
    // Only an explicit `true` counts, so a stray string cannot discard a lead.
    expect(isPreviewRecord({ preview: "no" })).toBe(false);
    expect(isPreviewRecord({ isPreview: 0 })).toBe(false);
  });
});
