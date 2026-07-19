import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AuthStatus,
  type Candidate,
  type ExistingPlaylist,
  type Facets,
  type Preset,
  type PreviewResult,
  type PushMode,
  type PushResult,
  type SavedRecipe,
  type ServiceName,
  type UnmatchedTrack,
} from './api';
import {
  SORT_LABELS,
  type Clause,
  type ClauseType,
  type Recipe,
  type RecipeOutput,
  type SortKey,
} from './recipeTypes';
import { countryName } from './countries';
import { ChipInput, DateRangeInput, DaysInput, SliderField } from './components/clauseEditors';

const CLAUSE_LABELS: Record<ClauseType, string> = {
  genre: 'Genre',
  country: 'Country of origin',
  notPlayedInDays: "Haven't played in…",
  playedInDays: 'Played within…',
  gapDays: 'Gap between plays',
  anniversary: 'On this day (anniversary)',
  firstListen: 'First listened between',
  lastListen: 'Last listened between',
  peakMonth: 'Peak listening between',
  playcount: 'Play count',
  loved: 'Loved / liked',
  excludeRecentlyPlaylisted: 'Exclude recently playlisted',
};

const CLAUSE_ORDER: ClauseType[] = [
  'genre',
  'country',
  'notPlayedInDays',
  'playedInDays',
  'gapDays',
  'anniversary',
  'firstListen',
  'lastListen',
  'peakMonth',
  'playcount',
  'loved',
  'excludeRecentlyPlaylisted',
];

function defaultClause(type: ClauseType): Clause {
  switch (type) {
    case 'genre':
      return { type, anyOf: [], mode: 'canonical', negate: false };
    case 'country':
      return { type, anyOf: [], negate: false };
    case 'notPlayedInDays':
      return { type, days: 730 };
    case 'playedInDays':
      return { type, days: 90 };
    case 'gapDays':
      return { type, infinite: true };
    case 'firstListen':
    case 'lastListen':
    case 'peakMonth':
      return { type };
    case 'playcount':
      return { type, min: 5 };
    case 'loved':
      return { type };
    case 'excludeRecentlyPlaylisted':
      return { type, days: 30 };
    case 'anniversary':
      return { type, field: 'firstListen', windowDays: 3 };
  }
}

/** A clause is meaningful (worth sending) only if it actually constrains. */
function isMeaningful(c: Clause): boolean {
  switch (c.type) {
    case 'genre':
    case 'country':
      return c.anyOf.length > 0;
    case 'firstListen':
    case 'lastListen':
    case 'peakMonth':
      return Boolean(c.after || c.before);
    case 'playcount':
      return c.min !== undefined || c.max !== undefined;
    case 'gapDays':
      return Boolean(c.infinite) || c.minDays !== undefined || c.maxDays !== undefined;
    default:
      return true;
  }
}

