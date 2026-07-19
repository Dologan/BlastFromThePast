import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type AuthStatus,
  type CurateGroup,
  type CuratePreviewResult,
  type CuratePushOutcome,
  type ExistingPlaylist,
  type GroupBy,
  type LikedSource,
  type OnExisting,
  type PlaylistInventory,
  type ServiceName,
  type Settings,
  type UnlikeExecuteResult,
  type UnlikePreviewRow,
} from './api';
import type { Clause, Recipe } from './recipeTypes';
import { DateRangeInput, DaysInput, SliderField } from './components/clauseEditors';

const SERVICE_LABEL: Record<ServiceName, string> = { spotify: 'Spotify', tidal: 'TIDAL' };

/** Waits for the current background job to finish, polling like RecipeBuilder's push flow. */
async function waitForJob(maxAttempts = 400): Promise<{ error: string | null }> {
  let status = await api.getSyncStatus();
  for (let i = 0; i < maxAttempts && status.running; i++) {
    await new Promise((r) => setTimeout(r, 750));
    status = await api.getSyncStatus();
  }
  return { error: status.error };
}

// ---- Classify & push ----

interface BaseCriteria {
  lovedSource: 'any' | LikedSource;
  playcountMin?: number;
  playcountMax?: number;
  lastListenAfter?: string;
  lastListenBefore?: string;
  firstListenAfter?: string;
  firstListenBefore?: string;
  peakAfter?: string;
  peakBefore?: string;
  mode: 'tracks' | 'albums';
}

const DEFAULT_CRITERIA: BaseCriteria = { lovedSource: 'any', mode: 'tracks' };

function buildBaseRecipe(c: BaseCriteria): Recipe {
  const filters: Clause[] = [{ type: 'loved', source: c.lovedSource === 'any' ? undefined : c.lovedSource }];
  if (c.playcountMin !== undefined || c.playcountMax !== undefined) {
    filters.push({ type: 'playcount', min: c.playcountMin, max: c.playcountMax });
  }
  if (c.lastListenAfter || c.lastListenBefore) {
    filters.push({ type: 'lastListen', after: c.lastListenAfter, before: c.lastListenBefore });
  }
  if (c.firstListenAfter || c.firstListenBefore) {
    filters.push({ type: 'firstListen', after: c.firstListenAfter, before: c.firstListenBefore });
  }
  if (c.peakAfter || c.peakBefore) {
    filters.push({ type: 'peakMonth', after: c.peakAfter, before: c.peakBefore });
  }
  return { filters, output: { mode: c.mode, sort: 'weighted_random', limit: 10000 } };
}

