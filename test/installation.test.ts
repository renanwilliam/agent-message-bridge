import test from 'node:test';
import assert from 'node:assert/strict';
import {privateConfigSchema} from '../src/config.js';
import {validateInstallationConfig} from '../src/installation.js';
const p={id:'alpha',tenant:'sample',scopes:['messages:read'],peers:['beta']};
test('one installation accepts only principals and recipients inside its namespace',()=>{
 const config=privateConfigSchema.parse({subjects:{human:p},clientSubjects:{client:{subject:p}},webhookRecipients:['sample:beta']});
 assert.doesNotThrow(()=>validateInstallationConfig(config,'sample'));
 for(const wrong of ['*','sample#history','sample:other',''])assert.throws(()=>validateInstallationConfig(config,wrong));
 assert.throws(()=>validateInstallationConfig(config,'other'),/installation boundary/);
 const routes=privateConfigSchema.parse({routes:{'other:beta':{url:'https://recipient.example/wake',bearer:'synthetic-not-a-live-credential'}}});
 assert.throws(()=>validateInstallationConfig(routes,'sample'),/installation boundary/);
 const mixed=privateConfigSchema.parse({subjects:{safe:p},clientSubjects:{client:{subject:{...p,tenant:'other'}}}});
 assert.throws(()=>validateInstallationConfig(mixed,'sample'),/installation boundary/);
});
