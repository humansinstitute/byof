import {expect,test} from 'bun:test';

test('stale accepted requests expose truthful same-result recovery UI',async()=>{
  const source=await Bun.file(new URL('../public/app.js',import.meta.url)).text();
  expect(source).toContain("button('recover-result','Recover result'");
  expect(source).toContain("retrying_delivery:'Recovery in progress'");
  expect(source).toContain("recovered:'Final message recovered'");
  expect(source).toContain('resends its retained signed result. It does not rerun the agent or start another build.');
  expect(source).toContain("action==='recover-result'");
  expect(source).toContain('/recover-result`');
  expect(source).toContain('Reply recovered · publication still required');
  expect(source).toContain('Reply recovered · publication failed');
  expect(source).toContain('the requested app change is not live. Publication is still required.');
});
