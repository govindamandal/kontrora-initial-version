import { NextRequest, NextResponse } from 'next/server';
import {
  estimateContext,
  estimateFailure,
  EstimateError,
  jsonBody,
  readEstimate,
} from '@/lib/estimates/api';
import { estimateUpdateSchema, uuid } from '@/lib/estimates/domain';
type Context = { params: Promise<{ accountId: string; estimateId: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { accountId, estimateId } = await params;
    const db = await estimateContext(request, accountId);
    return NextResponse.json({ estimate: await readEstimate(db, accountId, estimateId) });
  } catch (error) {
    return estimateFailure(error);
  }
}
export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const { accountId, estimateId } = await params;
    const db = await estimateContext(request, accountId, true);
    if (!uuid.safeParse(estimateId).success) throw new EstimateError('Invalid estimate ID');
    const parsed = estimateUpdateSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new EstimateError(parsed.error.issues[0].message);
    const { version, ...change } = parsed.data;
    const payload = 'content' in change ? change.content : change;
    const { error } = await db.rpc('kontrora_save_estimate', {
      p_account: accountId,
      p_payload: payload,
      p_id: estimateId,
      p_version: version,
    });
    if (error) throw error;
    return NextResponse.json({ estimate: await readEstimate(db, accountId, estimateId) });
  } catch (error) {
    return estimateFailure(error);
  }
}
