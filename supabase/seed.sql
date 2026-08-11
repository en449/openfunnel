-- ===========================================================================
-- Local/dev seed — SYNTHETIC DATA ONLY.
--
-- Standing rule while the build runs on Vercel Free + Supabase Free
-- (PLAN.md §2.1): no real personal data anywhere. Every name, address and
-- phone number below is invented, and the domains are .invalid / .example on
-- purpose so a stray delivery attempt cannot reach a real host.
--
-- Applied automatically by `supabase db reset`. Never run against production.
-- ===========================================================================

insert into client (id, name, slug, contact_email, vertical, avv_signed_at)
values (
  '00000000-0000-4000-8000-000000000001',
  'Testkunde GaLaBau GmbH',
  'testkunde',
  'inbox@testkunde.invalid',
  'galabau',
  now()
);

insert into funnel (id, client_id, slug, name, status, published_at, doc)
values (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'lead-gen',
  'Lead-Gen (seed)',
  'live',
  now(),
  '{
    "id": "lead-gen",
    "name": "Lead-Gen (seed)",
    "theme": { "primary": "#2563eb", "mode": "light" },
    "steps": [
      { "id": "goal", "type": "choice", "headline": "Was ist Ihr Ziel?",
        "options": [ { "label": "Mehr Anfragen" }, { "label": "Bessere Anfragen" } ] },
      { "id": "contact", "type": "form", "headline": "Wohin dürfen wir antworten?",
        "fields": [
          { "name": "name",  "type": "text",  "label": "Name",   "required": true },
          { "name": "email", "type": "email", "label": "E-Mail", "required": true },
          { "name": "phone", "type": "tel",   "label": "Telefon" }
        ] },
      { "id": "done", "type": "success", "headline": "Danke!" }
    ]
  }'::jsonb
);

-- Two targets so the fan-out is exercised: one that will succeed against a
-- local echo server, one aimed at a host that cannot resolve — which is how
-- the retry path, the backoff and the dead-letter transition get tested
-- without needing anything to actually be down.
insert into delivery_target (client_id, funnel_id, kind, config) values
  ('00000000-0000-4000-8000-000000000001', null, 'webhook',
   '{"url": "http://127.0.0.1:4599/hook", "secret": "seed-secret-not-real"}'::jsonb),
  ('00000000-0000-4000-8000-000000000001', null, 'webhook',
   '{"url": "https://crm-of-the-client.invalid/hook"}'::jsonb);
