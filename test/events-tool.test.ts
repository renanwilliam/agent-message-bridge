import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { createOAuthAppConfig } from '../src/auth-runtime.js';
import { Bridge } from '../src/bridge.js';
import { createAuthenticator, privateConfigSchema, providerOAuthScopes } from '../src/config.js';
import { Events } from '../src/events.js';
import { MemoryStore } from '../src/memory-store.js';

const issuer='https://issuer.example.test';
const resource='https://bridge.example.test/bridge/mcp';
const metadataUrl='https://bridge.example.test/.well-known/oauth-protected-resource/bridge/mcp';
const messages=['messages:send','messages:read','messages:claim'];
const all=[...messages,'events:subscribe'];
const external=(scope:string)=>`${resource}/${scope}`;
const aliases=Object.fromEntries([...all,'history:read'].map(scope=>[external(scope),scope]));
const signing=await generateKeyPair('ES256');
const keys=createLocalJWKSet({keys:[{...await exportJWK(signing.publicKey),kid:'events-test',alg:'ES256'}]});
type Era='legacy'|'modern';
type Json=Record<string,any>;

async function token(client='event_client', scopes=messages.map(external), extra:Json={}) {
  const at=Math.floor(Date.now()/1000);
  return new SignJWT({sub:'shared_subject',client_id:client,iss:issuer,aud:resource,iat:at,exp:at+300,scope:scopes.join(' '),...extra})
    .setProtectedHeader({alg:'ES256',kid:'events-test'}).sign(signing.privateKey);
}

function fixture(scopeAliases:Record<string,string>=aliases) {
  const scopeNames=Object.keys(scopeAliases).length?messages.map(external).filter(scope=>Object.hasOwn(scopeAliases,scope)):messages;
  const config=privateConfigSchema.parse({scopeAliases,...(scopeNames.length?{advertisedScopes:scopeNames}:{}),clientSubjects:{
    event_client:{shared_subject:{id:'event_agent',tenant:'sample',scopes:all,peers:['peer'],eventAuthorizationEpoch:'1'}},
    peer_client:{shared_subject:{id:'peer',tenant:'sample',scopes:messages,peers:['event_agent']}},
    reader_client:{shared_subject:{id:'reader',tenant:'sample',scopes:['history:read'],peers:[],readParticipants:['event_agent']}},
  }});
  const authenticate=createAuthenticator(config,issuer,resource,`${issuer}/jwks`,keys);
  const store=new MemoryStore();
  let writes=0, posts=0;
  const commit=store.commit.bind(store);
  store.commit=async values=>{writes++;await commit(values);};
  const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:60000,webhookRecipients:[]});
  const events=new Events(store,async()=>{posts++;throw new Error('Unexpected outbound request');});
  const appConfig=createOAuthAppConfig(config,{
    OAUTH_ISSUER:issuer,OAUTH_TOKEN_PROFILE:'generic-jwt',OAUTH_AUDIENCE:resource,
    OAUTH_JWKS_URL:`${issuer}/jwks`,MCP_RESOURCE_URL:resource,
  });
  const app=createApp(bridge,events,{...appConfig,authenticate});
  return {app,events,authenticate,appConfig,config,counts:()=>({writes,posts})};
}

async function rpc(app:ReturnType<typeof createApp>,era:Era,method:string,bearer:string,params:Json={},headers:Record<string,string>={}) {
  const response=await app.fetch(new Request(resource,{
    method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',accept:'application/json, text/event-stream',
      'mcp-protocol-version':era==='modern'?'2026-07-28':'2025-03-26',
      ...(era==='modern'?{'mcp-method':method,...(method==='tools/call'?{'mcp-name':String(params.name)}:{})}:{}),...headers},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(era==='modern'?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}:{})}}),
  }));
  const raw=await response.text();
  const body=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?
    raw.split('\n').filter(line=>line.startsWith('data:')).at(-1)!.slice(5):raw) as Json;
  return {response,body};
}
const call=(args:Json={})=>({name:'bridge_list_events',arguments:args});

