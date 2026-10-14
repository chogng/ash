import agentEnvironment from './aiAgentEnv.json' with { type: 'json' };

/** Child-process attribution marker; shared hosts must not inherit an enclosing agent's identity. */
export const AiAgentEnvVar = agentEnvironment.marker;
