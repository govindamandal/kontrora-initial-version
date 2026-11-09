import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  estimateContentSchema,
  estimateUpdateSchema,
  parseMoneyMinor,
} from '../lib/estimates/domain';
const account = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
const id = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';
const draft = {
  title: 'Discovery',
  currency: 'USD',
  notes: '',
  project_id: null,
  items: [{ description: 'Research', quantity: 3, unit_price_minor: 1999 }],
};
const { state, db } = vi.hoisted(() => {
  const state = {
    signedIn: true,
    access: true,
    write: true,
    replay: false,
    saveError: null as unknown,
    calls: [] as unknown[],
  };
  const row = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',
    estimate_line_items: [],
    estimate_events: [],
  };
  const chain: any = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'maybeSingle') return async () => ({ data: row, error: null });
        if (key === 'single') return async () => ({ data: { name: 'Account' }, error: null });
        if (key === 'then')
          return (resolve: (v: unknown) => void) => resolve({ data: [], count: 0, error: null });
        return (...args: unknown[]) => {
          state.calls.push([key, ...args]);
          return chain;
        };
      },
    },
  );
  const db = {
    auth: {
      getUser: async () => ({
        data: { user: state.signedIn ? { id: 'user' } : null },
        error: null,
      }),
    },
    rpc: vi.fn(async (name: string, args: any) => {
      state.calls.push([name, args]);
      return name === 'kontrora_finance_access'
        ? { data: args.p_write ? state.write : state.access, error: null }
        : { data: { id: row.id, replayed: state.replay }, error: state.saveError };
    }),
    from: vi.fn(() => chain),
  };
  return { state, db };
});
vi.mock('@/lib/supabase-server', () => ({ createApiSupabaseClient: () => db }));
import { POST, GET } from '../app/api/accounts/[accountId]/estimates/route';
import { PATCH, GET as getOne } from '../app/api/accounts/[accountId]/estimates/[estimateId]/route';
const ctx = { params: Promise.resolve({ accountId: account, estimateId: id }) };
function request(body: unknown, key = 'retry-key-123', method = 'POST') {
  return new NextRequest(`http://localhost/api/accounts/${account}/estimates`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  state.signedIn = true;
  state.access = true;
  state.write = true;
  state.replay = false;
  state.saveError = null;
  state.calls = [];
  vi.clearAllMocks();
});
describe('estimate money and content', () => {
  it('converts decimal prices without floating-point rounding', () => {
    expect(parseMoneyMinor('19.99')).toBe(1999);
    expect(parseMoneyMinor('0.10')).toBe(10);
    expect(parseMoneyMinor('1.5')).toBe(150);
  });
  it.each(['1.005', '-1', '1e3', '', 'NaN', '10000000.01'])(
    'rejects ambiguous/out-of-range price %s',
    (value) => expect(() => parseMoneyMinor(value)).toThrow(),
  );
  it('rejects client totals, fractional quantities, unsafe totals, and unsupported currencies', () => {
    expect(estimateContentSchema.safeParse({ ...draft, total_minor: 1 }).success).toBe(false);
    expect(
      estimateContentSchema.safeParse({ ...draft, items: [{ ...draft.items[0], quantity: 1.5 }] })
        .success,
    ).toBe(false);
    expect(
      estimateContentSchema.safeParse({
        ...draft,
        items: [{ ...draft.items[0], quantity: 10000, unit_price_minor: 1000000000 }],
      }).success,
    ).toBe(false);
    expect(estimateContentSchema.safeParse({ ...draft, currency: 'XYZ' }).success).toBe(false);
  });
  it('requires a version and separates edits from transitions', () => {
    expect(estimateUpdateSchema.safeParse({ status: 'sent' }).success).toBe(false);
    expect(
      estimateUpdateSchema.safeParse({ version: 1, status: 'sent', content: draft }).success,
    ).toBe(false);
  });
});
describe('estimate routes', () => {
  it('requires authentication and an account-specific editor grant before creation', async () => {
    state.signedIn = false;
    expect((await POST(request(draft), ctx)).status).toBe(401);
    state.signedIn = true;
    state.write = false;
    expect((await POST(request(draft), ctx)).status).toBe(404);
    expect(state.calls.some((c: any) => c[0] === 'kontrora_save_estimate')).toBe(false);
  });
  it('requires a retry key and rejects malformed input without writing', async () => {
    expect((await POST(request(draft, ''), ctx)).status).toBe(400);
    expect((await POST(request({ ...draft, account_id: account }), ctx)).status).toBe(400);
    expect(state.calls.some((c: any) => c[0] === 'kontrora_save_estimate')).toBe(false);
  });
  it('returns 201 on create and 200 with a replay header on retry', async () => {
    expect((await POST(request(draft), ctx)).status).toBe(201);
    state.replay = true;
    const replay = await POST(request(draft), ctx);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  });
  it('returns conflict on reused keys or concurrent edits', async () => {
    state.saveError = { code: '23505', message: 'Different content' };
    expect((await POST(request(draft), ctx)).status).toBe(409);
    state.saveError = { code: 'PT409', message: 'Reload' };
    expect((await PATCH(request({ version: 1, status: 'sent' }, '', 'PATCH'), ctx)).status).toBe(
      409,
    );
  });
  it('scopes get-by-id and filtering in the database and bounds pagination', async () => {
    expect((await getOne(new NextRequest('http://localhost'), ctx)).status).toBe(200);
    expect(state.calls).toContainEqual(['eq', 'account_id', account]);
    expect(state.calls).toContainEqual(['eq', 'id', id]);
    expect(
      (await GET(new NextRequest('http://localhost?status=draft&page=2&search=Discovery'), ctx))
        .status,
    ).toBe(200);
    expect(state.calls).toContainEqual(['eq', 'status', 'draft']);
    expect(state.calls).toContainEqual(['range', 10, 19]);
    expect((await GET(new NextRequest('http://localhost?page=-1'), ctx)).status).toBe(400);
  });
  it('denies viewers mutation and hides another account', async () => {
    state.write = false;
    expect(
      (await PATCH(request({ version: 1, status: 'accepted' }, '', 'PATCH'), ctx)).status,
    ).toBe(404);
    state.access = false;
    expect((await getOne(new NextRequest('http://localhost'), ctx)).status).toBe(404);
  });
});
