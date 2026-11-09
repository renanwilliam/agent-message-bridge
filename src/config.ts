import { z } from 'zod';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BridgeError, type Principal } from './types.js';
import { validateCognitoAccessClaims, validateCognitoEndpoints, type AuthenticatorOptions } from './cognito-auth.js';
import { isAdditionalAuthHeader } from './webhook-auth.js';

const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const subjectKey=z.string().min(1).max(1024);
const scopeKey=z.string().min(1).max(1024).regex(/^\S+$/);
const recipient=z.string().regex(/^[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$/);
const scopes=z.enum(['messages:send','messages:read','messages:claim','events:subscribe','history:read']);
function providerScopeNames(scopeAliases:Record<string,unknown>):string[] {
  const aliases=Object.keys(scopeAliases);
  return aliases.length>0?aliases:[...scopes.options];
}
const principal=z.object({
  id:identifier,tenant:identifier,scopes:z.array(scopes),peers:z.array(identifier),
  readParticipants:z.array(identifier).optional(),
  eventAuthorizationEpoch:z.string().regex(/^[1-9][0-9]{0,15}$/).optional(),
}).strict().refine(value=>value.readParticipants===undefined ||
  (value.scopes.length===1 && value.scopes[0]==='history:read' && value.peers.length===0),
  {message:'A history observer must have only history:read and no sending peers'});
const httpsUrl=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;});
const oauthEndpoint=httpsUrl.refine(value=>!new URL(value).search);
export const viewerOAuthSchema=z.object({
  authorizeUrl:oauthEndpoint,
  tokenUrl:oauthEndpoint,
  clientId:subjectKey,
  redirectUri:oauthEndpoint.refine(value=>new URL(value).pathname==='/viewer'),
  resource:oauthEndpoint,
  scopes:z.array(scopeKey).min(1).max(20),
  // Set from verified provider metadata, never from callback parameters.
  authorizationResponseIssuerRequired:z.boolean(),
}).strict();
export type ViewerOAuth=z.infer<typeof viewerOAuthSchema>;

/** Public browser configuration must name this service's exact protected resource. */
export function validateViewerOAuth(value:ViewerOAuth|undefined,resourceUrl:string,audience:string):ViewerOAuth|undefined {
  if(value===undefined)return undefined;
  try {
    const parsed=viewerOAuthSchema.parse(value);
    if(parsed.resource!==resourceUrl || parsed.resource!==audience ||
      new URL(parsed.redirectUri).origin!==new URL(resourceUrl).origin)throw new Error('mismatch');
    return parsed;
  } catch {throw new Error('Invalid viewer OAuth configuration');}
}

export const privateConfigSchema=z.object({
  // Each function receives its own secret. Missing capabilities default to none.
  subjects:z.record(subjectKey,principal).default({}),
  clientSubjects:z.record(subjectKey,z.record(subjectKey,principal)).default({}),
  scopeAliases:z.record(scopeKey,scopes).default({}),
  // Metadata disclosure only; token validation and principal grants use scopeAliases independently.
  advertisedScopes:z.array(scopeKey).min(1).max(20).refine(value=>new Set(value).size===value.length).optional(),
  viewerOAuth:viewerOAuthSchema.optional(),
  cognitoDiscovery:z.object({loginOrigin:oauthEndpoint}).strict().optional(),
  callbacks:z.record(identifier,z.object({secret:z.string().min(40),principal}).strict()).default({}),
  routes:z.record(recipient,z.object({url:httpsUrl,bearer:z.string().min(16),
    additionalAuthHeader:z.string().refine(isAdditionalAuthHeader,{message:'Invalid additional authentication header'}).optional(),
  }).strict()).default({}),
  webhookRecipients:z.array(recipient).default([]),
  origins:z.array(httpsUrl).default([]),
  // maxTurns is a deprecated compatibility input, never an enforcement limit.
  limits:z.object({maxTurns:z.number().int().min(2).max(1000).optional(),messagesPerMinute:z.number().int().min(1).max(1000).default(30),claimMs:z.number().int().min(1000).max(900000).default(120000),maxAttempts:z.number().int().min(1).max(20).default(8)}).default({messagesPerMinute:30,claimMs:120000,maxAttempts:8}),
}).strict().refine(value=>value.advertisedScopes===undefined ||
  value.advertisedScopes.every(scope=>providerScopeNames(value.scopeAliases).includes(scope)),
  {message:'Advertised scopes must be configured provider scope names',path:['advertisedScopes']});
export type PrivateConfig=z.infer<typeof privateConfigSchema>;

