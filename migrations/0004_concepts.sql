CREATE TABLE concept_actions(id TEXT PRIMARY KEY,revision INTEGER UNIQUE NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE concept_mappings(source_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,target_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,action_id TEXT NOT NULL REFERENCES concept_actions(id));
CREATE TABLE concept_aliases(id TEXT PRIMARY KEY,concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,alias TEXT NOT NULL,action_id TEXT NOT NULL REFERENCES concept_actions(id),UNIQUE(concept_id,alias));
INSERT INTO settings(key,value) VALUES('concept_revision','0');
