"""Real PostgreSQL integration checks in an isolated, automatically dropped database."""
import subprocess, uuid, re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
suffix=uuid.uuid4().hex[:10]
name='kontrora_estimates_'+suffix
roles={r:r+'_'+suffix for r in ('anon','authenticated','service_role')}
base=['psql','-h','127.0.0.1','-U','postgres','-w','-v','ON_ERROR_STOP=1','-q','-At']
def run(text,db=name):
 p=subprocess.run(base+['-d',db],input=text,text=True,capture_output=True)
 if p.returncode: raise RuntimeError(p.stderr)
 return p.stdout.strip()
def as_user(sql,user='11111111-1111-1111-1111-000000000001'):
 return run(f"SET ROLE {roles['authenticated']}; SET request.jwt.claim.sub='{user}'; "+sql)
subprocess.run(['createdb','-h','127.0.0.1','-U','postgres','-w',name],check=True)
try:
 for role in roles.values(): run(f'CREATE ROLE {role} NOLOGIN;',db='postgres')
 run("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;")
 run(Path('supabase/schema.sql').read_text())
 run("""
 INSERT INTO auth.users(id,email) VALUES ('11111111-1111-1111-1111-000000000001','finance@test.local'),('11111111-1111-1111-1111-000000000002','viewer@test.local'),('11111111-1111-1111-1111-000000000003','outsider@test.local');
 UPDATE user_profiles SET is_superadmin=true WHERE id='11111111-1111-1111-1111-000000000001';
 INSERT INTO accounts(id,name) VALUES('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','Account A'),('aaaaaaaa-aaaa-aaaa-aaaa-000000000002','Account B');
 INSERT INTO projects(id,name,account_id) VALUES('ffffffff-0001-0002-0003-000000000001','Project A','aaaaaaaa-aaaa-aaaa-aaaa-000000000001'),('ffffffff-0001-0002-0003-000000000002','Project B','aaaaaaaa-aaaa-aaaa-aaaa-000000000002');
 """)
 migration=Path('supabase/migrations/20261109_estimates.sql').read_text()
 for old,new in roles.items(): migration=re.sub(r'\b'+old+r'\b',new,migration)
 run(migration)
 run(f"GRANT USAGE ON SCHEMA auth TO {roles['authenticated']}; GRANT ALL ON user_profiles,roles,user_roles,accounts TO {roles['authenticated']};")
 run("""DELETE FROM finance_access_grants;
 INSERT INTO finance_access_grants(user_id,account_id,finance_role) VALUES
 ('11111111-1111-1111-1111-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-000000000001','editor'),
 ('11111111-1111-1111-1111-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-000000000001','viewer');""")
 payload='''{"title":"Integration estimate","currency":"USD","items":[{"description":"Discovery","quantity":3,"unit_price_minor":1999}],"notes":"","project_id":"ffffffff-0001-0002-0003-000000000001"}'''
 create=f"SELECT kontrora_save_estimate('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','{payload}'::jsonb,'integration-key-1');"
 with ThreadPoolExecutor(max_workers=2) as pool: concurrent=list(pool.map(lambda _: as_user(create),range(2)))
 import json
 results=[json.loads(s) for s in concurrent]
 assert len({s['id'] for s in results})==1 and sorted(s['replayed'] for s in results)==[False,True],results
 eid=results[0]['id']
 try: run("UPDATE projects SET account_id='aaaaaaaa-aaaa-aaaa-aaaa-000000000002' WHERE id='ffffffff-0001-0002-0003-000000000001';")
 except RuntimeError as e: assert 'foreign key constraint' in str(e)
 else: raise AssertionError('Linked project moved across accounts')
 assert as_user(f"SELECT total_minor FROM estimates WHERE id='{eid}';")=='5997'
 def denied(sql,message=None,user='11111111-1111-1111-1111-000000000001'):
  try: as_user(sql,user)
  except RuntimeError as e:
   if message: assert message in str(e),str(e)
  else: raise AssertionError('Expected denial: '+sql)
 denied(create.replace('Integration estimate','Different payload'),'different content')
 denied(create.replace('integration-key-1','integration-key-2').replace('000000000001"}','000000000002"}'),'Project must belong')
 denied(create.replace('integration-key-1','integration-key-3').replace('"quantity":3','"quantity":1.5'),'Invalid line item')
 denied(create.replace('integration-key-1','integration-key-4').replace('"unit_price_minor":1999','"unit_price_minor":-1'),'Invalid line item')
 denied(f"SELECT kontrora_save_estimate('aaaaaaaa-aaaa-aaaa-aaaa-000000000002','{payload}','wrong-account-key');",'Financial access denied')
 viewer='11111111-1111-1111-1111-000000000002'; outsider='11111111-1111-1111-1111-000000000003'
 assert as_user('SELECT count(*) FROM estimates;',viewer)=='1'
 denied(create,'Financial access denied',viewer)
 assert as_user('SELECT count(*) FROM estimates;',outsider)=='0'
 assert as_user('SELECT count(*) FROM estimate_line_items;',outsider)=='0'
 assert as_user('SELECT count(*) FROM estimate_events;',outsider)=='0'
 # Even permissive legacy profile/role policies cannot create a finance entitlement.
 as_user("UPDATE user_profiles SET is_superadmin=true WHERE id='"+outsider+"';",outsider)
 denied(create,'Financial access denied',outsider)
 denied("INSERT INTO finance_access_grants(user_id,finance_role) VALUES('"+outsider+"','editor');",'permission denied',outsider)
 denied(f"UPDATE estimates SET total_minor=1 WHERE id='{eid}';",'permission denied')
 denied(f"DELETE FROM estimates WHERE id='{eid}';",'permission denied')
 def transition(status,version):
  return f"SELECT kontrora_save_estimate('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','{{\"status\":\"{status}\"}}',NULL,'{eid}',{version});"
 # Draft editing replaces line items atomically and appends a versioned event.
 as_user(f"SELECT kontrora_save_estimate('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','{payload.replace('Integration estimate','Updated scope')}',NULL,'{eid}',1);")
 assert as_user(f"SELECT title FROM estimates WHERE id='{eid}';")=='Updated scope'
 assert as_user(f"SELECT count(*) FROM estimate_line_items WHERE estimate_id='{eid}';")=='1'
 denied(transition('accepted',2),'Invalid lifecycle transition')
 denied(transition('sent',99),'reload')
 as_user(transition('sent',2))
 denied(f"SELECT kontrora_save_estimate('aaaaaaaa-aaaa-aaaa-aaaa-000000000001','{payload}',NULL,'{eid}',3);",'Only draft')
 # Two concurrent terminal decisions: one succeeds and one sees a stale version.
 def decide(status):
  try: as_user(transition(status,3)); return True
  except RuntimeError as e: assert 'reload' in str(e); return False
 with ThreadPoolExecutor(max_workers=2) as pool: assert sorted(pool.map(decide,['accepted','rejected']))==[False,True]
 denied(transition('sent',4),'Invalid lifecycle transition')
 assert as_user(f"SELECT count(*) FROM estimate_events WHERE estimate_id='{eid}';")=='4'
 # Rollback retained totals/items, idempotency replays don't create extra records/events.
 assert as_user('SELECT count(*) FROM estimates;')=='1'
 assert as_user(f"SELECT total_minor FROM estimates WHERE id='{eid}';")=='5997'
 assert as_user(create) and as_user('SELECT count(*) FROM estimates;')=='1'
 try: run(f"DELETE FROM estimates WHERE id='{eid}';")
 except RuntimeError as e: assert 'cannot be deleted' in str(e)
 else: raise AssertionError('Hard delete was permitted')
 print('Estimates PostgreSQL: PASS — concurrent idempotency, conflict/rollback, exact totals, project/account boundaries, viewer/outsider RLS, legacy escalation isolation, locked lifecycle, optimistic concurrency, immutable records/history')
finally:
 subprocess.run(['dropdb','-h','127.0.0.1','-U','postgres','-w',name],check=True)
 for role in roles.values(): run(f'DROP ROLE IF EXISTS {role};',db='postgres')
