import {loadBuilderEngine,builderAgents,runtimeForAgent} from './builder-engine.ts';
import {runtimeAvailable} from './pipeline/builder-runtime.ts';
import {cancelUnsentRequest} from './queued-recovery.ts';
import { recoverWorkshopBuilders } from './workshop-recovery.ts';
import { installActivityTables, storeActivity } from './activity-store.ts';
import { verifyActivity } from './pipeline/activity-receiver.ts';
import encodeQR from 'qr';
import { codeAttempt, normalizedInvitation, shortInvitation } from './invitation-codes.ts';
import { sha256 } from './assets.ts';
import { uploadBoardImage, readBoardImage } from './workshop-images.ts';
import { CanvasRuntime } from './canvas-runtime.ts';
import { NappletData } from './napplet-data.ts';
import { IpponCapability } from './ippon.ts';
import { injectNappletBridge, nappletRuntimeBootstrap, nappletRuntimeShell } from './napplet-runtime.ts';
import { installProfileStore, saveNostrProfile, knownProfiles } from './profile-store.ts';
import { TowerConnect } from './tower-connect.ts';
import { installSite, Site } from './site.ts';
import { installStorageTables, storageStatus, createStorageJob, candidateStorageJob, getStorageJob, updateStorageJob, verifyStorageAuth, towerSetup, pollStorageJob, dispatchStorageJob, remotePreview, storeStorageDelivery } from "./storage.ts";
import { refreshProjectGuidance } from "./local-builds.ts";
import { loadBuilderPrompt } from "./builder-prompt.ts";
import { projectRoute, workshopBuilders, additionalProjects } from "./project-routing.ts";
import { executionLinks } from "./execution-links.ts";
import { deleteNativeBuilder, storeBuilderDeletion } from "./builder-deletion.ts";
import { retireBuilder } from "./builder-lifecycle.ts";
import { join } from "node:path";
import { Auth, type Member } from "./auth.ts";
import { Assets, previewPolicy } from "./assets.ts";
import { type Config, limits } from "./config.ts";
import { openDatabase } from "./database.ts";
import { demand, HttpError } from "./errors.ts";
import { installDeliveryTables, storeDelivery } from "./delivery-store.ts";
import { verifyDelivery, DeliveryDenied } from "./pipeline/receiver.ts";
import { Publication } from "./publication.ts";
import {HostedPublication} from './hosted-publication.ts';
import {publicCanvasPage} from './public-canvas.ts';
import { dispatchApprovedRequest } from "./pipeline/operator-dispatch.ts";
import { dispatchFollowup, resumeFollowup, followupAvailable } from "./pipeline/followup-dispatch.ts";
import {beginAgentPublication,beginRemoteAgentPublication,registerAgentPublication,publicationAuthority} from './agent-publication.ts';
import { installBoard, saveBoard } from "./workshop-board.ts";
import {chatAttachmentStatus,prepareChatAttachment} from './chat-attachments.ts';
import { Workshop } from "./workshop.ts";
import {authorizeWorkshopFollowup} from './pipeline/workshop-prepare.ts';
import {authorizeConfigurableBuilder} from './pipeline/configurable-prepare.ts';
import {upgradeUntouchedOriginalCashuWallets,upgradeUntouchedOriginalPongProjects,upgradeUntouchedOriginalSpinners} from './starter-upgrades.ts';
// Sandboxed frames have an opaque origin. The parent binds capability messages to the exact frame;
// the existing Escape/focus signals remain separate from the capability channel.
const previewEscapeBridge = nappletRuntimeBootstrap('00000000-0000-0000-0000-000000000000').suffix;
export function application(rootConfig: Config, fixtures?: {datasetTransport?:(scope:any)=>import('./tower-storage-client.ts').StorageTransport;ipponFetch?:(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;ipponTimeoutMs?:number}) {
  const config=rootConfig;
  const db = openDatabase(config.dataDir), assets=new Assets(join(config.dataDir, "objects"));
  upgradeUntouchedOriginalSpinners(db,assets);
  upgradeUntouchedOriginalCashuWallets(db,assets);
  upgradeUntouchedOriginalPongProjects(db,assets);
  const auth = new Auth(db, config), workshop = new Workshop(db, assets);
  Workshop.siteAdminProviders.set(db,pubkey=>auth.isHost(pubkey));
  installSite(db,config); installBoard(workshop); installProfileStore(db); const site=new Site(db,config); const towerConnector=new TowerConnect(site,workshop.assets); installDeliveryTables(db); installActivityTables(db); installStorageTables(workshop); workshop.storageRequired=!!config.storage;
  loadBuilderEngine(db,workshop.id,config.followup?.builderRuntime?.agent??"codex");
  const nappletData = new NappletData(db);
  const ippon = new IpponCapability(db,nappletData,{baseUrl:rootConfig.ipponBaseUrl,fetch:fixtures?.ipponFetch,timeoutMs:fixtures?.ipponTimeoutMs});
  const canvasRuntime=new CanvasRuntime(db,nappletData,fixtures?.datasetTransport);
  Workshop.datasetProviders.set(db,async(w,member)=>{
    const storage=site.storage(w.id);
    const readiness=storage?storageStatus(w,storage):null;
    if((!storage||readiness?.state!=='ready')&&!fixtures?.datasetTransport)return {canvasId:w.id,datasets:[],valuesIncluded:false,available:false,reason:'Tower Canvas data is not activated'};
    const datasetDiscovery=readiness?.datasetDiscovery;
    if(!fixtures?.datasetTransport&&datasetDiscovery?.code!=='exact_match')return {canvasId:w.id,datasets:[],valuesIncluded:false,available:false,reason:datasetDiscovery?.message||'Canvas dataset transport is unavailable'};
    const session=db.query('SELECT hash FROM sessions WHERE pubkey=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1').get(member.pubkey,Math.floor(Date.now()/1000)) as any;
    demand(session,401,'Canvas discovery requires an active owner session');
    try{return await canvasRuntime.discovery(w,w.scoped(member),session.hash,storage);}catch(error){
      // Optional Canvas data must not block existing visual/conversational builds.
      // Access denial still aborts; an unavailable destination never means an empty schema.
      if(error instanceof HttpError&&[502,503,504].includes(error.status))return {canvasId:w.id,datasets:[],valuesIncluded:false,available:false,reason:'Canvas datasets are unavailable on this destination. Do not create a replacement data scheme; non-data app work may continue.'};
      throw error;
    }
  });
  const publication = new Publication(db, workshop, workshop.assets);
  const security = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...security, ...headers } });
  const originOf = (request: Request) => config.origin || new URL(request.url).origin;
  const listeners = new Set<() => void>();
  async function handle(request: Request): Promise<Response> {
    let workshop=new Workshop(db, new Assets(join(rootConfig.dataDir,"objects")));
    let config=rootConfig;
    let publication=new Publication(db,workshop,workshop.assets);
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method, mutation = !["GET", "HEAD"].includes(method), origin = originOf(request);
      if(path==='/api/v1/internal/builder/prepare'&&method==='POST'){
        demand(config.origin&&!url.search&&config.followup,503,'Builder preparation is not configured');
        const raw=await request.text();demand(Buffer.byteLength(raw)<=limits.callbackBytes,413,'Builder preparation too large');
        let body:any;try{body=JSON.parse(raw)}catch{throw new HttpError(400,'Invalid builder preparation')}
        const project=db.query('SELECT workshop_id FROM projects WHERE id=? AND deleted_at IS NULL').get(body?.projectId) as any;demand(project,404,'Builder project missing');
        workshop=new Workshop(db,workshop.assets,project.workshop_id);
        const storage=site.storage(workshop.id);demand(storage,503,'Managed builder authority unavailable');
        const eventId=verifyStorageAuth(request,raw,storage.appPubkey,config.origin);
        demand(!db.query('SELECT event_id FROM storage_auth_events WHERE event_id=?').get(eventId),401,'Builder authentication replay');
        const followup=workshopBuilders(config.followup);demand(followup,503,'Workshop builder is unavailable');
        const authority=authorizeWorkshopFollowup(body,{ownerPubkey:followup.ownerPubkey!,builderRoot:followup.builderRoot!,workshopId:followup.workshopId,fileVersions:followup.fileVersions,
          legacy:{projectId:followup.projectId!,ownerPubkey:followup.ownerPubkey!,conversationKey:followup.conversationKey!,directory:followup.directory!},dataDir:config.dataDir});
        const runtime=authorizeConfigurableBuilder(body,config.dataDir);
        db.run('INSERT INTO storage_auth_events VALUES(?)',[eventId]);
        return json({...authority,runtime});
      }
      if (['/api/v1/internal/publication/candidate','/api/v1/internal/publication/intent','/api/v1/internal/publication/failure','/api/v1/publication/version'].includes(path) && method==='POST') {
        demand(config.origin&&!url.search,401,'Publication URL binding denied');
        const raw=await request.text();demand(Buffer.byteLength(raw)<=limits.callbackBytes,413,'Publication receipt too large');
        const body=JSON.parse(raw),project=db.query('SELECT workshop_id FROM projects WHERE id=? AND deleted_at IS NULL').get(body.projectId) as any;
        demand(project,404,'Publication project missing');workshop=new Workshop(db,workshop.assets,project.workshop_id);
        const storage=site.storage(workshop.id);demand(storage,503,'Managed publication storage unavailable');
        const eventId=verifyStorageAuth(request,raw,storage.appPubkey,config.origin!);
        const result=db.transaction(()=>{
          demand(!db.query('SELECT event_id FROM storage_auth_events WHERE event_id=?').get(eventId),401,'Publication authentication replay');
          let result;
          if(path.endsWith('/candidate'))result=beginRemoteAgentPublication(workshop,body,storage);
          else if(path.endsWith('/intent'))result=beginAgentPublication(workshop,body,storage);
          else if(path.endsWith('/failure')){publicationAuthority(workshop,body);const publication=db.query('SELECT candidate_json,status FROM agent_publications WHERE request_id=?').get(body.requestId) as any;demand(publication&&publication.candidate_json===JSON.stringify(body.candidate)&&publication.status!=='published'&&typeof body.error==='string',409,'Publication failure correlation denied');db.run('UPDATE agent_publications SET error=? WHERE request_id=?',[body.error.slice(0,4000),body.requestId]);result={status:'pending'};}
          else result=registerAgentPublication(workshop,body);
          db.run('INSERT INTO storage_auth_events VALUES(?)',[eventId]);return result;
        }).immediate();
        return json(result);
      }
      if (path === "/api/v1/storage/callback" && method === "POST") {
        demand(config.callbackSignerPubkey && config.origin,503,'Storage callback is not configured');
        const raw=await request.text();demand(Buffer.byteLength(raw)<700000,413,'Storage callback too large');let candidate:any;try{candidate=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid callback');}
        const job=db.query('SELECT workshop_id FROM storage_jobs WHERE id=?').get(candidate?.result?.jobId||'') as any;demand(job,404,'Storage job not found');workshop=new Workshop(db,workshop.assets,job.workshop_id);config={...rootConfig,storage:site.storage(job.workshop_id)};demand(config.storage,503,'Storage installation is not configured');
        const delivery=verifyDelivery({body:raw,authorization:request.headers.get('authorization'),publicUrl:config.origin+'/api/v1/storage/callback',signerPubkey:config.callbackSignerPubkey!,deliveryHeader:request.headers.get('x-wingman-delivery-id'),runHeader:request.headers.get('x-wingman-run-id')});
        return json({handling:storeStorageDelivery(workshop,config.storage,delivery)});
      }
      if(path.startsWith('/api/v1/internal/storage/')){
        demand(config.origin,503,'Storage installation is not configured');
        const raw=method==='GET'?'':await request.text();demand(Buffer.byteLength(raw)<700000,413,'Storage receipt too large');
        const parsed=raw?JSON.parse(raw):{},jobId=path.match(/\/jobs\/([a-f0-9-]{36})$/)?.[1];
        const scoped=jobId?db.query('SELECT workshop_id FROM storage_jobs WHERE id=?').get(jobId) as any:db.query('SELECT workshop_id FROM projects WHERE id=?').get(parsed.projectId) as any;demand(scoped,404,'Storage resource not found');workshop=new Workshop(db,workshop.assets,scoped.workshop_id);config={...rootConfig,storage:site.storage(scoped.workshop_id)};demand(config.storage,503,'Storage installation is not configured');
        const eventId=verifyStorageAuth(request,raw,config.storage.appPubkey,config.origin!);
        demand(!db.query('SELECT event_id FROM storage_auth_events WHERE event_id=?').get(eventId),401,'Storage authentication replay');
        db.run('INSERT INTO storage_auth_events VALUES(?)',[eventId]);
        const body=raw?JSON.parse(raw):{},job=path.match(/^\/api\/v1\/internal\/storage\/jobs\/([a-f0-9-]{36})$/);
        if(path==='/api/v1/internal/storage/candidates'&&method==='POST')return json(candidateStorageJob(workshop,config.storage,body));
        if(job&&method==='GET'){
          const saved=getStorageJob(workshop,config.storage,job[1]!);
          if(saved.operation==='dataset')canvasRuntime.verifyJob(workshop,workshop.scoped(auth.member(saved.candidate?.datasetAuthority?.user)),saved.candidate);
          return json(saved);
        }
        if(job&&method==='POST')return json(updateStorageJob(workshop,config.storage,job[1]!,body));
        throw new HttpError(404,'Storage operation not found');
      }
      if (path === '/api/v1/pipeline/activity' && method === 'POST') {
        demand(!url.search,401,'Activity URL binding denied');
        demand(config.callbackSignerPubkey && config.origin,503,'Activity receiver is not configured');
        const verified=verifyActivity({body:await request.text(),authorization:request.headers.get('authorization'),publicUrl:config.origin+'/api/v1/pipeline/activity',signerPubkey:config.callbackSignerPubkey,eventHeader:request.headers.get('x-wingman-event-id'),runHeader:request.headers.get('x-wingman-run-id')});
        return json({handling:storeActivity(db,verified)});
      }
      if (["/api/v1/pipeline/callback","/api/v1/pipeline/message"].includes(path) && method === "POST") {
        demand(!url.search,401,"Callback URL binding denied");
        demand(config.callbackSignerPubkey && config.origin, 503, "Callback signer and public receiver are not configured");
        const raw = await request.text(); demand(Buffer.byteLength(raw) <= limits.callbackBytes, 413, "Callback too large");
        const delivery = verifyDelivery({ body: raw, authorization: request.headers.get("authorization"), publicUrl: `${config.origin}${path}`, signerPubkey: config.callbackSignerPubkey, deliveryHeader: request.headers.get("x-wingman-delivery-id"), runHeader: request.headers.get("x-wingman-run-id") });
        return json({ handling: storeBuilderDeletion(workshop,delivery) ?? storeDelivery(db, delivery, workshop) });
      }
      const publicPage=path.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
      if(publicPage&&method==='GET'){
        const found=HostedPublication.lookup(db,publicPage[1]!);demand(found,404,'Public Canvas not found');
        return new Response(publicCanvasPage(found.alias,found.version,found.snapshot),{headers:{...security,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; img-src 'self' https: data:; connect-src 'self' https: wss://relay.primal.net wss://nos.lol wss://relay.damus.io wss://purplepag.es; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
      }
      const publicApp=path.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)\/apps\/([a-f0-9-]{36})$/);
      if(publicApp&&method==='GET'){
        const found=HostedPublication.lookup(db,publicApp[1]!);demand(found,404,'Published Napplet not found');const app=found.snapshot.napplets.find(p=>p.projectId===publicApp[2]);demand(app,404,'Published Napplet not found');
        const project=db.query('SELECT hidden,owner FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(app.projectId,found.snapshot.workshopId) as any;
        const excluded=db.query('SELECT excluded FROM hosted_publication_exclusions WHERE workshop_id=? AND project_id=?').get(found.snapshot.workshopId,app.projectId) as any;
        const publicWorkshop=new Workshop(db,workshop.assets,found.snapshot.workshopId);demand(project&&!project.hidden&&!excluded?.excluded&&publicWorkshop.projectOwnerAccess(project.owner)?.state==='admitted',404,'Published Napplet not found');
        const storage=site.storage(found.snapshot.workshopId),source=storage?await remotePreview(publicWorkshop,storage,app.revisionId).catch(()=>null):null;
        const payload=source??publicWorkshop.assets.get(app.sourceHash);demand(sha256(payload)===app.sourceHash,500,'Published Napplet integrity check failed');
        let documentId=crypto.randomUUID();try{const active=auth.session(request),member=publicWorkshop.scoped(active.member);publicWorkshop.admitted(member);documentId=nappletData.issueDocument(publicWorkshop,member,active.sessionHash,app.projectId,app.revisionId);}catch{}
        return new Response(injectNappletBridge(payload,documentId),{headers:{...security,'content-type':'text/html; charset=utf-8','content-security-policy':previewPolicy,'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=()'}});
      }
      const publicImage=path.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)\/images\/([a-f0-9]{64})$/);
      if(publicImage&&method==='GET'){
        const found=HostedPublication.lookup(db,publicImage[1]!);demand(found,404,'Published picture not found');const row=db.query('SELECT mime FROM workshop_board_images WHERE workshop_id=? AND hash=?').get(found.snapshot.workshopId,publicImage[2]!) as any;demand(row&&found.snapshot.objects.some(o=>o.kind==='image'&&o.src?.includes(publicImage[2]!)),404,'Published picture not found');return new Response(new Uint8Array(workshop.assets.getBytes(publicImage[2]!)),{headers:{...security,'content-type':row.mime,'content-security-policy':"default-src 'none'; sandbox",'cache-control':'public, max-age=31536000, immutable'}});
      }
      if(path.startsWith('/p/')&&method==='GET')throw new HttpError(404,'Public Canvas not found');
      if(path==='/api/v1/public/session'&&method==='GET'){
        const alias=url.searchParams.get('alias')||'',found=HostedPublication.lookup(db,alias);demand(found,404,'Public Canvas not found');const active=auth.session(request),publicWorkshop=new Workshop(db,workshop.assets,found.snapshot.workshopId),member=publicWorkshop.scoped(active.member);publicWorkshop.admitted(member);return json({member,csrf:active.csrf});
      }
      if (mutation) demand(request.headers.get("origin") === origin, 403, "Request origin does not match this workshop");
      // Browser navigation uses configured identity, never forwarded headers.
      // Alternate managed port/mesh entry pages move here before authentication.
      if (path === "/api/v1/browser-origin" && method === "GET") return json({ origin });
      if (["/health","/api/health"].includes(path) && method === "GET") {const capable=workshopBuilders(config.followup);const publicationAvailable=!!capable?.agentPublication&&!!(config.storage||config.managedStorage||config.storageTemplates?.length||config.workshopStorage?.length);return json({ status: "ok", service: "liquid-freedom", version: config.version, build: await Bun.file(join(import.meta.dir, "../tmp/build/assets.json")).json().catch(() => null), hostConfigured: !!config.hostPubkey, generation: { available: !!capable?.memberWorkshops && !capable.suspended, operatorApprovedBuildAvailable: !!config.operatorBuild, ownerProjectFollowupAvailable: !!config.followup && !config.followup.suspended, ownerProjectFollowupSuspended: !!config.followup?.suspended, reason: "Installed workshop builders require active admission, project ownership and available allowance" }, publication: { available: publicationAvailable, reason: publicationAvailable?"Agent-tool publication is installed; each Canvas still requires its verified private storage binding.":"Awaiting installed agent-tool publication and managed storage authority" }, limits });}
      if (["/", "/app.js", "/activity-time.js", "/chat-attachments.js", "/invitation-url.js", "/napplet-host.js", "/napplet-cache.js", "/canvas-host.js", "/canvas-images.js", "/identity.js", "/napplet.d.ts", "/style.css", "/public-canvas.js", "/public-canvas-camera.js", "/public-canvas.css"].includes(path) && method === "GET") {
        const file = Bun.file(join(import.meta.dir, "../public", path === "/" ? "index.html" : path.slice(1)));
        demand(await file.exists(), 503, "Managed build required");
        return new Response(file, { headers: { ...security, "cache-control": "no-store", "content-type": path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".d.ts") ? "text/plain; charset=utf-8" : "text/html", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: wss://relay.primal.net wss://nos.lol wss://relay.damus.io wss://purplepag.es; frame-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
      }
      let body: any = {};
      if (mutation) { const bodyLimit=/^\/api\/v1\/projects\/[^/]+\/attachments$/.test(path)?limits.attachmentBodyBytes:path==='/api/v1/board/images'?limits.boardImageBodyBytes:limits.bodyBytes;demand(Number(request.headers.get("content-length") || 0) <= bodyLimit, 413, "Request too large"); const raw = await request.text(); demand(Buffer.byteLength(raw) <= bodyLimit, 413, "Request too large"); try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "Invalid JSON"); } demand(body && typeof body === "object" && !Array.isArray(body), 400, "Expected an object"); }
      if (path === "/api/v1/challenge" && method === "POST") return json(auth.challenge(origin));
      if (path === "/api/v1/login" && method === "POST") { const login = auth.login(body, origin); const secure = origin.startsWith("https:") ? "; Secure" : ""; return json({ member: login.member, csrf: login.csrf }, 200, { "set-cookie": `lf_session=${login.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}` }); }
      const session = auth.session(request, mutation);
      const identity=session.member;
      if(path==='/api/v1/profile/nostr'&&method==='POST')return json(saveNostrProfile(db,identity,body));
      if(path==='/api/v1/site/people'&&method==='GET')return json(knownProfiles(db,identity));
      if(path==='/api/v1/profile'&&['GET','POST'].includes(method))return json(site.profile(identity,method==='POST'?body:undefined));
      if(path==='/api/v1/workshops'&&method==='GET')return json({workshops:site.workshops(identity).map(w=>({...w,...(identity.admin&&w.tower_id?{setupState:storageStatus(new Workshop(db,workshop.assets,w.id),site.storage(w.id)).setupState}:{})})),legacyWorkshopId:site.legacy()});
      if(path==='/api/v1/site/workshops'&&method==='POST')return json(site.create(identity,body),201);
      const canvasDelete=path.match(/^\/api\/v1\/workshops\/([a-f0-9-]{36})$/);
      if(canvasDelete&&method==='DELETE')return json(site.deleteCanvas(identity,canvasDelete[1]!,body));
      if(path==='/api/v1/site/towers'&&method==='GET')return json({towers:site.towers(identity)});
      if(path==='/api/v1/site/towers'&&method==='POST')return json({towers:site.register(identity,body)},201);
      const towerConnect=path.match(/^\/api\/v1\/site\/towers\/([^/]+)\/connect$/);
      if(towerConnect&&method==='POST')return json(await towerConnector.connect(identity,towerConnect[1]!,site.selection(request),body));
      const towerSetupRoute=path.match(/^\/api\/v1\/site\/towers\/([^/]+)\/(create-intent|create|bind)$/);
      if(towerSetupRoute&&method==='POST'){const [_,id,action]=towerSetupRoute;const selected=site.selection(request);return json(action==='create-intent'?towerConnector.intent(identity,id!,selected,body):action==='create'?await towerConnector.create(identity,id!,selected,body):await towerConnector.bind(identity,id!,selected,body));}
      if(path==='/api/v1/workshops/redeem-code'&&method==='POST'){
        codeAttempt(db,identity.pubkey);demand(typeof body.code==='string'&&/^\d{6}$/.test(body.code),400,'Enter a six-digit workshop code');
        const invitation=db.query('SELECT workshop_id,status,remaining FROM invitations WHERE hash=? AND code IS NOT NULL').get(sha256(body.code)) as any;
        demand(invitation,403,'Invitation is invalid');
        demand(invitation.status!=='stopped',410,'Invitation has been stopped');
        demand(invitation.status==='active'&&invitation.remaining>0,410,'Invitation is exhausted');
        const target=new Workshop(db,workshop.assets,invitation.workshop_id);
        const joined=target.join(target.scoped(identity),{invitation:body.code});return json({member:joined,workshopId:target.id});
      }
      const scope=site.selection(request);
      workshop=new Workshop(db,workshop.assets,scope);
      const member=workshop.scoped(identity);
      const selectedStorage=site.storage(scope);
      config={...rootConfig,storage:selectedStorage,followup:workshop.legacy || rootConfig.followup?.fileVersions && rootConfig.followup.replacementEnabled ? workshopBuilders(rootConfig.followup) : undefined,operatorBuild:workshop.legacy?rootConfig.operatorBuild:undefined};
      workshop.storageReady=!(workshop.roomRow().tower_id||selectedStorage)||!!selectedStorage&&storageStatus(workshop,selectedStorage).state==='ready';
      workshop.storageRequired=!!selectedStorage;
      publication=new Publication(db,workshop,workshop.assets);
      const hostedPublication=new HostedPublication(db,workshop);
      const attachmentCreate=path.match(/^\/api\/v1\/projects\/([^/]+)\/attachments$/);
      if(attachmentCreate&&method==='POST')return json(await prepareChatAttachment(workshop,member,config.storage,attachmentCreate[1]!,body),202);
      const attachmentRead=path.match(/^\/api\/v1\/projects\/([^/]+)\/attachments\/([^/]+)$/);
      if(attachmentRead&&method==='GET')return json(await chatAttachmentStatus(workshop,member,config.storage,attachmentRead[1]!,attachmentRead[2]!));
      if(path==='/api/v1/napplet/dataset/watch'&&method==='POST')return new Response(canvasRuntime.watch(workshop,member,session.sessionHash,config.storage,body,request.signal),{headers:{...security,'content-type':'application/x-ndjson'}});
      if(path==='/api/v1/napplet/dataset'&&method==='POST')return json(await canvasRuntime.operate(workshop,member,session.sessionHash,config.storage,body,request.signal));
      if(path==='/api/v1/canvas/datasets'&&method==='GET')return json(await canvasRuntime.discovery(workshop,member,session.sessionHash,config.storage));
      if(path==='/api/v1/napplet/open'&&method==='POST')return json(nappletData.open(workshop,member,session.sessionHash,body));
      if(path==='/api/v1/napplet/data'&&method==='POST')return json(nappletData.operate(workshop,member,session.sessionHash,body));
      if(path==='/api/v1/napplet/cashu'&&method==='POST')return json(await ippon.operate(workshop,member,session.sessionHash,body));
      if(path==='/api/v1/workshops/join'&&method==='POST'){body.invitation=normalizedInvitation(body.invitation);if(shortInvitation(body.invitation))codeAttempt(db,identity.pubkey);return json({member:workshop.join(member,body)});}

      if(path==='/api/v1/host/storage'&&method==='GET'){site.admin(identity);return json({...storageStatus(workshop,config.storage),selectedTowerId:workshop.roomRow().tower_id,activationRequirement:config.storage?null:'Managed app execution is unavailable; configure the installation-wide storage worker'});}
      if(path==='/api/v1/host/storage/setup'&&method==='POST'){site.admin(identity);demand(config.storage,503,'Install the managed storage pipeline before setup');return json(await towerSetup(workshop,config.storage,member,body));}
      if(path==='/api/v1/host/storage/namespace'&&method==='POST'){site.admin(identity);demand(config.storage,503,'Storage is not configured');const s=storageStatus(workshop,config.storage);demand(s.binding,409,'Select a workspace first');const id=createStorageJob(workshop,'namespace',s.binding.target,'namespace',new Uint8Array());await dispatchStorageJob(workshop,config.storage,id);return json({jobId:id},202);}
      if(path==='/api/v1/host/storage/probe'&&method==='POST'){site.admin(identity);demand(config.storage,503,'Storage is not configured');const status=storageStatus(workshop,config.storage);demand(status.binding,409,'Select a workspace first');const job=await pollStorageJob(workshop,config.storage,status.binding.probe_job_id);if(body.retry&&job.status!=='verified')await dispatchStorageJob(workshop,config.storage,job.jobId);return json(storageStatus(workshop,config.storage));}
      const storageRetry=path.match(/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/storage-retry$/);
      if(storageRetry&&method==='POST'){
       workshop.project(member,storageRetry[1]!,!member.host);demand(config.storage,503,'Storage is not configured');const job=db.query('SELECT j.* FROM storage_jobs j JOIN requests r ON r.id=j.request_id WHERE r.id=? AND r.project_id=?').get(storageRetry[2]!,storageRetry[1]!) as any;demand(job,404,'Saved storage job not found');await pollStorageJob(workshop,config.storage,job.id);const current=db.query('SELECT status FROM requests WHERE id=?').get(storageRetry[2]!) as any;if(current.status==='succeeded')return json(current);await dispatchStorageJob(workshop,config.storage,job.id);return json({status:'storage_pending'},202);
      }
      const operatorReceipt = path.match(/^\/api\/v1\/host\/requests\/([^/]+)\/receipts$/);
      if (operatorReceipt && method === "GET") {
        workshop.host(member);
        const id = operatorReceipt[1]!;
        const saved = db.query("SELECT * FROM requests WHERE id=?").get(id);
        demand(saved, 404, "Saved request not found"); workshop.project(member,(saved as any).project_id);
        return json({ request: saved, hostSubmission: db.query("SELECT * FROM host_request_audit WHERE request_id=?").get(id), generations: db.query('SELECT request_id,generation,native_request_id,context_hash FROM request_epoch_history WHERE request_id=? ORDER BY generation').all(id), replacementAttempts: db.query('SELECT run_id,receipt_json,created_at FROM replacement_attempts WHERE request_id=? ORDER BY created_at,rowid').all(id), recovery: db.query("SELECT previous_run,new_run,receipt_json FROM request_recoveries WHERE request_id=?").get(id),
          dispatch: db.query("SELECT run_id,receipt_json FROM dispatch_receipts WHERE request_id=?").get(id),
          build: db.query("SELECT revision_id,receipt_json FROM build_receipts WHERE request_id=?").get(id),
          delivery: db.query("SELECT delivery_id,run_id,request_id,status,body_hash,created_at FROM delivery_receipts WHERE request_id=?").all(id) });
      }
      const hostFollowup = path.match(/^\/api\/v1\/host\/projects\/([^/]+)\/requests$/);
      if (hostFollowup && method === 'POST') {
        workshop.host(member);
        const projectId = hostFollowup[1]!, project = workshop.project(member,projectId);
        demand(followupAvailable(project,config.followup)&&runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime),403,'Host execution is not activated for this owner and project');

        const saved = workshop.request(member,projectId,body,true,true) as any;
        return json({request:await dispatchFollowup(workshop,member,projectId,saved.id,config.followup),hostSubmitted:true},202);
      }
      const nativeLifecycle = path.match(/^\/api\/v1\/projects\/([^/]+)\/builder\/native$/);
      if(nativeLifecycle && method === 'POST') return json(await deleteNativeBuilder(workshop,member,nativeLifecycle[1]!,body,config.followup),202);
      const lifecycle = path.match(/^\/api\/v1\/projects\/([^/]+)\/builder$/);
      if (lifecycle && method === 'DELETE') return json(retireBuilder(workshop,member,lifecycle[1]!,body.generation));
      const recovery = path.match(/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/resume$/);
      if (recovery && method === 'POST') return json({ request: await resumeFollowup(workshop, member, recovery[1]!, recovery[2]!, config.followup) }, 202);
      const cancellation=path.match(/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/cancel$/);
      if(cancellation&&method==='POST')return json({request:cancelUnsentRequest(workshop,member,cancellation[1]!,cancellation[2]!)});
      const engineCorrection=path.match(/^\/api\/v1\/host\/projects\/([^/]+)\/requests\/([^/]+)\/builder-engine$/);
      if(engineCorrection&&method==='POST')return json({builderEngine:workshop.correctRequestBuilderEngine(member,engineCorrection[1]!,engineCorrection[2]!,body)});
      const operatorBuild = path.match(/^\/api\/v1\/host\/requests\/([^/]+)\/build$/);
      if (operatorBuild && method === "POST") return json(await dispatchApprovedRequest(workshop, member, operatorBuild[1]!, config.operatorBuild), 202);
      if (path === "/api/v1/me" && method === "GET") return json({ member:{...member,...site.profile(identity)}, csrf: session.csrf });
      if (path === "/api/v1/logout" && method === "POST") { nappletData.closeSession(session.sessionHash); auth.logout(request); return json({ ok: true }, 200, { "set-cookie": "lf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" }); }
      if(path==='/api/v1/board/images'&&method==='POST')return json(uploadBoardImage(workshop,member,body),201);
      const boardImageRoute=path.match(/^\/api\/v1\/board\/images\/([a-f0-9]{64})$/);
      if(boardImageRoute&&method==='GET'){const image=readBoardImage(workshop,member,boardImageRoute[1]!);return new Response(new Uint8Array(image.bytes),{headers:{...security,'content-type':image.mime,'content-security-policy':"default-src 'none'; sandbox"}});}
      if(path==='/api/v1/board'&&method==='POST')return json({board:saveBoard(workshop,member,body)});
      if (path === "/api/v1/room" && method === "GET") return json({ ...workshop.room(member), member:{...member,...site.profile(identity)}, workshopId:workshop.id, additionalProjectsAvailable: additionalProjects(member,config.followup) });
      if (path === "/api/v1/projects" && method === "POST") {
        const created=body.forkProjectId
          ? workshop.fork(member,body.forkProjectId,body.idempotencyKey)
          : workshop.create(member,body.starterId,undefined,additionalProjects(member,config.followup));
        const route=projectRoute(created.project,config.followup);
        if(route?.fileVersions&&!route.remotePreparation)refreshProjectGuidance(route.directory!,workshop.guidance());
        return json({ ...created, generationAvailable: followupAvailable(created.project,config.followup), nativeDeletionAvailable:false },'idempotent' in created&&created.idempotent?200:201);
      }
      const project = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(activate|restore|share|consent|requests|preview|payload|runtime|rename|edit))?$/);
      if (project) {
        const [, id, action] = project;
        if (!action && method === 'DELETE') return json(workshop.deleteNapplet(member,id!,body));
        if (!action && method === "GET") return json({ ...workshop.detail(member, id!), execution: executionLinks(workshop,member,id!,config.followup), nativeDeletionAvailable: !!config.followup?.nativeDeletion && !config.followup.suspended && followupAvailable(workshop.project(member,id!),config.followup), generationAvailable: followupAvailable(workshop.project(member,id!),config.followup)&&runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime), storageReady:workshop.storageReady, generationReason: !runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime)?'The selected builder engine awaits platform activation; your request and app remain saved.':!workshop.storageReady ? 'Private storage needs authorization. Questions are available; app changes wait for the site administrator to connect storage.' : config.followup?.suspended && id === config.followup.projectId ? "This project conversation is awaiting native resume activation. Requests are saved without execution." : null });
        if (action === "edit" && method === "GET") {
          workshop.editableProject(member,id!);
          return json({ ...workshop.detail(member,id!), execution:executionLinks(workshop,member,id!,config.followup), nativeDeletionAvailable:!!config.followup?.nativeDeletion&&!config.followup.suspended&&followupAvailable(workshop.editableProject(member,id!),config.followup), generationAvailable:followupAvailable(workshop.editableProject(member,id!),config.followup)&&runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime), storageReady:workshop.storageReady, generationReason:!runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime)?'The selected builder engine awaits platform activation; your request and app remain saved.':!workshop.storageReady?'Private storage needs authorization. Questions are available; app changes wait for the site administrator to connect storage.':null });
        }
        if (action === "preview" && method === "GET") {
          const revisionId=url.searchParams.get('revision')||'',revision=workshop.previewRevision(member,id!,revisionId);
          const hasRemote=db.query('SELECT revision_id FROM remote_versions WHERE revision_id=?').get(revisionId);
          demand(!hasRemote||config.storage,503,'The managed private storage connection is unavailable');
          const source=config.storage?await remotePreview(workshop,config.storage,revisionId):null;
          demand(auth.sessionActive(session.sessionHash),401,'Session expired during preview load');
          const documentId=nappletData.issueDocument(workshop,member,session.sessionHash,id!,revisionId);
          return new Response(injectNappletBridge(source??workshop.assets.get(revision.source_hash),documentId) + previewEscapeBridge, { headers: { ...security, "content-type": "text/html", "content-security-policy": previewPolicy, "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()" } });
        }
        if (action === 'payload' && method === 'GET') {
          const revisionId=url.searchParams.get('revision')||'',revision=workshop.previewRevision(member,id!,revisionId);
          const hasRemote=db.query('SELECT revision_id FROM remote_versions WHERE revision_id=?').get(revisionId);
          demand(!hasRemote||config.storage,503,'The managed private storage connection is unavailable');
          const source=config.storage?await remotePreview(workshop,config.storage,revisionId):null;
          demand(auth.sessionActive(session.sessionHash),401,'Session expired during payload load');
          const bytes=new TextEncoder().encode(source??workshop.assets.get(revision.source_hash));
          demand(sha256(bytes)===revision.source_hash,500,'Immutable payload verification failed');
          return new Response(bytes,{headers:{...security,'content-type':'text/html; charset=utf-8','x-napplet-source-sha256':revision.source_hash}});
        }
        if (action === 'runtime' && method === 'GET') {
          const revisionId=url.searchParams.get('revision')||'',revision=workshop.previewRevision(member,id!,revisionId);
          demand(auth.sessionActive(session.sessionHash),401,'Session expired during runtime load');
          const documentId=nappletData.issueDocument(workshop,member,session.sessionHash,id!,revisionId);
          return new Response(nappletRuntimeShell(documentId,revision.source_hash),{headers:{...security,'content-type':'text/html','content-security-policy':previewPolicy,'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=()'}});
        }
        if (action === "rename" && method === "POST") return json(workshop.rename(member, id!, body));
        if (action === "activate" && method === "POST") return json(workshop.activate(member, id!, body));
        if (action === "restore" && method === "POST") return json(workshop.restore(member, id!, body));
        if (action === "share" && method === "POST") return json(workshop.share(member, id!, body));
        if (action === "consent" && method === "POST") return json(workshop.consent(member, id!, body));
        if (action === "requests" && method === "POST") {
          const available = followupAvailable(workshop.project(member,id!,true),config.followup)&&runtimeAvailable(config.followup,loadBuilderEngine(db,workshop.id).runtime);

          let saved = workshop.request(member,id!,body,available) as any;
          if (available) saved = await dispatchFollowup(workshop,member,id!,saved.id,config.followup);
          return json({ request:saved,generationAvailable:available }, available ? 202 : 200);
        }
      }
      const engineState=()=>{const choice=loadBuilderEngine(db,workshop.id);return {...choice,available:runtimeAvailable(config.followup,choice.runtime),options:builderAgents.map(agent=>({agent,label:agent==='goose'?'Goose · GLM 5.3':agent==='claude'?'Claude · configured default':'Codex · configured default',available:runtimeAvailable(config.followup,runtimeForAgent(agent))})),reason:runtimeAvailable(config.followup,choice.runtime)?'Installed builder runtime is enabled; live provider checks occur during execution.':'Saved selection awaits compatible managed pipeline and platform activation. Requests keep their selected engine.'}};
      if(['/api/v1/host/builder-engine','/api/v1/site/builder-engine'].includes(path)&&['GET','POST'].includes(method)){
        site.admin(identity);workshop.builderEngine(member,method==='POST'?body:undefined);
        return json({...workshop.builderPrompt(member),builderEngine:engineState(),workshopId:workshop.id,scope:workshop.legacy?'site':'workshop'});
      }
      if (['/api/v1/host/builder-prompt','/api/v1/site/builder-prompt'].includes(path) && ['GET','POST'].includes(method)) {
        if(path==='/api/v1/site/builder-prompt')site.admin(identity);
        const saved=workshop.builderPrompt(member,method==='POST'?body:undefined);
        if(method==='POST')for(const project of db.query('SELECT * FROM projects WHERE workshop_id=?').all(workshop.id)){
          const route=projectRoute(project,config.followup);
          if(route?.fileVersions&&!route.remotePreparation)refreshProjectGuidance(route.directory!,saved.prompt);
        }
        return json({...saved,...(member.admin?{builderEngine:engineState()}:{}),...(path==='/api/v1/site/builder-prompt'?{workshopId:workshop.id,scope:workshop.legacy?'site':'workshop'}:{})});
      }
      if (path === "/api/v1/host/settings" && method === "POST") return json(workshop.settings(member, body));
      if (path === "/api/v1/host/people" && method === "GET") return json(workshop.people(member));
      const presentInvitation=(invitation:any)=>{if(!invitation?.code)return invitation;const url=origin+'/?code='+invitation.code;return {...invitation,url,qr:encodeQR(url,'data-url',{scale:6,border:4,ecc:'medium'})};};
      if (path === "/api/v1/host/invitations" && method === "GET") {const result=workshop.sharedInvitation(member);return json({...result,active:presentInvitation(result.active)});}
      if (path === "/api/v1/host/invitations" && method === "POST") return json(presentInvitation(workshop.invitation(member,body)));
      if (path === "/api/v1/host/invitations/stop" && method === "POST") return json(workshop.stopInvitation(member));
      const moderation = path.match(/^\/api\/v1\/host\/(members|projects)\/([^/]+)$/);
      if (moderation && method === "POST") return json(moderation[1] === "members" ? workshop.moderate(member, moderation[2]!, body) : workshop.visibility(member, moderation[2]!, body));
      if (path === "/api/v1/host/publication/prepare" && method === "POST") return json({ snapshot: publication.prepare(member, body.selections, body.siteName), public: false, published: false }, 201);
      if (path === "/api/v1/host/publication" && method === "GET") return json({ candidates: workshop.publicationCandidates(member), available: false, receipts: publication.list(member), reason: "Publication unavailable: approved publication signer, Blossom storage, relays, current-spec exporter and remote verification are required." });
      if (path === "/api/v1/host/publication" && method === "POST") { workshop.host(member); throw new HttpError(503, "Publication unavailable; no public assets or events were created"); }
      if(path==='/api/v1/host/hosted-publication'&&method==='GET')return json(hostedPublication.status(member));
      if(path==='/api/v1/host/hosted-publication'&&method==='POST')return json(hostedPublication.publish(member,body),201);
      const hostedInclusion=path.match(/^\/api\/v1\/host\/hosted-publication\/projects\/([a-f0-9-]{36})$/);
      if(hostedInclusion&&method==='POST')return json(hostedPublication.inclusion(member,hostedInclusion[1]!,body.included));
      throw new HttpError(404, "Route not found");
    } catch (error) { if (error instanceof DeliveryDenied) return json({ error: error.message }, 401); if (error instanceof HttpError) return json({ error: error.message }, error.status); console.error("Application request failed", error instanceof Error ? {path:new URL(request.url).pathname,name:error.name,message:error.message,code:(error as NodeJS.ErrnoException).code??null} : {path:new URL(request.url).pathname,name:"unknown"}); return json({ error: "Internal error; operation did not complete" }, 500); }
  }
  async function handleAndNotify(request: Request) {
    const response = await handle(request);
    // Publish only after the durable mutation has committed. Subscriptions recheck
    // session, workshop and project access before reading any request state.
    if (response.ok && !['GET','HEAD'].includes(request.method)) {
      for (const listener of listeners) { try { listener(); } catch { /* a disconnected client cannot fail a committed operation */ } }
    }
    return response;
  }
  let recovering=false;
  async function recoverBuilders() {
    if(recovering)return;
    recovering=true;
    try {await recoverWorkshopBuilders(new Workshop(db,workshop.assets),auth,workshopBuilders(rootConfig.followup),undefined,{storageReady:id=>{const w=new Workshop(db,workshop.assets,id),storage=site.storage(id);return !(w.roomRow().tower_id||storage)||!!storage&&storageStatus(w,storage).state==='ready';},storageRequired:id=>{const storage=site.storage(id);return !!storage && storageStatus(new Workshop(db,workshop.assets,id),storage).binding?.status==='ready';}});}
    finally {recovering=false;for(const listener of listeners){try{listener();}catch{}}}
  }
  return { db, auth, workshop, site, publication, handle: handleAndNotify, originOf, recoverBuilders,
    onChange(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
}
