import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { application } from "../src/application.ts";
import decodeQR from "qr/decode.js";

const evidence = "tmp/docs/handoffs/starter-catalogue-browser";
mkdirSync(evidence, { recursive: true });
let app: ReturnType<typeof application>;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.handle(request) });
const accessKey="acceptance-secret",quote="quote_acceptance",invoice="lnbc1"+"q".repeat(40),paymentQuote="payment_acceptance";let balance=0,paymentChecks=0,depositAmount=0;const upstreamCalls:{path:string;method:string;body:any}[]=[];
const ipponFetch=async(input:string|URL|Request,init:RequestInit={})=>{
  const url=new URL(String(input)),authorized=new Headers(init.headers).get("authorization")===`Bearer ${accessKey}`;
  upstreamCalls.push({path:url.pathname,method:String(init.method),body:init.body?JSON.parse(String(init.body)):null});
  if(url.pathname==="/v1/wallet"&&init.method==="POST"){balance=0;depositAmount=0;return Response.json({name:"Acceptance",access_key:accessKey,mint:"https://mint.example",unit:"sat",balance:0,pending_balance:0,limits:null});}
  if(!authorized)return Response.json({error:"denied"},{status:401});
  if(url.pathname==="/v1/wallet"&&init.method==="GET")return Response.json({name:"Acceptance",access_key:accessKey,mint:"https://mint.example",unit:"sat",balance,pending_balance:0,limits:null});
  if(url.pathname==="/v1/wallet/deposit"&&init.method==="POST"){depositAmount=JSON.parse(String(init.body)).amount;return Response.json({quote,request:invoice,state:"UNPAID",expiry:null});}
  if(url.pathname===`/v1/wallet/deposit/${quote}`&&init.method==="GET"){balance+=depositAmount;depositAmount=0;return Response.json({quote,request:invoice,state:"ISSUED",expiry:123456});}
  if(url.pathname==="/v1/wallet/pay"&&init.method==="POST"){balance-=23;return Response.json({quote:paymentQuote,amount:init.body?JSON.parse(String(init.body)).amount:0,fee_reserve:2,state:"PENDING",payment_preimage:null,expiry:123456});}
  if(url.pathname===`/v1/wallet/pay/${paymentQuote}`&&init.method==="GET"){paymentChecks++;return Response.json({quote:paymentQuote,amount:21,fee_reserve:2,state:"PAID",payment_preimage:"acceptance-preimage",expiry:123456});}
  return Response.json({error:"missing"},{status:404});
};
app = application({ dataDir: mkdtempSync(evidence + "/data-"), hostPubkey: null, origin: server.url.origin, version: "starter-acceptance",ipponBaseUrl:"https://ippon.test" },{ipponFetch});
app.db.run("UPDATE room SET admission='open' WHERE id=1");
const browser = await chromium.launch({ executablePath: process.env.FREEDOM_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const starters = [
  { title: "SATCADE wallet", heading: "SATCADE" },
  { title: "Bush Bash Nostr", heading: "#bussobushbash" },
  { title: "Bitcoin spinner", heading: "Should I buy bitcoin?" },
  { title: "100 D6 rolls", heading: "100 D6 rolls" },
  { title: "Pong", heading: "Pong" },
];
const results: Record<string, unknown>[] = [];

async function openStarter(width: number, height: number, index: number) {
  const starter = starters[index]!;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width === 390, isMobile: width === 390, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  let copied="";await page.exposeFunction("captureWalletClipboard",(value:string)=>{copied=value});await page.addInitScript(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:(value:string)=>(window as any).captureWalletClipboard(value)}}));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Create a New Profile" }).click();
  await page.getByLabel("Display name").fill(`Starter ${width} ${index}`);
  await page.getByRole("button", { name: "Generate local key and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Canvases" })).toBeVisible();
  await page.getByRole("button", { name: "Open Canvas" }).first().click();
  await page.getByRole("button", { name: "New Napplet" }).click();
  const card = page.locator(".starter").filter({ has: page.getByRole("heading", { name: starter.title, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Use this starter →" }).click();
  const frame = page.frameLocator("iframe[data-napplet]");
  await expect(frame.getByRole("heading", { name: starter.heading, exact: true })).toBeVisible({ timeout: 15000 });

  if (starter.title === "SATCADE wallet") {
    await expect(frame.getByRole("status")).toContainText("NO WALLET YET", { timeout: 15000 });
    await frame.getByRole("button",{name:"START WALLET"}).evaluate((element:HTMLButtonElement)=>element.click());
    await expect(frame.getByRole("status")).toContainText("WALLET READY",{timeout:15000});
    await frame.locator("#receive").evaluate((element: HTMLButtonElement) => element.click());
    await expect(frame.getByRole("status")).toContainText("INVOICE READY", { timeout: 15000 });
    await expect(frame.locator("#invoiceBox")).not.toHaveClass(/hidden/);
    await expect(frame.locator("#openInvoice")).toHaveAttribute("href",/^lightning:ln/i);
    const pixels=await frame.locator("#invoiceQr").evaluate(async element=>{const img=element as HTMLImageElement;await img.decode();const canvas=document.createElement("canvas");canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const context=canvas.getContext("2d")!;context.drawImage(img,0,0);return{width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)}});expect(decodeQR({...pixels,data:Uint8Array.from(pixels.data)})).toBe("lightning:"+invoice);
    await frame.getByRole("button",{name:"COPY"}).click();expect(copied).toBe(invoice);
    await frame.getByRole("button",{name:"CHECK PAYMENT"}).first().click(); await expect(frame.getByRole("status")).toContainText("WALLET READY");
    await frame.getByRole("button",{name:"ADDRESS BOOK"}).click();await expect(frame.getByText("bitcoinbushbash@walletofsatoshi.com",{exact:true})).toBeVisible();await frame.locator(".contact-pick").filter({hasText:"Bitcoin Bush Bash"}).click();
    const payCalls=()=>upstreamCalls.filter(call=>call.path==="/v1/wallet/pay"&&call.method==="POST").length,payBaseline=payCalls();
    await expect(frame.locator("#destination")).toHaveValue("bitcoinbushbash@walletofsatoshi.com");await frame.locator("#sendAmount").fill("42");await frame.getByRole("button",{name:"REVIEW PAYMENT"}).evaluate((element:HTMLButtonElement)=>element.click());await expect(frame.getByRole("status")).toContainText("Leave a few sats for the Lightning fee");await expect(frame.locator("#paymentReview")).toHaveClass(/hidden/);expect(payCalls()).toBe(payBaseline);await expect(page.locator(".napplet-consent")).toHaveCount(0);
    await frame.locator("#sendAmount").fill("21");await frame.getByRole("button",{name:"REVIEW PAYMENT"}).evaluate((element:HTMLButtonElement)=>element.click());await expect(frame.locator("#reviewAmount")).toHaveText("21 sat");
    await frame.getByRole("button",{name:"CONTINUE TO APPROVAL"}).evaluate((element:HTMLButtonElement)=>element.click());const consent=page.locator(".napplet-consent");await expect(consent).toContainText("SATCADE wallet");await expect(consent).toContainText("v1");await expect(consent).toContainText("bitcoinbushbash@walletofsatoshi.com");await expect(consent).toContainText("Amount: 21 sat");await expect(consent).toContainText("Wallet funds will leave");await expect(consent.locator('[data-napplet-consent="deny"]')).toBeFocused();
    const concurrent=frame.locator("body").evaluate(async()=>{try{await(window as any).napplet.cashu.pay({lightningAddress:"other@example.com",amount:1});return"OK"}catch(error:any){return error.code}});expect(await concurrent).toBe("BUSY");await consent.locator('[data-napplet-consent="deny"]').click();await expect(frame.getByRole("status")).toContainText("NO FUNDS SENT");expect(payCalls()).toBe(payBaseline);
    await frame.getByRole("button",{name:"CONTINUE TO APPROVAL"}).evaluate((element:HTMLButtonElement)=>element.click());await expect(consent).toContainText("bitcoinbushbash@walletofsatoshi.com");await consent.locator('[data-napplet-consent="allow"]').click();await expect(frame.locator("#paymentState")).toContainText("PENDING");expect(payCalls()).toBe(payBaseline+1);await frame.locator("#paymentResult").getByRole("button",{name:"CHECK PAYMENT"}).evaluate((element:HTMLButtonElement)=>element.click());await expect(frame.locator("#paymentState")).toContainText("PAID");expect(paymentChecks).toBeGreaterThan(0);
    const appText=await frame.locator("body").innerText();expect(appText).not.toMatch(/Ippon|Minibits|Freedom Tools|access[- ]?key|bridge|capabilit|dataset|website|\bhost\b/i);expect(await frame.locator("html").evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const staleBefore=payCalls();await frame.getByRole("button",{name:"REVIEW PAYMENT"}).evaluate((element:HTMLButtonElement)=>element.click());await frame.getByRole("button",{name:"CONTINUE TO APPROVAL"}).evaluate((element:HTMLButtonElement)=>element.click());await expect(consent).toBeVisible();await page.locator("iframe[data-napplet]").evaluate((element:HTMLIFrameElement)=>element.src=element.src);await expect(consent).toHaveCount(0);expect(payCalls()).toBe(staleBefore);
    const currentUser=await page.evaluate(async()=>(await(await fetch('/api/v1/me')).json()).member.pubkey),projectId=await page.locator("iframe[data-napplet]").getAttribute("data-project"),privateRows=(app.db.query("SELECT user_pubkey,key,value_json FROM napplet_user_data WHERE key='wallet.addressBook.v1' AND user_pubkey=? AND project_id=?").all(currentUser,projectId) as any[]);expect(privateRows).toHaveLength(1);expect(privateRows[0].value_json).toContain("bitcoinbushbash@walletofsatoshi.com");
  } else if (starter.title === "Bush Bash Nostr") {
    await expect(frame.getByRole("status")).not.toHaveText("Ready.", { timeout: 25000 });
  } else if (starter.title === "Bitcoin spinner") {
    await frame.getByRole("button", { name: "Spin" }).click();
    await expect(frame.getByRole("status")).toHaveText("Yes", { timeout: 3000 });
  } else if (starter.title === "100 D6 rolls") {
    await frame.getByRole("button", { name: "Go" }).click();
    await expect(frame.locator("#rolls span")).toHaveCount(100);
    const values = await frame.locator("#rolls span").allTextContents();
    expect(values.every(value => /^[1-6]$/.test(value))).toBe(true);
    await expect(frame.getByRole("status")).toContainText("Total: 100");
  } else {
    await expect(frame.locator("#pong")).toBeVisible();
    const text=(await frame.locator("body").innerText()).toLowerCase();expect(text).not.toMatch(/lightning|invoice|donat|payment|unlock/);
    await expect(frame.getByRole("status")).toContainText("Ready. Press Space or Start. Score 0–0.");
    const initial=await frame.locator("#pong").evaluate(()=>eval("({x:state.x,left:state.left,running:state.running})"));await page.waitForTimeout(150);const still=await frame.locator("#pong").evaluate(()=>eval("({x:state.x,left:state.left,running:state.running})"));expect(still).toEqual(initial);
    if(width===390){
      const canvas=frame.locator("#pong");await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();expect(box).not.toBeNull();const scrollBefore=await page.evaluate(()=>scrollY);
      await page.touchscreen.tap(box!.x+box!.width/2,box!.y+box!.height/4);expect(await canvas.evaluate(()=>eval("state.left"))).toBeLessThan(initial.left);
      await page.touchscreen.tap(box!.x+box!.width/2,box!.y+box!.height*3/4);expect(await canvas.evaluate(()=>eval("state.left"))).toBe(initial.left);expect(await page.evaluate(()=>scrollY)).toBe(scrollBefore);
    }else{
      const canvas=frame.locator("#pong"),box=await canvas.boundingBox();expect(box).not.toBeNull();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/4);await page.mouse.down();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height*3/4);await page.mouse.up();expect(await canvas.evaluate(()=>eval("state.left"))).toBe(initial.left);await page.keyboard.down("ArrowUp");await page.waitForTimeout(80);const movedUp=await canvas.evaluate(()=>eval("state.left"));await page.waitForTimeout(80);expect(await canvas.evaluate(()=>eval("state.left"))).toBeLessThan(movedUp);await page.keyboard.up("ArrowUp");const released=await canvas.evaluate(()=>eval("state.left"));await page.waitForTimeout(80);expect(await canvas.evaluate(()=>eval("state.left"))).toBe(released);await page.keyboard.down("ArrowDown");await page.waitForTimeout(120);await page.keyboard.up("ArrowDown");expect(await canvas.evaluate(()=>eval("state.left"))).toBeGreaterThan(released);
    }
    const canvas=frame.locator("#pong");await canvas.press("Space");await expect(frame.getByRole("status")).toContainText("Game running");const runningX=await canvas.evaluate(()=>eval("state.x"));await page.waitForTimeout(100);expect(await canvas.evaluate(()=>eval("state.x"))).not.toBe(runningX);
    await canvas.press("Space");await expect(frame.getByRole("status")).toContainText("Paused");const pausedX=await canvas.evaluate(()=>eval("state.x"));await page.waitForTimeout(100);expect(await canvas.evaluate(()=>eval("state.x"))).toBe(pausedX);
    await canvas.press("Space");await expect(frame.getByRole("status")).toContainText("Game running");expect(await canvas.evaluate(()=>eval("state.running"))).toBe(true);
    await canvas.evaluate(()=>eval("state.leftScore=3;state.rightScore=4;state.left=0;state.x=10"));await canvas.press("r");await expect(frame.getByRole("status")).toContainText("Reset. Game running. Score 0–0.");expect(await canvas.evaluate(()=>eval("({leftScore:state.leftScore,rightScore:state.rightScore,left:state.left,running:state.running})"))).toEqual({leftScore:0,rightScore:0,left:140,running:true});
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/${width}-${starter.title.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
  results.push({ viewport: { width, height }, starter: starter.title, errors });
  expect(errors).toEqual([]);
  await context.close();
}

try {
  for (const viewport of [{ width: 1440, height: 950 }, { width: 390, height: 844 }])
    for (let index = 0; index < starters.length; index++) await openStarter(viewport.width, viewport.height, index);
  await Bun.write(evidence + "/results.json", JSON.stringify({ proof: "Real Chrome and isolated Freedom Tools backend", results }, null, 2));
  console.log(JSON.stringify({ evidence, results }));
} finally {
  await browser.close();
  server.stop(true);
  app.db.close();
}
