import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { application } from "../src/application.ts";
import { starters } from "../src/starters.ts";
import { validateGeneratedHtml } from "../src/pipeline/artifact.ts";

const byId = (id: string) => starters.find(starter => starter.id === id)!;

test("catalogue contains exactly Pete's five starters and removes legacy entries", () => {
  expect(starters.map(({ id }) => id)).toEqual(["cashu", "nostr", "spinner", "dice", "pong"]);
  expect(starters.some(({ id }) => ["todo", "meme", "game", "quiz", "blank"].includes(id))).toBe(false);
  for (const starter of starters) {
    expect(validateGeneratedHtml(starter.source)).toBe(starter.source);
    const scripts = [...starter.source.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]![1])).not.toThrow();
    expect(starter.source).not.toMatch(/<script\s+src|<iframe|<object|<embed|innerHTML|insertAdjacentHTML/i);
  }
});

test("Cashu uses only project/user-private storage and the documented Ippon REST contract", () => {
  const source = byId("cashu").source;
  expect(source).toContain('KEY="ippon.wallet.v1"');
  expect(source).toContain("napplet.storage.get(KEY)");
  expect(source).toContain("napplet.storage.set(KEY,wallet)");
  expect(source).toContain("napplet.storage.remove(KEY)");
  expect(source).toContain('"/v1/wallet/deposit"');
  expect(source).toContain('"/v1/wallet/deposit/"');
  expect(source).toContain('data.state==="ISSUED"');
  expect(source).not.toMatch(/seed|private[_ -]?key|dataset/i);
  expect(source).toContain("Origin: null");
});

test("Nostr browser uses the trusted relay API, exact filter, bounded rendering and honest states", () => {
  const source = byId("nostr").source;
  expect(source).toContain('kinds:[1],"#t":["bussobushbash"],limit:100');
  expect(source).toContain("napplet.relay.query(options)");
  expect(source).toContain("napplet.relay.subscribe(options");
  expect(source).toContain("event.content");
  expect(source).toContain("content.textContent");
  for (const state of ["truncated", "partial", "failed", "Recovery may have missed events", "No matching events"])
    expect(source).toContain(state);
});

test("spinner always resolves Yes and dice creates exactly 100 unbiased bounded D6 values", () => {
  const spin = byId("spinner").source, dice = byId("dice").source;
  expect(spin).toContain("Should I buy bitcoin?");
  expect(spin).toContain('answer.textContent="Yes"');
  expect(spin).toContain("@keyframes spin");
  expect(spin).not.toMatch(/No|Maybe/);
  expect(dice).toContain("crypto.getRandomValues(bytes)");
  expect(dice).toContain("bytes[0]>=252");
  expect(dice).toContain("bytes[0]%6+1");
  expect(dice).toContain("Array.from({length:100},d6)");
  expect(dice).toContain('" · Total: "+rolls.length');
});

test("Pong requests exactly 21 sats and cannot unlock from invoice creation or manual check", () => {
  const source = byId("pong").source;
  expect(source).toContain('addressUrl="https://walletofsatoshi.com/.well-known/lnurlp/bitcoinbushbash"');
  expect(source).toContain("amountMsat=21000");
  expect(source).toContain('callback.searchParams.set("amount",String(amountMsat))');
  expect(source).toContain("Creating an invoice is not proof of payment");
  expect(source).toContain("Pong stays locked");
  expect(source).toContain('function unlockAfterVerifiedSettlement()');
  expect(source.match(/unlockAfterVerifiedSettlement\(\)/g)).toHaveLength(1);
  expect(source).toContain('canvas.addEventListener("pointermove"');
  expect(source).toContain('keys.has("ArrowUp")');
});

test("catalogue removal does not delete an existing project or revision", () => {
  const directory = mkdtempSync("/tmp/freedom-starters-");
  let app = application({ dataDir: directory, hostPubkey: null, origin: null, version: "test" });
  try {
    const owner = "a".repeat(64);
    app.db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,'Owner','temporary','admitted',1)", [owner]);
    const member = app.auth.member(owner);
    const project = app.workshop.create(member, "spinner").project;
    const revision = project.current_revision;
    app.db.run("UPDATE projects SET title='Todo app (existing)' WHERE id=?", [project.id]);
    app.db.close();
    app = application({ dataDir: directory, hostPubkey: null, origin: null, version: "test" });
    const restored = app.workshop.project(app.auth.member(owner), project.id);
    expect(restored.title).toBe("Todo app (existing)");
    expect(restored.current_revision).toBe(revision);
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id=?").get(project.id)).toEqual({ count: 1 });
  } finally {
    app.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
