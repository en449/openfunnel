/**
 * @file Regression tests for the engine's two untrusted-string boundaries.
 *
 * Both existed as findings before they existed as code: `step.consent` was the
 * one funnel field rendered through raw `innerHTML`, and the video embed check
 * was an unanchored regex that a `javascript:` URL satisfied by containing the
 * word "player.". A funnel document is imported from templates and bug reports,
 * so both are attacker-reachable without the operator writing anything.
 */
import { test, expect, beforeAll } from "bun:test";
import { installDom } from "./dom-setup.js";

beforeAll(installDom);

/** Render a fragment into a detached div so the result can be queried. */
async function render(html) {
  const { richText } = await import("../src/dom.js");
  const host = document.createElement("div");
  host.appendChild(richText(html));
  return host;
}

test("richText drops elements that load or execute", async () => {
  const host = await render('before<img src="x" onerror="alert(1)">after');
  expect(host.querySelector("img")).toBeNull();
  expect(host.innerHTML).not.toContain("onerror");
  expect(host.textContent).toBe("beforeafter");
});

test("richText keeps no attribute other than a validated href", async () => {
  const host = await render('<span onclick="alert(1)" style="x" data-y="z">hi</span>');
  const span = host.querySelector("span");
  expect(span).not.toBeNull();
  expect(span?.attributes.length).toBe(0);
  expect(host.textContent).toBe("hi");
});

test("richText keeps a real policy link and hardens it", async () => {
  const host = await render('By continuing you accept our <a href="https://ex.com/privacy">policy</a>.');
  const a = host.querySelector("a");
  expect(a?.getAttribute("href")).toBe("https://ex.com/privacy");
  expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(a?.getAttribute("target")).toBe("_blank");
});

test("richText refuses a javascript: href but keeps the words", async () => {
  const host = await render('<a href="javascript:alert(1)">read this</a>');
  expect(host.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(host.textContent).toBe("read this");
});

test("richText refuses an href that only looks same-origin", async () => {
  // The URL parser deletes ASCII tab/newline/CR from anywhere in the input
  // before resolving, so this is `https://evil.tld/phish` by the time a click
  // happens — while every `startsWith("//")`-style check reads it as a path.
  const host = await render('<a href="/\t/evil.tld/phish">privacy policy</a>');
  expect(host.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(host.textContent).toBe("privacy policy");
});

test("richText survives pathological nesting instead of throwing", async () => {
  // ~330KB of nested divs in a JSON field overflowed the recursive walk, and the
  // RangeError escapes `renderForm` into an uncaught `Controller._render` — one
  // consent field took out the whole funnel, not just the consent line. The
  // buried text is discarded; the point is that the funnel still renders.
  const depth = 30_000;
  const host = await render(`${"<div>".repeat(depth)}deep${"</div>".repeat(depth)}`);
  expect(host.textContent).toBe("");
});

test("richText keeps ordinary nesting well inside the depth limit", async () => {
  const host = await render('<p>By continuing you accept our <strong><a href="/legal">terms</a></strong>.</p>');
  expect(host.querySelector("p strong a")?.getAttribute("href")).toBe("/legal");
  expect(host.textContent).toBe("By continuing you accept our terms.");
});

test("richText drops script bodies rather than printing them", async () => {
  const host = await render("<script>alert(1)</script>legal text");
  expect(host.textContent).toBe("legal text");
});

test("richText unwraps an unknown element and keeps its text", async () => {
  const host = await render("<div><h1>Consent</h1> line</div>");
  expect(host.querySelector("div")).toBeNull();
  expect(host.textContent).toBe("Consent line");
});

test("isNavigableUrl resolves the URL rather than pattern-matching it", async () => {
  const { isNavigableUrl } = await import("../src/dom.js");
  // Each of these resolves off-origin in a browser while passing a textual
  // "starts with one slash" test — the parser strips the whitespace first.
  expect(isNavigableUrl("/\t/evil.tld/x")).toBe(false);
  expect(isNavigableUrl("/\n/evil.tld/x")).toBe(false);
  expect(isNavigableUrl("/\r/evil.tld/x")).toBe(false);
  expect(isNavigableUrl("//evil.tld/x")).toBe(false);
  expect(isNavigableUrl("/\\evil.tld/x")).toBe(false);
  expect(isNavigableUrl("javascript:alert(1)")).toBe(false);
  expect(isNavigableUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  expect(isNavigableUrl("")).toBe(false);
  expect(isNavigableUrl(null)).toBe(false);

  expect(isNavigableUrl("/privacy")).toBe(true);
  expect(isNavigableUrl("https://ex.com/privacy")).toBe(true);
  expect(isNavigableUrl("http://ex.com/privacy")).toBe(true);
});

test("isSameOriginUrl allows a path and refuses everything off-origin", async () => {
  const { isSameOriginUrl } = await import("../src/dom.js");
  expect(isSameOriginUrl("/api/lead")).toBe(true);
  expect(isSameOriginUrl("https://leads.attacker.tld/collect")).toBe(false);
  expect(isSameOriginUrl("//attacker.tld/collect")).toBe(false);
  expect(isSameOriginUrl("/\t/attacker.tld/collect")).toBe(false);
  expect(isSameOriginUrl("")).toBe(false);
});

test("embedUrl refuses a javascript: URL that name-drops a player host", async () => {
  const { embedUrl } = await import("../src/dom.js");
  // The exact string the old unanchored `.test()` waved through into an iframe
  // src, where it would have executed with nothing to click.
  expect(embedUrl("javascript:alert(1)//player.")).toBeNull();
  expect(embedUrl("javascript:alert(1)//youtube.com")).toBeNull();
  expect(embedUrl("https://evil.tld/player.")).toBeNull();
  expect(embedUrl("https://notyoutube.com.evil.tld/watch?v=abc123")).toBeNull();
  expect(embedUrl("/media/clip.mp4")).toBeNull();
  expect(embedUrl(undefined)).toBeNull();
});

test("embedUrl still normalises the share URLs operators paste", async () => {
  const { embedUrl } = await import("../src/dom.js");
  expect(embedUrl("https://youtu.be/abc123def")).toBe("https://www.youtube.com/embed/abc123def");
  expect(embedUrl("https://www.youtube.com/watch?v=abc123def")).toBe("https://www.youtube.com/embed/abc123def");
  expect(embedUrl("https://player.vimeo.com/video/12345")).toBe("https://player.vimeo.com/video/12345");
});
