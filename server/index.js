/** Entry point: boot the game server and shut down cleanly on signals. */

import { createGameServer } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = createGameServer();

await app.listen(PORT, HOST);
console.log(`Bluffalo listening on http://${HOST}:${PORT}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    await app.close().catch(() => {});
    process.exit(0);
  });
}