for(const era of ['legacy','modern'] as const) {
  test(`${era}: event catalog helper negotiates the existing scopes plus Events without side effects`,async()=>{
    const f=fixture();
    const bearer=await token();
    const {body:catalog}=await rpc(f.app,era,'tools/list',bearer);
    const helper=catalog.result.tools.find((tool:Json)=>tool.name==='bridge_list_events');
    assert.ok(helper);
    assert.equal(helper.inputSchema.type,'object');
    assert.deepEqual(helper.inputSchema.properties,{});
    assert.equal(helper.inputSchema.additionalProperties,false);
    assert.deepEqual(helper.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
    assert.deepEqual(helper._meta.securitySchemes,[{type:'oauth2',scopes:all.map(external)}]);
    const {response,body}=await rpc(f.app,era,'tools/call',bearer,call());
    assert.equal(response.status,200);
    assert.equal(body.error,undefined);
    assert.equal(body.result.isError,true);
    assert.equal(body.result.structuredContent,undefined);
    assert.deepEqual(body.result._meta['mcp/www_authenticate'],[
      `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="Authorize event discovery for this connection.", scope="${helper._meta.securitySchemes[0].scopes.join(' ')}"`,
    ]);
    assert.ok(!JSON.stringify(body).includes(bearer));
    const principal=await f.authenticate(new Request(resource,{headers:{authorization:`Bearer ${bearer}`}}));
    assert.equal(principal.canRequestEventScope,true);
    assert.deepEqual(principal.scopes,messages);
    const native=await rpc(f.app,era,'events/list',bearer);
    assert.equal(native.body.error.data.reason,'forbidden');
    assert.deepEqual(f.counts(),{writes:0,posts:0});
    assert.deepEqual(f.appConfig.advertisedScopes,messages.map(external));
    const prm=await f.app.fetch(new Request(metadataUrl));
    assert.deepEqual((await prm.json()).scopes_supported,messages.map(external));
    const sent=await rpc(f.app,era,'tools/call',bearer,{name:'bridge_send_message',arguments:{id:'synthetic_message',conversationId:'synthetic_conversation',recipient:'peer',text:'Synthetic message'}});
    assert.equal(sent.body.result.isError,undefined);
    const history=await rpc(f.app,era,'tools/call',bearer,{name:'bridge_read_history',arguments:{conversationId:'synthetic_conversation'}});
    assert.equal(history.body.result.isError,undefined);
    assert.equal(history.body.result.structuredContent.messages[0].text,'Synthetic message');
  });

  test(`${era}: sufficient scope returns the real catalog but does not activate a subscription`,async()=>{
    const f=fixture();
    const bearer=await token('event_client',all.map(external));
    const principal=await f.authenticate(new Request(resource,{headers:{authorization:`Bearer ${bearer}`}}));
    const {body}=await rpc(f.app,era,'tools/call',bearer,call());
    assert.equal(body.result.isError,undefined);
    assert.deepEqual(body.result.structuredContent,f.events.list(principal));
    assert.deepEqual(JSON.parse(body.result.content[0].text),f.events.list(principal));
    assert.equal(body.result._meta?.['mcp/www_authenticate'],undefined);
    const native=await rpc(f.app,era,'events/list',bearer);
    assert.deepEqual(body.result.structuredContent.events,native.body.result.events);
    const subscription=await rpc(f.app,era,'events/subscribe',bearer,{
      name:'message.received',arguments:{},delivery:{mode:'webhook',url:'https://callback.example.test/events',secret:`whsec_${Buffer.alloc(32,31).toString('base64')}`},
    });
    assert.equal(subscription.body.error.data.reason,'event_access_revoked');
    assert.deepEqual(f.counts(),{writes:0,posts:0});
  });

  test(`${era}: peer and reader cannot forge eligibility or trigger scope expansion`,async()=>{
    const f=fixture();
    for(const client of ['peer_client','reader_client']) {
      const bearer=await token(client,[...all,'history:read'].map(external),{canRequestEventScope:true,scopes:all});
      const headers={'x-can-request-event-scope':'true'};
      const principal=await f.authenticate(new Request(resource,{headers:{authorization:`Bearer ${bearer}`,...headers}}));
      assert.equal(principal.canRequestEventScope,false);
      assert.equal(principal.scopes.includes('events:subscribe'),false);
      const catalog=await rpc(f.app,era,'tools/list',bearer,{},headers);
      assert.equal(catalog.body.result.tools.some((tool:Json)=>tool.name==='bridge_list_events'),false);
      for(const args of [{},{canRequestEventScope:true,scopes:all}]) {
        const denied=await rpc(f.app,era,'tools/call',bearer,call(args),headers);
        assert.ok(denied.body.error || denied.body.result?.isError);
        assert.ok(!JSON.stringify(denied.body).includes('mcp/www_authenticate'));
      }
    }
    assert.deepEqual(f.counts(),{writes:0,posts:0});
  });

  test(`${era}: extra arguments and invalid authentication do not become upgrade prompts`,async()=>{
    const f=fixture();
    const forged=await rpc(f.app,era,'tools/call',await token(),call({canRequestEventScope:true}));
    assert.ok(forged.body.error || forged.body.result?.isError);
    assert.ok(!JSON.stringify(forged.body).includes('mcp/www_authenticate'));
    for(const extra of [{client_id:'unknown'},{sub:'unknown'},{aud:'https://other.example.test'},{exp:1}]) {
      const denied=await rpc(f.app,era,'tools/call',await token('event_client',all.map(external),extra),call());
      assert.equal(denied.response.status,401);
      assert.equal(denied.body.error,'unauthorized');
      assert.equal(denied.response.headers.get('www-authenticate'),`Bearer resource_metadata="${metadataUrl}"`);
    }
    assert.deepEqual(f.counts(),{writes:0,posts:0});
  });

  test(`${era}: operational errors stay errors and scope requests do not include unused grants`,async()=>{
    const f=fixture();
    const bearer=await token('event_client',[external('messages:read')]);
    const catalog=await rpc(f.app,era,'tools/list',bearer);
    const helper=catalog.body.result.tools.find((tool:Json)=>tool.name==='bridge_list_events');
    assert.deepEqual(helper._meta.securitySchemes[0].scopes,[external('messages:read'),external('events:subscribe')]);
    const challenge=await rpc(f.app,era,'tools/call',bearer,call());
    assert.ok(challenge.body.result._meta['mcp/www_authenticate'][0].endsWith(`scope="${helper._meta.securitySchemes[0].scopes.join(' ')}"`));
    f.events.list=()=>{throw new Error('SYNTHETIC_PRIVATE_FAILURE');};
    const failed=await rpc(f.app,era,'tools/call',await token('event_client',all.map(external)),call());
    assert.equal(failed.body.result.isError,true);
    assert.equal(failed.body.result.content[0].text,'internal_error');
    assert.equal(failed.body.result._meta?.['mcp/www_authenticate'],undefined);
    assert.ok(!JSON.stringify(failed.body).includes('SYNTHETIC_PRIVATE_FAILURE'));
    assert.deepEqual(f.counts(),{writes:0,posts:0});
  });
}

test('helper aliases fail closed without disabling message tools or exposing invalid scope strings',async()=>{
  const withoutEvents=Object.fromEntries(Object.entries(aliases).filter(([,internal])=>internal!=='events:subscribe'));
  for(const bad of [withoutEvents,{...aliases,'https://other.example.test/events':'events:subscribe'},
    ...['quote"scope','back\\slash','bad\u007Fscope','évents'].map(name=>({...withoutEvents,[name]:'events:subscribe'})),
    {...aliases,'https://other.example.test/read':'messages:read'},
  ]) {
    const f=fixture(bad);
    const bearer=await token();
    const catalog=await rpc(f.app,'modern','tools/list',bearer);
    assert.equal(catalog.body.error,undefined);
    assert.equal(catalog.body.result.tools.some((tool:Json)=>tool.name==='bridge_list_events'),false);
    assert.equal(catalog.body.result.tools.some((tool:Json)=>tool.name==='bridge_send_message'),true);
    const denied=await rpc(f.app,'modern','tools/call',bearer,call());
    assert.ok(denied.body.error || denied.body.result?.isError);
    assert.ok(!JSON.stringify(denied.body).includes('mcp/www_authenticate'));
    assert.deepEqual(f.counts(),{writes:0,posts:0});
    const sent=await rpc(f.app,'modern','tools/call',bearer,{name:'bridge_send_message',arguments:{id:'synthetic_message',conversationId:'synthetic_conversation',recipient:'peer',text:'Synthetic message'}});
    assert.equal(sent.body.result.isError,undefined);
    const history=await rpc(f.app,'modern','tools/call',bearer,{name:'bridge_read_history',arguments:{conversationId:'synthetic_conversation'}});
    assert.equal(history.body.result.structuredContent.messages[0].text,'Synthetic message');
  }
});

test('unaliased scopes remain supported and alias resolution is bounded and unambiguous',async()=>{
  const f=fixture({});
  const result=await rpc(f.app,'modern','tools/call',await token('event_client',messages),call());
  assert.ok(result.body.result._meta['mcp/www_authenticate'][0].endsWith(`scope="${all.join(' ')}"`));
  assert.deepEqual(providerOAuthScopes(aliases,[...all,'messages:read']),all.map(external));
  for(const [map,required] of [
    [{},['unrecognized']],
    [{[external('events:subscribe')]:'events:subscribe'},['messages:read','events:subscribe']],
    [{['x'.repeat(1025)]:'events:subscribe'},['events:subscribe']],
  ] as [Record<string,string>,string[]][])assert.throws(()=>providerOAuthScopes(map,required),/^Error: Invalid OAuth scope configuration$/);
  assert.equal(privateConfigSchema.safeParse({subjects:{synthetic:{id:'alpha',tenant:'sample',scopes:all,peers:[],canRequestEventScope:true}}}).success,false);
});
