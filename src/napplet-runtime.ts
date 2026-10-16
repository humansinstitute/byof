import client from '../templates/napplet-client.js' with { type: 'text' };
// Run before any app script. The injected code contains no identity or authority.
export function injectNappletBridge(source: string, documentId: string) {
  const script=`<script>${client.replace('__FREEDOM_DOCUMENT_ID__',JSON.stringify(documentId))}</script>`;
  // Preserve standards mode while executing before any generated app script.
  const doctype=source.match(/^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i);
  return doctype ? source.slice(0,doctype[0].length)+script+source.slice(doctype[0].length) : script+source;
}
