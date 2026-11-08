'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/hooks/useAuth';
import { apiFetch } from '@/lib/api-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Entry = {
  id: string;
  entry_date: string;
  hours_logged: number;
  description: string | null;
  project?: { name: string };
};
type Project = { id: string; name: string };
export default function TimeEntriesPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [hours, setHours] = useState('');
  const [description, setDescription] = useState('');
  const [clockedIn, setClockedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [timeResponse, projectResponse, clockResponse] = await Promise.all([
        apiFetch('/api/time-entries'),
        apiFetch('/api/projects'),
        apiFetch('/api/clock'),
      ]);
      const [timeData, projectData, clockData] = await Promise.all([
        timeResponse.json(),
        projectResponse.json(),
        clockResponse.json(),
      ]);
      if (!timeResponse.ok) throw new Error(timeData.error || 'Could not load time entries');
      if (!clockResponse.ok) throw new Error(clockData.error || 'Could not load clock status');
      setEntries(timeData.timeEntries || []);
      setProjects(projectResponse.ok ? projectData.projects || [] : []);
      setClockedIn(clockData.isClockedIn === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load time entries');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(path: string, body: object = {}) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save');
      setNotice(data.message || 'Time entry saved');
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      await action('/api/time-entries', {
        projectId,
        hoursLogged: Number(hours),
        entryDate: date,
        description,
      })
    ) {
      setHours('');
      setDescription('');
    }
  }
  return (
    <>
      <main className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-semibold">Time Entries</h1>
          <p className="text-sm text-muted-foreground">Review and log your own project time.</p>
        </div>
        {error && (
          <p role="alert" className="rounded border border-red-400/30 p-3 text-red-400">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded border p-3">
            {notice}
          </p>
        )}
        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          aria-label="Clock"
        >
          <p>{clockedIn ? 'You are currently clocked in.' : 'You are currently clocked out.'}</p>
          {clockedIn ? (
            <Button disabled={busy} variant="outline" onClick={() => action('/api/clock/discard')}>
              Stop clock without logging time
            </Button>
          ) : (
            <Button disabled={busy || loading} onClick={() => action('/api/clock')}>
              Clock in
            </Button>
          )}
        </section>
        <form onSubmit={save} className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
          <h2 className="font-medium sm:col-span-2">Log time</h2>
          <div className="space-y-2">
            <Label htmlFor="time-project">Project</Label>
            <select
              id="time-project"
              required
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-md border bg-background p-2"
            >
              <option value="">Select a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="time-date">Date</Label>
            <Input
              id="time-date"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="time-hours">Hours</Label>
            <Input
              id="time-hours"
              type="number"
              min="0.01"
              max="24"
              step="0.01"
              required
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="time-description">Description</Label>
            <Input
              id="time-description"
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Button className="sm:col-span-2" disabled={busy || loading || !projects.length}>
            Save time entry
          </Button>
        </form>
        <section className="overflow-x-auto rounded-lg border" aria-label="Your time entries">
          {loading ? (
            <p className="p-4">Loading time entries…</p>
          ) : !entries.length ? (
            <p className="p-4 text-muted-foreground">No time entries yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-3">Date</th>
                  <th className="p-3">Project</th>
                  <th className="p-3">Hours</th>
                  <th className="p-3">Description</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="p-3">{e.entry_date}</td>
                    <td className="p-3">{e.project?.name || 'Project unavailable'}</td>
                    <td className="p-3">{Number(e.hours_logged).toFixed(2)}</td>
                    <td className="p-3">{e.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
