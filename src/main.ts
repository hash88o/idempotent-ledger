import { createPool, migrate } from "./db.js";
import { createApp } from "./server.js";

const DEFAULT_PORT = 3000;

const pool = createPool();
await migrate(pool);

const port = Number(process.env.PORT ?? DEFAULT_PORT);
createApp(pool).listen(port, () => {
  console.log(`idempotent-ledger listening on http://localhost:${port}`);
});
