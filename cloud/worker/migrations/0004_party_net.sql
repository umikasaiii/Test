-- DSLink phase 7: Party Voice (membership + invites only: the Cloud never sees, records or stores any audio) and the per-game network profile override.
ALTER TABLE game_metadata ADD COLUMN network_profile TEXT NOT NULL DEFAULT '';   -- '' = derived from cloud/web/play/netprofiles.json; an admin may pin LOW_LATENCY_REQUIRED | NORMAL | UNKNOWN

CREATE TABLE parties (
  id           TEXT PRIMARY KEY,                 -- random, not enumerable
  owner        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  max_members  INTEGER NOT NULL DEFAULT 8
);
CREATE TABLE party_members (
  party_id    TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (party_id, user_id)
);
CREATE UNIQUE INDEX party_members_user ON party_members(user_id);   -- one party at a time, enforced by the database (no race)
CREATE TABLE party_invites (
  id          TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,                      -- pending | accepted | refused | cancelled | expired
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX party_invites_to ON party_invites(to_user, status);
CREATE INDEX party_invites_party ON party_invites(party_id, status);
