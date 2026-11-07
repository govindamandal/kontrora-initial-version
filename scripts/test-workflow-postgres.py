import subprocess,uuid
from pathlib import Path
name='kontrora_verify_'+uuid.uuid4().hex[:10]
base=['psql','-h','127.0.0.1','-U','postgres','-w','-v','ON_ERROR_STOP=1','-q']
def sql(text):
 p=subprocess.run(base+['-d',name],input=text,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr)
subprocess.run(['createdb','-h','127.0.0.1','-U','postgres','-w',name],check=True)
try:
 sql("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;")
 sql(Path('supabase/schema.sql').read_text())
 migration=Path('supabase/migrations/20261107_workflow_transactions.sql').read_text().replace('FROM PUBLIC, anon','FROM PUBLIC').replace('TO authenticated','TO CURRENT_USER')
 sql(migration)
 sql("""
 INSERT INTO auth.users(id,email) VALUES('11111111-1111-1111-1111-000000000001','workflow-check@test.local');
 UPDATE user_profiles SET is_superadmin=true;
 INSERT INTO accounts(id,name) VALUES('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','Disposable integration fixture');
 INSERT INTO projects(id,name,account_id) VALUES('ffffffff-0001-0002-0003-000000000001','Disposable integration fixture','aaaaaaaa-aaaa-aaaa-aaaa-000000000001');
 INSERT INTO workflow_templates(id,name,is_active) VALUES('00000001-0002-0003-0004-000000000001','Integration fixture',true);
 INSERT INTO workflow_nodes(id,workflow_template_id,label,node_type) VALUES
 ('aaaaaaaa-bbbb-cccc-dddd-000000000001','00000001-0002-0003-0004-000000000001','Start','start'),
 ('aaaaaaaa-bbbb-cccc-dddd-000000000002','00000001-0002-0003-0004-000000000001','End','end');
 INSERT INTO workflow_connections(workflow_template_id,from_node_id,to_node_id) VALUES('00000001-0002-0003-0004-000000000001','aaaaaaaa-bbbb-cccc-dddd-000000000001','aaaaaaaa-bbbb-cccc-dddd-000000000002');
 DO $$ BEGIN
   BEGIN PERFORM kontrora_start_workflow('00000001-0002-0003-0004-000000000001','ffffffff-0001-0002-0003-000000000001'); RAISE EXCEPTION 'Expected denial';
   EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Project access denied' THEN RAISE; END IF; END;
 END $$;
 SELECT set_config('request.jwt.claim.sub','11111111-1111-1111-1111-000000000001',false);
 DO $$ DECLARE instance jsonb; iid uuid; BEGIN
   instance:=kontrora_start_workflow('00000001-0002-0003-0004-000000000001','ffffffff-0001-0002-0003-000000000001'); iid:=(instance->>'id')::uuid;
   BEGIN PERFORM kontrora_start_workflow('00000001-0002-0003-0004-000000000001','ffffffff-0001-0002-0003-000000000001'); RAISE EXCEPTION 'Expected duplicate denial';
   EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Project or task already has an active workflow' THEN RAISE; END IF; END;
   BEGIN PERFORM kontrora_handoff_workflow(iid,'aaaaaaaa-bbbb-cccc-dddd-999999999999'); RAISE EXCEPTION 'Expected target denial';
   EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Target node does not belong to this workflow' THEN RAISE; END IF; END;
   IF (SELECT count(*) FROM workflow_history WHERE workflow_instance_id=iid)<>0 THEN RAISE EXCEPTION 'Invalid transition wrote history'; END IF;
   PERFORM kontrora_handoff_workflow(iid,'aaaaaaaa-bbbb-cccc-dddd-000000000002');
   IF (SELECT status FROM workflow_instances WHERE id=iid)<>'completed' THEN RAISE EXCEPTION 'Workflow did not complete'; END IF;
   IF (SELECT count(*) FROM workflow_history WHERE workflow_instance_id=iid)<>1 THEN RAISE EXCEPTION 'History was not saved'; END IF;
   BEGIN PERFORM kontrora_handoff_workflow(iid,'aaaaaaaa-bbbb-cccc-dddd-000000000002'); RAISE EXCEPTION 'Expected repeated transition denial';
   EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Workflow is not active' THEN RAISE; END IF; END;
 END $$;
 """)
 print('PostgreSQL workflow integration: PASS (unauthenticated denial, duplicate start, invalid target rollback, completion/history, repeated transition denial)')
finally:
 subprocess.run(['dropdb','-h','127.0.0.1','-U','postgres','-w',name],check=True)
