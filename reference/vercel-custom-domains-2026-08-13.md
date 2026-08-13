# Research: Vercel Custom Domains — Attaching Client Hostnames to a Single Vercel Project
Date: 2026-08-13

Context: OpenFunnel is one Vercel project serving every funnel at `/f/:slug`. Goal: attach
per-client custom hostnames (e.g. `angebot.client-firma.de`) with TLS, and evaluate a
wildcard subdomain (`*.f.enno.de`) to avoid a per-client API call. Team scope:
`enno-s-projects`.

All facts below are quoted/paraphrased directly from Vercel's own docs, fetched
2026-08-13. Each doc page in the new Vercel docs system carries a `last_updated` field —
that value (not "today") is reported as the "Source date" below.

---

## Q1: Plan gating — domains per project + wildcard support (Hobby vs Pro vs Enterprise)

**Answer:**

Domains per project (from the official Limits table):

| | Hobby | Pro | Enterprise |
|---|---|---|---|
| Domains per Project | **50** | **Unlimited*** | **Unlimited*** |

\* "To prevent abuse, Vercel implements soft limits of 100,000 domains per project for
the Pro plan and 1,000,000 domains for the Enterprise plan. These limits are flexible
and can be increased upon request."

**Wildcard domains are NOT plan-gated.** They are a project/domain-configuration feature
available on every plan, including Hobby — the constraint is technical, not billing-based:
a wildcard domain (`*.acme.com`) **must** use Vercel's nameservers (the "Nameservers
method"), because Vercel needs to control DNS to complete the ACME **DNS-01** challenge
required to issue a wildcard TLS certificate. Non-wildcard domains use the simpler
**HTTP-01** challenge and can stay on a third-party DNS provider with just an A/CNAME
record. Direct quote from the add-a-domain doc: "If using your custom domain as a
wildcard domain, you must use the nameservers method for verification." From the
troubleshooting doc: "You have configured wildcard subdomains on your project, but their
nameservers aren't with Vercel. When using a wildcard domain, you must use the
nameservers method."

