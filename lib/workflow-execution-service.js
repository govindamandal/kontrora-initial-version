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
