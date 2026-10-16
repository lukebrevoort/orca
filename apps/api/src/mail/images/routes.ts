import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, oauthAccounts } from "../../db/schema.ts";
import { renderRequestedImages, type ImageDownload } from "./render.ts";

type Options={dbFactory?:typeof createDatabaseClient;downloadImage?:ImageDownload};
export function registerMessageImageRoutes(app:Hono<{Variables:AuthVariables}>,options:Options={}){
 const dbFactory=options.dbFactory??createDatabaseClient;
 app.post("/v1/messages/:id/images",requireAuth({dbFactory}),async c=>{
  c.header("Cache-Control","private, no-store");c.header("X-Content-Type-Options","nosniff");
  // Native bearer-only action: a cross-site cookie/form cannot trigger sender requests.
  if(!c.req.header("authorization")?.startsWith("Bearer "))return c.json({error:{code:"image_consent_required",message:"Load images from the app."}},403);
  const accountId=c.req.query("accountId");if(!accountId)return c.json({error:{code:"validation_error",message:"An accountId is required"}},400);
  const {db,sqlite}=dbFactory();let html:string|null=null;
  try{
   const row=db.select({html:emails.bodyHtml}).from(emails).innerJoin(oauthAccounts,eq(oauthAccounts.id,emails.accountId)).where(and(eq(emails.id,c.req.param("id")),eq(emails.accountId,accountId),eq(oauthAccounts.userId,c.get("auth").userId))).get();
   if(!row)return c.json({error:{code:"not_found",message:"Message not found"}},404);
   html=row.html;
  }finally{sqlite.close();}
  return c.json(await renderRequestedImages(html,options.downloadImage));
 });
}
