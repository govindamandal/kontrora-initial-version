-- Required by the restored workflow services. Each transition is one transaction.
-- SECURITY INVOKER retains the caller's RLS context; never trust a caller-supplied user ID.
BEGIN;
CREATE OR REPLACE FUNCTION public.kontrora_workflow_access(project_id_arg uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS (
   SELECT 1 FROM user_profiles u WHERE u.id=auth.uid() AND (
     u.is_superadmin OR EXISTS (
       SELECT 1 FROM projects p WHERE p.id=project_id_arg AND (
         p.created_by=u.id OR p.assigned_user_id=u.id OR EXISTS (
           SELECT 1 FROM project_assignments a WHERE a.project_id=p.id AND a.user_id=u.id AND a.removed_at IS NULL
         ) OR EXISTS (SELECT 1 FROM accounts a WHERE a.id=p.account_id AND a.account_manager_id=u.id)
       )
     )
   )
 );
$$;
CREATE OR REPLACE FUNCTION public.kontrora_start_workflow(
 template_id uuid, project_id_arg uuid DEFAULT NULL, task_id_arg uuid DEFAULT NULL, start_node_id_arg uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE pid uuid; node workflow_nodes; instance workflow_instances;
BEGIN
 IF (project_id_arg IS NULL) = (task_id_arg IS NULL) THEN RAISE EXCEPTION 'Provide either project or task'; END IF;
 pid:=project_id_arg;
 IF task_id_arg IS NOT NULL THEN SELECT project_id INTO pid FROM tasks WHERE id=task_id_arg; END IF;
 IF NOT coalesce(kontrora_workflow_access(pid),false) THEN RAISE EXCEPTION 'Project access denied'; END IF;
 IF NOT EXISTS (SELECT 1 FROM user_profiles u WHERE u.id=auth.uid() AND (u.is_superadmin OR EXISTS (
   SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND ur.removed_at IS NULL
   AND (coalesce((r.permissions->>'execute_workflows')::boolean,false) OR coalesce((r.permissions->>'execute_any_workflow')::boolean,false))
 ))) THEN RAISE EXCEPTION 'Workflow execution permission required'; END IF;
 -- Serialize starts on the project, including task-linked workflow starts.
 PERFORM 1 FROM projects WHERE id=pid FOR UPDATE;
 IF NOT EXISTS (SELECT 1 FROM workflow_templates WHERE id=template_id AND is_active) THEN RAISE EXCEPTION 'Workflow template not found or not active'; END IF;
 IF EXISTS (SELECT 1 FROM workflow_instances WHERE status='active' AND
   ((project_id_arg IS NOT NULL AND project_id=project_id_arg) OR (task_id_arg IS NOT NULL AND task_id=task_id_arg)))
 THEN RAISE EXCEPTION 'Project or task already has an active workflow'; END IF;
 SELECT * INTO node FROM workflow_nodes WHERE workflow_template_id=template_id AND node_type='start'
   AND (start_node_id_arg IS NULL OR id=start_node_id_arg) ORDER BY id LIMIT 1;
 IF node.id IS NULL THEN RAISE EXCEPTION 'Invalid start node or template has no nodes'; END IF;
 INSERT INTO workflow_instances(workflow_template_id,project_id,task_id,current_node_id)
 VALUES(template_id,project_id_arg,task_id_arg,node.id) RETURNING * INTO instance;
 INSERT INTO workflow_active_steps(workflow_instance_id,node_id,assigned_user_id) VALUES(instance.id,node.id,auth.uid());
 RETURN to_jsonb(instance);
END;
$$;
CREATE OR REPLACE FUNCTION public.kontrora_handoff_workflow(
 instance_id uuid, target_node_id uuid, notes_arg text DEFAULT NULL,
 form_response_id_arg uuid DEFAULT NULL, assignee_id uuid DEFAULT NULL, skip_arg boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE instance workflow_instances; target workflow_nodes; history workflow_history; pid uuid; privileged boolean; can_skip boolean;
BEGIN
 SELECT * INTO instance FROM workflow_instances WHERE id=instance_id FOR UPDATE;
 IF instance.id IS NULL OR instance.status<>'active' THEN RAISE EXCEPTION 'Workflow is not active'; END IF;
 pid:=instance.project_id;
 IF pid IS NULL THEN SELECT project_id INTO pid FROM tasks WHERE id=instance.task_id; END IF;
 IF NOT coalesce(kontrora_workflow_access(pid),false) THEN RAISE EXCEPTION 'Project access denied'; END IF;
 SELECT u.is_superadmin OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
   WHERE ur.user_id=u.id AND ur.removed_at IS NULL AND coalesce((r.permissions->>'execute_any_workflow')::boolean,false)),
   u.is_superadmin OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
   WHERE ur.user_id=u.id AND ur.removed_at IS NULL AND coalesce((r.permissions->>'skip_workflow_nodes')::boolean,false))
 INTO privileged,can_skip FROM user_profiles u WHERE u.id=auth.uid();
 IF NOT coalesce(privileged,false) AND NOT EXISTS (
   SELECT 1 FROM workflow_active_steps s WHERE s.workflow_instance_id=instance_id AND s.node_id=instance.current_node_id
   AND s.status='active' AND s.assigned_user_id=auth.uid()
 ) AND NOT EXISTS (SELECT 1 FROM workflow_node_assignments a WHERE a.workflow_node_id=instance.current_node_id AND a.assigned_user_id=auth.uid())
 THEN RAISE EXCEPTION 'Current workflow step is not assigned to you'; END IF;
 SELECT * INTO target FROM workflow_nodes WHERE id=target_node_id AND workflow_template_id=instance.workflow_template_id;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Target node does not belong to this workflow'; END IF;
 IF target.id=instance.current_node_id THEN RAISE EXCEPTION 'Workflow has already moved to this node'; END IF;
 IF skip_arg AND NOT coalesce(can_skip,false) THEN RAISE EXCEPTION 'Skip permission required'; END IF;
 IF NOT skip_arg AND NOT EXISTS (SELECT 1 FROM workflow_connections c WHERE c.workflow_template_id=instance.workflow_template_id
   AND c.from_node_id=instance.current_node_id AND c.to_node_id=target.id AND (c.condition IS NULL OR c.condition='null'))
 THEN RAISE EXCEPTION 'No unconditional connection to target node'; END IF;
 IF assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_assignments WHERE project_id=pid AND user_id=assignee_id AND removed_at IS NULL)
 THEN RAISE EXCEPTION 'Assignee must belong to this project'; END IF;
 IF form_response_id_arg IS NOT NULL AND NOT EXISTS (SELECT 1 FROM form_responses f JOIN workflow_history h ON h.id=f.workflow_history_id
   WHERE f.id=form_response_id_arg AND f.submitted_by=auth.uid() AND h.workflow_instance_id=instance.id)
 THEN RAISE EXCEPTION 'Form response does not belong to this workflow'; END IF;
 UPDATE workflow_active_steps SET status='completed',completed_at=now() WHERE workflow_instance_id=instance_id AND node_id=instance.current_node_id AND status='active';
 INSERT INTO workflow_history(workflow_instance_id,from_node_id,to_node_id,transitioned_by,notes,form_response_id,out_of_order,transition_type)
 VALUES(instance.id,instance.current_node_id,target.id,auth.uid(),notes_arg,form_response_id_arg,skip_arg,CASE WHEN skip_arg THEN 'skip' ELSE 'normal' END)
 RETURNING * INTO history;
 UPDATE workflow_instances SET current_node_id=target.id,status=CASE WHEN target.node_type='end' THEN 'completed' ELSE 'active' END,
 completed_at=CASE WHEN target.node_type='end' THEN now() ELSE NULL END WHERE id=instance_id;
 IF target.node_type<>'end' THEN INSERT INTO workflow_active_steps(workflow_instance_id,node_id,assigned_user_id) VALUES(instance_id,target.id,assignee_id); END IF;
 RETURN to_jsonb(history);
