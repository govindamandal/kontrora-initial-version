import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createProjectSchema, validateRequestBody } from '../lib/validation-schemas';

const user = { id: '11111111-1111-1111-1111-000000000001' };
const accountId = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
let authenticate: ReturnType<typeof vi.fn>;
let permit: ReturnType<typeof vi.fn>;
let insertProject: ReturnType<typeof vi.fn>;
let insertAssignment: ReturnType<typeof vi.fn>;
let post: (request: NextRequest) => Promise<Response>;
beforeEach(() => {
  authenticate = vi.fn().mockResolvedValue(user);
  permit = vi.fn().mockResolvedValue(true);
  insertProject = vi.fn((value) => ({ select: () => ({ single: async () => ({ data: { id: 'new-project', ...value }, error: null }) }) }));
  insertAssignment = vi.fn().mockResolvedValue({ error: null });
  const admin = { from: (table: string) => {
    if (table === 'user_profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: user, error: null }) }) }) };
    if (table === 'projects') return { insert: insertProject };
    if (table === 'project_assignments') return { insert: insertAssignment };
    throw new Error('Unexpected table');
  } };
  const deps = {
    'next/server': { NextRequest, NextResponse },
    '@/lib/supabase-server': { getUserFromRequest: authenticate, createAdminSupabaseClient: () => admin },
    '@/lib/rbac': { hasPermission: permit, isSuperadmin: () => true },
    '@/lib/permissions': { Permission: { MANAGE_PROJECTS: 'manage_projects' } },
    '@/lib/validation-schemas': { createProjectSchema, validateRequestBody },
    '@/lib/debug-logger': { logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } },
    '@/lib/config': { config: { errors: { exposeDetails: true } } },
  };
  const sandboxModule = { exports: {} as any };
  vm.runInNewContext(readFileSync('app/api/projects/route.js', 'utf8'), {
    module: sandboxModule, exports: sandboxModule.exports,
    require: (name: string) => { if (!(name in deps)) throw new Error(name); return deps[name]; },
  });
  post = sandboxModule.exports.POST;
});
function request(body: object) { return new NextRequest('http://localhost/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

describe('project creation route', () => {
  it('creates the project with estimated hours and creator membership', async () => {
    const response = await post(request({ name: 'New project', accountId, estimated_hours: 8 }));
    expect(response.status).toBe(201);
    expect(insertProject).toHaveBeenCalledWith(expect.objectContaining({ estimated_hours: 8, account_id: accountId, created_by: user.id }));
    expect(insertAssignment).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'new-project', user_id: user.id }));
    expect(insertAssignment.mock.calls[0][0]).not.toHaveProperty('source_type');
  });
  it('rejects unauthenticated creation without writing', async () => {
    authenticate.mockResolvedValue(null);
    expect((await post(request({ name: 'New project', accountId }))).status).toBe(401);
    expect(insertProject).not.toHaveBeenCalled();
  });
  it('rejects users without account project permission', async () => {
    permit.mockResolvedValue(false);
    expect((await post(request({ name: 'New project', accountId }))).status).toBe(403);
    expect(permit).toHaveBeenCalledWith(user, 'manage_projects', { accountId }, expect.anything());
    expect(insertProject).not.toHaveBeenCalled();
  });
  it('rejects invalid estimated hours before writing', async () => {
    expect((await post(request({ name: 'New project', accountId, estimated_hours: -1 }))).status).toBe(400);
    expect(insertProject).not.toHaveBeenCalled();
  });
});
