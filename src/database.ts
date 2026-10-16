import {installAgentPublication} from './agent-publication.ts';
import { installActivityTables } from './activity-store.ts';
import {installBuilderEngines} from './builder-engine.ts';
import { installBuilderPrompt } from './builder-prompt.ts';
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
export function openDatabase(directory: string): Database {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = join(directory, "workshop.sqlite"), db = new Database(path, { create: true, strict: true }); chmodSync(path, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), title TEXT NOT NULL, introduction TEXT NOT NULL, lightning TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0, admission TEXT NOT NULL DEFAULT 'invitation');
    INSERT OR IGNORE INTO room(id,title,introduction) VALUES(1,'Build what you need','We’re working together to build a page worth sharing. Make a small app, remix an idea, and leave your mark.');
    CREATE TABLE IF NOT EXISTS members (pubkey TEXT PRIMARY KEY, name TEXT NOT NULL, identity_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', allowance INTEGER NOT NULL DEFAULT 20, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY, remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, pubkey TEXT NOT NULL REFERENCES members(pubkey), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES members(pubkey), title TEXT NOT NULL, description TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE, current_revision TEXT REFERENCES revisions(id), shared_revision TEXT REFERENCES revisions(id), hidden INTEGER NOT NULL DEFAULT 0, origin_project TEXT REFERENCES projects(id), origin_revision TEXT REFERENCES revisions(id), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL, parent_id TEXT REFERENCES revisions(id), restored_from TEXT REFERENCES revisions(id), source_hash TEXT NOT NULL, author TEXT NOT NULL REFERENCES members(pubkey), created_at INTEGER NOT NULL, UNIQUE(project_id,number));
    CREATE TABLE IF NOT EXISTS consent (project_id TEXT NOT NULL REFERENCES projects(id), revision_id TEXT NOT NULL REFERENCES revisions(id), author TEXT NOT NULL REFERENCES members(pubkey), granted INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,revision_id));
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), prompt TEXT NOT NULL, expected_revision TEXT NOT NULL REFERENCES revisions(id), status TEXT NOT NULL, error TEXT, run_id TEXT UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS moderation (id TEXT PRIMARY KEY, actor TEXT NOT NULL, member TEXT NOT NULL REFERENCES members(pubkey), action TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS project_revision_scope BEFORE UPDATE OF current_revision,shared_revision ON projects
    WHEN (NEW.current_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revisions WHERE id=NEW.current_revision AND project_id=NEW.id)) OR (NEW.shared_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revisions WHERE id=NEW.shared_revision AND project_id=NEW.id)) BEGIN SELECT RAISE(ABORT,'revision project mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS consent_scope BEFORE INSERT ON consent
    WHEN NOT EXISTS(SELECT 1 FROM revisions r JOIN projects p ON p.id=r.project_id WHERE r.id=NEW.revision_id AND p.id=NEW.project_id AND p.owner=NEW.author) BEGIN SELECT RAISE(ABORT,'consent project mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS request_revision_scope BEFORE INSERT ON requests
    WHEN NOT EXISTS(SELECT 1 FROM revisions WHERE id=NEW.expected_revision AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'request project mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS revision_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
    CREATE TRIGGER IF NOT EXISTS revision_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;`);
  const sessionColumns=db.query('PRAGMA table_info(sessions)').all() as {name:string}[];
  if(!sessionColumns.some(c=>c.name==='identity_type'))db.exec('ALTER TABLE sessions ADD COLUMN identity_type TEXT');
  const columns = db.query("PRAGMA table_info(requests)").all() as { name: string }[];
  for (const [name, type] of [['response','TEXT'],['mode',"TEXT NOT NULL DEFAULT 'auto'"]]) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS request_dispatch (request_id TEXT PRIMARY KEY REFERENCES requests(id), input_json TEXT NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS conversation_receipts (project_id TEXT PRIMARY KEY REFERENCES projects(id), native_id TEXT NOT NULL, sequence INTEGER NOT NULL, receipt_json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_project_request ON requests(project_id) WHERE status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain');`);
  db.exec(`CREATE TABLE IF NOT EXISTS builder_epochs(project_id TEXT NOT NULL REFERENCES projects(id),generation INTEGER NOT NULL,conversation_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT,created_at INTEGER NOT NULL,retired_at INTEGER,native_id TEXT,sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,generation));
    CREATE TABLE IF NOT EXISTS request_epochs(request_id TEXT PRIMARY KEY REFERENCES requests(id),project_id TEXT NOT NULL,generation INTEGER NOT NULL,native_request_id TEXT NOT NULL UNIQUE,context_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,FOREIGN KEY(project_id,generation) REFERENCES builder_epochs(project_id,generation));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS request_epoch_no_update BEFORE UPDATE ON request_epochs BEGIN SELECT RAISE(ABORT,'immutable replacement snapshot'); END;
    CREATE TRIGGER IF NOT EXISTS request_epoch_no_delete BEFORE DELETE ON request_epochs BEGIN SELECT RAISE(ABORT,'immutable replacement snapshot'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS replacement_attempts(request_id TEXT NOT NULL REFERENCES requests(id),run_id TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(request_id,run_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS request_epoch_history(request_id TEXT NOT NULL REFERENCES requests(id),project_id TEXT NOT NULL,generation INTEGER NOT NULL,native_request_id TEXT NOT NULL UNIQUE,context_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(request_id,generation),FOREIGN KEY(project_id,generation) REFERENCES builder_epochs(project_id,generation));
    INSERT OR IGNORE INTO request_epoch_history SELECT * FROM request_epochs;
    CREATE TRIGGER IF NOT EXISTS epoch_history_no_update BEFORE UPDATE ON request_epoch_history BEGIN SELECT RAISE(ABORT,'immutable replacement snapshot'); END;
    CREATE TRIGGER IF NOT EXISTS epoch_history_no_delete BEFORE DELETE ON request_epoch_history BEGIN SELECT RAISE(ABORT,'immutable replacement snapshot'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS builder_deletions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),generation INTEGER NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT UNIQUE,claimed_at INTEGER NOT NULL DEFAULT 0,receipt_json TEXT,error TEXT,UNIQUE(project_id,generation));
    CREATE TABLE IF NOT EXISTS builder_delete_deliveries(delivery_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,body_hash TEXT NOT NULL,result_json TEXT NOT NULL);`);
  db.exec(`DROP INDEX IF EXISTS one_active_project_request;
    CREATE UNIQUE INDEX one_active_project_request ON requests(project_id) WHERE status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain');`);
  db.exec(`CREATE TABLE IF NOT EXISTS host_request_audit(request_id TEXT PRIMARY KEY REFERENCES requests(id),actor TEXT NOT NULL REFERENCES members(pubkey),project_owner TEXT NOT NULL REFERENCES members(pubkey),reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS host_request_audit_no_update BEFORE UPDATE ON host_request_audit BEGIN SELECT RAISE(ABORT,'immutable host request audit'); END;
    CREATE TRIGGER IF NOT EXISTS host_request_audit_no_delete BEFORE DELETE ON host_request_audit BEGIN SELECT RAISE(ABORT,'immutable host request audit'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS workshop_identity(id INTEGER PRIMARY KEY CHECK(id=1),workshop_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS local_builds(request_id TEXT PRIMARY KEY REFERENCES requests(id),project_id TEXT NOT NULL REFERENCES projects(id),directory TEXT NOT NULL,version INTEGER NOT NULL,artifact_path TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',source_hash TEXT,revision_id TEXT REFERENCES revisions(id));`);
  const buildColumns=db.query('PRAGMA table_info(local_builds)').all() as {name:string}[];
  if(!buildColumns.some(c=>c.name==='storage_required'))db.exec('ALTER TABLE local_builds ADD COLUMN storage_required INTEGER NOT NULL DEFAULT 0');
  db.run('INSERT OR IGNORE INTO workshop_identity VALUES(1,?)',[crypto.randomUUID()]);
  const projectColumns=db.query('PRAGMA table_info(projects)').all() as {name:string}[];
  if(!projectColumns.some(c=>c.name==='workshop_id'))db.exec('ALTER TABLE projects ADD COLUMN workshop_id TEXT');
  db.exec('UPDATE projects SET workshop_id=(SELECT workshop_id FROM workshop_identity WHERE id=1) WHERE workshop_id IS NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS project_forks(
      workshop_id TEXT NOT NULL,
      actor TEXT NOT NULL REFERENCES members(pubkey),
      idempotency_key TEXT NOT NULL,
      source_project TEXT NOT NULL REFERENCES projects(id),
      source_revision TEXT NOT NULL REFERENCES revisions(id),
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workshop_id,actor,idempotency_key)
    );
    CREATE TRIGGER IF NOT EXISTS project_fork_no_update BEFORE UPDATE ON project_forks BEGIN SELECT RAISE(ABORT,'immutable project fork'); END;
    CREATE TRIGGER IF NOT EXISTS project_fork_no_delete BEFORE DELETE ON project_forks BEGIN SELECT RAISE(ABORT,'immutable project fork'); END;
    CREATE TRIGGER IF NOT EXISTS project_fork_scope BEFORE INSERT ON project_forks
    WHEN NOT EXISTS(SELECT 1 FROM revisions r JOIN projects source ON source.id=r.project_id JOIN projects fork ON fork.id=NEW.project_id WHERE r.id=NEW.source_revision AND source.id=NEW.source_project AND source.workshop_id=NEW.workshop_id AND fork.workshop_id=NEW.workshop_id AND fork.owner=NEW.actor)
    BEGIN SELECT RAISE(ABORT,'fork project mismatch'); END;`);
  installAgentPublication(db);
  installBuilderPrompt(db);installBuilderEngines(db);
  installActivityTables(db);
  return db;
}
