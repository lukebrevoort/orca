import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth, type AuthVariables } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, oauthAccounts } from "../../db/schema.ts";
import { imageSourceRevision, renderRequestedImages, type ImageDownload } from "./render.ts";

type Options={dbFactory?:typeof createDatabaseClient;downloadImage?:ImageDownload;allowedOrigin?:string};
export function registerMessageImageRoutes(app:Hono<{Variables:AuthVariables}>,options:Options={}){
 const dbFactory=options.dbFactory??createDatabaseClient;
 const active=new Set<string>();
 // Preserve the shipped bearer-only contract for older native clients. This
 // legacy path cannot bind a request to the source revision shown to the user.
 app.post("/v1/messages/:id/images",requireAuth({dbFactory}),async c=>{
  c.header("Cache-Control","private, no-store");c.header("X-Content-Type-Options","nosniff");
  if(!/^Bearer [A-Za-z0-9_-]+$/i.test(c.req.header("authorization")??""))return c.json({error:{code:"image_consent_required",message:"Load images from the app."}},403);
  const accountId=c.req.query("accountId");if(!accountId)return c.json({error:{code:"validation_error",message:"An accountId is required"}},400);
  const {db,sqlite}=dbFactory();let html:string|null=null;
  try{
   const row=db.select({html:emails.bodyHtml}).from(emails).innerJoin(oauthAccounts,eq(oauthAccounts.id,emails.accountId)).where(and(eq(emails.id,c.req.param("id")),eq(emails.accountId,accountId),eq(oauthAccounts.userId,c.get("auth").userId))).get();
   if(!row)return c.json({error:{code:"not_found",message:"Message not found"}},404);
   html=row.html;
  }finally{sqlite.close();}
  const key=JSON.stringify([accountId,c.req.param("id")]);
  if(active.has(key)||active.size>=4)return c.json({error:{code:"image_busy",message:"Image loading is already in progress. Try again shortly."}},429);
  active.add(key);
  try{
   const result=await renderRequestedImages(html,options.downloadImage,c.req.raw.signal,[],[],undefined,"legacy");
   return c.json({bodyHtml:result.bodyHtml,sourceHash:result.sourceHash,loaded:result.loaded,blocked:result.blocked});
  }finally{active.delete(key);}
 });
 app.post("/v1/messages/:id/images/v2",requireAuth({dbFactory}),bodyLimit({maxSize:4096}),async c=>{
  c.header("Cache-Control","private, no-store");c.header("X-Content-Type-Options","nosniff");
  // Cookies require an exact configured Origin and a non-simple JSON request.
  const bearer=/^Bearer [A-Za-z0-9_-]+$/i.test(c.req.header("authorization")??"");
  if(!bearer && (!options.allowedOrigin || c.req.header("origin")!==options.allowedOrigin))return c.json({error:{code:"invalid_origin",message:"Load images from Orca."}},403);
  if(c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")return c.json({error:{code:"validation_error",message:"A message revision is required."}},400);
  let payload:unknown;try{payload=await c.req.json();}catch{return c.json({error:{code:"validation_error",message:"A message revision is required."}},400);}
  const revision=(payload && typeof payload==="object" && "revision" in payload) ? (payload as {revision:unknown}).revision : null;
  if(typeof revision!=="string"||!/^[a-f0-9]{64}$/.test(revision))return c.json({error:{code:"validation_error",message:"A message revision is required."}},400);
  const lists=payload as {retained?:unknown;seen?:unknown;remainingBytes?:unknown};
  const validList=(value:unknown):value is number[]=>Array.isArray(value)&&value.length<=200&&value.every(n=>Number.isSafeInteger(n)&&n>=0&&n<10000)&&new Set(value).size===value.length;
  if((lists.retained!==undefined&&!validList(lists.retained))||(lists.seen!==undefined&&!validList(lists.seen)))return c.json({error:{code:"validation_error",message:"Invalid image request."}},400);
  if(lists.remainingBytes!==undefined&&(!Number.isSafeInteger(lists.remainingBytes)||Number(lists.remainingBytes)<0||Number(lists.remainingBytes)>8*1024*1024))return c.json({error:{code:"validation_error",message:"Invalid image request."}},400);
  const accountId=c.req.query("accountId");if(!accountId)return c.json({error:{code:"validation_error",message:"An accountId is required"}},400);
  const {db,sqlite}=dbFactory();let html:string|null=null;
  try{
   const row=db.select({html:emails.bodyHtml}).from(emails).innerJoin(oauthAccounts,eq(oauthAccounts.id,emails.accountId)).where(and(eq(emails.id,c.req.param("id")),eq(emails.accountId,accountId),eq(oauthAccounts.userId,c.get("auth").userId))).get();
   if(!row)return c.json({error:{code:"not_found",message:"Message not found"}},404);
   html=row.html;
  }finally{sqlite.close();}
  if(imageSourceRevision(html)!==revision)return c.json({error:{code:"stale_message",message:"Message changed. Reopen it before loading images."}},409);
  const key=JSON.stringify([accountId,c.req.param("id")]);
  if(active.has(key)||active.size>=4)return c.json({error:{code:"image_busy",message:"Image loading is already in progress. Try again shortly."}},429);
  active.add(key);
  try{return c.json(await renderRequestedImages(html,options.downloadImage,c.req.raw.signal,lists.retained as number[]??[],lists.seen as number[]??[],lists.remainingBytes as number??undefined));}
  finally{active.delete(key);}
 });
}
