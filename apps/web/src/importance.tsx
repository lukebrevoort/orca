import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { importantPageSchema, importanceMutationSchema, importanceOperationSchema, importancePreviewSchema, importanceResolutionSchema, type ImportanceChoice, type ImportanceMutation, type ImportanceOperation, type ImportanceResolution } from '@orca/shared';
import { TopLayer, useTopLayerActive } from './top-layer';
import { decodeMailPreview } from './mail-preview';
import './importance.css';

export const importanceChanged = 'orca:importance-changed';
const label = (value: string | null) => value === 'important' ? 'Important' : value === 'not_important' ? 'Not important' : 'Unreviewed';
export class ImportanceRequestError extends Error { constructor(readonly status:number, message:string) { super(message); } }
export async function requestImportance<T>(path:string, schema:{parse(value:unknown):T}, signal?:AbortSignal, body?:unknown):Promise<T> {
  const response = await fetch(path, {credentials:'include',signal,headers:{'content-type':'application/json','x-orca-importance-version':'1'},...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body)})});
  const value = await response.json().catch(()=>null);
  if (response.status === 401) window.dispatchEvent(new Event('orca:session-expired'));
  if (!response.ok) throw new ImportanceRequestError(response.status,value?.error?.message ?? 'Importance is unavailable. Your mail is still here.');
  return schema.parse(value);
}
const snapshotSchema = {parse(value:unknown) { const v=value as {accountId:string;threadId:string;importance:unknown};return {...v,importance:importanceResolutionSchema.parse(v.importance)}; }};
const keyFor = (accountId:string,threadId:string) => JSON.stringify([accountId,threadId]);
type Command = {path:string;body:ImportanceMutation | {accountId:string;operationId:string;expectedRevision:number}};
type Receipt = {operation:ImportanceOperation;command:Command};
type ImportanceContextValue = {observe:(accountId:string,threadId:string,importance:ImportanceResolution)=>void; changed: (accountId:string,threadId?:string,importance?:ImportanceResolution)=>void; receipt:(value:Receipt)=>void; snapshots:Map<string,ImportanceResolution>;status:{notice:string;busy:boolean;undo:(()=>Promise<void>)|null;dismiss:()=>void}};
const ImportanceContext = createContext<ImportanceContextValue | null>(null);

/** Transient receipts belong to this mounted owner. Nothing persists locally. */
export function ImportanceProvider({children}:{children:ReactNode}) {
  const [snapshots,setSnapshots]=useState(new Map<string,ImportanceResolution>());
  const [receipt,setReceipt]=useState<Receipt|null>(null);
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!receipt)return;const timer=setTimeout(()=>setReceipt(null),Math.max(0,Date.parse(receipt.operation.receipt.undoUntil)-Date.now()));return()=>clearTimeout(timer);},[receipt]);
  function changed(accountId:string,threadId?:string,importance?:ImportanceResolution) {
    if(!alive.current)return;
    setSnapshots(current=>{const next=new Map(current);if(threadId&&importance)next.set(keyFor(accountId,threadId),importance);else for(const key of next.keys())if(JSON.parse(key)[0]===accountId)next.delete(key);return next;});
    window.dispatchEvent(new CustomEvent(importanceChanged,{detail:{accountId,threadId,importance}}));
  }
  async function undo() {
    if(!receipt||pending.current)return;
    pending.current=true;
    const source=receipt.operation.receipt;
    const command:Command={path:`/v1/importance/operations/${encodeURIComponent(source.operationId)}/undo`,body:{accountId:source.accountId,operationId:crypto.randomUUID(),expectedRevision:source.revision}};
    setBusy(true);
    try {
      const result=await performImportance(command);
      if(!alive.current)return;
      changed(source.accountId,source.target.kind==='conversation'?source.target.threadId:undefined,result.importance);
      setReceipt(null);setNotice(result.status==='superseded'?'A newer choice is current. Review it before changing again.':'Previous choice restored. Current sender preferences still apply.');
    }catch(error){if(alive.current){setReceipt(null);setNotice(String(error instanceof Error?error.message:error));}}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  return <ImportanceContext.Provider value={{snapshots,observe:(accountId,threadId,importance)=>setSnapshots(current=>new Map(current).set(keyFor(accountId,threadId),importance)),changed,receipt:value=>{if(alive.current){setReceipt(value);setNotice('Choice saved in Orca. Mail placement and read state are unchanged.');}},status:{notice,busy,undo:receipt&&receipt.operation.status==='current'?undo:null,dismiss:()=>{setReceipt(null);setNotice('');}}}}>{children}
    <ImportanceStatus/>
  </ImportanceContext.Provider>;
}

