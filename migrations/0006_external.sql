CREATE TABLE external_sources (
 id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 request_key TEXT UNIQUE NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,quote TEXT NOT NULL,
 source_type TEXT NOT NULL,speaker TEXT,published_at TEXT,scope TEXT NOT NULL,
 provenance TEXT NOT NULL DEFAULT 'user_provided',received_at INTEGER NOT NULL,
 UNIQUE(capture_id,url,quote)
);
CREATE TABLE research_daily(day TEXT PRIMARY KEY,runs INTEGER NOT NULL DEFAULT 0);
CREATE TABLE research_runs (
 id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 capture_version INTEGER NOT NULL,view_id TEXT REFERENCES views(id) ON DELETE SET NULL,base_revision INTEGER,
 question TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,dispatched_at INTEGER,lease_until INTEGER,lease_token TEXT,error_code TEXT,
 search_json TEXT,result_json TEXT,adopted_revision INTEGER,created_at INTEGER NOT NULL,finished_at INTEGER
);
CREATE INDEX research_ready ON research_runs(state,available_at,dispatched_at);
