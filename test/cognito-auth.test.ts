import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthenticator, privateConfigSchema } from '../src/config.js';
import { cognitoAuthorizationMetadata, oauthRuntimeSettings, validateCognitoEndpoints } from '../src/cognito-auth.js';
import { createOAuthAppConfig } from '../src/auth-runtime.js';
import { createApp } from '../src/app.js';
import { Bridge } from '../src/bridge.js';
import { Events } from '../src/events.js';
import { MemoryStore } from '../src/memory-store.js';
import { bootstrapApp } from '../src/activation.js';

const issuer='https://issuer-cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE';
const jwksUrl=`${issuer}/.well-known/jwks.json`;
const publicIssuer='https://bridge.example.test';
const resource=`${publicIssuer}/bridge/mcp`;
const loginOrigin='https://example-login.auth.us-east-1.amazoncognito.com';
const alpha={id:'alpha',tenant:'sample',scopes:['messages:send','messages:read'],peers:['beta']};
const reader={id:'reader',tenant:'sample',scopes:['history:read'],peers:[],readParticipants:['alpha']};
const config=privateConfigSchema.parse({
  subjects:{human:alpha},
  clientSubjects:{alpha_client:{human:alpha},reader_client:{human:reader}},
  scopeAliases:{'bridge/messages:send':'messages:send','bridge/messages:read':'messages:read','bridge/history:read':'history:read'},
  cognitoDiscovery:{loginOrigin},
});
const key=await generateKeyPair('RS256');
const jwk={...await exportJWK(key.publicKey),kid:'synthetic-rsa',alg:'RS256'};
const keys=createLocalJWKSet({keys:[jwk]});
const authenticate=createAuthenticator(config,issuer,resource,jwksUrl,keys,{profile:'cognito-access-token'});
async function signedRequest(overrides:Record<string,unknown>={}) {
  const at=Math.floor(Date.now()/1000);
  const token=await new SignJWT({iss:issuer,aud:resource,sub:'human',client_id:'alpha_client',token_use:'access',
    scope:'bridge/messages:read bridge/history:read',iat:at,exp:at+60,...overrides})
    .setProtectedHeader({kid:jwk.kid,alg:'RS256'}).sign(key.privateKey);
  return new Request(resource,{headers:{authorization:`Bearer ${token}`}});
}
test('Cognito access JWT enforces configured client/subject scope intersection',async()=>{
  const p=await authenticate(await signedRequest());
  assert.equal(p.id,'alpha');assert.deepEqual(p.scopes,['messages:read']);
  const human=await authenticate(await signedRequest({client_id:'reader_client'}));
  assert.equal(human.id,'reader');assert.deepEqual(human.scopes,['history:read']);assert.deepEqual(human.peers,[]);
});
test('Cognito SDK sign-in claims cannot read history without resource audience, bridge scope and private grant',async()=>{
  const store=new MemoryStore();
  const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:60000,webhookRecipients:[]});
  const message={id:'guarded_message',conversationId:'guarded_conversation',recipient:'beta',text:'Synthetic protected history'};
  await bridge.send(alpha,message);
  const events=new Events(store,async()=>{throw new Error('No callback expected');});
  const app=createApp(bridge,events,{resourceUrl:resource,issuer:publicIssuer,origins:[],callbacks:{},authenticate});
  const historyUrl=`${publicIssuer}/history?conversationId=${message.conversationId}`;
  const selfService='aws.cognito.signin.user.admin';
  for(const scenario of [
    {name:'SDK default claims',claims:{aud:undefined,scope:selfService},status:401,error:'unauthorized'},
    {name:'bridge scope without resource binding',claims:{aud:undefined,scope:'bridge/history:read'},status:401,error:'unauthorized'},
    {name:'resource audience without bridge scope',claims:{aud:resource,scope:selfService},status:403,error:'forbidden'},
  ]) {
    // Sign each shape with the trusted fixture key and a known client/subject.
    // Failures must come from claims/authorization, not a bad signature or bootstrap.
    const signed=await signedRequest({client_id:'reader_client',...scenario.claims});
    const response=await app.fetch(new Request(historyUrl,{headers:signed.headers}));
    assert.equal(response.status,scenario.status,scenario.name);
    assert.deepEqual(await response.json(),{error:scenario.error},scenario.name);
  }
  const noGrant=createAuthenticator(privateConfigSchema.parse({subjects:{human:reader},scopeAliases:config.scopeAliases}),issuer,resource,jwksUrl,keys,{profile:'cognito-access-token'});
  const noGrantApp=createApp(bridge,events,{resourceUrl:resource,issuer:publicIssuer,origins:[],callbacks:{},authenticate:noGrant});
  const authorizedClaims=await signedRequest({client_id:'reader_client',scope:'bridge/history:read'});
  const noMapping=await noGrantApp.fetch(new Request(historyUrl,{headers:authorizedClaims.headers}));
  assert.equal(noMapping.status,401);
  assert.deepEqual(await noMapping.json(),{error:'unauthorized'});
  const allowed=await app.fetch(new Request(historyUrl,{headers:authorizedClaims.headers}));
  assert.equal(allowed.status,200);
  const history=await allowed.json();
  assert.equal(history.messages.length,1);
  assert.equal(history.messages[0].id,message.id);
  assert.equal(history.messages[0].text,message.text);
});
test('Cognito self-service scope exposes no MCP tools and cannot publish despite a known identity and resource audience',async()=>{
  const store=new MemoryStore();
  const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:60000,webhookRecipients:[]});
  const events=new Events(store,async()=>{throw new Error('No callback expected');});
  const app=createApp(bridge,events,{resourceUrl:resource,issuer:publicIssuer,origins:[],callbacks:{},authenticate});
  const message={id:'scope_guard_message',conversationId:'scope_guard_conversation',recipient:'beta',text:'Synthetic authorized publication'};
  async function rpc(method:string,params:Record<string,unknown>,claims:Record<string,unknown>) {
    const signed=await signedRequest(claims);
    const headers=new Headers(signed.headers);
    headers.set('content-type','application/json');
    headers.set('accept','application/json, text/event-stream');
    headers.set('mcp-protocol-version','2026-07-28');
    headers.set('mcp-method',method);
    if(method==='tools/call')headers.set('mcp-name',String(params.name));
    const response=await app.fetch(new Request(resource,{method:'POST',headers,body:JSON.stringify({
      jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}},
    })}));
    const raw=await response.text();
    const payload=response.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean).at(-1)
      : raw;
    assert.ok(payload,'Expected a response envelope');
    return {status:response.status,body:JSON.parse(payload)};
  }
  const selfService={scope:'aws.cognito.signin.user.admin'};
  const noAudience=await rpc('tools/list',{}, {...selfService,aud:undefined});
  assert.equal(noAudience.status,401);
  assert.deepEqual(noAudience.body,{error:'unauthorized'});
  const principal=await authenticate(await signedRequest(selfService));
  assert.equal(principal.id,alpha.id);
  assert.deepEqual(principal.scopes,[]);
  const catalog=await rpc('tools/list',{},selfService);
  assert.equal(catalog.status,200);
  assert.deepEqual(catalog.body.result.tools,[]);
  const denied=await rpc('tools/call',{name:'bridge_send_message',arguments:message},selfService);
  assert.ok(denied.body.error || denied.body.result?.isError,'Self-service scope must not authorize sending');
  await assert.rejects(bridge.history(alpha,message.conversationId),/conversation_not_found/);
  const allowed=await rpc('tools/call',{name:'bridge_send_message',arguments:message},{scope:'bridge/messages:send'});
  assert.equal(allowed.status,200);
  assert.equal(allowed.body.error,undefined);
  assert.equal(allowed.body.result.isError,undefined);
  assert.equal(allowed.body.result.structuredContent.duplicate,false);
  const history=await bridge.history(alpha,message.conversationId);
  assert.equal(history.messages.length,1);
  assert.equal(history.messages[0]?.id,message.id);
});
test('Cognito rejects ID tokens, azp-only identity, other resources and malformed claims',async()=>{
  const at=Math.floor(Date.now()/1000);
  for(const overrides of [
    {token_use:'id'},{token_use:undefined},{client_id:undefined,azp:'alpha_client'},
    {client_id:'unregistered'},{client_id:''},{azp:'reader_client'},{sub:'unknown'},
    {iss:publicIssuer},{aud:'alpha_client'},{aud:undefined},{aud:[resource,'https://other.example.test']},
    {aud:[resource]},{scope:undefined},{scope:['bridge/messages:read']},{scope:''},
    {exp:at-1},{iat:undefined},
  ])await assert.rejects(authenticate(await signedRequest(overrides)),/unauthorized/,JSON.stringify(overrides));
});
test('Cognito never falls back to subject-only identity or another token algorithm',async()=>{
  const subjectOnly=createAuthenticator(privateConfigSchema.parse({subjects:{human:alpha}}),issuer,resource,jwksUrl,keys,{profile:'cognito-access-token'});
  await assert.rejects(subjectOnly(await signedRequest()),/unauthorized/);
  const ec=await generateKeyPair('ES256');const ecJwk={...await exportJWK(ec.publicKey),kid:'other-alg',alg:'ES256'};
  const verifier=createAuthenticator(config,issuer,resource,jwksUrl,createLocalJWKSet({keys:[ecJwk]}),{profile:'cognito-access-token'});
  const at=Math.floor(Date.now()/1000);
  const token=await new SignJWT({iss:issuer,aud:resource,sub:'human',client_id:'alpha_client',token_use:'access',scope:'bridge/messages:read',iat:at,exp:at+60})
    .setProtectedHeader({alg:'ES256',kid:'other-alg'}).sign(ec.privateKey);
  await assert.rejects(verifier(new Request(resource,{headers:{authorization:`Bearer ${token}`}})),/unauthorized/);
});
test('Cognito issuer and public keys are pinned to the same explicitly configured pool',()=>{
  assert.equal(validateCognitoEndpoints(issuer,jwksUrl).region,'us-east-1');
  for(const wrong of ['https://keys.example.test/jwks',jwksUrl.replace('EXAMPLE','OTHER'),`${jwksUrl}?url=other`,`${jwksUrl}#fragment`]) {
    assert.throws(()=>createAuthenticator(config,issuer,resource,wrong,keys,{profile:'cognito-access-token'}),/Cognito/);
  }
  assert.throws(()=>validateCognitoEndpoints('https://attacker.example.test/pool',jwksUrl),/Cognito/);
});
test('runtime keeps discovery issuer separate from trusted token issuer without guessing',()=>{
  assert.deepEqual(oauthRuntimeSettings({OAUTH_ISSUER:publicIssuer}),{issuer:publicIssuer,tokenIssuer:publicIssuer,profile:'generic-jwt'});
  assert.throws(()=>oauthRuntimeSettings({OAUTH_ISSUER:publicIssuer,OAUTH_TOKEN_PROFILE:'cognito-access-token'}),/explicit token issuer/);
  assert.throws(()=>oauthRuntimeSettings({OAUTH_ISSUER:publicIssuer,OAUTH_TOKEN_PROFILE:'try-any-token'}),/Invalid/);
  const settings={OAUTH_ISSUER:publicIssuer,OAUTH_TOKEN_ISSUER:issuer,OAUTH_TOKEN_PROFILE:'cognito-access-token',OAUTH_AUDIENCE:resource,OAUTH_JWKS_URL:jwksUrl,MCP_RESOURCE_URL:resource};
  const appConfig=createOAuthAppConfig(config,settings);
  assert.equal(appConfig.issuer,publicIssuer);assert.equal(appConfig.authorizationServerMetadata?.jwks_uri,jwksUrl);
  assert.throws(()=>createOAuthAppConfig(config,{...settings,OAUTH_AUDIENCE:'client_id'}),/audience/);
  assert.throws(()=>createOAuthAppConfig(config,{...settings,OAUTH_TOKEN_PROFILE:'generic-jwt'}),/Cognito discovery requires/);
});
test('static OAuth metadata supports a public client but does not pretend to provide DCR, CIMD or OIDC',async()=>{
  const metadata=cognitoAuthorizationMetadata({issuer:publicIssuer,tokenIssuer:issuer,jwksUrl,loginOrigin,resource,scopes:Object.keys(config.scopeAliases)});
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);
  assert.equal(metadata.token_endpoint,`${loginOrigin}/oauth2/token`);
  for(const absent of ['registration_endpoint','client_id_metadata_document_supported','authorization_response_iss_parameter_supported','userinfo_endpoint'])assert.equal(Object.hasOwn(metadata,absent),false);
  const store=new MemoryStore();const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:60000,webhookRecipients:[]});
  const events=new Events(store,async()=>{throw new Error('No callback expected');});
  const app=createApp(bridge,events,{resourceUrl:resource,issuer:publicIssuer,origins:[],callbacks:{},authenticate,authorizationServerMetadata:metadata});
  for(const path of ['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource/bridge/mcp']) {
    const response=await app.fetch(new Request(publicIssuer+path,{headers:{origin:'https://client.example.test'}}));
    assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'*');
    const options=await app.fetch(new Request(publicIssuer+path,{method:'OPTIONS',headers:{origin:'https://client.example.test','access-control-request-headers':'mcp-protocol-version'}}));
    assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-headers'),'content-type, mcp-protocol-version, authorization');
    assert.equal(options.headers.get('access-control-allow-credentials'),null);
    assert.equal((await app.fetch(new Request(publicIssuer+path,{method:'POST'}))).status,405);
    assert.equal((await bootstrapApp().fetch(new Request(publicIssuer+path))).status,503);
  }
  assert.equal((await app.fetch(new Request(`${publicIssuer}/.well-known/openid-configuration`))).status,401);
  const unauthorized=await app.fetch(new Request(resource));
  assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('www-authenticate')??'',/resource_metadata=/);
});