Practical implication for `*.f.enno.de`: this works on Hobby, but Vercel's nameservers
must be delegated for the `f.enno.de` zone (or the whole `enno.de` zone, via an NS
record delegating `f.enno.de` to Vercel's nameservers if you don't want to move the
entire root domain's DNS to Vercel).

Caveat/ambiguity: the REST API error catalog (see Q3) still documents a
`custom_domain_needs_upgrade` error — `"Domain name creation requires a premium
account."` This appears to be a legacy/edge-case error message (possibly tied to
specific TLDs or account states) since the current Limits page explicitly gives Hobby a
50-domains-per-project allowance. Flagging this as unverified/ambiguous rather than
asserting Hobby has zero custom-domain capability — the Limits table is the more
current, authoritative, and specific source.

**Source:**
- https://vercel.com/docs/limits (`last_updated: 2026-08-03`) — domains-per-project table
- https://vercel.com/docs/domains/working-with-domains/add-a-domain (`last_updated: 2026-02-27`) — "Hobby teams have a limit of 50 custom domains per project"; wildcard nameserver requirement
- https://vercel.com/docs/domains/troubleshooting (`last_updated: 2026-07-20`) — wildcard nameserver requirement, DNS-01 vs HTTP-01
- https://vercel.com/docs/domains/working-with-domains (`last_updated: 2026-06-08`) — wildcard domain definition
- https://vercel.com/docs/rest-api/errors (`last_updated: 2026-08-13`) — `custom_domain_needs_upgrade` error (ambiguous/possibly legacy)

**Confidence:** high for the domains-per-project numbers and the "wildcard = nameservers
method, not a plan gate" finding (multiple independent, current pages agree). Low/flagged
for the `custom_domain_needs_upgrade` error's current applicability.

---

## Q2: REST API — exact endpoints for project domains

**Answer:** All confirmed directly from Vercel's live API reference docs
(`vercel.com/docs/rest-api/...`, `last_updated: 2026-08-13` on every page fetched).
Current version segments are **v9** for the project-domains CRUD family and **v10** for
adding a domain (adding is the newest/highest version; the others are still v9 and are
not marked deprecated anywhere in the docs — no deprecation notice was found on any of
these pages).

| Action | Method | Path |
|---|---|---|
| **Add a domain to a project** | POST | `/v10/projects/{idOrName}/domains` |
| **List a project's domains** | GET | `/v9/projects/{idOrName}/domains` |
| **Get one project domain (incl. verification status)** | GET | `/v9/projects/{idOrName}/domains/{domain}` |
| **Update a project domain** (reassign git branch/env, set redirect) | PATCH | `/v9/projects/{idOrName}/domains/{domain}` |
| **Remove a domain from a project** | DELETE | `/v9/projects/{idOrName}/domains/{domain}` |
| **Verify a project domain** | POST | `/v9/projects/{idOrName}/domains/{domain}/verify` |
| **Get a domain's DNS configuration status** (misconfigured?) | GET | `/v6/domains/{domain}/config` |
| **Get TXT verification record for domain-ownership claim** | GET | `/v9/domains/{domain}/verification` |
| **Move a project domain to a different project** | POST | `/v1/projects/{idOrName}/domains/{domain}/move` |

Every one of these endpoints takes the same two **optional** query parameters:
- `teamId` (string) — "The Team identifier to perform the request on behalf of."
- `slug` (string) — "The Team slug to perform the request on behalf of."

Both are documented as optional on every endpoint. Per the Access Tokens doc (Q3):
"Team- and project-scoped tokens do not require the `teamId` query parameter or the
team `slug` on API requests. Vercel infers the team and project from the token's scope...
Full-account tokens still need `?teamId=` when targeting a specific team's resources."
→ For OpenFunnel under `enno-s-projects`: if using a full-account personal token, you
must pass `?teamId=<team_id>` or `?slug=enno-s-projects` on every call; if using a
team- or project-scoped token, you can omit both.

**Add a domain — request body** (`POST /v10/projects/{idOrName}/domains`):
```json
{
  "name": "angebot.client-firma.de",   // required
  "gitBranch": null,                    // optional, maxLength 250, nullable
  "customEnvironmentId": null,          // optional
  "redirect": null,                     // optional, nullable
  "redirectStatusCode": null            // optional, enum: 301|302|307|308|null
}
```

**Add a domain — 200 response body:**
```json
{
  "name": "angebot.client-firma.de",
  "apexName": "client-firma.de",
  "projectId": "prj_xxx",
  "redirect": null,
  "redirectStatusCode": null,
  "gitBranch": null,
  "customEnvironmentId": null,
  "createdAt": 1691000000000,
  "updatedAt": 1691000000000,
  "verified": false,
  "verification": [
    {
      "type": "TXT",
      "domain": "_vercel.angebot.client-firma.de",
      "value": "vc-domain-verify=...",
      "reason": "pending_domain_verification"
    }
  ]
}
```
Doc quote on the meaning of `verified`: "`true` if the domain is verified for use with
the project. If `false` it will not be used as an alias on this project until the
challenge in `verification` is completed." Doc quote on the flow: "If the domain is not
yet verified to be used on this project, the request will return `verified = false`, and
the domain will need to be verified according to the `verification` challenge via `POST
/projects/:idOrName/domains/:domain/verify`. If the domain already exists on the
project, the request will fail with a `400` status code."

Documented error responses on add-domain: `400` (invalid values, git-branch+redirect
conflict, no successful production deployment yet, self-redirect, production-branch as
domain branch), `401` (unauthorized), `402` (payment method missing), `403` ("You don't
have access to the domain you are adding"), `409` (domain already assigned to another
Vercel project / project being transferred), `410`.

**List domains — response** is paginated:
```json
{
  "domains": [ { "name": "...", "apexName": "...", "projectId": "...", "verified": true, ... } ],
  "pagination": { "count": 20, "next": 1691000000000, "prev": null }
}
```
Query params: `production` (true/false), `target` (production/preview),
`customEnvironmentId`, `gitBranch`, `redirects` (true/false, default true),
`redirect`, `verified` (true/false), `limit` (max 100), `since`, `until`, `order`
(ASC/DESC, default DESC), plus `teamId`/`slug`.

**Remove a domain — response:** `200` returns an empty object `{}`. Optional request
body: `{ "removeRedirects": boolean }` — "Whether to remove all domains from this
project that redirect to the domain being removed." Errors: `400`, `401`, `403`, `404`,
`409` (project being transferred), `410`.

**Verify a domain — response:** same shape as add/get, minus `verification` array once
verified. Documented `400` failure messages: "There is an existing TXT record on the
domain verifying it for another project", "The domain does not have a TXT record that
attempts to verify the project domain", "The TXT record on the domain does not match the
expected challenge for the project domain", "Project domain is not assigned to project."

**Get domain config (`/v6/domains/{domain}/config`)** — used to check DNS/cert health:
```json
{
  "configuredBy": "CNAME" | "A" | "http" | "dns-01" | null,
  "acceptedChallenges": ["http-01" | "dns-01"],
  "recommendedIPv4": [ { "rank": 1, "value": [...] } ],
  "recommendedCNAME": [ { "rank": 1, "value": "..." } ],
  "misconfigured": true | false
}
```
`misconfigured` is described as: "Whether or not the domain is configured AND we can
automatically generate a TLS certificate." This endpoint accepts an optional
`projectIdOrName` query param "to use when the domain is not yet associated with a
project," plus `strict` (true/false).

**Source:**
- https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project
- https://vercel.com/docs/rest-api/projects/retrieve-project-domains-by-project-by-id-or-name
- https://vercel.com/docs/rest-api/projects/get-a-project-domain
- https://vercel.com/docs/rest-api/projects/update-a-project-domain
- https://vercel.com/docs/rest-api/projects/remove-a-domain-from-a-project
- https://vercel.com/docs/rest-api/projects/verify-project-domain
- https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration
- https://vercel.com/docs/rest-api/domains/get-domain-verification-record
- https://vercel.com/docs/rest-api (endpoint index, confirms v9/v10 segments and full
  `projects` group listing)
