import type { Workshop } from "../workshop.ts";
import type { Member } from "../auth.ts";
import type { OperatorBuildConfig } from "../config.ts";
import { demand } from "../errors.ts";
import { bindRun } from "../delivery-store.ts";
import { ManagedPipelineClient } from "./managed-client.ts";

export async function dispatchApprovedRequest(workshop: Workshop, member: Member, id: string, config?: OperatorBuildConfig) {
  workshop.host(member);
  demand(config && config.approvedRequestId === id, 403, "This saved request has not been approved for an operator build");
  const row = workshop.db.query("SELECT r.*,p.conversation_id,p.current_revision FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.id=?").get(id) as any;
  demand(row, 404, "Saved request not found");
  workshop.project(member,row.project_id);
  if (row.run_id) return { requestId: id, runId: row.run_id, status: row.status };
  demand(row.status === "unavailable" && row.expected_revision === row.current_revision, 409, "Saved request or project changed");
  const client = new ManagedPipelineClient(config);
  const source = workshop.assets.get(workshop.revision(row.project_id, row.expected_revision).source_hash);
  const accepted = await client.submit({ requestId: id, projectId: row.project_id, prompt: row.prompt, source });
  workshop.db.transaction(() => {
    bindRun(workshop.db, id, accepted.runId);
    workshop.db.run("UPDATE requests SET status='building',error=NULL WHERE id=? AND status='unavailable'", [id]);
    workshop.db.run("INSERT OR IGNORE INTO dispatch_receipts(request_id,run_id,receipt_json) VALUES(?,?,?)", [id, accepted.runId, JSON.stringify(accepted.receipt)]);
  })();
  return { requestId: id, runId: accepted.runId, status: "building" };
}
