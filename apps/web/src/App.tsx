import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuthStatus,
  type Insights,
  type InsightKind,
  type LibrarySummary,
  type ServiceName,
  type Settings,
  type SyncStatus,
} from './api';
import RecipeBuilder from './RecipeBuilder';
import { countryName } from './countries';

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

function progressText(status: SyncStatus): string | null {
  const p = status.progress;
  if (!status.running || !p) return null;
  if ('kind' in p && p.kind === 'enrich') {
    if (p.phase === 'fetch') {
      return `Fetching metadata — MusicBrainz ${p.mbProcessed}/${p.mbTotal}, Last.fm ${p.lastfmProcessed}/${p.lastfmTotal}`;
    }
    return `Applying to library — ${p.processed} of ${p.total} artists`;
  }
  if ('kind' in p && p.kind === 'spotify-liked') {
    return `Importing Spotify liked — ${p.linked} matched of ${p.seen} seen`;
  }
  if ('kind' in p && p.kind === 'push') {
    return `Building playlist — matched ${p.matched} of ${p.processed}/${p.total}`;
  }
  if ('phase' in p) {
    if (p.phase === 'scrobbles' && p.totalPages)
      return `Scrobbles: page ${p.page} of ${p.totalPages} — ${p.inserted} new`;
    if (p.phase === 'loved') return `Loved tracks: page ${p.page ?? 1}`;
    return 'Rebuilding stats…';
  }
  return null;
}