- (all `last_updated: 2026-08-13`)

**Confidence:** high — these are current, machine-generated-from-OpenAPI reference
pages fetched live today, with exact JSON schemas, not third-party paraphrase.

---

## Q3: Auth — token type, scope, and what "no team access" looks like

**Answer:** Vercel REST API auth is a single mechanism: a **bearer access token**
(`Authorization: Bearer <token>`). There is no separate "OAuth vs PAT" distinction for
this use case beyond how the token was minted — personal access tokens created in the
dashboard/CLI carry the prefix `vcp_` and behave identically to OAuth-issued tokens on
the wire (both are bearer tokens). OAuth2 exists as a separate flow only for building
third-party Vercel **Integrations**, not needed here.

**Token scoping levels** (three, chosen at creation time):
- **Full Account** — "Acts on your personal account and every team you belong to."
- **Team** — "Limited to a single team. The token can read and write that team's
  resources across all of its projects."
- **Project** — "Limited to a single project within a team. The token can only read and
  write resources belonging to that one project." "A project-scoped token denies any
  request to another project, to a user-level resource, or to a team-level resource."

For OpenFunnel under `enno-s-projects`, recommendation implied by the docs: create a
**Team**- or **Project**-scoped token against `enno-s-projects` (or the specific
OpenFunnel project) — then `teamId`/`slug` can be omitted entirely, since "Vercel infers
the team and project from the token's scope." A **Full Account** token requires passing
`?teamId=...` (or `?slug=enno-s-projects`) on every request or it will act on the
personal account instead of the team.

Note: "Some teams require you to enable two-factor authentication or SAML before you
can create tokens scoped to them." And: "Creating tokens through the CLI or API requires
a full-account token. A project-scoped token cannot mint new tokens."

