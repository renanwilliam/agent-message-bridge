import { runtime } from './runtime.js';
import type { McpHandlerRequestOptions } from '@modelcontextprotocol/server';
export default {async fetch(request:Request,options?:McpHandlerRequestOptions) {return (await runtime()).app.fetch(request,options);}};
