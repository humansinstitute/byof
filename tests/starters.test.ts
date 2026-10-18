import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { application } from "../src/application.ts";
import { starters } from "../src/starters.ts";
import { validateGeneratedHtml } from "../src/pipeline/artifact.ts";

const byId = (id: string) => starters.find(starter => starter.id === id)!;

test("catalogue contains the Simple website followed by Pete's existing starters and removes legacy entries", () => {
  expect(starters.map(({ id }) => id)).toEqual(["website", "cashu", "nostr", "spinner", "dice", "pong"]);
  expect(starters.some(({ id }) => ["todo", "meme", "game", "quiz", "blank"].includes(id))).toBe(false);
  for (const starter of starters) {
    expect(validateGeneratedHtml(starter.source)).toBe(starter.source);
    const scripts = [...starter.source.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeLessThanOrEqual(1);
    if (scripts[0]) expect(() => new Function(scripts[0][1])).not.toThrow();
    expect(starter.source).not.toMatch(/<script\s+src|<iframe|<object|<embed|innerHTML|insertAdjacentHTML/i);
  }
});

test("catalogue derives its visible count and renders icon labels as text", async () => {
  const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
  expect(source).toContain("state.starters.length} workshop Napplet${state.starters.length===1?'':'s'}");
  expect(source).not.toContain("Choose one of five workshop Napplets");
  expect(source).toContain('<div class="art">${esc(s.icon)}</div>');
  expect(source).not.toContain('<div class="art">${s.icon}</div>');
  expect(byId("website").icon).toBe("<>");
});

test("Simple website is a minimal responsive dependency-free Hello world document", () => {
  const starter = byId("website"), source = starter.source;
  expect(starter.title).toBe("Simple website");
  expect(starter.description).toBe("A clean Hello world page ready to make your own.");
  expect(source.startsWith("<!doctype html>")).toBe(true);
  expect(source).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  expect(source).toContain("<h1>Hello world</h1>");
  expect(source).toContain("font-size: clamp(");
  expect(source).not.toMatch(/<script|https?:|napplet\.|fetch\(|credential|token|password/i);
  expect(source.match(/<h1>/g)).toHaveLength(1);
});

test("Cashu starter is a provider-neutral forkable arcade wallet with receive, send and private address book", () => {
  const source = byId("cashu").source;
  for (const method of ["napplet.cashu.status()", "napplet.cashu.connect()", "napplet.cashu.createDeposit(amount)", "napplet.cashu.checkDeposit(currentDeposit.quote)", "napplet.cashu.pay(", "napplet.cashu.checkPayment(currentPayment.quote)", "napplet.cashu.disconnect()", 'napplet.storage.get("wallet.addressBook.v1")', 'napplet.storage.set("wallet.addressBook.v1",contacts)']) expect(source).toContain(method);
  expect(source).toContain('id="receiveAmount" inputmode="numeric" type="number" min="1" max="100000" step="1" value="42"');
  expect(source).toContain('id="sendAmount" inputmode="numeric" type="number" min="1" max="100000" step="1" value="21"');
  expect(source).toContain('walletBalance=data.balance');
  expect(source).toContain('if(amount>=walletBalance)throw Error("Leave a few sats for the Lightning fee. Send less than your current balance.")');
  expect(source).toContain('state==="ISSUED"');
  expect(source).toContain('id="invoiceQr"'); expect(source).toContain('src=data.qr'); expect(source).toContain('href="lightning:"+data.invoice');
  expect(source).toContain("bitcoinbushbash@walletofsatoshi.com"); expect(source).toContain("PAYMENT DENIED · NO FUNDS SENT");
  expect(source).toContain("REVIEW EVERY DETAIL"); expect(source).toContain("CONTINUE TO APPROVAL");
  expect(source).not.toMatch(/fetch\(|accessKey|authorization|ippon\.wallet\.v1/i);
  expect(source).not.toMatch(/Ippon|Minibits|Freedom Tools|access[- ]?key|bridge|capabilit|dataset|website|\bhost\b/i);
  expect(byId("cashu").description).not.toMatch(/Ippon|Minibits|Freedom Tools|provider|\bhost\b|bridge|capabilit|dataset/i);
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
  expect(spin.match(/>YES</g)).toHaveLength(2);
  expect(spin.match(/>NO</g)).toHaveLength(2);
  expect(spin).toContain('class="pointer"');
  expect(spin).toContain("position:absolute;z-index:2");
  expect(spin).toContain("FULL_TURNS=5,YES_SECTOR_OFFSET_DEG=90");
  expect(spin).toContain("YES_LANDING_DEG=FULL_TURNS*360+YES_SECTOR_OFFSET_DEG");
  expect(spin).toContain('wheel.style.setProperty("--landing-angle",YES_LANDING_DEG+"deg")');
  expect(spin).toContain("rotate(var(--landing-angle))");
  expect(spin).toContain("@keyframes counterSpin");
  expect(spin).toContain('answer.textContent="Yes"');
  expect(spin).toContain("@keyframes spin");
  expect(spin).toContain("prefers-reduced-motion: reduce");
  expect(spin).not.toContain('answer.textContent="No"');
  expect(spin).not.toMatch(/Math\.random/);
  expect(dice).toContain("crypto.getRandomValues(bytes)");
  expect(dice).toContain("bytes[0]>=252");
  expect(dice).toContain("bytes[0]%6+1");
  expect(dice).toContain("Array.from({length:100},d6)");
  expect(dice).toContain('" · Total: "+rolls.length');
});

test("Pong starts stationary with documented keyboard and discrete touch controls", () => {
  const source = byId("pong").source;
  expect(byId("pong").title).toBe("Pong");
  expect(source).toContain("<h1>Pong</h1>");
  expect(source).toContain("↑/↓ move · Space starts or pauses · R resets and starts");
  expect(source).toContain("Ready. Press Space or Start. Score 0–0.");
  expect(source).toContain('const canvas=document.querySelector("#pong")');
  expect(source).toContain("running:false");
  expect(source).toContain('["ArrowUp","ArrowDown","w","W","s","S"].includes(event.key)');
  expect(source).toContain('keys.add(event.key)');
  expect(source).toContain('document.addEventListener("keyup",event=>keys.delete(event.key))');
  expect(source).toContain('addEventListener("blur",()=>keys.clear())');
  expect(source).toContain('movePaddle(-1,PADDLE_KEY_SPEED)');
  expect(source).toContain('if(event.code==="Space")');
  expect(source).toContain('event.key==="r"||event.key==="R"');
  expect(source).toContain('event.pointerType!=="touch"');
  expect(source).toContain('event.clientY<rect.top+rect.height/2?-1:1');
  expect(source).toContain('document.querySelector("#restart").onclick=restart');
  expect(source).toContain('if(event.pointerType!=="touch")return');
  expect(source).not.toContain('canvas.addEventListener("pointermove"');
  expect(source).not.toContain('event.pointerType==="mouse"');
  expect(source).toContain("touch-action:none");
  expect(source).not.toMatch(/lightning|invoice|donat|payment|settlement|unlock|walletofsatoshi|fetch\(/i);
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