**Response shape when the token lacks access** (generic `403`/forbidden, documented in
the REST API error catalog):
```json
{
  "error": {
    "code": "forbidden",
    "message": "Not authorized"
  }
}
```
For domain-specific access-denial (token/team doesn't own the domain), the docs give a
more specific variant:
```json
{
  "error": {
    "code": "forbidden",
    "message": "You don't have access to \"DOMAIN\"",
    "domain": "DOMAIN"
  }
}
```

**Source:**
- https://vercel.com/docs/accounts/access-tokens (`last_updated: 2026-08-03`)
- https://vercel.com/docs/rest-api/errors (`last_updated: 2026-08-13`)

**Confidence:** high.

---

## Q4: DNS the client must configure

**Answer:**

**Apex domain** (e.g. `client-firma.de`): **A record**. Vercel's docs explicitly forbid
CNAME at the zone apex per RFC1034 §3.6.2 ("If a CNAME RR is present at a node, no other
data should be present"), so apex domains always get an A record. Documented values:
- **General-purpose value:** `76.76.21.21` — "a general-purpose anycast address," used
  by most existing/older projects.
- **Newer/plan-specific values:** newer projects can be assigned an address from "a pool
  of anycast IPs matched to the plan and project" — the docs give `216.198.79.1` as one
  example of such an alternate value.
- **The docs are explicit that you must use whatever value the project's own Domains
  settings page/API shows, not a hardcoded IP found elsewhere:** "Always use the value
  shown in your project's domain card... verification checks for the exact A record your
  project expects." → **Do not hardcode `76.76.21.21` in client-facing instructions** —
  read it per-domain from the dashboard or from `GET /v6/domains/{domain}/config`
  (`recommendedIPv4`) at attach time.
- These IPs are Anycast, not tied to a specific geography: "Although this IP address
  resolves to a specific geographic location, it does not mean that... users will be
  sent to this specific geographic location."

**Subdomain** (e.g. `angebot.client-firma.de`): **CNAME record**. "Each project has a
unique CNAME record e.g. `d1d4fc829fe7bc7c.vercel-dns-017.com`." This is a
**per-project, dynamically generated** value (not the older static
`cname.vercel-dns.com` some tutorials still reference) — again, read the actual value
from the dashboard/API for that specific project, not from a blog post. Also documented:
"the old records of `cname.vercel-dns.com` and `76.76.21.21` will continue to work but
new entries are now dynamic" (per third-party summary of Vercel's own DNS guidance —
flagging this specific "still works" claim as **unverified** since it wasn't in a
directly-quoted primary source, only in a WebSearch AI summary).

**Critical syntax gotcha documented by Vercel itself:** the CNAME value they give you
ends in a trailing period (`.`) denoting a fully-qualified domain name, and "you must
copy the value exactly as it appears, including the period." Also: the DNS record
**Name** field must be just the prefix (e.g. `angebot`), never the prefix + full domain.

**TXT verification record — "domain already in use by another Vercel account" case:**
Two distinct TXT flows exist in the docs, both scoped under the target hostname:
1. **Project-domain verification challenge** (returned inline by `POST
   /v10/projects/{idOrName}/domains`): `verification[].type = "TXT"`,
   `verification[].domain = "_vercel.{domain}"`, `verification[].value = <challenge
   string>`. You add a TXT record at `_vercel.<domain>` with that value, then call
   `POST /projects/:idOrName/domains/:domain/verify`.
2. **Domain-ownership claim** (`GET /v9/domains/{domain}/verification`): "Get the TXT
   verification record needed to claim ownership of a domain for the authenticated
   team. The caller must add this TXT record to `_vercel.{domain}` in their DNS
   configuration, then call `POST /domains/:domain/claim` to complete the ownership
   transfer." Response: `{ "txtRecord": "...", "verificationDomain": "..." }`.

Doc-level narrative confirms the same UX flow: "If the domain is in use by another
Vercel account, you may be prompted to verify access to the domain... This will not
move the domain into your account, but will allow you to use it in your project... you
can only set up one TXT record at a time." Alternative for the "I own the domain but not
the Vercel account" case: "**Connect External** option on the Domains dashboard...
You'll receive a TXT record to add to your DNS to verify ownership. Once verified, the
domain will automatically transfer to your account."

**Wildcard domains:** cannot use A/CNAME at all — **must** delegate nameservers to
Vercel (see Q1), because wildcard TLS certs require the DNS-01 challenge which needs
Vercel to control DNS directly.

**Source:**
- https://vercel.com/docs/domains/working-with-domains/add-a-domain (`2026-02-27`)
- https://vercel.com/docs/domains/troubleshooting (`2026-07-20`)
- https://vercel.com/docs/domains/working-with-domains (`2026-06-08`)
- https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project (`2026-08-13`)
- https://vercel.com/docs/rest-api/domains/get-domain-verification-record (`2026-08-13`)
- https://vercel.com/kb/guide/a-record-and-caa-with-vercel (`2026-07-28`)

**Confidence:** high for the record types, TXT flow, and "read the value per-project"
rule; medium for the specific IP examples quoted (they are documented as *examples*, the
actual value is project-specific and must be fetched live); low/unverified for the
"cname.vercel-dns.com still works" backward-compatibility claim.

---

## Q5: Verification lifecycle — pending → verified → certificate issued

**Answer:**

**Fields while pending** (from `POST/GET /v9|v10/projects/{idOrName}/domains[/{domain}]`):
`verified: false` plus a `verification` array of challenge objects (`type`, `domain`,
`value`, `reason`). While `verified` is `false`, the docs state the domain "will not be
used as an alias on this project" — i.e. it won't serve traffic yet.

**How to poll:** Two-step, documented explicitly:
1. `POST /v10/projects/{idOrName}/domains` (add) returns `verified` + `verification`
   challenge.
2. Configure the DNS/TXT record per the challenge, then `POST
   /v9/projects/{idOrName}/domains/{domain}/verify` — "Attempts to verify a project
   domain with `verified = false` by checking the correctness of the project domain's
   `verification` challenge." Returns `verified: true` on success (with a `200`
   response even if "Domain is already verified").
3. For DNS-config / certificate-eligibility status independent of the ownership
   challenge, poll `GET /v6/domains/{domain}/config` and check `misconfigured` — Vercel
   defines this field explicitly as "Whether or not the domain is configured AND we can
   automatically generate a TLS certificate." `misconfigured: false` is your signal that
   DNS is correct and a cert can be (or has been) issued.
