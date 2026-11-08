import type { PrivateConfig } from './config.js';
/** An AWS stack is one installation. Reject configuration that would cross its IAM boundary. */
export function validateInstallationConfig(config:PrivateConfig,installationId:string):void {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(installationId))throw new Error('Invalid installation identifier');
  const principals=[...Object.values(config.subjects),...Object.values(config.clientSubjects).flatMap(Object.values),...Object.values(config.callbacks).map(value=>value.principal)];
  const recipients=[...config.webhookRecipients,...Object.keys(config.routes)];
  if(principals.some(principal=>principal.tenant!==installationId)||recipients.some(key=>key.split(':')[0]!==installationId))throw new Error('Configuration does not match installation boundary');
}
