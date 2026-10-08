-- DSLink Cloud storage (phase 6): the user's OWN files in a PRIVATE R2 bucket, reachable only through the authenticated Worker. D1 holds identifiers, sizes and hashes - never content.
CREATE TABLE cloud_files (            -- one ready file per (user, kind, name): game = nds-<product code>, system = bios7.bin / bios9.bin / firmware.bin
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- game | system
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,           -- verified by the Worker on completion (dedup per user, integrity, stable identity)
  r2_key      TEXT NOT NULL,           -- opaque: u/<user>/cf/<kind>/<random>; never derived from a file name
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, name)
);

CREATE TABLE cloud_uploads (          -- an upload in progress (resumable by part); expires and is cleaned up
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  r2_key      TEXT NOT NULL,
  mode        TEXT NOT NULL,           -- single | multipart
  upload_id   TEXT NOT NULL DEFAULT '',
  chunk       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX cloud_uploads_user ON cloud_uploads(user_id);
CREATE TABLE cloud_upload_parts (
  upload_id   TEXT NOT NULL REFERENCES cloud_uploads(id) ON DELETE CASCADE,
  part        INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part)
);

CREATE TABLE cloud_saves (            -- save history: revisions are linear (1, 2, 3 ...), the last few are kept
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  device_id    TEXT NOT NULL,
  device_name  TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',   -- '' | restore:<revision>
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, game_id, revision)
);
