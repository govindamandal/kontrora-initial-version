const { database, result } = require('./service-db');
const { createServerSupabase } = require('./supabase-server');
const { hasPermission } = require('./rbac');
const { Permission } = require('./permissions');
const { getUserProfileFromRequest } = require('./supabase-server');

const roleManagementService = {
  async updateRole(id, input, client) {
    const session = client || (await createServerSupabase());
    const profile = await getUserProfileFromRequest(session);
    if (
      !profile ||
      !(await hasPermission(profile, Permission.MANAGE_USER_ROLES, undefined, session))
    )
      throw new Error('Insufficient permissions to update roles');
    const db = database(session);
    const role = await result(db.from('roles').select('id,is_system_role').eq('id', id).single());
    if (role.is_system_role) throw new Error('Cannot modify system roles');
    const allowed = Object.fromEntries(
      Object.entries(input).filter(([k]) =>
        ['name', 'description', 'permissions', 'department_id', 'hierarchy_level'].includes(k),
      ),
    );
    return result(db.from('roles').update(allowed).eq('id', id).select().single());
  },
};
module.exports = { roleManagementService };
