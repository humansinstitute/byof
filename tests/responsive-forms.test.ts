import {test,expect} from 'bun:test';

const app=await Bun.file(new URL('../public/app.js',import.meta.url)).text();
const css=await Bun.file(new URL('../public/style.css',import.meta.url)).text();

test('invitation dialog keeps the Canvas Code between QR and selectable URL',()=>{
 const invite=app.match(/function activeInvitation\(invitation,opener=null\)\{[\s\S]*?\n\}/)![0];
 expect(invite).toContain('<span>Canvas Code</span>');
 expect(invite).not.toContain('BYOF Canvas code');
 expect(invite.indexOf('id="invite-qr"')).toBeLessThan(invite.indexOf('id="invite-code"'));
 expect(invite.indexOf('id="invite-code"')).toBeLessThan(invite.indexOf('id="invite-url"'));
 expect(invite).toContain('textarea id="invite-url"');
 expect(invite).toContain('readonly');
 expect(invite).toContain('class="field-action"');
 expect(invite).toContain('role="status" aria-live="polite"');
 expect(invite).toContain('does not expire automatically');
 expect(invite).toContain('Stop admitting');
 expect(invite).toContain('People already admitted keep access');
 expect(invite).not.toContain('24 hours');
});
test('invitation setup has bounded accessible quantity and honest lifecycle states',()=>{
 const setup=app.match(/function invitationSetup\(latest,opener=null\)\{[\s\S]*?\n\}/)![0];
 expect(setup).toContain('id="invitation-limit" type="number" min="1" max="50" step="1"');
 expect(setup).toContain('Allow up to 10 new people');
 expect(app).toContain("latest.status==='exhausted'");
 expect(app).toContain('People who already joined still have access');
});
test('copy feedback covers success and manual-copy recovery',()=>{
 const copy=app.match(/if\(action==='copy-invite-url'\)\{[\s\S]*?\n    \}/)![0];
 expect(copy).toContain("feedback.textContent='Invitation URL copied.'");
 expect(copy).toContain('Select the URL and copy it manually.');
 expect(copy).toContain('field.focus();field.select()');
});

test('shared dialog and field-action rules prevent narrow viewport collisions',()=>{
 expect(css).toContain('max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain');
 expect(css).toContain('.field-action{display:grid;grid-template-columns:minmax(0,1fr) auto');
 expect(css).toContain('.field-action{grid-template-columns:1fr}');
 expect(css).toContain('.field-action>button{width:100%;min-width:0}');
 expect(css).toContain('.dialog-actions{align-items:stretch;flex-direction:column}');
});
