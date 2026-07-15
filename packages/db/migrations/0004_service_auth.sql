-- OAuth tokens for the streaming services. access_token/refresh_token are
-- stored encrypted (AES-256-GCM) at rest; the key lives in data/secret.key,
-- outside the DB. One row per connected service.
CREATE TABLE service_auth (
  service TEXT PRIMARY KEY,        -- 'spotify' | 'tidal'
  access_token TEXT NOT NULL,      -- encrypted blob
  refresh_token TEXT,              -- encrypted blob (may be absent)
  expires_at INTEGER NOT NULL,     -- unix seconds
  scope TEXT,
  updated_at INTEGER NOT NULL
);
