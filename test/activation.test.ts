import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapApp,bootstrapMode} from '../src/activation.js';
import {runtime} from '../src/runtime.js';
test('bootstrap activation flag is explicit and rejects malformed deployment configuration',()=>{
 assert.equal(bootstrapMode('true'),true);assert.equal(bootstrapMode('false'),false);assert.equal(bootstrapMode(undefined),false);
 for(const invalid of ['TRUE','1','', 'yes'])assert.throws(()=>bootstrapMode(invalid));
});
test('bootstrap runtime starts without reading configuration secrets or requiring OAuth credentials',async()=>{
 const names=['BOOTSTRAP_MODE','INSTALLATION_ID','TABLE_NAME','CONFIG_SECRET_ARN','MCP_RESOURCE_URL','OAUTH_ISSUER','OAUTH_AUDIENCE','OAUTH_JWKS_URL'];
 const saved=new Map(names.map(name=>[name,process.env[name]]));
 try {
  for(const name of names)delete process.env[name];
  Object.assign(process.env,{BOOTSTRAP_MODE:'true',INSTALLATION_ID:'fixture',TABLE_NAME:'fixture-table'});
  const {app}=await runtime();
  const response=await app.fetch(new Request('https://bridge.example/bridge/mcp'));
  assert.equal(response.status,503);
 } finally {
  for(const [name,value] of saved)if(value===undefined)delete process.env[name];else process.env[name]=value;
 }
});
test('infrastructure-only bootstrap never authenticates, issues metadata or accepts inbound messages',async()=>{
 const app=bootstrapApp();
 for(const path of ['/bridge/mcp','/peer','/history','/viewer','/.well-known/oauth-protected-resource/bridge/mcp']){
  const response=await app.fetch(new Request('https://bridge.example'+path,{method:'POST',headers:{authorization:'Bearer synthetic-invalid-token'},body:'{"method":"tools/call"}'}));
  assert.equal(response.status,503);assert.equal(response.headers.get('www-authenticate'),null);
  assert.deepEqual(await response.json(),{error:'integration_not_configured',status:'infrastructure_only'});
 }
});
