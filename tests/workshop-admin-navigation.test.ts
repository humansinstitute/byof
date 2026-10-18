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

test('Napplet edit affordances distinguish administrators from ordinary nonowners',()=>{
  const card=source.match(/function nappletCard\(p, own\) \{[\s\S]*?\n\}/)?.[0]||'';
  expect(card).toContain('canEdit=owner||me.host');
  expect(card).toContain("control(canEdit ? 'napplet-settings' : 'napplet-options'");
  const actions=source.match(/if \(action === 'napplet-settings' \|\| action === 'napplet-options'\) \{[\s\S]*?\n    \}/)?.[0]||'';
  expect(actions).toContain('canEdit=owner||me.host');
  expect(actions).toContain("owner?'Edit your Napplet!':'Edit Napplet as administrator'");
  expect(actions).toContain("if (action === 'napplet-settings' && !canEdit)");
  expect(source).toContain("canEdit=detail.permissions?.edit??own");
  expect(source).toContain("own ? 'Your project' : 'Administrator editing'");
  expect(source).toContain('Administrative changes are recorded under your account. Public publication consent remains with the Napplet owner.');
});

test('site-admin Napplet deletion is deliberately confirmed and only refreshes after server success',()=>{
  const actions=source.match(/if \(action === 'napplet-settings' \|\| action === 'napplet-options'\) \{[\s\S]*?\n    \}/)?.[0]||'';
  expect(actions).toContain("me.admin?button('confirm-napplet-delete','Delete Napplet'");
  expect(actions).not.toContain("owner?button('confirm-napplet-delete'");
  const confirmation=source.match(/if\(action==='confirm-napplet-delete'\)\{[\s\S]*?\n    \}/)?.[0]||'';
  expect(confirmation).toContain("if(!me.admin)throw Error('Site administrator access required')");
  expect(confirmation).toContain('data-title="${esc(p.title)}"');
  expect(confirmation).toContain('data-revision="${esc(p.current_revision)}"');
  expect(confirmation).toContain('External publication artifacts and native transcripts are not erased.');
  expect(confirmation).toContain('data-a="close">Cancel');
  const submission=source.match(/if\(event.target.id==='napplet-delete-form'\)\{[\s\S]*?\n    \}/)?.[0]||'';
  expect(submission).toContain("await api(`projects/${id}`");
  expect(submission.indexOf('await api')).toBeLessThan(submission.indexOf("$('#dialog').close()"));
  expect(submission.indexOf('await api')).toBeLessThan(submission.indexOf('await page()'));
  expect(source).toContain("event.target.id==='napplet-delete-form'?$('#napplet-delete-error')");
  expect(source).toContain("submit.disabled=event.target.value!==form.dataset.title");
});
