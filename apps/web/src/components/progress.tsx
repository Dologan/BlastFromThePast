import type { SyncStatus } from '../api';

/** Human-readable description of a job's current progress, per job kind. */
export function progressText(status: SyncStatus): string | null {
  const p = status.progress;
  if (!status.running || !p) return null;
  if ('kind' in p && p.kind === 'enrich') {
    if (p.phase === 'fetch') {
      return `Fetching metadata — MusicBrainz ${p.mbProcessed}/${p.mbTotal}, Last.fm ${p.lastfmProcessed}/${p.lastfmTotal}`;
    }
    return `Applying to library — ${p.processed} of ${p.total} artists`;
  }
  if ('kind' in p && p.kind === 'enrich-albums') {
    return `Fetching release dates — ${p.processed} of ${p.total} albums`;
  }
  if ('kind' in p && p.kind === 'service-liked') {
    return `Importing ${p.source} liked — ${p.linked} matched of ${p.seen} seen`;
  }
  if ('kind' in p && p.kind === 'push') {
    return `Building playlist — matched ${p.matched} of ${p.processed}/${p.total}`;
  }
  if ('kind' in p && p.kind === 'playlist-inventory') {
    return `Syncing ${p.service} playlists — ${p.playlistsDone} of ${p.playlistsTotal}`;
  }
  if ('kind' in p && p.kind === 'curate') {
    return `Pushing "${p.currentName}" — playlist ${p.playlistsDone + 1} of ${p.playlistsTotal} (matched ${p.matched} of ${p.processed}/${p.total} tracks)`;
  }
  if ('kind' in p && p.kind === 'unlike') {
    return `Unliking — ${p.processed} of ${p.total}`;
  }
  if ('phase' in p) {
    if (p.phase === 'scrobbles' && p.totalPages) return `Scrobbles: page ${p.page} of ${p.totalPages} — ${p.inserted} new`;
    if (p.phase === 'loved') return `Loved tracks: page ${p.page ?? 1}`;
    return 'Rebuilding stats…';
  }
  return null;
}

/** Fraction (0–1) of a job's progress, when it can be computed; null when indeterminate. */
export function progressFraction(status: SyncStatus): number | null {
  const p = status.progress;
  if (!status.running || !p || !('kind' in p)) return null;
  switch (p.kind) {
    case 'push':
      return p.total > 0 ? p.processed / p.total : null;
    case 'unlike':
      return p.total > 0 ? p.processed / p.total : null;
    case 'playlist-inventory':
      return p.playlistsTotal > 0 ? p.playlistsDone / p.playlistsTotal : null;
    case 'curate': {
      // Blend "playlists completed" with progress through the current playlist's tracks,
      // so the bar still creeps forward while a single large playlist is being built.
      if (p.playlistsTotal <= 0) return null;
      const withinCurrent = p.total > 0 ? p.processed / p.total : 0;
      return (p.playlistsDone + withinCurrent) / p.playlistsTotal;
    }
    case 'enrich':
      if (p.phase === 'derive') return p.total > 0 ? p.processed / p.total : null;
      return null;
    case 'enrich-albums':
      return p.total > 0 ? p.processed / p.total : null;
    default:
      return null;
  }
}

/** A labelled progress bar for a running job; falls back to an indeterminate animation
 * when the job doesn't report a computable fraction (e.g. paginated imports). */
export function ProgressBar({ status, fallbackText }: { status: SyncStatus | null; fallbackText?: string }) {
  if (!status?.running) return null;
  const text = progressText(status) ?? fallbackText ?? 'Working…';
  const fraction = progressFraction(status);
  return (
    <div className="progress">
      <div className={`progress-track${fraction === null ? ' indeterminate' : ''}`}>
        {fraction !== null && (
          <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%` }} />
        )}
      </div>
      <p className="hint progress-label">{text}</p>
    </div>
  );
}