function GroupCard({
  group,
  selected,
  onToggleGroup,
  deselectedTracks,
  onToggleTrack,
  conflict,
}: {
  group: CurateGroup;
  selected: boolean;
  onToggleGroup: () => void;
  deselectedTracks: Set<number>;
  onToggleTrack: (entityId: number) => void;
  conflict: ExistingPlaylist | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const effectiveCount = group.entityIds.filter((id) => !deselectedTracks.has(id)).length;
  return (
    <div className="curate-group">
      <div className="curate-group-head">
        <label className="inline">
          <input type="checkbox" checked={selected} onChange={onToggleGroup} />
          <strong>{group.name}</strong>
        </label>
        <span className="hint">
          {effectiveCount.toLocaleString()} track{effectiveCount === 1 ? '' : 's'}
        </span>
        {conflict && <span className="badge on">exists already</span>}
        <button type="button" className="link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'hide tracks' : 'show tracks'}
        </button>
      </div>
      {expanded && (
        <ul className="curate-track-list">
          {group.sample.map((s, i) => {
            const id = group.entityIds[i];
            if (id === undefined) return null;
            return (
              <li key={id}>
                <label className="inline">
                  <input type="checkbox" checked={!deselectedTracks.has(id)} onChange={() => onToggleTrack(id)} />
                  {s}
                </label>
              </li>
            );
          })}
          {group.entityIds.length > group.sample.length && (
            <li className="hint">
              +{(group.entityIds.length - group.sample.length).toLocaleString()} more not shown — included unless the whole group is deselected.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ClassifyAndPush({ settings, auth }: { settings: Settings; auth: AuthStatus | null }) {
  const [criteria, setCriteria] = useState<BaseCriteria>(DEFAULT_CRITERIA);
  const [groupBy, setGroupBy] = useState<GroupBy>('genreFamily');
  const [minGroupSize, setMinGroupSize] = useState(5);
  const [namePrefix, setNamePrefix] = useState('Loved: ');
  const [excludeOn, setExcludeOn] = useState<ServiceName[]>([]);
  const [preview, setPreview] = useState<CuratePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [deselectedTracks, setDeselectedTracks] = useState<Record<string, Set<number>>>({});
  const [conflicts, setConflicts] = useState<Record<string, ExistingPlaylist | null>>({});
  const [service, setService] = useState<ServiceName | ''>(settings.defaultService ?? '');
  const [onExisting, setOnExisting] = useState<OnExisting>('skip');
  const [pushing, setPushing] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [pushResults, setPushResults] = useState<{ name: string; outcome: CuratePushOutcome }[] | null>(null);
  const [inventory, setInventory] = useState<PlaylistInventory | null>(null);
  const [syncingPlaylists, setSyncingPlaylists] = useState(false);

  const base = useMemo(() => buildBaseRecipe(criteria), [criteria]);
  const connected: ServiceName[] = [
    ...(auth?.spotify.connected ? (['spotify'] as const) : []),
    ...(auth?.tidal.connected ? (['tidal'] as const) : []),
  ];

  const refreshInventory = () => api.getPlaylistInventory().then(setInventory).catch(() => {});
  useEffect(() => {
    void refreshInventory();
  }, []);

  // Debounced live preview -- re-runs on every criteria/grouping change; this
  // iteration loop plus per-group/per-track checkboxes IS the "refinement" step.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .curatePreview({ base, groupBy, excludePlaylistedOn: excludeOn, minGroupSize, namePrefix })
        .then((r) => {
          setPreview(r);
          setSelectedGroups(new Set(r.groups.map((g) => g.key)));
          setDeselectedTracks({});
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(t);
  }, [base, groupBy, excludeOn, minGroupSize, namePrefix]);

  // Name-conflict badges per group, once a target service is picked.
  useEffect(() => {
    if (!service || !preview) {
      setConflicts({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        preview.groups.map(async (g) => {
          try {
            const { existing } = await api.checkExistingPlaylist(service, g.name);
            return [g.key, existing] as const;
          } catch {
            return [g.key, null] as const;
          }
        }),
      );
      if (!cancelled) setConflicts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [service, preview]);

  const toggleGroup = (key: string) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleTrack = (groupKey: string, entityId: number) =>
    setDeselectedTracks((prev) => {
      const set = new Set(prev[groupKey] ?? []);
      if (set.has(entityId)) set.delete(entityId);
      else set.add(entityId);
      return { ...prev, [groupKey]: set };
    });

  const toggleExcludeService = (s: ServiceName) =>
    setExcludeOn((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const syncPlaylistsNow = async () => {
    setSyncingPlaylists(true);
    setError(null);
    try {
      await api.syncPlaylists();
      const { error: jobError } = await waitForJob();
      if (jobError) setError(`Playlist sync failed: ${jobError}`);
      await refreshInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingPlaylists(false);
    }
  };

  const push = async () => {
    if (!service || !preview) return;
    const playlists = preview.groups
      .filter((g) => selectedGroups.has(g.key))
      .map((g) => ({ name: g.name, trackIds: g.entityIds.filter((id) => !(deselectedTracks[g.key]?.has(id))) }))
      .filter((p) => p.trackIds.length > 0);
    if (playlists.length === 0) {
      setPushMsg('Nothing selected to push.');
      return;
    }
    setPushing(true);
    setPushMsg(null);
    setPushResults(null);
    try {
      await api.curatePush(service, onExisting, playlists);
      const { error: jobError } = await waitForJob();
      const { results } = await api.getCurateResult();
      if (results) {
        setPushResults(results.map((outcome, i) => ({ name: playlists[i]?.name ?? '', outcome })));
        setPushMsg(null);
      } else {
        setPushMsg(jobError ? `Push failed: ${jobError}` : 'Push finished but returned no result.');
      }
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  };

  return (
    <section className="panel">
      <h2>Classify &amp; push</h2>
      <div className="curator-criteria">
        <label>
          Loved / liked source
          <select
            value={criteria.lovedSource}
            onChange={(e) => setCriteria({ ...criteria, lovedSource: e.target.value as BaseCriteria['lovedSource'] })}
          >
            <option value="any">any source</option>
            <option value="lastfm">Last.fm loved</option>
            <option value="spotify">Spotify liked</option>
            <option value="tidal">TIDAL liked</option>
          </select>
        </label>
        <label>
          Pick
          <select value={criteria.mode} onChange={(e) => setCriteria({ ...criteria, mode: e.target.value as 'tracks' | 'albums' })}>
            <option value="tracks">Tracks</option>
            <option value="albums">Albums</option>
          </select>
        </label>
      </div>
      <div className="minmax-sliders">
        <SliderField
          label="min plays"
          value={criteria.playcountMin}
          onChange={(v) => setCriteria({ ...criteria, playcountMin: v })}
          max={200}
          allowEmpty
          placeholder="—"
        />
        <SliderField
          label="max plays"
          value={criteria.playcountMax}
          onChange={(v) => setCriteria({ ...criteria, playcountMax: v })}
          max={200}
          allowEmpty
          placeholder="—"
        />
      </div>
      <div className="clause">
        <div className="clause-head">
          <span>Last played between</span>
        </div>
        <DateRangeInput
          after={criteria.lastListenAfter}
          before={criteria.lastListenBefore}
          onChange={(after, before) => setCriteria({ ...criteria, lastListenAfter: after, lastListenBefore: before })}
        />
      </div>
      <div className="clause">
        <div className="clause-head">
          <span>First listened between</span>
        </div>
        <DateRangeInput
          after={criteria.firstListenAfter}
          before={criteria.firstListenBefore}
          onChange={(after, before) => setCriteria({ ...criteria, firstListenAfter: after, firstListenBefore: before })}
        />
      </div>
      <div className="clause">
        <div className="clause-head">
          <span>Peak listening period between</span>
        </div>
        <DateRangeInput
          after={criteria.peakAfter}
          before={criteria.peakBefore}
          onChange={(after, before) => setCriteria({ ...criteria, peakAfter: after, peakBefore: before })}
        />
      </div>

      <h3>Grouping</h3>
      <div className="curator-criteria">
        <label>
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="genreFamily">Broad genre family (metal includes djent)</option>
            <option value="canonicalGenre">Finer canonical genre</option>
          </select>
        </label>
        <label>
          Min group size
          <input
            type="number"
            min={1}
            value={minGroupSize}
            onChange={(e) => setMinGroupSize(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label>
          Name prefix
          <input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} />
        </label>
      </div>
      <div className="curator-exclude">
        <span className="hint">Exclude tracks already in a playlist on:</span>
        {(['spotify', 'tidal'] as ServiceName[]).map((s) => (
          <label className="inline" key={s}>
            <input type="checkbox" checked={excludeOn.includes(s)} onChange={() => toggleExcludeService(s)} />
            {SERVICE_LABEL[s]}
            {inventory?.[s] && (
              <span className="hint">
                {' '}
                ({inventory[s]!.playlists} playlists, synced {new Date(inventory[s]!.fetchedAt * 1000).toLocaleDateString()})
              </span>
            )}
          </label>
        ))}
        <button type="button" className="secondary" onClick={syncPlaylistsNow} disabled={syncingPlaylists || connected.length === 0}>
          {syncingPlaylists ? 'Syncing…' : 'Sync playlists now'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {preview && (
        <>
          <p className="hint">
            {preview.totalMatched.toLocaleString()} {criteria.mode} matched
            {preview.excluded > 0 ? `, ${preview.excluded.toLocaleString()} already playlisted (excluded)` : ''} — grouped into{' '}
            {preview.groups.length} playlist{preview.groups.length === 1 ? '' : 's'}.
          </p>
          <div className="curate-groups">
            {preview.groups.map((g) => (
              <GroupCard
                key={g.key}
                group={g}
                selected={selectedGroups.has(g.key)}
                onToggleGroup={() => toggleGroup(g.key)}
                deselectedTracks={deselectedTracks[g.key] ?? new Set()}
                onToggleTrack={(id) => toggleTrack(g.key, id)}
                conflict={conflicts[g.key]}
              />
            ))}
          </div>
        </>
      )}

      {connected.length > 0 && (
        <div className="push-row">
          <label className="inline">
            Push to
            <select value={service} onChange={(e) => setService(e.target.value as ServiceName | '')}>
              <option value="">choose…</option>
              {connected.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            If a playlist exists
            <select value={onExisting} onChange={(e) => setOnExisting(e.target.value as OnExisting)}>
              <option value="skip">skip it</option>
              <option value="replace">replace its contents</option>
              <option value="append">add to it</option>
            </select>
          </label>
          <button onClick={push} disabled={pushing || !service || selectedGroups.size === 0}>
            {pushing ? 'Pushing…' : `Push ${selectedGroups.size} playlist${selectedGroups.size === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
      {connected.length === 0 && <p className="hint">Connect Spotify or TIDAL on the Dashboard to push playlists.</p>}
      {pushMsg && <p className="hint">{pushMsg}</p>}
      {pushResults && (
        <ul className="curate-results">
          {pushResults.map(({ name, outcome }, i) =>
            'skipped' in outcome && outcome.skipped ? (
              <li key={i} className="hint">
                {name} — skipped (already exists)
              </li>
            ) : (
              <li key={i}>
                <a href={outcome.playlistUrl} target="_blank" rel="noreferrer">
                  {name}
                </a>{' '}
                — {outcome.matchedCount} track{outcome.matchedCount === 1 ? '' : 's'}
                {outcome.unmatched.length > 0 && `, ${outcome.unmatched.length} unmatched`}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

// ---- Cleanup (bulk unlike) ----

function Cleanup() {
  // Defaults to 'none' (no playlist requirement) rather than 'any' -- 'any'
  // silently returns zero rows until playlists have been synced at least
  // once, which is a confusing first-run trap.
  const [inPlaylistOn, setInPlaylistOn] = useState<'any' | 'none' | ServiceName>('none');
  const [maxPlaycount, setMaxPlaycount] = useState<number | undefined>(3);
  const [notPlayedInDays, setNotPlayedInDays] = useState(1095); // ~3 years; 0 = no constraint
  const [source, setSource] = useState<LikedSource | undefined>(undefined);
  const [rows, setRows] = useState<UnlikePreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [localOnly, setLocalOnly] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<UnlikeExecuteResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => {
    api
      .unlikePreview({
        inPlaylistOn: inPlaylistOn === 'none' ? undefined : inPlaylistOn === 'any' ? 'any' : [inPlaylistOn],
        maxPlaycount,
        notPlayedInDays: notPlayedInDays > 0 ? notPlayedInDays : undefined,
        source,
      })
      .then((r) => {
        setRows(r.rows);
        setSelected(new Set(r.rows.filter((row) => !row.protected).map((row) => row.trackId)));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    const t = setTimeout(refresh, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPlaylistOn, maxPlaycount, notPlayedInDays, source]);

  const toggle = (trackId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });

  const toggleProtect = async (trackId: number, isProtected: boolean) => {
    await api.protectTrack(trackId, isProtected);
    setRows((prev) => prev?.map((r) => (r.trackId === trackId ? { ...r, protected: isProtected } : r)) ?? null);
    if (isProtected) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  };

  const selectAllUnprotected = () => setSelected(new Set((rows ?? []).filter((row) => !row.protected).map((row) => row.trackId)));

  const execute = async () => {
    setExecuting(true);
    setMsg(null);
    setResult(null);
    try {
      await api.unlikeExecute([...selected], localOnly);
      const { error: jobError } = await waitForJob();
      const { result: outcome } = await api.getUnlikeResult();
      setResult(outcome);
      if (!outcome) setMsg(jobError ? `Failed: ${jobError}` : 'Finished but returned no result.');
      refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
      setConfirming(false);
    }
  };

  const selectedRows = (rows ?? []).filter((r) => selected.has(r.trackId));
  const spotifyCount = selectedRows.filter((r) => r.sources.includes('spotify')).length;
  const tidalCount = selectedRows.filter((r) => r.sources.includes('tidal')).length;
  const lastfmOnlyCount = selectedRows.filter((r) => r.sources.every((s) => s === 'lastfm')).length;

  return (
    <section className="panel">
      <h2>Cleanup (bulk unlike)</h2>
      <p className="hint">
        Clean up loves that were more of a "revisit later" bookmark than a true favourite. Shield a track to protect
        it from ever being unliked here, even if it's rarely played.
      </p>
      <div className="curator-criteria">
        <label>
          Already in a playlist
          <select value={inPlaylistOn} onChange={(e) => setInPlaylistOn(e.target.value as 'any' | 'none' | ServiceName)}>
            <option value="none">no requirement</option>
            <option value="any">any service</option>
            <option value="spotify">Spotify only</option>
            <option value="tidal">TIDAL only</option>
          </select>
        </label>
        <label>
          Source
          <select value={source ?? 'any'} onChange={(e) => setSource(e.target.value === 'any' ? undefined : (e.target.value as LikedSource))}>
            <option value="any">any source</option>
            <option value="lastfm">Last.fm loved</option>
            <option value="spotify">Spotify liked</option>
            <option value="tidal">TIDAL liked</option>
          </select>
        </label>
      </div>
      <div className="minmax-sliders">
        <SliderField label="max plays" value={maxPlaycount} onChange={setMaxPlaycount} max={200} allowEmpty placeholder="—" />
      </div>
      <label>
        Not played in the last (0 = no constraint)
        <DaysInput days={notPlayedInDays} onChange={setNotPlayedInDays} />
      </label>

      {error && <p className="error">{error}</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="selection-row">
            <span className="hint">
              {selected.size} of {rows.length} selected
            </span>
            <button type="button" className="link" onClick={selectAllUnprotected}>
              all unprotected
            </button>
            <button type="button" className="link" onClick={() => setSelected(new Set())}>
              none
            </button>
          </div>
          <ul className="unlike-list">
            {rows.map((r) => (
              <li key={r.trackId} className={r.protected ? 'protected' : selected.has(r.trackId) ? '' : 'deselected'}>
                <input type="checkbox" checked={selected.has(r.trackId)} disabled={r.protected} onChange={() => toggle(r.trackId)} />
                <div className="result-body">
                  <div className="result-main">
                    <strong>{r.name}</strong> <span className="hint">— {r.artistName}</span>
                  </div>
                  <div className="result-meta">
                    <span className="hint">
                      {r.playcount.toLocaleString()} plays · last {new Date(r.lastListen * 1000).toLocaleDateString()} ·{' '}
                      {r.sources.join(', ')}
                      {r.playlistNames.length > 0 && ` · in ${r.playlistNames.join(', ')}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={r.protected ? 'shield on' : 'shield'}
                  title={r.protected ? 'Protected — click to unprotect' : 'Protect from bulk unlike'}
                  onClick={() => toggleProtect(r.trackId, !r.protected)}
                >
                  🛡
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {rows && rows.length === 0 && <p className="hint">Nothing matches these criteria.</p>}

      <label className="inline">
        <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />
        Local only — don't call Spotify/TIDAL, just stop treating these as loved here (Last.fm/TIDAL-sourced likes
        resurface on the next sync unless also unloved on the service)
      </label>

      {!confirming ? (
        <button onClick={() => setConfirming(true)} disabled={selected.size === 0}>
          Unlike {selected.size} track{selected.size === 1 ? '' : 's'}…
        </button>
      ) : (
        <div className="conflict-box">
          <p>
            About to unlike {selected.size} track{selected.size === 1 ? '' : 's'}
            {!localOnly &&
              `: ${spotifyCount} on Spotify, ${tidalCount} on TIDAL, ${lastfmOnlyCount} Last.fm-only (no write access yet — skipped unless "local only" is checked)`}
            {localOnly && ' locally only (nothing changes on Spotify/TIDAL/Last.fm; they may resurface on the next sync)'}.
          </p>
          <div className="conflict-actions">
            <button onClick={execute} disabled={executing}>
              {executing ? 'Working…' : 'Confirm'}
            </button>
            <button className="secondary" onClick={() => setConfirming(false)} disabled={executing}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}
      {result && (
        <p className="hint">
          Unliked {result.unliked}. Spotify removed: {result.spotifyRemoved}. TIDAL removed: {result.tidalRemoved}.
          {result.localOnlyRemoved > 0 && ` Local-only: ${result.localOnlyRemoved}.`}
          {result.skipped.length > 0 && ` ${result.skipped.length} skipped.`}
        </p>
      )}
    </section>
  );
}

export default function Curator() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    api.getAuthStatus().then(setAuth).catch(() => {});
  }, []);

  if (!settings) return null;

  return (
    <div className="curator">
      <ClassifyAndPush settings={settings} auth={auth} />
      <Cleanup />
    </div>
  );
}
