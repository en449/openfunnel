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
import { isInside, isSafeWebhookTarget, isSafeWebhookTargetResolved } from "../server.js";

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
