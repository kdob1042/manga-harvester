CREATE TABLE capture_tombstones(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
CREATE TABLE deletion_requests(request_key TEXT PRIMARY KEY,capture_id TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE retired_requests(request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,capture_id TEXT NOT NULL,deleted_at INTEGER NOT NULL);
INSERT INTO settings(key,value) VALUES('instance_id',lower(hex(randomblob(16))));