test('advertised subset is identical in application AS and PRM metadata without changing four/three/one-scope grants',async()=>{
  const messageScopes=['messages:send','messages:read','messages:claim'];
  const eventScopes=[...messageScopes,'events:subscribe'];
  const scopeAliases={
    'bridge/messages:send':'messages:send','bridge/messages:read':'messages:read','bridge/messages:claim':'messages:claim',
    'bridge/events:subscribe':'events:subscribe','bridge/history:read':'history:read',
  };
  const messageAliases=Object.keys(scopeAliases).slice(0,3);
  const grants={
    event_client:{human:{id:'event_agent',tenant:'sample',scopes:eventScopes,peers:['peer']}},
    peer_client:{human:{id:'peer',tenant:'sample',scopes:messageScopes,peers:['event_agent']}},
    viewer_client:{human:reader},
  };
  const base=privateConfigSchema.parse({scopeAliases,clientSubjects:grants,cognitoDiscovery:{loginOrigin},
    viewerOAuth:{authorizeUrl:`${loginOrigin}/oauth2/authorize`,tokenUrl:`${loginOrigin}/oauth2/token`,
      clientId:'viewer_client',redirectUri:`${publicIssuer}/viewer`,resource,scopes:['bridge/history:read'],authorizationResponseIssuerRequired:false},
  });
  const subset=privateConfigSchema.parse({...base,advertisedScopes:messageAliases});
  const settings={OAUTH_ISSUER:publicIssuer,OAUTH_TOKEN_ISSUER:issuer,OAUTH_TOKEN_PROFILE:'cognito-access-token',
    OAUTH_AUDIENCE:resource,OAUTH_JWKS_URL:jwksUrl,MCP_RESOURCE_URL:resource};
  for(const [selected,expected] of [[base,Object.keys(scopeAliases)],[subset,messageAliases]] as const) {
    const appConfig=createOAuthAppConfig(selected,settings);
    assert.deepEqual(appConfig.advertisedScopes,expected);
    assert.deepEqual(appConfig.authorizationServerMetadata?.scopes_supported,expected);
    assert.deepEqual(appConfig.viewerOAuth?.scopes,['bridge/history:read']);
    const store=new MemoryStore();
    const app=createApp(new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:60000,webhookRecipients:[]}),
      new Events(store,async()=>{throw new Error('No callback expected');}),appConfig);
    for(const path of ['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource/bridge/mcp']) {
      const response=await app.fetch(new Request(publicIssuer+path));
      assert.equal(response.status,200);
      assert.deepEqual((await response.json() as {scopes_supported:string[]}).scopes_supported,expected);
    }
  }
  assert.deepEqual(subset.scopeAliases,base.scopeAliases);
  assert.deepEqual(subset.clientSubjects,base.clientSubjects);
  const before=createAuthenticator(base,issuer,resource,jwksUrl,keys,{profile:'cognito-access-token'});
  const after=createAuthenticator(subset,issuer,resource,jwksUrl,keys,{profile:'cognito-access-token'});
  for(const [clientId,expected] of [['event_client',eventScopes],['peer_client',messageScopes],['viewer_client',['history:read']]] as const) {
    const allTokenScopes=await signedRequest({client_id:clientId,scope:Object.keys(scopeAliases).join(' ')});
    assert.deepEqual((await after(allTokenScopes.clone())).scopes,expected);
    assert.deepEqual(await after(allTokenScopes.clone()),await before(allTokenScopes));
    const messageOnlyToken=await signedRequest({client_id:clientId,scope:messageAliases.join(' ')});
    assert.deepEqual((await after(messageOnlyToken.clone())).scopes,expected.filter(scope=>messageScopes.includes(scope)));
    assert.deepEqual(await after(messageOnlyToken.clone()),await before(messageOnlyToken));
  }
  assert.deepEqual((await after(await signedRequest({client_id:'event_client',scope:'bridge/events:subscribe'}))).scopes,['events:subscribe']);
  assert.deepEqual((await after(await signedRequest({client_id:'viewer_client',scope:'bridge/history:read'}))).scopes,['history:read']);
});
