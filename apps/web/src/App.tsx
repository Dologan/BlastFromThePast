import { useCallback, useEffect, useState } from 'react';
import { api, type LibrarySummary, type Settings, type SyncStatus } from './api';

function formatDate(uts: number | null): string {
  if (!uts) return '—';
  return new Date(uts * 1000).toLocaleDateString();
}

function SettingsPanel({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [username, setUsername] = useState(settings.lastfmUsername ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.saveSettings({ lastfmUsername: username, lastfmApiKey: apiKey || undefined });
      setApiKey('');
      setMessage('Saved.');
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel">
      <h2>Connections</h2>
      <label>
        Last.fm username
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="your-username" />
      </label>
      <label>
        Last.fm API key {settings.lastfmApiKeySet && <span className="hint">(saved — leave blank to keep)</span>}
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={settings.lastfmApiKeySet ? '••••••••' : 'get one at last.fm/api'}
        />
      </label>
      <button onClick={save} disabled={saving || !username}>
        Save
      </button>
      {message && <p className="hint">{message}</p>}
    </section>
  );
}

function SyncPanel({ status, onStart }: { status: SyncStatus | null; onStart: () => void }) {
  const progress = status?.progress;
  return (
    <section className="panel">
      <h2>Sync</h2>
      <button onClick={onStart} disabled={status?.running ?? false}>
        {status?.running ? 'Syncing…' : 'Sync Last.fm now'}
      </button>
      {status?.running && progress && (
        <p>
          {progress.phase === 'scrobbles' && progress.totalPages
            ? `Scrobbles: page ${progress.page} of ${progress.totalPages} — ${progress.inserted} new`
            : progress.phase === 'loved'
              ? `Loved tracks: page ${progress.page ?? 1}`
              : 'Rebuilding stats…'}
        </p>
      )}
      {status?.error && <p className="error">Last sync failed: {status.error}</p>}
      <ul className="sources">
        {status?.sources.map((s) => (
          <li key={s.source}>
            <code>{s.source}</code> — {s.status}
            {s.lastSyncedAt ? `, last synced ${new Date(s.lastSyncedAt * 1000).toLocaleString()}` : ''}
            {s.error ? ` (${s.error})` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LibraryPanel({ summary }: { summary: LibrarySummary | null }) {
  if (!summary) return null;
  return (
    <section className="panel">
      <h2>Library</h2>
      <div className="stats">
        <div>
          <strong>{summary.scrobbles.toLocaleString()}</strong> scrobbles
        </div>
        <div>
          <strong>{summary.tracks.toLocaleString()}</strong> tracks
        </div>
        <div>
          <strong>{summary.albums.toLocaleString()}</strong> albums
        </div>
        <div>
          <strong>{summary.artists.toLocaleString()}</strong> artists
        </div>
        <div>
          <strong>{summary.liked.toLocaleString()}</strong> loved/liked
        </div>
        <div>
          {formatDate(summary.firstScrobble)} → {formatDate(summary.lastScrobble)}
        </div>
      </div>
      {summary.topArtists.length > 0 && (
        <>
          <h3>Top artists</h3>
          <ol>
            {summary.topArtists.map((a) => (
              <li key={a.name}>
                {a.name} <span className="hint">({a.playcount.toLocaleString()})</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [st, sum] = await Promise.all([api.getSyncStatus(), api.getLibrarySummary()]);
      setStatus(st);
      setSummary(sum);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((err) => setError(String(err)));
    void refresh();
  }, [refresh]);

  // Poll while a sync is running (and once more after it stops).
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [status?.running, refresh]);

  const startSync = async () => {
    try {
      await api.startLastfmSync();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main>
      <h1>Blast From The Past</h1>
      <p className="tagline">Rediscover your music from your Last.fm history.</p>
      {error && <p className="error">{error}</p>}
      {settings && (
        <SettingsPanel settings={settings} onSaved={() => api.getSettings().then(setSettings)} />
      )}
      <SyncPanel status={status} onStart={startSync} />
      <LibraryPanel summary={summary} />
    </main>
  );
}
