import { createHash } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";

export type TerminalEnvelope = {
  runId: string; deliveryId: string; status: string; terminal: true;
  result: Record<string, unknown> | null; error: unknown;
};
export type VerifiedDelivery = {
  envelope: TerminalEnvelope; eventId: string; attempt: number; bodyHash: string;
};
export class DeliveryDenied extends Error {}

function one(event: Event, name: string): string {
  const tags = event.tags.filter(tag => tag[0] === name);
  if (tags.length !== 1 || tags[0].length !== 2 || !tags[0][1]) throw new DeliveryDenied(`invalid_${name}_tag`);
  return tags[0][1];
}

export function verifyDelivery(input: {
  body: string; authorization: string | null; publicUrl: string;
  signerPubkey: string; deliveryHeader: string | null; runHeader: string | null;
  nowSeconds?: number;
}): VerifiedDelivery {
  if (Buffer.byteLength(input.body) > 1048576) throw new DeliveryDenied("body_too_large");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!input.authorization?.startsWith("Nostr ")) throw new DeliveryDenied("authorization_required");
  let event: Event;
  let envelope: TerminalEnvelope;
  try {
    event = JSON.parse(Buffer.from(input.authorization.slice(6), "base64").toString("utf8"));
    envelope = JSON.parse(input.body);
    // Parse creates a fresh object, so a caller cannot smuggle a cached verified symbol.
    if (!verifyEvent(event)) throw new Error();
  } catch { throw new DeliveryDenied("invalid_signature_or_body"); }
  if (event.pubkey !== input.signerPubkey || event.kind !== 27235 || event.content !== "") throw new DeliveryDenied("signer_or_kind_denied");
  if (!Number.isInteger(event.created_at) || event.created_at < now - 60 || event.created_at > now + 15) throw new DeliveryDenied("stale_signature");
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  if (one(event, "u") !== input.publicUrl || one(event, "method") !== "POST" || one(event, "payload") !== bodyHash) throw new DeliveryDenied("request_binding_denied");
  if (!envelope || typeof envelope.runId !== "string" || !envelope.runId ||
      typeof envelope.deliveryId !== "string" || !envelope.deliveryId || envelope.terminal !== true ||
      !["ok", "error", "needs_input", "skipped", "cancelled"].includes(envelope.status)) throw new DeliveryDenied("terminal_envelope_required");
  if (one(event, "run") !== envelope.runId || one(event, "delivery") !== envelope.deliveryId ||
      input.runHeader !== envelope.runId || input.deliveryHeader !== envelope.deliveryId) throw new DeliveryDenied("receipt_binding_denied");
  const attemptText = one(event, "attempt");
  if (!/^[1-9]\d*$/.test(attemptText) || !Number.isSafeInteger(Number(attemptText))) throw new DeliveryDenied("attempt_denied");
  return { envelope, eventId: event.id, attempt: Number(attemptText), bodyHash };
}

// The WApp must execute all methods in ONE database transaction and commit before
// returning HTTP 2xx. Identity/room/member are resolved from its stored run mapping.
export interface DeliveryTransaction {
  hasEvent(eventId: string): boolean;
  deliveryHash(deliveryId: string): string | null;
  requestForRun(runId: string): { requestId: string; projectId: string } | null;
  apply(delivery: VerifiedDelivery): void;
  recordEvent(eventId: string): void;
}
export function applyDelivery(delivery: VerifiedDelivery, tx: DeliveryTransaction): "applied" | "duplicate" {
  if (tx.hasEvent(delivery.eventId)) throw new DeliveryDenied("auth_replay");
  const priorHash = tx.deliveryHash(delivery.envelope.deliveryId);
  if (priorHash) {
    if (priorHash !== delivery.bodyHash) throw new DeliveryDenied("delivery_payload_conflict");
    tx.recordEvent(delivery.eventId);
    return "duplicate";
  }
  const mapping = tx.requestForRun(delivery.envelope.runId);
  if (!mapping) throw new DeliveryDenied("unknown_run");
  const result = delivery.envelope.result;
  if (delivery.envelope.status === "ok") {
    if (!result || result.requestId !== mapping.requestId || result.projectId !== mapping.projectId) throw new DeliveryDenied("request_correlation_denied");
    if (!["ban", "answer_completed", "build_completed", "build_failed", "classifier_error", "storage_pending", "builder_abandoned", "message_completed"].includes(String(result.action))) throw new DeliveryDenied("unknown_terminal_action");
    if (result.action === "ban") {
      const evidence = result.policyEvidence as any;
      const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
      if (result.banRequired !== true || evidence?.policyVersion !== "freedomtools-screen-v1" ||
          evidence.threshold !== 0.95 || typeof evidence.model !== "string" || !evidence.model ||
          !valid(evidence.injectionProbability) || !valid(evidence.privateExtractionProbability) ||
          !(evidence.injectionProbability >= 0.95 || evidence.privateExtractionProbability >= 0.95)) throw new DeliveryDenied("invalid_ban_evidence");
    } else if (result.banRequired !== false) throw new DeliveryDenied("invalid_nonban_result");
    if (result.candidate) {
      const candidate=result.candidate as Record<string,unknown>;
      if(result.action!=="build_failed" || result.code!=="artifact_validation_pending" ||
        candidate.invocationRunId!==delivery.envelope.runId || candidate.requestId!==mapping.requestId ||
        candidate.projectId!==mapping.projectId || !Array.isArray(candidate.projectFiles))throw new DeliveryDenied("candidate_correlation_denied");
    }
  }
  tx.apply(delivery);
  tx.recordEvent(delivery.eventId);
  return "applied";
}
