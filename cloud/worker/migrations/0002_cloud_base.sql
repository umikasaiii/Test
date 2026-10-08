-- DSLink Cloud base (phase 5): accounts hardening, blocks, generic game catalog + library METADATA, room invites.
-- Nothing here ever holds a ROM, BIOS, firmware, save or radio frame: only identifiers and titles.
ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';          -- active | disabled
ALTER TABLE auth_sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE blocks (                -- blocker no longer sees / is reachable by blocked
  blocker     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker != blocked)
);
CREATE INDEX blocks_blocked ON blocks(blocked);

CREATE TABLE game_metadata (         -- generic catalog: one row per game, any platform / core
  game_id                  TEXT PRIMARY KEY,           -- e.g. nds-amps (platform + product code), stable across devices
  platform                 TEXT NOT NULL,              -- nds | ps1 | gba | ... (free for future cores)
  title                    TEXT NOT NULL,
  product_code             TEXT NOT NULL DEFAULT '',
  core_id                  TEXT NOT NULL DEFAULT '',
  multiplayer_mode         TEXT NOT NULL DEFAULT 'none',   -- none | distributed | download_play | both
  download_play_supported  INTEGER NOT NULL DEFAULT 0,
  metadata_version         INTEGER NOT NULL DEFAULT 1,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE library_entries (       -- the user's library as METADATA: which games they own, not the files
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL REFERENCES game_metadata(game_id),
  favorite     INTEGER NOT NULL DEFAULT 0,
  last_played  INTEGER NOT NULL DEFAULT 0,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX library_entries_game ON library_entries(game_id);

CREATE TABLE room_invites (          -- "invite a friend to play": the room itself lives in a Durable Object, here only the pairing
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id     TEXT NOT NULL REFERENCES game_metadata(game_id),
  status      TEXT NOT NULL,         -- pending | accepted | refused | cancelled | expired
  room_code   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX room_invites_to ON room_invites(to_user, status);
CREATE INDEX room_invites_from ON room_invites(from_user, status);
