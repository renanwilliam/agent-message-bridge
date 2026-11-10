import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { Events } from '../src/events.js';
import { createApp } from '../src/app.js';
import { BridgeError, type Principal } from '../src/types.js';
import { httpServer, listen, close } from '../src/http.js';
// Servidor exclusivamente local, sem AWS, com identidades e mensagens sintéticas.
const store = new MemoryStore();
const bridge = new Bridge(store, {
  viewerCatalog: 'complete',
  messagesPerMinute: 1000,
  claimMs: 1000,
  webhookRecipients: [],
});
const sender: Principal = {
  id: 'alpha',
  tenant: 'demo',
  scopes: ['messages:send'],
  peers: ['beta', 'gamma'],
};
for (let i = 1; i <= 35; i++)
  await bridge.send(sender, {
    id: `message_${i}`,
    conversationId: 'demo_planejamento',
    recipient: 'beta',
    text:
      i === 1
        ? 'Pode revisar o plano de validação?\nUse apenas registros sintéticos.\n<script>window.syntheticXss = true</script>'
        : `Mensagem sintética ${i}. ${i === 35 ? 'Resultado final disponível.' : 'Validação em andamento. '.repeat(8)}`,
  });
await bridge.send(sender, {
  id: 'other_1',
  conversationId: 'demo_validacao',
  recipient: 'gamma',
  text: 'Outra conversa sintética.',
});
const app = createApp(
  bridge,
  new Events(store, async () => ({ status: 200, body: '' })),
  {
    resourceUrl: 'https://bridge.example.test/mcp',
    issuer: 'https://issuer.example.test',
    origins: [`http://127.0.0.1:${process.env.VIEWER_DEMO_PORT ?? 4173}`],
    callbacks: {},
    authenticate: async (request) => {
      if (
        request.headers.get('authorization') !== 'Bearer synthetic-viewer-token'
      )
        throw new BridgeError('unauthorized', 401);
      return {
        id: 'reader',
        tenant: 'demo',
        scopes: ['history:read'],
        peers: [],
        readParticipants: ['alpha'],
      };
    },
  },
);
const server = httpServer(app);
console.log(
  `Viewer sintético: ${await listen(server, Number(process.env.VIEWER_DEMO_PORT ?? 4173))}/viewer`,
);
console.log('Token sintético: synthetic-viewer-token');
process.once('SIGTERM', () => void close(server));
process.once('SIGINT', () => void close(server));
