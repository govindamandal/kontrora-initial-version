import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient } from '@/lib/supabase-server';
import { uuid } from './domain';

export class EstimateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function estimateContext(request: NextRequest, accountId: string, write = false) {
  if (!uuid.safeParse(accountId).success) throw new EstimateError('Invalid account ID');
  const db = createApiSupabaseClient(request);
  if (!db) throw new EstimateError('Database unavailable', 503);
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new EstimateError('Please sign in', 401);
  const access = await db.rpc('kontrora_finance_access', { p_account: accountId, p_write: write });
  if (access.error) throw access.error;
  // Use the same response for inaccessible and absent accounts.
  if (!access.data) throw new EstimateError('Account not found or financial access denied', 404);
  return db;
}
export const estimateColumns =
  'id,account_id,project_id,title,currency,status,notes,total_minor,version,created_by,created_at,updated_at,sent_at,decided_at';
export async function readEstimate(
  db: NonNullable<ReturnType<typeof createApiSupabaseClient>>,
  accountId: string,
  id: string,
) {
  if (!uuid.safeParse(id).success) throw new EstimateError('Invalid estimate ID');
  const { data, error } = await db
    .from('estimates')
    .select(`${estimateColumns},estimate_line_items(*),estimate_events(*)`)
    .is('estimate_line_items.archived_at', null)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new EstimateError('Estimate not found', 404);
  data.estimate_line_items = data.estimate_line_items.filter(
    (item: { archived_at: string | null }) => item.archived_at === null,
  );
  data.estimate_line_items.sort(
    (a: { position: number }, b: { position: number }) => a.position - b.position,
  );
  data.estimate_events.sort(
    (a: { version: number }, b: { version: number }) => a.version - b.version,
  );
  return data;
}
export function estimateFailure(error: unknown) {
  if (error instanceof EstimateError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  const dbError = error as { code?: string; message?: string };
  const codes: Record<string, number> = {
    '42501': 403,
    P0002: 404,
    '23505': 409,
    '40001': 409,
    '22023': 400,
    '22P02': 400,
    '23514': 400,
    '22003': 400,
  };
  const status = codes[dbError.code || ''];
  if (status)
    return NextResponse.json({ error: dbError.message || 'Invalid estimate request' }, { status });
  console.error('Estimates request failed', dbError.code || 'unknown');
  return NextResponse.json(
    { error: 'Estimates are temporarily unavailable. Please try again.' },
    { status: 503 },
  );
}
export async function jsonBody(request: NextRequest) {
  // Bound payload size before parsing; line item schema adds precise limits.
  const text = await request.text();
  if (text.length > 65536) throw new EstimateError('Request too large', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new EstimateError('Invalid JSON');
  }
}
