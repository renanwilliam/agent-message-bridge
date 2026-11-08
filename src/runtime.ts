import { bootstrapMode, bootstrapApp } from './activation.js';
import { DynamoStore } from './dynamo-store.js';
import { Bridge } from './bridge.js';
import { Events } from './events.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';
import { loadPrivateConfig, parsePrivateConfig, configuredWebhookRecipients, env } from './config.js';
import { createOAuthAppConfig } from './auth-runtime.js';
import { validateInstallationConfig } from './installation.js';
import { outboundPost } from './transport.js';
export async function runtime() {
  const inactive=bootstrapMode(process.env.BOOTSTRAP_MODE);
  const config=inactive?parsePrivateConfig('{}'):await loadPrivateConfig();
  validateInstallationConfig(config,env('INSTALLATION_ID'));
  const store=new DynamoStore(env('TABLE_NAME'));
  const webhookRecipients=configuredWebhookRecipients(config);
  const bridge=new Bridge(store,{...config.limits,webhookRecipients});
  const events=new Events(store,outboundPost);
  const app=inactive?bootstrapApp():createApp(bridge,events,createOAuthAppConfig(config,process.env));
  const worker=new Worker(store,{routes:config.routes,deliveryEnabled:!inactive,leaseMs:30000,retryMs:5000,maxAttempts:config.limits.maxAttempts,responseWaitMs:config.limits.claimMs},outboundPost);
  return {store,bridge,events,app,worker};
}