4. The CLI equivalent for humans/scripts: `vercel domains verify <domain> --project
   <project> --format json` — "inspects ownership, DNS records, nameservers, DNSSEC,
   conflicting records, and project attachment, and tells you precisely what to change,"
   returning "status, reason, recommended records, detected conflicts, and suggested
   next commands" in JSON mode. (Requires Vercel CLI ≥ 54.15.1.)

There is **no separate "certificate status" field/endpoint documented** beyond
`misconfigured` on the domain-config endpoint and the general dashboard UI; the `certs`
REST group (`GET/POST/PUT/DELETE /v8/certs`) exists for *custom/uploaded* certificates,
not for querying the state of Vercel's own automatic Let's Encrypt issuance.

**How issuance actually works (5-step flow, quoted verbatim):**
1. "Vercel asks LetsEncrypt for a certificate for that domain and asks how it can prove
   control of the domain"
2. "Let's Encrypt reviews the domain and issues Vercel with a challenge... usually in the
   format of creating a file or DNS record with a particular code."
3. "Vercel creates that file with the code on the HTTP-01 or DNS-01 validation path and
   tells LetsEncrypt it's done"
4. "LetsEncrypt then check[s] to see if the file is there and if they can see the file,
   they send us the certificate"
5. "Vercel then adds the certificate to our infrastructure and it then starts working on
   HTTPS"

Non-wildcard domains use **HTTP-01** ("providing the request can make it to Vercel, then
our infrastructure will deal with it" — i.e. fully automatic once the A/CNAME resolves
to Vercel, no manual DNS-01 record needed). Wildcard domains use **DNS-01**, handled
automatically only if nameservers are delegated to Vercel.

**Typical timing: not numerically specified anywhere in the docs I could access.** The
docs only say cert generation "will only work once the certificate validation request is
successful, which happens once DNS records are added and propagated," and separately
that DNS **record** propagation (A/CNAME/TXT) is typically fast while **nameserver**
changes "can take up to 24–48 hours to fully propagate across the internet." Community
folklore (mirzapandzo.com blog, not Vercel-authored, so treated as unverified) suggests
certs often issue within minutes once DNS is correct, but Vercel does not publish an SLA
or typical duration figure. **This is a genuine documentation gap — do not build a fixed
timeout/retry budget into your polling logic without a manual safety margin.**

