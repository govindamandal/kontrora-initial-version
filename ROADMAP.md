# Initial version review and proposed roadmap

The initial version provides account, project, task, time tracking, workflow and organizational foundations. The review uncovered missing services, mismatches between API queries and the database schema, and incomplete client navigation. Platform repairs have been pushed. The hosted compatibility migration is now applied; account/task creation and role listing passed retesting. Workflow transactions passed disposable local PostgreSQL integration tests.

## Revenue and business operations

The first revenue slice is now implemented: account-scoped estimates with optional project links, integer minor-unit line items, and controlled draft → sent → accepted/rejected transitions. It includes finance access grants, account boundaries, idempotent creation, retained records/history, list/filter/create/edit screens, and focused API/database tests. This treats the requested “proposal lifecycle” as the Estimates lifecycle defined in the assignment; customer signatures, email delivery, and revisions are separate follow-up work.

Build subsequent budgets, invoices and revenue reporting on the accepted estimate, with explicit rules for revisions, currency, taxes and payment state. Confirm those rules before implementation. Existing project time and cost data can support budget-versus-actual reporting once its completeness is checked.

## CRM

Add leads, contacts, activity history and configurable pipeline stages. Convert a qualified lead into an account/project without duplicating customer data. Link opportunities and estimates so conversion and revenue reporting use the same records. Define ownership, visibility, duplicate handling and required fields with the team.

## Collaboration analytics

Define actionable metrics first: workload, capacity, overdue work, cycle time, handoff delays and utilization by team/department. Establish reliable assignment and workflow events, then add dashboards with date/team/project filters and drill-downs. Avoid ranking individuals using incomplete time or activity data.

## Suggested sequence

1. Stabilize the existing application and apply/verify database migrations.
2. Showcase and review the implemented Estimates lifecycle; confirm proposal document/revision requirements.
3. Deliver revenue/business operations in small milestones.
4. Add CRM conversion and shared customer records.
5. Expand collaboration analytics on verified event/time data.

The Q3–Q4 sequence is a proposed priority order, not a delivery commitment. A calendar estimate needs confirmed acceptance criteria, access to automic-style-engine or an agreed replacement, the production schema, and decisions about finance/CRM workflows. The Estimates demo can be reviewed independently of that broader roadmap.
