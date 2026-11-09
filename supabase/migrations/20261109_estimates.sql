BEGIN;
-- A separate, deny-by-default finance ACL isolates financial access from the
-- starter schema's permissive legacy profile/role policies. Only trusted SQL or
-- service-role administration may grant access. NULL account means explicit org scope.
CREATE TABLE public.finance_access_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
 account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
 finance_role text NOT NULL CHECK(finance_role IN ('viewer','editor')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX finance_grant_account ON public.finance_access_grants(user_id,account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX finance_grant_global ON public.finance_access_grants(user_id) WHERE account_id IS NULL;
ALTER TABLE public.finance_access_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_access_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.finance_access_grants TO authenticated;
CREATE POLICY finance_grants_read_own ON public.finance_access_grants FOR SELECT TO authenticated USING(user_id=auth.uid());

CREATE FUNCTION public.kontrora_finance_access(p_account uuid, p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.accounts WHERE id=p_account)
 AND EXISTS(SELECT 1 FROM public.finance_access_grants g WHERE g.user_id=auth.uid()
 AND (g.account_id=p_account OR g.account_id IS NULL) AND (NOT p_write OR g.finance_role='editor'));
$$;
REVOKE ALL ON FUNCTION public.kontrora_finance_access(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.kontrora_finance_access(uuid,boolean) TO authenticated;

-- Bootstrap financial roles from trusted, existing demo assignments once.
INSERT INTO public.finance_access_grants(user_id,finance_role)
 SELECT id,'editor' FROM public.user_profiles WHERE is_superadmin AND NOT is_client;
INSERT INTO public.finance_access_grants(user_id,finance_role)
 SELECT DISTINCT u.id,'viewer' FROM public.user_profiles u JOIN public.user_roles ur ON ur.user_id=u.id AND ur.removed_at IS NULL
 JOIN public.roles r ON r.id=ur.role_id WHERE r.name='Executive Director' AND NOT u.is_client
 AND NOT EXISTS(SELECT 1 FROM public.finance_access_grants WHERE user_id=u.id AND account_id IS NULL);
INSERT INTO public.finance_access_grants(user_id,account_id,finance_role)
 SELECT a.account_manager_id,a.id,'editor' FROM public.accounts a JOIN public.user_profiles u ON u.id=a.account_manager_id
 WHERE NOT u.is_client;
UPDATE public.roles SET permissions=permissions || '{"view_financial_data":true}'::jsonb WHERE name='Executive Director';
UPDATE public.roles SET permissions=permissions || '{"view_financial_data":true,"manage_estimates":true}'::jsonb WHERE name='Account Manager';

CREATE UNIQUE INDEX projects_estimates_account_key ON public.projects(id,account_id);
CREATE TABLE public.estimates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
 project_id uuid,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
 currency text NOT NULL CHECK(currency IN ('USD','EUR','GBP','INR','CAD','AUD')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','rejected')),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
 total_minor bigint NOT NULL DEFAULT 0 CHECK(total_minor BETWEEN 0 AND 9000000000000),
 version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz, decided_at timestamptz,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 request_fingerprint text NOT NULL,
 UNIQUE(account_id,created_by,idempotency_key),
 FOREIGN KEY(project_id,account_id) REFERENCES public.projects(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX estimates_account_status_created ON public.estimates(account_id,status,created_at DESC,id);
CREATE TABLE public.estimate_line_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE RESTRICT,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 49),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 300),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
 unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 1000000000),
 line_total_minor bigint GENERATED ALWAYS AS (quantity::bigint*unit_price_minor) STORED,
 UNIQUE(estimate_id,position)
);
CREATE TABLE public.estimate_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
 from_status text, to_status text NOT NULL, version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.estimates,public.estimate_line_items,public.estimate_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.estimates,public.estimate_line_items,public.estimate_events TO authenticated;
CREATE POLICY estimates_read ON public.estimates FOR SELECT TO authenticated USING(public.kontrora_finance_access(account_id));
CREATE POLICY estimate_items_read ON public.estimate_line_items FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.estimates e WHERE e.id=estimate_id));
CREATE POLICY estimate_events_read ON public.estimate_events FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.estimates e WHERE e.id=estimate_id));
-- No DELETE endpoint or table grant. Keep financial records and their history.
CREATE FUNCTION public.kontrora_estimate_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Estimates cannot be deleted' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER estimates_no_delete BEFORE DELETE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.kontrora_estimate_no_delete();
CREATE TRIGGER estimate_events_no_delete BEFORE DELETE ON public.estimate_events FOR EACH ROW EXECUTE FUNCTION public.kontrora_estimate_no_delete();

