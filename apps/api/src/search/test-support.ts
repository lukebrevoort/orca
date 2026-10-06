/** Synthetic fixtures only. Production maintenance uses the explicit admin CLI. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { initializeSearchBuild, enableSearch } from "./indexing/admin.ts";
import { acquireWriterOwnership } from "./indexing/ownership.ts";
import { enqueueBaseline, claimNextJob, acknowledgeReceipt } from "./indexing/queue.ts";
import { canonicalizePath, getSearchIndexPath, openCanonicalReadOnly, readSearchControl, type SourceAccount } from "./indexing/schema.ts";
import { applyIndexJob, publishAccountReady } from "./indexing/worker-core.ts";

export function prepareSyntheticSearchIndex(canonical: Database): void {
  const path = canonicalizePath(canonical.filename);
  const indexPath = getSearchIndexPath(path);
  if (!existsSync(indexPath)) initializeSearchBuild(canonical, indexPath);
  canonical.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  const index = new Database(indexPath);
  index.exec("PRAGMA synchronous=FULL");
  const owner = acquireWriterOwnership(index, indexPath, readSearchControl(canonical));
  const source = openCanonicalReadOnly(path);
  try {
    const identity = { sourceId: readSearchControl(canonical).source_id, buildId: readSearchControl(canonical).build_id, ownerToken: owner.token };
    const accounts = canonical.query<SourceAccount, []>("SELECT * FROM mail_search_accounts WHERE deleted=0").all();
    for (const account of accounts) {
      let complete = false;
      while (!complete) complete = enqueueBaseline(canonical, account.account_id, account.mode).complete;
    }
    let job; while ((job = claimNextJob(canonical))) acknowledgeReceipt(canonical, applyIndexJob(source, index, job, identity));
    for (const account of accounts) {
      if (!publishAccountReady(source, index, account.account_id, account.incarnation, account.mode, identity)) throw new Error("Synthetic fixture search did not become ready");
    }
    enableSearch(canonical, index);
  } finally { source.close(); owner.release(); index.close(); }
}
