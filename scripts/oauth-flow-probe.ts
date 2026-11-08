import { readFile } from 'node:fs/promises';
import { planOAuthFlowProbe } from '../src/oauth-flow-probe.js';

// This entry point cannot execute live OAuth flows. The library requires an
// independently authorized callback driver, transport and JWT verifier.
try {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (mode !== '--plan' || !file || extra.length) throw new Error('invalid arguments');
  const raw = await readFile(file, 'utf8');
  if (Buffer.byteLength(raw) > 65536) throw new Error('oversized profile');
  console.log(JSON.stringify(planOAuthFlowProbe(JSON.parse(raw)), null, 2));
} catch {
  console.error('OAuth flow probe plan rejected. Usage: oauth-flow-probe.ts --plan <public-profile.json>. No network request was made.');
  process.exitCode = 1;
}