function ClauseEditor({
  clause,
  facets,
  onChange,
}: {
  clause: Clause;
  facets: Facets | null;
  onChange: (c: Clause) => void;
}) {
  switch (clause.type) {
    case 'genre':
      return (
        <>
          <ChipInput
            values={clause.anyOf}
            onChange={(anyOf) => onChange({ ...clause, anyOf })}
            suggestions={facets?.genres ?? []}
            placeholder="e.g. metal, jazz…"
          />
          <label className="inline">
            <input
              type="checkbox"
              checked={clause.mode === 'raw'}
              onChange={(e) => onChange({ ...clause, mode: e.target.checked ? 'raw' : 'canonical' })}
            />
            exact tag (no subgenres)
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={clause.negate ?? false}
              onChange={(e) => onChange({ ...clause, negate: e.target.checked })}
            />
            exclude these instead
          </label>
        </>
      );
    case 'country':
      return (
        <>
          <ChipInput
            values={clause.anyOf}
            onChange={(anyOf) => onChange({ ...clause, anyOf })}
            suggestions={facets?.countries ?? []}
            placeholder="e.g. Sweden, United Kingdom…"
            labelFor={countryName}
          />
          <label className="inline">
            <input
              type="checkbox"
              checked={clause.negate ?? false}
              onChange={(e) => onChange({ ...clause, negate: e.target.checked })}
            />
            exclude these instead
          </label>
        </>
      );
    case 'notPlayedInDays':
    case 'playedInDays':
    case 'excludeRecentlyPlaylisted':
      return <DaysInput days={clause.days} onChange={(days) => onChange({ ...clause, days })} />;
    case 'gapDays':
      return (
        <>
          <label className="inline">
            <input
              type="checkbox"
              checked={clause.infinite ?? false}
              onChange={(e) => onChange({ ...clause, infinite: e.target.checked })}
            />
            still ongoing — hasn't returned from its biggest-ever pause yet
          </label>
          {clause.infinite ? (
            <div className="days-input-labeled">
              <span className="hint">and has been silent for at least</span>
              <DaysInput days={clause.minDays ?? 0} onChange={(minDays) => onChange({ ...clause, minDays: minDays || undefined })} />
            </div>
          ) : (
            <div className="minmax-sliders">
              <div className="days-input-labeled">
                <span className="hint">min gap</span>
                <DaysInput days={clause.minDays ?? 0} onChange={(minDays) => onChange({ ...clause, minDays: minDays || undefined })} />
              </div>
              <div className="days-input-labeled">
                <span className="hint">max gap</span>
                <DaysInput days={clause.maxDays ?? 3650} onChange={(maxDays) => onChange({ ...clause, maxDays: maxDays || undefined })} />
              </div>
            </div>
          )}
        </>
      );
    case 'firstListen':
    case 'lastListen':
      return (
        <DateRangeInput
          after={clause.after}
          before={clause.before}
          onChange={(after, before) => onChange({ ...clause, after, before })}
        />
      );
    case 'peakMonth':
      return (
        <DateRangeInput
          after={clause.after}
          before={clause.before}
          onChange={(after, before) => onChange({ ...clause, after, before })}
          // Older saved recipes may hold a bare 'YYYY-MM' from the old month
          // picker; pad it so a date input can display it.
          toDateValue={(v) => (v && v.length === 7 ? `${v}-01` : (v ?? ''))}
        />
      );
    case 'playcount':
      return (
        <div className="minmax-sliders">
          <SliderField label="min" value={clause.min} onChange={(min) => onChange({ ...clause, min })} max={200} allowEmpty placeholder="—" />
          <SliderField label="max" value={clause.max} onChange={(max) => onChange({ ...clause, max })} max={200} allowEmpty placeholder="—" />
        </div>
      );
    case 'loved':
      return (
        <select value={clause.source ?? 'any'} onChange={(e) => onChange({ ...clause, source: e.target.value === 'any' ? undefined : (e.target.value as 'lastfm' | 'spotify' | 'tidal') })}>
          <option value="any">from any source</option>
          <option value="lastfm">Last.fm loved</option>
          <option value="spotify">Spotify liked</option>
          <option value="tidal">TIDAL liked</option>
        </select>
      );
    case 'anniversary':
      return (
        <div className="daterange">
          <select value={clause.field ?? 'firstListen'} onChange={(e) => onChange({ ...clause, field: e.target.value as 'firstListen' | 'lastListen' })}>
            <option value="firstListen">first listened</option>
            <option value="lastListen">last listened</option>
          </select>
          <span>within</span>
          <SliderField value={clause.windowDays} onChange={(v) => onChange({ ...clause, windowDays: v ?? 0 })} max={30} />
          <span>days of today (any year)</span>
        </div>
      );
  }
}

