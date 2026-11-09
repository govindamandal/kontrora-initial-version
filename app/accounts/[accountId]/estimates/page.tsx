'use client';
import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-config';
import { useAuth } from '@/lib/hooks/useAuth';
import {
  currencies,
  estimateContentSchema,
  estimateStatuses,
  formatMoney,
  parseMoneyMinor,
} from '@/lib/estimates/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Plus, ArrowLeft, FileText, Trash2 } from 'lucide-react';

type Item = { description: string; quantity: number; unit_price_minor: number; position: number };
type Estimate = {
  id: string;
  title: string;
  currency: string;
  status: string;
  notes: string;
  project_id: string | null;
  total_minor: number;
  version: number;
  created_at: string;
  estimate_line_items: Item[];
  estimate_events: {
    id: string;
    from_status: string | null;
    to_status: string;
    created_at: string;
    version: number;
  }[];
};
type EditItem = { description: string; quantity: string; price: string };
const emptyItem = (): EditItem => ({ description: '', quantity: '1', price: '0.00' });
const field =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60';
export default function EstimatesPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = use(params);
  const { user, loading: authLoading } = useAuth();
  const base = `/api/accounts/${accountId}/estimates`;
  const [rows, setRows] = useState<Estimate[]>([]);
  const [accountName, setAccountName] = useState('Account');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [status, setStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [selected, setSelected] = useState<Estimate | null>(null);
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [project, setProject] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<EditItem[]>([emptyItem()]);
  const [dirty, setDirty] = useState(false);
  const idempotency = useRef<{ signature: string; key: string } | null>(null);
  const locked = !canManage || (!!selected && selected.status !== 'draft');
  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page), status, search });
    apiFetch(`${base}?${query}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        if (!active) return;
        setRows(d.estimates);
        setCount(d.count);
        setProjects(d.projects);
        setAccountName(d.account.name);
        setCanManage(d.canManage);
      })
      .catch((e) => {
        if (active) setError(e.message || 'Could not load estimates');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, page, search, status, refresh, user, authLoading]);
  function showEstimate(e: Estimate | null) {
    setSelected(e);
    setTitle(e?.title || '');
    setCurrency(e?.currency || 'USD');
    setProject(e?.project_id || '');
    setNotes(e?.notes || '');
    setItems(
      e
        ? e.estimate_line_items.map((i) => ({
            description: i.description,
            quantity: String(i.quantity),
            price: (i.unit_price_minor / 100).toFixed(2),
          }))
        : [emptyItem()],
    );
    setDirty(false);
    setEditorOpen(true);
    idempotency.current = null;
  }
  async function openEstimate(id: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(`${base}/${id}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      showEstimate(d.estimate);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open estimate');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const content = estimateContentSchema.parse({
        title,
        currency,
        project_id: project || null,
        notes,
        items: items.map((i) => ({
          description: i.description,
          quantity: Number(i.quantity),
          unit_price_minor: parseMoneyMinor(i.price),
        })),
      });
      const signature = JSON.stringify(content);
      if (!idempotency.current || idempotency.current.signature !== signature)
        idempotency.current = { signature, key: crypto.randomUUID() };
      const r = await apiFetch(selected ? `${base}/${selected.id}` : base, {
        method: selected ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': idempotency.current.key },
        body: JSON.stringify(selected ? { version: selected.version, content } : content),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      showEstimate(d.estimate);
      setRefresh((v) => v + 1);
      setNotice('Draft saved. Review it before marking it as sent.');
    } catch (e) {
      setError(
        e instanceof Error && 'issues' in e
          ? 'Check the title and line items. Quantities must be whole numbers from 1 to 10,000.'
          : e instanceof Error
            ? e.message
            : 'Could not save estimate',
      );
    } finally {
      setBusy(false);
    }
  }
  async function transition(next: string) {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(`${base}/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: selected.version, status: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      showEstimate(d.estimate);
      setRefresh((v) => v + 1);
      setNotice(`Estimate marked as ${next}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update status');
    } finally {
      setBusy(false);
    }
  }
  function changeItem(index: number, key: keyof EditItem, value: string) {
    setItems((v) => v.map((i, n) => (n === index ? { ...i, [key]: value } : i)));
    setDirty(true);
  }
  let previewTotal: number | null = 0;
  try {
    previewTotal = items.reduce((sum, i) => sum + parseMoneyMinor(i.price) * Number(i.quantity), 0);
    if (!Number.isSafeInteger(previewTotal) || previewTotal < 0) previewTotal = null;
  } catch {
    previewTotal = null;
  }
  if (!authLoading && !user)
    return (
      <p>
        Please{' '}
        <Link className="underline" href="/login">
          sign in
        </Link>{' '}
        to view estimates.
      </p>
    );
  return (
    <div className="space-y-6 pb-12">
      <Link
        href={`/accounts/${accountId}`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to account
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{accountName} / Revenue</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Estimates</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Turn a scope of work into an estimate. Save a draft, send it, and record the decision.
          </p>
        </div>
        {canManage && (
          <Button
            disabled={busy}
            onClick={() => {
              showEstimate(null);
              setError('');
              setNotice('');
            }}
          >
            <Plus size={16} className="mr-2" />
            New estimate
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
          {error}
          <Button
            variant="outline"
            size="sm"
            className="ml-3"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Retry list
          </Button>
          {selected && (
            <Button
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={() => openEstimate(selected.id)}
            >
              Reload estimate
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account estimates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchInput);
              setPage(1);
            }}
          >
            <Input
              aria-label="Search estimates"
              placeholder="Search by title"
              maxLength={100}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="max-w-xs"
            />
            <select
              aria-label="Filter by status"
              className={`${field} max-w-40`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {estimateStatuses.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <Button variant="outline" type="submit">
              Search
            </Button>
          </form>
          {loading || authLoading ? (
            <p className="py-8 text-sm text-muted-foreground">Loading estimates…</p>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center">
              <FileText className="mx-auto mb-3 text-muted-foreground" />
              <p>No estimates found.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {canManage
                  ? 'Create a draft or adjust your filters.'
                  : 'Estimates shared with your finance role will appear here.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-3">Estimate</th>
                    <th className="px-3">Status</th>
                    <th className="px-3 text-right">Total</th>
                    <th className="pl-3 text-right">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="py-4">
                        <button
                          disabled={busy}
                          onClick={() => openEstimate(e.id)}
                          className="text-left font-medium hover:underline"
                        >
                          {e.title}
                        </button>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {e.id.slice(0, 8).toUpperCase()}
                        </p>
                      </td>
                      <td className="px-3">
                        <Badge variant="outline" className="capitalize">
                          {e.status}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 text-right tabular-nums">
                        {formatMoney(e.total_minor, e.currency)}
                      </td>
                      <td className="whitespace-nowrap pl-3 text-right text-muted-foreground">
                        {new Date(e.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {count} estimate{count !== 1 ? 's' : ''} · Page {page}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * 10 >= count || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {editorOpen && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{selected ? selected.title : 'New draft estimate'}</CardTitle>
              <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={busy}>
                Close
              </Button>
            </div>
            {selected && (
              <p className="text-sm text-muted-foreground">
                {selected.id.slice(0, 8).toUpperCase()} · Version {selected.version} ·{' '}
                <span className="capitalize">{selected.status}</span>
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-5">
            {selected && selected.status !== 'draft' && (
              <p className="rounded-md bg-muted p-3 text-sm">
                This estimate is locked. Sent estimates can only be accepted or rejected; final
                decisions are retained.
              </p>
            )}
            <fieldset disabled={locked || busy} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm">
                  Title
                  <Input
                    value={title}
                    maxLength={160}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="e.g. Website redesign — phase 1"
                  />
                </label>
                <label className="space-y-2 text-sm">
                  Project (optional)
                  <select
                    className={field}
                    value={project}
                    onChange={(e) => {
                      setProject(e.target.value);
                      setDirty(true);
                    }}
                  >
                    <option value="">Account only</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block max-w-48 space-y-2 text-sm">
                Currency
                <select
                  className={field}
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setDirty(true);
                  }}
                >
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="space-y-3">
                <h3 className="font-medium">Line items</h3>
                {items.map((item, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-12 items-end gap-3 rounded-lg border p-3"
                  >
                    <label className="col-span-12 space-y-2 text-sm sm:col-span-5">
                      Description {index + 1}
                      <Input
                        maxLength={300}
                        value={item.description}
                        onChange={(e) => changeItem(index, 'description', e.target.value)}
                        placeholder="Work or deliverable"
                      />
                    </label>
                    <label className="col-span-4 space-y-2 text-sm sm:col-span-2">
                      Quantity
                      <Input
                        type="number"
                        min="1"
                        max="10000"
                        step="1"
                        value={item.quantity}
                        onChange={(e) => changeItem(index, 'quantity', e.target.value)}
                      />
                    </label>
                    <label className="col-span-5 space-y-2 text-sm sm:col-span-3">
                      Unit price ({currency})
                      <Input
                        inputMode="decimal"
                        value={item.price}
                        onChange={(e) => changeItem(index, 'price', e.target.value)}
                      />
                    </label>
                    <div className="col-span-3 text-right sm:col-span-2">
                      <Button
                        aria-label={`Remove line ${index + 1}`}
                        variant="ghost"
                        size="icon"
                        disabled={locked || busy || items.length === 1}
                        onClick={() => {
                          setItems((v) => v.filter((_, n) => n !== index));
                          setDirty(true);
                        }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                ))}
                {!locked && (
                  <Button
                    variant="outline"
                    disabled={items.length >= 50}
                    onClick={() => {
                      setItems((v) => [...v, emptyItem()]);
                      setDirty(true);
                    }}
                  >
                    Add line item
                  </Button>
                )}
              </div>
              <label className="block space-y-2 text-sm">
                Notes
                <textarea
                  className={field}
                  rows={3}
                  maxLength={4000}
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Scope, assumptions, and terms"
                />
              </label>
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Estimate total
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {previewTotal === null ? 'Check line items' : formatMoney(previewTotal, currency)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!locked && (
                  <Button disabled={busy} onClick={save}>
                    {busy ? 'Saving…' : 'Save draft'}
                  </Button>
                )}
                {canManage && selected?.status === 'draft' && (
                  <Button
                    variant="outline"
                    disabled={busy || dirty}
                    onClick={() => transition('sent')}
                  >
                    Mark as sent
                  </Button>
                )}
                {canManage && selected?.status === 'sent' && (
                  <>
                    <Button disabled={busy} onClick={() => transition('accepted')}>
                      Record acceptance
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => transition('rejected')}
                    >
                      Record rejection
                    </Button>
                  </>
                )}
              </div>
            </div>
            {canManage && selected?.status === 'draft' && dirty && (
              <p className="text-sm text-muted-foreground">
                Save your changes before marking this estimate as sent.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Status changes record your team’s actions. Email delivery, electronic signatures,
              taxes, and payments are not included.
            </p>
            {selected && (
              <div className="border-t pt-4">
                <h3 className="mb-3 text-sm font-medium">Activity</h3>
                <ol className="space-y-2 text-sm text-muted-foreground">
                  {selected.estimate_events.map((e) => (
                    <li key={e.id}>
                      Version {e.version}:{' '}
                      {e.from_status ? `${e.from_status} → ${e.to_status}` : 'Draft created'} ·{' '}
                      {new Date(e.created_at).toLocaleString()}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
