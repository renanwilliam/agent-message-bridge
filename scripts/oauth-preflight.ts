import { discoveryUrls, inspectOAuthMetadata } from '../src/oauth-discovery.js';

// Read-only operator CLI, not a server fetch API: read the operator-selected issuer's
// discovery. No authorization/token requests, credentials or grants are accepted.
const [issuer, method = 'none', ...extra] = process.argv.slice(2);
if (!issuer || extra.length || !['none', 'client_secret_basic', 'client_secret_post'].includes(method)) throw new Error('Usage: oauth-preflight.ts <https-issuer> [none|client_secret_basic|client_secret_post]');
const urls = discoveryUrls(issuer);
let found = false;
for (const url of urls) {
  try {
    const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) { await response.body?.cancel(); continue; }
    if (!response.ok || !response.body) throw new Error('metadata_unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) throw new Error('metadata_too_large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const result = inspectOAuthMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')), issuer, method);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.compatibleMetadata ? 0 : 1;
    found = true; break;
  } catch {
    // Do not print response bodies, cookies, headers or a remote error message.
    console.error('OAuth metadata preflight failed; no credentials or grants were created.');
    process.exitCode = 1; found = true; break;
  }
}
if (!found) { console.error('No OAuth discovery document found.'); process.exitCode = 1; }
