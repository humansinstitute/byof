// Work in viewport coordinates for enclosure, so zoom and minimized cards match what is visible.
function selectionRect(a,b){return {left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)};}
function enclosedIds(items,box){if(box.right-box.left<3||box.bottom-box.top<3)return [];return items.filter(o=>o.left>=box.left&&o.top>=box.top&&o.right<=box.right&&o.bottom<=box.bottom).map(o=>o.id);}
function movementObjects(objects,selected){const ids=new Set(selected);let changed=true;while(changed){changed=false;for(const o of objects)if(o.groupId&&ids.has(o.groupId)&&!ids.has(o.id)){ids.add(o.id);changed=true;}}return objects.filter(o=>ids.has(o.id)).map(o=>({...o}));}
function groupDelta(items,x,y){return {x:Math.max(...items.map(o=>-50000-o.x),Math.min(x,...items.map(o=>50000-o.x))),y:Math.max(...items.map(o=>-50000-o.y),Math.min(y,...items.map(o=>50000-o.y)))};}

import { installNappletHost } from '/napplet-host.js';
import { createNappletPayloadCache } from '/napplet-cache.js';
import { temporaryIdentity, forgetTemporaryIdentity, browserProfileCache, humanText, initials } from '/identity.js';
import { activityInstant, collapseActivity, newestInstant, perthEventTime } from './activity-time.js';
import { invitationAtNavigation, invitationFreeUrl, invitationHistoryKey, invitationStorageKey, singleInvitationRedemption } from '/invitation-url.js';
import {clipboardImages,imageMarkdown,imageUploadsBlockSend,insertImageMarkers,replaceImageMarker,submittedImageAttachments} from '/chat-attachments.js';
// Navigate before reading sessions, asking a signer, or sending any API request.
// Keep credentials and signed challenges on the workshop's configured origin.
const originResponse = await fetch('/api/v1/browser-origin', { credentials: 'omit', cache: 'no-store' });
if (!originResponse.ok) throw new Error('BYOF Canvas address unavailable; reload to retry.');
const { origin: canonicalOrigin } = await originResponse.json();
const workshopUrl = new URL(canonicalOrigin);
if (!['http:', 'https:'].includes(workshopUrl.protocol) || workshopUrl.origin !== canonicalOrigin) throw new Error('BYOF Canvas address is invalid.');
if (location.origin !== canonicalOrigin) {
  location.replace(canonicalOrigin + location.pathname + location.search + location.hash);
  await new Promise(() => {}); // This document must not continue during navigation.
}
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
// Unlock sound during a user gesture; browsers block unsolicited audio.
let completionAudio = null, completionSound = true;
try { completionSound = localStorage.getItem('freedom-completion-sound') !== 'off'; } catch {}
function unlockCompletionAudio() {
  if (!completionSound) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    completionAudio ||= new Audio();
    if (completionAudio.state === 'suspended') void completionAudio.resume().catch(()=>{});
  } catch {}
}
document.addEventListener('pointerdown', unlockCompletionAudio, {capture:true});
document.addEventListener('keydown', unlockCompletionAudio, {capture:true});
function pingCompletedTurn(previous, next) {
  if (!previous || previous.id !== next.id || previous.status === 'succeeded' || next.status !== 'succeeded') return;
  if (!completionSound || completionAudio?.state !== 'running') return;
  try {
    const ctx=completionAudio, now=ctx.currentTime;
    // A clear bell with a bright overtone and a long, gentle decay.
    for (const [frequency,volume] of [[880,.65],[1760,.18]]) {
      const tone=ctx.createOscillator(), gain=ctx.createGain();
      tone.frequency.value=frequency;
      gain.gain.setValueAtTime(.001,now);
      gain.gain.exponentialRampToValueAtTime(volume,now+.008);
      gain.gain.exponentialRampToValueAtTime(.001,now+1.4);
      tone.connect(gain);gain.connect(ctx.destination);
      tone.start(now);tone.stop(now+1.45);
    }
  } catch {}
}
document.addEventListener('click', event=>{
  const control=event.target.closest('[data-completion-sound]');if(!control)return;
  completionSound=!completionSound;
  try { localStorage.setItem('freedom-completion-sound',completionSound?'on':'off'); } catch {}
  unlockCompletionAudio();
  control.setAttribute('aria-pressed',String(completionSound));
  control.textContent='Completion sound: '+(completionSound?'on':'off');
});