/** A modal's status belongs INSIDE its active focus/inert boundary. The normal
 * mail status stays visible without scrolling or moving focus after a write. */
export function ImportanceStatus({inline=false}:{inline?:boolean}) {
  const context=useContext(ImportanceContext);
  const layerActive=useTopLayerActive();
  const status=context?.status;
  if(!status?.notice||(!inline&&layerActive))return null;
  return <aside className={`importance-receipt${inline?' importance-receipt-inline':''}`} aria-live="polite"><span>{status.notice}</span>{status.undo?<button disabled={status.busy} onClick={()=>void status.undo?.()} type="button">{status.busy?'Checking Undo…':'Undo importance change'}</button>:null}<button aria-label="Dismiss importance status" type="button" onClick={status.dismiss}>Dismiss</button></aside>;
}

/** Reconcile ambiguity before allowing a stable-ID retry. Never replay a newer state. */
export async function performImportance(command:Command,signal?:AbortSignal):Promise<ImportanceOperation> {
  const ownedOperation = { parse(value:unknown) {
    const result = importanceOperationSchema.parse(value);
    if (result.receipt.accountId !== command.body.accountId || result.receipt.operationId !== command.body.operationId
      || ('target' in command.body && JSON.stringify(result.receipt.target) !== JSON.stringify(command.body.target))) {
      throw new Error('The response did not match this owned importance operation. Check current state before another choice.');
    }
    return result;
  }};
  try { return await requestImportance(command.path,ownedOperation,signal,command.body); }
  catch(error) {
    if(signal?.aborted)throw error;
    if(error instanceof ImportanceRequestError && error.status<500)throw error;
    try {return await requestImportance(`/v1/importance/operations/${command.body.operationId}?accountId=${encodeURIComponent(command.body.accountId)}`,ownedOperation,signal);}
    catch(reconcile) {
      if(reconcile instanceof ImportanceRequestError&&reconcile.status===404) return requestImportance(command.path,ownedOperation,signal,command.body);
      throw new Error('Could not confirm the change. Reconnect and check current importance before another choice.');
    }
  }
}

export function ImportanceControl({accountId,threadId,address,initial,accountLabel,disabled=false}:{accountId:string;threadId:string;address?:string|null;initial?:ImportanceResolution;accountLabel?:string;disabled?:boolean}) {
  const context=useContext(ImportanceContext);
  const known=context?.snapshots.get(keyFor(accountId,threadId))??initial;
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const lifetime=useRef<AbortController|null>(null);
  const pending=useRef(false);
  useEffect(()=>{const c=new AbortController();lifetime.current=c;pending.current=false;setBusy(false);setError(null);setOpen(false);return()=>c.abort();},[accountId,threadId]);
  useEffect(()=>setError(null),[known?.conversation.revision]);
  async function choose(choice:ImportanceChoice) {
    if(!known||pending.current||!context)return;
    pending.current=true;setBusy(true);setError(null);
    const command={path:'/v1/importance/choices',body:importanceMutationSchema.parse({accountId,target:{kind:'conversation',threadId},choice,expectedRevision:known.conversation.revision,operationId:crypto.randomUUID()})};
    try {const result=await performImportance(command,lifetime.current?.signal);if(lifetime.current?.signal.aborted)return;context.changed(accountId,threadId,result.importance);if(result.status==='current')context.receipt({operation:result,command});else setError('A newer choice is current. Review importance before another change.');}
    catch(e){if(!lifetime.current?.signal.aborted)setError(e instanceof Error?e.message:String(e));}
    finally{pending.current=false;if(!lifetime.current?.signal.aborted)setBusy(false);}
  }
  return <><div className="importance-control" aria-label="Conversation importance" aria-busy={busy}>
    <span title={accountLabel}>{known?label(known.effective):'Importance unavailable'} · this conversation{accountLabel?` · ${accountLabel}`:''}</span>
    {known&&context?<div className="importance-direct" role="group" aria-label="Choose for this conversation only">{(['important','not_important'] as const).map(choice=><button aria-pressed={known.conversation.choice===choice} disabled={disabled||busy||Boolean(error)} key={choice} onClick={()=>void choose(choice)} type="button" title="This conversation only, in this account. Does not mark read or move mail.">{label(choice)}</button>)}</div>:null}
    <button aria-haspopup="dialog" disabled={disabled||busy} onClick={()=>setOpen(true)} type="button" aria-label={`Review importance of ${threadId}`}>{known?'More':'Review importance'}</button>
    {busy?<span role="status">Saving choice…</span>:null}{error?<span role="alert">{error}</span>:null}
  </div>{open?<ImportanceDialog key={keyFor(accountId,threadId)} accountId={accountId} threadId={threadId} address={address} accountLabel={accountLabel} onClose={()=>setOpen(false)}/>:null}</>;

}

