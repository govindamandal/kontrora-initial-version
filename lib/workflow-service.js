const { database, result } = require('./service-db');

const templateQuery = (db) =>
  db.from('workflow_templates').select('*, workflow_nodes(*), workflow_connections(*)');
async function getWorkflowTemplates(client) {
  return result(templateQuery(database(client)).eq('is_active', true).order('name'));
}
async function getAllWorkflowTemplates(client) {
  return result(templateQuery(database(client)).order('name'));
}
async function getWorkflowTemplateById(id, client) {
  return result(templateQuery(database(client)).eq('id', id).maybeSingle());
}
async function createWorkflowTemplate(name, description, createdBy, client) {
  return result(
    database(client)
      .from('workflow_templates')
      .insert({ name, description, created_by: createdBy })
      .select()
      .single(),
  );
}
async function updateWorkflowTemplate(id, updates, client) {
  const allowed = Object.fromEntries(
    Object.entries(updates).filter(([k]) => ['name', 'description', 'is_active'].includes(k)),
  );
  return result(
    database(client).from('workflow_templates').update(allowed).eq('id', id).select().single(),
  );
}
async function deleteWorkflowTemplate(id, client) {
  // Preserve templates referenced by historical workflow instances.
  return updateWorkflowTemplate(id, { is_active: false }, client);
}
function nodeData(input) {
  const { settings, requires_form, form_template_id, ...fields } = input;
  const allowed = Object.fromEntries(
    Object.entries(fields).filter(([k]) =>
      ['node_type', 'entity_id', 'position_x', 'position_y', 'label'].includes(k),
    ),
  );
  if (settings !== undefined || requires_form !== undefined || form_template_id !== undefined) {
    allowed.config = {
      ...(settings || {}),
      ...(requires_form !== undefined && { requires_form }),
      ...(form_template_id !== undefined && { form_template_id }),
    };
  }
  return allowed;
}
async function createWorkflowNode(templateId, input, client) {
  return result(
    database(client)
      .from('workflow_nodes')
      .insert({ ...nodeData(input), workflow_template_id: templateId })
      .select()
      .single(),
  );
}
async function updateWorkflowNode(id, input, client) {
  const db = database(client);
  const patch = nodeData(input);
  if (patch.config) {
    const current = await result(db.from('workflow_nodes').select('config').eq('id', id).single());
    patch.config = { ...current.config, ...patch.config };
  }
  return result(db.from('workflow_nodes').update(patch).eq('id', id).select().single());
}
async function deleteWorkflowNode(id, client) {
  return result(database(client).from('workflow_nodes').delete().eq('id', id));
}
async function createWorkflowConnection(templateId, fromId, toId, condition, client) {
  const db = database(client);
  const nodes = await result(
    db
      .from('workflow_nodes')
      .select('id')
      .eq('workflow_template_id', templateId)
      .in('id', [...new Set([fromId, toId])]),
  );
  if (nodes.length !== new Set([fromId, toId]).size)
    throw new Error('Connection nodes must belong to this workflow template');
  return result(
    db
      .from('workflow_connections')
      .insert({
        workflow_template_id: templateId,
        from_node_id: fromId,
        to_node_id: toId,
        condition: condition == null ? null : JSON.stringify(condition),
      })
      .select()
      .single(),
  );
}
async function deleteWorkflowConnection(id, client) {
  return result(database(client).from('workflow_connections').delete().eq('id', id));
}
async function getWorkflowInstanceById(id, client) {
  return result(
    database(client)
      .from('workflow_instances')
      .select('*, workflow_templates(*), workflow_nodes!current_node_id(*), projects(*)')
      .eq('id', id)
      .maybeSingle(),
  );
}
async function getWorkflowHistory(id, client) {
  return result(
    database(client)
      .from('workflow_history')
      .select('*')
      .eq('workflow_instance_id', id)
      .order('created_at'),
  );
}
async function getNextAvailableNodes(id, client) {
  const db = database(client);
  const instance = await getWorkflowInstanceById(id, db);
  if (!instance || instance.status !== 'active') return [];
  const edges = await result(
    db
      .from('workflow_connections')
      .select('to_node_id')
      .eq('workflow_template_id', instance.workflow_template_id)
      .eq('from_node_id', instance.current_node_id),
  );
  if (!edges.length) return [];
  return result(
    db
      .from('workflow_nodes')
      .select('*')
      .in(
        'id',
        edges.map((e) => e.to_node_id),
      ),
  );
}
async function startWorkflowInstance(input, client) {
  const db = database(client);
  return result(
    db.rpc('kontrora_start_workflow', {
      template_id: input.workflowTemplateId,
      project_id_arg: input.projectId || null,
      task_id_arg: input.taskId || null,
      start_node_id_arg: input.startNodeId || null,
    }),
  );
}
async function handoffWorkflow(client, input) {
  return result(
    database(client).rpc('kontrora_handoff_workflow', {
      instance_id: input.instanceId,
      target_node_id: input.toNodeId,
      notes_arg: input.notes || null,
      form_response_id_arg: input.formResponseId || null,
      assignee_id: input.handedOffTo || null,
      skip_arg: Boolean(input.outOfOrder),
    }),
  );
}
module.exports = {
  getWorkflowTemplates,
  getAllWorkflowTemplates,
  getWorkflowTemplateById,
  createWorkflowTemplate,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
  createWorkflowNode,
  updateWorkflowNode,
  deleteWorkflowNode,
  createWorkflowConnection,
  deleteWorkflowConnection,
  getWorkflowInstanceById,
  getWorkflowHistory,
  getNextAvailableNodes,
  startWorkflowInstance,
  handoffWorkflow,
};