const profiles = browserProfileCache();
let knownPeople = [], createWorkshop = false, identityMarkup = '';
const profileName = m => profiles.peek(m.pubkey, m.identity_type === 'temporary' ? m.name : '').name;
const authorName = p => p.authorPubkey ? profiles.peek(p.authorPubkey).name : humanText(p.author,60) || 'BYOF Canvas participant';
function setMember(member) { me = member; hydrateProfiles([member]); }
const syncedProfiles = new Map();
function hydrateProfiles(members) {
  for (const member of members) {
    if (!member?.pubkey || member.identity_type === 'temporary') continue;
    const key=member.pubkey;
    void profiles.refresh(key).then(view => {
      if (me?.pubkey === key && view.event && syncedProfiles.get(key) !== view.event.id) {
        syncedProfiles.set(key,view.event.id);
        void api('profile/nostr',{event:view.event}).catch(()=>syncedProfiles.delete(key));
      }
      if(me)renderIdentity();
      document.querySelectorAll('[data-profile-name]').forEach(node => {
        if(node.dataset.profileName===key)node.textContent=view.name;
      });
      if(screen==='profile' && me?.pubkey===key && !$('#profile-form')?.dataset.dirty) fillProfile();
    });
  }
}
function renderIdentity() {
  if (!me) { $('#identity').innerHTML='<span class="tag">BYOF Canvas</span>';identityMarkup='';return; }
  const view=profiles.peek(me.pubkey,me.identity_type==='temporary'?me.name:'');
  const markup=`<button class="avatar" data-a="menu" aria-label="Open identity menu" aria-haspopup="true" aria-controls="avatar-menu" aria-expanded="${menu}">${view.avatar?`<img src="${esc(view.avatar)}" alt="">`:esc(initials(view.name))}</button>${menu?`<nav id="avatar-menu" class="menu" aria-label="Identity menu"><b>${esc(view.name)}</b>${button('profile','My Profile')}${button('workshops','Canvases')}${me.admin?button('site','Site Admin'):''}</nav>`:''}`;
  if(identityMarkup!==markup){$('#identity').innerHTML=markup;identityMarkup=markup;}
}
function fillProfile() {
  if (!me) return;
  profile=profiles.peek(me.pubkey,me.identity_type==='temporary'?me.name:'');
  if($('#profile-name')) { $('#profile-name').value=profile.name;$('#profile-picture').value=profile.picture;$('#profile-about').value=profile.about; }
}
function canvasOverviewMarkup(workshop) {
  const overview=workshop.overview||{},napplets=Number.isSafeInteger(overview.nappletCount)?overview.nappletCount:0,decorations=Number.isSafeInteger(overview.decorationCount)?overview.decorationCount:0;
  let seed=2166136261;for(const character of String(workshop.id||workshop.title||'')){seed^=character.codePointAt(0);seed=Math.imul(seed,16777619)>>>0;}
  const palettes=[['#24282c','#ff741f','#f4f1e9','#97c8d3'],['#f4f1e9','#24282c','#ff741f','#c7b6e4'],['#ff741f','#24282c','#fffdf8','#97c8d3'],['#97c8d3','#24282c','#f4f1e9','#ff741f']],palette=palettes[seed%palettes.length],variant=(seed>>>3)%4,shiftA=24+(seed%92),shiftB=332+((seed>>>8)%116),tilt=((seed>>>16)%17)-8,empty=napplets+decorations===0;
  const motifs=[
   `<circle cx="${shiftA+54}" cy="92" r="76" fill="${palette[1]}"/><path d="M${shiftB} 40h180v180H${shiftB}z" fill="${palette[3]}" stroke="${palette[0]}" stroke-width="7"/><path d="M56 250h410" stroke="${palette[0]}" stroke-width="18"/>`,
   `<path d="M-20 278 172 54l132 154L454 22l220 256" fill="none" stroke="${palette[1]}" stroke-width="42" stroke-linejoin="bevel"/><circle cx="${shiftB}" cy="110" r="62" fill="${palette[3]}" stroke="${palette[0]}" stroke-width="7"/>`,
   `<g transform="rotate(${tilt} 320 160)"><rect x="${shiftA}" y="46" width="172" height="226" fill="${palette[3]}" stroke="${palette[0]}" stroke-width="7"/><rect x="${shiftB}" y="82" width="136" height="146" fill="${palette[1]}" stroke="${palette[0]}" stroke-width="7"/></g><circle cx="540" cy="64" r="28" fill="${palette[2]}"/>`,
   `<path d="M42 50h238v98H42zM360 172h238v98H360z" fill="${palette[1]}" stroke="${palette[0]}" stroke-width="7"/><path d="m278 99 88 74" stroke="${palette[0]}" stroke-width="18"/><circle cx="${shiftA+206}" cy="244" r="48" fill="${palette[3]}"/>`,
  ];
  const art=`<svg class="canvas-cover-art" viewBox="0 0 640 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><rect width="640" height="320" fill="${palette[2]}"/><path class="canvas-cover-grid" d="M0 40h640M0 80h640M0 120h640M0 160h640M0 200h640M0 240h640M0 280h640M40 0v320M80 0v320M120 0v320M160 0v320M200 0v320M240 0v320M280 0v320M320 0v320M360 0v320M400 0v320M440 0v320M480 0v320M520 0v320M560 0v320M600 0v320" stroke="${palette[0]}" stroke-opacity=".12" stroke-width="1"/>${motifs[variant]}<g class="canvas-cover-brand" fill="${palette[0]}"><text x="42" y="292">FREEDOM TOOLS</text><path d="M574 274h25v25h-25z" fill="${palette[1]}" stroke="${palette[0]}" stroke-width="5"/></g></svg>`;
  return `<div class="canvas-cover${empty?' canvas-cover-empty':''}" role="img" aria-label="Decorative Freedom Tools cover for ${esc(workshop.title)} Canvas; not a content preview" data-cover-seed="${seed.toString(16)}">${art}${empty?'<span class="canvas-cover-state">Ready for ideas</span>':''}</div><div class="canvas-overview-meta"><span>${napplets} ${napplets===1?'Napplet':'Napplets'}</span><span>${decorations} ${decorations===1?'decoration':'decorations'}</span></div>`;
}
let workshopsLoading=false,workshopsLoadError='',workshopsLoadEpoch=0;
function workshopsCacheKey(){return me?.pubkey?'freedom-canvases:'+me.pubkey:'';}
function cachedWorkshops(){try{const key=workshopsCacheKey(),saved=key&&JSON.parse(sessionStorage.getItem(key)||'null');return Array.isArray(saved)?saved.filter(w=>w&&typeof w.id==='string'&&typeof w.title==='string'&&typeof w.introduction==='string'):[];}catch{return [];}}
function cacheWorkshops(items){try{const key=workshopsCacheKey();if(key)sessionStorage.setItem(key,JSON.stringify(items));}catch{}}
async function workshopsPage() {
  const epoch=++workshopsLoadEpoch;
  nappletHost.revoke();detail=null;selectedWorkshop='';requestedProjectId=null;
  clearTimeout(reconnectTimer);const previous=socket;socket=null;previous?.close();subscribedRequest='';
  const url=new URL(location.href);url.searchParams.delete('workshop');url.searchParams.delete('project');history.replaceState(null,'',url);
  if(!workshops.length)workshops=cachedWorkshops();
  screen='workshops';menu=false;createWorkshop=false;workshopsLoading=true;workshopsLoadError='';render();
  try{const listed=await api('workshops',undefined,undefined,'',AbortSignal.timeout(5000));if(epoch!==workshopsLoadEpoch)return;workshops=listed.workshops;cacheWorkshops(workshops);}
  catch(error){if(epoch!==workshopsLoadEpoch)return;workshopsLoadError=error?.name==='TimeoutError'?'Canvas list took too long to respond.':'Canvas list could not be refreshed.';}
  finally{if(epoch===workshopsLoadEpoch){workshopsLoading=false;if(screen==='workshops')render();}}
}
function canvasDraftKey(){return 'canvas-create:'+me.pubkey;}
function canvasDraft(){try{return JSON.parse(sessionStorage.getItem(canvasDraftKey())||'null')||{};}catch{return {};}}
function saveCanvasDraft(fields={}){const previous=canvasDraft(),form=$('#workshop-form');const next={...previous,...(form?{title:$('#workshop-title').value,introduction:$('#workshop-intro').value,owner:$('#workshop-owner').value}:{}),...fields,idempotencyKey:previous.idempotencyKey||crypto.randomUUID()};sessionStorage.setItem(canvasDraftKey(),JSON.stringify(next));return next;}
function registerTowerForm(){return '<form id="canvas-tower-form"><label for="canvas-tower-label">Backend name</label><input id="canvas-tower-label" maxlength="80" required><label for="canvas-tower-origin">NStack backend address</label><input id="canvas-tower-origin" type="url" placeholder="https://nstack.example.com" required><button type="submit">Add NStack backend</button></form>';}
document.addEventListener('input',event=>{if(event.target.closest('#workshop-form'))saveCanvasDraft();});
document.addEventListener('change',event=>{if(event.target.closest('#workshop-form'))saveCanvasDraft();});
let canvasSetup=null;
const setupError=error=>String(error?.message||error||'Setup could not continue').replace(/\bTower\b/g,'NStack backend').replace(/\btower\b/g,'backend');
function setupSteps(step){return `<ol class="setup-stepper" aria-label="Canvas setup progress">${['Create Canvas','Connect an NStack backend','Choose the Workspace','Confirm and launch'].map((label,index)=>{const number=index+1,state=number<step?'complete':number===step?'current':'upcoming';return `<li class="${state}" ${number===step?'aria-current="step"':''}><span>${number<step?'✓':number}</span><small>${esc(label)}</small></li>`;}).join('')}</ol>`;}
function setupFrame(content){return `<div class="setup-heading"><div><div class="eyebrow">Canvas setup</div><h1 id="canvas-setup-title">Set up your Canvas</h1></div><button type="button" data-a="close-canvas-setup" class="setup-close" aria-label="Close Canvas setup">×</button></div>${setupSteps(canvasSetup.step)}<div class="setup-body">${content}</div>`;}
function renderCanvasSetup(){
 if(!canvasSetup)return;const d=canvasDraft(),step=canvasSetup.step,w=workshops.find(w=>w.id===d.workshopId),tower=towers.find(t=>t.id===d.towerId),workspace=towerWorkspaces.find(item=>item.identity?.workspace_id===d.workspaceId),locked=!!w?.tower_id;
 let content='';
 if(step===1)content=`<h2>1. Create Canvas</h2><p>Name the shared space and choose its owner. Your entries are kept if you go back or close setup.</p><form id="workshop-form" novalidate><label for="workshop-title">Canvas title</label><input id="workshop-title" maxlength="120" value="${esc(d.title)}" required ${d.workshopId?'readonly':''}><label for="workshop-intro">Introduction</label><textarea id="workshop-intro" maxlength="3000" required ${d.workshopId?'readonly':''}>${esc(d.introduction)}</textarea><label for="workshop-owner">Owner</label><select id="workshop-owner" ${d.workshopId?'disabled':''}>${knownPeople.map(p=>`<option value="${esc(p.pubkey)}" ${p.pubkey===(d.owner||me.pubkey)?'selected':''} data-profile-name="${esc(p.pubkey)}">${esc(profileName(p))}</option>`).join('')}</select><p id="canvas-create-error" class="setup-error" role="alert">${esc(canvasSetup.error||'')}</p><div class="setup-actions">${d.workshopId?'<button type="button" data-a="start-another-canvas">Start another Canvas</button>':''}<button class="primary" type="submit">Next: Connect backend</button></div></form>`;
 if(step===2){
  const status=canvasSetup.connectionStatus,connected=status==='success',diagnostic=storage?.datasetDiscovery,managedMismatch=diagnostic?.code==='managed_binding_mismatch',signerMismatch=diagnostic?.code==='signer_target_mismatch',bindingRequired=diagnostic?.code==='dataset_binding_required',mismatch=managedMismatch||signerMismatch||bindingRequired;
  const mismatchNotice=managedMismatch?`<div class="connection-result failure origin-mismatch" role="alert"><strong>Dataset discovery is blocked by an exact managed-binding mismatch.</strong><p>Canvas destination: <code>${esc(diagnostic.canvasOrigin)}</code></p><p>Managed dataset broker: <code>${esc(diagnostic.managedOrigin||'Not configured')}</code></p><p>Keep this Canvas on its selected destination. Ask the site operator to enable a secure exact binding for this Canvas destination, then reopen setup. Do not reconnect this Canvas to the broker’s other backend.</p></div>`:(signerMismatch||bindingRequired)?`<div class="connection-result failure origin-mismatch" role="alert"><strong>Complete setup for the Canvas dataset identity.</strong><p>${esc(diagnostic.message)}</p><p>Authorize the displayed dataset app identity for this same backend workspace. The existing publication and private-file storage identity stays unchanged.</p></div>`:'';
  content=`<h2>2. Connect an NStack backend</h2><p>Choose the backend that will hold this Canvas data, then test access here. A passing test does not save a workspace connection.</p>${mismatchNotice}<label for="workshop-tower">NStack backend</label><select id="workshop-tower" required ${locked?'disabled':''}><option value="">Choose an NStack backend</option>${towers.map(t=>`<option value="${esc(t.id)}" ${d.towerId===t.id?'selected':''}>${esc(t.label)} · ${esc(t.origin)}</option>`).join('')}</select>${status==='pending'?'<p class="connection-result pending" role="status">Testing the NStack backend connection…</p>':connected?`<p class="connection-result success" role="status">Connection successful. ${towerWorkspaces.length} workspace${towerWorkspaces.length===1?'':'s'} available.</p>`:status==='failure'?`<p class="connection-result failure" role="alert">Connection failed. ${esc(canvasSetup.error)}</p>`:mismatch?'':'<p class="notice">You may be asked to approve a read-only workspace-list request with your Nostr signer.</p>'}<div class="setup-actions">${button('canvas-setup-back','Back')}${managedMismatch?'<button disabled>Test connection</button>':button('test-canvas-backend',connected?'Test again':'Test connection','','primary')}<button data-a="canvas-setup-next" ${connected?'':'disabled'}>Next: Choose Workspace</button></div><details><summary>Add an NStack backend</summary>${registerTowerForm()}</details>`;
 }
 if(step===3){const loading=canvasSetup.workspaceStatus==='loading',empty=!loading&&!towerWorkspaces.length;content=`<h2>3. Choose the Workspace</h2><p>Select the workspace for <strong>${esc(d.title||w?.title)}</strong> on ${esc(tower?.label||'the connected backend')}.</p>${loading?'<p class="connection-result pending" role="status">Refreshing workspaces…</p>':canvasSetup.error?`<p class="connection-result failure" role="alert">${esc(canvasSetup.error)}</p>`:''}<fieldset class="workspace-choices" ${loading?'disabled':''}><legend>Available workspaces</legend>${towerWorkspaces.map(item=>{const id=item.identity.workspace_id;return `<label class="workspace-choice"><input type="radio" name="canvas-workspace" value="${esc(id)}" ${d.workspaceId===id?'checked':''}><span><strong>${esc(item.label||'Workspace')}</strong><small>${esc(id)}</small></span></label>`;}).join('')}${empty?'<p class="empty-workspaces" role="status">No workspaces are available on this backend. Create one below or refresh after access changes.</p>':''}</fieldset><div class="setup-actions">${button('canvas-setup-back','Back')}${button('refresh-canvas-workspaces','Refresh workspaces')}<button data-a="canvas-setup-next" ${d.workspaceId&&workspace?'':'disabled'}>Next: Confirm</button></div><details><summary>Create a workspace</summary><form id="tower-create-form"><label for="tower-workspace-name">New workspace name</label><input id="tower-workspace-name" maxlength="80" required><button type="submit">Create workspace</button><p id="tower-setup-error" role="alert"></p></form></details>`;}
 if(step===4){const target=storage?.binding?.target,chosen=workspace||{label:d.workspaceLabel,identity:{workspace_id:d.workspaceId}},saving=canvasSetup.saveStatus==='pending',failed=canvasSetup.saveStatus==='failure';content=`<h2>4. Confirm and launch</h2><p>Review the exact relationship before it is saved.</p><dl class="setup-summary"><div><dt>Canvas</dt><dd>${esc(d.title||w?.title)}</dd></div><div><dt>NStack backend</dt><dd>${esc(tower?.label||'Backend')}<small>${esc(tower?.origin||target?.towerUrl||'')}</small></dd></div><div><dt>Workspace</dt><dd>${esc(chosen?.label||'Workspace')}<small>${esc(chosen?.identity?.workspace_id||target?.workspaceId||'')}</small></dd></div><div><dt>Publication and private-file app</dt><dd><code>${esc(storage?.appNpub||'Unavailable')}</code></dd></div><div><dt>Canvas dataset app</dt><dd><code>${esc(storage?.datasetAppNpub||storage?.dataset?.appNpub||'Unavailable')}</code></dd></div></dl><p class="notice">Confirming authorizes both displayed app identities for this exact workspace, verifies private storage and dataset access, saves each relationship separately, and opens the Canvas.</p>${saving?'<p class="connection-result pending" role="status">Saving and checking the connection…</p>':failed?`<p class="connection-result failure" role="alert">Setup was not saved as complete. ${esc(canvasSetup.error)}</p>`:''}<div class="setup-actions">${button('canvas-setup-back','Back')}<button class="primary" data-a="confirm-canvas-setup" ${saving?'disabled':''}>${failed?'Retry confirm and launch':'Confirm and launch'}</button></div>`;}
 const modal=$('#dialog');modal.className='canvas-setup-modal';modal.setAttribute('aria-labelledby','canvas-setup-title');modal.innerHTML=setupFrame(content);modal.querySelector('.setup-body h2')?.setAttribute('tabindex','-1');if(!modal.open){dialogOpener ||= document.activeElement;modal.showModal();}queueMicrotask(()=>{if(!modal.contains(document.activeElement))modal.querySelector(canvasSetup.focus||'.setup-body h2, input, select, button')?.focus();canvasSetup.focus=null;});
}
async function openCanvasSetup(id=''){
 nappletHost.revoke();detail=null;clearTimeout(reconnectTimer);socket?.close();socket=null;createWorkshop=false;menu=false;
 towers=(await api('site/towers')).towers;knownPeople=(await api('site/people')).people;for(const p of knownPeople)profiles.seed(p.pubkey,p.event);hydrateProfiles(knownPeople);workshops=(await api('workshops')).workshops;
 let d=canvasDraft();if(id){const w=workshops.find(item=>item.id===id);if(!w)throw Error('Canvas not found');selectedWorkshop=id;storage=await api('host/storage');const selected=towers.find(t=>t.id===w.tower_id)||towers.find(t=>t.origin===storage.towerOrigin),target=storage.binding?.target;d=saveCanvasDraft({workshopId:id,title:w.title,introduction:w.introduction,owner:w.owner,towerId:selected?.id||d.towerId,workspaceId:target?.workspaceId||d.workspaceId,workspaceLabel:target?.workspaceId?'Saved workspace':d.workspaceLabel});activeTowerId=d.towerId||null;towerConnectionStorage=storage;if(target?.workspaceId)towerWorkspaces=[{label:d.workspaceLabel||'Saved workspace',identity:{workspace_id:target.workspaceId,workspace_owner_npub:target.workspaceOwnerNpub}}];}else if(d.workshopId&&workshops.some(w=>w.id===d.workshopId)){selectedWorkshop=d.workshopId;storage=await api('host/storage');activeTowerId=d.towerId||workshops.find(w=>w.id===d.workshopId)?.tower_id||null;}else{selectedWorkshop='';d=saveCanvasDraft({workshopId:null,title:d.title||'',introduction:d.introduction||'',owner:d.owner||me.pubkey,towerId:d.towerId||'',workspaceId:d.workspaceId||''});}
 const step=id?(['dataset_binding_required','managed_binding_mismatch','signer_target_mismatch'].includes(storage?.datasetDiscovery?.code)?2:storage?.state==='probing'&&storage.binding?.target?.workspaceId?4:activeTowerId?2:1):1;canvasSetup={step,error:'',connectionStatus:'idle',workspaceStatus:'idle',saveStatus:'idle',focus:null};renderCanvasSetup();
}
async function completeCanvasSetup(id){await openCanvasSetup(id);}
const pendingControls = new Map();
let requestedProjectId = new URL(location.href).searchParams.get('project');
async function openRequestedProject() { if (requestedProjectId) { try { await openProject(requestedProjectId); } catch (error) { toast(error.message); } } }
function startBusy() { busy = true; document.body.setAttribute('aria-busy','true'); document.querySelectorAll('button,input,textarea,select').forEach(control => { pendingControls.set(control,control.disabled); control.disabled = true; }); }
function endBusy() { busy = false; document.body.removeAttribute('aria-busy'); pendingControls.forEach((wasDisabled,control) => { if (control.isConnected) control.disabled = wasDisabled; }); pendingControls.clear(); }
function readInvitationStorage(){try{return sessionStorage.getItem(invitationStorageKey);}catch{return null;}}
function writeInvitationStorage(value){try{if(value)sessionStorage.setItem(invitationStorageKey,value);else sessionStorage.removeItem(invitationStorageKey);sessionStorage.removeItem('freedom-join-code');}catch{}}
function invitationState(){return invitationAtNavigation(location.href,readInvitationStorage(),history.state);}
function invitationError(invitation){return invitation.explicit&&!invitation.valid?'This invitation link does not contain a valid six-digit code. Enter the code from your invitation to continue.':'';}
const initialInvitation=invitationState();
let pendingCode=initialInvitation.code;
let selectedWorkshop=new URL(location.href).searchParams.get('workshop')||'',workshops=[],towers=[],profile=null;
let me = null, csrf = '', screen = 'start', signUp = false, menu = false, state = null, detail = null, people = null, publication = null, builderGuidance = null, storage = null, towerWorkspaces = [], workspaceCreateIntent = null, socket = null, busy = false, joinCodeError = invitationError(initialInvitation);
const builderPreviewRevisions=new Map();
const forkRequestStorageKey=id=>`freedom-fork:${me.pubkey}:${selectedWorkshop}:${id}`;
function forkRequestId(id){const key=forkRequestStorageKey(id),saved=sessionStorage.getItem(key);if(saved)return saved;const created=crypto.randomUUID();sessionStorage.setItem(key,created);return created;}
const nappletHost = installNappletHost(() => ({member:me,csrf,workshop:selectedWorkshop}));
const nappletPayloadCache=createNappletPayloadCache();
const pendingNappletSources=new WeakMap();
window.addEventListener('message',event=>{
  if(event.origin!=='null')return;
  const frame=[...document.querySelectorAll('iframe[data-napplet]')].find(frame=>frame.contentWindow===event.source);
  if(event.data?.type==='freedom-napplet-document-ready'&&frame?.dataset.runtimeBinding==='true'&&event.data.sourceHash===frame.dataset.sourceHash){frame.dataset.runtimeReady='true';return;}
  if(event.data?.type!=='freedom-napplet-source-request'||event.ports.length!==1)return;
  const pending=frame&&pendingNappletSources.get(frame);
  if(!frame||!pending||event.data.sourceHash!==frame.dataset.sourceHash||event.data.sourceHash!==pending.sourceHash){event.ports[0].close();return;}
  pendingNappletSources.delete(frame);frame.dataset.runtimeBinding='true';nappletHost.sync();event.ports[0].postMessage({source:pending.source});event.ports[0].close();
});
if(initialInvitation.explicit){if(initialInvitation.valid)rememberJoinCode(initialInvitation.code,true);else writeInvitationStorage('');}
else if(!initialInvitation.restored)writeInvitationStorage('');
async function api(path, body, method, workshopScope=selectedWorkshop, signal) {
  const response = await fetch('/api/v1/' + path, { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: { 'content-type':'application/json', 'x-csrf-token':csrf,...(workshopScope||new URL(location.href).searchParams.has('workshop')?{'x-workshop-id':workshopScope}:{}) }, ...(body === undefined ? {} : { body:JSON.stringify(body) }),...(signal?{signal}:{}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
function toast(message) { $('#toast').textContent = humanText(message); $('#toast').style.display = 'block'; clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('#toast').style.display = 'none', 6500); }
let dialogOpener = null;
$('#dialog').addEventListener('cancel',event=>{if(canvasSetup){event.preventDefault();saveCanvasDraft();towerSetupEpoch++;$('#dialog').close();}});
$('#dialog').addEventListener('close', () => { if(canvasSetup)canvasSetup=null;$('#dialog').className='';$('#dialog').removeAttribute('aria-labelledby');if (dialogOpener?.isConnected && !activeViewer) dialogOpener.focus(); dialogOpener = null; });
$('#dialog').addEventListener('click',event=>{const modal=$('#dialog'),rect=modal.getBoundingClientRect();if(event.target===modal&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))modal.close();});
function dialog(html,opener=null,topClose=false) { if (!$('#dialog').open) dialogOpener=opener||document.activeElement;const modal=$('#dialog');modal.className=topClose?'app-dialog napplet-action-modal':'app-dialog';modal.innerHTML=(topClose?'<button type="button" class="dialog-close" data-a="close" aria-label="Close Napplet actions">[x]</button>':'')+html+(topClose?'':'<div class="actions dialog-actions"><button data-a="close">Close</button></div>');const heading=modal.querySelector('h1,h2');if(heading){heading.id='dialog-title';modal.setAttribute('aria-labelledby',heading.id);}else modal.removeAttribute('aria-labelledby');modal.showModal();if(topClose)queueMicrotask(()=>modal.querySelector('.napplet-owner-actions button,input,form button')?.focus()); }
const button = (action, label, id = '', className = '') => `<button data-a="${action}" data-id="${esc(id)}" class="${className}">${label}</button>`;
const back = () => button('page', '← BYOF Canvas page', '', 'back');
let reconnectTimer=null, reconnectDelay=500, subscribedRequest='';
function subscribeRequest() {
  if(socket?.readyState!==WebSocket.OPEN)return;
  const request=screen==='builder'&&detail?detail.requests.at(-1):null;
  const key=request?detail.project.id+':'+request.id:'';
  if(key===subscribedRequest)return;
  subscribedRequest=key;
  socket.send(JSON.stringify(request?{type:'subscribe',projectId:detail.project.id,requestId:request.id}:{type:'unsubscribe'}));
}
function applyProjectUpdate(updated) {
  if(!detail||screen!=='builder'||updated.project.id!==detail.project.id)return;
  const previousActive=detail.project.current_revision,sameRevision=updated.project.current_revision===previousActive,selected=builderPreviewRevisions.get(detail.project.id);
  if(!selected||selected===previousActive||!updated.revisions.some(revision=>revision.id===selected))builderPreviewRevisions.set(detail.project.id,updated.project.current_revision);
  for(const next of updated.requests)pingCompletedTurn(detail.requests.find(r=>r.id===next.id),next);
  saveDraft(); detail=updated;
  if(sameRevision){const pane=$('.conversation-pane');if(pane)refreshConversation(pane);}
  else if(!activeViewer){const pane=$('.conversation-pane');if(pane)refreshConversation(pane,false,true);else render();}else viewerRevisionPending=true;
  subscribeRequest();
}
function connect() {
  clearTimeout(reconnectTimer); const previous=socket;socket=null;previous?.close();subscribedRequest='';
  if(!me||me.state!=='admitted'&&!me.host)return;
  const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/v1/events?workshop='+encodeURIComponent(selectedWorkshop));socket=ws;
  ws.onopen=()=>{if(socket!==ws)return;reconnectDelay=500;subscribeRequest();};
  ws.onmessage=async event=>{
    if(socket!==ws)return;
    try {
      const message=JSON.parse(event.data);
      if(message.type==='room'){state={...state,...message.data};if(screen==='page')render();}
      if(message.type==='request'&&screen==='builder'&&detail?.project.id===message.projectId&&message.workshopId===selectedWorkshop){
        const index=detail.requests.findIndex(r=>r.id===message.requestId);if(index<0)return;
        // Snapshot replacement is duplicate-safe and restores all ordered progress.
        pingCompletedTurn(detail.requests[index],message.data);
        saveDraft();detail.requests[index]=message.data;
        if(message.currentRevision!==detail.project.current_revision){applyProjectUpdate(await api('projects/'+message.projectId));}
        else {const pane=$('.conversation-pane');if(pane)refreshConversation(pane);}
      }
    } catch(error){toast(error.message);}
  };
  ws.onclose=event=>{if(socket!==ws)return;socket=null;subscribedRequest='';if(event.code===1008)return;reconnectTimer=setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(15000,reconnectDelay*2);};
}

async function page() {
  if(selectedWorkshop){
    const [room,listed]=await Promise.all([api('room'),workshops.length?Promise.resolve(null):api('workshops')]);
    if(listed){workshops=listed.workshops;cacheWorkshops(workshops);}
    state=room;
  }else{
    const listed=await api('workshops');workshops=listed.workshops;cacheWorkshops(workshops);selectedWorkshop=listed.legacyWorkshopId;state=await api('room');
  }
  setMember(state.member);hydrateProfiles(state.gallery.map(p=>({pubkey:p.authorPubkey})));
  const u=new URL(location.href);u.searchParams.set('workshop',selectedWorkshop);history.replaceState(null,'',u);
  screen='page';menu=false;render();subscribeRequest();
}
async function openProject(id, edit = false) { detail = await api('projects/' + encodeURIComponent(id) + (edit ? '/edit' : ''));if(!detail.revisions.some(revision=>revision.id===builderPreviewRevisions.get(detail.project.id)))builderPreviewRevisions.set(detail.project.id,detail.project.current_revision); screen = 'builder'; menu = false; render(); const history=$('.conversation-history');if(history)history.scrollTop=history.scrollHeight; subscribeRequest(); }
function preview(id, revision, sourceHash, title = "Napplet", suppliedUrl = null, deferred = false) { const source=suppliedUrl || `/api/v1/projects/${encodeURIComponent(id)}/preview?workshop=${encodeURIComponent(selectedWorkshop)}&revision=${encodeURIComponent(revision)}`;return `<iframe data-napplet data-project="${esc(id)}" data-revision="${esc(revision)}" data-source-hash="${esc(sourceHash)}" data-workshop="${esc(selectedWorkshop)}" data-src="${esc(source)}" title="${esc(title)} preview" sandbox="allow-scripts allow-forms" allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'" referrerpolicy="no-referrer"${deferred?'':' data-load-now="true"'}></iframe>`; }
// Keep the builder iframe in its original dialog: resizing never reparents or reloads it.
let viewerRevisionPending = false;
let activeViewer = null, viewerOpener = null, viewerScroll = '';
function viewerMarkup(title, id, revision, sourceHash, inline = false, suppliedUrl = null, deferred = false) {
  return `<dialog class="napplet-viewer${inline ? ' inline-viewer' : ''}" ${inline ? 'open' : ''} aria-label="${esc(title)}"><div class="viewer-toolbar"><h2>${esc(title)}</h2><div class="actions"><button type="button" data-viewer="fullscreen">Full screen</button><button type="button" data-viewer="close">Close</button></div></div>${preview(id, revision, sourceHash, title, suppliedUrl, deferred)}</dialog>`;
}
let nappletVisibilityObserver=null,activeNappletLoads=0;
const nappletLoadQueue=[],maxConcurrentNappletLoads=3;
function drainNappletLoads(){
  while(activeNappletLoads<maxConcurrentNappletLoads&&nappletLoadQueue.length){
    const frame=nappletLoadQueue.shift();delete frame.dataset.loadQueued;
    if(!frame.isConnected||frame.dataset.loaded||frame.dataset.loading||!frame.dataset.src||frame.closest('.napplet-card.minimized'))continue;
    activeNappletLoads++;let done=false,timer;const settled=()=>{if(done)return;done=true;clearTimeout(timer);activeNappletLoads=Math.max(0,activeNappletLoads-1);drainNappletLoads();};
    frame.addEventListener('load',settled,{once:true});frame.addEventListener('error',settled,{once:true});timer=setTimeout(settled,10000);frame.dataset.loading='true';nappletVisibilityObserver?.unobserve(frame);
    nappletPayloadCache.load({projectId:frame.dataset.project,revisionId:frame.dataset.revision,sourceHash:frame.dataset.sourceHash,workshopId:frame.dataset.workshop}).then(result=>{if(frame.isConnected&&frame.dataset.revision){const url=`/api/v1/projects/${encodeURIComponent(frame.dataset.project)}/runtime?workshop=${encodeURIComponent(frame.dataset.workshop)}&revision=${encodeURIComponent(frame.dataset.revision)}`;pendingNappletSources.set(frame,{source:result.source,sourceHash:frame.dataset.sourceHash});delete frame.dataset.loading;frame.dataset.loaded='true';frame.dataset.cacheHit=String(result.cacheHit);frame.dataset.runtimeUrl=url;frame.src=url;}}).catch(()=>{if(frame.isConnected){delete frame.dataset.loading;frame.dataset.loaded='true';frame.dataset.runtimeBinding='true';frame.dataset.runtimeReady='true';frame.src=frame.dataset.src;}});
  }
}
function loadNappletFrame(frame){if(frame?.dataset.src&&!frame.dataset.loaded&&!frame.dataset.loading&&frame.dataset.loadQueued!=='true'){frame.dataset.loadQueued='true';nappletLoadQueue.push(frame);drainNappletLoads();}}
function armVisibleNapplets(){
  nappletVisibilityObserver?.disconnect();nappletVisibilityObserver=null;
  const root=$('.board-viewport'),frames=[...document.querySelectorAll('.board-plane iframe[data-napplet][data-src]')].filter(frame=>!frame.closest('.napplet-card.minimized'));
  if(!root||!frames.length)return;
  if('IntersectionObserver' in window){nappletVisibilityObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)loadNappletFrame(entry.target);},{root,rootMargin:'160px'});for(const frame of frames)if(!frame.src)nappletVisibilityObserver.observe(frame);}
  requestAnimationFrame(()=>{const visible=root.getBoundingClientRect();for(const frame of frames){if(frame.src)continue;const box=frame.getBoundingClientRect();if(box.right>=visible.left-160&&box.left<=visible.right+160&&box.bottom>=visible.top-160&&box.top<=visible.bottom+160)loadNappletFrame(frame);}});
}
function openViewer(viewer, opener) {
  viewerOpener = opener; activeViewer = viewer;
  viewerScroll = document.body.style.overflow; document.body.style.overflow = 'hidden';
  if (viewer.open) viewer.close();
  viewer.classList.add('expanded-viewer'); viewer.showModal();
  viewer.querySelector('[data-viewer="close"]').focus();
}
function syncViewer() {
  if (!activeViewer) return;
  activeViewer.classList.toggle('native-fullscreen', document.fullscreenElement === document.documentElement);
  const full = document.fullscreenElement === document.documentElement || activeViewer.classList.contains('viewport-fullscreen');
  activeViewer.querySelector('[data-viewer="fullscreen"]').textContent = full ? 'Exit full screen' : 'Full screen';
}
async function exitViewerFullscreen() {
  if (document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => {});
  activeViewer?.classList.remove('viewport-fullscreen'); syncViewer();
}
async function closeViewer() {
  const viewer = activeViewer; if (!viewer) return;
  await exitViewerFullscreen();
  viewer.close(); viewer.classList.remove('expanded-viewer');
  if (viewer.classList.contains('inline-viewer')) viewer.setAttribute('open', '');
  else viewer.remove();
  activeViewer = null; document.body.style.overflow = viewerScroll;
  if (viewerOpener?.isConnected) viewerOpener.focus(); viewerOpener = null;
  if (viewerRevisionPending) { viewerRevisionPending = false; render(); }
}
document.addEventListener('fullscreenchange', syncViewer);
function viewerEscape() {
  if (!activeViewer) return;
  if (activeViewer.classList.contains('viewport-fullscreen') || document.fullscreenElement === document.documentElement) void exitViewerFullscreen();
  else void closeViewer();
}
document.addEventListener('cancel', event => {
  if (event.target !== activeViewer) return;
  event.preventDefault(); viewerEscape();
}, true);
window.addEventListener('message', event => {
  if(event.data?.type==='freedom-preview-focus') { const frame=[...document.querySelectorAll('.board-plane iframe')].find(f=>f.contentWindow===event.source); if(frame)raiseWindow(frame.closest('[data-object]')); }
  if (activeViewer && event.source === activeViewer.querySelector('iframe')?.contentWindow && event.data?.type === 'freedom-preview-escape') viewerEscape();
});
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-viewer]'); if (!control || !activeViewer) return;
  if (control.dataset.viewer === 'close') return void closeViewer();
  if (document.fullscreenElement === document.documentElement || activeViewer.classList.contains('viewport-fullscreen')) return void exitViewerFullscreen();
  const viewer = activeViewer;
  try {
    // Dialogs cannot request fullscreen themselves; the root keeps the modal in the top layer.
    if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable');
    await document.documentElement.requestFullscreen();
    if (activeViewer !== viewer) await document.exitFullscreen().catch(() => {});
  } catch {
    if (activeViewer === viewer) viewer.classList.add('viewport-fullscreen');
  }
  syncViewer();
});
// Patch workshop cards in place so room events and title changes keep running frames.
function patchPage(parent, fresh) {
  const key = node => node.nodeType === 1 ? node.getAttribute('data-preview-key') || node.getAttribute('data-card-key') : null;
  const old = [...parent.childNodes];
  let cursor = parent.firstChild;
  for (const next of [...fresh.childNodes]) {
    const match = key(next) ? old.find(n => key(n) === key(next)) : cursor && !key(cursor) && cursor.nodeType === next.nodeType && cursor.nodeName === next.nodeName ? cursor : null;
    if (!match) { parent.insertBefore(next, cursor); continue; }
    if (match !== cursor) {
      if (parent.moveBefore) parent.moveBefore(match, cursor);
      else parent.insertBefore(match, cursor);
    }
    if (match.nodeType === 1) {
      for (const attr of [...match.attributes]) if (!next.hasAttribute(attr.name) && !(attr.name==='style' && (match.dataset.object || match.classList.contains('board-plane') || match.classList.contains('board-viewport'))) && !(match.tagName==='IFRAME'&&['src','data-loading','data-loaded','data-cache-hit','data-runtime-url','data-runtime-binding','data-runtime-ready'].includes(attr.name)&&next.dataset.src===match.dataset.src)) match.removeAttribute(attr.name);
      for (const attr of [...next.attributes]) if (match.getAttribute(attr.name) !== attr.value) match.setAttribute(attr.name, attr.value);
      // src and title may change, but unchanged frames must never be replaced.
      if (match.tagName !== 'IFRAME') patchPage(match, next);
    } else if (match.nodeValue !== next.nodeValue) match.nodeValue = next.nodeValue;
    old.splice(old.indexOf(match), 1); cursor = match.nextSibling;
  }
  for (const node of old) if (node.parentNode === parent) node.remove();
}
function renderWorkshop(html) {
  const fresh = document.createElement('template'); fresh.innerHTML = html;
  if ($('#main').dataset.workshop === selectedWorkshop) patchPage($('#main'), fresh.content);
  else { $('#main').innerHTML = html; $('#main').dataset.workshop = selectedWorkshop; }
}
const popOutIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 3H3v18h18v-7"/></svg>';
const minimizedNapplets = new Set();
const windowIcon = path => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${path}</svg>`;
const cogIcon = windowIcon('<path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>');
function nappletCard(p, own) {
  const revision = p.current_revision;
  const owner = own || state.projects.some(project => project.id === p.id), canEdit=owner||me.host;
  const key = selectedWorkshop + ':' + p.id, minimized = minimizedNapplets.has(key), appId = `app-${own ? 'own' : 'shared'}-${p.id}`;
  const control = (action,label,icon,kind='') => `<button type="button" class="window-control ${kind}" data-a="${action}" data-id="${esc(p.id)}" aria-label="${esc(label)}" title="${esc(label)}"${action==='minimize' ? ` aria-expanded="${!minimized}" aria-controls="${esc(appId)}"` : ''}${action==='pop-out'&&!revision?' disabled':''}>${icon}</button>`;
  return `<section class="card napplet-card${minimized ? ' minimized' : ''}" data-card-key="napplet:${esc(p.id)}" data-object="${esc(p.id)}" data-project-id="${esc(p.id)}" tabindex="0" aria-label="${esc(p.title)} window"><div class="window-bar"><h2 title="${esc(p.title)}">${esc(p.title)}</h2><div class="window-controls">${control('minimize',(minimized?'Restore ':'Minimize ')+p.title,windowIcon(minimized?'<path d="M6 8h12v10H6Z"/>':'<path d="M5 12h14"/>'),'yellow')}${control('pop-out','Open '+p.title+' in larger viewer',popOutIcon,'green')}${control(canEdit ? 'napplet-settings' : 'napplet-options',(canEdit ? 'Settings for ' : 'Options for ')+p.title,canEdit ? cogIcon : windowIcon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'))}</div></div><div id="${esc(appId)}" class="window-app" ${minimized ? 'inert aria-hidden="true"' : ''} data-preview-key="napplet:${esc(p.id)}:${esc(revision)}">${revision ? viewerMarkup(p.title, p.id, revision, p.source_hash, true, p.appVersionUrl, true) : '<p class="unbuilt">This Napplet is waiting for its first completed build. Its owner or a Canvas administrator can open the builder from Settings.</p>'}</div>${me.host ? `<button class="board-resize" data-resize="${esc(p.id)}" aria-label="Resize ${esc(p.title)}">↘</button>` : ''}</section>`;
}
// Shared layout and personal presentation are separate. Saves are explicit and
// compare the server version; incoming room refreshes never discard dirty edits.
const boardViews = new Map(), boardDrafts = new Map();
function boardDraft() {
  let draft=boardDrafts.get(selectedWorkshop), board=state.board;
  if(!draft || !draft.dirty && draft.version!==board.version) { draft={version:board.version,objects:structuredClone(board.objects),dirty:false};boardDrafts.set(selectedWorkshop,draft); }
  else for(const object of board.objects)if(!draft.objects.some(o=>o.id===object.id))draft.objects.push(structuredClone(object));
  const active=new Set(board.objects.map(o=>o.id));draft.objects=draft.objects.filter(o=>o.kind!=='napplet'||active.has(o.id));
  return draft;
}
function boardView() {
  if(!boardViews.has(selectedWorkshop)) {
    boardViews.set(selectedWorkshop,{x:0,y:0,scale:1,needsInitialFit:true,pan:false,levels:new Map(),level:10});
  }
  return boardViews.get(selectedWorkshop);
}
function arrowBounds(o){return {left:Math.min(0,o.endX,o.curveX??o.endX/2),top:Math.min(0,o.endY,o.curveY??o.endY/2),right:Math.max(0,o.endX,o.curveX??o.endX/2),bottom:Math.max(0,o.endY,o.curveY??o.endY/2)};}
function objectGeometry(node,o){const b=o.kind==='arrow'?arrowBounds(o):{left:0,top:0,right:o.width,bottom:o.height};node.style.left=(o.x+b.left)+'px';node.style.top=(o.y+b.top)+'px';node.style.width=Math.max(1,b.right-b.left)+'px';node.style.height=Math.max(1,b.bottom-b.top)+'px';node.style.setProperty('--app-height',(o.height-44)+'px');}
// Local presentation state only; never changes the recipient or workshop settings.
const donationDetails = new Map();
function donationState() {
  const address = state.room.lightning;
  let details = donationDetails.get(selectedWorkshop);
  if (!details || details.address !== address) {
    details = {address, qr:state.donationQr, revealed:false, feedback:''};
    donationDetails.set(selectedWorkshop, details);
  }
  return details;
}
function donationMarkup() {
  const details = donationState();
  if (!details.address) return '<p>A donation address has not been configured yet.</p>';
  return `<button type="button" class="primary" data-donation="reveal" aria-expanded="${details.revealed}" aria-controls="donation-details">${esc(state.room.support_label || 'Support this BYOF Canvas')}</button><div id="donation-details" class="donation-details" ${details.revealed ? '' : 'hidden'}><p>Lightning address</p><code class="donation-address">${esc(details.address)}</code>${details.qr?`<img class="donation-qr" src="${esc(details.qr)}" alt="Lightning donation QR code">`: ''}<div class="actions"><button type="button" data-donation="copy">Copy address</button><a class="button" href="lightning:${esc(details.address)}">Open in wallet</a></div><p class="notice">If no wallet opens, copy this address and paste it into a Lightning wallet that supports Lightning addresses.</p><p class="donation-feedback" role="status" aria-live="polite">${esc(details.feedback)}</p></div>`;
}
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-donation]');
  if (!control) return;
  // Expanded viewers defer room renders; copy the recipient currently displayed.
  const content = control.closest('.donation-content'), details = donationDetails.get(selectedWorkshop);
  if (control.dataset.donation === 'reveal') {
    details.revealed = true;
    control.setAttribute('aria-expanded', 'true');
    const panel = content.querySelector('.donation-details');
    panel.hidden = false;
    // Bring the address/actions into view in the compact desktop window.
    content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
    return;
  }
  control.disabled = true;
  try {
    await navigator.clipboard.writeText(details.address);
    details.feedback = 'Address copied.';
  } catch {
    details.feedback = 'Could not copy the address. Select the address above and copy it manually.';
  } finally {
    const feedback = content.querySelector('.donation-feedback');
    if (feedback && content.querySelector('.donation-address')?.textContent === details.address) feedback.textContent = details.feedback;
    control.disabled = false;
  }
});
function donationCard(o) {
  const id=o.id,minimized=minimizedNapplets.has(selectedWorkshop+':'+id),title='Support this BYOF Canvas';
  const controls=`<button class="window-control yellow" data-a="minimize" data-id="${id}" aria-label="${minimized?'Restore':'Minimize'} donation" aria-expanded="${!minimized}" title="${minimized?'Restore':'Minimize'} donation">${windowIcon('<path d="M5 12h14"/>')}</button><button class="window-control green" data-a="pop-out" data-id="${id}" aria-label="Open donation in larger viewer" title="Open donation">${popOutIcon}</button>${me.host?`<button class="window-control" data-a="edit" aria-label="Donation settings" title="Donation settings">${cogIcon}</button>`:''}`;
  return `<section class="card napplet-card donation-window${minimized?' minimized':''}" data-card-key="donation" data-object="${id}" tabindex="0" aria-label="Donation window"><div class="window-bar"><h2>${title}</h2><div class="window-controls">${controls}</div></div><div class="window-app" ${minimized?'inert aria-hidden="true"':''} data-preview-key="donation"><dialog class="napplet-viewer inline-viewer" open aria-label="Donation"><div class="viewer-toolbar"><h2>${title}</h2><div class="actions"><button data-viewer="fullscreen">Full screen</button><button data-viewer="close">Close</button></div></div><div class="donation-content"><span aria-hidden="true">₿</span>${donationMarkup()}</div></dialog></div>${me.host?`<button class="board-resize" data-resize="${id}" aria-label="Resize donation">↘</button>`:''}</section>`;
}
function arrowObjectMarkup(o){return `<section class="board-object board-arrow" data-object="${esc(o.id)}" data-card-key="object:${esc(o.id)}" tabindex="0" aria-label="BYOF Canvas arrow">${arrowMarkup(o)}${me.host?`<div class="object-tools"><button data-move="${esc(o.id)}" aria-label="Move arrow">↔</button>${button('board-object','Options',o.id)}</div><button class="arrow-endpoint" data-endpoint="start" aria-label="Adjust arrow start"></button><button class="arrow-endpoint" data-endpoint="end" aria-label="Adjust arrow end"></button><button class="arrow-endpoint curve-point" data-endpoint="curve" aria-label="Curve arrow"></button>`:''}</section>`;}
function boardMarkup() {
  const draft=boardDraft(),view=boardView(),objects=draft.objects,apps=new Map(state.board.napplets.map(p=>[p.id,p]));
  const objectTools=o=>me.host?`<div class="object-tools"><button data-move="${esc(o.id)}" aria-label="Move ${o.kind}" title="Drag to move">↔</button>${button('board-object',o.kind==='text'?'Type':'Options',o.id)}</div><button class="board-resize" data-resize="${esc(o.id)}" aria-label="Resize ${esc(o.kind)}">↘</button>`:'';
  const decoration=o=>o.kind==='arrow'?arrowObjectMarkup(o):`<section class="board-object board-${o.kind}" data-object="${esc(o.id)}" data-card-key="object:${esc(o.id)}" tabindex="0" aria-label="${esc(o.kind==='group'?o.label:o.kind==='image'?o.label:'BYOF Canvas text')}">${o.kind==='group'?`<div class="object-bar"><span>${esc(o.label)}</span>${me.host?button('board-object','Edit',o.id):''}</div>`:o.kind==='text'?`<div class="board-text-content" data-text-object="${esc(o.id)}">${esc(o.text)}</div>`:`<img src="${esc(o.src)}" alt="${esc(o.label)}" referrerpolicy="no-referrer" draggable="false">`}${objectTools(o)}</section>`;
  const tool=(action,label,icon)=>`<button data-board="${action}" aria-label="${label}" title="${label}"${action==='pan'?` aria-pressed="${view.pan}"`:['text','image','arrow'].includes(action)?` aria-pressed="${view.tool===action}"`:''}>${icon}</button>`;
  return `<section class="workshop-desktop" aria-label="BYOF Canvas desktop"><div class="canvas-title">${button('workshops','←','','canvas-icon')}<h1>${esc(state.room.title)}</h1></div><div class="canvas-actions">${me.host?button('invite','Invite','','canvas-invite'):''}${me.host?`<button class="canvas-icon" data-a="edit" aria-label="Edit BYOF Canvas" title="Edit BYOF Canvas">${cogIcon}</button>`:''}<button class="canvas-icon" data-a="starters" aria-label="New Napplet" title="New Napplet">+</button></div><div class="board-controls" role="toolbar" aria-label="Desktop tools">${tool('pan','Pan mode','✋')}${me.host?`${tool('text','Add text','T')}${tool('image','Add picture','▧')}${tool('arrow','Draw arrow','↗')}${tool('group','Add group','▢')}<button data-board="save" aria-label="Save layout" title="Save layout" ${draft.dirty?'':'disabled'}>Save</button>${tool('more','More board actions','⋯')}<div class="board-more" ${view.more?'':'hidden'}><button data-board="objects">Object options</button><button data-board="reload">Reload layout</button><button data-board="image-url">Picture from URL</button><label>Choose picture<input id="board-picture-file" type="file" accept="image/png,image/jpeg,image/webp"></label></div>`:''}</div><div class="board-zoom-controls" role="toolbar" aria-label="Desktop zoom"><button data-board="fit">Fit all</button><button data-board="reset">100%</button>${tool('out','Zoom out','−')}<output id="board-zoom" aria-label="Zoom level">${Math.round(view.scale*100)}%</output>${tool('in','Zoom in','+')}</div><span id="board-save-status" class="${draft.dirty?'pending':'saved'}" role="status">${draft.dirty?(draft.version!==state.board.version?'Board changed elsewhere; reload before saving.':'Unsaved layout'):'Layout saved'}</span><div id="text-size-controls" role="toolbar" aria-label="Text formatting" hidden>${['bold','italic','underline','shadow'].map(effect=>`<button data-text-effect="${effect}" aria-label="${effect[0].toUpperCase()+effect.slice(1)}" aria-pressed="false">${effect[0].toUpperCase()+effect.slice(1)}</button>`).join('')}<label>Text size <input id="board-font-size" type="number" min="12" max="144" step="1" value="24"></label></div><div id="arrow-controls" role="toolbar" aria-label="Arrow styling" hidden><label for="arrow-colour">Arrow colour</label><input id="arrow-colour" type="color" value="#24282c"><label><input id="arrow-dotted" type="checkbox">Dotted line</label><button data-board="straight-arrow">Straight arrow</button></div><form id="board-url-picture" hidden><label>Picture URL<input id="board-picture-url" type="url" required maxlength="2048" placeholder="https://…"></label><label>URL picture description<input id="board-picture-description" required maxlength="200"></label><button type="submit">Add URL picture</button><button type="button" data-board="close-url">Close</button></form><aside id="board-object-options" hidden aria-label="Object options"></aside><div id="picture-paste-controls" hidden><button data-board="paste-image">Paste picture</button><span>Paste an image here</span></div><div class="board-viewport${view.pan?' pan-mode':''}" tabindex="0" aria-label="Pan and zoom BYOF Canvas. Drag background to select whole items. Use Pan mode or touch to pan, and zoom controls or pinch to zoom."><div class="board-plane">${objects.map(o=>o.kind==='napplet'?nappletCard(apps.get(o.projectId),apps.get(o.projectId).authorPubkey===me.pubkey):o.kind==='donation'?donationCard(o):decoration(o)).join('')}</div><div class="pan-shield" aria-hidden="true"></div><div class="board-selection-box" hidden aria-hidden="true"></div><div class="picture-insertion-marker" hidden aria-hidden="true">+</div></div></section>`;
}
function syncBoardTools() {
  const view=boardView(),text=boardDraft().objects.find(o=>o.id===view.focus&&o.kind==='text');
  if($('#text-size-controls')){$('#text-size-controls').hidden=!me.host||!text;if(text&&document.activeElement!==$('#board-font-size'))$('#board-font-size').value=text.fontSize||24;}
  for(const b of document.querySelectorAll('[data-text-effect]'))b.setAttribute('aria-pressed',String(!!text?.[b.dataset.textEffect]));
  const arrow=boardDraft().objects.find(o=>o.id===view.focus&&o.kind==='arrow');if($('#arrow-controls')){$('#arrow-controls').hidden=!me.host||!arrow;if(arrow){$('#arrow-colour').value=arrow.colour||'#24282c';$('#arrow-dotted').checked=!!arrow.dotted;}}
  syncObjectOptions();
  if($('#picture-paste-controls'))$('#picture-paste-controls').hidden=!view.imagePoint;
  if($('.board-more'))$('.board-more').hidden=!view.more;
  for(const action of ['text','image','arrow'])$(`[data-board="${action}"]`)?.setAttribute('aria-pressed',String(view.tool===action));
  $('[data-board="more"]')?.setAttribute('aria-expanded',String(!!view.more));
  $('.pan-shield')?.classList.toggle('placing',!!view.tool||!!view.drawing);
  const marker=$('.picture-insertion-marker');if(marker){marker.hidden=!view.imagePoint;if(view.imagePoint){marker.style.left=(view.x+view.imagePoint.x*view.scale)+'px';marker.style.top=(view.y+view.imagePoint.y*view.scale)+'px';}}
}
function beginTextEdit(id) {
  if(!me.host)return;const node=$(`[data-text-object="${id}"]`);if(!node)return;
  boardView().editing=id;node.contentEditable='plaintext-only';node.setAttribute('role','textbox');node.setAttribute('aria-label','BYOF Canvas text editor');node.focus();
}
function finishTextEdit() {
  const view=boardView(),id=view.editing;if(!id)return;const node=$(`[data-text-object="${id}"]`),draft=boardDraft(),o=draft.objects.find(o=>o.id===id);view.editing=null;
  if(node){node.removeAttribute('contenteditable');node.removeAttribute('role');node.removeAttribute('aria-label');}
  if(o&&!o.text?.trim()){draft.objects=draft.objects.filter(o=>o.id!==id);node?.closest('[data-object]').remove();}
  syncBoardTools();
}
function insertText(point) {
  const draft=boardDraft(),id=crypto.randomUUID();draft.objects.push({id,kind:'text',x:point.x,y:point.y,width:360,height:100,groupId:null,text:'',fontSize:24});draft.dirty=true;boardView().focus=id;render();raiseWindow($(`[data-object="${id}"]`));beginTextEdit(id);
}
async function insertClipboardImage(blob) {
  const view=boardView(),point=view.imagePoint,scope=selectedWorkshop;if(!me.host||!point)throw Error('Choose a board position with the picture tool first.');
  if(!['image/png','image/jpeg','image/webp'].includes(blob.type)||blob.size>10000000)throw Error('Use a PNG, JPEG or WebP picture under 10 MB.');
  if(busy)throw Error('Wait for the current board operation.');startBusy();let decoded;try {
    decoded=await createImageBitmap(blob);
    if(decoded.width>16000||decoded.height>16000||decoded.width*decoded.height>40000000)throw Error('Picture dimensions exceed capacity.');
    let ratio=Math.min(1,1200/Math.max(decoded.width,decoded.height)),data='';
    for(let pass=0;pass<8;pass++){
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(decoded.width*ratio));canvas.height=Math.max(1,Math.round(decoded.height*ratio));canvas.getContext('2d').drawImage(decoded,0,0,canvas.width,canvas.height);data=canvas.toDataURL('image/png').split(',')[1];if(data.length<=240000)break;ratio*=.75;
    }
    if(data.length>240000)throw Error('Picture exceeds capacity after resizing.');
    const result=await api('board/images',{base64:data},undefined,scope);if(scope!==selectedWorkshop)return;
    const width=Math.min(500,result.width),height=Math.max(100,width*result.height/result.width),draft=boardDraft();const id=crypto.randomUUID();draft.objects.push({id,kind:'image',x:point.x,y:point.y,width:Math.max(240,width),height:Math.min(4000,height),groupId:null,src:result.src,label:'Pasted BYOF Canvas picture'});draft.dirty=true;view.imagePoint=null;view.tool=null;view.focus=id;view.levels.set(id,++view.level);render();toast('Picture added. Save layout to share its position.');
  } finally{decoded?.close();endBusy();if(scope===selectedWorkshop&&$('[data-board="save"]'))$('[data-board="save"]').disabled=!boardDraft().dirty;}
}
document.addEventListener('paste',event=>{
  if(screen!=='page'||!me?.host||!boardView().imagePoint||event.target.closest?.('input,textarea,[contenteditable]')||document.activeElement?.tagName==='IFRAME')return;
  const item=[...(event.clipboardData?.items||[])].find(item=>item.kind==='file'&&item.type.startsWith('image/'));if(!item)return;
  const blob=item.getAsFile();if(blob){event.preventDefault();void insertClipboardImage(blob).catch(e=>toast(e.message));}
});
document.addEventListener('input',event=>{
  const editor=event.target.closest('[data-text-object][contenteditable]');if(editor){const o=boardDraft().objects.find(o=>o.id===editor.dataset.textObject);if(o){o.text=editor.innerText.slice(0,4000);o.height=Math.max(100,Math.min(4000,editor.scrollHeight));dirtyBoard();}}
  if(event.target.id==='board-font-size'){const o=boardDraft().objects.find(o=>o.id===boardView().focus&&o.kind==='text'),size=Number(event.target.value);if(o&&Number.isInteger(size)&&size>=12&&size<=144){o.fontSize=size;dirtyBoard();syncBoardDOM();}}
});
document.addEventListener('focusout',event=>{if(event.target.matches('[data-text-object][contenteditable]'))finishTextEdit();});
document.addEventListener('click',event=>{const text=event.target.closest('[data-text-object]');if(text&&!boardView().pan)beginTextEdit(text.dataset.textObject);});
document.addEventListener('change',event=>{if(event.target.id==='board-picture-file'&&event.target.files?.[0]){const view=boardView();if(!view.imagePoint)view.imagePoint={x:(80-view.x)/view.scale,y:(80-view.y)/view.scale};void insertClipboardImage(event.target.files[0]).catch(e=>toast(e.message));}});

