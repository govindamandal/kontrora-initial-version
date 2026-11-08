'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AppLayout } from '@/components/app-layout';
import { useAuth } from '@/lib/hooks/useAuth';
import { apiFetch } from '@/lib/api-config';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

type Details = {
  project: { name: string; description: string | null; status: string };
  updates: { id: string; content: string; created_at: string }[];
};
export default function ClientProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [score, setScore] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    async function load() {
      try {
        const r = await apiFetch(`/api/client/portal/projects/${id}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load this project');
        if (active) setDetails(d);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load this project');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [id, user?.id]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(`/api/client/portal/projects/${id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          project_id: id,
          satisfaction_score: Number(score),
          what_went_well: feedback,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not submit feedback');
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit feedback');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppLayout>
      <main className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <Link className="text-sm underline" href="/client-portal">
          Back to your projects
        </Link>
        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        {!details ? (
          !error && <p>Loading project…</p>
        ) : (
          <>
            <section className="space-y-2">
              <h1 className="text-2xl font-semibold">{details.project.name}</h1>
              <p>{details.project.description}</p>
              <p className="capitalize text-muted-foreground">
                {details.project.status.replaceAll('_', ' ')}
              </p>
            </section>
            <section className="space-y-3">
              <h2 className="font-semibold">Project updates</h2>
              {details.updates?.length ? (
                details.updates.map((u) => (
                  <article className="rounded-lg border p-4" key={u.id}>
                    <p>{u.content}</p>
                    <time className="text-sm text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </time>
                  </article>
                ))
              ) : (
                <p className="text-muted-foreground">No updates yet.</p>
              )}
            </section>
            <form className="space-y-3 rounded-lg border p-4" onSubmit={submit}>
              <h2 className="font-semibold">Share feedback</h2>
              {sent ? (
                <p role="status">Thank you. Your feedback has been submitted.</p>
              ) : (
                <>
                  <Label htmlFor="client-score">Satisfaction (1–10)</Label>
                  <Input
                    id="client-score"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={score}
                    onChange={(e) => setScore(e.target.value)}
                    required
                  />
                  <Label htmlFor="client-feedback">What went well?</Label>
                  <textarea
                    id="client-feedback"
                    className="min-h-24 w-full rounded-md border bg-background p-3"
                    maxLength={2000}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                  <Button disabled={busy}>Submit feedback</Button>
                </>
              )}
            </form>
          </>
        )}
      </main>
    </AppLayout>
  );
}
