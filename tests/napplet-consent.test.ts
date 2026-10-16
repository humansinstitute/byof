import { expect, test } from 'bun:test';

const canvasSource = await Bun.file('public/canvas-host.js').text();
const datasetDisplayName: (name: string) => string = new Function(
  canvasSource.slice(0, canvasSource.indexOf('export function canvasDomain')).replaceAll('export ', '') + ';return datasetDisplayName;',
)();

test('dataset permission language turns technical names into friendly titles', () => {
  expect(datasetDisplayName('anonymous-troll-box')).toBe('Anonymous Troll Box');
  expect(datasetDisplayName('shared_notes')).toBe('Shared Notes');
});

test('dataset permission keeps technical identifiers behind details', async () => {
  const source = await Bun.file('public/napplet-host.js').text();
  expect(source).toContain("`Open ${datasetLabel}?`");
  expect(source).toContain("label.textContent=kind==='dataset'?'Technical details':'Inspect app binding'");
  expect(source).toContain("kind==='dataset'?details.append(pre):dialog.append(pre)");
  expect(source).toContain("deny.textContent=kind==='dataset'?'Not now':'Deny'");
  expect(source).toContain("allow.textContent=kind==='dataset'?'Open'");
});
