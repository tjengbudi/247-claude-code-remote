import { createHmac } from 'crypto';

export interface CreatePathATokenArgs {
  machineId: string;
  machineName: string;
  agentUrl: string;
  agentApiKey: string;
}

export function createPathAToken(args: CreatePathATokenArgs): string {
  const { machineId, machineName, agentUrl, agentApiKey } = args;
  const now = Date.now();

  const payload = {
    mid: machineId,
    mn: machineName,
    url: agentUrl,
    tok: agentApiKey,
    iat: now,
    exp: now + 5 * 60 * 1000, // 5 minutes in future
  };

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const secret = machineId;
  const signature = createHmac('sha256', secret).update(payloadStr).digest('base64url');

  return `${payloadStr}.${signature}`;
}
