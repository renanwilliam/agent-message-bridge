import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { advertisedOAuthScopes, createAuthenticator, configuredWebhookRecipients, validateViewerOAuth, parsePrivateConfig, privateConfigSchema } from '../src/config.js';

const agent={id:'alpha',tenant:'team',scopes:['messages:send','messages:read','messages:claim'],peers:['beta']};
const observer={id:'reader',tenant:'team',scopes:['history:read'],peers:[],readParticipants:['alpha']};
const route={url:'https://recipient.example.test/wake',bearer:'synthetic-test-bearer'};
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;

test('role-specific configurations default omitted privileges and credentials to none',()=>{
  const empty=parsePrivateConfig('{}');
  assert.deepEqual(empty.subjects,{});
  assert.deepEqual(empty.clientSubjects,{});
  assert.deepEqual(empty.scopeAliases,{});
  assert.deepEqual(empty.callbacks,{});
  assert.deepEqual(empty.routes,{});
  assert.deepEqual(empty.webhookRecipients,[]);
  const configurations={
    mcp:{subjects:{alpha:agent},webhookRecipients:['team:beta']},
    ingress:{callbacks:{peer_alpha:{secret,principal:agent}},webhookRecipients:['team:beta']},
    delivery:{routes:{'team:beta':route}},
    history:{subjects:{reader:observer}},
  };
  for(const [role,value] of Object.entries(configurations)) {
    const parsed=parsePrivateConfig(JSON.stringify(value));
    if(role!=='ingress')assert.deepEqual(parsed.callbacks,{});
    if(role!=='delivery')assert.deepEqual(parsed.routes,{});
    if(role==='ingress'||role==='delivery')assert.deepEqual(parsed.subjects,{});
  }
});

test('advertised OAuth scopes use exact provider aliases or the unaliased bridge contract',()=>{
  assert.deepEqual(advertisedOAuthScopes({scopeAliases:{}}),['messages:send','messages:read','messages:claim','events:subscribe','history:read']);
  assert.deepEqual(advertisedOAuthScopes({scopeAliases:{'bridge/read':'messages:read','bridge/observe':'history:read'}}),['bridge/read','bridge/observe']);
});

test('optional advertised scopes are a unique bounded subset of exact external scope names',()=>{
  const scopeAliases={'bridge/read':'messages:read','bridge/events':'events:subscribe'};
  const parsed=privateConfigSchema.parse({scopeAliases,advertisedScopes:['bridge/read']});
  assert.deepEqual(advertisedOAuthScopes(parsed),['bridge/read']);
  assert.deepEqual(parsed.scopeAliases,scopeAliases);
  assert.deepEqual(advertisedOAuthScopes(privateConfigSchema.parse({advertisedScopes:['messages:read']})),['messages:read']);
  const returned=advertisedOAuthScopes(parsed);returned.push('untrusted');
  assert.deepEqual(parsed.advertisedScopes,['bridge/read']);
  for(const advertisedScopes of [[],['bridge/read','bridge/read'],['unknown'],['messages:read'],['bridge/read bridge/events']]) {
    assert.equal(privateConfigSchema.safeParse({scopeAliases,advertisedScopes}).success,false);
  }
  assert.equal(privateConfigSchema.safeParse({advertisedScopes:['unknown']}).success,false);
  const manyAliases=Object.fromEntries(Array.from({length:21},(_,i)=>[`external/scope${i}`,'messages:read']));
  assert.equal(privateConfigSchema.safeParse({scopeAliases:manyAliases,advertisedScopes:Object.keys(manyAliases).slice(0,20)}).success,true);
  assert.equal(privateConfigSchema.safeParse({scopeAliases:manyAliases,advertisedScopes:Object.keys(manyAliases)}).success,false);
  assert.throws(()=>parsePrivateConfig(JSON.stringify({advertisedScopes:['SYNTHETIC_UNKNOWN_SCOPE']})),/^Error: Invalid private configuration$/);
});

