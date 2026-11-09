import { NextRequest, NextResponse } from 'next/server';
import {
  estimateContext,
  estimateColumns,
  estimateFailure,
  EstimateError,
  jsonBody,
  readEstimate,
} from '@/lib/estimates/api';
import { estimateContentSchema, estimateStatuses } from '@/lib/estimates/domain';
type Context = { params: Promise<{ accountId: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { accountId } = await params;
    const db = await estimateContext(request, accountId);
    const url = request.nextUrl;
    const status = url.searchParams.get('status') || '';
    const search = url.searchParams.get('search') || '';
    const rawPage = url.searchParams.get('page') || '1';
    if (
      (status && !estimateStatuses.includes(status as (typeof estimateStatuses)[number])) ||
      !/^[1-9]\d{0,3}$/.test(rawPage) ||
      search.length > 100
    )
      throw new EstimateError('Invalid list filters');
    const page = Number(rawPage),
      pageSize = 10;
    let query = db
      .from('estimates')
      .select(estimateColumns, { count: 'exact' })
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .order('id');
    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('title', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    const [manage, projects, account] = await Promise.all([
      db.rpc('kontrora_finance_access', { p_account: accountId, p_write: true }),
      db.from('projects').select('id,name').eq('account_id', accountId).order('name'),
      db.from('accounts').select('name').eq('id', accountId).single(),
    ]);
    if (manage.error || projects.error || account.error)
      throw manage.error || projects.error || account.error;
    return NextResponse.json({
      estimates: data,
      count,
      page,
      pageSize,
      canManage: !!manage.data,
      projects: projects.data,
      account: account.data,
    });
  } catch (error) {
    return estimateFailure(error);
  }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { accountId } = await params;
    const db = await estimateContext(request, accountId, true);
    const key = request.headers.get('Idempotency-Key');
    if (!key || !/^[\x21-\x7E]{8,128}$/.test(key))
      throw new EstimateError('Provide an Idempotency-Key of 8–128 printable characters');
    const parsed = estimateContentSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new EstimateError(parsed.error.issues[0].message);
    const { data, error } = await db.rpc('kontrora_save_estimate', {
      p_account: accountId,
      p_payload: parsed.data,
      p_key: key,
    });
    if (error) throw error;
    const estimate = await readEstimate(db, accountId, data.id);
    return NextResponse.json(
      { estimate, replayed: data.replayed },
      {
        status: data.replayed ? 200 : 201,
        headers: {
          'Idempotency-Replayed': String(data.replayed),
          Location: `/api/accounts/${accountId}/estimates/${data.id}`,
        },
      },
    );
  } catch (error) {
    return estimateFailure(error);
  }
}
