const { database, result } = require('./service-db');

async function getFormResponseById(id, client) {
  return result(
    database(client)
      .from('form_responses')
      .select('*, form_templates(*)')
      .eq('id', id)
      .maybeSingle(),
  );
}
async function getFormResponseByHistoryId(id, client) {
  return result(
    database(client)
      .from('form_responses')
      .select('*, form_templates(*)')
      .eq('workflow_history_id', id)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
}
function validateFields(fields, data) {
  for (const field of fields || []) {
    const value = data[field.id];
    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) throw new Error(`Required field: ${field.label}`);
    if (empty) continue;
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error(`Invalid number: ${field.label}`);
    if (field.type === 'checkbox' && typeof value !== 'boolean')
      throw new Error(`Invalid checkbox: ${field.label}`);
    if (field.type === 'dropdown' && !field.options?.includes(value))
      throw new Error(`Invalid option: ${field.label}`);
    if (
      field.type === 'multiselect' &&
      (!Array.isArray(value) || value.some((v) => !field.options?.includes(v)))
    )
      throw new Error(`Invalid options: ${field.label}`);
  }
}
async function submitFormResponse(input, client) {
  const db = database(client);
  const template = await result(
    db.from('form_templates').select('fields,is_active').eq('id', input.formTemplateId).single(),
  );
  if (!template.is_active) throw new Error('Form template is not active');
  validateFields(template.fields, input.responseData);
  return result(
    db
      .from('form_responses')
      .insert({
        form_template_id: input.formTemplateId,
        response_data: input.responseData,
        submitted_by: input.submittedBy,
        workflow_history_id: input.workflowHistoryId || null,
      })
      .select()
      .single(),
  );
}
module.exports = {
  getFormResponseById,
  getFormResponseByHistoryId,
  submitFormResponse,
  validateFields,
};
