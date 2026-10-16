import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { PipelineClient, type RequestReceipt } from "./client.ts";
import { createHash } from "node:crypto";
test("app signs exact bytes and fresh retries retain request id without claiming completion",async()=>{
  const key=generateSecretKey(),receipts:RequestReceipt[]=[];
  const client=new PipelineClient({origin:"https://autopilot.example",callbackUrl:"https://receiver.example/result",
    definitionId:"user:app:definition",appPubkey:getPublicKey(key),signer:async event=>finalizeEvent(event,key),
    receipt:async r=>{receipts.push(r)},fetch:(async(url,options)=>{
      const event=JSON.parse(Buffer.from(String((options!.headers as any).authorization).slice(6),"base64").toString());
      const body=String(options!.body);
      expect(event.tags).toContainEqual(["u",String(url)]);
      expect(event.tags).toContainEqual(["payload",createHash("sha256").update(body).digest("hex")]);
      const payload=JSON.parse(body); expect(payload.mode).toBe("webhook"); expect(payload.idempotencyKey).toBe("request");
      return Response.json({runId:"run",terminal:false,status:"running"},{status:202});
    }) as typeof fetch});
  const input={requestId:"request",projectId:"project",prompt:"edit"};
  expect(await client.submit(input)).toEqual({runId:"run",accepted:true}); await client.submit(input);
  expect(receipts[0].body).toBe(receipts[1].body); expect(receipts[0].event.id).not.toBe(receipts[1].event.id);
});
test("wrong broker identity denied before transmitting",async()=>{
  const key=generateSecretKey(); let called=false;
  const client=new PipelineClient({origin:"https://autopilot.example",callbackUrl:"https://receiver.example/result",
    definitionId:"definition",appPubkey:getPublicKey(generateSecretKey()),signer:async event=>finalizeEvent(event,key),
    fetch:(async()=>{called=true;return Response.json({})}) as unknown as typeof fetch});
  await expect(client.submit({requestId:"request",projectId:"project",prompt:"edit"})).rejects.toThrow("app_signer_binding_denied");
  expect(called).toBe(false);
});
