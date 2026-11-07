import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), cookieUser: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.cookieUser } }) }));
vi.mock('@/lib/debug-logger', () => ({ logger: { error: vi.fn() } }));
import { getUserFromRequest } from '../lib/supabase-server';

describe('API request authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'test-key');
    vi.stubEnv('SUPABASE_SERVER_URL', 'http://localhost:54321');
  });
  it('verifies bearer tokens with the auth server', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null });
    const user = await getUserFromRequest(new NextRequest('http://localhost/api/projects', { headers: { authorization: 'Bearer test-token' } }));
    expect(user?.id).toBe('verified-user');
    expect(mocks.getUser).toHaveBeenCalledWith('test-token');
    expect(mocks.cookieUser).not.toHaveBeenCalled();
  });
  it('rejects an invalid bearer without falling back to cookies', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid JWT' } });
    expect(await getUserFromRequest(new NextRequest('http://localhost/api/projects', { headers: { authorization: 'Bearer invalid' } }))).toBeNull();
    expect(mocks.cookieUser).not.toHaveBeenCalled();
  });
  it('rejects malformed authorization headers', async () => {
    expect(await getUserFromRequest(new NextRequest('http://localhost/api/projects', { headers: { authorization: 'Basic invalid' } }))).toBeNull();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it('supports existing cookie sessions', async () => {
    mocks.cookieUser.mockResolvedValue({ data: { user: { id: 'cookie-user' } }, error: null });
    expect((await getUserFromRequest(new NextRequest('http://localhost/api/projects')))?.id).toBe('cookie-user');
  });
  it('returns null for unauthenticated requests', async () => {
    mocks.cookieUser.mockResolvedValue({ data: { user: null }, error: { message: 'No session' } });
    expect(await getUserFromRequest(new NextRequest('http://localhost/api/projects'))).toBeNull();
  });
});
