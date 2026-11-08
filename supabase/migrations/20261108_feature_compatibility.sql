BEGIN;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS actual_hours numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_status_check CHECK (status IN ('planning','in_progress','review','complete','on_hold','active','inactive','archived'));
ALTER TABLE public.accounts ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('backlog','todo','in_progress','review','blocked','done','complete'));
ALTER TABLE public.project_assignments ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual';
-- Refuse to proceed if existing duplicate clock sessions need review; never delete them automatically.
CREATE UNIQUE INDEX IF NOT EXISTS clock_sessions_one_open_per_user
  ON public.clock_sessions(user_id) WHERE end_time IS NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;
