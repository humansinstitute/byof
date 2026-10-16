import { expect, test } from 'bun:test';

const source = await Bun.file('public/app.js').text();
const styles = await Bun.file('public/style.css').text();

test('manageable Canvas cogs use the registered workshop edit action and styling hook', () => {
  const workshopList = source.match(/function workshopsMarkup\(\).*$/m)?.[0] || '';
  expect(workshopList).toContain('w.canManage?');
  expect(workshopList).toContain('class="workshop-settings"');
  expect(workshopList).toContain('data-a="edit-workshop"');
  expect(workshopList).toContain('data-id="${esc(w.id)}"');
  expect(workshopList).toContain('aria-label="Edit ${esc(w.title)} Canvas"');
  expect(workshopList).not.toContain('edit-BYOF Canvas');
  expect(styles).toContain('.workshop-settings{');
});

test('workshop edit action checks authority and selects the clicked workshop before loading', () => {
  const handler = source.match(/if\(action==='edit-workshop'\)\{[^\n]+\}/)?.[0] || '';
  expect(handler).toContain("workshops.find(w=>w.id===id)?.canManage");
  expect(handler).toContain("throw Error('BYOF Canvas management access required')");
  expect(handler.indexOf('selectedWorkshop=id')).toBeLessThan(handler.indexOf('await page()'));
  expect(handler).toContain("screen='edit'");
});
