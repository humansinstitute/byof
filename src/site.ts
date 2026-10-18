import type { Database } from 'bun:sqlite';
import { nip19 } from 'nostr-tools';
import { type Config, publicKey } from './config.ts';
import { type Member, now } from './auth.ts';
import { demand, text } from './errors.ts';
import { defaultBuilderPrompt, defaultAgentName, migrateNappletPrompt } from './builder-prompt.ts';
import { verifyForwarded, type StorageConfig } from './storage.ts';
import { currentManagedStorageConfig } from './managed-storage-config.ts';
const canvasPreviewKinds = new Set(['text', 'image', 'group', 'arrow']);
function finiteGeometry(value: any) {
    return value && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
export function imageUrl(value: unknown): string {
    demand(typeof value === 'string' && value.length <= 2048, 400, 'Image URL must be at most 2048 characters');
    if (!value.trim())
        return '';
    let u: URL;
    try {
        u = new URL(value);
    }
    catch {
        demand(false, 400, 'Use an HTTPS image URL');
    }
    demand(u!.protocol === 'https:' && !u!.username && !u!.password && !u!.hash && !/^(localhost|127\.|0\.|\[|.*\.local$)/i.test(u!.hostname) && !/\.svg(?:$|\/)/i.test(u!.pathname), 400, 'Use a public HTTPS raster image URL');
    return u!.href;
}
export function installSite(db: Database, config: Config) {
    db.exec(`CREATE TABLE IF NOT EXISTS profiles(pubkey TEXT PRIMARY KEY REFERENCES members(pubkey),picture TEXT NOT NULL DEFAULT '',about TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS towers(id TEXT PRIMARY KEY,label TEXT NOT NULL,origin TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canvas_create_intents(actor TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,workshop_id TEXT NOT NULL,PRIMARY KEY(actor,intent_id));
    CREATE TABLE IF NOT EXISTS tower_accounts(connection_id TEXT NOT NULL REFERENCES towers(id),actor TEXT NOT NULL,workspaces_json TEXT NOT NULL,connected_at INTEGER NOT NULL,PRIMARY KEY(connection_id,actor));
    CREATE TABLE IF NOT EXISTS workshops(id TEXT PRIMARY KEY,title TEXT NOT NULL,introduction TEXT NOT NULL,lightning TEXT NOT NULL DEFAULT '',pictures_json TEXT NOT NULL DEFAULT '[]',owner TEXT,tower_id TEXT REFERENCES towers(id),admission TEXT NOT NULL DEFAULT 'approval',paused INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workshop_members(workshop_id TEXT NOT NULL REFERENCES workshops(id),pubkey TEXT NOT NULL REFERENCES members(pubkey),state TEXT NOT NULL,allowance INTEGER NOT NULL DEFAULT 20,created_at INTEGER NOT NULL,PRIMARY KEY(workshop_id,pubkey));
    CREATE TABLE IF NOT EXISTS workshop_prompts(workshop_id TEXT PRIMARY KEY REFERENCES workshops(id),revision INTEGER NOT NULL,text TEXT NOT NULL,agent_name TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
    for (const table of ['room', 'workshops']) {
        const columns = db.query(`PRAGMA table_info(${table})`).all() as {name:string}[];
        if (!columns.some(c => c.name === 'support_label')) db.exec(`ALTER TABLE ${table} ADD COLUMN support_label TEXT NOT NULL DEFAULT 'Support this workshop'`);
    }
    db.run("UPDATE workshop_prompts SET agent_name=?,revision=revision+1,updated_at=? WHERE agent_name='Reardon'", [defaultAgentName, now()]);
    migrateNappletPrompt(db,'workshop_prompts');
    const legacy = (db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id;
    // One-time copy; legacy tables remain authoritative for old processes and receipts.
    db.run(`INSERT OR IGNORE INTO workshops(id,title,introduction,lightning,owner,admission,paused,created_at) SELECT ?,title,introduction,lightning,?,admission,paused,? FROM room WHERE id=1`, [legacy, config.hostPubkey, now()]);
    for (const table of ['invitations', 'moderation']) {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as any[];
        if (!cols.some(c => c.name === 'workshop_id')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN workshop_id TEXT`);
            db.run(`UPDATE ${table} SET workshop_id=?`, [legacy]);
        }
        db.run(`UPDATE ${table} SET workshop_id=? WHERE workshop_id IS NULL`, [legacy]);
    }
    if (config.storage) {
        db.run('INSERT OR IGNORE INTO towers VALUES(?,?,?,?)', ['legacy-managed', 'Managed Tower', config.storage.towerOrigin, now()]);
        const tower = db.query('SELECT id FROM towers WHERE origin=?').get(config.storage.towerOrigin) as any;
        db.run('UPDATE workshops SET tower_id=COALESCE(tower_id,?) WHERE id=?', [tower.id, legacy]);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS project_workshop_immutable BEFORE UPDATE OF workshop_id ON projects WHEN OLD.workshop_id IS NOT NULL AND NEW.workshop_id IS NOT OLD.workshop_id BEGIN SELECT RAISE(ABORT,'immutable project workshop'); END;`);
}
export class Site {
    constructor(public db: Database, public config: Config) { }
    admin(member: Member) { demand(member.admin, 403, 'Site administrator access required'); }
    projectOwnerAdmitted(workshopId:string,owner:string) {
        const workshopOwner=(this.db.query('SELECT owner FROM workshops WHERE id=?').get(workshopId) as any)?.owner;
        if(workshopOwner===owner||owner===this.config.hostPubkey||!!this.config.adminPubkeys?.includes(owner))return true;
        const membership=workshopId===this.legacy()
            ? this.db.query('SELECT state FROM members WHERE pubkey=?').get(owner) as any
            : this.db.query('SELECT state FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(workshopId,owner) as any;
        return membership?.state==='admitted';
    }
    selection(request:Request) {
        const url=new URL(request.url),query=url.searchParams.has('workshop'),header=request.headers.has('x-workshop-id');
        if(query&&header)demand(url.searchParams.get('workshop')===request.headers.get('x-workshop-id'),400,'Workshop selections disagree');
        const selected=query?url.searchParams.get('workshop')!:header?request.headers.get('x-workshop-id')!:this.legacy();
        demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(selected),400,'Explicit workshop selection must be a valid workshop UUID');
        return selected;
    }
    legacy() { return (this.db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id as string; }
    profile(member: Member, body?: any) {
        if (body !== undefined) {
            const name = text(body.name, 'Display name', 60), picture = imageUrl(body.picture ?? '');
            demand(typeof body.about === 'string' && body.about.length <= 2000, 400, 'About must be at most 2000 characters');
            this.db.transaction(() => { this.db.run('UPDATE members SET name=? WHERE pubkey=?', [name, member.pubkey]); this.db.run('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(pubkey) DO UPDATE SET picture=excluded.picture,about=excluded.about', [member.pubkey, picture, body.about]); })();
        }
        const row = this.db.query('SELECT m.pubkey,m.name,m.identity_type,COALESCE(p.picture,\'\') picture,COALESCE(p.about,\'\') about FROM members m LEFT JOIN profiles p ON p.pubkey=m.pubkey WHERE m.pubkey=?').get(member.pubkey) as any;
        return { ...row, identity_type:member.identity_type, npub: nip19.npubEncode(member.pubkey), storage: 'app-local' };
    }
    canvasOverview(workshopId: string) {
        const legacy = workshopId === this.legacy();
        const projects = (this.db.query('SELECT owner FROM projects WHERE workshop_id=? AND hidden=0 AND deleted_at IS NULL').all(workshopId) as any[]).filter(project => this.projectOwnerAdmitted(workshopId,project.owner));
        const row = this.db.query('SELECT objects_json FROM workshop_boards WHERE workshop_id=?').get(workshopId) as any;
        let stored: any[] = [];
        try { const parsed = row ? JSON.parse(row.objects_json) : []; stored = Array.isArray(parsed) ? parsed : []; } catch { stored = []; }
        const decorations = stored.filter(item => finiteGeometry(item) && canvasPreviewKinds.has(item.kind));
        return { nappletCount: projects.length, decorationCount: decorations.length };
    }
    workshops(member: Member) { return (this.db.query('SELECT w.* FROM workshops w WHERE ?=1 OR w.owner=? OR (w.id=? AND EXISTS(SELECT 1 FROM members m WHERE m.pubkey=? AND m.state=\'admitted\')) OR EXISTS(SELECT 1 FROM workshop_members wm WHERE wm.workshop_id=w.id AND wm.pubkey=? AND wm.state=\'admitted\') ORDER BY w.created_at,w.id').all(Number(!!member.admin),member.pubkey,this.legacy(),member.pubkey,member.pubkey) as any[]).map(w => { if (w.id === this.legacy())
        Object.assign(w, this.db.query('SELECT title,introduction,lightning,support_label,paused,admission FROM room WHERE id=1').get()); const canManage=!!member.admin || w.owner === member.pubkey;return { ...w, pictures: JSON.parse(w.pictures_json), canManage, canDelete:canManage&&w.id!==this.legacy(), legacy:w.id===this.legacy(), overview: this.canvasOverview(w.id) }; }); }
    deleteCanvas(member:Member,id:string,body:any) {
        const canvas=this.db.query('SELECT id,title,owner FROM workshops WHERE id=?').get(id) as any;
        demand(canvas,404,'Canvas not found');
        demand(!!member.admin||canvas.owner===member.pubkey,403,'Canvas owner or site administrator access required');
        demand(id!==this.legacy(),409,'The default Canvas cannot be deleted because Freedom Tools requires it for legacy links and bootstrap state');
        demand(body?.confirmPermanent===true&&body?.confirmText==='CONFIRM',400,'Type CONFIRM and confirm permanent deletion');
        const immutableDeletes=['epoch_history_no_delete','host_request_audit_no_delete','project_admin_audit_no_delete','project_fork_no_delete','request_attachment_no_delete','request_engine_correction_no_delete','request_engine_no_delete','request_epoch_no_delete','request_prompt_no_delete','revision_no_delete'];
        const triggers=this.db.query(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${immutableDeletes.map(()=>'?').join(',')})`).all(...immutableDeletes) as {name:string;sql:string}[];
        const projectScope='SELECT id FROM projects WHERE workshop_id=?';
        const requestScope=`SELECT id FROM requests WHERE project_id IN (${projectScope})`;
        const revisionScope=`SELECT id FROM revisions WHERE project_id IN (${projectScope})`;
        const snapshotScope="SELECT id FROM publication_snapshots WHERE json_extract(body_json,'$.workshopId')=?";
        return this.db.transaction(()=>{
            // These triggers protect ordinary lifecycle history. This single immediate
            // transaction is the only path that may remove a complete Canvas graph.
            for(const trigger of triggers)this.db.exec(`DROP TRIGGER ${trigger.name}`);

            this.db.run(`DELETE FROM publication_claims WHERE snapshot_id IN (${snapshotScope})`,[id]);
            this.db.run(`DELETE FROM publication_operations WHERE snapshot_id IN (${snapshotScope})`,[id]);
            this.db.run("DELETE FROM publication_snapshots WHERE json_extract(body_json,'$.workshopId')=?",[id]);
            this.db.run('DELETE FROM hosted_publication_exclusions WHERE workshop_id=?',[id]);
            this.db.run('DELETE FROM hosted_publications WHERE workshop_id=?',[id]);

            this.db.run(`DELETE FROM activity_receipts WHERE run_id IN (SELECT run_id FROM activity_authority WHERE workshop_id=? OR project_id IN (${projectScope})) OR run_id IN (SELECT invocation_run_id FROM activity_recovery_lineage WHERE request_id IN (${requestScope}))`,[id,id,id]);
            this.db.run(`DELETE FROM activity_turns WHERE run_id IN (SELECT run_id FROM activity_authority WHERE workshop_id=? OR project_id IN (${projectScope}))`,[id,id]);
            this.db.run(`DELETE FROM activity_recovery_lineage WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM request_activity WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM activity_authority WHERE workshop_id=? OR project_id IN (${projectScope})`,[id,id]);

            this.db.run(`DELETE FROM request_attachments WHERE request_id IN (${requestScope}) OR attachment_id IN (SELECT id FROM chat_attachments WHERE workshop_id=?)`,[id,id]);
            this.db.run(`DELETE FROM remote_versions WHERE revision_id IN (${revisionScope}) OR job_id IN (SELECT id FROM storage_jobs WHERE workshop_id=?)`,[id,id]);
            this.db.run('DELETE FROM chat_attachments WHERE workshop_id=?',[id]);
            this.db.run(`DELETE FROM storage_jobs WHERE workshop_id=? OR request_id IN (${requestScope})`,[id,id]);

            for(const table of ['agent_publications','automatic_recovery','build_receipts','delivery_receipts','dispatch_receipts','final_message_receipts','host_request_audit','replacement_attempts','request_builder_prompts','request_dispatch','request_recoveries'])
                this.db.run(`DELETE FROM ${table} WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM request_builder_engine_corrections WHERE request_id IN (SELECT request_id FROM request_builder_engines WHERE request_id IN (${requestScope}))`,[id]);
            this.db.run(`DELETE FROM request_builder_engines WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM local_builds WHERE project_id IN (${projectScope}) OR request_id IN (${requestScope})`,[id,id]);
            this.db.run(`DELETE FROM request_epochs WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM request_epoch_history WHERE request_id IN (${requestScope})`,[id]);
            this.db.run(`DELETE FROM requests WHERE project_id IN (${projectScope})`,[id]);

            this.db.run(`DELETE FROM builder_delete_deliveries WHERE run_id IN (SELECT run_id FROM builder_deletions WHERE project_id IN (${projectScope}))`,[id]);
            this.db.run(`DELETE FROM builder_deletions WHERE project_id IN (${projectScope})`,[id]);
            this.db.run(`DELETE FROM builder_epochs WHERE project_id IN (${projectScope})`,[id]);
            this.db.run(`DELETE FROM conversation_receipts WHERE project_id IN (${projectScope})`,[id]);
            this.db.run(`DELETE FROM consent WHERE project_id IN (${projectScope})`,[id]);
            this.db.run('DELETE FROM project_admin_audit WHERE workshop_id=?',[id]);
            this.db.run('DELETE FROM project_forks WHERE workshop_id=?',[id]);
            this.db.run('DELETE FROM napplet_user_data WHERE workshop_id=?',[id]);
            this.db.run(`UPDATE projects SET current_revision=NULL,shared_revision=NULL,origin_project=NULL,origin_revision=NULL WHERE workshop_id=?`,[id]);
            this.db.run(`DELETE FROM revisions WHERE project_id IN (${projectScope})`,[id]);
            this.db.run('DELETE FROM projects WHERE workshop_id=?',[id]);

            for(const table of ['canvas_create_intents','invitations','moderation','workshop_board_images','workshop_boards','builder_engines','canvas_dataset_bindings','tower_storage_grants','workshop_storage_bindings','managed_workshop_storage','workshop_members','workshop_prompts'])
                this.db.run(`DELETE FROM ${table} WHERE workshop_id=?`,[id]);
            demand(this.db.run('DELETE FROM workshops WHERE id=?',[id]).changes===1,404,'Canvas not found');

            for(const trigger of triggers)this.db.exec(trigger.sql);
            return {deletedCanvasId:id,externalDataRetained:true,message:'Canvas deleted from Freedom Tools. Externally stored datasets and published artifacts were not deleted.'};
        }).immediate();
    }
    create(member: Member, body: any) {
        this.admin(member);
        const title = text(body.title, 'Workshop title', 120), intro = text(body.introduction || 'Welcome to our workshop.', 'Introduction', 3000);
        let owner: string;
        try {
            owner = body.owner ? publicKey(body.owner) : member.pubkey;
        }
        catch {
            demand(false, 400, 'Owner must be a public npub or hex identity');
        }
        demand(!body.towerId || this.db.query('SELECT id FROM towers WHERE id=?').get(body.towerId), 400, 'Select a registered Tower');
        const payload=JSON.stringify({title,intro,owner:owner!,towerId:body.towerId||null});
        if(body.idempotencyKey){
            demand(/^[0-9a-f-]{36}$/.test(body.idempotencyKey),400,'Invalid Canvas creation intent');
            const prior=this.db.query('SELECT * FROM canvas_create_intents WHERE actor=? AND intent_id=?').get(member.pubkey,body.idempotencyKey) as any;
            if(prior){demand(prior.payload===payload,409,'Canvas details changed after setup started; complete the saved Canvas');return this.workshops(member).find(w=>w.id===prior.workshop_id);}
        }
        const id = crypto.randomUUID();
        this.db.transaction(() => { this.db.run('INSERT INTO workshops(id,title,introduction,owner,tower_id,created_at) VALUES(?,?,?,?,?,?)', [id, title, intro, owner!, body.towerId || null, now()]); this.db.run('INSERT INTO workshop_prompts VALUES(?,?,?,?,?)', [id, 1, defaultBuilderPrompt, defaultAgentName, now()]); if(body.idempotencyKey)this.db.run('INSERT INTO canvas_create_intents VALUES(?,?,?,?)',[member.pubkey,body.idempotencyKey,payload,id]); })();
        return this.workshops(member).find(w => w.id === id);
    }
    towers(member: Member) { this.admin(member); return (this.db.query('SELECT * FROM towers ORDER BY created_at').all() as any[]).map(t => ({ ...t, connected: !!this.db.query('SELECT actor FROM tower_accounts WHERE connection_id=? AND actor=?').get(t.id, member.pubkey), status: 'registered', activationRequirement: 'Browser authorization for the selected workspace, managed app execution and successful private upload/readback are required' })); }
    register(member: Member, body: any) { this.admin(member); let u: URL; try {
        u = new URL(body.origin);
    }
    catch {
        demand(false, 400, 'Tower must be an HTTPS origin');
    } demand(u!.protocol === 'https:' && u!.origin === body.origin && !u!.username && !u!.password && !/^(localhost|127\.|0\.|\[|.*\.local$)/i.test(u!.hostname), 400, 'Tower must be a public HTTPS origin with no path'); const id = crypto.randomUUID(); demand(!this.db.query('SELECT id FROM towers WHERE origin=?').get(u!.origin), 409, 'Tower already registered'); this.db.run('INSERT INTO towers VALUES(?,?,?,?)', [id, text(body.label, 'Tower name', 80), u!.origin, now()]); return this.towers(member); }
    async connect(member: Member, id: string, body: any, persist = true) { this.admin(member); const t = this.db.query('SELECT * FROM towers WHERE id=?').get(id) as any; demand(t, 404, 'Tower not found'); const url = t.origin + '/api/v4/flightdeck-pg/workspaces'; verifyForwarded(body.event, member.pubkey, url, 'GET'); const r = await fetch(url, { headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(body.event)).toString('base64') }, redirect: 'error', signal: AbortSignal.timeout(15000) }); demand(r.ok, r.status, 'Tower authorization failed'); const data = await r.json(); demand(Array.isArray(data.workspaces), 502, 'Invalid Tower workspace list'); if(persist)this.db.run('INSERT INTO tower_accounts VALUES(?,?,?,?) ON CONFLICT(connection_id,actor) DO UPDATE SET workspaces_json=excluded.workspaces_json,connected_at=excluded.connected_at', [id, member.pubkey, JSON.stringify(data.workspaces), now()]); return { workspaces: data.workspaces, status: 'connected-unprobed' }; }
    storage(workshopId: string): StorageConfig | undefined { const w = this.db.query('SELECT tower_id FROM workshops WHERE id=?').get(workshopId) as any;
        // An admin-created board inherits the installation's already verified
        // default private storage destination. This adds no participant ACL or
        // board activation switch; explicit Tower selections retain their binding.
        const base=this.config.storage;
        if(w&&!w.tower_id&&base&&this.config.followup?.agentPublication){
            const ready=this.db.query("SELECT * FROM storage_binding WHERE installation_id=? AND workshop_id=? AND status='ready'").get(base.installationId,base.workshopId) as any;
            if(ready){
                const prepared={...base,workshopId};
                this.db.run('INSERT OR IGNORE INTO workshop_storage_bindings(workshop_id,installation_id,target_json,local_root,status,connected_actor,namespace_json) VALUES(?,?,?,?,?,?,?)',[workshopId,base.installationId,ready.target_json,base.localRoot,'ready',ready.connected_actor,ready.namespace_json]);
                const pinned=this.db.query('SELECT * FROM workshop_storage_bindings WHERE workshop_id=?').get(workshopId) as any;
                demand(pinned.installation_id===base.installationId&&pinned.target_json===ready.target_json&&pinned.local_root===base.localRoot,409,'Default workshop storage binding changed');
                return prepared;
            }
        }
        const tower = w?.tower_id && this.db.query('SELECT origin FROM towers WHERE id=?').get(w.tower_id) as any; const exact=[this.config.storage, ...(this.config.workshopStorage || [])].find(s => s && s.workshopId === workshopId && s.towerOrigin === tower?.origin);
        if(exact)return exact;
        const template=this.config.storageTemplates?.find(s=>s.towerOrigin===tower?.origin) ?? (tower && this.config.managedStorage ? {...this.config.managedStorage,towerOrigin:tower.origin}:undefined);
        if(!template)return undefined;
        // Existing exact connectors remain pinned. The installation-wide worker
        // requires browser/native grants for new destinations and immutable jobs.
        const prepared={...template,workshopId};
        this.db.run('INSERT OR IGNORE INTO managed_workshop_storage(workshop_id,tower_id,config_json) VALUES(?,?,?)',[workshopId,w.tower_id,JSON.stringify(prepared)]);
        this.db.run('UPDATE managed_workshop_storage SET config_json=? WHERE workshop_id=? AND config_json IS NULL',[JSON.stringify(prepared),workshopId]);
        const configured=this.db.query('SELECT tower_id,config_json FROM managed_workshop_storage WHERE workshop_id=?').get(workshopId) as any;
        demand(configured.tower_id===w.tower_id,409,'Workshop storage Tower is already configured; migrate before changing it');
        const stored=JSON.parse(configured.config_json);
        try{return currentManagedStorageConfig(stored,template,workshopId);}
        catch{demand(false,409,'Workshop installation authority changed');} }
}