test('private configuration parsing never exposes invalid input or validation causes',()=>{
  const marker='SYNTHETIC_SECRET_MUST_NOT_APPEAR';
  for(const raw of [
    `${marker}{`,
    JSON.stringify({routes:{'team:beta':{url:marker,bearer:marker}}}),
    JSON.stringify({subjects:{[marker]:{...agent,scopes:[marker]}}}),
    JSON.stringify({[marker]:true}),
  ]) {
    assert.throws(()=>parsePrivateConfig(raw),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.equal(error.message,'Invalid private configuration');
      assert.equal(Object.hasOwn(error,'cause'),false);
      assert.equal(Object.hasOwn(error,'issues'),false);
      assert.ok(!String(error.stack).includes(marker));
      assert.ok(!JSON.stringify(error).includes(marker));
      return true;
    });
  }
});

test('recipient routing remains tenant-qualified and deduplicates the explicit list with route keys',()=>{
  const config=parsePrivateConfig(JSON.stringify({
    webhookRecipients:['first:beta','second:beta','first:beta'],
    routes:{'first:beta':route,'third:gamma':route},
  }));
  assert.deepEqual(configuredWebhookRecipients(config),['first:beta','second:beta','third:gamma']);
  const explicitOnly=parsePrivateConfig('{"webhookRecipients":["first:beta"]}');
  assert.deepEqual(configuredWebhookRecipients(explicitOnly),['first:beta']);
  assert.deepEqual(explicitOnly.routes,{});
});

test('route keys and explicit recipient entries reject malformed identities and extra fields',()=>{
  for(const key of ['beta',':beta','team:','team:beta:extra','team space:beta',`${'x'.repeat(101)}:beta`]) {
    assert.equal(privateConfigSchema.safeParse({routes:{[key]:route}}).success,false,key);
    assert.equal(privateConfigSchema.safeParse({webhookRecipients:[key]}).success,false,key);
  }
  assert.equal(privateConfigSchema.safeParse({routes:{'team:beta':{...route,unexpected:true}}}).success,false);
  assert.equal(privateConfigSchema.safeParse({callbacks:{peer:{secret,principal:agent,unexpected:true}}}).success,false);
  assert.equal(privateConfigSchema.safeParse({subjects:{alpha:{...agent,unexpected:true}}}).success,false);
});

test('optional extra credential header accepts only bounded custom names outside reserved namespaces',()=>{
  const parse=(additionalAuthHeader:unknown)=>privateConfigSchema.safeParse({routes:{'team:beta':{...route,additionalAuthHeader}}});
  for(const name of [undefined,'X-Webhook-Key','x-api-key','X-'+ 'a'.repeat(62)])assert.equal(parse(name).success,true);
  for(const name of ['',null,42,'Authorization','Host','Content-Length','Idempotency-Key','X-Key\r\nInjected','X-Key\n',
    'X-Key:Value','X-Key Value','X_Auth','X--Auth','X-é','X-','X-'+ 'a'.repeat(63),
    'X-MCP-Subscription-Id','x-bridge-key-id','X-Amz-Security-Token','X-Amzn-Trace-Id','X-Forwarded-For',
    'X-Real-IP','x-original-url','X-Rewrite-URL','X-HTTP-Method-Override','X-Method-Override','X-Host',
    'X-Request-ID','X-Correlation-ID','X-Idempotency-Key'])assert.equal(parse(name).success,false,String(name));
  assert.equal(privateConfigSchema.parse({routes:{'team:beta':route}}).routes['team:beta']!.additionalAuthHeader,undefined);
});

test('an observer cannot mix delegated history access with agent mutations or peer routes',()=>{
  assert.equal(privateConfigSchema.safeParse({subjects:{reader:observer}}).success,true);
  for(const principal of [
    {...observer,scopes:['history:read','messages:send']},
    {...observer,scopes:['history:read','messages:claim']},
    {...observer,scopes:['history:read','events:subscribe']},
    {...observer,peers:['beta']},
    {...observer,scopes:[]},
  ])assert.equal(privateConfigSchema.safeParse({subjects:{reader:principal}}).success,false);
});


