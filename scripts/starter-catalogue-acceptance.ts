import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { application } from "../src/application.ts";

const evidence = "tmp/docs/handoffs/starter-catalogue-browser";
mkdirSync(evidence, { recursive: true });
let app: ReturnType<typeof application>;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.handle(request) });
app = application({ dataDir: mkdtempSync(evidence + "/data-"), hostPubkey: null, origin: server.url.origin, version: "starter-acceptance" });
app.db.run("UPDATE room SET admission='open' WHERE id=1");
const browser = await chromium.launch({ executablePath: process.env.FREEDOM_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const starters = [
  { title: "Cashu wallet", heading: "Cashu wallet" },
  { title: "Bush Bash Nostr", heading: "#bussobushbash" },
  { title: "Bitcoin spinner", heading: "Should I buy bitcoin?" },
  { title: "100 D6 rolls", heading: "100 D6 rolls" },
  { title: "21-sat Pong", heading: "21-sat Pong" },
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
    await expect(frame.getByRole("status")).toContainText("No wallet is connected", { timeout: 15000 });
    await expect(frame.getByText("Origin: null", { exact: false })).toBeVisible();
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
    await expect(frame.locator("#game")).toHaveClass(/hidden/);
    await frame.getByRole("button", { name: "Request 21-sat invoice" }).click();
    await expect(frame.locator("#invoiceBox")).not.toHaveClass(/hidden/, { timeout: 20000 });
    await expect(frame.getByRole("status")).toContainText("Pong remains locked");
    await expect(frame.locator("#pay")).toHaveAttribute("href", /^lightning:ln/i);
    await frame.locator("#verify").evaluate((button: HTMLButtonElement) => button.click());
    await expect(frame.getByRole("status")).toContainText("Pong stays locked");
    await expect(frame.locator("#game")).toHaveClass(/hidden/);
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
