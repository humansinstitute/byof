import { limits } from "../config.ts";
import { demand } from "../errors.ts";

export function validateGeneratedHtml(source: unknown): string {
  demand(typeof source === "string" && Buffer.byteLength(source) <= limits.sourceBytes, 400, "Generated source exceeds capacity");
  demand(/<html[\s>]/i.test(source) && /<\/html\s*>/i.test(source) && !source.includes("\0"), 400, "Generated HTML document required");
  // The browser CSP is the enforced network/host boundary; reject active embedding as well.
  demand(!/<(?:iframe|frame|object|embed|base)\b/i.test(source), 400, "Generated app must be self-contained");
  // A source citation is navigation, not a runtime resource. CSP remains the
  // enforced boundary for scripts, CSS, imports, fetches and dynamically built URLs.
  for (const tag of source.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const name=tag[1]!.toLowerCase();
    const attributes=tag[0].replace(/^<[^\s>]+/,'');
    demand(!/\b(?:src|srcset|poster|data)\s*=\s*(?:["']\s*)?(?:https?:|\/\/)/i.test(attributes) &&
      (name==='a' || !/\bhref\s*=\s*(?:["']\s*)?(?:https?:|\/\/)/i.test(attributes)),400,'Generated app must be self-contained');
  }
  return source;
}
