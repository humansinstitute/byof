import { Workshop } from './workshop.ts';
import { application } from "./application.ts";
import { configuration, limits } from "./config.ts";
import { RequestEvents, type EventClient } from "./request-events.ts";
import type { Config } from "./config.ts";
export function createFreedomServer(config: Config, port = Number(process.env.PORT || 3000)) {
const app = application(config), events = new RequestEvents(app);
const connections = new Map<string, number>();
const server = Bun.serve<EventClient>({
  hostname: "0.0.0.0", port, maxRequestBodySize: limits.attachmentBodyBytes,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/events") {
      try {
        if (request.headers.get("origin") !== app.originOf(request)) return new Response("Origin denied", { status: 403 });
        const session = app.auth.session(request),workshopId=app.site.selection(request),scope=new Workshop(app.db,app.workshop.assets,workshopId);session.member=scope.scoped(session.member);scope.admitted(session.member);
        if ((connections.get(session.member.pubkey) || 0) >= limits.socketsPerMember) return new Response("Connection capacity reached", { status: 429 });
        if (server.upgrade(request, { data: { member: session.member, expiresAt: session.expiresAt, sessionHash: session.sessionHash,workshopId } })) return;
      } catch { return new Response("Unauthorized", { status: 401 }); }
      return new Response("WebSocket upgrade required", { status: 400 });
    }
    return app.handle(request);
  },
  websocket: {
    maxPayloadLength: 1024, idleTimeout: 60,
    open(ws) { events.open(ws); const key = ws.data.member.pubkey; connections.set(key, (connections.get(key) || 0) + 1); ws.send(JSON.stringify({ type: "capabilities", generationAvailable: false, publicationAvailable: false })); },
    message(ws, message) {
      events.message(ws, typeof message === "string" ? message : message.toString());
    },
    close(ws) { events.close(ws); const key = ws.data.member.pubkey; connections.set(key, Math.max(0, (connections.get(key) || 1) - 1)); },
  },
});
const unsubscribe = app.onChange(() => events.publish());
const sweep = setInterval(() => {events.publish();void app.recoverBuilders().catch(()=>{});}, 15000);
void app.recoverBuilders().catch(()=>{});
sweep.unref();
return {server, app, stop() {clearInterval(sweep);unsubscribe();server.stop(true);app.db.close();}};
}
if (import.meta.main) {
const config=configuration(), {server}=createFreedomServer(config);
console.log(`BYO Freedom ${config.version} listening on managed port ${server.port}; generation and publication unavailable`);

}