const testIssuer='https://issuer.example.test';
const testAudience='https://bridge.example.test/bridge/mcp';
const signing=await generateKeyPair('ES256');
const signingJwk={...await exportJWK(signing.publicKey),kid:'ephemeral-test-key',alg:'ES256'};
const testKeys=createLocalJWKSet({keys:[signingJwk]});
async function signedRequest(claims:Record<string,unknown>={}) {
  const at=Math.floor(Date.now()/1000);
  const bearer=await new SignJWT({sub:'shared_subject',iss:testIssuer,aud:testAudience,iat:at,exp:at+300,scope:'messages:send messages:read messages:claim',...claims})
    .setProtectedHeader({alg:'ES256',kid:signingJwk.kid}).sign(signing.privateKey);
  return new Request(testAudience,{headers:{authorization:`Bearer ${bearer}`}});
}
function scopedAuthenticator(extra:Record<string,unknown>={}) {
  const config=privateConfigSchema.parse({
    subjects:{shared_subject:observer,fallback_subject:agent},
    clientSubjects:{
      client_alpha:{shared_subject:agent},
      client_beta:{shared_subject:{...agent,id:'beta',peers:['alpha']}},
    },
    ...extra,
  });
  return createAuthenticator(config,testIssuer,testAudience,`${testIssuer}/jwks`,testKeys);
}

test('client mappings segregate one human subject into distinct authenticated agent principals',async()=>{
  const authenticate=scopedAuthenticator();
  const alpha=await authenticate(await signedRequest({client_id:'client_alpha'}));
  const beta=await authenticate(await signedRequest({azp:'client_beta'}));
  assert.equal(alpha.id,'alpha');
  assert.deepEqual(alpha.peers,['beta']);
  assert.equal(beta.id,'beta');
  assert.deepEqual(beta.peers,['alpha']);
  const consistent=await authenticate(await signedRequest({client_id:'client_beta',azp:'client_beta'}));
  assert.equal(consistent.id,'beta');
});

test('event authorization epochs are bounded configuration values and do not grant additional scopes',async()=>{
  const configured={...agent,eventAuthorizationEpoch:'1'};
  const authenticate=scopedAuthenticator({clientSubjects:{client_alpha:{shared_subject:configured}}});
  const principal=await authenticate(await signedRequest({client_id:'client_alpha',eventAuthorizationEpoch:'2'}));
  assert.equal(principal.eventAuthorizationEpoch,'1');
  assert.deepEqual(principal.scopes,agent.scopes);
  assert.equal(principal.scopes.includes('events:subscribe'),false);
  for(const eventAuthorizationEpoch of ['', '0', '01', '-1', '1.0', '1'.repeat(17), 'epoch_1', 'with space', 1]) {
    assert.equal(privateConfigSchema.safeParse({subjects:{alpha:{...agent,eventAuthorizationEpoch}}}).success,false);
  }
  assert.equal(privateConfigSchema.safeParse({subjects:{alpha:{...agent,eventAuthorizationEpoch:'9'.repeat(16)}}}).success,true);
  assert.equal(privateConfigSchema.safeParse({subjects:{alpha:agent,reader:observer}}).success,true);
});

test('client mode rejects missing, unknown or conflicting claims and never falls back to subjects',async()=>{
  const authenticate=scopedAuthenticator();
  for(const claims of [
    {},{client_id:'unknown'},{azp:'unknown'},
    {client_id:'client_alpha',azp:'client_beta'},
    {client_id:'',azp:'client_alpha'},
    {client_id:123,azp:'client_alpha'},
    {client_id:'client_alpha',azp:null},
    {client_id:'client_alpha',sub:'fallback_subject'},
    {client_id:'toString'},
    {client_id:'client_alpha',sub:'toString'},
  ])await assert.rejects(authenticate(await signedRequest(claims)),/unauthorized/,JSON.stringify(claims));
  // Client IDs identify a namespace; they never replace the JWT resource audience.
  for(const aud of [undefined,'client_alpha','https://wrong.example.test']) {
    await assert.rejects(authenticate(await signedRequest({client_id:'client_alpha',aud})),/unauthorized/);
  }
});

