import http from 'node:http';
import deployment from '../../../shared/deployments/hedera-testnet.json' with { type: 'json' };

const port = Number(process.env.PORT ?? '4023');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const responses = new Map([
  ['/health', { status: 'ok', mode: 'read-only' }],
  ['/deployment', { ...deployment, paymentsEnabled: false }],
]);

const server = http.createServer((req, res) => {
  const body = req.method === 'GET' ? responses.get(req.url) : undefined;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'not_found' }));
});

server.listen(port, process.env.HOST || '0.0.0.0');
