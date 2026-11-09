# Estimates — revenue slice

## Run and showcase

1. Configure the existing Supabase URL, publishable key and server-only service role key as described in README. Never commit .env.local.
2. Apply the baseline/previous migrations, then **supabase/migrations/20261109_estimates.sql** once in Supabase SQL Editor. Also apply `20261110_estimate_conflict_response.sql` after it (safe for fresh installs too); it uses a non-retrying HTTP 409 conflict response and clears only stalled estimate test calls. It adds the finance slice without replacing existing data.
3. Run `npm run dev`, sign in as SuperAdmin, open **Accounts → an account → View estimates**. Create a draft, add lines, save, mark as sent, then record acceptance or rejection. Executive Director is read-only; an account manager can edit only explicitly granted accounts. Client/designer accounts have no finance grant.
4. Vercel uses the same Supabase database and the existing environment variables; no new environment variables are required.

This is a demo login environment with publicly selectable seeded identities. It is not production authentication. Do not put real customer financial information into this deployment. A production release must remove role-select login and use authenticated invitations/real user sign-in.

## Architecture and money

The account-context page calls Next.js route handlers, which authenticate the caller with Supabase. Reads use the caller's client and RLS. A narrowly granted PostgreSQL function owns mutations and computes totals inside the transaction. No service-role client is used by estimate routes.

`estimates` stores account, optional same-account project, currency, aggregate amount, lifecycle timestamps and version. Ordered `estimate_line_items` store quantity and unit price; `estimate_events` retain creation, edit and transition history. Header total and lines change atomically. Every account/project link is validated in the transaction. Account/project foreign keys restrict deleting linked resources.

Amounts are integer minor units; supported currencies USD/EUR/GBP/INR/CAD/AUD have two decimals. Decimal input is parsed as text, never rounded from floating-point currency math. Quantities are whole numbers from 1–10,000, prices 0–1,000,000,000 minor units, with 1–50 lines and a maximum aggregate of 9,000,000,000,000 minor units. These limits stay within JavaScript's safe integer range. Tax, discounts, multi-currency conversion, and fractional quantities are explicit follow-up work, not silently approximated.

Draft content is editable. Draft → sent requires a positive total. Sent → accepted or rejected is terminal. Sent content is frozen. Updates require the loaded version, and row locking plus optimistic concurrency ensures that competing decisions cannot both succeed. Status recording does not deliver email or collect a legally binding signature. No hard-delete route exists. Estimates, line-item and event deletion are blocked even for trusted SQL; authenticated clients have no direct mutation grants. Draft edits archive previous line items and insert the replacement lines; their history is retained too.

## Security and tenancy review

Financial access is **deny by default**, with viewer/editor roles in `finance_access_grants`. The starter schema has permissive legacy policies on profiles/roles, so those mutable fields are deliberately not accepted as authority over financial records. This is a separate financial RBAC boundary. The permission catalog includes View Financial Data and Manage Estimates for discoverability; toggling a legacy permission alone does not grant finance access.

The migration bootstraps global editor access for existing non-client superadmins, global viewer access for existing Executive Directors, and scoped editor access for each account's current non-client manager. This is a one-time snapshot. Future staff/accounts and ownership changes require trusted grant administration, not implicit access inheritance. Global scope is explicit (`account_id IS NULL`). There is no automatic superadmin bypass in the finance function.

Trusted administrators can grant access in SQL, for example:

```sql
INSERT INTO public.finance_access_grants (user_id, account_id, finance_role)
VALUES ('USER_UUID', 'ACCOUNT_UUID', 'editor');
-- Remove access by deleting the corresponding access grant, not an estimate.
```

Do not grant global scope for ordinary account staff. A grant is the authoritative financial entitlement; remove stale grants on staff departure or account reassignment. Only trusted SQL/service-role administration may mutate grants. No UI for finance grant administration is included in this slice.

Every list/get/create/update checks the URL account. RLS also protects headers, items, and events on direct authenticated Supabase reads; unauthorized account access returns the same 404 as an absent account. There is no client-supplied author/total/account field. Server errors expose no database details except controlled validation/conflict messages. The slice does not claim to repair the entire starter platform's authorization model; its financial boundary is isolated and tested against legacy profile escalation.

## API

- `GET /api/accounts/:accountId/estimates?status=draft&search=title&page=1`: server filtering, stable ordering, count and ten-row pagination. Returns same-account project choices and finance edit capability.
- `POST /api/accounts/:accountId/estimates`: requires `Idempotency-Key` (8–128 printable non-space characters). Body: title, currency, optional project_id/notes, and items of description, quantity, unit_price_minor.
- `GET /api/accounts/:accountId/estimates/:estimateId`: header, ordered lines and events.
- `PATCH /api/accounts/:accountId/estimates/:estimateId`: `{version, content: {...}}` for draft edits OR `{version, status: "sent"|"accepted"|"rejected"}` for a lifecycle transition. A transition is separate from content editing.

Create idempotency is scoped by caller and account. A transaction-scoped advisory lock and unique key serialize simultaneous retries. Same normalized content/key returns the same resource (201 initially; 200 with `Idempotency-Replayed: true` afterward); a changed payload using the same key returns 409. A replay returns the current representation of that resource, not an old snapshot. Keys are retained with the estimate and never reused. Draft edits use version-based conflict detection rather than create keys. Stale versions raise `PT409`; do not substitute `40001`, which PostgREST retries as a serialization failure.

## Validation

- `npm test`: existing platform checks plus money/schema and estimate API authorization, filters, replay, and conflict behavior.
- `python3 scripts/test-estimates-postgres.py`: real disposable local PostgreSQL database with isolated roles. Tests exact totals, concurrent create retries, key conflicts, cross-account project rejection/rollback, viewer and outsider RLS, direct mutation denial, legacy profile escalation isolation, immutable sent content, concurrent terminal decisions, and no hard deletion. Requires local PostgreSQL `postgres` access and permission to create/drop only the disposable database and temporary roles. Does not touch hosted data.
- `npm run lint` and `npm run build`. The inherited application has existing lint warnings and skips global TypeScript errors during build; these are not represented as resolved by this slice.

## What to ship next

Replace demo login before real use; provide audited finance grant administration; add customer-facing proposal documents and explicit revision/versioning; notification delivery/outbox; richer tax/discount/quantity rules; invoices tied to accepted estimates; Stripe/webhook reconciliation with signed events and deduplication; and reporting based on actual collections rather than estimated revenue. CRM and team/department analytics priorities are covered in the separate roadmap write-up.