/** Public provider scope names, independent of private identity grants. */
export function advertisedOAuthScopes(config:Pick<PrivateConfig,'scopeAliases'|'advertisedScopes'>):string[] {
  return config.advertisedScopes?[...config.advertisedScopes]:providerScopeNames(config.scopeAliases);
}

/** Resolve requestable provider names without widening discovery or choosing ambiguous aliases. */
export function providerOAuthScopes(scopeAliases:Record<string,string>, requiredScopes:readonly string[]):string[] {
  const entries=Object.entries(scopeAliases);
  return [...new Set(requiredScopes)].map(scope=>{
    const candidates=entries.length?entries.filter(([,internal])=>internal===scope).map(([external])=>external):[scope];
    if(!scopes.options.includes(scope as typeof scopes.options[number]) || candidates.length!==1 ||
      !/^[\x21\x23-\x5B\x5D-\x7E]{1,1024}$/.test(candidates[0]!))throw new Error('Invalid OAuth scope configuration');
    return candidates[0]!;
  });
}

/** Never propagate parser diagnostics containing fragments of a secret document. */
export function parsePrivateConfig(raw:string):PrivateConfig {
  try { return privateConfigSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Invalid private configuration'); }
}
export function configuredWebhookRecipients(config:PrivateConfig):string[] {
  return [...new Set([...config.webhookRecipients,...Object.keys(config.routes)])];
}

export function createAuthenticator(config:PrivateConfig,issuer:string,audience:string,jwksUrl:string,keys?:JWTVerifyGetKey,options:AuthenticatorOptions={}) {
  const cognito=options.profile==='cognito-access-token';
  if(options.profile!==undefined && !['generic-jwt','cognito-access-token'].includes(options.profile)) throw new Error('Invalid token profile');
  if(cognito) {
    validateCognitoEndpoints(issuer,jwksUrl);
  }
  const jwks=keys??createRemoteJWKSet(new URL(httpsUrl.parse(jwksUrl)),{timeoutDuration:5000});
  return async(request:Request):Promise<Principal>=>{
    // Roles without HTTP grants (for example delivery) retain an inert verifier.
    if(cognito && !Object.keys(config.clientSubjects).length) throw new BridgeError('unauthorized',401);
    const bearer=request.headers.get('authorization');if(!bearer?.startsWith('Bearer '))throw new BridgeError('unauthorized',401);
    try {
      const {payload}=await jwtVerify(bearer.slice(7),jwks,{issuer,audience,algorithms:cognito?['RS256']:['RS256','ES256'],requiredClaims:['sub','exp','iat']});
      if(cognito)validateCognitoAccessClaims(payload,audience);
      if(typeof payload.sub!=='string' || !payload.sub) throw new Error('unknown subject');
      let subjects=config.subjects;
      if(Object.keys(config.clientSubjects).length>0) {
        const clientId=payload.client_id;
        const authorizedParty=payload.azp;
        if((clientId!==undefined && (typeof clientId!=='string' || !clientId)) ||
          (authorizedParty!==undefined && (typeof authorizedParty!=='string' || !authorizedParty)) ||
          (clientId!==undefined && authorizedParty!==undefined && clientId!==authorizedParty)) {
          throw new Error('invalid client identity');
        }
        const client=clientId??authorizedParty;
        if(typeof client!=='string' || !Object.hasOwn(config.clientSubjects,client)) throw new Error('unknown client');
        subjects=config.clientSubjects[client]!;
      }
      // A configured client namespace never falls back to a subject-only mapping.
      if(!Object.hasOwn(subjects,payload.sub)) throw new Error('unknown subject');
      const configured=subjects[payload.sub]!;
      const granted=typeof payload.scope==='string'?payload.scope.split(' '):[];
      const effective=new Set(granted.map(scope=>Object.hasOwn(config.scopeAliases,scope)?config.scopeAliases[scope]!:scope));
      return {...configured,scopes:configured.scopes.filter(scope=>effective.has(scope)),
        canRequestEventScope:configured.scopes.includes('events:subscribe')};
    } catch {throw new BridgeError('unauthorized',401);}
  };
}
let cache:{secretId:string;expires:number;value:PrivateConfig}|undefined;
export async function loadPrivateConfig():Promise<PrivateConfig> {
  const secretId=process.env.CONFIG_SECRET_ARN;if(!secretId)throw new Error('CONFIG_SECRET_ARN required');
  if(cache&&cache.secretId===secretId&&cache.expires>Date.now())return cache.value;
  const result=await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:secretId}));
  if(!result.SecretString)throw new Error('Configuration secret must be JSON text');
  const value=parsePrivateConfig(result.SecretString);
  cache={secretId,expires:Date.now()+60000,value};return value;
}
export function env(name:string) {const value=process.env[name];if(!value)throw new Error(`${name} required`);return value;}