function syncBoardDOM() {
  const draft=boardDraft(),view=boardView();
  for(const node of document.querySelectorAll('.board-plane [data-object]')) {
    const o=draft.objects.find(o=>o.id===node.dataset.object);if(!o)continue;objectGeometry(node,o);
    node.style.zIndex=String(o.kind==='group'&&view.focus!==o.id?0:view.levels.get(o.id)||1);
    if(o.kind==='text'){const style=node.querySelector('.board-text-content').style;style.fontSize=(o.fontSize||24)+'px';style.fontWeight=o.bold?'700':'400';style.fontStyle=o.italic?'italic':'normal';style.textDecoration=o.underline?'underline':'none';style.textShadow=o.shadow?'2px 3px 4px #0006':'none';}
    if(o.kind==='arrow'){node.querySelector('svg').outerHTML=arrowMarkup(o);for(const handle of node.querySelectorAll('[data-endpoint]')){const end=handle.dataset.endpoint==='end',curve=handle.dataset.endpoint==='curve',b=arrowBounds(o);handle.style.left=((curve?o.curveX??o.endX/2:end?o.endX:0)-b.left)+'px';handle.style.top=((curve?o.curveY??o.endY/2:end?o.endY:0)-b.top)+'px';}}
    node.classList.toggle('focused-window',view.focus===o.id);
    node.classList.toggle('board-selected',view.selection?.has(o.id)||false);
  }
  sizeBoardViewport();if(view.needsInitialFit){view.needsInitialFit=false;fitBoard();}applyViewport();syncBoardTools();armVisibleNapplets();
}
function sizeBoardViewport(){const viewport=$('.board-viewport');if(viewport)viewport.style.height=Math.max(240,innerHeight-viewport.getBoundingClientRect().top)+'px';}
window.addEventListener('resize',()=>{if(screen==='page')sizeBoardViewport();});
function applyViewport() {
  const view=boardView(),plane=$('.board-plane');if(!plane)return;
  plane.style.transform=`translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  $('.board-viewport').classList.toggle('pan-mode',view.pan);
  $('#board-zoom').textContent=Math.round(view.scale*100)+'%';
  $('[data-board="pan"]').setAttribute('aria-pressed',String(view.pan));
  syncBoardTools();
  try{sessionStorage.setItem('freedom-board-view:'+selectedWorkshop,JSON.stringify({x:view.x,y:view.y,scale:view.scale}));}catch{}
  if(screen==='page')armVisibleNapplets();
}
function raiseWindow(node) {
  if(!node||!state?.board)return;const view=boardView(),o=boardDraft().objects.find(o=>o.id===node.dataset.object);if(!o)return;
  view.focus=o.id;view.imagePoint=null;view.levels.set(o.id,++view.level);
  for(const n of document.querySelectorAll('.board-plane [data-object]'))n.classList.toggle('focused-window',n===node);
  node.style.zIndex=String(view.level);syncBoardTools();
}
document.addEventListener('focusin',event=>{const node=event.target.closest?.('.board-plane [data-object]');if(node)raiseWindow(node);});
function dirtyBoard() {
  boardDraft().dirty=true;
  const save=$('[data-board="save"]');if(save)save.disabled=false;
  if($('#board-save-status')){$('#board-save-status').textContent='Unsaved layout';$('#board-save-status').className='pending';}
}
function zoomBoard(factor,anchor) {
  const view=boardView(),rect=$('.board-viewport').getBoundingClientRect(),point=anchor||{x:rect.width/2,y:rect.height/2};
  const scale=Math.max(.15,Math.min(2,view.scale*factor));
  view.x=point.x-(point.x-view.x)*scale/view.scale;view.y=point.y-(point.y-view.y)*scale/view.scale;view.scale=scale;applyViewport();
}
function fitBoard() {
  const objects=boardDraft().objects;if(!objects.length)return;
  const rect=$('.board-viewport').getBoundingClientRect(),left=Math.min(...objects.map(o=>o.x+(o.kind==='arrow'?arrowBounds(o).left:0))),top=Math.min(...objects.map(o=>o.y+(o.kind==='arrow'?arrowBounds(o).top:0))),right=Math.max(...objects.map(o=>o.x+(o.kind==='arrow'?arrowBounds(o).right:o.width))),bottom=Math.max(...objects.map(o=>o.y+(o.kind==='arrow'?arrowBounds(o).bottom:o.height)));
  const view=boardView();view.scale=Math.min(1,Math.max(1,rect.width-32)/Math.max(1,right-left),Math.max(1,rect.height-32)/Math.max(1,bottom-top));view.x=(rect.width-(right-left)*view.scale)/2-left*view.scale;view.y=(rect.height-(bottom-top)*view.scale)/2-top*view.scale;applyViewport();
}
document.addEventListener('submit',event=>{if(event.target.id!=='board-url-picture')return;event.preventDefault();if(!me.host||busy)return;const view=boardView();boardDraft().objects.push({id:crypto.randomUUID(),kind:'image',x:(80-view.x)/view.scale,y:(120-view.y)/view.scale,width:360,height:240,groupId:null,src:$('#board-picture-url').value,label:$('#board-picture-description').value});dirtyBoard();render();});
function arrowMarkup(o){const b=arrowBounds(o),sx=-b.left,sy=-b.top,ex=sx+o.endX,ey=sy+o.endY,cx=o.curveX??o.endX/2,cy=o.curveY??o.endY/2,angle=Math.hypot(o.endX-cx,o.endY-cy)>0?Math.atan2(o.endY-cy,o.endX-cx):Math.atan2(o.endY,o.endX),size=14,path=o.curveX===undefined?`M ${sx} ${sy} L ${ex} ${ey}`:`M ${sx} ${sy} Q ${sx+cx} ${sy+cy} ${ex} ${ey}`,colour=o.colour||'#24282c';return `<svg aria-hidden="true" width="100%" height="100%" style="overflow:visible"><path class="arrow-stroke arrow-line" stroke="${esc(colour)}" ${o.dotted?'stroke-dasharray="1 9"':''} d="${path}"/><path class="arrow-stroke arrow-head" stroke="${esc(colour)}" d="M ${ex-size*Math.cos(angle-.5)} ${ey-size*Math.sin(angle-.5)} L ${ex} ${ey} L ${ex-size*Math.cos(angle+.5)} ${ey-size*Math.sin(angle+.5)}"/></svg>`;}
function syncObjectOptions(){const panel=$('#board-object-options');if(!panel)return;const o=boardDraft().objects.find(o=>o.id===boardView().options);panel.hidden=!me.host||!o;if(!o)return;panel.innerHTML=`<label for="board-object-picker">Object</label><select id="board-object-picker">${boardDraft().objects.map(item=>`<option value="${esc(item.id)}" ${item.id===o.id?'selected':''}>${esc(item.kind==='napplet'?state.board.napplets.find(p=>p.id===item.id)?.title:item.kind==='text'?item.text.slice(0,60):item.kind==='arrow'?'Arrow':item.label||'Donation')}</option>`).join('')}</select><strong>${esc(o.kind==='napplet'?state.board.napplets.find(p=>p.id===o.id)?.title:o.kind==='text'?'Text':o.kind==='arrow'?'Arrow':o.label)}</strong>${o.kind==='group'?`<label>Group name<input data-object-field="label" maxlength="80" value="${esc(o.label)}"></label>`:o.kind==='image'?`<label>Picture source<input data-object-field="src" maxlength="2048" value="${esc(o.src)}"></label><label>Picture description<input data-object-field="label" maxlength="200" value="${esc(o.label)}"></label>`:''}${o.kind!=='group'?`<label for="object-group">Group</label><select id="object-group" data-object-field="groupId"><option value="">No group</option>${boardDraft().objects.filter(g=>g.kind==='group').map(g=>`<option value="${esc(g.id)}" ${o.groupId===g.id?'selected':''}>${esc(g.label)}</option>`).join('')}</select>`:''}${!['napplet','donation'].includes(o.kind)?`<button data-board="remove" data-id="${esc(o.id)}">Remove object</button>`:''}<button data-board="close-options">Close options</button>`;}
function editBoardObject(kind,id){if(!me.host)return;finishTextEdit();if($('#dialog').open)$('#dialog').close();if(!id){const view=boardView();id=crypto.randomUUID();boardDraft().objects.push({id,kind,x:(Math.min(600,$('.board-viewport').clientWidth/2)-view.x)/view.scale,y:(120-view.y)/view.scale,width:960,height:560,groupId:null,label:'New group'});dirtyBoard();render();}boardView().options=id;boardView().focus=id;boardView().levels.set(id,++boardView().level);syncBoardDOM();if(kind==='text')beginTextEdit(id);}
document.addEventListener('change',event=>{if(['arrow-colour','arrow-dotted'].includes(event.target.id)){if(!me.host||busy)return;const o=boardDraft().objects.find(o=>o.id===boardView().focus&&o.kind==='arrow');if(o){if(event.target.id==='arrow-colour')o.colour=event.target.value;else o.dotted=event.target.checked;dirtyBoard();syncBoardDOM();}return;}if(event.target.id==='board-object-picker'){const view=boardView();view.options=event.target.value;view.focus=view.options;view.levels.set(view.focus,++view.level);syncBoardDOM();return;}if(!event.target.matches('[data-object-field]'))return;const o=boardDraft().objects.find(o=>o.id===boardView().options);if(!o)return;const field=event.target.dataset.objectField;o[field]=field==='groupId'?event.target.value||null:event.target.value.trim()||o.label;dirtyBoard();render();});
document.addEventListener('pointerdown',event=>{if(event.target.closest('[data-text-effect]'))event.preventDefault();});
document.addEventListener('click',event=>{const b=event.target.closest('[data-text-effect]');if(!b||!me.host||busy)return;const o=boardDraft().objects.find(o=>o.id===boardView().focus&&o.kind==='text');if(o){o[b.dataset.textEffect]=!o[b.dataset.textEffect];dirtyBoard();syncBoardDOM();}});
document.addEventListener('click',async event=>{
  const b=event.target.closest('[data-board]');if(!b||busy)return;
  const action=b.dataset.board;
  if(!['text','image','arrow','more'].includes(action)){boardView().tool=null;boardView().more=false;syncBoardTools();}
  if(action==='in'||action==='out')zoomBoard(action==='in'?1.2:1/1.2);
  if(action==='reset')zoomBoard(1/boardView().scale);
  if(action==='fit')fitBoard();
  if(action==='pan'){boardView().pan=!boardView().pan;applyViewport();}
  if(!me.host)return;
  if(action==='objects'){boardView().options=boardView().focus||boardDraft().objects[0]?.id;syncBoardTools();}
  if(action==='more'){boardView().more=!boardView().more;syncBoardTools();}
  if(action==='text'||action==='image'||action==='arrow'){finishTextEdit();const view=boardView();view.pan=false;view.more=false;view.imagePoint=null;view.tool=view.tool===action?null:action;applyViewport();toast(action==='text'?'Click the board and type.':action==='arrow'?'Drag on the board to draw an arrow.':'Click the board, then paste a picture.');}
  if(action==='straight-arrow'){const o=boardDraft().objects.find(o=>o.id===boardView().focus&&o.kind==='arrow');if(o){delete o.curveX;delete o.curveY;dirtyBoard();syncBoardDOM();}}
  if(action==='close-options'){boardView().options=null;syncBoardTools();}
  if(action==='group')editBoardObject('group');
  if(action==='image-url'){$('#board-url-picture').hidden=false;$('#board-picture-url').focus();}
  if(action==='close-url')$('#board-url-picture').hidden=true;
  if(action==='paste-image'){try{const items=await navigator.clipboard.read();const item=items.find(item=>item.types.some(t=>t.startsWith('image/')));if(!item)throw Error('Copy a picture first.');const type=item.types.find(t=>['image/png','image/jpeg','image/webp'].includes(t));if(!type)throw Error('Clipboard picture format unavailable.');await insertClipboardImage(await item.getType(type));}catch(e){toast(e.message);}}
  if(action==='remove') {const draft=boardDraft();draft.objects=draft.objects.filter(o=>o.id!==b.dataset.id);for(const o of draft.objects)if(o.groupId===b.dataset.id)o.groupId=null;dirtyBoard();$('#dialog').close();render();}
  if(action==='reload'){try{const room=await api('room');state=room;boardDrafts.delete(selectedWorkshop);render();}catch(e){toast(e.message);}}
  if(action==='save') {
    finishTextEdit();
    const draft=boardDraft(),scope=selectedWorkshop;startBusy();
    try {const result=await api('board',{expectedVersion:draft.version,objects:draft.objects},undefined,scope);draft.version=result.board.version;draft.dirty=false;state.board=result.board;render();toast('BYOF Canvas layout saved');}
    catch(e){toast(e.message);if($('#board-save-status'))$('#board-save-status').textContent=e.message;}
    finally{endBusy();if(scope===selectedWorkshop&&$('[data-board="save"]'))$('[data-board="save"]').disabled=!draft.dirty;}
  }
});
let boardGesture=null;const boardPointers=new Map();
document.addEventListener('pointerdown',event=>{
  const viewport=event.target.closest('.board-viewport');if(!viewport||event.button>0||activeViewer||busy)return;
  const placing=boardView().tool;if(placing&&me.host){event.preventDefault();const view=boardView(),r=viewport.getBoundingClientRect(),point={x:(event.clientX-r.left-view.x)/view.scale,y:(event.clientY-r.top-view.y)/view.scale};view.tool=null;if(placing==='arrow'){view.drawing=true;const o={id:crypto.randomUUID(),kind:'arrow',x:point.x,y:point.y,width:1,height:1,endX:0,endY:0,groupId:null};boardDraft().objects.push(o);view.focus=o.id;view.levels.set(o.id,++view.level);const template=document.createElement('template');template.innerHTML=arrowObjectMarkup(o);$('.board-plane').append(template.content);syncBoardDOM();$('.board-viewport').setPointerCapture(event.pointerId);boardPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});boardGesture={mode:'arrow-end',pointer:event.pointerId,start:{x:event.clientX,y:event.clientY},object:structuredClone(o),children:[]};return;}if(placing==='text')insertText(point);else{view.imagePoint=point;viewport.focus();applyViewport();}return;}
  const node=event.target.closest('[data-object]');if(node){const v=boardView();if(!v.selection?.has(node.dataset.object))v.selection=new Set();raiseWindow(node);syncBoardDOM();}
  const view=boardView(),resize=event.target.closest('[data-resize]'),bar=event.target.closest('.window-bar,.object-bar');
  const arrange=me.host&&!view.pan&&node&&(resize||event.target.closest('[data-endpoint]')||event.target.closest('[data-move]')||(bar&&!event.target.closest('button')));
  const background=event.target===viewport||event.target.classList.contains('board-plane')||event.target.classList.contains('pan-shield')||event.target.classList.contains('board-group');
  if(!arrange&&!background)return;
  event.preventDefault();viewport.setPointerCapture(event.pointerId);
  boardPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(boardPointers.size===2&&boardGesture?.mode==='pan') {
    const [a,b]=[...boardPointers.values()];boardGesture={mode:'pinch',distance:Math.hypot(a.x-b.x,a.y-b.y),scale:view.scale,center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},x:view.x,y:view.y};
  } else if(boardPointers.size===1) {
    const o=arrange?boardDraft().objects.find(o=>o.id===node.dataset.object):null;
    const selecting=!arrange&&me.host&&!view.pan&&event.pointerType!=='touch';
    if(selecting){view.selection=new Set();view.focus=null;syncBoardDOM();}
    boardGesture={mode:arrange?(event.target.closest('[data-endpoint]')?'arrow-'+event.target.closest('[data-endpoint]').dataset.endpoint:resize?'resize':'move'):selecting?'select':'pan',pointer:event.pointerId,start:{x:event.clientX,y:event.clientY},x:view.x,y:view.y,object:o?structuredClone(o):null,children:o?.kind==='group'?boardDraft().objects.filter(c=>c.groupId===o.id).map(c=>structuredClone(c)):[]};
    if(arrange){boardGesture.moving=movementObjects(boardDraft().objects,view.selection?.has(o.id)?view.selection:new Set([o.id]));viewport.classList.add('arranging');}
  }
});
document.addEventListener('pointermove',event=>{
  if(!boardGesture||!boardPointers.has(event.pointerId))return;event.preventDefault();boardPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  const g=boardGesture,view=boardView(),viewport=$('.board-viewport');if(!viewport)return;
  if(g.mode==='pinch') {
    if(boardPointers.size<2)return;const [a,b]=[...boardPointers.values()],rect=viewport.getBoundingClientRect(),center={x:(a.x+b.x)/2-rect.left,y:(a.y+b.y)/2-rect.top},scale=Math.max(.15,Math.min(2,g.scale*Math.hypot(a.x-b.x,a.y-b.y)/g.distance));
    view.x=center.x-(g.center.x-rect.left-g.x)*scale/g.scale;view.y=center.y-(g.center.y-rect.top-g.y)*scale/g.scale;view.scale=scale;applyViewport();return;
  }
  const dx=event.clientX-g.start.x,dy=event.clientY-g.start.y;
  if(g.mode==='pan'){view.x=g.x+dx;view.y=g.y+dy;applyViewport();return;}
  if(g.mode==='select'){const rect=viewport.getBoundingClientRect(),box=selectionRect(g.start,{x:event.clientX,y:event.clientY}),overlay=$('.board-selection-box');overlay.hidden=false;overlay.style.left=(box.left-rect.left)+'px';overlay.style.top=(box.top-rect.top)+'px';overlay.style.width=(box.right-box.left)+'px';overlay.style.height=(box.bottom-box.top)+'px';view.selection=new Set(enclosedIds([...document.querySelectorAll('.board-plane [data-object]')].map(node=>({id:node.dataset.object,...Object.fromEntries(['left','top','right','bottom'].map(key=>[key,node.getBoundingClientRect()[key]]))})),box));syncBoardDOM();return;}
  const o=boardDraft().objects.find(o=>o.id===g.object.id);if(!o)return;
  if(g.mode==='arrow-start'||g.mode==='arrow-end'||g.mode==='arrow-curve'){const clamp=n=>Math.max(-4000,Math.min(4000,n));if(g.mode==='arrow-curve'){o.curveX=clamp((g.object.curveX??g.object.endX/2)+dx/view.scale);o.curveY=clamp((g.object.curveY??g.object.endY/2)+dy/view.scale);}else if(g.mode==='arrow-end'){o.endX=clamp(g.object.endX+dx/view.scale);o.endY=clamp(g.object.endY+dy/view.scale);}else{o.endX=clamp(g.object.endX-dx/view.scale);o.endY=clamp(g.object.endY-dy/view.scale);o.x=g.object.x+g.object.endX-o.endX;o.y=g.object.y+g.object.endY-o.endY;if(g.object.curveX!==undefined){o.curveX=clamp(g.object.x+g.object.curveX-o.x);o.curveY=clamp(g.object.y+g.object.curveY-o.y);}}o.width=Math.max(1,Math.abs(o.endX));o.height=Math.max(1,Math.abs(o.endY));}
  else if(g.mode==='move'){const delta=groupDelta(g.moving,dx/view.scale,dy/view.scale);for(const original of g.moving){const item=boardDraft().objects.find(c=>c.id===original.id);if(item){item.x=original.x+delta.x;item.y=original.y+delta.y;}}}
  else {o.width=Math.max(240,Math.min(4000,g.object.width+dx/view.scale));o.height=Math.max(o.kind==='napplet'?200:100,Math.min(4000,g.object.height+dy/view.scale));}
  dirtyBoard();syncBoardDOM();
});
function endBoardGesture(event){if(!boardPointers.has(event.pointerId))return;boardPointers.delete(event.pointerId);if(boardGesture?.mode==='pinch'&&boardPointers.size===1){const [pointer,p]=[...boardPointers.entries()][0];const view=boardView();boardGesture={mode:'pan',pointer,start:p,x:view.x,y:view.y};}else if(!boardPointers.size){if(boardGesture?.mode?.startsWith('arrow-')){const o=boardDraft().objects.find(o=>o.id===boardGesture.object.id);if(o&&Math.hypot(o.endX,o.endY)<8){boardDraft().objects=boardDraft().objects.filter(c=>c.id!==o.id);$(`[data-object="${o.id}"]`)?.remove();}}boardGesture=null;const overlay=$('.board-selection-box');if(overlay)overlay.hidden=true;boardView().drawing=false;syncBoardTools();$('.board-viewport')?.classList.remove('arranging');}}
document.addEventListener('pointerup',endBoardGesture);document.addEventListener('pointercancel',endBoardGesture);
document.addEventListener('wheel',event=>{
  const viewport=event.target.closest('.board-viewport');if(!viewport||activeViewer||(!boardView().pan&&event.target!==viewport&&!event.target.classList.contains('board-plane')))return;
  event.preventDefault();const view=boardView();if(event.ctrlKey||event.metaKey){const rect=viewport.getBoundingClientRect();zoomBoard(Math.exp(-event.deltaY*.005),{x:event.clientX-rect.left,y:event.clientY-rect.top});}else{view.x-=event.deltaX;view.y-=event.deltaY;applyViewport();}
},{passive:false});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&event.target.closest('.board-viewport')&&!event.target.isContentEditable){boardView().selection=new Set();syncBoardDOM();}
  if(!event.target.matches('.board-viewport'))return;
  const view=boardView(),steps={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]};
  if(steps[event.key]){event.preventDefault();view.x+=steps[event.key][0];view.y+=steps[event.key][1];applyViewport();}
  if(event.key==='+'||event.key==='='){event.preventDefault();zoomBoard(1.2);}if(event.key==='-'){event.preventDefault();zoomBoard(1/1.2);}
});
// Poll the authoritative room as well as using events: a saved build or new app
// appears even after a socket reconnect, with unchanged frames retained in place.
let roomPoll=false;
setInterval(async()=>{
  if(screen!=='page'||!me||roomPoll||busy||boardGesture||boardViews.get(selectedWorkshop)?.editing)return;roomPoll=true;
  const scope=selectedWorkshop;
  try{const updated=await api('room');if(scope!==selectedWorkshop||screen!=='page')return;if(JSON.stringify(updated)!==JSON.stringify(state)){state=updated;setMember(updated.member);render();}}catch{}finally{roomPoll=false;}
},3000);

const activeStatuses = ['queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain'];
const draftKey = id => 'byo-freedom-draft:' + me.pubkey + ':' + id;
function draft() { try { return JSON.parse(sessionStorage.getItem(draftKey(detail.project.id))) || {}; } catch { return {}; } }
const chatImageUploads=new Map();
function currentImageUploads(){return detail?chatImageUploads.get(detail.project.id)||[]:[];}
function storeDraftPrompt(projectId,prompt){let saved={};try{saved=JSON.parse(sessionStorage.getItem(draftKey(projectId)))||{};}catch{}sessionStorage.setItem(draftKey(projectId),JSON.stringify({...saved,prompt}));}
function uploadStatusMarkup(){
  const uploads=currentImageUploads(),pending=uploads.filter(item=>item.status==='uploading'),failed=uploads.filter(item=>item.status==='error'||item.status==='detached');
  return `${pending.length?`<span>${pending.length===1?'Uploading pasted image…':`Uploading ${pending.length} pasted images…`}</span>`:''}${failed.map(item=>`<span class="chat-upload-error">${esc(item.error||'Image upload failed.')} <button type="button" data-chat-upload-remove="${esc(item.id)}">Remove</button></span>`).join('')}`;
}
function syncImageUploadUi(){
  const status=$('#chat-upload-status');if(status)status.innerHTML=uploadStatusMarkup();
  const send=$('#instruction-form button[type="submit"]');if(send){const active=detail.requests.some(r=>activeStatuses.includes(r.status)),uncertain=detail.requests.some(r=>r.status==='execution_uncertain');send.disabled=active||uncertain||detail.builder?.state==='deleting'||imageUploadsBlockSend(currentImageUploads());}
}
function replaceDraftMarker(projectId,token,replacement){
  const input=detail?.project.id===projectId?$('#prompt'):null,current=input?input.value:(()=>{try{return (JSON.parse(sessionStorage.getItem(draftKey(projectId)))||{}).prompt||'';}catch{return '';}})();
  const result=replaceImageMarker(current,token,replacement);if(!result.replaced)return false;
  if(input){input.value=result.value;input.setSelectionRange(result.caret,result.caret);}storeDraftPrompt(projectId,result.value);return true;
}
function fileBase64(file){return file.arrayBuffer().then(buffer=>{let value='',bytes=new Uint8Array(buffer);for(let offset=0;offset<bytes.length;offset+=0x8000)value+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(value);});}
async function uploadPastedImage(record){
  record.status='uploading';record.error='';syncImageUploadUi();
  try{
    const body={attachmentId:record.id,filename:record.filename,contentType:record.file.type,sizeBytes:record.file.size,base64:await fileBase64(record.file)};
    await api(`projects/${record.projectId}/attachments`,body);
    let result;for(let attempt=0;attempt<75;attempt++){result=await api(`projects/${record.projectId}/attachments/${record.id}`);if(result.status!=='uploading')break;await new Promise(resolve=>setTimeout(resolve,800));}
    if(result?.status!=='ready')throw Error(result?.error||'Image upload is still pending. Retry or remove it.');
    record.attachment={attachment_id:result.attachment_id,kind:'image',filename:result.filename,content_type:result.content_type,size_bytes:result.size_bytes,storage_object_id:result.storage_object_id};
    const inserted=replaceDraftMarker(record.projectId,record.token,imageMarkdown(result.filename,result.storage_object_id));
    record.status=inserted?'ready':'detached';record.error=inserted?'':'The upload finished, but its marker was removed. Remove this item or paste it again.';
  }catch(error){record.failureMarker=`[ Image upload failed: ${record.filename} ]`;replaceDraftMarker(record.projectId,record.token,record.failureMarker);record.status='error';record.error=error.message||'Image upload failed. Retry by pasting it again.';}
  syncImageUploadUi();
}
function inspectionLinks(links) {
  if (!links) return '';
  const link = (url,label) => url ? `<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
  return `<details><summary>Inspect in Autopilot</summary><p class="notice">${esc(links.operatorNotice)}</p><div class="actions">${link(links.definition,'Pipeline definition')}</div>${links.runs.map(row => `<div class="actions">${link(row.run,'Run '+esc(row.requestId.slice(0,8)))}${link(row.session,'Builder session')}</div>`).join('')}</details>`;
}
function eventTimeMarkup(value,label) {
  const formatted=perthEventTime(value,label);
  return formatted?`<time class="activity-time" datetime="${esc(formatted.datetime)}" aria-label="${esc(formatted.ariaLabel)}">${esc(formatted.text)}</time>`:'';
}
function activityMarkup(request,name) {
  return collapseActivity(request.activity).map(event=>{
    if(event.type==='tools')return `<div class="message activity tools" role="status">Using tools${eventTimeMarkup(event.instant,'Last tool')}</div>`;
    if(event.type==='commentary')return `<div class="message activity"><b>${esc(name)}</b>${esc(event.content)}${eventTimeMarkup(event.instant,'Received')}</div>`;
    return `<p class="muted activity" role="status">${event.type==='failed' ? 'Agent turn ended with a failure; waiting for the confirmed result.' : 'Agent turn finished; checking the final result.'}${eventTimeMarkup(event.instant,'Updated')}</p>`;
  }).join('');
}
function requestUpdateTime(request) {
  if(request.response&&Number.isSafeInteger(request.response_received_at))return eventTimeMarkup(new Date(request.response_received_at*1000).toISOString(),'Received');
  return eventTimeMarkup(newestInstant((request.activity||[]).map(activityInstant)),'Last activity');
}
function workingIndicator(request) {
  const dots=['dispatching','building'].includes(request.status)
    ? '<span class="working-dots" aria-hidden="true"><span></span><span></span><span></span></span>'
    : '';
  return dots+requestUpdateTime(request);
}
function conversationMarkupBase() {
  const own = detail.project.owner === me.pubkey, saved = draft(), uncertain = detail.requests.some(r => r.status==='execution_uncertain'), active = detail.requests.some(r => activeStatuses.includes(r.status));
  const name = detail.agentName || 'Agent 21';
  const statusLabel = r => r.status === 'failed' && r.recoverable ? (r.automaticRetryExhausted ? 'Saved · retry available' : 'Saved · reconnecting builder') : r.status === 'succeeded' ? (r.response ? name : name + ' · Updated app ready') : name + ' · ' + ({ unavailable:'Saved · awaiting activation', queued:'Saved · not started', dispatching:'Connecting', dispatch_pending:'Waiting to reconnect', building:'Working', storage_pending:'Build saved · storage retry needed', failed:'Could not complete', execution_uncertain:'Execution outcome uncertain', classifier_error:'Screening unavailable' }[r.status] || r.status);
  const builder = detail.builder;
  let lifecycle = builder ? `<p class="muted"> ${esc(name)} session ${builder.generation} · ${esc(builder.state)}. Saved messages and app versions are preserved.</p>` : '';
  if (builder?.state === 'retired') lifecycle += `<p class="notice">The next authorized request starts a replacement ${esc(name)} session with your saved context.</p>`;
  if (builder?.state === 'deleting') lifecycle += `<p class="notice">Native deletion is pending or uncertain; requests to ${esc(name)} are fenced. ${esc(detail.builderDeletion?.error || '')}</p>`;
  if (detail.builderDeletion?.status === 'completed') { let receipt; try { receipt = JSON.parse(detail.builderDeletion.receipt_json).envelope.result.deletionReceipt; } catch {} lifecycle += `<p class="notice">Native runtime records were deleted. ${receipt?.nativeTranscriptDeleted ? 'The native transcript was deleted.' : 'No native transcript deletion was recorded.'} Provider metadata indexes and app message history remain.</p>`; }
  if (own && builder && ['active','retired'].includes(builder.state)) {
    if (builder.state === 'active') lifecycle += `<button data-a="retire-builder" ${active ? 'disabled' : ''}>Retire ${esc(name)} session</button>`;
    lifecycle += `<p class="notice">Retirement removes this app’s ${esc(name)} association. ${detail.nativeDeletionAvailable ? 'Native transcript and runtime deletion is available separately; provider metadata indexes remain.' : 'Native runtime/history deletion is not currently available.'}</p>`;
    if (detail.nativeDeletionAvailable && !active && detail.builderDeletion?.status !== 'completed') lifecycle += button('confirm-native-delete','Delete native transcript and runtime');
  }
  return `<div class="conversation-header"><h2>Talk with ${esc(name)}</h2><button type="button" data-mobile-option data-completion-sound aria-pressed="${completionSound}">Completion sound: ${completionSound?'on':'off'}</button></div><div class="conversation-history" tabindex="0" aria-label="Conversation history"><div data-mobile-option>${lifecycle}</div><p class="muted">Questions and suggestions get an answer. Requested changes create a saved version.</p><div class="status" role="status">${detail.builder?.state==='deleting' ? `Native deletion is pending; requests to ${esc(name)} are fenced` : uncertain ? 'Checking the previous build. Your last saved app is available.' : active ? esc(({queued:'Your request is saved and has not started. Retry or cancel it below.',dispatching:'Connecting to your builder.',dispatch_pending:'Dispatch outcome is pending; reconnect the same saved request.',building:name+' is working on this project',storage_pending:'Your build is waiting for storage publication.'})[detail.requests.find(r=>activeStatuses.includes(r.status))?.status] || 'Checking the saved request.') : detail.storageReady===false ? 'Questions are available. Complete Canvas setup before requesting app changes.' : detail.generationAvailable ? 'Ready for your next question or change' : esc(detail.generationReason || 'Instructions are saved; execution awaits activation for this project')}</div>${detail.requests.map(r => `<div class="message user"><b>You</b>${esc(r.prompt)}</div>${activityMarkup(r,name)}<div class="message" data-request="${esc(r.id)}"><b>${esc(statusLabel(r))}${workingIndicator(r)}</b>${esc(r.response || (r.neverSent ? (r.error || 'Saved; no dispatch has started. You can retry or cancel it below without changing your app or allowance.') : r.recoverable ? (r.automaticRetryExhausted ? 'The builder is temporarily unavailable. Your saved app is safe. Continue this saved request to try again.' : 'Reconnecting your builder. Your request and saved app are safe.') : r.error) || ({queued:'Saved; not started',dispatching:'Connecting',dispatch_pending:'Waiting for dispatch confirmation',building:'Working on it',storage_pending:'Waiting for publication',execution_uncertain:'Reconciling the previous execution'}[r.status] || ''))}${r.response && r.error ? `<p class="notice">${esc(r.error)}</p>` : ''}${r.publicationStatus==='published'&&r.status==='building'?`<p class="notice">App v${esc(r.publishedVersion)} is published and playable. The final reply is still in progress.</p>`:''}${r.publicationStatus==='pending'&&r.publicationError?`<p class="notice">${esc(r.publicationError)}</p>`:''}${r.status==='succeeded' ? `<p class="muted">Completed${r.agentPublication ? (r.publicationStatus==='published' ? ' · Published app v'+esc(r.publishedVersion) : ' · Your app is unchanged') : r.mode==='answer' ? ' · Your app is unchanged' : ''}</p>` : ''}${r.status==='storage_pending' && (own||me.host) ? button('storage-retry','Retry saved storage',r.id) : ''}${detail.generationAvailable && (r.neverSent || ['unavailable','dispatch_pending'].includes(r.status) || (['failed','execution_uncertain'].includes(r.status) && r.recoverable)) && (own || me.host) ? button('resume-request',r.neverSent?'Retry saved request':'Continue saved request',r.id) : ''}${r.neverSent && (own||me.host) ? button('cancel-request','Cancel saved request',r.id) : ''}</div>`).join('')}</div><div class="conversation-composer">${me.admin&&detail.storageReady===false?button('complete-canvas-setup','Complete Canvas setup',selectedWorkshop):''}${own ? `<form id="instruction-form"><label for="prompt">${detail.storageReady===false?'Your question':'Your next question or change'}</label><textarea id="prompt" maxlength="8000" required placeholder="${detail.storageReady===false?'Ask a question while Canvas setup is completed':'Ask for suggestions, or describe a change'}">${esc(saved.prompt || '')}</textarea><div id="chat-upload-status" class="chat-upload-status" role="status" aria-live="polite">${uploadStatusMarkup()}</div><div class="actions"><button class="primary" type="submit" ${active || uncertain || detail.builder?.state==='deleting' || imageUploadsBlockSend(currentImageUploads()) ? 'disabled' : ''}>${detail.generationAvailable ? 'Send' : 'Save request'}</button></div><p class="notice">${detail.generationAvailable ? 'Private to this project. Answers keep your current app. Successful updates use one build allowance.' : 'Your request will be saved privately. Execution is not yet activated for this project; no allowance is charged.'}</p></form>` : `<p class="notice">Host actions are attributed to your account and use the project owner's allowance.</p>${detail.generationAvailable ? `<form id="host-request-form"><label for="host-prompt">Host follow-up instruction</label><textarea id="host-prompt" maxlength="8000" required></textarea><label for="host-reason">Reason for acting on this project</label><input id="host-reason" maxlength="1000" required><button class="primary" type="submit" ${active || uncertain || detail.builder?.state==='deleting' ? 'disabled' : ''}>Send host follow-up</button></form>` : ''}`}</div>`;
}
function conversationMarkup(){
  const selected=detail.selectedBuilderEngine,label=selected?.agent==='goose'?'Goose · GLM 5.3':selected?.agent==='claude'?'Claude · configured default':'Codex · configured default';
  let markup=conversationMarkupBase().replace('<div class="conversation-history"',`<p class="notice">Canvas builder: <b>${esc(label)}</b> · selection r${esc(selected?.revision||1)}</p><div class="conversation-history"`);
  for(const request of detail.requests){
    if(!request.builderEngine)continue;
    const saved=request.builderEngine.runtime.agent==='goose'?'Goose · GLM 5.3':request.builderEngine.runtime.agent==='claude'?'Claude · configured default':'Codex · configured default';
    const correction=me.admin&&request.neverSent&&request.builderEngine.runtime.agent!==selected?.agent&&!request.builderEngineCorrected?button('correct-request-engine','Use current Canvas builder',request.id):'';
    const marker=`<div class="message" data-request="${esc(request.id)}">`;
    markup=markup.replace(marker,marker+`<p class="muted">Saved builder: ${esc(saved)} · selection r${esc(request.builderEngine.revision)}${request.builderEngineCorrected?' · audited pre-dispatch correction':''}</p>${correction}`);
  }
  return markup;
}
function refreshConversation(pane, followLatest = false, renderProject = false) {
  restoreBuilderOptions();
  const history = pane.querySelector('.conversation-history');
  const top = history?.scrollTop || 0;
  const atEnd = !history || history.scrollHeight - history.clientHeight - top < 64;
  const focused = pane.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id, selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const inputs = [...pane.querySelectorAll('textarea,input')].map(input => [input.id,input.value]);
  if(renderProject){render();pane=$('.conversation-pane');}else pane.innerHTML = conversationMarkup();
  for (const [id,value] of inputs) { const input=document.getElementById(id); if(input && !followLatest)input.value=value; }
  const next = pane.querySelector('.conversation-history');
  if(next)next.scrollTop = followLatest || atEnd ? next.scrollHeight : top;
  if(focusId){const input=document.getElementById(focusId);input?.focus({preventScroll:true});if(selection)input?.setSelectionRange(...selection);}
  syncBuilderLayout();
}
function saveDraft() {
  if (!me || !detail || !$('#prompt')) return;
  const old = draft(), prompt = $('#prompt').value;
  const retry = old.prompt === prompt && old.requestId;
  sessionStorage.setItem(draftKey(detail.project.id),JSON.stringify({prompt,...(retry ? {requestId:old.requestId,expectedRevisionId:old.expectedRevisionId,...(old.mode ? {mode:old.mode}: {})}: {})}));
}
document.addEventListener('input', event => { if (event.target.id === 'prompt') saveDraft(); });
document.addEventListener('paste',event=>{
  if(event.target?.id!=='prompt'||!detail)return;
  const files=clipboardImages(event.clipboardData);if(!files.length)return;
  event.preventDefault();
  const input=event.target,ids=files.map(()=>crypto.randomUUID()),inserted=insertImageMarkers(input.value,input.selectionStart,input.selectionEnd,ids);
  input.value=inserted.value;input.setSelectionRange(inserted.caret,inserted.caret);saveDraft();
  const records=currentImageUploads(),projectId=detail.project.id;
  files.forEach((file,index)=>{const ext=String(file.type).split('/')[1]?.replace('jpeg','jpg')||'png',record={id:ids[index],projectId,file,filename:file.name||`image.${ext}`,token:inserted.tokens[index],status:'uploading',error:''};records.push(record);void uploadPastedImage(record);});
  chatImageUploads.set(projectId,records);syncImageUploadUi();
});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-chat-upload-remove]');if(!button||!detail)return;
  const uploads=currentImageUploads(),record=uploads.find(item=>item.id===button.dataset.chatUploadRemove);if(!record)return;
  replaceDraftMarker(record.projectId,record.failureMarker||record.token,'');chatImageUploads.set(record.projectId,uploads.filter(item=>item!==record));syncImageUploadUi();$('#prompt')?.focus();
});
setInterval(async () => {
  if (screen !== 'builder' || !detail || busy || !detail.requests.some(r => activeStatuses.includes(r.status)) && !['dispatching','dispatch_pending','working'].includes(detail.builderDeletion?.status)) return;
  try {
    const updated = await api('projects/' + detail.project.id);
    const changed = JSON.stringify(updated.requests) !== JSON.stringify(detail.requests) || updated.project.current_revision !== detail.project.current_revision || JSON.stringify(updated.builderDeletion) !== JSON.stringify(detail.builderDeletion) || JSON.stringify(updated.builder) !== JSON.stringify(detail.builder);
    if (!changed) return;
    applyProjectUpdate(updated);
  } catch (error) { toast(error.message); }
}, 2500);
// Tab changes only change visibility: never rebuild or reparent the live app.
const builderMedia = matchMedia('(max-width:900px)');
const builderTabs = new Map();
let mobileOptions = [];
function restoreBuilderOptions() {
  for(const [node,placeholder] of mobileOptions) {
    if(placeholder.isConnected)placeholder.replaceWith(node);
  }
  mobileOptions=[];
  const heading=$('header>.builder-heading');
  if(heading)$('#main').prepend(heading);
  $('#builder-options')?.remove();
}
function syncBuilderTabs() {
  const builder=$('.builder');if(!builder||screen!=='builder')return;
  const mobile=builderMedia.matches, selected=builderTabs.get(detail.project.id)||'preview';
  builder.dataset.tab=selected;
  document.querySelectorAll('[data-builder-tab]').forEach(tab=>{
    const active=tab.dataset.builderTab===selected;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
  });
  for(const name of ['preview','chat']) {
    const panel=$('#builder-'+name);
    panel.inert=mobile&&name!==selected;
    if(mobile){panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','tab-'+name);}
    else {panel.removeAttribute('role');panel.removeAttribute('aria-labelledby');}
  }
}
function syncBuilderLayout() {
  restoreBuilderOptions();
  const heading=$('.builder-heading');
  if(screen!=='builder'||!heading)return;
  syncBuilderTabs();
  if(!builderMedia.matches)return;
  const options=document.createElement('details');options.id='builder-options';
  options.innerHTML='<summary>Options</summary><nav aria-label="Napplet options"></nav>';
  heading.append(options);
  const nodes=[...heading.children].filter(n=>n!==options&&!n.matches('h1,.eyebrow'));
  nodes.push(...document.querySelectorAll('[data-mobile-option],.napplet-revoke'));
  for(const node of nodes){const placeholder=document.createComment('desktop option');node.before(placeholder);mobileOptions.push([node,placeholder]);options.querySelector('nav').append(node);}
  document.querySelector('header').insertBefore(heading,$('#identity'));
}
builderMedia.addEventListener('change',syncBuilderLayout);
document.addEventListener('click',event=>{
  const tab=event.target.closest('[data-builder-tab]');if(!tab)return;
  builderTabs.set(detail.project.id,tab.dataset.builderTab);syncBuilderTabs();
});
document.addEventListener('keydown',event=>{
  const tab=event.target.closest('[data-builder-tab]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();const name=event.key==='Home'?'preview':event.key==='End'?'chat':tab.dataset.builderTab==='preview'?'chat':'preview';
    builderTabs.set(detail.project.id,name);syncBuilderTabs();$('#tab-'+name).focus();
  }
  if(event.key==='Escape'&&$('#builder-options')?.open){$('#builder-options').open=false;$('#builder-options summary').focus();}
});
document.addEventListener('click',event=>{
  const options=$('#builder-options');if(options&&!options.contains(event.target))options.open=false;
});
function render() {
  document.body.classList.toggle('builder-page',screen==='builder'&&!!me);
  document.body.classList.toggle('canvas-page',screen==='page'&&!!me&&(me.host||me.state==='admitted'));
  if (activeViewer) {
    const card=activeViewer.closest('.board-plane [data-object]');
    if(card&&(!me.host&&me.state!=='admitted'||!state.board?.objects.some(p=>p.id===card.dataset.object))){viewerRevisionPending=true;void closeViewer();return;}
    viewerRevisionPending = true; return;
  }
  restoreBuilderOptions();
  renderIdentity();
  $('#main').dataset.screen = screen;
  if (screen !== 'page') delete $('#main').dataset.workshop;

  if (screen === 'start') $('#main').innerHTML = `<div class="landing"><div class="intro"><div class="eyebrow">BYO Freedom</div><h1>Build what you need.<br>Make something together.</h1><p class="muted">A room of people. A page of ideas. Napplets you can build, try and remix.</p></div><section class="card login"><div class="eyebrow">Your place at the workbench</div><h2>Join the BYOF Canvas.</h2>${entryJoinCodeField()}<div class="actions">${button('signup','Create a New Profile','','primary')}${button('login','Log in with browser extension')}</div></section></div>`;
  if (screen === 'login') $('#main').innerHTML = `${button('start','← Back','','back')}<div class="intro"><h1>${signUp ? 'Create a Nostr profile' : 'Log in'}</h1>${signUp?'<p class="muted">Start with a throwaway key saved locally, or use your browser signer.</p>':''}</div><section class="card login-form">${signUp ? '<label for="name">Display name</label><input id="name" autocomplete="nickname" maxlength="60" placeholder="Your name">' : ''}${pendingCode?`<p class="status">After authentication, join with code <strong>${esc(pendingCode)}</strong>.</p>`:''}${signUp?`<section class="signup-primary" aria-labelledby="local-key-heading"><div class="eyebrow">Recommended · quick start</div><h2 id="local-key-heading">Generate a throwaway key</h2><p>Freedom Tools will generate a Nostr key and save it only in this browser session, so you can start immediately without an extension.</p><p class="warning"><strong>Local and not recoverable.</strong> Closing this browser tab or signing out removes the key permanently.</p>${button('temporary','Generate local key and continue','','primary')}</section><details class="signup-fallback"><summary>Use a browser extension signer instead</summary><div class="signup-fallback-body"><p>Your signer holds your private key and approves the login challenge. <strong>Freedom Tools never receives your private key.</strong></p><p class="notice">No signer yet? Install or enable a Nostr signer browser extension, create or import your key there, then return and retry.</p>${button('extension','Continue with browser signer')}</div></details>`:button('extension','Log in with browser extension','','primary')}<p id="login-error" role="alert" aria-live="polite"></p></section>`;
  if(screen==='join-code')$('#main').innerHTML=`<section class="card"><h1>Join a BYOF Canvas</h1><p>Your profile is ready. Check the invitation code and try again.</p>${joinCodeForm()}${joinCodeError?`<p class="error" role="alert">${esc(joinCodeError)}</p>`:''}</section>`;
  if (!me) return;
  if (screen === 'page') {
    const room = state.room, admitted = me.host || me.state === 'admitted';
    renderWorkshop(admitted?`${me.admin&&workshops.find(w=>w.id===selectedWorkshop)?.setupState&&workshops.find(w=>w.id===selectedWorkshop).setupState!=='ready'?`<section class="card"><p>Canvas setup is incomplete. Complete the connection check before building.</p>${button('complete-canvas-setup','Complete setup',selectedWorkshop)}</section>`:''}${boardMarkup()}`:`<section class="card"><h1>${esc(room.title)}</h1><h2>${me.state==='not-joined'?'Join this BYOF Canvas':me.state==='banned'?'Access removed for this room':'Waiting for host admission'}</h2>${me.state==='not-joined'?button('join','Join BYOF Canvas'):button('refresh-me','Check admission')}</section>`);
    if(admitted) syncBoardDOM();
  }
  if (screen === 'starters') $('#main').innerHTML = `${back()}<div class="intro"><div class="eyebrow">Make your mark</div><h1>Start small. Make it yours.</h1><p class="muted">Choose one of five workshop Napplets, then make it your own.</p></div><div class="grid">${state.starters.map(s => `<section class="card starter"><div class="art">${s.icon}</div><h2>${esc(s.title)}</h2><p class="muted">${esc(s.description)}</p>${button('create','Use this starter →',s.id)}</section>`).join('')}</div><p class="notice">${state.additionalProjectsAvailable ? "Create another app whenever you need one. Each project has its own private conversation." : "One initial project per participant. Open your project from the BYOF Canvas page; forks are separate projects."}</p>`;
  if (screen === 'builder' && detail) {
    const p = detail.project, own = detail.permissions?.owner??p.owner === me.pubkey, canEdit=detail.permissions?.edit??own, current = detail.revisions.find(r => r.id === p.current_revision), selected = detail.revisions.find(r=>r.id===(builderPreviewRevisions.get(p.id)||p.current_revision))||current, shared = p.shared_revision, consent = detail.consent.some(c => c.revision_id === selected.id && c.granted), selectedIsActive=selected.id===current.id;
    const lineageLabel=revision=>revision.lineage_status==='active'?'Active on Canvas':revision.lineage_status==='ancestor'?'Active lineage':revision.lineage_status==='abandoned'?'Abandoned branch':'Saved checkpoint';
    $('#main').innerHTML = `<div class="builder-heading">${back()}<div class="eyebrow">${own ? 'Your project' : 'Administrator editing'} · Canvas v${current.number}${selectedIsActive?'':` · Previewing v${selected.number}`}</div><h1 data-project-title>${esc(p.title)}</h1>${canEdit ? button('rename','Rename Napplet',p.id) : ''}${inspectionLinks(detail.execution)}</div><div class="builder-tabs" role="tablist" aria-label="Napplet workspace"><button id="tab-preview" role="tab" aria-controls="builder-preview" data-builder-tab="preview">Preview</button><button id="tab-chat" role="tab" aria-controls="builder-chat" data-builder-tab="chat">Chat</button></div><div class="builder"><section id="builder-chat" class="card conversation-pane">${conversationMarkup()}</section><section id="builder-preview" class="card"><h2>Try your Napplet</h2>${button('larger','Open larger')} ${viewerMarkup(p.title,p.id,selected.id,selected.source_hash,true,selected.appVersionUrl)}<div data-mobile-option><p class="notice">${selectedIsActive?'Showing the version active on the Canvas.':'Preview only · the Canvas is still on v'+current.number+'.'} Sandboxed. HTTPS/WSS services must support browser access from an opaque origin; remote code, frames and Freedom Tools access remain blocked.</p><div class="actions"><span class="tag">Preview v${selected.number}</span>${canEdit&&!selectedIsActive?button('activate-revision','Push v'+selected.number+' to Canvas',selected.id,'primary'):''}${canEdit ? button('share',shared===selected.id ? 'Publication selection: v'+selected.number : selectedIsActive&&!shared ? 'Select version for publication →' : 'Select v'+selected.number+' for publication →','','') + (shared ? button('unshare','Clear publication selection') : '') : ''}</div>${own && shared === selected.id ? `<label class="check"><input type="checkbox" id="public-consent" data-revision-id="${esc(selected.id)}" ${consent ? 'checked' : ''}><span>I agree to public publication of exactly v${selected.number}, including source, my public identity and fork attribution. Private instructions are excluded.</span></label><p class="notice">This permission is separate from Canvas activation. You can revoke it before publication.</p>` : ''}${!own&&canEdit?'<p class="notice">Administrative changes are recorded under your account. Public publication consent remains with the Napplet owner.</p>':''}<h3>Versions</h3><div class="version-list">${detail.revisions.map(r => `<button type="button" class="version-row${r.id===selected.id?' selected':''}" data-a="preview-revision" data-id="${esc(r.id)}" aria-pressed="${r.id===selected.id}"><span>v${r.number} · ${lineageLabel(r)}${r.restored_from ? ' · Restored copy' : ''}</span><small>${r.id===selected.id?'Showing in preview':'Preview this saved checkpoint'}</small></button>`).join('')}</div></div></section></div>`;
  }
  if (screen === 'admin' && people) $('#main').innerHTML = managementMarkup();
  if (screen === 'edit') $('#main').innerHTML = `${back()}<div class="actions">${button('admin','People & settings')}${button('publish','Publication')}</div><div class="eyebrow">BYOF Canvas page settings</div><h1>Set the scene.</h1><section class="card"><form id="settings-form"><label for="title">BYOF Canvas heading</label><input id="title" maxlength="120" value="${esc(state.room.title)}" required><label for="intro">Introduction</label><textarea id="intro" maxlength="3000" required>${esc(state.room.introduction)}</textarea><label for="pictures">BYOF Canvas pictures (HTTPS URLs, one per line, up to six)</label><textarea id="pictures" maxlength="12288">${esc((state.room.pictures||[]).join('\n'))}</textarea><label for="support-label">Support button label</label><input id="support-label" maxlength="120" value="${esc(state.room.support_label || 'Support this BYOF Canvas')}" placeholder="Support the Bush Bash!"><label for="address">Lightning address</label><input id="address" value="${esc(state.room.lightning)}" placeholder="name@your-lightning-provider"><p class="notice">Support shows the address to copy, with a link to open a compatible wallet. No funds are held by this app.</p><label for="admission">Admission</label><select id="admission">${['invitation','approval','open'].map(v => `<option ${v === state.room.admission ? 'selected' : ''}>${v}</option>`).join('')}</select><div class="actions"><button class="primary" type="submit">Save page →</button></div></form></section>`;
  if(screen==='profile'&&profile)$('#main').innerHTML=`${back()}<h1>My Profile</h1><section class="card"><p>${me.identity_type==='temporary'?'Temporary profile for this device. Signing out removes access to this temporary identity.':'Your Nostr profile. Edits save on this device; they are not published to relays.'}</p>${profile.avatar?`<img class="profile-avatar" src="${esc(profile.avatar)}" alt="Your avatar">`:''}<form id="profile-form"><label for="profile-name">Display name</label><input id="profile-name" maxlength="60" value="${esc(profile.name)}" required><label for="profile-picture">Avatar image URL (HTTPS)</label><input id="profile-picture" maxlength="2048" type="url" value="${esc(profile.picture)}"><label for="profile-about">About</label><textarea id="profile-about" maxlength="2000">${esc(profile.about)}</textarea><div class="actions"><button class="primary" type="submit">Save on this device</button>${me.identity_type!=='temporary'?button('use-nostr-profile','Use Nostr profile'):''}</div></form><div class="actions">${button('logout','Sign out')}</div></section>`;
  if(screen==='workshops')$('#main').innerHTML=workshopsMarkup();
  if(screen==='site')$('#main').innerHTML=`${back()}<div class="eyebrow">Site administrator</div><h1>Site administration</h1><div class="grid"><section class="card"><h2>Tower connections</h2><p>Select the BYOF Canvas, then connect to its Tower to choose or create a workspace. Review and sign app access for your chosen workspace. Background publication uses the managed app identity; a private upload and readback confirm readiness.</p><label for="site-workshop">BYOF Canvas</label><select id="site-workshop">${workshops.map(w=>`<option value="${esc(w.id)}" ${w.id===selectedWorkshop?'selected':''}>${esc(w.title)}</option>`).join('')}</select><p class="status" role="status">${({ready:'Ready · private storage verified',probing:'Probing · checking private storage',error:'Error · storage needs attention',needs_authorization:'Needs authorization · choose or reconnect a workspace',disconnected:'Disconnected · managed execution unavailable'})[storage.state]||'Choose a Tower workspace to enable private storage'}</p>${towers.map(t=>`<article class="tower"><h3>${esc(t.label)}</h3><p class="identity-key">${esc(t.origin)}</p>${t.connected?'<p>Account connected</p>':''}${button('connect-registered-tower',t.connected?'Reconnect Tower':'Connect Tower',t.id)}</article>`).join('')}<form id="tower-form"><label for="tower-label">Tower name</label><input id="tower-label" maxlength="80" required><label for="tower-origin">Tower HTTPS origin</label><input id="tower-origin" type="url" maxlength="2048" placeholder="https://tower.example.com" required><button type="submit">Register Tower</button></form></section>${systemPromptsMarkup()}</div>`;
  if (screen === 'publish' && publication) {const current=publication.publication,url=current?location.origin+'/p/'+current.alias:'';$('#main').innerHTML = `${back()}<div class="eyebrow">Canvas administrator · public hosting</div><h1>Publish this Canvas.</h1><div class="grid"><section class="card"><h2>${esc(state.room.title)}</h2><p>Workshop setup is the publication agreement, so active Napplets are included by default at their current saved version. Builder conversations, prompts, grants, private datasets and drafts are never included.</p>${publication.projects.map(p=>`<label class="check"><input type="checkbox" data-hosted-project="${esc(p.id)}" ${!p.excluded?'checked':''} ${p.hidden||!p.current_revision?'disabled':''}><span>${esc(p.title)}${p.hidden?' · hidden from the Canvas':!p.current_revision?' · awaiting its first build':''}<small class="muted"> · ${esc(authorName(p))}</small></span></label>`).join('')||'<p class="muted">No Napplets yet.</p>'}<p class="notice">Excluding a Napplet removes it from the current hosted menu and export without deleting it from the private Canvas. Future immutable publication targets may retain already-published history.</p>${publication.canChooseName?`<label for="hosted-name">Custom public name (site administrators only)</label><input id="hosted-name" maxlength="63" value="${esc(current?.alias||'')}" placeholder="community-garden">`:''}<div class="actions">${button('publish-hosted',current?'Update public Canvas':'Publish public Canvas','','primary')}</div>${current?`<p class="status">Live path · <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a> · version ${current.version}</p>`:'<p class="status">The first publication assigns a stable random three-word address.</p>'}</section><section class="card"><h2>A public view, not the editor.</h2><p>The hosted page preserves the saved layout, text, groups, arrows, pictures, donation presentation and included active Napplets.</p><p>Self-contained Napplet features work anonymously. Identity, storage, wallet and service capabilities require a real signed-in visitor and retain the existing consent and server-side scope checks.</p></section></div>`;}
  document.querySelectorAll('iframe[data-napplet][data-load-now]').forEach(loadNappletFrame);
  syncBuilderLayout();
}
function rememberJoinCode(value,fresh=false){
 pendingCode=String(value??'').trim();
 if(!pendingCode){writeInvitationStorage('');return pendingCode;}
 let flow=fresh?null:history.state&&typeof history.state==='object'?history.state[invitationHistoryKey]:null;
 if(!flow){flow=crypto.randomUUID();const state=history.state&&typeof history.state==='object'?history.state:{};history.replaceState({...state,[invitationHistoryKey]:flow},'',location.href);}
 writeInvitationStorage(JSON.stringify({code:pendingCode,flow}));return pendingCode;
}
function captureEntryJoinCode(){const code=rememberJoinCode($('#workshop-code')?.value);if(code&&!/^\d{6}$/.test(code))throw Error('Enter a six-digit Canvas Code, or leave the field blank.');joinCodeError='';return code;}
function entryJoinCodeField(){return `<div id="entry-join-code"><label for="workshop-code">Canvas Code <span>(optional)</span></label><input id="workshop-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" value="${esc(pendingCode)}" placeholder="123456" aria-describedby="workshop-code-help"><p id="workshop-code-help" class="notice">Have an invitation? Enter its six-digit code before choosing how to continue.</p>${joinCodeError?`<p class="error" role="alert">${esc(joinCodeError)}</p>`:''}</div>`;}
function joinCodeForm(){return `<form id="code-join-form"><label for="workshop-code">Canvas Code</label><input id="workshop-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required value="${esc(pendingCode)}" placeholder="123456"><button type="submit">Join with code</button></form>`;}
function workshopsMarkup(){const cards=workshops.map(w=>`<section class="card canvas-card">${canvasOverviewMarkup(w)}<div class="workshop-card-heading"><h2>${esc(w.title)}</h2>${w.canManage?`<button class="workshop-settings" data-a="edit-workshop" data-id="${esc(w.id)}" aria-label="Edit ${esc(w.title)} Canvas" title="Edit Canvas">${cogIcon}</button>`:''}</div><p>${esc(w.introduction)}</p>${w.setupState&&w.setupState!=='ready'?`<p role="status">Setup incomplete</p>${me.admin?button('complete-canvas-setup','Complete setup',w.id):''}`:''}<div class="canvas-card-actions">${button('select-workshop','Open Canvas',w.id)}${w.canDelete?button('confirm-canvas-delete','Delete Canvas',w.id,'danger'):''}</div></section>`).join(''),status=workshopsLoading?(workshops.length?'<p class="notice" role="status">Refreshing Canvases…</p>':'<p class="notice" role="status">Loading Canvases…</p>'):workshopsLoadError?`<div class="notice" role="alert"><p>${esc(workshopsLoadError)}${workshops.length?' Your saved list is still available.':''}</p>${button('refresh-workshops','Try again')}</div>`:'';return `<h1>Canvases</h1><p>Choose a Canvas you have access to, or join another with its invitation code.</p>${joinCodeForm()}${me.admin?button('create-workshop','Create Canvas','','primary'):''}${status}<div class="canvas-grid">${cards||(!workshopsLoading&&!workshopsLoadError?'<p class="notice">You do not have access to any Canvases yet. Enter an invitation code to join one.</p>':'')}</div>`;}
const redeemJoinCode=singleInvitationRedemption(async code=>{rememberJoinCode(code);const joined=await api('workshops/redeem-code',{code});selectedWorkshop=joined.workshopId;setMember(joined.member);rememberJoinCode('');joinCodeError='';const url=invitationFreeUrl(location.href);url.searchParams.set('workshop',selectedWorkshop);history.replaceState(null,'',url);await page();connect();});
async function enterAfterSignIn(){if(joinCodeError){screen='join-code';render();return;}if(pendingCode){try{await redeemJoinCode(pendingCode);}catch(error){joinCodeError=error.message;screen='join-code';render();toast(error.message);return;}}else if(selectedWorkshop||requestedProjectId){await page();connect();}else{await workshopsPage();return;}await openRequestedProject();}
function synchronizeInvitationNavigation(){
 const invitation=invitationState();joinCodeError=invitationError(invitation);
 if(invitation.valid)rememberJoinCode(invitation.code,invitation.explicit);else rememberJoinCode('');
 selectedWorkshop=new URL(location.href).searchParams.get('workshop')||'';
 if(!me){screen='start';render();return;}
 if(joinCodeError){screen='join-code';render();return;}
 if(pendingCode)void enterAfterSignIn();
}
window.addEventListener('popstate',synchronizeInvitationNavigation);
function restoreVisibleInvitationAfterPageShow(){
 if(me||screen!=='start')return;
 const invitation=invitationState(),field=$('#workshop-code');
 if(invitation.valid&&field&&field.value!==invitation.code){rememberJoinCode(invitation.code,invitation.explicit);field.value=invitation.code;}
}
window.addEventListener('pageshow',()=>{synchronizeInvitationNavigation();setTimeout(restoreVisibleInvitationAfterPageShow);});
async function signIn(temporary) {
  const name = $('#name')?.value.trim() || '';
  let signer;
  if (temporary) signer = temporaryIdentity();
  else { if (!window.nostr?.signEvent) throw new Error('No Nostr signer is available. Install or enable a Nostr signer browser extension, create or import your key in the signer, then return here and retry. Freedom Tools cannot create a key in your signer.'); signer = window.nostr; }
  const challenge = await api('challenge', {}), event = await signer.signEvent(challenge.event);
  const result = await api('login', { challengeId:challenge.id, event, name, identityType:temporary ? 'temporary' : 'extension' });
  setMember(result.member); csrf = result.csrf; await enterAfterSignIn();
}
let managementView = 'people', managementWorkshop = null;
const managementFilters = {people:{query:'',status:'all'},napplets:{query:'',status:'all'}};
function managementRows() {
  const isPeople=managementView==='people',filter=managementFilters[managementView];
  const source=isPeople?people.members:people.projects;
  const query=filter.query.trim().toLocaleLowerCase();
  const matches=source.filter(item=>{
    const status=isPeople?item.state:item.hidden?'hidden':'visible';
    const text=isPeople?`${profileName(item)} ${item.pubkey}`:`${item.title} ${authorName(item)} ${item.authorPubkey||''}`;
    return (filter.status==='all'||filter.status===status)&&text.toLocaleLowerCase().includes(query);
  });
  const rows=matches.map(item=>isPeople?`<article class="management-row"><div class="management-person"><b><span data-profile-name="${esc(item.pubkey)}">${esc(profileName(item))}</span>${item.pubkey===me.pubkey?' <small class="muted">(you)</small>':''}</b><div class="management-meta"><span class="tag">${esc(item.state)}</span><span>${item.allowance} instructions allowed</span></div></div><div class="actions">${item.pubkey!==me.pubkey?`${item.state==='pending'?button('admit','Admit',item.pubkey):''}${item.state==='banned'?button('unban','Unban',item.pubkey):button('ban','Remove & ban',item.pubkey,'danger')}${button('allowance','Set allowance',item.pubkey)}`:''}</div></article>`:`<article class="management-row"><div class="management-person"><b>${esc(item.title)}</b><div class="management-meta"><span data-profile-name="${esc(item.authorPubkey||'')}">${esc(authorName(item))}</span><span class="tag">${item.hidden?'Hidden':'Visible'}</span></div></div><div class="actions">${button('open','Inspect',item.id)}${button('visibility',item.hidden?'Show':'Hide',item.id)}</div></article>`).join('');
  return `<p class="management-result muted" role="status">${matches.length} of ${source.length} ${isPeople?'people':'Napplets'}</p>${rows||`<div class="management-empty"><h3>${source.length?'No matches':isPeople?'No participants yet':'No Napplets yet'}</h3><p>${source.length?'Try another search or status filter.':isPeople?'Create an invitation to bring people into the BYOF Canvas.':'Napplets will appear here when participants start building.'}</p>${source.length?button('management-clear','Clear filters'):isPeople?button('invite','Create invitation'):''}</div>`}`;
}
function managementMarkup() {
  const settings=managementView==='settings',isPeople=managementView==='people',filter=managementFilters[managementView];
  return `${back()}<div class="eyebrow">BYOF Canvas management</div><div class="management-heading"><div><h1>Manage the BYOF Canvas.</h1><p class="muted">${esc(state.room.title)} · Building ${state.room.paused?'paused':'open'}</p></div>${button('invite','Create invitation','','primary')}</div><nav class="management-tabs" aria-label="BYOF Canvas management views">${[['people','People',people.members.length],['napplets','Napplets',people.projects.length],['settings','Settings',null]].map(([id,label,count])=>`<button data-a="management-view" data-id="${id}" aria-current="${managementView===id?'page':'false'}">${label}${count===null?'':` <span class="tag">${count}</span>`}</button>`).join('')}</nav><section class="card management-card"><h2>${settings?'Room settings':isPeople?'People':'Napplets'}</h2>${settings?`<div class="management-settings"><div><h3>Building</h3><p class="muted">${state.room.paused?'Building is paused for this room.':'Participants can build in this room.'}</p>${button('pause',state.room.paused?'Resume building':'Pause room building')}</div><div><h3>Admission & BYOF Canvas page</h3><p class="muted">Admission: ${esc(state.room.admission)}</p>${button('edit','Edit BYOF Canvas page')}</div><div><h3>Room limits</h3><p class="muted">50 members · 10 projects each · 100 saved revisions per project.</p></div></div><p class="notice">Unbanning restores membership; showing previously hidden Napplets is a separate host action.</p>`:`<div class="management-toolbar"><div><label for="management-search">${isPeople?'Search people':'Search Napplets'}</label><input id="management-search" type="search" value="${esc(filter.query)}" placeholder="${isPeople?'Name or public key':'Title or author'}" autocomplete="off"></div><div><label for="management-status">Status</label><select id="management-status">${(isPeople?['all','pending','admitted','banned']:['all','visible','hidden']).map(status=>`<option value="${status}" ${filter.status===status?'selected':''}>${status==='all'?'All statuses':status[0].toUpperCase()+status.slice(1)}</option>`).join('')}</select></div></div><div id="management-results">${managementRows()}</div>`}</section>${settings?builderEngineMarkup():''}`;
}
document.addEventListener('input',event=>{if(event.target.id==='management-search'&&screen==='admin'){managementFilters[managementView].query=event.target.value;$('#management-results').innerHTML=managementRows();}});
document.addEventListener('change',event=>{if(event.target.id==='management-status'&&screen==='admin'){managementFilters[managementView].status=event.target.value;$('#management-results').innerHTML=managementRows();}});
async function admin() { if(managementWorkshop!==selectedWorkshop){managementWorkshop=selectedWorkshop;managementView='people';for(const key of ['people','napplets'])managementFilters[key]={query:'',status:'all'};} storage = null; people = await api('host/people'); hydrateProfiles(people.members); builderGuidance = await api('host/builder-prompt'); screen = 'admin'; menu = false; render(); }
let promptWorkshopId=null;
function builderEngineMarkup(){
 const choice=builderGuidance?.builderEngine;if(!me?.admin||!choice)return '';
 return `<section class="card"><h2>Builder engine</h2><form id="builder-engine-form"><label for="builder-engine">Agent used for new Napplet messages</label><select id="builder-engine">${choice.options.map(option=>`<option value="${esc(option.agent)}" ${option.agent===choice.agent?'selected':''}>${esc(option.label)}${option.available?'':' · awaiting activation'}</option>`).join('')}</select><p class="notice">Goose uses GLM 5.3 through managed OpenRouter. Claude and Codex use their configured defaults. Engine changes apply to new requests; saved requests and retries keep their original engine.</p><p class="status" role="status">${esc(choice.reason)}</p><div class="actions"><button class="primary" type="submit">Save builder engine</button><button data-a="reload-builder-prompt" type="button">Reload saved settings</button></div></form></section>`;
}
function systemPromptsMarkup(){
 if(!builderGuidance)return '';
 return `${builderEngineMarkup()}<section class="card"><h2>System prompts</h2><label for="prompt-workshop">Prompt scope</label><select id="prompt-workshop">${workshops.map(w=>`<option value="${esc(w.id)}" ${w.id===promptWorkshopId?'selected':''}>${esc(w.title)}</option>`).join('')}</select><p class="notice">${builderGuidance.scope==='site'?'Site builder prompt for the primary BYOF Canvas.':'Saved builder instructions for this BYOF Canvas.'} New messages use the saved instructions. Queued messages and retries keep their original instructions.</p><form id="builder-prompt-form"><label for="agent-name">Agent name</label><input id="agent-name" maxlength="${builderGuidance.agentNameMaxChars}" value="${esc(builderGuidance.prompt.agentName)}" required><label for="builder-prompt">Napplet builder guidance</label><textarea id="builder-prompt" rows="16" maxlength="${builderGuidance.maxChars}" required>${esc(builderGuidance.prompt.text)}</textarea><div class="actions"><button class="primary" type="submit">Save builder prompt</button><button data-a="reload-builder-prompt" type="button">Reload saved prompt</button></div></form></section>`;
}
let reusableWorkspaces=[];
let activeTowerId=null,towerSetupSelection=null,towerConnectionStorage=null,towerSetupEpoch=0;
async function signTower(url,method,body){
 if(!window.nostr?.signEvent)throw Error('Use your signed-in Nostr extension to authorize Tower');
 const payload=body===undefined?undefined:JSON.stringify(body);
 const hash=payload?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(x=>x.toString(16).padStart(2,'0')).join(''):null;
 return window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method',method],...(hash?[['payload',hash]]:[])]});
}
async function testCanvasBackend(refresh=false){
 const d=canvasDraft(),select=$('#workshop-tower'),towerId=d.towerId||select?.value;
 if(!towerId){canvasSetup.error='Choose an NStack backend before testing the connection.';canvasSetup.connectionStatus='failure';canvasSetup.focus='#workshop-tower';renderCanvasSetup();return;}
 saveCanvasDraft({towerId});activeTowerId=towerId;canvasSetup.error='';canvasSetup.connectionStatus='pending';if(refresh)canvasSetup.workspaceStatus='loading';renderCanvasSetup();
 const epoch=++towerSetupEpoch;
 try{
  let current=canvasDraft();if(!current.workshopId){const created=await api('site/workshops',{title:current.title,introduction:current.introduction,owner:current.owner,towerId,idempotencyKey:current.idempotencyKey},undefined,'');selectedWorkshop=created.id;saveCanvasDraft({workshopId:created.id});workshops=(await api('workshops')).workshops;render();dialogOpener=document.querySelector(`[data-a="complete-canvas-setup"][data-id="${CSS.escape(created.id)}"]`)||dialogOpener;}
  const tower=towers.find(t=>t.id===towerId);if(!tower)throw Error('Choose a registered NStack backend');
  const event=await signTower(tower.origin+'/api/v4/flightdeck-pg/workspaces','GET');if(epoch!==towerSetupEpoch||!canvasSetup)return;
  const connected=await api('site/towers/'+towerId+'/connect',{event},undefined,selectedWorkshop);if(epoch!==towerSetupEpoch||!canvasSetup)return;
  reusableWorkspaces=connected.reusable||[];towerWorkspaces=connected.workspaces||[];towerConnectionStorage=connected.storage;storage=connected.storage;const registered=towers.find(t=>t.id===towerId);if(registered)registered.connected=true;
  const chosen=towerWorkspaces.find(item=>item.identity?.workspace_id===canvasDraft().workspaceId);saveCanvasDraft({workspaceId:chosen?.identity.workspace_id||'',workspaceLabel:chosen?.label||''});canvasSetup.connectionStatus='success';canvasSetup.workspaceStatus='idle';canvasSetup.error='';renderCanvasSetup();
 }catch(error){if(epoch!==towerSetupEpoch||!canvasSetup)return;canvasSetup.connectionStatus='failure';canvasSetup.workspaceStatus='error';canvasSetup.error=setupError(error);renderCanvasSetup();}
}
async function confirmAndLaunchCanvas(){
 const d=canvasDraft(),workspace=towerWorkspaces.find(item=>item.identity?.workspace_id===d.workspaceId),tower=towers.find(t=>t.id===d.towerId),scope=d.workshopId;
 if(!scope||!tower||!workspace){canvasSetup.saveStatus='failure';canvasSetup.error='Return to the previous steps and choose a tested backend and workspace.';renderCanvasSetup();return;}
 const epoch=++towerSetupEpoch,current=()=>epoch===towerSetupEpoch&&!!canvasSetup&&selectedWorkshop===scope;
 canvasSetup.saveStatus='pending';canvasSetup.error='';renderCanvasSetup();
 try{
  const savedProbe=storage.state==='probing'&&storage.binding?.target?.workspaceId===d.workspaceId;
  const owner=workspace.identity?.workspace_owner_npub;if(!owner)throw Error('Selected workspace owner identity is unavailable');
  const datasetReady=storage.dataset?.status==='ready'&&storage.datasetDiscovery?.code==='exact_match';
  let datasetAuthorization={};
  if(!datasetReady){
   const datasetAppNpub=storage.datasetAppNpub||storage.dataset?.appNpub;if(!datasetAppNpub)throw Error('The Canvas dataset app identity is unavailable');
   const datasetNamespace={app_npub:datasetAppNpub,app_name:'BYO Freedom datasets',capabilities:['wapp','app-db'],enabled:true};
   const datasetInvite={invitee_npub:datasetAppNpub,role:'guest',kind:'app',display_name:'BYO Freedom Canvas datasets'};
   const datasetNamespaceEvent=await signTower(`${tower.origin}/api/v4/workspaces/${owner}/apps`,'POST',datasetNamespace);if(!current())return;
   const datasetInviteEvent=await signTower(`${tower.origin}/api/v4/flightdeck-pg/workspaces/${d.workspaceId}/invites`,'POST',datasetInvite);if(!current())return;
   datasetAuthorization={datasetNamespaceEvent,datasetInviteEvent};
  }
  if(savedProbe&&datasetReady){}else if(storage.state==='ready'&&!datasetReady)storage=await api('site/towers/'+tower.id+'/bind',{workspaceId:d.workspaceId,...datasetAuthorization},undefined,scope);
  else if(reusableWorkspaces.includes(d.workspaceId))storage=await api('site/towers/'+tower.id+'/bind',{workspaceId:d.workspaceId,reuse:true,...datasetAuthorization},undefined,scope);
  else{
   const grant={invitee_npub:storage.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'};
   const event=await signTower(`${tower.origin}/api/v4/flightdeck-pg/workspaces/${d.workspaceId}/invites`,'POST',grant);if(!current())return;
   let namespaceEvent;
   if(storage.datasetDiscovery?.code!=='exact_match'){
    const namespace={app_npub:storage.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true};
    namespaceEvent=await signTower(`${tower.origin}/api/v4/workspaces/${owner}/apps`,'POST',namespace);if(!current())return;
   }
   storage=await api('site/towers/'+tower.id+'/bind',{workspaceId:d.workspaceId,event,...(namespaceEvent?{namespaceEvent}:{}),...datasetAuthorization,reconnect:true},undefined,scope);
  }
  const deadline=Date.now()+90000;
  while(current()&&Date.now()<deadline&&!(storage.binding?.status==='ready'&&storage.namespaceReady)){if(storage.probe?.error)throw Error(storage.probe.error);await new Promise(resolve=>setTimeout(resolve,700));storage=await api('host/storage/probe',{},undefined,scope);}
  if(!current())return;if(!(storage.binding?.status==='ready'&&storage.namespaceReady&&storage.dataset?.status==='ready'&&storage.datasetDiscovery?.code==='exact_match'))throw Error('The saved storage and dataset connections are still being checked. Retry to continue this setup.');
  const listed=await api('workshops');workshops=listed.workshops;const authoritative=workshops.find(item=>item.id===scope);if(authoritative?.setupState!=='ready')throw Error('The backend has not confirmed this Canvas setup yet.');
  selectedWorkshop=scope;await page();connect();sessionStorage.removeItem(canvasDraftKey());$('#dialog').close();
 }catch(error){if(!current())return;canvasSetup.saveStatus='failure';canvasSetup.error=setupError(error);renderCanvasSetup();}
}
function towerDialog(content){if(screen==='canvas-setup'){$('#canvas-setup-panel').innerHTML=content+`<div class="actions">${button('pause-canvas-setup','Save and leave setup')}</div>`;return;}if($('#dialog').open)$('#dialog').innerHTML=content+'<div class="actions"><button data-a="close">Close</button></div>';else dialog(content);}
function towerChooser(){
 const storage=towerConnectionStorage;
 if(!storage.configured){towerDialog(`<h2>Tower account connected</h2><p role="status">Your Tower account is authorized. ${towerWorkspaces.length} workspace${towerWorkspaces.length===1?'':'s'} found.</p><p>${storage.otherTower?'This BYOF Canvas already uses another Tower for private storage. Its saved destination is unchanged. Use a new BYOF Canvas to set up storage on this Tower.':'Private storage is not enabled. Managed app execution is unavailable. The site operator must configure the installation-wide storage worker before workspace authorization.'}</p>${towerWorkspaces.map(w=>`<p>${esc(w.label||'Workspace')}</p>`).join('')}`);return;}
 const bound=storage.binding?.target?.workspaceId;
 towerDialog(`<h2>Choose a workspace</h2><p>Connect ${esc(workshops.find(w=>w.id===selectedWorkshop)?.title)} to ${esc(towers.find(t=>t.id===activeTowerId)?.label)} (${esc(towers.find(t=>t.id===activeTowerId)?.origin)}).</p>${bound?'<p>Existing saved versions stay in their current workspace. Select that workspace to reconnect. Use another BYOF Canvas for a new destination.</p>':''}<div class="workspace-choices">${towerWorkspaces.map(w=>`<p><button data-a="select-tower-workspace" data-id="${esc(w.identity.workspace_id)}" ${bound&&bound!==w.identity.workspace_id?'disabled':''}>${esc(w.label||'Workspace')}${reusableWorkspaces.includes(w.identity.workspace_id)?' · reuse connection':''}</button></p>`).join('')}</div>${!towerWorkspaces.length?'<p>No authorized workspaces found.</p>':''}<form id="tower-create-form"><label for="tower-workspace-name">New workspace name</label><input id="tower-workspace-name" maxlength="80" required><button type="submit" ${bound?'disabled':''}>Create workspace</button></form><p id="tower-setup-error" role="alert"></p>`);
}
async function openTowerConnection(id){
 const epoch=++towerSetupEpoch,scope=selectedWorkshop;activeTowerId=id;towerSetupSelection=null;reusableWorkspaces=[];
 towerDialog('<h2>Connect Tower</h2><p role="status">Loading your workspaces…</p>');
 try{const tower=towers.find(t=>t.id===id),event=await signTower(tower.origin+'/api/v4/flightdeck-pg/workspaces','GET');if(epoch!==towerSetupEpoch||scope!==selectedWorkshop)return;const connected=await api('site/towers/'+id+'/connect',{event},undefined,scope);if(epoch!==towerSetupEpoch||scope!==selectedWorkshop)return;reusableWorkspaces=connected.reusable||[];towerWorkspaces=connected.workspaces;towerConnectionStorage=connected.storage;if(!connected.storage.otherTower)storage=connected.storage;const registered=towers.find(t=>t.id===id);if(registered)registered.connected=true;const selected=workshops.find(w=>w.id===selectedWorkshop);if(selected&&!connected.storage.otherTower)selected.tower_id=id;if(screen!=='canvas-setup')render();towerChooser();}
 catch(error){if(epoch!==towerSetupEpoch||scope!==selectedWorkshop)return;towerDialog(`<h2>Connect Tower</h2><p role="alert">${esc(error.message)}</p>${button('retry-tower-connect','Retry connection')}`);throw error;}
}
function reviewTowerWorkspace(workspaceId){
 towerSetupSelection=workspaceId;
 const workspace=towerWorkspaces.find(w=>w.identity.workspace_id===workspaceId),tower=towers.find(t=>t.id===activeTowerId);
 if(!workspace||!tower)throw Error('Reconnect Tower to select an authorized workspace');
 if(reusableWorkspaces.includes(workspaceId)){towerDialog(`<h2>Reuse connection</h2><p>${esc(tower.label)} · ${esc(tower.origin)}</p><p>${esc(workspace.label||'Workspace')} · ${esc(workspaceId)}</p><p>Existing app access matches this exact destination. Check private storage again before opening the Canvas. If access has been removed, review and sign again.</p>${button('reuse-tower-workspace','Check connection',workspaceId)}${button('review-new-tower-access','Review access',workspaceId)}`);return;}
 towerDialog(`<h2>Review app access</h2><p>Authorize Freedom Tools on <b>${esc(tower.label)}</b> (${esc(tower.origin)}) in <b>${esc(workspace.label||'Workspace')}</b>.</p><p class="identity-key">Workspace: ${esc(workspaceId)}</p><p>Your browser reviews the exact native namespace and workspace-guest operations for both stable identities. Tower guest access follows the workspace’s native permissions.</p><p class="identity-key">Publication and private-file app: ${esc(storage.appNpub)}</p><p class="identity-key">Canvas dataset app: ${esc(storage.datasetAppNpub||storage.dataset?.appNpub||'Unavailable')}</p><p>The dataset signer stays server-only; your personal key is never given to either app. Existing publication authority is not rewritten. Readiness requires a real private upload/readback plus descriptor, migration and query proof from the dataset identity.</p>${button('authorize-tower-workspace',storage.binding?'Reauthorize and check connections':'Authorize and check connections',workspaceId)}`);
}
async function setupTowerWorkspace(workspaceId,reuse=false){
 const epoch=++towerSetupEpoch,workshopScope=selectedWorkshop,towerId=activeTowerId,appNpub=storage.appNpub;
 const current=()=>epoch===towerSetupEpoch&&(screen==='canvas-setup'||$('#dialog').open)&&workshopScope===selectedWorkshop&&towerId===activeTowerId;
 towerSetupSelection=workspaceId;const workspace=towerWorkspaces.find(w=>w.identity.workspace_id===workspaceId);
 towerDialog(`<h2>Set up private storage</h2><p role="status">${reuse?'Checking your existing connection…':'Approve the signing prompts to authorize BYO Freedom. Private storage will be checked automatically.'}</p>`);
 try{
  const origin=towers.find(t=>t.id===towerId).origin;
  const owner=workspace?.identity?.workspace_owner_npub;if(!owner)throw Error('Selected workspace owner identity is unavailable');
  const datasetReady=storage.dataset?.status==='ready'&&storage.datasetDiscovery?.code==='exact_match',datasetAppNpub=storage.datasetAppNpub||storage.dataset?.appNpub;let datasetAuthorization={};
  if(!datasetReady){if(!datasetAppNpub)throw Error('The Canvas dataset app identity is unavailable');const datasetNamespace={app_npub:datasetAppNpub,app_name:'BYO Freedom datasets',capabilities:['wapp','app-db'],enabled:true},datasetInvite={invitee_npub:datasetAppNpub,role:'guest',kind:'app',display_name:'BYO Freedom Canvas datasets'};datasetAuthorization={datasetNamespaceEvent:await signTower(`${origin}/api/v4/workspaces/${owner}/apps`,'POST',datasetNamespace),datasetInviteEvent:await signTower(`${origin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,'POST',datasetInvite)};if(!current())return;}
  if((reuse||storage.state==='ready')&&!datasetReady){storage=await api('site/towers/'+towerId+'/bind',{workspaceId,...(reuse?{reuse:true}:{}),...datasetAuthorization},undefined,workshopScope);}else if(reuse){storage=await api('site/towers/'+towerId+'/bind',{workspaceId,reuse:true},undefined,workshopScope);}else{
  const grant={invitee_npub:appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'};
  const event=await signTower(`${origin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,'POST',grant);
  if(!current())return;
  let namespaceEvent;if(storage.datasetDiscovery?.code!=='exact_match'){const namespace={app_npub:appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true};namespaceEvent=await signTower(`${origin}/api/v4/workspaces/${owner}/apps`,'POST',namespace);if(!current())return;}
  storage=await api('site/towers/'+towerId+'/bind',{workspaceId,event,...(namespaceEvent?{namespaceEvent}:{}),...datasetAuthorization,reconnect:true},undefined,workshopScope);
  }
  if(!current())return;
  towerDialog('<h2>Set up private storage</h2><p role="status">Checking tables, private upload and readback…</p>');
  await waitForTowerSetup(current,workspace,workspaceId,workshopScope);
 }catch(error){if(!current())return;towerDialog(`<h2>Storage setup needs attention</h2><p role="alert">${esc(error.message)}</p>${button('retry-tower-setup','Retry setup')}${button('review-new-tower-access','Review access',workspaceId)}`);throw error;}
}
async function waitForTowerSetup(current,workspace,workspaceId,workshopScope){
  const deadline=Date.now()+90000;
  while(Date.now()<deadline&&current()){
   if(storage.binding?.status==='ready'&&storage.namespaceReady&&storage.dataset?.status==='ready'&&storage.datasetDiscovery?.code==='exact_match'){if(screen==='canvas-setup'){const target=storage.binding.target;towerDialog(`<h2>Ready</h2><p role="status">Private storage and Canvas datasets verified.</p><p>${esc(target.towerUrl||storage.towerOrigin)} · ${esc(workspace.label||'Workspace')} · ${esc(workspaceId)}</p>${button('open-ready-canvas','Open Canvas',workshopScope)}`);}else{await siteAdmin();towerDialog('<h2>Ready</h2><p role="status">Private storage and Canvas datasets verified. This BYOF Canvas is connected.</p>');}return;}
   if(storage.probe?.error)throw Error(storage.probe.error);
   await new Promise(resolve=>setTimeout(resolve,700));storage=await api('host/storage/probe',{},undefined,workshopScope);
  }
  if(!current())return;
  throw Error('Setup is still pending. Retry to check the saved setup without creating another workspace.');
}
async function resumeCanvasProbe(){
 const epoch=++towerSetupEpoch,scope=selectedWorkshop,current=()=>epoch===towerSetupEpoch&&screen==='canvas-setup'&&scope===selectedWorkshop;
 towerDialog('<h2>Check saved setup</h2><p role="status">Checking private storage…</p>');
 try{storage=await api('host/storage/probe',{},undefined,scope);const workspaceId=storage.binding?.target?.workspaceId;await waitForTowerSetup(current,{label:'Saved workspace'},workspaceId,scope);}
 catch(error){if(current())towerDialog(`<h2>Storage setup needs attention</h2><p role="alert">${esc(error.message)}</p>${button('connect-registered-tower','Review connection',activeTowerId)}`);}
}
async function createConnectedWorkspace(){
 const epoch=towerSetupEpoch,scope=selectedWorkshop,towerId=activeTowerId,current=()=>epoch===towerSetupEpoch&&scope===selectedWorkshop&&towerId===activeTowerId;
 const name=$('#tower-workspace-name').value.trim();
 const intentKey='tower-create:'+me.pubkey+':'+selectedWorkshop+':'+activeTowerId;
 try{workspaceCreateIntent=JSON.parse(sessionStorage.getItem(intentKey)||'null');}catch{workspaceCreateIntent=null;}
 if(!workspaceCreateIntent||workspaceCreateIntent.name!==name||workspaceCreateIntent.tower!==activeTowerId)workspaceCreateIntent={name,tower:activeTowerId,key:crypto.randomUUID()};
 sessionStorage.setItem(intentKey,JSON.stringify(workspaceCreateIntent));
 const body={workspaceName:name,idempotencyKey:workspaceCreateIntent.key};
 try{
  const prepared=await api('site/towers/'+towerId+'/create-intent',body,undefined,scope);if(!current())return;const event=await signTower(prepared.url,'POST',prepared.payload);if(!current())return;
  const created=await api('site/towers/'+towerId+'/create',{...body,event},undefined,scope);if(!current())return;
  // Create is an explicit choice, followed by explicit destination confirmation.
  const listEvent=await signTower(towers.find(t=>t.id===activeTowerId).origin+'/api/v4/flightdeck-pg/workspaces','GET');
  if(!current())return;const connected=await api('site/towers/'+towerId+'/connect',{event:listEvent},undefined,scope);if(!current())return;storage=connected.storage;towerConnectionStorage=connected.storage;reusableWorkspaces=connected.reusable||[];towerWorkspaces=connected.workspaces;
  workspaceCreateIntent=null;sessionStorage.removeItem(intentKey);
  if(canvasSetup){canvasSetup.workspaceStatus='idle';canvasSetup.error='Workspace created. Select '+name+' below.';renderCanvasSetup();}else{towerChooser();$('#tower-setup-error').textContent='Workspace created. Select '+name+' to connect this BYOF Canvas.';}
 }catch(error){if(!current())return;if(canvasSetup){canvasSetup.workspaceStatus='error';canvasSetup.error=setupError(error);renderCanvasSetup();}else if($('#tower-setup-error'))$('#tower-setup-error').textContent=error.message;throw error;}
}
async function siteAdmin(){towers=(await api('site/towers')).towers;const listed=await api('workshops');workshops=listed.workshops;if(!promptWorkshopId)promptWorkshopId=listed.legacyWorkshopId;builderGuidance=await api('site/builder-prompt',undefined,undefined,promptWorkshopId);storage=await api('host/storage');screen='site';menu=false;render();}
async function memberAction(pubkey,stateValue,allowance) { const member = people.members.find(m => m.pubkey === pubkey); await api('host/members/' + pubkey,{state:stateValue,allowance:allowance ?? member.allowance}); await admin(); }
document.addEventListener('click', async event => {
  const target = event.target.closest('button[data-a]'); if (!target) return;
  if(busy&&['close','close-canvas-setup','pause-canvas-setup'].includes(target.dataset.a)){towerSetupEpoch++;saveCanvasDraft();if(target.dataset.a==='pause-canvas-setup')await workshopsPage();else $('#dialog').close();return;}
  if(busy)return;
  if(['create-workshop','complete-canvas-setup'].includes(target.dataset.a))dialogOpener=target;
  const action = target.dataset.a, id = target.dataset.id; startBusy();
  try {
    if(action==='management-view'){managementView=id;render();}
    if(action==='management-clear'){managementFilters[managementView]={query:'',status:'all'};render();}
    if (action === 'close') {towerSetupEpoch++;$('#dialog').close();}
    if(action==='close-canvas-setup'){saveCanvasDraft();towerSetupEpoch++;$('#dialog').close();}
    if (action === 'menu') { menu = !menu; render(); }
    if (action === 'start') { screen = 'start'; render(); }
    if (action === 'signup') { captureEntryJoinCode();signUp = true; screen = 'login'; render(); }
    if (action === 'login') { captureEntryJoinCode();signUp = false; await signIn(false); }
    if (action === 'temporary' || action === 'extension') await signIn(action === 'temporary');
    if(action==='profile'){profile=profiles.peek(me.pubkey,me.identity_type==='temporary'?me.name:'');screen='profile';menu=false;render();}
    if(action==='pause-canvas-setup'){towerSetupEpoch++;await workshopsPage();}
    if(action==='workshops'){towerSetupEpoch++;await workshopsPage();}
    if(action==='refresh-workshops')await workshopsPage();
    if(action==='resume-saved-canvas')await completeCanvasSetup(id);
    if(action==='start-another-canvas'){sessionStorage.removeItem(canvasDraftKey());await openCanvasSetup();}
    if(action==='create-workshop')await openCanvasSetup();
    if(action==='cancel-create-workshop')$('#dialog').close();
    if(action==='use-nostr-profile'){profiles.clearLocal(me.pubkey);profile=profiles.peek(me.pubkey);render();}
    if(action==='edit-workshop'){if(!workshops.find(w=>w.id===id)?.canManage)throw Error('BYOF Canvas management access required');nappletHost.revoke();selectedWorkshop=id;detail=null;requestedProjectId=null;towerWorkspaces=[];await page();connect();screen='edit';menu=false;render();}
    if(action==='confirm-canvas-delete'){
      const canvas=workshops.find(w=>w.id===id);if(!canvas?.canDelete)throw Error('Canvas deletion access required');
      dialog(`<h2>Delete ${esc(canvas.title)} Canvas?</h2><p>This permanently deletes this Canvas, its memberships, Napplets, conversations, and other Freedom Tools records. This cannot be undone.</p><p class="notice">Canvas datasets and published artifacts stored by external services will not be deleted.</p><form id="canvas-delete-form" data-id="${esc(canvas.id)}" data-title="${esc(canvas.title)}"><label for="canvas-delete-confirm">Type <strong>CONFIRM</strong> to permanently delete this Canvas</label><input id="canvas-delete-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" required><p id="canvas-delete-error" class="error" role="alert" hidden></p><button id="canvas-delete-submit" class="danger" type="submit" disabled>Permanently delete Canvas</button></form>`,target);
    }
    if(action==='resume-canvas-probe')await resumeCanvasProbe();
    if(action==='complete-canvas-setup')await completeCanvasSetup(id);
    if(action==='canvas-setup-back'){saveCanvasDraft();canvasSetup.error='';canvasSetup.saveStatus='idle';canvasSetup.step=Math.max(1,canvasSetup.step-1);renderCanvasSetup();}
    if(action==='canvas-setup-next'){if(canvasSetup.step===2&&canvasSetup.connectionStatus==='success'){canvasSetup.step=3;canvasSetup.error='';renderCanvasSetup();}else if(canvasSetup.step===3&&canvasDraft().workspaceId){canvasSetup.step=4;canvasSetup.error='';renderCanvasSetup();}}
    if(action==='test-canvas-backend')await testCanvasBackend();
    if(action==='refresh-canvas-workspaces')await testCanvasBackend(true);
    if(action==='confirm-canvas-setup')await confirmAndLaunchCanvas();
    if(action==='open-ready-canvas'){if(storage.state!=='ready')throw Error('Finish the connection check first');sessionStorage.removeItem(canvasDraftKey());await page();connect();}
    if(action==='select-workshop'){nappletHost.revoke();selectedWorkshop=id;detail=null;towerWorkspaces=[];await page();connect();}
    if(action==='join')dialog('<h2>Join BYOF Canvas</h2><form id="join-form"><label for="join-invitation">Invitation code (optional)</label><input id="join-invitation" maxlength="200"><button type="submit">Confirm join</button></form>');
    if(action==='site')await siteAdmin();
    if(action==='connect-registered-tower')await openTowerConnection(id);
    if(action==='select-tower-workspace')reviewTowerWorkspace(id);
    if(action==='review-new-tower-access'){reusableWorkspaces=reusableWorkspaces.filter(w=>w!==id);reviewTowerWorkspace(id);}
    if(action==='reuse-tower-workspace')await setupTowerWorkspace(id,true);
    if(action==='authorize-tower-workspace')await setupTowerWorkspace(id);
    if(action==='retry-tower-setup')reviewTowerWorkspace(towerSetupSelection);
    if(action==='retry-tower-connect')await openTowerConnection(activeTowerId);
    if (action === 'page') await page();
    if (action === 'refresh-me') { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); }
    if (action === 'starters') { screen = 'starters'; menu = false; render(); }
    if (action === 'create') { $('#dialog').close(); detail = await api('projects',{starterId:id}); screen = 'builder'; render(); }
    if (action === 'fork') { const key=forkRequestStorageKey(id);detail=await api('projects',{forkProjectId:id,idempotencyKey:forkRequestId(id)});sessionStorage.removeItem(key);$('#dialog').close();screen='builder';render();toast('Fork created from the latest saved version'); }
    if (action === 'open') { $('#dialog').close(); await openProject(id); }
    if (action === 'edit-napplet') { $('#dialog').close(); await openProject(id,true); }
    if (action === 'larger') openViewer($('.inline-viewer'), target);
    if (action === 'board-object') { const o=boardDraft().objects.find(o=>o.id===id);editBoardObject(o.kind,id); }
    if (action === 'minimize') { const key = selectedWorkshop + ':' + id; if (minimizedNapplets.has(key)) minimizedNapplets.delete(key); else minimizedNapplets.add(key); render(); }
    if (action === 'pop-out') { minimizedNapplets.delete(selectedWorkshop + ':' + id); render(); openViewer(target.closest('.napplet-card').querySelector('.inline-viewer'), target); }
    if (action === 'napplet-settings' || action === 'napplet-options') {
      const p = [...state.projects, ...(state.board?.napplets||[])].find(p => p.id === id), owner=(p.owner||p.authorPubkey)===me.pubkey,canEdit=owner||me.host;
      if (action === 'napplet-settings' && !canEdit) throw Error('Napplet administrator access required');
      dialog(`<h2>${esc(p.title)}</h2><div class="napplet-owner-actions">${canEdit ? button('rename','Rename',id)+button('edit-napplet',owner?'Edit your Napplet!':'Edit Napplet as administrator',id) : ''}${button('fork','Fork this Napplet and make it your own!',id)}${me.admin?button('confirm-napplet-delete','Delete Napplet',id,'danger'):''}</div><p id="napplet-action-error" class="error" role="alert" hidden></p>`,null,true);
    }
    if(action==='confirm-napplet-delete'){
      if(!me.admin)throw Error('Site administrator access required');
      const p=[...state.projects,...(state.board?.napplets||[])].find(project=>project.id===id);if(!p)throw Error('Napplet not found');
      dialog(`<h2>Delete ${esc(p.title)}?</h2><p>This permanently removes this Napplet from Freedom Tools, including its Canvas window and app-local data. Immutable audit and build history are retained. External publication artifacts and native transcripts are not erased.</p><form id="napplet-delete-form" data-id="${esc(p.id)}" data-title="${esc(p.title)}" data-revision="${esc(p.current_revision)}"><label for="napplet-delete-confirm">Type <strong>${esc(p.title)}</strong> to permanently delete this Napplet</label><input id="napplet-delete-confirm" autocomplete="off" spellcheck="false" required><p id="napplet-delete-error" class="error" role="alert" hidden></p><div class="actions"><button type="button" data-a="close">Cancel</button><button id="napplet-delete-submit" class="danger" type="submit" disabled>Permanently delete Napplet</button></div></form>`,target);
      $('#napplet-delete-confirm').focus();
    }
    if (action === 'rename') { const p = screen === 'builder' ? detail.project : [...state.projects, ...(state.board?.napplets||[])].find(p => p.id === id); dialog(`<h2>Rename Napplet</h2><form id="rename-form" data-id="${esc(p.id)}"><label for="napplet-title">Napplet title</label><input id="napplet-title" maxlength="120" required value="${esc(p.title)}" aria-describedby="rename-error"><p id="rename-error" class="error" role="alert" hidden></p><button class="primary" type="submit">Save name</button></form>`,null,true); $('#napplet-title').focus(); }
    if (action === 'confirm-native-delete') dialog(`<h2>Delete ${esc(detail.agentName)} native history?</h2><p>This deletes the native transcript and runtime records. Provider metadata indexes remain. Your app messages and game versions are preserved.</p>${button('delete-native-builder','Delete native transcript and runtime')}`);
    if (action === 'delete-native-builder') { await api(`projects/${detail.project.id}/builder/native`,{generation:detail.builder.generation,confirmNativeTranscriptDeletion:true}); $('#dialog').close(); await openProject(detail.project.id); toast('Native lifecycle operation saved. Waiting for its signed receipt.'); }
    if (action === 'retire-builder') { const result = await api(`projects/${detail.project.id}/builder`,{generation:detail.builder.generation},'DELETE'); await openProject(detail.project.id); toast(detail.agentName + ' session retired. Saved messages and app versions are preserved.'); }
    if(action==='cancel-request'){await api(`projects/${detail.project.id}/requests/${id}/cancel`,{});await openProject(detail.project.id);toast('Saved request cancelled; your app is unchanged');}
    if(action==='correct-request-engine'){const request=detail.requests.find(request=>request.id===id);dialog(`<h2>Use the current Canvas builder?</h2><p>This request is proven not to have reached a model. Its original selection remains in the audit history; this one correction becomes immutable before retry.</p><form id="request-engine-correction-form" data-id="${esc(id)}"><label for="engine-correction-reason">Reason</label><input id="engine-correction-reason" maxlength="1000" required value="Correct mistaken pre-dispatch Canvas builder selection"><input type="hidden" id="engine-correction-request-revision" value="${esc(request.builderEngine.revision)}"><input type="hidden" id="engine-correction-canvas-revision" value="${esc(detail.selectedBuilderEngine.revision)}"><button class="primary" type="submit">Record audited correction</button></form>`);}
    if (action === 'resume-request') { const result=await api(`projects/${detail.project.id}/requests/${id}/resume`,{}); await openProject(detail.project.id); toast(result.request?.status==='queued'?'Request saved; dispatch has not started':result.request?.status==='building'?'Saved request connected':'Saved request status updated'); }
    if(action==='preview-revision'){builderPreviewRevisions.set(detail.project.id,id);render();}
    if(action==='activate-revision'){detail=await api(`projects/${detail.project.id}/activate`,{revisionId:id,expectedRevisionId:detail.project.current_revision});builderPreviewRevisions.set(detail.project.id,id);render();toast('v'+detail.revisions.find(r=>r.id===id).number+' is now active on the Canvas');}
    if (action === 'restore') { detail = await api(`projects/${detail.project.id}/restore`, {revisionId:id,expectedRevisionId:detail.project.current_revision});builderPreviewRevisions.set(detail.project.id,detail.project.current_revision); render(); toast('Restored as a new saved revision'); }
    if (action === 'share') {const selected=detail.revisions.find(r=>r.id===(builderPreviewRevisions.get(detail.project.id)||detail.project.current_revision));dialog(`<h2>Select v${selected.number} for publication</h2><p>This pins exactly the version currently shown in the builder preview. It does not activate that version on the Canvas. Public publication still requires separate exact-version consent; your builder conversation stays private.</p>` + button('share-confirm','Select v'+selected.number+' →',selected.id,'primary'));}
    if (action === 'share-confirm') { detail = await api(`projects/${detail.project.id}/share`,{revisionId:id}); $('#dialog').close(); render(); toast('Publication version selected'); }
    if (action === 'unshare') { detail = await api(`projects/${detail.project.id}/share`,{revisionId:null}); render(); toast('Room sharing and public consent removed'); }
    if (action === 'logout') { nappletHost.revoke(); if(me.identity_type==='temporary')profiles.clearLocal(me.pubkey); await api('logout',{}); socket?.close(); forgetTemporaryIdentity(); me = null; state = null; workshops=[]; screen = 'start'; render(); }
    if (action === 'tower-connect') {
      if(!window.nostr)throw Error('A Nostr browser extension is required for Tower sign-in');
      const event=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',storage.towerOrigin+'/api/v4/flightdeck-pg/workspaces'],['method','GET']],content:''});
      towerWorkspaces=(await api('host/storage/setup',{operation:'connect',event})).workspaces;render();
    }
    if(action==='storage-namespace'){await api('host/storage/namespace',{});toast('Checking the app namespace. Refresh readiness after completion.');}
    if(action==='storage-probe'){storage=await api('host/storage/probe',{});render();}
    if(action==='storage-probe-retry'){storage=await api('host/storage/probe',{retry:true});render();}
    if(action==='storage-retry'){await api(`projects/${detail.project.id}/requests/${id}/storage-retry`,{});await openProject(detail.project.id);}
    if (action === 'reload-builder-prompt') { if(screen==='site'){builderGuidance=await api('site/builder-prompt',undefined,undefined,promptWorkshopId);render();}else await admin();toast('Saved builder prompt loaded'); }
    if (action === 'admin') await admin();
    if (action === 'edit') { screen = 'edit'; menu = false; render(); }
    if (action === 'publish') { publication = await api('host/hosted-publication'); screen = 'publish'; menu = false; render(); }
    if(action==='publish-hosted'){const expectedVersion=publication.publication?.version||0,body={expectedVersion};if(publication.canChooseName&&$('#hosted-name')?.value.trim())body.name=$('#hosted-name').value.trim();const published=await api('host/hosted-publication',body);publication=await api('host/hosted-publication');render();toast(`Public Canvas version ${published.version} is live at /p/${published.alias}`);}
    if (action === 'pause') { state = await api('host/settings',{...state.room,paused:!state.room.paused}); await admin(); }
    if (action === 'visibility') { const p = people.projects.find(p => p.id === id); await api(`host/projects/${id}`,{hidden:!p.hidden}); await admin(); }
    if (action === 'admit' || action === 'unban') await memberAction(id,'admitted');
    if (action === 'ban') dialog('<h2>Remove this participant?</h2><p>Their Napplets will be hidden, public consent revoked, and access blocked for this room.</p>' + button('ban-confirm','Remove & ban',id,'danger'));
    if (action === 'ban-confirm') { await memberAction(id,'banned'); $('#dialog').close(); }
    if (action === 'allowance') { const m = people.members.find(m => m.pubkey === id); dialog(`<h2>Build allowance for <span data-profile-name="${esc(m.pubkey)}">${esc(profileName(m))}</span></h2><label for="allowance">Instructions allowed (0–100)</label><input id="allowance" type="number" min="0" max="100" value="${m.allowance}">` + button('allowance-save','Save allowance',id)); }
    if (action === 'allowance-save') { const m = people.members.find(m => m.pubkey === id); await memberAction(id,m.state,Number($('#allowance').value)); $('#dialog').close(); }
    if (action === 'invite') { const invitation = await api('host/invitations',{uses:10,shortCode:true}); dialog(`<h2>Invite to ${esc(state.room.title)}</h2><p>Valid for 24 hours and 10 admissions.</p><img id="invite-qr" class="invite-qr" src="${esc(invitation.qr)}" alt="BYOF Canvas invitation QR code"><div class="invite-code"><span>Canvas Code</span><strong id="invite-code">${esc(invitation.code)}</strong></div><label for="invite-url">Invitation URL</label><div class="field-action"><textarea id="invite-url" rows="2" readonly spellcheck="false">${esc(invitation.url)}</textarea><button type="button" data-a="copy-invite-url" aria-describedby="invite-copy-feedback">Copy invitation URL</button></div><p id="invite-copy-feedback" class="copy-feedback" role="status" aria-live="polite"></p>`,target); }
    if(action==='copy-invite-url'){
      const feedback=$('#invite-copy-feedback');
      try{await navigator.clipboard.writeText($('#invite-url').value);feedback.className='copy-feedback success';feedback.textContent='Invitation URL copied.';toast('Invitation URL copied');}
      catch{feedback.className='copy-feedback error';feedback.textContent='Could not copy the invitation URL. Select the URL and copy it manually.';const field=$('#invite-url');field.focus();field.select();setTimeout(()=>{field.focus();field.select();});}
    }
  } catch (error) { if(screen==='login')$('#login-error').textContent=error.message;else toast(error.message);const feedback=$('#napplet-action-error');if(feedback){feedback.hidden=false;feedback.textContent=error.message;} }
  finally { endBusy(); if ($('#dialog').open && !$('#dialog').contains(document.activeElement)) $('#dialog').querySelector('input,button')?.focus(); if (activeViewer) activeViewer.querySelector('[data-viewer="close"]').focus(); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; startBusy();
  try {
    if(event.target.id==='request-engine-correction-form'){const id=event.target.dataset.id;await api(`host/projects/${detail.project.id}/requests/${id}/builder-engine`,{reason:$('#engine-correction-reason').value,expectedRequestRevision:Number($('#engine-correction-request-revision').value),expectedCanvasRevision:Number($('#engine-correction-canvas-revision').value)});$('#dialog').close();await openProject(detail.project.id);toast('Saved request now uses the current Canvas builder');}
    if (event.target.id === 'rename-form') {
      const id = event.target.dataset.id;
      const result = await api(`projects/${id}/rename`, {title: $('#napplet-title').value});
      for (const p of [...state.projects, ...(state.board?.napplets||[])]) if (p.id === id) p.title = result.project.title;
      if (detail?.project.id === id) detail.project.title = result.project.title;
      $('#dialog').close();
      if (screen === 'page') render();
      else {
        $('[data-project-title]').textContent = result.project.title;
        const viewer = $('.inline-viewer'); viewer.setAttribute('aria-label', result.project.title);
        viewer.querySelector('h2').textContent = result.project.title;
        viewer.querySelector('iframe').title = result.project.title + ' preview';
      }
      toast('Napplet name saved');
    }
    if (event.target.id === 'instruction-form') {
      if(imageUploadsBlockSend(currentImageUploads()))throw Error('Wait for pasted images to finish, or remove failed uploads.');
      saveDraft(); const saved = draft();
      const submission = {prompt:saved.prompt,attachments:submittedImageAttachments(currentImageUploads()),...(saved.mode ? {mode:saved.mode}:{}),requestId:saved.requestId || crypto.randomUUID(),expectedRevisionId:saved.expectedRevisionId || detail.project.current_revision};
      sessionStorage.setItem(draftKey(detail.project.id),JSON.stringify(submission));
      const result = await api(`projects/${detail.project.id}/requests`,submission);
      sessionStorage.removeItem(draftKey(detail.project.id));
      chatImageUploads.delete(detail.project.id);
      detail = await api('projects/' + detail.project.id); refreshConversation($('.conversation-pane'),true);
      toast(result.generationAvailable ? 'Request sent to your project conversation' : 'Request saved; awaiting activation for this project');
    }
    if (event.target.id === 'host-request-form') { await api(`host/projects/${detail.project.id}/requests`,{requestId:crypto.randomUUID(),prompt:$('#host-prompt').value,operatorReason:$('#host-reason').value,expectedRevisionId:detail.project.current_revision}); await openProject(detail.project.id); toast('Audited host follow-up saved'); }
    if(event.target.id==='tower-create-form')await createConnectedWorkspace();
    if(event.target.id==='storage-create-form'){
      const name=$('#storage-workspace-name').value.trim();if(!workspaceCreateIntent||workspaceCreateIntent.name!==name)workspaceCreateIntent={name,key:crypto.randomUUID()};
      const payload=JSON.stringify({workspace_name:name,idempotency_key:workspaceCreateIntent.key,terms_version:'hosted-usd-v1'});
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const event=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:crypto.randomUUID(),tags:[['u',storage.towerOrigin+'/api/v4/flightdeck-pg/hosted/workspaces'],['method','POST'],['payload',hash]]});
      await api('host/storage/setup',{operation:'create',workspaceName:name,idempotencyKey:workspaceCreateIntent.key,event});workspaceCreateIntent=null;toast('Workspace created. Connect again to select and bind it.');
    }
    if(event.target.id==='storage-setup-form'){
      const workspaceId=$('#storage-workspace').value,workspace=towerWorkspaces.find(w=>w.identity.workspace_id===workspaceId);
      const payload=JSON.stringify({invitee_npub:storage.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'});
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const event=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',`${storage.towerOrigin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`],['method','POST'],['payload',hash]],content:''});
      storage=await api('host/storage/setup',{operation:'bind',workspaceId,localRoot:storage.localRoot,event});render();toast('Workspace bound. Check storage readiness after the probe completes.');
    }
    if(event.target.id==='builder-engine-form'){builderGuidance=await api(screen==='site'?'site/builder-engine':'host/builder-engine',{agent:$('#builder-engine').value,expectedRevision:builderGuidance.builderEngine.revision},undefined,screen==='site'?promptWorkshopId:selectedWorkshop);render();toast('Builder engine saved for new messages');}
    if (event.target.id === 'builder-prompt-form') { builderGuidance = await api(screen==='site'?'site/builder-prompt':'host/builder-prompt',{agentName:$('#agent-name').value,text:$('#builder-prompt').value,expectedRevision:builderGuidance.prompt.revision},undefined,screen==='site'?promptWorkshopId:selectedWorkshop); render(); toast('System prompt saved for new messages'); }
    if(event.target.id==='code-join-form'){const code=rememberJoinCode($('#workshop-code').value);if(me)await redeemJoinCode(code);else{signUp=true;screen='login';render();}}
    if(event.target.id==='canvas-delete-form'){
      const id=event.target.dataset.id,title=event.target.dataset.title;
      await api(`workshops/${id}`,{confirmText:$('#canvas-delete-confirm').value,confirmPermanent:true},'DELETE',id);
      if(canvasDraft().workshopId===id)sessionStorage.removeItem(canvasDraftKey());
      nappletHost.revoke();clearTimeout(reconnectTimer);socket?.close();socket=null;selectedWorkshop='';state=null;detail=null;people=null;publication=null;storage=null;towerWorkspaces=[];managementWorkshop=null;if(promptWorkshopId===id)promptWorkshopId=null;
      workshops=workshops.filter(w=>w.id!==id);cacheWorkshops(workshops);$('#dialog').close();await workshopsPage();toast(`${title} was deleted from Freedom Tools. External datasets and published artifacts were left unchanged.`);
    }
    if(event.target.id==='napplet-delete-form'){
      const id=event.target.dataset.id,title=event.target.dataset.title,expectedRevisionId=event.target.dataset.revision;
      await api(`projects/${id}`,{confirmTitle:$('#napplet-delete-confirm').value,confirmPermanent:true,expectedRevisionId},'DELETE');
      $('#dialog').close();await page();toast(`${title} was deleted from Freedom Tools. This action did not delete external publication artifacts or change the native lifecycle.`);
    }
    if(event.target.id==='join-form'){await api('workshops/join',{invitation:$('#join-invitation').value});$('#dialog').close();await page();connect();}
    if(event.target.id==='profile-form'){profile=await profiles.saveLocal(me.pubkey,{name:$('#profile-name').value,picture:$('#profile-picture').value,about:$('#profile-about').value});if(me.identity_type==='temporary'){await api('profile',{name:profile.name,picture:profile.picture,about:profile.about});me.name=profile.name;}render();toast('Profile saved on this device');}
    if(event.target.id==='tower-form'){await api('site/towers',{label:$('#tower-label').value,origin:$('#tower-origin').value});await siteAdmin();toast('Tower registered; not yet authorized');}
    if(event.target.id==='canvas-tower-form'){saveCanvasDraft();towers=(await api('site/towers',{label:$('#canvas-tower-label').value,origin:$('#canvas-tower-origin').value})).towers;canvasSetup.error='';renderCanvasSetup();}
    if(event.target.id==='workshop-form'){
      const title=$('#workshop-title').value.trim(),introduction=$('#workshop-intro').value.trim(),owner=$('#workshop-owner').value;
      if(!title){canvasSetup.error='Enter a Canvas title to continue.';canvasSetup.focus='#workshop-title';renderCanvasSetup();return;}
      if(!introduction){canvasSetup.error='Enter an introduction to continue.';canvasSetup.focus='#workshop-intro';renderCanvasSetup();return;}
      saveCanvasDraft({title,introduction,owner});canvasSetup.error='';canvasSetup.step=2;renderCanvasSetup();
    }
    if (event.target.id === 'settings-form') { state = await api('host/settings',{pictures:$('#pictures').value.split('\n').map(v=>v.trim()).filter(Boolean),title:$('#title').value,introduction:$('#intro').value,lightning:$('#address').value,support_label:$('#support-label').value.trim(),admission:$('#admission').value,paused:!!state.room.paused}); await page(); toast('BYOF Canvas settings saved'); }
  } catch (error) { toast(error.message);const feedback=event.target.id==='rename-form'?$('#rename-error'):event.target.id==='canvas-delete-form'?$('#canvas-delete-error'):event.target.id==='napplet-delete-form'?$('#napplet-delete-error'):null;if(feedback){feedback.hidden=false;feedback.textContent=error.message;(event.target.id==='rename-form'?$('#napplet-title'):event.target.id==='canvas-delete-form'?$('#canvas-delete-confirm'):$('#napplet-delete-confirm'))?.focus();} } finally { endBusy(); }
});
document.addEventListener('change', async event => {
  if(event.target.name==='canvas-workspace'){const workspace=towerWorkspaces.find(item=>item.identity?.workspace_id===event.target.value);saveCanvasDraft({workspaceId:event.target.value,workspaceLabel:workspace?.label||'Workspace'});canvasSetup.error='';renderCanvasSetup();return;}
  if(event.target.id==='workshop-tower'&&canvasSetup){saveCanvasDraft({towerId:event.target.value,workspaceId:'',workspaceLabel:''});activeTowerId=event.target.value;canvasSetup.connectionStatus='idle';canvasSetup.error='';towerWorkspaces=[];renderCanvasSetup();return;}
  if(event.target.id==='prompt-workshop'){try{promptWorkshopId=event.target.value;builderGuidance=await api('site/builder-prompt',undefined,undefined,promptWorkshopId);render();}catch(error){toast(error.message);}return;}
  if(event.target.id==='site-workshop'){selectedWorkshop=event.target.value;towerWorkspaces=[];state=await api('room');setMember(state.member);await siteAdmin();return;}
  if(event.target.matches('[data-hosted-project]')){try{publication=await api(`host/hosted-publication/projects/${event.target.dataset.hostedProject}`,{included:event.target.checked});render();toast(event.target.checked?'Napplet included in the current public Canvas':'Napplet removed from the current public Canvas');}catch(error){toast(error.message);publication=await api('host/hosted-publication');render();}return;}
  if (event.target.id !== 'public-consent') return;
  try { detail = await api(`projects/${detail.project.id}/consent`,{revisionId:event.target.dataset.revisionId,granted:event.target.checked}); render(); toast('Exact-version public consent saved'); } catch (error) { toast(error.message); render(); }
});
try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu){menu=false;render();$('.avatar')?.focus();}});
document.addEventListener('click',e=>{if(menu&&!e.composedPath().includes($('#identity'))){menu=false;render();}});
document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement){const avatar=e.target.closest('.avatar');if(avatar)avatar.textContent=me?initials(profileName(me)):'WP';else e.target.hidden=true;}},true);

document.addEventListener('input',event=>{if(event.target.id==='workshop-code'&&screen==='start')rememberJoinCode(event.target.value);if(event.target.closest('#profile-form'))$('#profile-form').dataset.dirty='true';if(event.target.id==='canvas-delete-confirm'){const submit=$('#canvas-delete-submit');submit.disabled=event.target.value!=='CONFIRM';$('#canvas-delete-error').hidden=true;}if(event.target.id==='napplet-delete-confirm'){const submit=$('#napplet-delete-submit'),form=event.target.form;submit.disabled=event.target.value!==form.dataset.title;$('#napplet-delete-error').hidden=true;}});
document.addEventListener('focus',event=>{if(event.target.id==='workshop-code'&&event.target.value.length===event.target.maxLength)event.target.select();},true);

$('#dialog').addEventListener('cancel',()=>{towerSetupEpoch++;});
