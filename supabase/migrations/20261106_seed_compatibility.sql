BEGIN;
ALTER TABLE public.workflow_nodes
  ADD COLUMN IF NOT EXISTS position_x numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS position_y numeric NOT NULL DEFAULT 0;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','review','done','complete'));
NOTIFY pgrst, 'reload schema';
COMMIT;
