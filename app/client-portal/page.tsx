'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/app-layout';
import { useAuth } from '@/lib/hooks/useAuth';
import { apiFetch } from '@/lib/api-config';

type Project = { id: string; name: string; description: string | null; status: string };
export default function ClientPortalPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    async function load() {
      try {
        const response = await apiFetch('/api/client/portal/projects');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load your projects');
        if (active) setProjects(data.projects || []);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load your projects');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [user?.id]);
  return (
    <AppLayout>
      <main className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-semibold">Client Portal</h1>
          <p className="text-muted-foreground">Updates and delivery progress for your account.</p>
        </div>
        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        {loading ? (
          <p>Loading projects…</p>
        ) : !error && !projects.length ? (
          <p>No projects have been shared with your account yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/client-portal/projects/${p.id}`}
                className="space-y-2 rounded-lg border p-5 hover:bg-muted"
              >
                <h2 className="font-semibold">{p.name}</h2>
                <p className="text-sm text-muted-foreground">{p.description}</p>
                <p className="text-sm capitalize">{p.status.replaceAll('_', ' ')}</p>
              </Link>
            ))}
          </div>
        )}
      </main>
    </AppLayout>
  );
}
