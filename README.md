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
