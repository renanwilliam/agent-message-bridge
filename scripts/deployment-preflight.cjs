'use strict';

// This runs before Serverless packages or deploys. It validates references only;
// it does not fetch configuration values, inspect credentials or contact AWS.
function validateDeployment(config) {
  const installationId = config.provider?.environment?.INSTALLATION_ID;
  if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(installationId)) {
    throw new Error('installationId must contain 1–100 ASCII letters, digits, underscores or hyphens; IAM wildcard and partition separators are forbidden.');
  }
  const refs = [
    config.mcp?.servers?.bridge?.environment?.CONFIG_SECRET_ARN,
    ...['ingress', 'history', 'delivery'].map(name => config.functions?.[name]?.environment?.CONFIG_SECRET_ARN),
  ];
  const secretArn = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/;
  if (refs.some(ref => typeof ref !== 'string' || !secretArn.test(ref))) {
    throw new Error('Each runtime requires a complete Secrets Manager configuration ARN without IAM wildcards.');
  }
  if (new Set(refs).size !== 4) throw new Error('MCP, ingress, history and delivery require four distinct configuration secret ARNs.');
  if (config.provider.environment.CONFIG_SECRET_ARN || ['streamWake', 'sweep'].some(name => config.functions?.[name]?.environment?.CONFIG_SECRET_ARN)) {
    throw new Error('Configuration secret ARNs must not be inherited by stream or sweep functions.');
  }
}

class DeploymentPreflight {
  constructor(serverless) {
    this.hooks = {
      'before:package:initialize': () => validateDeployment(serverless.configurationInput),
      'before:deploy:initialize': () => validateDeployment(serverless.configurationInput),
    };
  }
}
module.exports = DeploymentPreflight;
module.exports.validateDeployment = validateDeployment;
