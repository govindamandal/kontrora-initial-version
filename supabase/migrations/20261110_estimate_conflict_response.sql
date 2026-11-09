-- Clear only long-running Data API calls for this estimate function.
-- These are the stale-version test calls that used SQLSTATE 40001.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND usename = 'authenticator'
  AND state = 'active'
  AND query_start < now() - interval '30 seconds'
  AND query LIKE '%kontrora_save_estimate%';

BEGIN;
CREATE OR REPLACE FUNCTION public.kontrora_save_estimate(p_account uuid,p_payload jsonb,p_key text DEFAULT NULL,p_id uuid DEFAULT NULL,p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.estimates; item jsonb; n integer:=0; total bigint:=0; target text; project uuid; replay boolean:=false; fingerprint text;
BEGIN
 IF NOT public.kontrora_finance_access(p_account,true) THEN RAISE EXCEPTION 'Financial access denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid estimate' USING ERRCODE='22023'; END IF;
 IF p_id IS NULL THEN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'Idempotency-Key must contain 8–128 characters' USING ERRCODE='22023'; END IF;
  fingerprint:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text || auth.uid()::text || p_key,0));
  SELECT * INTO e FROM public.estimates WHERE account_id=p_account AND created_by=auth.uid() AND idempotency_key=p_key;
  IF FOUND THEN
   IF e.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Idempotency key was used for different content' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('id',e.id,'replayed',true);
  END IF;
 ELSE
  SELECT * INTO e FROM public.estimates WHERE id=p_id AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found' USING ERRCODE='P0002'; END IF;
  IF p_version IS NULL OR e.version<>p_version THEN RAISE EXCEPTION 'Estimate changed; reload before saving' USING ERRCODE='PT409'; END IF;
 END IF;
 target:=coalesce(p_payload->>'status',CASE WHEN p_id IS NULL THEN 'draft' ELSE e.status END);
 IF p_id IS NOT NULL AND target<>e.status THEN
  IF NOT ((e.status='draft' AND target='sent') OR (e.status='sent' AND target IN ('accepted','rejected'))) THEN
   RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='22023';
  END IF;
  IF (p_payload - 'status')<>'{}'::jsonb THEN RAISE EXCEPTION 'Send a transition separately from content changes' USING ERRCODE='22023'; END IF;
  IF target='sent' AND (e.total_minor<=0 OR NOT EXISTS(SELECT 1 FROM public.estimate_line_items WHERE estimate_id=e.id AND archived_at IS NULL)) THEN
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
  UPDATE public.estimate_line_items SET archived_at=now() WHERE estimate_id=e.id AND archived_at IS NULL;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
  INSERT INTO public.estimate_line_items(estimate_id,position,description,quantity,unit_price_minor)
  VALUES(e.id,n,btrim(item->>'description'),(item->>'quantity')::integer,(item->>'unit_price_minor')::bigint);n:=n+1;
 END LOOP;
 INSERT INTO public.estimate_events(estimate_id,actor_id,from_status,to_status,version) VALUES(e.id,auth.uid(),CASE WHEN p_id IS NULL THEN NULL ELSE 'draft' END,'draft',e.version);
 RETURN jsonb_build_object('id',e.id,'replayed',false);
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
