export const viewerAuthScript=String.raw`
const transactionKey='agent-message-bridge.viewer.pkce.v1',transactionTtl=600000;
let accessToken='',tokenExpiresAt=0,sessionVersion=0;
const listeners=new Set();
let snapshot={authenticated:false,busy:false,message:''};
function notify(){snapshot={...snapshot,authenticated:!!accessToken};for(const listener of listeners)listener()}
const status={set textContent(message){snapshot={...snapshot,message};notify()}};
const login={set disabled(busy){snapshot={...snapshot,busy};notify()}};
function clearToken(){sessionVersion++;accessToken='';tokenExpiresAt=0;notify()}
function discardTransaction(){try{sessionStorage.removeItem(transactionKey)}catch{}}
function randomValue(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return base64url(bytes)}
function base64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
async function startLogin(){
  clearToken();discardTransaction();login.disabled=true;status.textContent='Iniciando login…';
  try{
    const verifier=randomValue(),state=randomValue();
    const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const pending={verifier,state,createdAt:Date.now(),clientId:oauth.clientId,redirectUri:oauth.redirectUri,resource:oauth.resource,tokenUrl:oauth.tokenUrl,issuer:expectedIssuer,issuerRequired:oauth.authorizationResponseIssuerRequired};
    sessionStorage.setItem(transactionKey,JSON.stringify(pending));
    const url=new URL(oauth.authorizeUrl);
    const params={response_type:'code',client_id:oauth.clientId,redirect_uri:oauth.redirectUri,scope:oauth.scopes.join(' '),resource:oauth.resource,code_challenge_method:'S256',code_challenge:challenge,state};
    for(const [key,value]of Object.entries(params))url.searchParams.set(key,value);
    location.assign(url.href);
  }catch{discardTransaction();status.textContent='Não foi possível iniciar o login. Verifique o armazenamento do navegador e tente novamente.';login.disabled=false}
}
async function finishLogin(){
  if(!oauth)return;
  const current=new URL(location.href),q=current.searchParams;
  const callback=q.has('code')||q.has('state')||q.has('error')||current.hash;
  if(!callback){
    try{const saved=JSON.parse(sessionStorage.getItem(transactionKey)||'null');if(saved&&(!Number.isFinite(saved.createdAt)||Date.now()-saved.createdAt<0||Date.now()-saved.createdAt>transactionTtl))discardTransaction()}catch{discardTransaction()}
    return;
  }
  // Remove códigos e erros da URL antes de consultar o provedor.
  try{history.replaceState(null,'',oauth.redirectUri)}catch{discardTransaction();clearToken();status.textContent='Falha no login. Abra o endereço configurado do viewer.';return}
  clearToken();const version=sessionVersion;login.disabled=true;status.textContent='Concluindo login…';
  try{
    const raw=sessionStorage.getItem(transactionKey);discardTransaction();
    if(!raw||raw.length>4096)throw new Error('invalid transaction');
    const pending=JSON.parse(raw),age=Date.now()-pending.createdAt;
    if(current.origin+current.pathname!==oauth.redirectUri||current.hash||q.getAll('state').length!==1||
      !/^[A-Za-z0-9_-]{43}$/.test(pending.state)||q.get('state')!==pending.state||
      !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier)||!Number.isFinite(pending.createdAt)||age<0||age>transactionTtl||
      pending.clientId!==oauth.clientId||pending.redirectUri!==oauth.redirectUri||pending.resource!==oauth.resource||pending.tokenUrl!==oauth.tokenUrl||
      pending.issuer!==expectedIssuer||pending.issuerRequired!==oauth.authorizationResponseIssuerRequired||
      ((oauth.authorizationResponseIssuerRequired||q.has('iss'))&&(q.getAll('iss').length!==1||q.get('iss')!==expectedIssuer)))throw new Error('invalid transaction');
    if(q.has('error')||q.getAll('code').length!==1||!q.get('code')||q.get('code').length>8192)throw new Error('authorization failed');
    const body=new URLSearchParams({grant_type:'authorization_code',client_id:oauth.clientId,code:q.get('code'),redirect_uri:oauth.redirectUri,code_verifier:pending.verifier,resource:pending.resource});
    const response=await fetch(oauth.tokenUrl,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()});
    if(!response.ok)throw new Error('token exchange failed');
    const result=await response.json();
    if(typeof result.access_token!=='string'||!result.access_token||result.access_token.length>32768||
      typeof result.token_type!=='string'||result.token_type.toLowerCase()!=='bearer'||
      !Number.isFinite(result.expires_in)||result.expires_in<=0)throw new Error('invalid token response');
    if(version!==sessionVersion)return;
    accessToken=result.access_token;tokenExpiresAt=Date.now()+Math.min(result.expires_in,86400)*1000;
    // Tokens de refresh e identidade são descartados; nenhum token entra no armazenamento.
    status.textContent='Login concluído. Selecione uma conversa.';
  }catch{clearToken();status.textContent='Login inválido ou expirado. Entre novamente.'}
  finally{discardTransaction();login.disabled=false}
}

globalThis.bridgeSession={
  oauth:!!oauth,
  subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener)},
  getSnapshot(){return snapshot},
  getToken(){if(accessToken&&Date.now()>=tokenExpiresAt){clearToken();status.textContent='Sessão expirada. Entre novamente.'}return accessToken},
  setToken(value){if(oauth)return;clearToken();accessToken=value.trim();tokenExpiresAt=Infinity;status.textContent=accessToken?'Token informado.':''},
  startLogin,
  suspend(){clearToken()},
  clear(message='Sessão encerrada.'){clearToken();discardTransaction();status.textContent=message},
  ready:finishLogin()
};
`;
