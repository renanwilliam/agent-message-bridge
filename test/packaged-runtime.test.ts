import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';
import test from 'node:test';

const packageDirectory=fileURLToPath(new URL('../.serverless/',import.meta.url));
const buildDirectory=join(packageDirectory,'build');
const buildFiles=['package.json','src/remote.js','src/aws-handlers.js'];
const hasBuild=buildFiles.some(file=>existsSync(join(buildDirectory,file)));
const execute=promisify(execFile);

/** Read one expected ZIP entry with bounded sizes. Never extract arbitrary paths. */
async function wrapperFromZip(archive:string):Promise<Buffer> {
  assert((await stat(archive)).size<=64*1024*1024,'Package archive exceeds the smoke-test size bound');
  const zip=await readFile(archive);
  let end=-1;
  for(let offset=zip.length-22;offset>=Math.max(0,zip.length-65557);offset--) {
    if(zip.readUInt32LE(offset)===0x06054b50 && offset+22+zip.readUInt16LE(offset+20)===zip.length){end=offset;break;}
  }
  assert(end>=0,'ZIP end record missing');
  assert.equal(zip.readUInt16LE(end+4),0,'Multi-disk ZIP is unsupported');
  assert.equal(zip.readUInt16LE(end+6),0,'Multi-disk ZIP is unsupported');
  const entries=zip.readUInt16LE(end+10);
  assert(entries<=256,'Unexpected ZIP member count');
  assert.equal(zip.readUInt16LE(end+8),entries);
  const centralSize=zip.readUInt32LE(end+12);
  const centralStart=zip.readUInt32LE(end+16);
  assert(centralStart+centralSize<=end,'Invalid ZIP central directory');
  let offset=centralStart;
  let wrapper:Buffer|undefined;
  for(let index=0;index<entries;index++) {
    assert(offset+46<=centralStart+centralSize,'Truncated ZIP member');
    assert.equal(zip.readUInt32LE(offset),0x02014b50);
    const nameLength=zip.readUInt16LE(offset+28),extraLength=zip.readUInt16LE(offset+30),commentLength=zip.readUInt16LE(offset+32);
    const next=offset+46+nameLength+extraLength+commentLength;
    assert(next<=centralStart+centralSize,'Invalid ZIP member length');
    const name=zip.subarray(offset+46,offset+46+nameLength).toString('utf8');
    assert(!name.startsWith('/')&&!name.includes('\\')&&!name.includes('\0')&&!/^[A-Za-z]:/.test(name)&&!name.split('/').includes('..'),'Unsafe ZIP member path');
    if(name==='serverless-mcp/entry.mjs') {
      assert.equal(wrapper,undefined,'Duplicate MCP wrapper entry');
      const method=zip.readUInt16LE(offset+10),checksum=zip.readUInt32LE(offset+16);
      const compressedSize=zip.readUInt32LE(offset+20),size=zip.readUInt32LE(offset+24),local=zip.readUInt32LE(offset+42);
      assert.equal(zip.readUInt16LE(offset+8)&1,0,'Encrypted ZIP entry is unsupported');
      assert(size<=16*1024*1024&&compressedSize<=64*1024*1024,'MCP wrapper exceeds size bound');
      assert(local+30<=centralStart,'Invalid ZIP local header');
      assert.equal(zip.readUInt32LE(local),0x04034b50);
      assert.equal(zip.readUInt16LE(local+8),method);
      assert.equal(zip.readUInt16LE(local+6)&1,0);
      const localNameLength=zip.readUInt16LE(local+26),localExtraLength=zip.readUInt16LE(local+28);
      const start=local+30+localNameLength+localExtraLength;
      assert(start+compressedSize<=centralStart,'Invalid ZIP data range');
      assert.equal(zip.subarray(local+30,local+30+localNameLength).toString('utf8'),name);
      const compressed=zip.subarray(start,start+compressedSize);
      assert(method===0||method===8,'Unsupported ZIP compression');
      wrapper=method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:16*1024*1024});
      assert.equal(wrapper.length,size);
      assert.equal(crc32(wrapper),checksum,'MCP wrapper ZIP checksum mismatch');
    }
    offset=next;
  }
  assert.equal(offset,centralStart+centralSize);
  assert(wrapper,'Generated archive must contain serverless-mcp/entry.mjs');
  return wrapper;
}

