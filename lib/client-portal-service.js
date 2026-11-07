const { randomBytes } = require('node:crypto');
const { database, result } = require('./service-db');

async function clientAccount(db, userId) {
  const profile = await result(
    db.from('user_profiles').select('is_client,client_account_id').eq('id', userId).single(),
  );
  if (!profile.is_client || !profile.client_account_id)
    throw new Error('Client account access required');
  return profile.client_account_id;
}
async function getClientProjects(userId, client) {
  const db = database(client);
  const accountId = await clientAccount(db, userId);
  return result(
    db
      .from('projects')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false }),
  );
}
async function getClientProjectById(userId, projectId, client) {
  const db = database(client);
  const accountId = await clientAccount(db, userId);
  const project = await result(
    db.from('projects').select('*').eq('id', projectId).eq('account_id', accountId).maybeSingle(),
  );
  if (!project) return null;
  const instances = await result(
    db
      .from('workflow_instances')
      .select('*,workflow_templates(*)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1),
  );
  return { ...project, workflow_instance: instances[0] || null };
}
async function submitClientFeedback(input, client) {
  const db = database(client);
  if (!(await getClientProjectById(input.clientUserId, input.projectId, db)))
    throw new Error('Project not found or access denied');
  if (input.workflowHistoryId) {
    const history = await result(
      db
        .from('workflow_history')
        .select('workflow_instances!workflow_instance_id(project_id)')
        .eq('id', input.workflowHistoryId)
        .single(),
    );
    if (history.workflow_instances?.project_id !== input.projectId)
      throw new Error('Feedback history does not belong to this project');
  }
  return result(
    db
      .from('client_feedback')
      .insert({
        project_id: input.projectId,
        client_user_id: input.clientUserId,
        satisfaction_score: input.satisfactionScore,
        what_went_well: input.whatWentWell,
        what_needs_improvement: input.whatNeedsImprovement,
        workflow_history_id: input.workflowHistoryId,
        visibility: 'private',
      })
      .select()
      .single(),
  );
}
async function getAllClientFeedback(client) {
  return result(
    database(client)
      .from('client_feedback')
      .select('*,projects(id,name),user_profiles!client_user_id(id,name)')
      .order('submitted_at', { ascending: false }),
  );
}
async function sendClientInvitation(input, client) {
  const db = database(client);
  const email = input.email.trim().toLowerCase();
  const existing = await result(
    db.from('user_profiles').select('id').ilike('email', email).limit(1),
  );
  if (existing.length)
    throw new Error('User already exists; invitations require a new client email');
  const pending = await result(
    db
      .from('client_portal_invitations')
      .select('id,expires_at')
      .eq('account_id', input.accountId)
      .ilike('email', email)
      .eq('status', 'pending'),
  );
  if (pending.some((i) => !i.expires_at || new Date(i.expires_at) > new Date()))
    throw new Error('A pending invitation already exists');
  const days = input.expiresInDays ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30)
    throw new Error('Invalid invitation expiry');
  return result(
    db
      .from('client_portal_invitations')
      .insert({
        account_id: input.accountId,
        email,
        invited_by: input.invitedBy,
        token: randomBytes(32).toString('hex'),
        expires_at: new Date(Date.now() + days * 86400000).toISOString(),
      })
      .select()
      .single(),
  );
}
async function decide(input, decision) {
  const db = database(input.supabaseClient);
  if (!(await getClientProjectById(input.clientUserId, input.projectId, db)))
    throw new Error('Project not found or access denied');
  if (input.issues?.length) throw new Error('Submit project issues separately before rejecting');
  return result(
    db.rpc('kontrora_client_decision', {
      instance_id: input.workflowInstanceId,
      project_id_arg: input.projectId,
      decision_arg: decision,
      notes_arg: input.notes || null,
    }),
  );
}
async function clientApproveProject(input) {
  return decide(input, 'approve');
}
async function clientRejectProject(input) {
  return decide(input, 'reject');
}
module.exports = {
  getClientProjects,
  getClientProjectById,
  submitClientFeedback,
  getAllClientFeedback,
  sendClientInvitation,
  clientApproveProject,
  clientRejectProject,
};
