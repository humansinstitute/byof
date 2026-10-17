import { chromium, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { application } from '../src/application.ts';

// Isolated real workshop/API fixture; never mutates the live workshop or managed services.
const evidence = 'tmp/docs/handoffs/napplet-viewer-evidence';
mkdirSync(evidence, { recursive: true });
const secret = generateSecretKey();
const dataDir = mkdtempSync(evidence + '/fixture-');
const app = application({ dataDir, hostPubkey: getPublicKey(secret), origin: null, version: 'viewer-acceptance' });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.handle });
const browser = await chromium.launch({ executablePath: process.env.FREEDOM_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const checks: string[] = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('fixtureSign', (event: any) => finalizeEvent(event, secret));
    await page.addInitScript(() => { (window as any).nostr = { signEvent: (event: any) => (window as any).fixtureSign(event) }; });
    await page.goto(server.url.href);
    await page.getByRole('button', { name: 'Log in as admin' }).click();
    await page.getByLabel('Display name').fill('Viewer fixture host');
    await page.getByRole('button', { name: 'Log in with browser extension' }).click();
    await page.getByRole('button', { name: 'Make your mark' }).first().click();
    // Use a separate host-owned fork on the second viewport.
    if (viewport.width === 390) {
      await page.getByRole('button', { name: '← Workshop page', exact: true }).click();
      await page.getByRole('button', { name: 'Fork', exact: true }).click();
    } else await page.locator('.starter').filter({has:page.getByRole('heading',{name:'100 D6 rolls',exact:true})}).getByRole('button', { name: 'Use this starter' }).click();
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Go' }).click();
    await expect(frame.locator('#rolls span')).toHaveCount(100);
    let previewLoads = 0; page.on('request', request => { if (request.url().includes('/preview?')) previewLoads++; });
    const previewResponse = await page.request.get(new URL((await page.locator('iframe').getAttribute('src'))!, server.url).href);
    expect(previewResponse.headers()['content-security-policy']).toContain('connect-src https: wss:');
    const open = page.getByRole('button', { name: 'Open larger' });
    await open.click();
    const viewer = page.locator('.expanded-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await expect(viewer.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(frame.locator('#rolls span')).toHaveCount(100);
    expect(await viewer.evaluate(el => el.matches(':modal'))).toBe(true);
    await page.evaluate(() => window.postMessage({ type: 'freedom-preview-escape' }, '*'));
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await expect(viewer.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
    await frame.getByRole('button', { name: 'Go' }).click();
    await expect(frame.locator('#rolls span')).toHaveCount(100);
    await viewer.getByRole('button', { name: 'Exit full screen' }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(open).toBeFocused();
    await expect(frame.locator('#rolls span')).toHaveCount(100);
    expect(previewLoads).toBe(0);
    // Browser denial and missing API both take the viewport fallback.
    for (const mode of ['denied', 'unsupported']) {
      await open.click();
      await viewer.evaluate((el, mode) => { Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: mode === 'denied' ? () => Promise.reject(new Error('Fixture denial')) : undefined }); }, mode);
      await viewer.getByRole('button', { name: 'Full screen', exact: true }).click();
      await expect(viewer).toHaveClass(/viewport-fullscreen/);
      const bounds = await viewer.boundingBox();
      expect(bounds!.width).toBe(viewport.width); expect(bounds!.height).toBe(viewport.height);
      await viewer.getByRole('button', { name: 'Close', exact: true }).focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.expanded-viewer'))).toBe(true);
      await frame.getByRole('button', { name: 'Go' }).focus();
      await page.keyboard.press('Escape');
      await expect(viewer).not.toHaveClass(/viewport-fullscreen/);
      await expect(viewer).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.expanded-viewer')).toHaveCount(0);
      await expect(open).toBeFocused();
      await expect(frame.locator('#rolls span')).toHaveCount(100);
    }
    await page.evaluate(() => { delete (document.documentElement as any).requestFullscreen; });
    expect(previewLoads).toBe(0);
    expect(await page.locator('iframe').evaluate(el => el.getBoundingClientRect().height)).toBe(viewport.width === 390 ? 560 : 640);
    if (viewport.width === 1440) {
      await page.getByRole('button', { name: 'Add to workshop page' }).click();
      await page.getByRole('button', { name: 'Add this version' }).click();
    }
    await page.getByRole('button', { name: '← Workshop page', exact: true }).click();
    const tryApp = page.getByRole('button', { name: 'Try app', exact: true });
    await tryApp.click();
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('heading', { name: '100 D6 rolls', exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Go' })).toBeVisible();
    expect(await viewer.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(viewport.width * .9);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/${viewport.width}-gallery.png` });
    await page.keyboard.press('Escape');
    await expect(tryApp).toBeFocused();
    await expect(page.locator('.napplet-viewer')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    expect(errors).toEqual([]);
    checks.push(`${viewport.width}x${viewport.height}: builder/gallery, actual native fullscreen, denied/unsupported fallback, close/Escape, focus containment/return, no iframe reload, game state preserved, sandbox, sizing`);
    await page.close();
  }
  await Bun.write(`${evidence}/results.json`, JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ checks, evidence }));
} finally { await browser.close(); server.stop(true); app.db.close(); }
