import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { application } from "../src/application.ts";

const evidence = "tmp/docs/handoffs/starter-catalogue-browser";
mkdirSync(evidence, { recursive: true });
let app: ReturnType<typeof application>;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.handle(request) });
const accessKey="acceptance-secret",quote="quote_acceptance",invoice="lnbc1"+"q".repeat(40);
const ipponFetch=async(input:string|URL|Request,init:RequestInit={})=>{
  const url=new URL(String(input)),authorized=new Headers(init.headers).get("authorization")===`Bearer ${accessKey}`;
  if(url.pathname==="/v1/wallet"&&init.method==="POST")return Response.json({name:"Acceptance",access_key:accessKey,mint:"https://mint.example",unit:"sat",balance:0,pending_balance:0,limits:null});
  if(!authorized)return Response.json({error:"denied"},{status:401});
  if(url.pathname==="/v1/wallet"&&init.method==="GET")return Response.json({name:"Acceptance",access_key:accessKey,mint:"https://mint.example",unit:"sat",balance:0,pending_balance:0,limits:null});
  if(url.pathname==="/v1/wallet/deposit"&&init.method==="POST")return Response.json({quote,request:invoice,state:"UNPAID",expiry:null});
  if(url.pathname===`/v1/wallet/deposit/${quote}`&&init.method==="GET")return Response.json({quote,request:invoice,state:"UNPAID",expiry:null});
  return Response.json({error:"missing"},{status:404});
};
app = application({ dataDir: mkdtempSync(evidence + "/data-"), hostPubkey: null, origin: server.url.origin, version: "starter-acceptance",ipponBaseUrl:"https://ippon.test" },{ipponFetch});
app.db.run("UPDATE room SET admission='open' WHERE id=1");
const browser = await chromium.launch({ executablePath: process.env.FREEDOM_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const starters = [
  { title: "Cashu wallet", heading: "Cashu wallet" },
  { title: "Bush Bash Nostr", heading: "#bussobushbash" },
  { title: "Bitcoin spinner", heading: "Should I buy bitcoin?" },
  { title: "100 D6 rolls", heading: "100 D6 rolls" },
  { title: "Pong", heading: "Pong" },
];
const results: Record<string, unknown>[] = [];

async function openStarter(width: number, height: number, index: number) {
  const starter = starters[index]!;
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Create a New Profile" }).click();
  await page.getByLabel("Display name").fill(`Starter ${width} ${index}`);
  await page.getByText("Use a temporary identity instead", { exact: true }).click();
  await page.getByRole("button", { name: "Create temporary identity" }).click();
  await expect(page.getByRole("heading", { name: "Canvases" })).toBeVisible();
  await page.getByRole("button", { name: "Open Canvas" }).first().click();
  await page.getByRole("button", { name: "New Napplet" }).click();
  const card = page.locator(".starter").filter({ has: page.getByRole("heading", { name: starter.title, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Use this starter →" }).click();
  const frame = page.frameLocator("iframe[data-napplet]");
  await expect(frame.getByRole("heading", { name: starter.heading, exact: true })).toBeVisible({ timeout: 15000 });

  if (starter.title === "Cashu wallet") {
    await expect(frame.getByRole("status")).toContainText("No managed wallet is connected", { timeout: 15000 });
    await frame.getByRole("button",{name:"Connect a new managed wallet"}).click();
    await expect(frame.getByRole("status")).toContainText("Managed wallet connected");
    await frame.locator("#receive").evaluate((element: HTMLButtonElement) => element.click());
    await expect(frame.getByRole("status")).toContainText("Invoice ready", { timeout: 15000 });
    await expect(frame.locator("#invoiceBox")).not.toHaveClass(/hidden/);
    await expect(frame.locator("#pay")).toHaveAttribute("href",/^lightning:ln/i);
    await expect(frame.locator("#invoiceState")).toContainText("Creating it did not receive funds");
    await frame.getByRole("button",{name:"Check deposit status"}).click();
    await expect(frame.getByRole("status")).toContainText("UNPAID");
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
    await frame.locator("#pong").press("ArrowUp");
    await frame.getByRole("button",{name:"Pause"}).click();await expect(frame.getByRole("status")).toContainText("Paused");
    await frame.getByRole("button",{name:"Resume"}).click();await expect(frame.getByRole("status")).toContainText("Game running");
    expect(await frame.locator("#pong").evaluate(()=>eval("state.x=-10;frame();true"))).toBe(true);await expect(frame.getByRole("status")).toContainText("Score 0–1",{timeout:3000});
    await frame.getByRole("button",{name:"Restart scores"}).click();await expect(frame.getByRole("status")).toContainText("Score 0–0");
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
