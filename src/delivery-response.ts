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
    return row.error!==undefined && row.error!==null || row.isError===true ||
      !!row.result && typeof row.result==='object' && (row.result as Record<string,unknown>).isError===true;
  };
  return Array.isArray(parsed)?parsed.some(failed):failed(parsed);
}
