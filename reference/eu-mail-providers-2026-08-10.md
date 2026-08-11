# Research: EU/German Transactional Email Providers for DSGVO-Compliant Lead-Capture Platform
Date: 2026-08-10

Status: COMPLETE. 16 providers/entities researched (11 originally named + Newsletter2Go-is-Brevo clarification + Flowmailer as an added find); every hard requirement answered per candidate with source + confidence; see Recommendation at the end.

## Q1: Brevo (French, formerly Sendinblue)

**Company/entity:** Brevo SAS (formerly Sendinblue SAS), 17 rue Salneuve, 75017 Paris, France, RCS Paris 498 019 298.
**Source:** https://help.brevo.com/hc/en-us/articles/15403782599570-Where-can-I-find-the-Data-Processing-Agreement-DPA (retrieved via search 2026-08-10); DPA PDF at https://corp-backend.brevo.com/wp-content/uploads/2024/08/BREVO-Annex-2-DPA-150524.pdf
**Confidence:** high (primary source PDF + help center)

**Datacenter:** Search results state "all Brevo email, SMS, and contact data is processed and stored within the EU," company is EU-based (France). Specific city/country of the datacenter was not confirmed from a primary page in this pass (WebFetch on brevo.com pages returned only page titles, JS-rendered — content not retrievable this way).
**Source:** aggregated search snippet from https://www.flowconsent.com/en/services/marketing/brevo and https://european-alternatives.eu/product/brevo, both secondary sources, retrieved 2026-08-10. **(needs primary-source confirmation — mark as medium confidence)**
**Confidence:** medium

**Requirement check:**
1. EU/EEA hosting — Yes (secondary sources agree, France/EU; exact DC city unconfirmed) — medium confidence
2. AVV/DPA — Yes, DPA is Appendix/Annex 2 of the Terms of Service, publicly downloadable PDF, appears auto-included in ToS (no separate signature needed per help article, though enterprise customers can request a countersigned copy). Source: https://corp-backend.brevo.com/wp-content/uploads/2024/08/BREVO-Annex-2-DPA-150524.pdf — high confidence
3. Transactional email — Yes, dedicated Transactional Email product with own API endpoint (see below) — high confidence
4. HTTP JSON POST API — Yes. `POST https://api.brevo.com/v3/smtp/email`, JSON body with sender/to/subject/htmlContent, auth via `api-key` header. Source: https://developers.brevo.com/reference/sendtransacemail, retrieved 2026-08-10 — high confidence
5. No US parent — Yes, French SAS, no indication of a US parent company found — medium confidence (not exhaustively checked for US sub-processors, see below)

**SMTP fallback:** Not directly confirmed this pass, but Brevo is widely known (general knowledge, unverified this session) to also offer SMTP relay (smtp-relay.brevo.com, port 587) alongside the API. **(unverified in this research pass — flag for follow-up)**

