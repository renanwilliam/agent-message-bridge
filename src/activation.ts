/** Infrastructure may be provisioned before any connector or credential is authorized. */
export function bootstrapMode(value:string|undefined):boolean {
  if(value===undefined||value==='false')return false;
  if(value==='true')return true;
  throw new Error('BOOTSTRAP_MODE must be true or false');
}
export function bootstrapApp() {
  return {async fetch(_request:Request):Promise<Response>{
    return Response.json({error:'integration_not_configured',status:'infrastructure_only'},{status:503,headers:{'cache-control':'no-store'}});
  }};
}
