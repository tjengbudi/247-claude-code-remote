import { createServer } from './server.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getAgentUrl } from './routes/pair.js';

const PORT = config.agent?.port || 4678;

async function main() {
  logger.main.info({ machine: config.machine.name }, 'Starting 247 Agent');

  const server = await createServer();

  server.listen(PORT, () => {
    // Advertise the resolved agent URL (config.agent.url or detected LAN IP),
    // not a hardcoded localhost — so the logged URL is reachable from the browser.
    const advertisedHost = getAgentUrl();
    logger.main.info({ port: PORT }, 'Agent running');
    logger.main.info({ url: `ws://${advertisedHost}` }, 'Dashboard connection URL');
    logger.main.info({ url: `http://${advertisedHost}/pair` }, 'Pair with dashboard at');
    logger.main.info('For remote access, use Tailscale Funnel, Cloudflare Tunnel, or SSH tunnel');
  });
}

main().catch((err) => {
  logger.main.error(err, 'Agent startup failed');
  process.exit(1);
});