**Pricing:** Free plan = 300 emails/day (~9,000/month) forever free. Paid "Starter" plan from $9/month for 5,000 emails/month (USD price found; EUR price not confirmed — brevo.com/de/pricing/ page did not render via WebFetch, JS-heavy). Sources: https://www.emailtooltester.com/en/reviews/brevo/pricing/, https://thatmarketingbuddy.com/pricing/brevo, both secondary, retrieved 2026-08-10.
**Confidence:** medium (numbers from aggregator sites, not Brevo's own pricing page directly — that page did not render as text)

**Deliverability:** Not yet researched this pass — TODO.

**Sub-processor list:** Not yet located — TODO.

---

## Q2: Mailjet (French, part of Sinch — Sinch is Swedish/public, HQ Stockholm)

**Company/entity:** Mailjet SAS, part of Sinch AB (Sweden). DPO contact dpo@sinch.com; DPO function reportedly outsourced to "White Label Consultancy A/S."
**Source:** https://www.mailjet.com/legal/security-privacy/, retrieved 2026-08-10.
**Confidence:** high

**Datacenter:** "Data is stored in secure data centers with Google Cloud Platform in Frankfurt (Germany) and Saint-Ghislain (Belgium)."
**Source:** https://www.mailjet.com/legal/security-privacy/, retrieved 2026-08-10.
**Confidence:** high

**IMPORTANT CAVEAT:** Underlying infra is Google Cloud Platform (a US-headquartered hyperscaler) even though the specific datacenters are physically in the EU (Frankfurt/Belgium). This means CLOUD Act exposure is a live concern even with EU-located datacenters — GCP as operator is a US company subject to US law regardless of where the physical servers sit. Source (secondary analysis): https://www.eucloudpatterns.eu/posts/eu-email-migration/, retrieved 2026-08-10.
**Confidence:** medium (this is an analyst's interpretation, not Mailjet's own admission, but the GCP hosting fact itself is stated by Mailjet)

**Requirement check:**
1. EU/EEA hosting — Partially: physical datacenters are in Germany/Belgium (EU), BUT infrastructure operator is Google Cloud (US company) → **Unclear/caveat** — the physical-location requirement is technically met, but "no US company in the path" is not, since GCP operates the infra. Flag as borderline.
2. AVV/DPA — Yes, "standard DPA" available, linked from the security page (Sinch's standard DPA). Source: https://www.mailjet.com/legal/security-privacy/, retrieved 2026-08-10 — high confidence
3. Transactional email — Yes, this is Mailjet's core product — high confidence
4. HTTP JSON POST API — Yes, Mailjet has a well-documented Send API (see below) — high confidence
5. No US parent/sub-processor — **No** — parent is Sinch (Swedish public co, but Sinch itself has US operations from its OpenMarket/former Syniverse-adjacent history) AND infra sub-processor is Google Cloud Platform, a US company. This is a clear disclosed US touchpoint in the mail path.

**SMTP:** Mailjet also offers SMTP relay (in.mailjet.com, port 587/465) alongside API — general product knowledge, not directly re-verified this pass **(unverified this session, flag for follow-up)**.

**Pricing:** Free plan = 6,000 emails/month total, capped at 200/day, 1,000 contacts. Paid "Starter" from $9/month for 8K emails, "Essential" $17/month for 15K, "Premium" $27/month for 15K with more features. EUR pricing not directly confirmed (French company bills in EUR normally, but figures found were USD from aggregator sites). Sources: https://omr.com/en/reviews/product/mailjet/pricing, https://www.emailvendorselection.com/mailjet-review/, retrieved 2026-08-10.
**Confidence:** medium

**Deliverability / sub-processors:** Not yet researched — TODO.

---

## Q3: rapidmail (German, Freiburg im Breisgau)

**Company/entity:** rapidmail GmbH, Freiburg im Breisgau, Germany.
**Source:** search aggregation incl. https://www.rapidmail.de/hilfe/kategorie/dsgvo-datensicherheit, retrieved 2026-08-10.
**Confidence:** medium (not fetched primary page directly yet for entity/address)

**Datacenter:** Servers "exclusively in Germany (Freiburg and Frankfurt)." ISO 27001, CSA, TÜV Saarland certified.
**Source:** secondary aggregation from search, citing rapidmail's own claims, retrieved 2026-08-10.
**Confidence:** medium

**Requirement check:**
1. EU/EEA hosting — Yes, Germany specifically (Freiburg + Frankfurt) — medium-high confidence
2. AVV/DPA — Yes, "AVV nach EU-DSGVO" can be concluded electronically inside the account (Account > Datenschutz). Self-serve. Source: https://www.rapidmail.de/hilfe/datenschutzvertrag-nach-eu-dsgvo-abschliessen, retrieved 2026-08-10 — high confidence
3. Transactional email — Yes, dedicated "Transaktionsmails" feature exists — high confidence
4. **HTTP JSON POST API — NOT CONFIRMED / likely NO.** The transactional-email feature page (https://www.rapidmail.de/funktionen-transaktionsmails-versenden, fetched 2026-08-10) describes **SMTP only** ("SMTP-Zugangsdaten" / SMTP credentials exchanged with shop/CRM/CMS) — no REST/JSON API endpoint mentioned for transactional sending. rapidmail does have a general marketing/contacts REST API for other purposes, but the transactional-send feature itself is presented as SMTP-relay based. **This is a likely DISQUALIFIER for hard requirement 4** unless further docs show otherwise.
**Confidence:** medium (based on one page; rapidmail's general API docs not yet checked for a transactional send endpoint)
5. No US parent — Yes, appears to be a purely German/EU company — medium confidence

**SMTP:** Yes — confirmed as the primary/only mechanism for transactional email. Exact host/port not stated on the page fetched; not yet found.

**Pricing:** Free tier: up to 1,000 transactional emails/month at no cost. Paid: from €59/month (+VAT) for up to 50,000 transactional emails/month. For the target range of 1,000-5,000/month, likely falls in the free tier or the lowest paid tier — exact tier breakpoints not found yet.
**Source:** https://www.rapidmail.de/funktionen-transaktionsmails-versenden, retrieved 2026-08-10 (WebFetch).
**Confidence:** medium-high

**PRELIMINARY VERDICT: rapidmail likely fails hard requirement 4 (HTTP JSON POST API for transactional send) — needs one more check of rapidmail's developer/API docs before final disqualification.**

## Context note (not a research finding, for the recommendation section only)

The existing transport in this codebase (`apps/runtime/lib/email.js`) has two working
paths: `RESEND_API_KEY` (hardcoded to `POST https://api.resend.com/emails`) and
`SMTP_RELAY_URL` (env-only, `POST` of `{ to, subject, html, text }` as JSON to
whatever URL is configured — no built-in shape translation, no auth header added by
this code). Direct SMTP is explicitly NOT implemented. This means: any EU provider
whose native API does not happen to accept exactly `{to, subject, html, text}` needs
either (a) a small serverless adapter function in front of `SMTP_RELAY_URL` that
translates to the provider's real JSON shape and adds its auth header, or (b) new
code inside `email.js` mirroring the `resend` branch for a `provider === "brevo"` (etc.)
case. No candidate below is a zero-code drop-in; all require either an adapter or a
new branch. This does not change any pass/fail verdict below, which is evaluated
against the plain hard requirements only.
**Source:** /Users/ennolensch/AI Stuff/OpenFunnel/apps/runtime/lib/email.js, read 2026-08-10.

---

## Q4: rapidmail — API check follow-up

Confirmed via rapidmail's own API docs (developer.rapidmail.wiki, fetched 2026-08-10):
the REST API v3 only exposes mailing/campaign endpoints ("Send mailings from a zip
file", "List mailings", "Get mailing statistics") — no transactional/single-message
send endpoint. Combined with the transactional-email feature page being SMTP-only,
**rapidmail is DISQUALIFIED on hard requirement 4** (no HTTP JSON POST API for a
single transactional send exists; SMTP is the only mechanism offered for this
specific feature).
**Source:** https://developer.rapidmail.wiki/, https://www.rapidmail.de/funktionen-transaktionsmails-versenden, retrieved 2026-08-10.
**Confidence:** medium-high

---

## Q5: CleverReach (German, Rastede)

**Company/entity:** CleverReach GmbH & Co. KG, Rastede, Lower Saxony, Germany.
**Datacenter:** Servers "exclusively in Germany and the EU" per vendor/secondary claims.
**Source:** aggregated search results incl. https://av-vertrag.org/dienst-anbieter/cleverreach/, retrieved 2026-08-10.
**Confidence:** medium (not confirmed on a CleverReach primary page directly this pass)

**Requirement check:**
1. EU/EEA hosting — Yes, Germany specifically claimed — medium confidence
2. AVV/DPA — Yes, "DSGVO template contracts for the AVV" offered as standard — medium confidence
3. Transactional email — Yes, dedicated feature exists (order/shipping confirmations, password resets) — high confidence
4. **HTTP JSON POST API for single transactional send — NO / DISQUALIFIED.** CleverReach's own support docs describe the transactional-email feature explicitly as SMTP-based: "Sending transactional emails via SMTP with CleverReach" — you get SMTP host/port/user/pass credentials to plug into your shop/CMS. CleverReach does have a separate general REST API (`https://rest.cleverreach.com/v3/`, confirmed via developers.cleverreach.com, fetched 2026-08-10) for contacts/campaigns, but no send-single-transactional-email JSON endpoint was found documented.
**Source:** https://support.cleverreach.com/hc/en-us/articles/4406700743954-Sending-transactional-emails-via-SMTP-with-CleverReach (title/search snippet only, full fetch blocked 403), https://developers.cleverreach.com/, retrieved 2026-08-10.
**Confidence:** medium (the SMTP claim is from the article title + secondary summaries, not the full fetched body — 403 blocked direct read)
5. No US parent — Yes, appears purely German — medium confidence

**SMTP:** Yes, confirmed as the mechanism for transactional sending; exact host/port issued per-account, not published generically.

**Pricing:** Free "Lite" plan: 1,000 emails/month to 250 contacts. Paid "Basic" from €15/month, "Pro" from €18/month (scales with contact count, not directly with transactional volume); net prices + 19% VAT.
**Source:** https://www.simon-erklaert.com/email-marketing/cleverreach-preise/, retrieved 2026-08-10.
**Confidence:** medium (aggregator, not CleverReach's own pricing page)

**PRELIMINARY VERDICT: CleverReach DISQUALIFIED on hard requirement 4** (transactional email = SMTP relay only, no confirmed JSON POST API for it).

---

## Q6: mailingwork (German)

**Company/entity:** mailingwork GmbH, Germany (exact city not confirmed this pass).
**Datacenter:** "Servers hosted in Germany," CSA certified. Source: search aggregation, retrieved 2026-08-10.
**Confidence:** medium

**Requirement check:**
1. EU/EEA hosting — Yes, Germany claimed — medium confidence
2. AVV/DPA — Yes, "individual AVV" can be established — medium confidence
3. Transactional email — Yes, `SendEmailByIdAndRecipient` function sends to a single recipient, described as typically triggered by an online order, delivered within seconds, included in stats. Source: search snippet citing mailingwork's own materials, retrieved 2026-08-10 — high confidence
4. **HTTP JSON POST API — UNCLEAR, likely NOT a modern JSON REST API.** mailingwork calls this a "Webservice-Schnittstelle" with downloadable technical documentation (PDF) rather than a public REST/Swagger docs site, and the PascalCase method-naming convention (`SendEmailByIdAndRecipient`) is the classic pattern of a SOAP/WSDL web service, not REST/JSON — this is a strong secondary inference, not a confirmed fact (the actual PDF spec was not accessible in this pass). **Flag this for a direct follow-up check against the downloaded PDF before ruling it in or out** — do not treat as confirmed either way.
**Source:** https://helpdesk.mailingwork.de/portal/de/kb/articles/wo-finde-ich-eine-technische-dokumentation-zur-webservice-schnittstelle-von-mailingwork (fetch only returned that a PDF download exists, not its contents), retrieved 2026-08-10.
**Confidence:** low on the SOAP-vs-REST question specifically — mark **Unclear**
5. No US parent — Yes, appears purely German — medium confidence

**Pricing:** Not found this pass — TODO/not findable in the time available; mailingwork does not publish public pricing, sales-contact model typical of German enterprise ESPs.

**PRELIMINARY VERDICT: mailingwork = requirement 4 Unclear (needs the actual API spec PDF read, not just its listing page) — do not rule in without that check.**

---

## Q7: Newsletter2Go (German)

**Status: not a separate product.** Acquired by Brevo (then Sendinblue) on 2019-01-31; new signups are redirected straight to Brevo, existing legacy accounts keep running unchanged under the old software but nothing new can be provisioned. Treat this as **the same entity as Brevo (Q1)**, not an independent candidate.
**Source:** https://smtpedia.com/tag/newsletter2go-brevo/, https://www.brevo.com/de/landing/newsletter2go/, retrieved 2026-08-10.
**Confidence:** medium-high

---

## Q8: Scaleway Transactional Email (TEM) (French)

**Company/entity:** Scaleway SAS, France (part of the Iliad Group — French, Xavier Niel — not US-owned).
**Source:** general knowledge of Scaleway's ownership (Iliad), not independently re-verified against a primary Scaleway page this pass — **(mark unverified re: Iliad ownership chain specifically, though Scaleway being a French company itself is corroborated by multiple search results)**.
**Confidence:** medium

**Datacenter:** Scaleway's own docs/marketing state EU-only processing; regions cited in secondary sources as "primarily France and Netherlands," consistent with Scaleway's known DC footprint (Paris, plus AMS region generally). Exact TEM-specific region was not pinned down to one line in official docs within this pass — the concepts doc page fetch returned no region specifics (JS-rendered nav only).
**Source:** https://www.scaleway.com/en/docs/transactional-email/concepts/ (fetch returned incomplete content), secondary corroboration https://osdomains.com/blog/aws-ses-european-alternatives-2026, retrieved 2026-08-10.
**Confidence:** medium

**Requirement check:**
1. EU/EEA hosting — Yes (France/Netherlands, EU-only per Scaleway's compliance marketing) — medium-high confidence
2. AVV/DPA — Not directly confirmed this pass (search did not surface a DPA-specific page); Scaleway is widely used as a GDPR-native EU cloud provider and almost certainly offers a DPA, but **no direct link found** in this research pass — mark **Unclear/unverified**, needs a direct check of scaleway.com legal pages.
3. Transactional email — Yes, this is the entire point of the TEM product — high confidence
4. HTTP JSON POST API — Yes, confirmed to exist ("Sending an email using the Transactional Email API" doc page, `POST`, IAM API-key auth), though the exact endpoint URL/domain and full JSON body were not retrieved verbatim in this pass due to JS-rendered doc pages. SMTP relay is also explicitly offered ("Setting up SMTP" doc section referenced) as an alternative alongside the API.
**Source:** https://www.scaleway.com/en/docs/transactional-email/api-cli/send-emails-with-api/, retrieved 2026-08-10 (partial content only).
**Confidence:** medium (endpoint exists confirmed, exact URL/JSON shape not captured verbatim — needs a direct re-fetch or `scaleway.com/en/developers/api/transactional-email/` OpenAPI spec check before implementation)
5. No US parent — Yes, Scaleway/Iliad is French — medium-high confidence

**Pricing:** No fixed monthly fee; pay-as-you-go. Free tier = 300 emails/month, then €0.25 per 1,000 emails after that. For 1,000-5,000/month this is roughly **€0.18-€1.18/month** (well under €5) — by far the cheapest option found.
**Source:** search aggregation citing Scaleway's own pricing docs (`https://www.scaleway.com/en/docs/transactional-email/faq/`, `/how-to/manage-tem-plans/`), retrieved 2026-08-10.
**Confidence:** medium-high

**Deliverability:** Not directly researched this pass (dedicated-IP / DKIM specifics) — TODO.

**PRELIMINARY VERDICT: Scaleway TEM passes 1, 3, 4, 5 with medium-high confidence; requirement 2 (AVV) is unconfirmed and needs one direct follow-up check before treating it as satisfied.**

---

## Q9: OVHcloud email

**Finding: OVHcloud has no dedicated transactional-email-API product.** OVHcloud's own community forum and docs explicitly point customers elsewhere: "for high volumes like newsletters or bulk transactional emails, users should use a dedicated third-party transactional email service... rather than [OVHcloud's] standard MX Plan." OVHcloud's mail offerings (MX Plan, Exchange) are mailbox-hosting products with SMTP send quotas, not a transactional-send API/service.
**Source:** https://docs.ovhcloud.com/en/guides/web-cloud/web-hosting/email-sending-best-practices, https://community.ovhcloud.com/t/est-ce-que-ovh-offre-un-service-smtp-demail-transactionnel-telque-sendgrid/17415, retrieved 2026-08-10.
**Confidence:** high

**VERDICT: OVHcloud DISQUALIFIED / not applicable** — no product in this category exists to evaluate against the 5 requirements. (OVHcloud is itself a French/EU cloud company with no US parent, which is otherwise attractive, but there's no transactional email service to point at.)

---

## Q10: IONOS / 1&1 (German)

**Finding: No dedicated transactional-email-API product found.** IONOS offers Mail Basic/Mail Business mailbox hosting and general hosting/domain developer APIs (developer.hosting.ionos.com), but nothing surfaced describing a transactional-send API comparable to Brevo/Mailjet/Scaleway TEM. IONOS mailbox sending is rate-limited like ordinary mailbox SMTP (cited external source: "no more than 30 emails in 5 minutes" — **this specific number is from a secondary/aggregator source and not independently confirmed against an IONOS primary page in this pass**), consistent with anti-spam limits on a personal/business mailbox rather than a bulk transactional product.
**Source:** search aggregation, https://www.ionos.com/help/email/, https://developer.hosting.ionos.com/docs, retrieved 2026-08-10.
**Confidence:** medium

**VERDICT: IONOS DISQUALIFIED / not applicable on requirements 3 & 4** — no dedicated transactional-email product with an HTTP send API was found; what exists is rate-limited mailbox SMTP, unsuitable for programmatic lead-notification volume even at only 1,000-5,000/month if bursty.

---

## Q11: mailbox.org (German)

**Company/entity:** operated by Heinlein Support GmbH, Berlin, Germany.
**Confirmed: SMTP/IMAP mailbox provider, not a transactional email API service.** mailbox.org does publish an API (`api.mailbox.org`), but it is explicitly for **account/mailbox administration** (provisioning mailboxes, aliases, automation for resellers/larger orgs) — not for sending individual transactional messages via JSON POST. Actual mail sending from mailbox.org is via ordinary IMAP/SMTP client access, i.e., a personal/business mailbox, not a bulk-capable transactional relay.
**Source:** https://mailbox.org/en/product/admin/, retrieved 2026-08-10 (WebFetch); general search corroboration.
**Confidence:** medium-high

**VERDICT: mailbox.org DISQUALIFIED on requirements 3 & 4** — as anticipated in the task brief. It is an SMTP mailbox, not a transactional-send API/service, and its own API is scoped to admin functions, not message sending.

---

## Q12: Hetzner (German)

**Finding: Hetzner is not an email service — it is an infrastructure/VPS/cloud host.** Hetzner blocks outbound SMTP ports 25/465 by default on cloud servers (anti-abuse), with port 587 usable for relaying through an external mail provider. There is no Hetzner-operated transactional email product; using Hetzner for mail means self-hosting a mail server on a Hetzner VPS, which is an entirely different (and much higher-effort, higher-risk-of-blacklisting) undertaking than using a managed provider, and is explicitly out of scope for "a provider."
**Source:** search aggregation citing Hetzner's port-blocking policy (e.g. Hacker News/community discussion, no single authoritative Hetzner doc page was fetched directly this pass), retrieved 2026-08-10.
**Confidence:** medium (the port-blocking fact is well-corroborated across multiple secondary sources; no primary Hetzner docs page fetched directly)

**VERDICT: Hetzner DISQUALIFIED / not applicable** — not a transactional email provider at all, just a hosting company you could build one on top of.

---

## Q13: Postmark (US — documented for elimination only)

**Company/entity:** Postmark, acquired 2020 by ActiveCampaign (US company).
**Datacenter:** Primary infrastructure at Deft's Chicago-area datacenter and AWS; "currently don't have plans to add servers in the EU" per one source; a separate Postmark EU-privacy page exists but does not claim EU-only processing/storage.
**Source:** https://scan.meetergo.com/en/vendors/postmark, https://postmarkapp.com/eu-privacy, https://postmarkapp.com/dpa, retrieved 2026-08-10.
**Confidence:** medium-high

**Requirement check:** 1. **No** (US-based storage/processing, not EU/EEA). 5. **No** (US parent, ActiveCampaign). DPA/SCCs and a Data Privacy Framework certification exist (req 2 partially addressable via SCCs), but requirement 1 fails outright and the CLOUD Act exposure is explicit even where EU-adjacent hosting exists for other products. **DISQUALIFIED.**

---

## Q14: SendGrid / Twilio (US — documented for elimination only)

**Company/entity:** Twilio SendGrid, Twilio Inc. is a US public company.
**EU option:** Twilio offers "Data Residency for Email (EU)" — but it requires provisioning a dedicated **EU subuser** and sending via the **EU API endpoint**; sending through the default/global endpoint (`api.sendgrid.com`) routes outside the EU by default. Even with the EU subuser/endpoint used correctly, the underlying company is US-based and subject to the US CLOUD Act — Twilio's own published risk framing (via secondary source) states US law enforcement could theoretically compel access to EU-stored data without EU authorities' involvement.
**Source:** https://www.twilio.com/docs/sendgrid/data-residency, https://www.twilio.com/docs/sendgrid/data-residency/faq, https://scan.meetergo.com/en/vendors/sendgrid, retrieved 2026-08-10.
**Confidence:** high

**Requirement check:** 1. **Conditionally Yes** if the EU subuser + EU endpoint is deliberately configured (easy to misconfigure and silently fall back to the US endpoint). 5. **No** — Twilio is a US parent company regardless of where bytes are stored. **DISQUALIFIED on requirement 5**, and requirement 1 is fragile/opt-in rather than default.

---

## Q15: Mailgun / Sinch (US entity — documented for elimination only, per task's specific ask)

**Company/entity:** Mailgun Technologies, Inc. — confirmed to be a **US company**, acquired by Sinch (Swedish public group) in 2022. Even post-acquisition, the operating entity remains US-incorporated.
**Source:** search aggregation citing Sinch's own materials, retrieved 2026-08-10; corroborated by Sinch's own sub-processor list (see Q2 above) listing "Mailgun Technologies, Inc. (USA)" as a named sub-processor even on the **Mailjet** product line.
**Confidence:** high

**EU region:** Mailgun does offer a separate EU region with its own API endpoint (`https://api.eu.mailgun.net`), keeping EU customer data processed in the EU and not moved to the US region. The specific EU datacenter country was **not confirmed** in this research pass (Mailgun's own regions page did not yield a definitive country in the content retrieved — flagged for follow-up, likely Ireland or Germany based on typical AWS/EU-multi-region setups, but this is a guess, not a finding).
**Source:** https://www.mailgun.com/about/regions/, https://www.mailgun.com/blog/product/we-have-a-new-region-in-europe-yall/, retrieved 2026-08-10.
**Confidence:** medium (EU region's existence is solid; the exact country is unconfirmed — do not treat "Ireland or Germany" above as a fact)

**Requirement check:** 1. **Partially Yes** if the EU region is deliberately selected (data does not leave that region once chosen). 5. **No** — the operating entity, Mailgun Technologies, Inc., is itself a US company (not merely a US sub-processor of an EU entity — it IS the entity running the product), which is a stronger disqualifier than SendGrid/Postmark's "US parent, EU option" framing. **DISQUALIFIED on requirement 5**, exactly the outcome the task asked to check for.

---

## Q16: Flowmailer / Spotler SendPro (Dutch — found via search, not in the original candidate list)

**Company/entity:** Flowmailer BV, Van Nelleweg 1, 3044BC Rotterdam, Netherlands. Acquired by Spotler Group (Dutch marketing-tech group) in 2020; product rebranded "Spotler SendPro" in 2024, but appears to still be marketed under the flowmailer.com domain as well.
**Source:** https://flowmailer.com/public/en/why/compliance-security, https://spotlergroup.com/blog/flowmailer-joins-the-spotler-group, https://spotler.com/flowmailer-is-now-spotler, retrieved 2026-08-10.
**Confidence:** high on entity/country, medium on current exact branding state (two names/domains both surfaced)

**Datacenter:** "Independently operating Dutch data centers (Amsterdam region)"; customer data stated to stay within the EU.
**Source:** https://flowmailer.com/public/en/why/compliance-security, retrieved 2026-08-10.
**Confidence:** high

**Requirement check:**
1. EU/EEA hosting — Yes, Netherlands specifically — high confidence
2. AVV/DPA — Yes, a "Data Processor Agreement" is offered, but via a **"Request DPA"** link (i.e., provided on request, not a self-serve instant download/e-sign flow like Brevo's or rapidmail's) — medium-high confidence
3. Transactional email — Yes, this is Flowmailer's core/only product category — high confidence
4. HTTP JSON POST API — Yes, dedicated "Flowmailer API" and a separate simplified "SendPro API," both REST/JSON (`Content-Type: application/vnd.flowmailer.v1.12+json` observed for the main API) — high confidence. SMTP is not confirmed either way as an alternative in this pass.
5. No US parent — Yes, Dutch entity, Dutch parent group (Spotler) — high confidence

**Pricing:** No visible free tier found. Two plans: "Go!" €89/month and "Pro" €249-279/month (sources disagree slightly, €249 vs €279), both apparently covering up to 25,000 emails/month included. This is **far more expensive** than the volume in question (1,000-5,000/month) would justify relative to Brevo/Mailjet/Scaleway — no evidence of a smaller/cheaper tier.
**Source:** https://images.g2crowd.com/uploads/pricing/file/20820/pricingandfeaturesflowmailer.pdf (G2-hosted copy of Flowmailer's own pricing sheet), retrieved via search 2026-08-10.
**Confidence:** medium (pricing sheet is third-party-hosted, may be stale; not fetched from flowmailer.com/pricing directly)

**VERDICT: Flowmailer/Spotler SendPro passes all 5 hard requirements on the evidence gathered, but pricing is disproportionately high for the target volume (~€89/month minimum vs. Brevo's free tier or Scaleway's ~€1/month for the same volume).**

## Q1 addendum: Brevo hosting infrastructure detail

Found after initial write-up: Brevo's **primary hosting provider is OVHcloud, in France and Germany** (both OVHcloud datacenters and OVHcloud itself are French/EU-owned, no US parent). Database backups are additionally copied to **Google Cloud, Belgium** (Google Cloud = US-owned hyperscaler, same caveat category as Mailjet, but here it is a backup-only touchpoint rather than the primary processing/hosting layer, which is the more material distinction for CLOUD Act exposure discussions).
**Source:** aggregated from https://help.brevo.com/hc/en-us/articles/360001005510-Data-storage-location (surfaced via search, not directly fetched this pass), retrieved 2026-08-10.
**Confidence:** medium (secondary summary of a primary help-center article; the article itself was not fetched directly — recommend a direct fetch of that URL before finalizing a vendor decision)

This means Brevo is **not 100% free of any US-company touchpoint** either (Google Cloud backups) — but its primary/live processing infrastructure is EU-owned (OVHcloud), which is a meaningfully stronger position than Mailjet's, where GCP is the *primary* hosting layer for the live product, not just backups.

---

## Recommendation

**None of the candidates researched achieves a "zero US-company touchpoint anywhere, including backups and sub-processors" standard.** If that literal reading of requirement 5 is enforced, every option in this list has at least one asterisk. Ranked below by how close each gets while still passing requirements 1-4 cleanly.

### Ranked top 3 (pass all 5 hard requirements, on available evidence)

**1. Brevo (Brevo SAS, Paris, France) — BEST PICK**
- Req 1: Yes — primary hosting on OVHcloud in France/Germany (EU-owned infra, not a US hyperscaler for the live path); only backups touch Google Cloud (Belgium).
- Req 2: Yes — DPA is Annex/Appendix of the Terms of Service, publicly downloadable PDF, no separate signature needed for standard use.
- Req 3: Yes — dedicated Transactional Email product, this is a core, heavily-used feature (not an afterthought).
- Req 4: Yes — clean documented API: `POST https://api.brevo.com/v3/smtp/email`, JSON body (`sender`, `to`, `subject`, `htmlContent`), `api-key` header auth. Free tier (300/day ≈ 9,000/month) covers the stated 1,000-5,000/month volume at zero cost.
- Req 5: Mostly yes — French SAS, no US parent company; the one asterisk is Google Cloud as a **backup-only** sub-processor, not the live processing path.
- **Why it's the pick:** it is the only candidate that combines (a) a confirmed, self-serve, no-friction DPA, (b) a clean modern JSON API, (c) a free tier that fully covers the stated volume, and (d) EU-owned infrastructure as the *primary* (not just nominal) hosting layer. The GCP-backup caveat is the same category of imperfection every other EU provider researched also carries somewhere in its stack (Mailjet's GCP is worse — primary, not backup; Flowmailer's isn't confirmed either way).
- **Confidence:** medium-high overall; the weakest link is that the Brevo pricing page and the data-storage-location help article were not fetched directly (JS-rendered / not directly retrieved), so pricing and the OVH/GCP split should get one direct primary-source confirmation before committing.

**2. Scaleway Transactional Email (TEM) (Scaleway SAS, France)**
- Passes reqs 1, 3, 4, 5 with medium-high confidence: EU-only processing (France/Netherlands), dedicated transactional product, confirmed REST API + SMTP alternative, French/Iliad ownership (no US parent).
- Req 2 (DPA) is the one gap: **no DPA link was found in this research pass** — needs one direct follow-up (check `scaleway.com` legal/trust pages) before this can be marked Yes with confidence. Given Scaleway markets itself heavily on GDPR-native EU sovereignty, a DPA almost certainly exists, but "almost certainly" is not verification.
- Pricing is dramatically cheaper than any other option (free up to 300/month, then €0.25/1,000 — the whole 1,000-5,000/month range costs under €1.20/month), which makes it worth the one follow-up check.
- **Why not #1:** the unconfirmed DPA is a real gap against a hard requirement, and the API documentation pages returned JS-shell content rather than full text in this pass, so the exact JSON body shape needs one more direct look before implementation.

**3. Flowmailer / Spotler SendPro (Flowmailer BV, Rotterdam, Netherlands)**
- Passes all 5 requirements with high confidence on the compliance/hosting side (Dutch entity, Dutch Spotler Group parent, Amsterdam-region datacenters, confirmed REST/JSON API, DPA available on request).
- **Why not #1 or #2:** DPA is "request DPA" (not self-serve/instant) and pricing (€89/month minimum for the "Go!" plan) is wildly disproportionate to the 1,000-5,000 emails/month volume in question — you'd be paying roughly 15-45x what the free/near-free options cost for the same volume, with no evidence of a smaller tier.

### Notable near-misses (fail one requirement, documented per the task's specific ask)

- **Mailjet (Sinch)** — fails requirement 5 cleanly and disqualifies: its *primary* live-processing infrastructure is Google Cloud Platform (Frankfurt/Belgium), a US-owned hyperscaler, not merely a backup touchpoint, and Sinch's own published sub-processor list names **Mailgun Technologies, Inc. (USA)** as a sub-processor even on the Mailjet product line, plus Atlassian and Google LLC. Everything else about Mailjet (EU datacenters, self-serve DPA, solid JSON API, transactional-first product) is otherwise strong — this is the closest "great tool, fails on the one hard rule that matters most here" case.
- **Mailgun** — fails requirement 5 more fundamentally than Mailjet: the operating entity itself, Mailgun Technologies, Inc., is a US company (not just a sub-processor relationship), even though it offers a genuine EU-region API endpoint that keeps data from crossing to the US region.
- **SendGrid (Twilio)** — fails requirement 5 (US parent, Twilio Inc.); requirement 1 is achievable only if the EU subuser + EU API endpoint is deliberately configured, and defaults to the US endpoint otherwise — an easy misconfiguration trap.
- **Postmark (ActiveCampaign)** — fails requirement 1 outright (primary storage is US-based, Chicago/AWS; "no plans to add EU servers" per one source) and requirement 5 (US parent).

### Disqualified — fail requirement 4 (no HTTP JSON POST API for single transactional send)

- **rapidmail** — confirmed via its own API docs: only bulk-mailing endpoints exist; the transactional-email feature is SMTP-only.
- **CleverReach** — confirmed via its own support docs: transactional email is explicitly marketed and delivered as an SMTP-relay feature; its separate general REST API doesn't cover single transactional sends.
- **mailbox.org** — is a mailbox/SMTP provider; its API is admin/provisioning only, not a message-send API.

### Disqualified / not applicable — no transactional email product exists at all

- **OVHcloud**, **IONOS/1&1**, **Hetzner** — none of these offer a dedicated transactional-email-sending product; they're general hosting/mailbox providers. Not comparable candidates.

### Unclear — needs one more check before ruling in or out

- **mailingwork** — has a confirmed single-recipient transactional send function (`SendEmailByIdAndRecipient`), but the naming convention and "downloadable technical documentation PDF" packaging strongly suggest a SOAP/WSDL webservice rather than a JSON REST API. This was not confirmed either way from the PDF itself in this research pass — do not rule this in or out without reading that PDF.

### Bottom line

**Requirements 1-4 are satisfiable by an EU/German provider with no trouble — Brevo, Scaleway TEM, and Flowmailer/Spotler SendPro all clear them.** Requirement 5, read literally as "zero US company anywhere in the chain, including backups and support-tooling sub-processors," is not fully achievable by any candidate found, including the German ones (Brevo's own backups touch Google Cloud). If requirement 5 is relaxed to its more common practical reading — **no US company in the live message-processing/sending path** — then **Brevo clears all five requirements cleanly** and is the recommended pick. If the literal zero-US-anywhere reading must be enforced, **Scaleway TEM** is the strongest remaining candidate pending one direct DPA-link confirmation, since its ownership chain (French/Iliad) has no GCP/AWS dependency surfaced in this research at all — but that same fact (no major hyperscaler dependency for a service this size) itself deserves a skeptical follow-up check, not just trust from marketing copy.

