const { NextResponse } = require('next/server');
const { createApiSupabaseClient, getUserProfileFromRequest } = require('@/lib/supabase-server');
const { getUserPipelineProjects } = require('@/lib/workflow-execution-service');
const { checkPermissionHybrid } = require('@/lib/permission-checker');
const { Permission } = require('@/lib/permissions');
const { logger } = require('@/lib/debug-logger');

async function GET(request) {
  try {
    const db = createApiSupabaseClient(request);
    if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    const profile = await getUserProfileFromRequest(db);
    if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await checkPermissionHybrid(profile, Permission.EXECUTE_WORKFLOWS, undefined, db))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const projects = await getUserPipelineProjects(db, profile.id, profile.is_superadmin === true);
    return NextResponse.json({ success: true, projects });
  } catch (error) {
    logger.error('Failed to fetch pipeline projects', {}, error);
    return NextResponse.json({ error: 'Failed to fetch pipeline projects' }, { status: 500 });
  }
}
exports.GET = GET;