function ConnectionsPanel({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [spotifyId, setSpotifyId] = useState(settings.spotifyClientId ?? '');
  const [tidalId, setTidalId] = useState(settings.tidalClientId ?? '');
  const [country, setCountry] = useState(settings.tidalCountryCode ?? 'US');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => api.getAuthStatus().then(setAuth).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    // Surface the OAuth callback outcome (redirected here as ?connect=…).
    const p = new URLSearchParams(window.location.search);
    if (p.get('connect')) {
      setMsg(p.get('ok') ? `Connected ${p.get('connect')}.` : `Connection failed: ${p.get('error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [refresh]);

  const saveIds = async () => {
    await api.saveSettings({ spotifyClientId: spotifyId, tidalClientId: tidalId, tidalCountryCode: country });
    onSaved();
    setMsg('Saved.');
  };

  const connect = async (service: ServiceName) => {
    try {
      const { url } = await api.startAuth(service);
      window.location.href = url; // hand off to the provider's consent page
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const disconnect = async (service: ServiceName) => {
    await api.disconnect(service);
    await refresh();
  };

  const row = (service: ServiceName, connected: boolean, clientIdSet: boolean) => (
    <div className="conn-row">
      <span className="conn-name">{service === 'spotify' ? 'Spotify' : 'TIDAL'}</span>
      <span className={connected ? 'badge on' : 'badge'}>{connected ? 'connected' : 'not connected'}</span>
      {connected ? (
        <button className="secondary" onClick={() => disconnect(service)}>
          Disconnect
        </button>
      ) : (
        <button onClick={() => connect(service)} disabled={!clientIdSet} title={clientIdSet ? '' : 'Enter a client ID first'}>
          Connect
        </button>
      )}
    </div>
  );

  return (
    <section className="panel">
      <h2>Streaming services</h2>
      <div className="conns">
        {auth && row('spotify', auth.spotify.connected, auth.spotify.clientIdSet)}
        {auth && row('tidal', auth.tidal.connected, auth.tidal.clientIdSet)}
      </div>
      <label>
        TIDAL country code
        <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US" style={{ maxWidth: '6rem' }} />
      </label>
      {msg && <p className="hint">{msg}</p>}
      <details className="advanced">
        <summary>Advanced: use your own developer apps</summary>
        <p className="hint">
          The app ships with built-in client IDs, so connecting just works. To use your own developer app
          instead, paste its client ID (leave blank to use the built-in one). Redirect URI to register:{' '}
          <code>{window.location.origin}/api/auth/&lt;service&gt;/callback</code>
        </p>
        <label>
          Spotify client ID override
          <input value={spotifyId} onChange={(e) => setSpotifyId(e.target.value)} placeholder="built-in" />
        </label>
        <label>
          TIDAL client ID override
          <input value={tidalId} onChange={(e) => setTidalId(e.target.value)} placeholder="built-in" />
        </label>
      </details>
      <button onClick={saveIds}>Save</button>
    </section>
  );
}

function SyncPanel({
  status,
  onSync,
  onEnrich,
  onReprocess,
  onImportLiked,
  pendingEnrich,
  hasCache,
  spotifyConnected,
}: {
  status: SyncStatus | null;
  onSync: () => void;
  onEnrich: () => void;
  onReprocess: () => void;
  onImportLiked: () => void;
  pendingEnrich: number;
  hasCache: boolean;
  spotifyConnected: boolean;
}) {
  const running = status?.running ?? false;
  const text = status ? progressText(status) : null;
  return (
    <section className="panel">
      <h2>Sync</h2>
      <div className="actions">
        <button onClick={onSync} disabled={running}>
          {running && status?.job === 'lastfm' ? 'Syncing…' : 'Sync Last.fm now'}
        </button>
        <button onClick={onEnrich} disabled={running}>
          {running && status?.job === 'enrich'
            ? 'Enriching…'
            : `Enrich artists${pendingEnrich > 0 ? ` (${pendingEnrich})` : ''}`}
        </button>
        {hasCache && (
          <button onClick={onReprocess} disabled={running} title="Re-apply cached MusicBrainz/Last.fm data to the library without any network calls">
            {running && status?.job === 'enrich-reprocess' ? 'Reprocessing…' : 'Reprocess from cache'}
          </button>
        )}
        {spotifyConnected && (
          <button onClick={onImportLiked} disabled={running} title="Flag library tracks you've liked on Spotify">
            {running && status?.job === 'spotify-liked' ? 'Importing…' : 'Import Spotify liked'}
          </button>
        )}
      </div>
      {text && <p>{text}</p>}
      {status?.error && <p className="error">Last job failed: {status.error}</p>}
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

function BarList({ items, labelFor }: { items: { name: string; weight: number }[]; labelFor?: (name: string) => string }) {
  const max = items.reduce((m, i) => Math.max(m, i.weight), 0) || 1;
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.name}>
          <span className="bar-label" title={i.name}>
            {labelFor ? labelFor(i.name) : i.name}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(i.weight / max) * 100}%` }} />
          </span>
          <span className="hint">{i.weight.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function TastePanel({ summary }: { summary: LibrarySummary }) {
  const e = summary.enrichment;
  const hasData = summary.topGenres.length > 0 || summary.topCountries.length > 0;
  return (
    <section className="panel">
      <h2>Genres &amp; countries</h2>
      <p className="hint">
        {e.enriched.toLocaleString()} of {summary.artists.toLocaleString()} artists enriched
        {e.pending > 0 ? `, ${e.pending.toLocaleString()} pending` : ''}
        {e.errored > 0 ? `, ${e.errored.toLocaleString()} errored` : ''} · {e.withCountry.toLocaleString()} with a country
      </p>
      <p className="hint">
        Cache: {summary.cache.mbArtists.toLocaleString()} MusicBrainz artists,{' '}
        {summary.cache.mbSearches.toLocaleString()} searches, {summary.cache.lastfmTags.toLocaleString()} Last.fm
        lookups saved — reused for free by “Reprocess from cache”.
      </p>
      {!hasData && <p className="hint">Run “Enrich artists” to populate genres and countries.</p>}
      {summary.topGenres.length > 0 && (
        <>
          <h3>Top genres</h3>
          <BarList items={summary.topGenres} />
        </>
      )}
      {summary.topCountries.length > 0 && (
        <>
          <h3>Top countries</h3>
          <BarList items={summary.topCountries} labelFor={countryName} />
        </>
      )}
    </section>
  );
}

function formatDuration(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 60) return `${Math.round(days / 30.4)} months`;
  return `${Math.round(days)} days`;
}

function InsightsPanel() {
  const [kind, setKind] = useState<InsightKind>('tracks');
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getInsights(kind, days)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [kind, days]);

  return (
    <section className="panel">
      <div className="results-head">
        <h2>Insights</h2>
        <div className="insight-controls">
          <select value={kind} onChange={(e) => setKind(e.target.value as InsightKind)}>
            <option value="tracks">Tracks</option>
            <option value="albums">Albums</option>
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
            <option value={180}>last 6 months</option>
            <option value={365}>last year</option>
          </select>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && !data && <p className="hint">Computing…</p>}
      {data && (
        <div className={loading ? 'dimmed' : undefined}>
          <h3>Longest gaps</h3>
          <p className="hint">The longest you went without playing something — before coming back to it.</p>
          {data.gaps.length === 0 ? (
            <p className="hint">No gaps yet — sync some history first.</p>
          ) : (
            <ol className="insight-list">
              {data.gaps.map((g) => (
                <li key={g.entityId}>
                  <span className="insight-main">
                    <strong>{g.name}</strong> <span className="hint">— {g.artistName}</span>
                  </span>
                  <span className="hint">
                    {formatDuration(g.gapSeconds)} · returned {new Date(g.gapEnd * 1000).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <h3>Climbers</h3>
          <p className="hint">Biggest jumps up your all-time ranking in the selected window.</p>
          {data.climbers.length === 0 ? (
            <p className="hint">Nothing climbed in this window.</p>
          ) : (
            <ol className="insight-list">
              {data.climbers.map((c) => (
                <li key={c.entityId}>
                  <span className="insight-main">
                    <strong>{c.name}</strong> <span className="hint">— {c.artistName}</span>
                  </span>
                  <span className="hint">
                    #{c.rankThen} → #{c.rankNow} <span className="climb">▲{c.climb}</span> · {c.playcount.toLocaleString()} plays
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
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

function Dashboard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [st, sum, au] = await Promise.all([
        api.getSyncStatus(),
        api.getLibrarySummary(),
        api.getAuthStatus(),
      ]);
      setStatus(st);
      setSummary(sum);
      setAuth(au);
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

  const runJob = async (start: () => Promise<unknown>) => {
    try {
      await start();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="dash">
        {settings && (
          <SettingsPanel settings={settings} onSaved={() => api.getSettings().then(setSettings)} />
        )}
        <SyncPanel
          status={status}
          onSync={() => runJob(api.startLastfmSync)}
          onEnrich={() => runJob(api.startEnrichment)}
          onReprocess={() => runJob(api.startReprocess)}
          onImportLiked={() => runJob(api.importSpotifyLiked)}
          pendingEnrich={summary?.enrichment.pending ?? 0}
          hasCache={(summary?.cache.mbArtists ?? 0) + (summary?.cache.mbSearches ?? 0) > 0}
          spotifyConnected={auth?.spotify.connected ?? false}
        />
        {settings && (
          <ConnectionsPanel settings={settings} onSaved={() => api.getSettings().then(setSettings)} />
        )}
        <LibraryPanel summary={summary} />
        {summary && <TastePanel summary={summary} />}
        <InsightsPanel />
      </div>
    </>
  );
}

type Tab = 'dashboard' | 'builder';

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Blast From The Past</h1>
          <p className="tagline">Rediscover your music from your Last.fm history.</p>
        </div>
        <nav className="tabs">
          <button className={tab === 'dashboard' ? 'tab on' : 'tab'} onClick={() => setTab('dashboard')}>
            Dashboard
          </button>
          <button className={tab === 'builder' ? 'tab on' : 'tab'} onClick={() => setTab('builder')}>
            Recipe builder
          </button>
        </nav>
      </header>
      {tab === 'dashboard' ? <Dashboard /> : <RecipeBuilder />}
    </main>
  );
}