test('scope aliases map exact token scope strings and cannot exceed the mapped principal grant',async()=>{
  const authenticate=scopedAuthenticator({scopeAliases:{
    'service/read':'messages:read',
    'service/write':'messages:send',
    'service/observe':'history:read',
  }});
  const mapped=await authenticate(await signedRequest({client_id:'client_alpha',scope:'service/read service/write service/observe'}));
  assert.deepEqual(mapped.scopes,['messages:send','messages:read']);
  const unknown=await authenticate(await signedRequest({client_id:'client_alpha',scope:'other/read service/read-extra service/write/extra'}));
  assert.deepEqual(unknown.scopes,[]);
  const direct=await authenticate(await signedRequest({client_id:'client_alpha',scope:'messages:claim service/read service/read'}));
  assert.deepEqual(direct.scopes,['messages:read','messages:claim']);
  const absent=await authenticate(await signedRequest({client_id:'client_alpha',scope:undefined}));
  assert.deepEqual(absent.scopes,[]);
});

test('empty client mapping retains explicit subject behavior and validates alias configuration',async()=>{
  const authenticate=scopedAuthenticator({clientSubjects:{},subjects:{shared_subject:agent}});
  assert.equal((await authenticate(await signedRequest())).id,'alpha');
  assert.equal((await authenticate(await signedRequest({client_id:'unmapped-legacy-client'}))).id,'alpha');
  for(const invalid of [
    {scopeAliases:{'service/read':'admin:all'}},
    {scopeAliases:{'two scopes':'messages:read'}},
    {scopeAliases:{'':'messages:read'}},
    {clientSubjects:{client_alpha:{shared_subject:{...agent,scopes:['admin:all']}}}},
  ])assert.equal(privateConfigSchema.safeParse(invalid).success,false);
});


test('optional viewer OAuth configuration is public-only and binds to the exact viewer and resource',()=>{
  const viewer={authorizeUrl:'https://login.example.test/oauth2/authorize',tokenUrl:'https://login.example.test/oauth2/token',clientId:'public-reader',redirectUri:'https://bridge.example.test/viewer',resource:'https://bridge.example.test/bridge/mcp',scopes:['bridge/history:read'],authorizationResponseIssuerRequired:true};
  const parsed=privateConfigSchema.parse({viewerOAuth:viewer});
  assert.deepEqual(parsed.viewerOAuth,viewer);
  assert.equal(privateConfigSchema.parse({}).viewerOAuth,undefined);
  assert.deepEqual(validateViewerOAuth(viewer,viewer.resource,viewer.resource),viewer);
  assert.equal(privateConfigSchema.parse({viewerOAuth:{...viewer,authorizationResponseIssuerRequired:false}}).viewerOAuth?.authorizationResponseIssuerRequired,false);
  for(const invalid of [
    {...viewer,clientSecret:'must-never-be-accepted'},
    {...viewer,client_secret:'must-never-be-accepted'},
    {...viewer,authorizeUrl:'http://login.example.test/authorize'},
    {...viewer,tokenUrl:'https://user:password@login.example.test/token'},
    {...viewer,tokenUrl:'https://login.example.test/token?secret=value'},
    {...viewer,redirectUri:'https://bridge.example.test/callback'},
    {...viewer,redirectUri:'https://bridge.example.test/viewer?other=true'},
    {...viewer,scopes:[]},
    {...viewer,scopes:['two scopes']},
    {...viewer,authorizationResponseIssuerRequired:undefined},
    {...viewer,authorizationResponseIssuerRequired:'false'},
  ])assert.equal(privateConfigSchema.safeParse({viewerOAuth:invalid}).success,false);
  assert.throws(()=>validateViewerOAuth(viewer,viewer.resource,'different-audience'),/Invalid viewer OAuth configuration/);
  assert.throws(()=>validateViewerOAuth({...viewer,redirectUri:'https://other.example.test/viewer'},viewer.resource,viewer.resource),/Invalid viewer OAuth configuration/);
});
