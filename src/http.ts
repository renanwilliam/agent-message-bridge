import { createServer, type Server } from 'node:http';
export function httpServer(app:{fetch(request:Request):Promise<Response>}):Server {
  return createServer(async(req,res)=>{
    try {
      const chunks:Buffer[]=[];let bytes=0;
      for await(const piece of req){bytes+=piece.length;if(bytes>65536){res.writeHead(413).end();return;}chunks.push(piece);}
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers)){if(value)headers.set(name,Array.isArray(value)?value.join(','):value);}
      const response=await app.fetch(new Request(`http://127.0.0.1${req.url??'/'}`,{method:req.method,headers,...(req.method!=='GET'&&req.method!=='HEAD'?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500,{'content-type':'application/json'}).end('{"error":"internal_error"}');}
  });
}
export async function listen(server:Server,port=0) {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('No local port');return `http://127.0.0.1:${address.port}`;}
export async function close(server:Server) {if(!server.listening)return;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
