import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { demand } from "./errors.ts";
import { limits } from "./config.ts";
export const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export class Assets {
  constructor(private root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); }
  put(source: string): string {
    demand(Buffer.byteLength(source) <= limits.sourceBytes, 413, "App source exceeds capacity");
    demand(source.includes("<html") && !source.includes("\0"), 400, "Expected a self-contained HTML app");
    return this.putBytes(new TextEncoder().encode(source));
  }
  putBytes(source: Uint8Array): string {
    demand(source.byteLength <= limits.sourceBytes, 413, "Asset exceeds capacity");
    const hash = sha256(source), path = join(this.root, hash), temporary = join(this.root, `.write-${crypto.randomUUID()}`);
    writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, path); } catch (error: any) { if (error.code !== "EEXIST") throw error; } finally { unlinkSync(temporary); }
    demand(sha256(readFileSync(path)) === hash, 500, "Immutable asset hash mismatch");
    return hash;
  }
  getBytes(hash: string): Uint8Array { demand(/^[a-f0-9]{64}$/.test(hash), 400, "Invalid asset reference"); const bytes = readFileSync(join(this.root, hash)); demand(sha256(bytes) === hash, 500, "Asset integrity check failed"); return bytes; }
  get(hash: string): string { return Buffer.from(this.getBytes(hash)).toString(); }
}
export const previewPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src 'none'; connect-src https: wss:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms";