function ResultsList({
  result,
  selected,
  onToggle,
}: {
  result: PreviewResult | null;
  selected: Set<number>;
  onToggle: (entityId: number) => void;
}) {
  if (!result) return null;
  if (result.rows.length === 0) return <p className="hint">No matches. Loosen your filters.</p>;
  return (
    <ul className="results">
      {result.rows.map((r) => (
        <li key={`${r.entityKind}-${r.entityId}`} className={selected.has(r.entityId) ? '' : 'deselected'}>
          <input
            type="checkbox"
            className="result-check"
            checked={selected.has(r.entityId)}
            onChange={() => onToggle(r.entityId)}
          />
          <div className="result-body">
            <div className="result-main">
              <strong>{r.name}</strong> <span className="hint">— {r.artistName}</span>
              {r.albumName && r.entityKind === 'track' && <span className="hint"> · {r.albumName}</span>}
            </div>
            <div className="result-meta">
              <span className="hint">
                {r.playcount.toLocaleString()} plays · last {new Date(r.lastListen * 1000).toLocaleDateString()}
              </span>
              <a href={r.spotifyUrl} target="_blank" rel="noreferrer">Spotify</a>
              <a href={r.tidalUrl} target="_blank" rel="noreferrer">TIDAL</a>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function FixupRow({
  service,
  track,
  fixed,
  onFixed,
}: {
  service: ServiceName;
  track: UnmatchedTrack;
  fixed: boolean;
  onFixed: (trackId: number) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  const find = async () => {
    setLoading(true);
    try {
      const { candidates } = await api.getCandidates(service, track.trackId);
      setCandidates(candidates);
    } finally {
      setLoading(false);
    }
  };

  const pick = async (c: Candidate) => {
    await api.overrideMatch(service, track.trackId, c.serviceId);
    onFixed(track.trackId);
  };

  return (
    <li>
      <span>
        {track.name} <span className="hint">— {track.artistName}</span>
      </span>{' '}
      {fixed ? (
        <span className="hint">✓ matched</span>
      ) : candidates ? (
        candidates.length === 0 ? (
          <span className="hint">no candidates</span>
        ) : (
          <span className="candidates">
            {candidates.slice(0, 4).map((c) => (
              <button key={c.serviceId} className="link" onClick={() => pick(c)} title={`${c.name} — ${c.artistName}`}>
                {c.name} · {c.artistName}
              </button>
            ))}
          </span>
        )
      ) : (
        <button className="link" onClick={find} disabled={loading}>
          {loading ? 'searching…' : 'find match'}
        </button>
      )}
    </li>
  );
}

function MatchFixup({
  result,
  fixed,
  onFixed,
}: {
  result: PushResult;
  fixed: Set<number>;
  onFixed: (trackId: number) => void;
}) {
  const rows = [...result.unmatched, ...result.lowConfidence];
  if (rows.length === 0) return null;
  return (
    <div className="fixup">
      <h3>Fix matches</h3>
      <p className="hint">
        These tracks didn't match cleanly. Pick the right result to add it and remember the choice.
      </p>
      <ul className="fixup-list">
        {rows.map((t) => (
          <FixupRow
            key={t.trackId}
            service={result.service}
            track={t}
            fixed={fixed.has(t.trackId)}
            onFixed={onFixed}
          />
        ))}
      </ul>
    </div>
  );
}

export default function RecipeBuilder() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [enabled, setEnabled] = useState<Partial<Record<ClauseType, Clause>>>({
    genre: defaultClause('genre'),
    notPlayedInDays: defaultClause('notPlayedInDays'),
  });
  const [output, setOutput] = useState<RecipeOutput>({ mode: 'albums', sort: 'neglect', limit: 50 });
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [name, setName] = useState('');
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [pushing, setPushing] = useState<ServiceName | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [fixed, setFixed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [conflict, setConflict] = useState<{ service: ServiceName; existing: ExistingPlaylist } | null>(null);

  const recipe: Recipe = useMemo(
    () => ({ filters: Object.values(enabled).filter(isMeaningful), output }),
    [enabled, output],
  );

  useEffect(() => {
    api.getFacets().then(setFacets).catch(() => {});
    api.listRecipes().then(setSaved).catch(() => {});
    api.getAuthStatus().then(setAuth).catch(() => {});
    api.getPresets().then(setPresets).catch(() => {});
  }, []);

  const applyDefinition = (def: Recipe) => {
    const byType: Partial<Record<ClauseType, Clause>> = {};
    for (const c of def.filters) byType[c.type] = c;
    setEnabled(byType);
    setOutput(def.output);
  };

  const loadPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    applyDefinition(preset.definition);
    setName(preset.name);
    setCurrentId(null); // a preset is a starting point, not a saved recipe
  };

  const doPush = async (service: ServiceName, mode: PushMode, existingPlaylistId?: string) => {
    const playlistName = name.trim() || 'Blast From The Past';
    setPushing(service);
    setPushResult(null);
    setFixed(new Set());
    setPushMsg(
      mode === 'replace'
        ? `Replacing "${playlistName}" on ${service}…`
        : mode === 'append'
          ? `Adding to "${playlistName}" on ${service}…`
          : `Pushing to ${service}…`,
    );
    try {
      await api.push(recipe, service, playlistName, [...selected], mode, existingPlaylistId);
      // Poll until the background push job finishes, then read its result.
      let lastStatus = await api.getSyncStatus();
      for (let i = 0; i < 200 && lastStatus.running; i++) {
        await new Promise((r) => setTimeout(r, 750));
        lastStatus = await api.getSyncStatus();
      }
      const { result } = await api.getPushResult();
      setPushResult(result);
      if (result?.itemsError) {
        setPushMsg(`Playlist "${playlistName}" was created, but adding tracks to it failed: ${result.itemsError}`);
      } else if (result?.matchError) {
        setPushMsg(`Some tracks couldn't be searched for: ${result.matchError}`);
      } else if (!result) {
        setPushMsg(lastStatus.error ? `Push failed: ${lastStatus.error}` : 'Push finished but returned no result.');
      } else if (result.skippedDuplicates) {
        setPushMsg(`${result.skippedDuplicates} track${result.skippedDuplicates === 1 ? '' : 's'} already in the playlist, left alone.`);
      } else {
        setPushMsg(null);
      }
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(null);
    }
  };

  const pushTo = async (service: ServiceName) => {
    if (selected.size === 0) {
      setPushMsg('Nothing selected — tick at least one result.');
      return;
    }
    const playlistName = name.trim() || 'Blast From The Past';
    setPushMsg(null);
    try {
      const { existing } = await api.checkExistingPlaylist(service, playlistName);
      if (existing) {
        setConflict({ service, existing });
        return;
      }
    } catch {
      // If the existence check fails, fall through to a normal push rather than blocking the user.
    }
    await doPush(service, 'new');
  };

  // Debounced live preview. Fresh results start fully selected.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewRecipe(recipe)
        .then((r) => {
          setResult(r);
          setSelected(new Set(r.rows.map((row) => row.entityId)));
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(t);
  }, [recipe]);

  const toggleSelected = (entityId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entityId)) next.delete(entityId);
      else next.add(entityId);
      return next;
    });

  const toggle = (type: ClauseType) =>
    setEnabled((prev) => {
      const next = { ...prev };
      if (next[type]) delete next[type];
      else next[type] = defaultClause(type);
      return next;
    });

  const setClause = (type: ClauseType, c: Clause) => setEnabled((prev) => ({ ...prev, [type]: c }));

  const refreshSaved = useCallback(() => api.listRecipes().then(setSaved).catch(() => {}), []);

  const save = async () => {
    if (!name.trim()) return;
    try {
      if (currentId) {
        await api.updateRecipe(currentId, name.trim(), recipe);
      } else {
        const created = await api.createRecipe(name.trim(), recipe);
        setCurrentId(created.id);
      }
      await refreshSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const load = (r: SavedRecipe) => {
    applyDefinition(r.definition);
    setName(r.name);
    setCurrentId(r.id);
  };

  const remove = async (id: number) => {
    await api.deleteRecipe(id);
    if (currentId === id) {
      setCurrentId(null);
      setName('');
    }
    await refreshSaved();
  };

  const newRecipe = () => {
    setEnabled({ genre: defaultClause('genre'), notPlayedInDays: defaultClause('notPlayedInDays') });
    setOutput({ mode: 'albums', sort: 'neglect', limit: 50 });
    setName('');
    setCurrentId(null);
  };

  return (
    <div className="builder">
      <div className="builder-col">
      <section className="panel">
        <div className="results-head">
          <h2>Filters</h2>
          {presets.length > 0 && (
            <label className="preset-picker">
              Start from a preset
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) loadPreset(e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="">Choose…</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id} title={p.description}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="clause-toggles">
          {CLAUSE_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              className={enabled[type] ? 'toggle on' : 'toggle'}
              onClick={() => toggle(type)}
            >
              {enabled[type] ? '✓ ' : '+ '}
              {CLAUSE_LABELS[type]}
            </button>
          ))}
        </div>
        <div className="clauses">
          {CLAUSE_ORDER.filter((t) => enabled[t]).map((type) => (
            <div key={type} className="clause">
              <div className="clause-head">
                <span>{CLAUSE_LABELS[type]}</span>
                <button type="button" className="link" onClick={() => toggle(type)}>
                  remove
                </button>
              </div>
              <ClauseEditor clause={enabled[type]!} facets={facets} onChange={(c) => setClause(type, c)} />
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Output</h2>
        <div className="output-controls">
          <label>
            Pick
            <select value={output.mode} onChange={(e) => setOutput({ ...output, mode: e.target.value as 'tracks' | 'albums' })}>
              <option value="albums">Albums</option>
              <option value="tracks">Tracks</option>
            </select>
          </label>
          <label>
            Sort by
            <select value={output.sort} onChange={(e) => setOutput({ ...output, sort: e.target.value as SortKey })}>
              {Object.entries(SORT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Limit
            <input type="number" min={1} value={output.limit} onChange={(e) => setOutput({ ...output, limit: Number(e.target.value) })} />
          </label>
          <label>
            Max per artist
            <input
              type="number"
              min={0}
              placeholder="∞"
              value={output.perArtistCap ?? ''}
              onChange={(e) => setOutput({ ...output, perArtistCap: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
        </div>
      </section>

      {saved.length > 0 && (
        <section className="panel">
          <h2>Saved recipes</h2>
          <ul className="saved-list">
            {saved.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => load(r)}>
                  {r.name}
                </button>
                <button className="link danger" onClick={() => remove(r.id)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      </div>

      <div className="builder-col results-col">
      <section className="panel">
        <div className="results-head">
          <h2>
            Results{' '}
            {result && <span className="hint">— {result.matched.toLocaleString()} match{result.matched === 1 ? '' : 'es'}</span>}
          </h2>
          <div className="save-row">
            <input placeholder="Recipe name" value={name} onChange={(e) => setName(e.target.value)} />
            <button onClick={save} disabled={!name.trim()}>
              {currentId ? 'Update' : 'Save'}
            </button>
            <button className="secondary" onClick={newRecipe}>
              New
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {result && result.rows.length > 0 && (
          <div className="selection-row">
            <span className="hint">
              {selected.size} of {result.rows.length} selected
            </span>
            <button className="link" onClick={() => setSelected(new Set(result.rows.map((r) => r.entityId)))}>
              all
            </button>
            <button className="link" onClick={() => setSelected(new Set())}>
              none
            </button>
          </div>
        )}
        {auth && (auth.spotify.connected || auth.tidal.connected) && (
          <div className="push-row">
            <span className="hint">
              {output.mode === 'tracks'
                ? 'Push the selected tracks as a playlist:'
                : 'Push the selected albums (all their tracks) as a playlist:'}
            </span>
            {auth.spotify.connected && (
              <button className="secondary" disabled={pushing !== null || conflict !== null || selected.size === 0} onClick={() => pushTo('spotify')}>
                {pushing === 'spotify' ? 'Pushing…' : 'Spotify'}
              </button>
            )}
            {auth.tidal.connected && (
              <button className="secondary" disabled={pushing !== null || conflict !== null || selected.size === 0} onClick={() => pushTo('tidal')}>
                {pushing === 'tidal' ? 'Pushing…' : 'TIDAL'}
              </button>
            )}
          </div>
        )}
        {auth && !auth.spotify.connected && !auth.tidal.connected && (
          <p className="hint">Connect Spotify or TIDAL on the Dashboard to push playlists.</p>
        )}
        {conflict && (
          <div className="conflict-box">
            <p className="hint">
              A playlist named "{name.trim() || 'Blast From The Past'}" already exists on {conflict.service} (pushed{' '}
              {new Date(conflict.existing.createdAt * 1000).toLocaleDateString()}).{' '}
              <a href={conflict.existing.playlistUrl} target="_blank" rel="noreferrer">
                open it
              </a>
              . Replace its contents, add the selection to it, or make a new one anyway?
            </p>
            <div className="conflict-actions">
              <button
                onClick={() => {
                  const { service, existing } = conflict;
                  setConflict(null);
                  void doPush(service, 'replace', existing.playlistId);
                }}
              >
                Replace
              </button>
              <button
                onClick={() => {
                  const { service, existing } = conflict;
                  setConflict(null);
                  void doPush(service, 'append', existing.playlistId);
                }}
              >
                Add to it
              </button>
              <button
                className="secondary"
                onClick={() => {
                  const { service } = conflict;
                  setConflict(null);
                  void doPush(service, 'new');
                }}
              >
                Create new anyway
              </button>
              <button className="link" onClick={() => setConflict(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {pushMsg && <p className="hint">{pushMsg}</p>}
        {pushResult && (
          <p className="hint">
            Playlist now has {pushResult.matchedCount} track{pushResult.matchedCount === 1 ? '' : 's'} from this push —{' '}
            <a href={pushResult.playlistUrl} target="_blank" rel="noreferrer">
              open in {pushResult.service}
            </a>
            {pushResult.unmatched.length > 0 && `. ${pushResult.unmatched.length} couldn't be matched.`}
            {pushResult.lowConfidence.length > 0 && ` ${pushResult.lowConfidence.length} low-confidence match(es).`}
          </p>
        )}
        {pushResult && (
          <MatchFixup
            result={pushResult}
            fixed={fixed}
            onFixed={(trackId) => setFixed((prev) => new Set(prev).add(trackId))}
          />
        )}
        <ResultsList result={result} selected={selected} onToggle={toggleSelected} />
      </section>
      </div>
    </div>
  );
}