CREATE FUNCTION public.kontrora_save_estimate(p_account uuid,p_payload jsonb,p_key text DEFAULT NULL,p_id uuid DEFAULT NULL,p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.estimates; item jsonb; n integer:=0; total bigint:=0; target text; project uuid; replay boolean:=false; fingerprint text;
BEGIN
 IF NOT public.kontrora_finance_access(p_account,true) THEN RAISE EXCEPTION 'Financial access denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid estimate' USING ERRCODE='22023'; END IF;
 IF p_id IS NULL THEN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'Idempotency-Key must contain 8–128 characters' USING ERRCODE='22023'; END IF;
  fingerprint:=md5(p_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text || auth.uid()::text || p_key,0));
  SELECT * INTO e FROM public.estimates WHERE account_id=p_account AND created_by=auth.uid() AND idempotency_key=p_key;
  IF FOUND THEN
   IF e.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Idempotency key was used for different content' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('id',e.id,'replayed',true);
  END IF;
 ELSE
  SELECT * INTO e FROM public.estimates WHERE id=p_id AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found' USING ERRCODE='P0002'; END IF;
  IF p_version IS NULL OR e.version<>p_version THEN RAISE EXCEPTION 'Estimate changed; reload before saving' USING ERRCODE='40001'; END IF;
 END IF;
 target:=coalesce(p_payload->>'status',CASE WHEN p_id IS NULL THEN 'draft' ELSE e.status END);
 IF p_id IS NOT NULL AND target<>e.status THEN
  IF NOT ((e.status='draft' AND target='sent') OR (e.status='sent' AND target IN ('accepted','rejected'))) THEN
   RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='22023';
  END IF;
  IF (p_payload - 'status')<>'{}'::jsonb THEN RAISE EXCEPTION 'Send a transition separately from content changes' USING ERRCODE='22023'; END IF;
  IF target='sent' AND (e.total_minor<=0 OR NOT EXISTS(SELECT 1 FROM public.estimate_line_items WHERE estimate_id=e.id)) THEN
   RAISE EXCEPTION 'Add a positive estimate total before sending' USING ERRCODE='22023'; END IF;
  UPDATE public.estimates SET status=target,version=version+1,updated_at=now(),sent_at=CASE WHEN target='sent' THEN now() ELSE sent_at END,
   decided_at=CASE WHEN target IN ('accepted','rejected') THEN now() ELSE NULL END WHERE id=e.id RETURNING * INTO e;
  INSERT INTO public.estimate_events(estimate_id,actor_id,from_status,to_status,version) VALUES(e.id,auth.uid(),CASE WHEN target='sent' THEN 'draft' ELSE 'sent' END,target,e.version);
  RETURN jsonb_build_object('id',e.id,'replayed',false);
 END IF;
 IF (p_id IS NOT NULL AND e.status<>'draft') OR target<>'draft' THEN RAISE EXCEPTION 'Only draft estimates can be edited' USING ERRCODE='22023'; END IF;
 IF p_payload ? 'status' AND p_id IS NOT NULL THEN RAISE EXCEPTION 'Estimate already has this status' USING ERRCODE='22023'; END IF;
 IF p_payload - ARRAY['title','currency','notes','project_id','items','status']<>'{}'::jsonb
 OR coalesce(length(btrim(p_payload->>'title')),0) NOT BETWEEN 1 AND 160
 OR coalesce(p_payload->>'currency','') NOT IN ('USD','EUR','GBP','INR','CAD','AUD')
 OR length(coalesce(p_payload->>'notes',''))>4000
 OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid estimate content' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_payload->'items') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Use 1–50 line items' USING ERRCODE='22023'; END IF;
 project:=nullif(p_payload->>'project_id','')::uuid;
 IF project IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=project AND account_id=p_account) THEN RAISE EXCEPTION 'Project must belong to this account' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['description','quantity','unit_price_minor']<>'{}'::jsonb
  OR coalesce(length(btrim(item->>'description')),0) NOT BETWEEN 1 AND 300
  OR coalesce(item->>'quantity','') !~ '^[0-9]+$' OR coalesce(item->>'unit_price_minor','') !~ '^[0-9]+$'
  OR (item->>'quantity')::numeric NOT BETWEEN 1 AND 10000 OR (item->>'unit_price_minor')::numeric NOT BETWEEN 0 AND 1000000000 THEN RAISE EXCEPTION 'Invalid line item' USING ERRCODE='22023'; END IF;
  total:=total+(item->>'quantity')::bigint*(item->>'unit_price_minor')::bigint;
 END LOOP;
 IF total>9000000000000 THEN RAISE EXCEPTION 'Estimate total exceeds limit' USING ERRCODE='22023'; END IF;
 IF p_id IS NULL THEN
  INSERT INTO public.estimates(account_id,project_id,title,currency,notes,total_minor,created_by,idempotency_key,request_fingerprint)
  VALUES(p_account,project,btrim(p_payload->>'title'),p_payload->>'currency',coalesce(p_payload->>'notes',''),total,auth.uid(),p_key,fingerprint) RETURNING * INTO e;
 ELSE
  UPDATE public.estimates SET project_id=project,title=btrim(p_payload->>'title'),currency=p_payload->>'currency',notes=coalesce(p_payload->>'notes',''),total_minor=total,version=version+1,updated_at=now() WHERE id=e.id RETURNING * INTO e;
  DELETE FROM public.estimate_line_items WHERE estimate_id=e.id;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
  INSERT INTO public.estimate_line_items(estimate_id,position,description,quantity,unit_price_minor)
  VALUES(e.id,n,btrim(item->>'description'),(item->>'quantity')::integer,(item->>'unit_price_minor')::bigint);n:=n+1;
 END LOOP;
 INSERT INTO public.estimate_events(estimate_id,actor_id,from_status,to_status,version) VALUES(e.id,auth.uid(),CASE WHEN p_id IS NULL THEN NULL ELSE 'draft' END,'draft',e.version);
 RETURN jsonb_build_object('id',e.id,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.kontrora_save_estimate(uuid,jsonb,text,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.kontrora_save_estimate(uuid,jsonb,text,uuid,integer) TO authenticated;
GRANT ALL ON public.finance_access_grants,public.estimates,public.estimate_line_items,public.estimate_events TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
