-- DSLink Cloud: relational metadata only. No ROM/BIOS/save blobs here (those live in the private R2 bucket).
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  pw_hash       TEXT,            -- PBKDF2-SHA256 (WebCrypto), NULL for passkey-only accounts
  pw_salt       TEXT,
  pw_iters      INTEGER
);

CREATE TABLE credentials (        -- WebAuthn / passkeys
  id          TEXT PRIMARY KEY,   -- credential id (base64url)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,      -- COSE public key, base64url
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE auth_sessions (      -- login sessions; only the SHA-256 of the bearer token is stored
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  device      TEXT
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE challenges (         -- one-shot WebAuthn challenges
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  data        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE login_attempts (     -- brute-force throttle for password login
  key         TEXT PRIMARY KEY,
  failures    INTEGER NOT NULL,
  window_end  INTEGER NOT NULL
);

CREATE TABLE friend_requests (
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,      -- pending | accepted | refused | cancelled
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX friend_requests_pending ON friend_requests(from_user, to_user) WHERE status = 'pending';
CREATE INDEX friend_requests_to ON friend_requests(to_user, status);

CREATE TABLE friendships (        -- one row per pair, user_a < user_b
  user_a      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX friendships_b ON friendships(user_b);

CREATE TABLE games (              -- the user's PRIVATE library
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  platform    TEXT NOT NULL,      -- nds | ps1
  status      TEXT NOT NULL,      -- pending | ready
  created_at  INTEGER NOT NULL
);
CREATE INDEX games_user ON games(user_id);

CREATE TABLE game_files (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,      -- rom | cue | bin | chd
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX game_files_game ON game_files(game_id);

CREATE TABLE system_files (       -- BIOS / firmware, per user, never shared
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, platform, name)
);

CREATE TABLE saves (              -- metadata only; the bytes are in R2
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,      -- sram | memcard1 | memcard2
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (game_id, kind)
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,      -- pending | accepted | refused | expired | cancelled
  session_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX invites_to ON invites(to_user, status);

CREATE TABLE play_sessions (      -- history
  id          TEXT PRIMARY KEY,
  host_user   TEXT NOT NULL,
  guest_user  TEXT NOT NULL,
  game_title  TEXT NOT NULL,
  platform    TEXT NOT NULL,
  status      TEXT NOT NULL,      -- created | running | ended
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX play_sessions_host ON play_sessions(host_user);
CREATE INDEX play_sessions_guest ON play_sessions(guest_user);
