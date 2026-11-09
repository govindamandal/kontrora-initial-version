# Kontrora

Kontrora is a Professional Services Automation (PSA) platform for agencies and consulting teams. It helps you run client work end-to-end — from account setup and project delivery through capacity planning, time tracking, workflows, and client collaboration.

Built with **Next.js App Router** and **Supabase** (Auth + Postgres).

## What it does

Kontrora organizes work around **accounts** (clients), **departments**, and **projects**, with role-based access control throughout.

- **Accounts & clients** — Manage client accounts, memberships, and a client portal with invitations and feedback
- **Projects & delivery** — Projects with milestones, tasks, stakeholders, updates, and issue tracking
- **People & RBAC** — Departments, hierarchical roles with JSON permissions, user approval, and invitations
- **Time & capacity** — Clock sessions, time entries, weekly allocations, availability, and capacity views at org / account / department level
- **Workflows** — Template-driven workflows with nodes, approvals, form templates, and progress history
- **Analytics** — Overview dashboards for projects, team load, time, accounts, and workflow activity
- **Admin & onboarding** — First-run setup, seeded roles/users, pending approvals, and demo-friendly login     

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js (App Router), React, Tailwind CSS, Radix UI |
| Backend | Next.js Route Handlers |
| Data & auth | Supabase (Postgres, Auth, RLS) |
| Testing | Vitest |

## Setup

Requires **Node.js 20.9+** and a free [Supabase](https://supabase.com) project.

1. Install dependencies and create your env file:

```bash
npm install
```

2. In `.env.local`, set your Supabase project URL, publishable (anon) key, and service role key from **Settings → API**.

3. In the Supabase SQL Editor, run in order:

   - `supabase/schema.sql`
   - `supabase/seed-roles.sql`
   - optionally `supabase/escrows.sql`

4. Seed demo users (enables role-select login), then start the app:

```bash
npm run seed:users
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts  

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm run start` | Start the production server |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |
| `npm run test` | Run Vitest |
| `npm run setup:env` | Create `.env.local` from the template if missing |
| `npm run seed:users` | Seed users for local / demo login |

## Project layout

```
app/          # App Router pages and API routes
components/   # UI and feature components
lib/          # Auth, RBAC, services, validation  
supabase/     # Schema, role seed, escrow SQL
scripts/      # Seed and setup utilities
```


## Production build and restored services

`npm run build` compiles the application for deployment. The backend services for
workflow templates, execution, client portal access, forms, and role updates are
included in `lib/`. These were missing from the supplied initial version.

Before using workflow start/handoff or client approval actions, apply
`supabase/migrations/20261107_workflow_transactions.sql` in your Supabase SQL
Editor. It adds transactional functions that lock workflow instances, validate
project access and step assignment, and save history together with each state
change. The functions use the signed-in user's identity and are unavailable to
anonymous callers. They have been integration-tested on disposable PostgreSQL.

The supplied schema supports sequential active steps. Conditional/parallel
progression and inline form/branch assignment are rejected explicitly rather
than guessed. Use explicit next-node handoffs for branching. Client approval
nodes must have `config.client_approval = true`. Workflow features requiring the
migration are unavailable until it is applied to the hosted database.

The initial Next.js configuration already skips TypeScript build validation;
a successful build is not evidence that all existing TypeScript issues or
legacy features are resolved. Run `npm test` and `npm run lint` separately.


## Feature verification and database compatibility

Apply `supabase/migrations/20261108_feature_compatibility.sql` after the existing
migrations. It adds the role ordering and task fields used by the original UI,
accepts account lifecycle statuses without invalidating existing account rows,
and prevents duplicate open clock sessions. Existing duplicate clock sessions
cause the index creation to fail for review; no records are deleted automatically.

The clock API now uses the supplied schema's `start_time` / `end_time` columns.
Time-entry services receive the authenticated server client instead of returning
empty results from a browser-only client. API linting enables `no-undef` to catch
missing database variables. Client Portal and Time Entries routes are included.
The demo seed associates `client@test.local` with the first sample account.

Run `npm test`, `npm run lint`, `npm run build`, and optionally
`python3 scripts/test-workflow-postgres.py` (requires local PostgreSQL admin access;
it creates and removes an isolated temporary test database).

The Estimates assessment and Q3–Q4 roadmap features are separate from these
initial-platform repairs and are not implemented by this change. Email delivery,
external billing/escrow transactions, and exhaustive permission/security auditing
are outside the automated smoke checks; configure and verify those integrations
before using real customer data.

## Estimates / proposal lifecycle assignment

The revenue slice is implemented under **Accounts → View estimates**. It includes account-scoped drafts and line items, exact minor-unit amounts, optional project links, server filtering/pagination, retry-safe create, immutable sent content, accepted/rejected decisions, version conflicts, finance viewer/editor access, and retained history.

Apply `supabase/migrations/20261109_estimates.sql` after the earlier migrations. No additional environment variables are needed. The migration bootstraps explicit finance grants for existing demo superadmins, Executive Directors and account managers. Other users remain denied; changing legacy permission flags alone does not grant finance access.

See [Estimates architecture, security/tenancy, API, tests, and next steps](docs-estimates.md) for the required assignment handoff and demo instructions. Run `npm test` and `python3 scripts/test-estimates-postgres.py` for unit/API and real PostgreSQL transaction/RLS checks. Do not use real customer data with the role-select demo login.
