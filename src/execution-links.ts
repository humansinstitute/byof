import type { FollowupConfig } from './config.ts';
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { projectRoute } from './project-routing.ts';

/** Links are derived from server configuration and verified stored run/native receipts. */
export function executionLinks(workshop: Workshop, member: Member, projectId: string, config?: FollowupConfig) {
  const project = workshop.project(member, projectId), route = projectRoute(project,config);
  if (!route) return null;
  const origin = new URL(route.origin).origin;
  const rows = workshop.db.query(`SELECT r.id,r.run_id,
    (SELECT d.result_json FROM delivery_receipts d WHERE d.request_id=r.id AND d.run_id=r.run_id AND d.status='succeeded' ORDER BY d.created_at DESC LIMIT 1) receipt_json
    FROM requests r WHERE r.project_id=? ORDER BY r.created_at,r.rowid`).all(projectId) as any[];
  return { definition: origin+'/pipelines/definitions/'+encodeURIComponent(route.definitionId),
    runs: rows.filter(row => row.run_id).map(row => {
      const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
      const native = receipt?.result?.nativeReceipt;
      return { requestId: row.id, run: origin+'/pipelines/runs/'+encodeURIComponent(row.run_id),
        session: native?.sessionId ? origin+'/live/'+encodeURIComponent(native.sessionId) : null };
    }), operatorNotice: 'Inspect and adjust in the Autopilot that owns this installation. Sign in as its owner or authorized operator.' };
}
