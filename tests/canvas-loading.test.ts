import { expect, test } from 'bun:test';

const source = await Bun.file('public/app.js').text();

test('opening a known Canvas does not refetch the Canvas list before its room', () => {
  const page = source.match(/async function page\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  expect(page).toContain("Promise.all([api('room'),workshops.length?Promise.resolve(null):api('workshops')])");
  expect(page.indexOf("state=room")).toBeGreaterThan(page.indexOf('Promise.all'));
});

test('Canvas Napplet frames defer loading until visible and minimized frames stay dormant', () => {
  expect(source).toContain('iframe data-napplet');
  expect(source).toContain('data-src="${esc(source)}"');
  expect(source).toContain("new IntersectionObserver");
  expect(source).toContain("rootMargin:'160px'");
  expect(source).toContain('maxConcurrentNappletLoads=3');
  expect(source).toContain('activeNappletLoads<maxConcurrentNappletLoads');
  expect(source).toContain("minimized ? 'inert aria-hidden=\"true\"' : ''");
  expect(source).toContain("revision ? viewerMarkup");
  expect(source).toContain('armVisibleNapplets();');
});

test('room refresh patching preserves an already loaded deferred frame', () => {
  expect(source).toContain("match.tagName==='IFRAME'&&['src','data-loading','data-loaded','data-cache-hit','data-runtime-url','data-runtime-binding','data-runtime-ready'].includes(attr.name)&&next.dataset.src===match.dataset.src");
});
