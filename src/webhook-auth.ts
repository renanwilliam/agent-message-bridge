/** An optional credential header must not replace routing, protocol, or trace metadata. */
export function isAdditionalAuthHeader(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || /[^a-z0-9-]/i.test(value) || !/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)) return false;
  const name = value.toLowerCase();
  if (/^x-(?:mcp|bridge|amz|amzn|forwarded|real-ip|original|rewrite|http-method|method-override|host)(?:-|$)/.test(name)) return false;
  return !['x-request-id', 'x-correlation-id', 'x-idempotency-key'].includes(name);
}