function ImportanceDialog({accountId,threadId,address,accountLabel,onClose}:{accountId:string;threadId:string;address?:string|null;accountLabel?:string;onClose:()=>void}) {
  const context=useContext(ImportanceContext);
  const [current,setCurrent]=useState<ImportanceResolution|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [sender,setSender]=useState(false);
  const [senderAddress,setSenderAddress]=useState(address??'');
  const [senderChoice,setSenderChoice]=useState<ImportanceChoice|null>('important');
  const [preview,setPreview]=useState<ReturnType<typeof importancePreviewSchema.parse>|null>(null);
  const controller=useRef<AbortController|null>(null);
  const pending=useRef(false);
  useEffect(()=>{const c=new AbortController();controller.current=c;setCurrent(null);setError(null);requestImportance(`/v1/importance/conversations/${encodeURIComponent(threadId)}?accountId=${encodeURIComponent(accountId)}`,snapshotSchema,c.signal).then(value=>{if(value.accountId!==accountId||value.threadId!==threadId)throw new Error('Importance response belongs to a different conversation.');if(!c.signal.aborted){setCurrent(value.importance);context?.observe(accountId,threadId,value.importance);}}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[accountId,threadId,refresh]);
  async function choose(choice:ImportanceChoice|null,broader=false) {
    if(!current||pending.current)return;
    if(broader&&(!preview||Date.parse(preview.expiresAt)<=Date.now())) {setPreview(null);setError('This preview expired. Preview again before saving.');return;}
    pending.current=true;setBusy(true);setError(null);
    const body=importanceMutationSchema.parse({accountId,target:broader?{kind:'sender',address:preview!.address}:{kind:'conversation',threadId},choice,expectedRevision:broader?preview!.current.revision:current.conversation.revision,operationId:crypto.randomUUID(),...(broader?{confirmation:preview!.confirmation}:{})});
    const command={path:'/v1/importance/choices',body};
    try{
      const result=await performImportance(command,controller.current?.signal);
      if(controller.current?.signal.aborted)return;
      context?.changed(accountId,broader?undefined:threadId,result.importance);
      if(result.status==='current'){context?.receipt({operation:result,command});onClose();}
      else {setError('A newer choice is current. Review the current state before changing it.');setRefresh(n=>n+1);}
    }catch(e){if(!controller.current?.signal.aborted){setError(e instanceof Error?e.message:String(e));setPreview(null);}}
    finally{pending.current=false;if(!controller.current?.signal.aborted)setBusy(false);}
  }
  async function reviewSender() {
    if(pending.current)return;pending.current=true;setBusy(true);setError(null);setPreview(null);
    try{const value=await requestImportance('/v1/importance/preview',importancePreviewSchema,controller.current?.signal,{accountId,address:senderAddress,choice:senderChoice});if(value.accountId!==accountId||value.address!==senderAddress.trim().toLowerCase()||value.choice!==senderChoice)throw new Error('Sender preview no longer matches this account and choice.');if(!controller.current?.signal.aborted)setPreview(value);}
    catch(e){if(!controller.current?.signal.aborted)setError(e instanceof Error?e.message:String(e));}
    finally{pending.current=false;if(!controller.current?.signal.aborted)setBusy(false);}
  }
  return <TopLayer ariaLabel="Conversation importance" className="importance-dialog" layerClassName="importance-layer" backdropClassName="importance-backdrop" onClose={busy?()=>{}:onClose} initialFocusSelector="h2" surfaceProps={{'aria-busy':busy}}>
    <header><div><p>{accountLabel??'This connected account'}</p><h2 tabIndex={-1}>What deserves attention?</h2></div><button disabled={busy} onClick={onClose} type="button">Close</button></header>
    <p>Choose for this conversation, including later replies. This does not move mail, mark it read, or create a sender preference.</p>
    {!current&&!error?<p role="status">Loading current importance…</p>:null}
    {error?<p role="alert">{error} <button disabled={busy} onClick={()=>setRefresh(n=>n+1)} type="button">Check current choice</button></p>:null}
    {current?<><p>Currently <strong>{label(current.effective)}</strong> · {current.source==='conversation'?'Your conversation choice':current.source==='participants'?'Current inbound sender preferences':'No explicit choice'}</p>
      <div className="importance-choices">{(['important','not_important'] as const).map(choice=><button aria-pressed={current.conversation.choice===choice} disabled={busy} key={choice} onClick={()=>void choose(choice)} type="button">{label(choice)}</button>)}</div>
      <details><summary>Inheritance and sender choices</summary><p>Without a conversation choice: <strong>{label(current.inherited)}</strong>. Any Important inbound participant makes this Important; otherwise an unreviewed participant keeps it Unreviewed. Reset uses the latest preferences at save time, so this result may change.</p>
        <p>{current.participantCounts.total} distinct inbound participants: {current.participantCounts.important} Important, {current.participantCounts.notImportant} Not important, {current.participantCounts.unreviewed} Unreviewed.</p>
        {current.preferences.length?<ul>{current.preferences.map(p=><li key={p.address}>{p.address}: {label(p.choice)}</li>)}</ul>:null}{current.preferencesTruncated?<p>Showing up to 20 explicit preferences; participant counts cover everyone.</p>:null}
        <button disabled={busy||current.conversation.choice===null} onClick={()=>void choose(null)} type="button">Use current sender preferences ({label(current.inherited)})</button>
        <button disabled={busy} onClick={()=>setSender(v=>!v)} type="button" aria-expanded={sender}>Choose for an exact sender…</button>
        {sender?<section className="importance-sender-review"><h3>Existing and future conversations</h3><label>Exact inbound address<input type="email" value={senderAddress} onChange={e=>{setSenderAddress(e.target.value);setPreview(null);}}/></label><label>Sender preference<select value={senderChoice??'inherit'} onChange={e=>{setSenderChoice(e.target.value==='inherit'?null:e.target.value as ImportanceChoice);setPreview(null);}}><option value="important">Important</option><option value="not_important">Not important</option><option value="inherit">Remove sender preference</option></select></label><button disabled={busy||!senderAddress} onClick={()=>void reviewSender()} type="button">Preview sender choice</button>
          {preview?<><p>In this account, {preview.existing.matching} existing conversations match {preview.address}. {preview.existing.changed} would change; {preview.existing.overridden} keep their explicit choices; {preview.existing.keptImportantByOtherParticipants} stay Important because of other participants.</p><p>After: {preview.existing.after.important} Important, {preview.existing.after.not_important} Not important, {preview.existing.after.unreviewed} Unreviewed. Future mail uses this exact address only, in this account. Other Important participants may keep it Important. No domain or alias expansion.</p><button disabled={busy} onClick={()=>void choose(preview.choice,true)} type="button">Confirm exact-sender choice</button><button disabled={busy} onClick={()=>setPreview(null)} type="button">Cancel sender choice</button></>:null}
        </section>:null}
      </details></>:null}
      {busy?<p role="status">Checking and saving the owned choice…</p>:null}
  </TopLayer>;
}

type Page=ReturnType<typeof importantPageSchema.parse>;
export function ImportantMail({accountId:ownerAccountId,accounts=[],accountLabel,onOpen,onAllMail,disabled=false}:{accountId:string|null;accounts?:readonly {id:string;email:string}[];accountLabel?:string;onOpen:(target:{accountId:string;threadId:string})=>void;onAllMail:()=>void;disabled?:boolean}) {
  const [selectedAccount,setSelectedAccount]=useState<string|null>(()=>typeof window==='undefined'?null:new URLSearchParams(window.location.search).get('importanceAccountId'));
  const requestedAccount=selectedAccount??ownerAccountId;
  const accountId=requestedAccount===ownerAccountId||accounts.some(account=>account.id===requestedAccount)?requestedAccount:null;
  const selectedLabel=accounts.find(account=>account.id===accountId)?.email??accountLabel;
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const owner=useRef(0),root=useRef<HTMLElement>(null);
  useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail.accountId===accountId)setRefresh(n=>n+1);};const focus=()=>{if(document.visibilityState==='visible')setRefresh(n=>n+1);};window.addEventListener(importanceChanged,changed);window.addEventListener('focus',focus);return()=>{window.removeEventListener(importanceChanged,changed);window.removeEventListener('focus',focus);};},[accountId]);
  useEffect(()=>{const generation=++owner.current,c=new AbortController();setError(null);if(!accountId||disabled){setPage(null);return;}setBusy(true);
    requestImportance(`/v1/important?accountId=${encodeURIComponent(accountId)}&limit=50`,importantPageSchema,c.signal).then(value=>{if(value.accountId!==accountId)throw new Error('Important page belongs to a different account.');if(!c.signal.aborted&&generation===owner.current){const focused=document.activeElement;
        const rows=[...root.current?.querySelectorAll('li')??[]];
        const index=rows.findIndex(row=>focused instanceof Node&&row.contains(focused));
        setPage(value);
        if(index>=0) requestAnimationFrame(()=>{if(focused instanceof HTMLElement&&!focused.isConnected){const next=root.current?.querySelectorAll<HTMLButtonElement>('.important-row')[Math.min(index,value.items.length-1)];(next??document.querySelector<HTMLButtonElement>('.mail-scope-switch button:last-child'))?.focus({preventScroll:true});}});}}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setBusy(false);});return()=>c.abort();},[accountId,refresh,disabled]);
  async function more(){if(!page?.nextCursor||busy)return;const generation=owner.current;setBusy(true);try{const next=await requestImportance(`/v1/important?accountId=${encodeURIComponent(page.accountId)}&limit=50&cursor=${encodeURIComponent(page.nextCursor)}`,importantPageSchema);if(next.accountId!==accountId)throw new Error('Important page belongs to a different account.');if(generation===owner.current)setPage(current=>current?{...next,items:[...new Map([...current.items,...next.items].map(item=>[item.threadId,item])).values()]}:next);}catch(e){if(generation===owner.current){if(e instanceof ImportanceRequestError&&e.status===400){setRefresh(n=>n+1);setError('Mail changed during pagination. Refreshing Important from the first page.');}else setError(e instanceof Error?e.message:String(e));}}finally{if(generation===owner.current)setBusy(false);}}
  return <section className="important-mail" ref={root} aria-labelledby="important-title" aria-busy={busy}><header><p>{selectedLabel??'Your mail'}</p><h1 id="important-title">Important</h1><p>Conversations you chose to give attention. All retained mail stays available.</p></header>
    {accounts.length>1?<label className="important-account">Connected account<select aria-label="Important mail account" value={requestedAccount??''} onChange={event=>{const value=event.target.value;setSelectedAccount(value);const url=new URL(window.location.href);url.searchParams.set('importanceAccountId',value);window.history.replaceState(window.history.state,'',url);}}>{!accountId?<option value={requestedAccount??''}>Account unavailable</option>:null}{accounts.map(account=><option key={account.id} value={account.id}>{account.email}</option>)}</select></label>:null}
    {!accountId&&!disabled?<p role="status">This account is unavailable. Choose a connected account or open All Mail.</p>:null}
    {disabled?<p role="status">Importance is unavailable in this synthetic preview. Use All Mail to explore the retained reader and writing flows.</p>:null}
    {busy?<p className="visually-hidden" role="status">Refreshing current importance…</p>:null}{busy&&!page?<p role="status">Loading important conversations…</p>:null}
    {error?<p role="alert">Importance could not load. {error} <button onClick={()=>setRefresh(n=>n+1)} type="button">Retry Important</button></p>:null}
    {page?.accountId===accountId&&!page.items.length?<div className="mail-empty"><h2>No important conversations yet</h2><p>Review All Mail and choose Important on a conversation. Unreviewed and Not important mail remains there.</p><button type="button" onClick={onAllMail}>Review All Mail</button></div>:null}
    {page?.accountId===accountId?<><p className="mail-count">{page.items.length} shown{page.nextCursor?' · more available':''}</p><ol className="important-list">{page.items.map(item=><li key={keyFor(item.accountId,item.threadId)}><button type="button" className="important-row" onClick={()=>onOpen(item)}><strong>{item.from??'Unknown sender'}</strong><span>{item.subject||'(No subject)'}</span><p>{decodeMailPreview(item.snippet)}</p><small>{new Date(item.receivedAt).toLocaleDateString()}{item.unread?' · Unread':''}</small></button><ImportanceControl accountId={item.accountId} threadId={item.threadId} address={item.from} initial={item.importance} accountLabel={selectedLabel}/></li>)}</ol>{page.nextCursor?<button disabled={busy} onClick={()=>void more()} type="button">{busy?'Loading…':'Load more important mail'}</button>:null}</>:null}
  </section>;
}
