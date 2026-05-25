import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = process.env.MEMELOOP_CLOUD_DB_DIR || path.join(process.cwd(), "data");
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const dbPath = path.join(DB_DIR, "memeloop-cloud.db");
const db: Database = new Database(dbPath);
export { db };

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('build', 'plan', 'explore', 'oracle', 'librarian')),
    description TEXT,
    skills TEXT DEFAULT '[]',
    prompt TEXT
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT,
    tools TEXT DEFAULT '[]'
  );
`);
