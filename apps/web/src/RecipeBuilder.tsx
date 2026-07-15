import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Facets, type PreviewResult, type SavedRecipe } from './api';
import {
  SORT_LABELS,
  type Clause,
  type ClauseType,
  type Recipe,
  type RecipeOutput,
  type SortKey,
} from './recipeTypes';

const CLAUSE_LABELS: Record<ClauseType, string> = {
  genre: 'Genre',
  country: 'Country of origin',
  notPlayedInDays: "Haven't played in…",
  playedInDays: 'Played within…',
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
      return { type, anyOf: [], mode: 'canonical' };
    case 'country':
      return { type, anyOf: [], negate: false };
    case 'notPlayedInDays':
      return { type, days: 730 };
    case 'playedInDays':
      return { type, days: 90 };
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
    default:
      return true;
  }
}

function ChipInput({
  values,
  onChange,
  suggestions,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const listId = useMemo(() => `dl-${Math.random().toString(36).slice(2)}`, []);
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="chipinput">
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        list={listId}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
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
        </>
      );
    case 'country':
      return (
        <>
          <ChipInput
            values={clause.anyOf}
            onChange={(anyOf) => onChange({ ...clause, anyOf })}
            suggestions={facets?.countries ?? []}
            placeholder="e.g. SE, GB…"
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
      return (
        <label className="inline">
          <input
            type="number"
            min={1}
            value={clause.days}
            onChange={(e) => onChange({ ...clause, days: Number(e.target.value) })}
          />
          days
          {clause.type !== 'excludeRecentlyPlaylisted' && (
            <span className="hint"> ({(clause.days / 365).toFixed(1)} years)</span>
          )}
        </label>
      );
    case 'firstListen':
    case 'lastListen':
      return (
        <div className="daterange">
          <input type="date" value={clause.after ?? ''} onChange={(e) => onChange({ ...clause, after: e.target.value || undefined })} />
          <span>→</span>
          <input type="date" value={clause.before ?? ''} onChange={(e) => onChange({ ...clause, before: e.target.value || undefined })} />
        </div>
      );
    case 'peakMonth':
      return (
        <div className="daterange">
          <input type="month" value={clause.after ?? ''} onChange={(e) => onChange({ ...clause, after: e.target.value || undefined })} />
          <span>→</span>
          <input type="month" value={clause.before ?? ''} onChange={(e) => onChange({ ...clause, before: e.target.value || undefined })} />
        </div>
      );
    case 'playcount':
      return (
        <div className="daterange">
          <input type="number" min={0} placeholder="min" value={clause.min ?? ''} onChange={(e) => onChange({ ...clause, min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <span>–</span>
          <input type="number" min={0} placeholder="max" value={clause.max ?? ''} onChange={(e) => onChange({ ...clause, max: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </div>
      );
    case 'loved':
      return (
        <select value={clause.source ?? 'any'} onChange={(e) => onChange({ ...clause, source: e.target.value === 'any' ? undefined : (e.target.value as 'lastfm' | 'spotify') })}>
          <option value="any">from any source</option>
          <option value="lastfm">Last.fm loved</option>
          <option value="spotify">Spotify liked</option>
        </select>
      );
  }
}

function ResultsList({ result }: { result: PreviewResult | null }) {
  if (!result) return null;
  if (result.rows.length === 0) return <p className="hint">No matches. Loosen your filters.</p>;
  return (
    <ol className="results">
      {result.rows.map((r) => (
        <li key={`${r.entityKind}-${r.entityId}`}>
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
        </li>
      ))}
    </ol>
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

  const recipe: Recipe = useMemo(
    () => ({ filters: Object.values(enabled).filter(isMeaningful), output }),
    [enabled, output],
  );

  useEffect(() => {
    api.getFacets().then(setFacets).catch(() => {});
    api.listRecipes().then(setSaved).catch(() => {});
  }, []);

  // Debounced live preview.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewRecipe(recipe)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(t);
  }, [recipe]);

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
    const byType: Partial<Record<ClauseType, Clause>> = {};
    for (const c of r.definition.filters) byType[c.type] = c;
    setEnabled(byType);
    setOutput(r.definition.output);
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
      <section className="panel">
        <h2>Filters</h2>
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
        <ResultsList result={result} />
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
  );
}
