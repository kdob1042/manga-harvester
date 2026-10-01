CREATE TABLE reflections (
 id TEXT PRIMARY KEY,
 generation_id TEXT NOT NULL UNIQUE REFERENCES generations(id) ON DELETE CASCADE,
 target_generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
 data TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE revisit_events (
 id TEXT PRIMARY KEY,
 reflection_id TEXT NOT NULL REFERENCES reflections(id) ON DELETE CASCADE,
 action TEXT NOT NULL CHECK(action IN ('shown','opened','dismissed')),
 created_at INTEGER NOT NULL,
 UNIQUE(reflection_id,action)
);
CREATE INDEX revisit_events_time ON revisit_events(created_at);