async function isolatedSmoke(program:string) {
  for(const file of buildFiles) assert(existsSync(join(buildDirectory,file)),`Incomplete generated build: ${file}`);
  const template=JSON.parse(await readFile(join(packageDirectory,'cloudformation-template-update-stack.json'),'utf8'));
  const artifactKey:unknown=template.Resources?.BridgeLambdaFunction?.Properties?.Code?.S3Key;
  assert.equal(typeof artifactKey,'string','Generated MCP archive key must be explicit');
  const artifactName=basename(artifactKey as string);
  assert(/^[A-Za-z0-9_.-]+\.zip$/.test(artifactName),'Invalid generated MCP archive name');
  const wrapper=await wrapperFromZip(join(packageDirectory,artifactName));
  const directory=await mkdtemp(join(tmpdir(),'bridge-packaged-runtime-'));
  try {
    for(let ancestor=directory;;ancestor=dirname(ancestor)) {
      assert(!existsSync(join(ancestor,'node_modules')),'Isolated smoke directory must have no ancestor node_modules');
      if(dirname(ancestor)===ancestor)break;
    }
    await mkdir(join(directory,'src'));
    await mkdir(join(directory,'serverless-mcp'));
    for(const file of buildFiles)await copyFile(join(buildDirectory,file),join(directory,file));
    await writeFile(join(directory,'serverless-mcp/entry.mjs'),wrapper);
    const env:NodeJS.ProcessEnv={
      BOOTSTRAP_MODE:'true',INSTALLATION_ID:'example',TABLE_NAME:'example',AWS_REGION:'us-east-1',
      AWS_CONFIG_FILE:'/dev/null',AWS_SHARED_CREDENTIALS_FILE:'/dev/null',AWS_EC2_METADATA_DISABLED:'true',
      SERVERLESS_MCP_SERVER_MODULE:'src/remote.js',LAMBDA_TASK_ROOT:directory,
    };
    const result=await execute(process.execPath,['--no-global-search-paths','--input-type=module','--eval',program],{
      cwd:directory,env,timeout:15000,maxBuffer:64*1024,
    });
    assert.equal(result.stdout.trim(),'packaged-bootstrap-ok');
  } finally {await rm(directory,{recursive:true,force:true});}
}

const responseCheck=`
assert.equal(response.statusCode,503);
assert.deepEqual(JSON.parse(Buffer.from(response.body,response.isBase64Encoded?'base64':'utf8').toString('utf8')),
 {error:'integration_not_configured',status:'infrastructure_only'});
console.log('packaged-bootstrap-ok');
`;
test('packaged MCP wrapper imports with plain Node and serves bootstrap without node_modules',{skip:!hasBuild},async()=>{
  await isolatedSmoke(`
import assert from 'node:assert/strict';
globalThis.awslambda={streamifyResponse:handler=>handler};
const entry=await import('./serverless-mcp/entry.mjs');
assert.equal(typeof entry.handler,'function');
assert.equal(typeof entry.bufferedHandler,'function');
const response=await entry.bufferedHandler({path:'/bridge/mcp',httpMethod:'GET',headers:{host:'bridge.example.test'},
 requestContext:{stage:'example',identity:{sourceIp:'127.0.0.1'}},body:null,isBase64Encoded:false},{});
${responseCheck}`);
});
test('packaged AWS handlers import with plain Node and history serves bootstrap without node_modules',{skip:!hasBuild},async()=>{
  await isolatedSmoke(`
import assert from 'node:assert/strict';
const handlers=await import('./src/aws-handlers.js');
for(const name of ['ingress','history','delivery','streamWake','sweep'])assert.equal(typeof handlers[name],'function');
const response=await handlers.history({path:'/history',httpMethod:'GET',headers:{host:'bridge.example.test'}});
${responseCheck}`);
});
