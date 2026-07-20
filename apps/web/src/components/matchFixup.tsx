import { useState } from 'react';
import { api, type Candidate, type OverrideAction, type ServiceName, type UnmatchedTrack } from '../api';

function actionLabel(action: OverrideAction): string {
  switch (action) {
    case 'added':
      return '✓ added to the playlist';
    case 'replaced':
      return '✓ replaced in the playlist';
    case 'unchanged':
      return '✓ already correct in the playlist';
    case 'savedOnly':
      return '✓ match saved (not added to a playlist)';
  }
}

function FixupRow({
  service,
  playlistId,
  track,
  alreadyInPlaylist,
  onFixed,
}: {
  service: ServiceName;
  playlistId: string;
  track: UnmatchedTrack;
  /** True for a low-confidence match (already sitting in the playlist under the wrong id);
   * false for a track that was never matched (never added at all). */
  alreadyInPlaylist: boolean;
  onFixed: (trackId: number, action: OverrideAction) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ action: OverrideAction; error?: string } | null>(null);

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
    const res = await api.overrideMatch(service, track.trackId, c.serviceId, playlistId, alreadyInPlaylist);
    setStatus({ action: res.action, error: res.playlistError });
    onFixed(track.trackId, res.action);
  };

  return (
    <li className="fixup-row">
      <div className="fixup-track">
        <strong>{track.name}</strong> <span className="hint">— {track.artistName}</span>
      </div>
      {status ? (
        <span className="hint fixup-status">
          {actionLabel(status.action)}
          {status.error ? ` — but the playlist couldn't be updated: ${status.error}` : ''}
        </span>
      ) : candidates ? (
        candidates.length === 0 ? (
          <span className="hint">no candidates</span>
        ) : (
          <div className="candidates">
            {candidates.slice(0, 6).map((c) => (
              <button key={c.serviceId} className="candidate-chip" onClick={() => pick(c)} title={`${c.name} — ${c.artistName}`}>
                {c.name} <span className="hint">· {c.artistName}</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <button className="link" onClick={find} disabled={loading}>
          {loading ? 'searching…' : 'find match'}
        </button>
      )}
    </li>
  );
}

/**
 * Lets the user resolve tracks that didn't match cleanly against a specific,
 * already-pushed playlist. Picking a candidate both remembers the match (for
 * future pushes) and mutates the live playlist right away: an unmatched track
 * gets appended; a low-confidence one (already added under the wrong id) gets
 * swapped for the corrected one. Shared by the Recipe builder's single-push
 * result and Curator's per-group push results -- same matching engine, same
 * fix-up needs either way.
 */
export function MatchFixup({
  service,
  playlistId,
  unmatched,
  lowConfidence,
  onTrackFixed,
}: {
  service: ServiceName;
  playlistId: string;
  unmatched: UnmatchedTrack[];
  lowConfidence: UnmatchedTrack[];
  /** Notified after each successful fix, so a caller can adjust a locally-displayed match count. */
  onTrackFixed?: (trackId: number, action: OverrideAction) => void;
}) {
  const rows = [
    ...unmatched.map((track) => ({ track, alreadyInPlaylist: false })),
    ...lowConfidence.map((track) => ({ track, alreadyInPlaylist: true })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="fixup">
      <h3>Fix matches</h3>
      <p className="hint">
        These tracks didn't match cleanly. Pick the right result to fix it in the playlist and remember the choice.
      </p>
      <ul className="fixup-list">
        {rows.map(({ track, alreadyInPlaylist }) => (
          <FixupRow
            key={track.trackId}
            service={service}
            playlistId={playlistId}
            track={track}
            alreadyInPlaylist={alreadyInPlaylist}
            onFixed={onTrackFixed ?? (() => {})}
          />
        ))}
      </ul>
    </div>
  );
}