END;
$$;
CREATE OR REPLACE FUNCTION public.kontrora_client_decision(instance_id uuid, project_id_arg uuid, decision_arg text, notes_arg text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE instance workflow_instances; target workflow_nodes; previous uuid; edge_count integer; history workflow_history;
BEGIN
 IF decision_arg NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid client decision'; END IF;
 SELECT * INTO instance FROM workflow_instances WHERE id=instance_id AND project_id=project_id_arg FOR UPDATE;
 IF instance.id IS NULL OR instance.status<>'active' THEN RAISE EXCEPTION 'Workflow not active for this project'; END IF;
 IF NOT EXISTS (SELECT 1 FROM projects p JOIN user_profiles u ON u.client_account_id=p.account_id
   WHERE p.id=project_id_arg AND u.id=auth.uid() AND u.is_client) THEN RAISE EXCEPTION 'Client account access denied'; END IF;
 IF NOT EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.id=instance.current_node_id AND n.node_type='approval'
   AND coalesce((n.config->>'client_approval')::boolean,false)) THEN RAISE EXCEPTION 'Workflow is not awaiting client approval'; END IF;
 IF decision_arg='approve' THEN
   SELECT count(*) INTO edge_count FROM workflow_connections WHERE from_node_id=instance.current_node_id AND workflow_template_id=instance.workflow_template_id AND (condition IS NULL OR condition='null');
   IF edge_count<>1 THEN RAISE EXCEPTION 'Client approval requires exactly one unconditional next node'; END IF;
   SELECT n.* INTO target FROM workflow_nodes n JOIN workflow_connections c ON c.to_node_id=n.id
     WHERE c.from_node_id=instance.current_node_id AND c.workflow_template_id=instance.workflow_template_id AND (c.condition IS NULL OR c.condition='null');
 ELSE
   IF notes_arg IS NULL OR length(trim(notes_arg))=0 THEN RAISE EXCEPTION 'Rejection notes required'; END IF;
   SELECT from_node_id INTO previous FROM workflow_history WHERE workflow_instance_id=instance_id AND to_node_id=instance.current_node_id ORDER BY created_at DESC LIMIT 1;
   SELECT * INTO target FROM workflow_nodes WHERE id=previous AND workflow_template_id=instance.workflow_template_id;
 END IF;
 IF target.id IS NULL THEN RAISE EXCEPTION 'No valid target node'; END IF;
 UPDATE workflow_active_steps SET status='completed',completed_at=now() WHERE workflow_instance_id=instance_id AND status='active';
 INSERT INTO workflow_history(workflow_instance_id,from_node_id,to_node_id,transitioned_by,notes,transition_type)
 VALUES(instance_id,instance.current_node_id,target.id,auth.uid(),notes_arg,CASE WHEN decision_arg='reject' THEN 'rejection' ELSE 'normal' END) RETURNING * INTO history;
 UPDATE workflow_instances SET current_node_id=target.id,status=CASE WHEN target.node_type='end' THEN 'completed' ELSE 'active' END,
 completed_at=CASE WHEN target.node_type='end' THEN now() ELSE NULL END WHERE id=instance_id;
 IF target.node_type<>'end' THEN INSERT INTO workflow_active_steps(workflow_instance_id,node_id) VALUES(instance_id,target.id); END IF;
 RETURN to_jsonb(history);
END;
$$;
REVOKE ALL ON FUNCTION public.kontrora_workflow_access(uuid), public.kontrora_start_workflow(uuid,uuid,uuid,uuid), public.kontrora_handoff_workflow(uuid,uuid,text,uuid,uuid,boolean), public.kontrora_client_decision(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kontrora_workflow_access(uuid), public.kontrora_start_workflow(uuid,uuid,uuid,uuid), public.kontrora_handoff_workflow(uuid,uuid,text,uuid,uuid,boolean), public.kontrora_client_decision(uuid,uuid,text,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
