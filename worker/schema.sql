-- che-canzone — schema del database Cloudflare D1
-- Eseguire una volta nella Console D1 (dashboard Cloudflare) oppure con:
--   wrangler d1 execute che-canzone --file worker/schema.sql
--
-- Nessuna PII: solo la frase dettata da Stefano e i metadati della canzone.

CREATE TABLE IF NOT EXISTS lookups (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,          -- ISO 8601, UTC (es. 2026-08-31T09:12:44.000Z)
  query   TEXT NOT NULL,          -- frase dettata dall'utente
  title   TEXT NOT NULL,          -- titolo scelto (canonico iTunes se disponibile)
  artist  TEXT NOT NULL,
  year    TEXT,
  album   TEXT
);

CREATE INDEX IF NOT EXISTS idx_lookups_ts ON lookups (ts);
