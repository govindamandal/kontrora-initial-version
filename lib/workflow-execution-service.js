const { database, result } = require('./service-db');
const {
  startWorkflowInstance,
  handoffWorkflow,
  getWorkflowInstanceById,
  getNextAvailableNodes,
} = require('./workflow-service');

async function getActiveSteps(client, instanceId) {
  return result(
    database(client)
      .from('workflow_active_steps')
      .select('*, workflow_nodes(*)')
      .eq('workflow_instance_id', instanceId)
      .eq('status', 'active'),
  );
}
async function getAllActiveAndWaitingSteps(client, instanceId) {
  return getActiveSteps(client, instanceId);
}
async function isWorkflowComplete(client, instanceId) {
  const row = await result(
    database(client).from('workflow_instances').select('status').eq('id', instanceId).single(),
  );
  return row.status === 'completed';
}
async function getUserActiveProjects(client, userId) {
  const db = database(client);
  const assignments = await result(
    db
      .from('project_assignments')
      .select('project_id')
      .eq('user_id', userId)
      .is('removed_at', null),
  );
  if (!assignments.length) return [];
  return result(
    db
      .from('workflow_instances')
      .select('*, projects(*), workflow_nodes!current_node_id(*)')
      .eq('status', 'active')
      .in(
        'project_id',
        assignments.map((a) => a.project_id),
      ),
  );
}
async function getUserPendingApprovals(client, userId) {
  return result(
    database(client)
      .from('workflow_approvals')
      .select('*, workflow_nodes(*), workflow_instances(*,projects(*))')
      .eq('approver_id', userId)
      .eq('status', 'pending'),
  );
}
async function startWorkflowForProject(client, projectId, templateId) {
  try {
    const instance = await startWorkflowInstance(
      { workflowTemplateId: templateId, projectId },
      client,
    );
    return { success: true, workflowInstanceId: instance.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function progressWorkflowStep(
  client,
  instanceId,
  activeStepId,
  userId,
  decision,
  feedback,
  formResponseId,
  assignedUserId,
  formData,
  assignedUsersPerNode,
) {
  try {
    if (formData || Object.keys(assignedUsersPerNode || {}).length)
      throw new Error(
        'Submit forms separately; parallel branch assignment is not supported by this schema',
      );
    if (decision && !['approve', 'approved', 'complete', 'reject', 'rejected'].includes(decision))
      throw new Error('Invalid workflow decision');
    if (activeStepId) {
      const step = await result(
        client
          .from('workflow_active_steps')
          .select('node_id,status')
          .eq('id', activeStepId)
          .eq('workflow_instance_id', instanceId)
          .single(),
      );
      const instance = await getWorkflowInstanceById(instanceId, client);
      if (step.status !== 'active' || step.node_id !== instance.current_node_id)
        throw new Error('Workflow step is no longer active');
    }
    if (['reject', 'rejected'].includes(decision))
      throw new Error('Select an explicit previous node for a rejection handoff');
    const next = await getNextAvailableNodes(instanceId, client);
    if (next.length !== 1)
      throw new Error('Select an explicit next node for branching or conditional workflows');
    const history = await handoffWorkflow(client, {
      instanceId,
      toNodeId: next[0].id,
      notes: feedback,
      formResponseId,
      handedOffTo: assignedUserId,
    });
    return { success: true, history };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
module.exports = {
  getActiveSteps,
  getAllActiveAndWaitingSteps,
  isWorkflowComplete,
  getUserActiveProjects,
  getUserPendingApprovals,
  startWorkflowForProject,
  progressWorkflowStep,
};

async function getUserPipelineProjects(client, userId, includeAll = false) {
  const db = database(client);
  let query = db
    .from('workflow_node_assignments')
    .select(
      'id,workflow_node_id,assigned_user_id,created_at,workflow_nodes!workflow_node_id(id,label,node_type,workflow_template_id),user_profiles!assigned_user_id(id,name,email)',
    );
  if (!includeAll) query = query.eq('assigned_user_id', userId);
  const assignments = await result(query);
  if (!assignments.length) return [];
  const templateIds = [
    ...new Set(assignments.map((a) => a.workflow_nodes?.workflow_template_id).filter(Boolean)),
  ];
  if (!templateIds.length) return [];
  const instances = await result(
    db
      .from('workflow_instances')
      .select(
        'id,current_node_id,workflow_template_id,projects!project_id(id,name,description,status,priority,created_at,accounts(id,name))',
      )
      .eq('status', 'active')
      .in('workflow_template_id', templateIds),
  );
  const instanceIds = instances.map((i) => i.id);
  const history = instanceIds.length
    ? await result(
        db
          .from('workflow_history')
          .select('workflow_instance_id,from_node_id')
          .in('workflow_instance_id', instanceIds),
      )
    : [];
  const seen = new Set();
  const projects = [];
  for (const instance of instances) {
    const project = instance.projects;
    if (!project || project.status === 'complete') continue;
    for (const assignment of assignments) {
      const node = assignment.workflow_nodes;
      if (
        node?.workflow_template_id !== instance.workflow_template_id ||
        node.id === instance.current_node_id
      )
        continue;
      if (history.some((h) => h.workflow_instance_id === instance.id && h.from_node_id === node.id))
        continue;
      const key = `${project.id}:${assignment.assigned_user_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({
        ...project,
        account: project.accounts,
        workflow_instance_id: instance.id,
        assigned_step: { nodeId: node.id, nodeName: node.label, nodeType: node.node_type },
        assigned_at: assignment.created_at,
        ...(includeAll && { assigned_user: assignment.user_profiles }),
      });
    }
  }
  return projects;
}
module.exports.getUserPipelineProjects = getUserPipelineProjects;
