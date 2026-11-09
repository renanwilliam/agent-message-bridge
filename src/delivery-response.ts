/** A successful HTTP envelope can still contain a failed MCP operation.
 * Empty/non-JSON callback responses remain valid transport receipts, not processing evidence.
 * Never persist or log arbitrary response text.
 */
export function mcpResponseFailed(body:string):boolean {
  let parsed:unknown;
  try { parsed=JSON.parse(body); } catch { return false; }
  const failed=(value:unknown):boolean=>{
    if(!value || typeof value!=='object' || Array.isArray(value))return false;
    const row=value as Record<string,unknown>;
    const object=(item:unknown):item is Record<string,unknown>=>!!item && typeof item==='object' && !Array.isArray(item);
    // A generic webhook receipt may use fields named error/isError for other purposes.
    if(row.jsonrpc!=='2.0')return false;
    return object(row.error) || object(row.result) && row.result.isError===true;
  };
  return Array.isArray(parsed)?parsed.some(failed):failed(parsed);
}
