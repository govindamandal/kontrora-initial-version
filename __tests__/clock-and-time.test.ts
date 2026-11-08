import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { uuidSchema } from '../lib/validation-schemas';

function load(path: string, dependencies: Record<string, unknown>) {
  const sandboxModule = { exports: {} as any };
  vm.runInNewContext(readFileSync(path, 'utf8'), {
    URL,
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(name);
      return dependencies[name];
    },
  });
  return sandboxModule.exports;
}
const logger = { error: vi.fn(), warn: vi.fn() };
describe('clock schema and server-side time entries', () => {
  it('loads the active clock using end_time and preserves the UI response contract', async () => {
    const session = { id: 'clock', start_time: '2026-01-01T09:00:00Z', end_time: null };
    const is = vi.fn().mockReturnValue({ single: async () => ({ data: session, error: null }) });
    const db = { from: () => ({ select: () => ({ eq: () => ({ is }) }) }) };
    const route = load('app/api/clock/route.js', {
      'next/server': { NextResponse },
      '@/lib/supabase-server': {
        createApiSupabaseClient: () => db,
        getUserProfileFromRequest: async () => ({ id: 'user' }),
      },
      '@/lib/permission-checker': {},
      '@/lib/permissions': {},
      '@/lib/debug-logger': { logger },
    });
    // Keep the clock within the 16-hour stale-session window.
    session.start_time = new Date().toISOString();
    const response = await route.GET(new NextRequest('http://localhost/api/clock'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(is).toHaveBeenCalledWith('end_time', null);
    expect(body.isClockedIn).toBe(true);
    expect(body.session.clock_in_time).toBe(session.start_time);
  });
  it('returns clocked out for an empty clock table', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({ single: async () => ({ data: null, error: { code: 'PGRST116' } }) }),
          }),
        }),
      }),
    };
    const route = load('app/api/clock/route.js', {
      'next/server': { NextResponse },
      '@/lib/supabase-server': {
        createApiSupabaseClient: () => db,
        getUserProfileFromRequest: async () => ({ id: 'user' }),
      },
      '@/lib/permission-checker': {},
      '@/lib/permissions': {},
      '@/lib/debug-logger': { logger },
    });
    const response = await route.GET(new NextRequest('http://localhost/api/clock'));
    expect(response.status).toBe(200);
    expect((await response.json()).isClockedIn).toBe(false);
  });
  it('uses the supplied authenticated database instead of silently returning empty server results', async () => {
    const browserClient = vi.fn(() => {
      throw new Error('Browser-only client used on the server');
    });
    const rows = [{ id: 'entry', hours_logged: 2 }];
    const order = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn().mockReturnValue({ order });
    const db = { from: vi.fn().mockReturnValue({ select: () => ({ eq }) }) };
    const { timeEntryService } = load('lib/services/time-entry-service.js', {
      '../supabase': { createClientSupabase: browserClient },
      '../debug-logger': { logger },
    });
    expect(await timeEntryService.getUserTimeEntries('user', undefined, undefined, db)).toEqual(
      rows,
    );
    expect(eq).toHaveBeenCalledWith('user_id', 'user');
    expect(browserClient).not.toHaveBeenCalled();
  });
});

describe('time entry project boundaries', () => {
  function timeRoute(db: object, access: boolean) {
    return load('app/api/time-entries/route.js', {
      'next/server': { NextResponse },
      zod: { z },
      '@/lib/validation-schemas': { uuidSchema },
      '@/lib/supabase-server': {
        createApiSupabaseClient: () => db,
        getUserProfileFromRequest: async () => ({ id: 'user' }),
      },
      '@/lib/services/time-entry-service': {
        timeEntryService: {
          getProjectTimeEntries: () => {
            throw new Error('Unauthorized read');
          },
        },
      },
      '@/lib/rbac': { userHasProjectAccess: async () => access },
      '@/lib/permission-checker': { hasPermission: async () => true },
      '@/lib/permissions': { Permission: {} },
      '@/lib/api-demo-guard': {},
      '@/lib/debug-logger': { logger },
    });
  }
  it('rejects reading another project before loading time entries', async () => {
    const response = await timeRoute({}, false).GET(
      new NextRequest('http://localhost/api/time-entries?projectId=foreign'),
    );
    expect(response.status).toBe(403);
  });
  it('rejects a task from a different project before inserting time', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ single: async () => ({ data: { project_id: 'foreign' } }) }),
        }),
      }),
    };
    const response = await timeRoute(db, true).POST(
      new NextRequest('http://localhost/api/time-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
          taskId: 'cccccccc-dddd-eeee-ffff-000000000001',
          hoursLogged: 1,
          entryDate: '2026-11-08',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('does not belong');
  });
});
