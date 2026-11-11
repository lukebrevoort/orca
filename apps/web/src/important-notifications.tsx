import { useEffect, useRef, useState } from 'react';
import { authSessionSchema, mailAccountPageSchema, importantNotificationCommandSchema, importantNotificationInstallationSchema, importantNotificationOperationSchema, importantNotificationClaimResponseSchema, type ImportantNotificationCommand, type ImportantNotificationInstallation, type MailAccount, type NotificationPermission } from '@orca/shared';
import { TopLayer } from './top-layer';
import { importanceChanged } from './importance';
import './important-notifications.css';

type State = { owner:string|null; installationId:string|null; accounts:MailAccount[]; current:ImportantNotificationInstallation|null; status:'loading'|'ready'|'unavailable'; error:string|null; notice:string; checking:boolean };
const initial:State={owner:null,installationId:null,accounts:[],current:null,status:'loading',error:null,notice:'',checking:false};
class NotificationOwnerChanged extends Error {}
class NotificationRequestError extends Error { constructor(readonly status:number,message:string){super(message);} }
async function request<T>(path:string,schema:{parse(value:unknown):T},signal?:AbortSignal,method='GET',body?:unknown):Promise<T>{
 const response=await fetch(path,{credentials:'include',signal,method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await response.json().catch(()=>null);
 if(response.status===401)window.dispatchEvent(new Event('orca:session-expired'));
 if(!response.ok)throw new NotificationRequestError(response.status,value?.error?.message??'Notification service unavailable. Existing choices were not changed.');
 return schema.parse(value);
}
export function browserNotificationPermission():NotificationPermission {
 return typeof Notification!=='function'||!window.isSecureContext?'unavailable':Notification.permission;
}
function isCurrentInstallation(owner:string|null,id:string|null){try{return Boolean(owner&&id)&&window.localStorage.getItem(`orca:important-notifications:v1:${owner}`)===id;}catch{return false;}}
function installationFor(owner:string){
 const key=`orca:important-notifications:v1:${owner}`;
 const saved=window.localStorage.getItem(key);
 if(saved&&/^[A-Za-z0-9._:-]{1,128}$/.test(saved))return saved;
 const id=crypto.randomUUID();window.localStorage.setItem(key,id);
 if(window.localStorage.getItem(key)!==id)throw new Error('This browser cannot retain its notification installation. Notifications are unavailable.');
 return id;
}
const anyJson={parse:(value:unknown)=>value};

/** One runtime per mounted application route. Nothing prompts for permission or
 * writes a policy on startup. Server claims independently enforce eligibility. */
export function useImportantNotifications(enabled=true){
 const [state,setState]=useState<State>(initial);
 const latest=useRef(state);latest.current=state;
 const lifetime=useRef(0),mounted=useRef(false),active=useRef<AbortController|null>(null),saving=useRef(false);
 const constructed=useRef(new Map<string,Notification>());
 const wake=useRef<()=>void>(()=>{});
 function stop(){++lifetime.current;active.current?.abort();active.current=null;for(const notification of constructed.current.values())notification.close();constructed.current.clear();}
 useEffect(()=>{
  mounted.current=true;
  if(!enabled){setState({...initial,status:'unavailable'});return()=>{mounted.current=false;stop();};}
  const controller=new AbortController(),generation=++lifetime.current;
  setState(initial);
  void (async()=>{
   const session=await request('/v1/auth/session',authSessionSchema,controller.signal);
   if(!session.isAuthenticated||!session.user)throw new Error('Sign in before managing notifications.');
   const owner=session.user.id,id=installationFor(owner);
   const [accounts,current]=await Promise.all([request('/v1/accounts',mailAccountPageSchema,controller.signal),request(`/v1/notifications/installations/${id}?channel=open_app`,importantNotificationInstallationSchema,controller.signal)]);
   if(controller.signal.aborted||generation!==lifetime.current)return;
   if(current.installationId!==id||current.channel!=='open_app')throw new Error('Notification status belongs to another installation.');
   setState({...initial,owner,installationId:id,accounts:accounts.items,current,status:'ready'});
  })().catch(error=>{if(!controller.signal.aborted&&generation===lifetime.current)setState({...initial,status:'unavailable',error:error.message});});
  const invalidate=()=>{stop();if(mounted.current)setState(current=>({...current,checking:false}));};
  const expired=()=>{stop();if(mounted.current)setState({...initial,status:'unavailable',error:'Session changed. Reload before managing notifications.'});};
  const storage=(event:StorageEvent)=>{if(event.key?.startsWith('orca:important-notifications:v1:'))expired();};
  const refresh=()=>{if(document.visibilityState==='visible')wake.current();else invalidate();};
  window.addEventListener('pagehide',invalidate);window.addEventListener('orca:session-expired',expired);window.addEventListener('storage',storage);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{mounted.current=false;controller.abort();stop();window.removeEventListener('pagehide',invalidate);window.removeEventListener('orca:session-expired',expired);window.removeEventListener('storage',storage);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[enabled]);
 async function readCurrent(snapshot:State,signal?:AbortSignal){
  if(!snapshot.installationId||!snapshot.owner)throw new Error('Notification owner is unavailable.');
  const session=await request('/v1/auth/session',authSessionSchema,signal);
  if(!session.isAuthenticated||session.user?.id!==snapshot.owner)throw new NotificationOwnerChanged('Notification ownership changed. Reload your current account.');
  const current=await request(`/v1/notifications/installations/${snapshot.installationId}?channel=open_app`,importantNotificationInstallationSchema,signal);
  if(current.installationId!==snapshot.installationId||current.channel!=='open_app')throw new NotificationOwnerChanged('Notification ownership changed. Reload your current account.');
  return current;
 }
 async function check(){
  const snapshot=latest.current;
  if(!enabled||saving.current||active.current||snapshot.status!=='ready'||!snapshot.owner||!snapshot.installationId||document.visibilityState!=='visible')return;
  const controller=new AbortController(),generation=lifetime.current;active.current=controller;
  const owns=()=>mounted.current&&!controller.signal.aborted&&generation===lifetime.current&&latest.current.owner===snapshot.owner&&latest.current.installationId===snapshot.installationId&&isCurrentInstallation(snapshot.owner,snapshot.installationId);
  setState(current=>({...current,checking:true}));
  try{
   const current=await readCurrent(snapshot,controller.signal);if(!owns())return;
   setState(value=>({...value,current,error:null}));
   if(!current.policy?.enabled||!current.delivery.available||browserNotificationPermission()!=='granted')return;
   const command={channel:'open_app',expectedRevision:current.revision,operationId:crypto.randomUUID(),permission:'granted'};
   const path=`/v1/notifications/installations/${snapshot.installationId}/claim`;
   const claim=()=>request(path,importantNotificationClaimResponseSchema,controller.signal,'POST',command);
   let response;
   try{response=await claim();}catch(error){if(error instanceof NotificationRequestError&&error.status<500)throw error;if(!owns())return;response=await claim();}
   if(!owns()||response.installationId!==snapshot.installationId||response.operationId!==command.operationId)throw new Error('Notification claim is stale. Check current choices.');
   for(const envelope of response.notifications){
    if(!owns()||browserNotificationPermission()!=='granted'||document.visibilityState!=='visible')break;
    if(constructed.current.has(envelope.id))continue;
    // The SAME claim UUID rechecks current session, revision, read state,
    // importance and freshness immediately before each constructor invocation.
    // An identical settings save can advance revision without changing the
    // server generation. A valid retry returns that CURRENT policy revision.
    const deliveryCurrent=await readCurrent(snapshot,controller.signal);
    const rechecked=await claim();
    if(!owns()||browserNotificationPermission()!=='granted'||document.visibilityState!=='visible'||rechecked.installationId!==snapshot.installationId||rechecked.operationId!==command.operationId||!rechecked.notifications.some(item=>item.id===envelope.id))continue;
    if(!owns()||document.visibilityState!=='visible'||browserNotificationPermission()!=='granted'||deliveryCurrent.revision!==rechecked.policyRevision||!deliveryCurrent.policy?.enabled||!deliveryCurrent.policy.accountIds.includes(envelope.accountId))continue;
    setState(value=>({...value,current:deliveryCurrent}));
    let outcome:'constructed'|'failed'='failed';
    try{
     const notification=new Notification(envelope.title,{body:`${envelope.subtitle}${envelope.subtitle?'\n':''}${envelope.body}`,tag:envelope.tag,data:{accountId:envelope.accountId,threadId:envelope.threadId}});
     constructed.current.set(envelope.id,notification);outcome='constructed';
     notification.onclick=()=>{void readCurrent(snapshot).then(()=>{if(!owns())return;window.focus();window.location.assign(`/?destination=important&thread=${encodeURIComponent(envelope.threadId)}&accountId=${encodeURIComponent(envelope.accountId)}`);}).catch(()=>notification.close());};
     notification.onerror=()=>{if(owns())setState(value=>({...value,notice:'The browser could not display an alert. Your Important-only policy is unchanged.'}));};
    }catch{if(owns())setState(value=>({...value,notice:'Browser notification construction failed. Your policy remains saved; alerts are unavailable here.'}));}
    if(!owns())break;
    const report={operationId:command.operationId,notificationIds:[envelope.id],outcome};
    try{await request(`/v1/notifications/installations/${snapshot.installationId}/report`,anyJson,controller.signal,'POST',report);}
    catch(error){if(owns()&&!(error instanceof NotificationRequestError&&error.status<500))await request(`/v1/notifications/installations/${snapshot.installationId}/report`,anyJson,controller.signal,'POST',report);}
   }
  }catch(error){if(owns()&&error instanceof NotificationRequestError&&[403,404,409].includes(error.status)){try{const current=await readCurrent(snapshot,controller.signal);if(owns())setState(value=>({...value,current}));}catch(ownerError){if(ownerError instanceof NotificationOwnerChanged)error=ownerError;}}if(error instanceof NotificationOwnerChanged){stop();if(mounted.current)setState({...initial,status:'unavailable',error:error.message});}else if(owns())setState(value=>({...value,error:error instanceof Error?error.message:String(error)}));}
  finally{if(active.current===controller)active.current=null;if(owns())setState(value=>({...value,checking:false}));}
 }
 wake.current=()=>void check();
 useEffect(()=>{
  if(!enabled||state.status!=='ready'||!state.current?.policy?.enabled)return;
  const timer=window.setInterval(()=>wake.current(),15_000);
  wake.current();
  const corrected=()=>{active.current?.abort();active.current=null;++lifetime.current;setState(value=>({...value,checking:false}));wake.current();};
  window.addEventListener(importanceChanged,corrected);
  return()=>{window.clearInterval(timer);window.removeEventListener(importanceChanged,corrected);};
 },[enabled,state.status,state.current?.policy?.enabled,state.installationId]);
 async function save(enabledChoice:boolean,accountIds:string[]){
  const snapshot=latest.current;
  if(saving.current||!snapshot.current||!snapshot.installationId||!snapshot.owner)return false;
  saving.current=true;active.current?.abort();active.current=null;++lifetime.current;
  const generation=lifetime.current,owner=snapshot.owner;
  const owns=()=>mounted.current&&lifetime.current===generation&&latest.current.owner===owner;
  setState(value=>({...value,error:null,checking:false}));
  try{
   let permission=browserNotificationPermission();
   // Called directly by the explicit Enable click, before any network await.
   if(enabledChoice&&permission==='default')permission=await Notification.requestPermission();
   if(!owns())return false;
   if(enabledChoice&&permission!=='granted')throw new Error(permission==='denied'?'Browser permission is blocked. Existing notification choices were not changed.':'Notifications are unavailable or permission was not granted. Existing choices were not changed.');
   const command:ImportantNotificationCommand=importantNotificationCommandSchema.parse({channel:'open_app',policyVersion:1,enabled:enabledChoice,accountIds,permission,expectedRevision:snapshot.current.revision,operationId:crypto.randomUUID()});
   const path=`/v1/notifications/installations/${snapshot.installationId}`;
   const decode={parse:(value:unknown)=>{const operation=importantNotificationOperationSchema.parse(value);if(operation.operationId!==command.operationId||operation.current.installationId!==snapshot.installationId||operation.current.channel!=='open_app')throw new Error('Notification receipt belongs to a different operation.');return operation;}};
   let result;
   try{result=await request(path,decode,undefined,'PUT',command);}
   catch(error){
    if(error instanceof NotificationRequestError&&error.status<500)throw error;
    try{result=await request(`/v1/notifications/operations/${command.operationId}`,decode);}
    catch(reconcile){if(reconcile instanceof NotificationRequestError&&reconcile.status===404)result=await request(path,decode,undefined,'PUT',command);else throw new Error('Could not confirm this change. Check current choices before trying again.');}
   }
   if(!owns())return false;
   setState(value=>({...value,current:result.current,error:null,notice:result.status==='superseded'?'A newer notification choice is current. Review it before changing again.':result.current.policy?.enabled?'Important-only choices saved. Browser construction is separate from OS display.':'Important-only alerts paused. Manual reminders are unchanged.'}));
   return result.status==='current';
  }catch(error){if(owns()){setState(value=>({...value,error:error instanceof Error?error.message:String(error)}));try{const current=await readCurrent(snapshot);if(owns())setState(value=>({...value,current}));}catch(ownerError){if(ownerError instanceof NotificationOwnerChanged){stop();if(mounted.current)setState({...initial,status:'unavailable',error:ownerError.message});}/* Otherwise keep ambiguity explicit. */}}return false;}
  finally{saving.current=false;}
 }
 return {state,save,check,permission:typeof window==='undefined'?'unavailable' as const:browserNotificationPermission()};
}

export function ImportantNotificationSettings({client}:{client:ReturnType<typeof useImportantNotifications>}){
 const {state,permission}=client;
 const [open,setOpen]=useState(false),[accounts,setAccounts]=useState<string[]>([]),[enabled,setEnabled]=useState(true),[busy,setBusy]=useState(false);
 const pending=useRef(false);
 function configure(){setAccounts(state.current?.policy?.accountIds??[]);setEnabled(state.current?.policy?.enabled??true);setOpen(true);}
 async function save(){if(pending.current)return;pending.current=true;setBusy(true);try{if(await client.save(enabled,accounts))setOpen(false);}finally{pending.current=false;setBusy(false);}}
 return <section className="important-notification-settings" aria-label="Important-only mail notifications">
  <h3>Important-only mail notifications</h3>
  {state.status==='loading'?<p role="status">Checking this browser’s notification installation…</p>:null}
  {state.status==='unavailable'?<p>Notification delivery is unavailable in this build or session. {state.error} Existing choices were not changed.</p>:null}
  {state.current?<><p>{state.current.policy?.enabled?'Important-only policy enabled for the selected accounts.':state.current.policy?'Important-only alerts are paused.':'Important-only notifications have not been adopted on this browser.'}</p>
   {state.current.previousSelection?<p>Previous notification choices remain until explicit adoption: Inbox {state.current.previousSelection.inbox?'on':'off'}, {state.current.previousSelection.spaceIds.length} spaces. Cancel preserves them.</p>:null}
   <p>Browser permission: {permission}. Server readiness: {state.current.delivery.available?'eligible feed available':state.current.delivery.reason?.replaceAll('_',' ')??'unavailable'}.</p>
   <button disabled={busy} onClick={configure} type="button">{state.current.policy?'Review important-only choices':'Set up important-only notifications'}</button>
   {state.current.policy?.enabled?<button disabled={state.checking||busy} onClick={()=>void client.check()} type="button">{state.checking?'Checking important arrivals…':'Check for important mail now'}</button>:null}
  </>:null}
  <p>Open-tab delivery only. Orca pauses checks while this tab is hidden; background tabs may delay alerts. Closing the tab or browser stops delivery. OS Focus, quiet settings and browser support can suppress alerts; constructing an alert does not confirm it appeared.</p>
  <p>Only fresh unread incoming mail already Important at arrival can interrupt you. Old mail is not replayed. Repeats for the same account/conversation/browser are suppressed for 15 minutes. Manual reminders are separate.</p>
  {state.error?<p role="alert">{state.error}</p>:null}{state.notice?<p role="status">{state.notice}</p>:null}
  {open?<TopLayer ariaLabel="Important-only notification choices" className="importance-dialog" layerClassName="importance-layer" backdropClassName="importance-backdrop" onClose={busy?()=>{}:()=>setOpen(false)} initialFocusSelector="h2">
   <h2 tabIndex={-1}>Choose what can interrupt</h2><p>This browser, for your selected accounts. Cancel leaves the current policy unchanged.</p>
   <label className="notification-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event=>setEnabled(event.target.checked)}/>Enable Important-only alerts</label>
   <fieldset disabled={busy}><legend>Connected accounts</legend>{state.accounts.map(account=><label className="notification-check" key={account.id}><input type="checkbox" checked={accounts.includes(account.id)} onChange={event=>setAccounts(current=>event.target.checked?[...current,account.id]:current.filter(id=>id!==account.id))}/>{account.email}</label>)}</fieldset>
   {accounts.some(id=>!state.accounts.some(account=>account.id===id))?<p role="alert">Some selected accounts are no longer available. Check current account access before saving.</p>:null}
   <p>Enabling requests browser permission only after this explicit action. A new adoption, re-enable or newly selected account starts with fresh arrivals, without replaying old unread mail.</p>
   {state.error?<p role="alert">{state.error}</p>:null}
   <footer><button disabled={busy} onClick={()=>setOpen(false)} type="button">Cancel</button><button disabled={busy||(enabled&&!accounts.length)} onClick={()=>void save()} type="button">{busy?'Saving notification choices…':enabled?'Enable important-only notifications':'Pause important-only notifications'}</button></footer>
  </TopLayer>:null}
 </section>;
}