**Documented failure modes:**
- **Missing/wrong CAA records**: "Since we use Let's Encrypt for our automatic SSL
  certificates, you must add a CAA record with the value `0 issue \"letsencrypt.org\"` if
  other CAA records already exist on your domain." Check via `dig -t CAA +noall +ans
  example.com`.
- **Stale `_acme-challenge` TXT record** from a previous host, blocking issuance —
  "please consider removing the DNS record."
- **Domain already claimed by another Vercel account/team** — "A domain can only be
  associated with one Personal Account or Team at a time," surfaces as `This team has
  already registered this domain` / `Another Vercel account is using this domain`, fixed
  via transfer or the "Connect External" TXT-verification flow (see Q4).
- **Misconfigured DNS** — generic "Invalid Configuration" alert in the dashboard,
  diagnosable via `dig a`/`dig cname`/`dig ns` or the `GET /v6/domains/{domain}/config`
  endpoint's `misconfigured` field.
- **Rewriting/redirecting `/.well-known`** — reserved path used for HTTP-01 challenges;
  "cannot be redirected or rewritten." If OpenFunnel's routing (e.g. a catch-all
  `/f/:slug` rewrite) ever intercepts `/.well-known/*`, certificate issuance/renewal
  would silently break — worth an explicit exclusion in your routing config.
- **IPv6 (AAAA) not supported** for third-party-DNS domains: "we do not support IPv6
  yet... if you are adding a custom domain from a third-party, you won't be able to
  point an AAAA record to Vercel."

**Source:**
- https://vercel.com/docs/domains/working-with-ssl (`2026-06-08`)
- https://vercel.com/docs/domains/troubleshooting (`2026-07-20`)
- https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration (`2026-08-13`)
- https://vercel.com/docs/rest-api/projects/verify-project-domain (`2026-08-13`)
- https://vercel.com/docs/cli/domains (`2026-07-15`)

**Confidence:** high for the mechanics/fields/failure modes (direct quotes from primary
docs); explicitly low/"not findable" for a concrete issuance-time SLA — Vercel does not
publish one.

---

## Q6: Rate limits on the domains endpoints

**Answer:** From the official Limits page's Rate Limits table (`scope` = `owner` means
"the team or... individual user, depending on the resource"; `user` = per authenticated
user):

| Description | Limit | Duration | Scope |
|---|---|---|---|
| Project domains get per minute | 500 | 60s | user |
| Get project domains count per minute | 100 | 60s | user |
| Project domains verification per minute | 100 | 60s | user |
| Project domain creation, update, or remove per minute | 100 | 60s | owner |
| Domain deletion (account-level) | 60 | 60s | owner (also stated separately as an "example": "up to 60 domains every 60 seconds") |
| Domains deletion per minute | 100 | 60s | owner |
| Domains retrieval per minute | 200 / 500 (two separate limits listed) | 60s | user |
| Domain project domains retrieval per minute | 200 | 60s | user |
| Domains dns config retrieval per minute | 500 | 60s | user |
| Domains update per minute | 60 | 60s | owner |
| **Domains creation per hour** | **120** | 3600s | owner |
| Domains record update per minute | 50 | 60s | owner |
| Domains record creation per minute | 50 | 60s | owner |
| Domains status retrieval per minute | 150 | 60s | owner |
| Domain verification record retrieval per minute | 60 | 60s | owner |
| Domain ownership claim attempts per minute | 10 | 60s | owner |

There is **no separate documented "per plan" ceiling specifically for domain additions**
beyond the flat rate limits above (which apply regardless of Hobby/Pro/Enterprise) and
the per-project domain-count cap from Q1 (50 on Hobby). The closest thing to a
per-day/hour domain-addition ceiling is **"Domains creation per hour: 120, scope:
owner"** — i.e. you can add up to 120 domains/hour team-wide via the API, platform-wide,
independent of plan.

On rate-limit responses generally, the error catalog documents this shape:
```json
{
  "error": {
    "code": "rate_limited",
    "message": "The rate limit of 6 exceeded for 'api-www-user-update-username'. Try again in 7 days",
    "limit": { "remaining": 0, "reset": 1571432075, "resetMs": 1571432075563, "total": 6 }
  }
}
```
(example shown is for username changes, but the response shape — `error.code =
rate_limited` with a `limit` object containing `remaining`/`reset`/`resetMs`/`total` —
applies to all rate-limited endpoints per the docs.)

**Source:**
- https://vercel.com/docs/limits (`2026-08-03`) — full rate-limit table, "Rate limit
  examples" section
- https://vercel.com/docs/rest-api/errors (`2026-08-13`) — `rate_limited` error shape

**Confidence:** high for the numbers (direct table dump from the live docs); medium on
completeness — the table lists 300+ rows and several domain-related rows share
near-identical descriptions with different numbers (likely legacy + current variants
both still listed), so treat this as "the documented ceiling," not a guarantee no other
domains-specific limit exists.

---

## Q7: Serving — Host header, hostname-carrying headers, and Deployment Protection/SSO interaction

**Answer:**

**`host` header:** "This header represents the domain name as it was accessed by the
client. If the deployment has been assigned to a preview URL or production domain and
the client visits the domain URL, it contains the custom domain instead of the
underlying deployment URL." → Yes, once `angebot.client-firma.de` is attached and
verified, the function sees `host: angebot.client-firma.de` for requests made to that
hostname.

**`x-forwarded-host`:** documented as "identical to the `host` header" — carries the
same custom-domain value. Use either interchangeably per Vercel's own docs.

**`x-vercel-deployment-url`:** the one header that does *not* carry the custom domain —
"This header represents the unique deployment, not the preview URL or production
domain. For example, `*.vercel.app`." Useful if OpenFunnel ever needs to distinguish
"which deployment served this" from "which hostname the client used."

**Deployment Protection / SSO interaction with a custom domain — this is the most
load-bearing finding for OpenFunnel's current setup ("only deployed as SSO-protected
previews, never `--prod`):**

Direct quote, Hobby-specific callout on the Deployment Protection overview page: "On the
Hobby plan, Vercel Authentication with Standard Protection is available. This protects
your preview deployments and deployment URLs, **but your production domain remains
publicly accessible**. To protect production domains, you need a Pro or Enterprise
plan."

**Standard Protection** (the default/only meaningfully-configurable option on Hobby):
"Protects all deployments **except** production domains. Available on all plans." This
means: **a custom domain attached to a project and pointed at the Production
environment is public by default**, regardless of Deployment Protection/SSO settings on
Hobby — SSO/password gates only ever cover preview URLs and the generated
`*.vercel.app` deployment URLs, never a verified custom domain serving production
traffic. `All Deployments` protection (which *would* cover the production domain too) is
explicitly "Available on Pro and Enterprise plans" only — not selectable on Hobby.

**Consequence for OpenFunnel specifically:** since the project has "never run `vercel
--prod`" and currently only has SSO-protected preview deployments, attaching a custom
domain in the Vercel dashboard/API only makes it public once that domain is assigned
either (a) to the **Production** environment (the default target for any domain added
without an explicit `gitBranch`/environment), which requires an actual Production
deployment to exist ("The domain can not be added because the latest production
deployment for the project was not successful" is a documented `400` error on the
add-domain endpoint — i.e. **you cannot attach and serve a domain until at least one
successful production deployment exists**), or (b) explicitly to a **Preview**
environment/git branch via the `gitBranch` field — in which case that domain **remains
subject to Deployment Protection** like any other preview URL, meaning client-facing
funnel URLs would sit behind Vercel's SSO login wall, which is very likely not what you
want for `angebot.client-firma.de`.

**Practical implication:** to serve client custom domains without SSO-gating them, the
project needs (1) at least one successful **Production** deployment (i.e. an actual
`vercel --prod`/production Git push, not just previews), and (2) the domain attached
with no `gitBranch` override (defaults to tracking Production) — then Standard
Protection's "production domains remain publicly accessible" carve-out applies
automatically, even on Hobby.

**Source:**
- https://vercel.com/docs/headers/request-headers (`2025-12-13`)
- https://vercel.com/docs/deployment-protection (`2026-07-30`)
- https://vercel.com/docs/domains/working-with-domains/assign-domain-to-a-git-branch (`2026-02-27`)
- https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project (`2026-08-13`) — the "latest production deployment... was not successful" 400 error

**Confidence:** high on the header behavior (directly quoted, unambiguous). High on the
Standard Protection Hobby carve-out (directly quoted, explicit Hobby callout). Medium on
the specific inference "you must have a successful production deployment before a
newly-added domain can serve traffic publicly" — this is assembled from two separate
doc statements (the 400 error message, and "production domain" language throughout) that
were not found combined into one explicit worked example; recommend verifying with a
single live add-domain call once a production deploy exists, before relying on it in
automation.

---

## Q8: Gotchas that would bite

**Answer:** Compiled from the Troubleshooting page and other primary docs, each with the
exact documented cause/fix.

1. **Domain stuck "pending" / not verifying**
   - Cause candidates documented: DNS not yet configured, TXT-verification not yet added
     if domain is claimed by another account, missing CAA record blocking cert issuance,
     wildcard domain not using the nameservers method.
   - Fix path: `dig a`/`dig cname`/`dig ns` (or Google Public DNS) to confirm the actual
     resolved records match what the project's Domains settings/`GET
     /v6/domains/{domain}/config` expects; for ownership disputes use "Connect External"
     + TXT record.
   - DNS **record** propagation (A/CNAME/TXT) is typically fast; **nameserver** changes
     can take **24–48 hours**. Vercel's own recommendation: lower the existing DNS TTL
     (e.g. to 60s) *before* cutting over, so you can roll back quickly if something's
     wrong.

2. **`vercel domains verify`** — CLI command (needs CLI ≥ 54.15.1) that diagnoses
   "ownership, DNS records, nameservers, DNSSEC, conflicting records, and project
   attachment" and returns "the exact steps to fix it." Not strictly required (the REST
   API's own `verify` endpoint + `config` endpoint cover the same ground
   programmatically), but is the fastest manual diagnostic. `--format json` gives a
   machine-readable diagnosis; `--strict` disables falling back to the parent zone's
   config.

3. **Apex vs CNAME / RFC violation:** you cannot put a CNAME at an apex domain (RFC1034
   §3.6.2) — Vercel will hand you an **A** record for apex domains and a **CNAME** for
   subdomains; there's no way around this, it's a DNS-spec constraint, not a Vercel
   choice.

4. **`www` handling:** adding an apex domain (`client-firma.de`) auto-prompts you to
   also add the `www` subdomain. Vercel will "attempt to redirect automatically"
   with/without `www` even if you don't explicitly configure a redirect, but the docs
   recommend explicitly adding one for "more robust protection." Recommended pattern:
   make `www.client-firma.de` (CNAME, more DDoS/perf-resilient because it can repoint
   without a DNS record change) the primary, with an explicit redirect from the apex —
   though for OpenFunnel's actual use case (a subdomain like `angebot.client-firma.de`,
   not a bare apex), this mostly doesn't apply.

5. **Absolute CNAME trailing dot:** the CNAME value Vercel gives you for a subdomain
   (e.g. `d1d4fc829fe7bc7c.vercel-dns-017.com.`) **includes a trailing period** denoting
   an FQDN — copy it exactly, including the dot, into the client's DNS provider.

6. **DNS record "Name" field mistake:** must be just the prefix (`angebot`), never
   `angebot.client-firma.de` again — a very common client-side data-entry error, worth
   calling out explicitly in any client-facing setup instructions you write.

7. **CAA records silently blocking issuance:** if the client's domain (or its DNS
   provider's default zone template) already has *any* CAA record, Let's Encrypt is
   blocked unless a record with value `0 issue "letsencrypt.org"` also exists. This is a
   common silent-failure mode for domains migrated from other hosts (Cloudflare, GoDaddy
   templates, etc. sometimes ship default CAA records).

8. **Redirect vs git-branch mutual exclusivity:** the add/update-domain API explicitly
   rejects setting both `redirect` and `gitBranch` on the same domain in one call ("You
   can't set both a git branch and a redirect for the domain").

9. **Domain attached to a preview/branch alias vs Production — meaningfully different
   behavior, confirmed two ways:**
   - **Deployment/serving:** "When you assign a domain to a *different* branch, you'll
     need to make a new deployment to the desired branch for the domain to resolve
     correctly" — a branch-assigned domain does **not** auto-track new deploys the way a
     Production domain does; you (or your CI) must redeploy that branch for the domain
     to update.
   - **Deployment Protection:** as covered in Q7, a domain assigned to a Preview
     environment/branch stays behind Vercel Authentication SSO if Standard Protection is
     on; a Production-environment domain does not (even on Hobby). This is the single
     most consequential "attach it to the wrong environment" trap for this project given
     its current SSO-preview-only deploy history.
   - Pro/Enterprise-only nuance: "Pro and Enterprise teams can also set branch tracking
     for their custom environments" (multi-environment feature, not available on Hobby).

10. **`custom_domain_needs_upgrade` API error exists in the docs** ("Domain name
    creation requires a premium account") — flagged in Q1 as possibly stale/legacy, but
    worth a defensive check in your integration code: if you ever see this exact error
    code from a Hobby-scoped token, it directly contradicts the current Limits page and
    should be treated as a live bug report / re-verify-immediately signal, not silently
    swallowed.

11. **`/.well-known` path is reserved** — cannot be redirected/rewritten by your app
    (used for HTTP-01 ACME challenges). If OpenFunnel's `/f/:slug` catch-all routing (or
    any custom `vercel.json` rewrite) is broad enough to intercept this path, certificate
    issuance/renewal for HTTP-01-validated domains would break silently. Worth an
    explicit test once domains are live.

12. **IPv6 not supported for third-party-DNS domains** — don't offer/document AAAA
    records to clients; Vercel doesn't support them for domains not on Vercel
    nameservers.

**Source:**
- https://vercel.com/docs/domains/troubleshooting (`2026-07-20`)
- https://vercel.com/docs/domains/working-with-domains/deploying-and-redirecting (`2026-07-23`)
- https://vercel.com/docs/domains/working-with-domains/assign-domain-to-a-git-branch (`2026-02-27`)
- https://vercel.com/docs/cli/domains (`2026-07-15`)
- https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project (`2026-08-13`)
- https://vercel.com/docs/rest-api/errors (`2026-08-13`)

**Confidence:** high — all items are direct quotes/close paraphrases of primary Vercel
docs, cross-checked against the troubleshooting page which exists specifically to
enumerate these failure modes.

---

## Summary of the two biggest build-relevant risks (not asked directly, but load-bearing)

1. **SSO/Deployment Protection**: on Hobby, a custom domain is only public if it's
   attached to the **Production** environment of a project that has at least one
   successful production deployment. OpenFunnel currently has never run `vercel --prod`.
   Attaching client domains today, without first shipping a real production deployment,
   will either fail outright (documented 400: "latest production deployment... was not
   successful") or — if assigned to a preview branch instead — silently put every client
   funnel behind Vercel's SSO login wall. This needs to be resolved (ship to Production)
   before any client domain work begins.

2. **Wildcard (`*.f.enno.de`) requires full nameserver delegation** of the `f.enno.de`
   zone (or the parent `enno.de` zone) to Vercel — not just a DNS record. That's an
   architectural decision (who controls DNS for that zone going forward, MX record
   migration for email if any exists on that zone, 24–48h cutover window) distinct from,
   and larger than, the "per-client A/CNAME record" flow for one-off client domains like
   `angebot.client-firma.de`.
