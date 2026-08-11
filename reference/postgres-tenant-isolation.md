# Postgres tenant isolation + PostgREST retry safety

Distilled 2026-08-09 from **InsForge** (github.com/InsForge/InsForge, Apache-2.0, v2.3.0).
The repo itself was **not** adopted — see [../security-audit/SUMMARY.md](../security-audit/SUMMARY.md)
for the OpenFunnel audit and the conversation for why. These two patterns were the only
things worth keeping, and they're kept as patterns, not as a dependency.

Relevant because OpenFunnel today has **no user model at all** — one shared `ADMIN_TOKEN`
([apps/runtime/lib/auth.js](../apps/runtime/lib/auth.js)) — and turning it into a SaaS means
per-account isolation of funnels and leads. This is how to do that in Postgres itself, so a
forgotten `WHERE account_id = ?` in app code cannot leak another tenant's leads.

---

## 1. Identity lives in one canonical JWT claims setting

Do not invent per-app GUCs (`app.user_id`, `app.tenant`). Write **one** setting,
`request.jwt.claims`, in the exact shape PostgREST uses. Then app-level queries and
PostgREST-served queries evaluate the same RLS policies against the same source of truth —
no parallel identity, no drift.

```sql
-- auth helpers read only the canonical claim set
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'role', '')::text
$$;
```

`auth.jwt()` reads `current_setting('request.jwt.claims')::jsonb`.
Note `nullif(..., '')` before the `::uuid` cast — a missing claim yields NULL rather than
throwing, so a policy on an unauthenticated connection denies instead of erroring.

## 2. Policies: enable RLS, one policy per verb, grant to the role

```sql
CREATE TABLE leads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT auth.uid(),   -- default, so an INSERT can't forge it
  funnel_id  TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_select ON leads FOR SELECT
  TO authenticated USING (auth.uid() = account_id);
CREATE POLICY owner_insert ON leads FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = account_id);
CREATE POLICY owner_update ON leads FOR UPDATE
  TO authenticated USING (auth.uid() = account_id);
CREATE POLICY owner_delete ON leads FOR DELETE
  TO authenticated USING (auth.uid() = account_id);

GRANT ALL ON leads TO authenticated;
```

Two things that are easy to get wrong:

- `USING` filters rows you can *see*; `WITH CHECK` constrains rows you can *write*. INSERT
  needs `WITH CHECK`, UPDATE wants both. A policy with only `USING` on UPDATE lets a tenant
  move a row **to** another tenant.
- `DEFAULT auth.uid()` on the ownership column means the client never supplies it, so there
  is nothing to tamper with in the request body.
- RLS does not apply to the table owner or to superusers, and is bypassed unless you also
  `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for the owning role. Connect as a
  non-owning role.
- Postgres has no `CREATE POLICY IF NOT EXISTS` through PG17 — guard re-runnable migrations
  with a `DO` block checking `pg_policy.polname`.

## 3. Setting the context per request

The load-bearing piece. Verbatim shape worth copying:

```
BEGIN
SET LOCAL ROLE <authenticated|anon|project_admin>
SELECT set_config('request.jwt.claims', $jsonb, true)   -- true = transaction-local
<your queries>
COMMIT
-- and in finally: RESET ROLE, always, before the client returns to the pool
```

Non-obvious details, each of which is a real bug if missed:

- **`SET LOCAL ROLE` cannot be parameterized.** Postgres can't bind identifiers, so the role
  string gets interpolated into SQL. **Allowlist it with an if/else chain — never trust the
  type.** A `UserContext` built from a JSON payload or a DB row is one mistake away from
  arbitrary SQL landing in `SET LOCAL ROLE`.
- **`RESET ROLE` in `finally`, unconditionally.** A failed query must not return a client to
  the pool still wearing a tenant's role. That's cross-tenant leakage via connection reuse.
- **Only real users get a `sub` claim.** Admin/service subjects (`cloud:<id>`, internal ids)
  and any `anonymous` sentinel must never become `sub`, because `auth.uid()` casts it to
  UUID and a non-UUID subject throws mid-policy.
- **Reject caller-supplied settings starting with `request.jwt.`** if you let callers pass
  extra `set_config` values — otherwise a caller overrides its own identity.
- Use `set_config(..., true)` (transaction-local) so `ROLLBACK` clears identity state too.

Sketch, adapted for `pg`:

```js
export async function withTenant(pool, ctx, fn) {
  const claims = { role: ctx.role };
  if (ctx.role === "authenticated" && ctx.id) claims.sub = ctx.id;
  if (ctx.email) claims.email = ctx.email;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (ctx.role === "authenticated")      await client.query("SET LOCAL ROLE authenticated");
    else if (ctx.role === "anon")          await client.query("SET LOCAL ROLE anon");
    else throw new Error(`unsupported role ${JSON.stringify(ctx.role)}`);
    await client.query("SELECT set_config($1, $2, true)", ["request.jwt.claims", JSON.stringify(claims)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("RESET ROLE").catch(() => {});
    client.release();
  }
}
```

## 4. Gateway token exchange (if PostgREST ever fronts the tables)

Never forward a client's own token to PostgREST. Verify it in the app layer, then mint a
**short-lived internal HS256 token** carrying `{ sub, email, role }` and forward that. The
internal signing key never leaves the server. Anonymous traffic gets a single subject-less
`anon` token, so all anon requests reach the database with identical claims and there is no
client-supplied claim surface at all.

---

## 5. PostgREST / HTTP retry safety — which errors are replayable

Directly relevant to OpenFunnel's **durable-delivery gap**: `persist()` currently
fire-and-forgets via `Promise.allSettled` ([lib/store.js](../apps/runtime/lib/store.js)), so a
failed webhook or email silently loses the lead forward. When that becomes a real retry
queue, this is the classification to use — it applies to any outbound HTTP, not just Postgres.

| Error class | Codes | Retry? |
| --- | --- | --- |
| Any HTTP response, including 5xx | — | **No.** Surface it. The server saw the request. |
| Timeout | `ECONNABORTED`, `ETIMEDOUT` | **No.** May already be executing; replaying a write risks a duplicate and amplifies load exactly when the backend is saturated. |
| Connection never established | `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` | **Yes, any method.** Proof the request never arrived. |
| Ambiguous network | `ECONNRESET`, `EPIPE`, missing code | **Idempotent methods only** (GET/HEAD/OPTIONS). |
| Everything else | cancellation, bad config | **No.** Fails identically on replay. |

**The stale keep-alive exception.** An `ECONNRESET` where Node reports
`request.reusedSocket === true` almost always means the server closed an idle pooled socket
before the request was processed — Node documents exactly this case and endorses one
immediate retry, valid even for writes. Bound it: **one** replay, then fall back to the
method-based policy so writes can't ping-pong. Log non-idempotent replays with a distinct
message so duplicate writes are traceable.

**Prevention beats retry:** use `agentkeepalive` rather than the built-in agent and set
`freeSocketTimeout` *below* the server's idle timeout. Then the client always reaps an idle
socket before the server can, and the stale-reuse race mostly stops happening.

Backoff used: `min(200 * 2.5^(attempt-1), 1000)` ms, 3 attempts, no delay on the
stale-socket replay (it should go out immediately).

---

## What was deliberately not taken

InsForge's cloud coupling (MCP transport is hosted-only at `mcp.insforge.dev`; functions
deploy via Deno Deploy Subhosting), its 133k LOC + 43-dep + 4-container footprint, and its
lack of any tenant/org model — the exact thing this note exists to solve. The full
capability inventory, if it's ever needed again, can be regenerated by re-cloning; nothing
here depends on it.
