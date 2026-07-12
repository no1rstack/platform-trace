import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTraceStore } from './src/store.js';
import { registerTraceRoutes } from './src/routes.js';
import { startCollectors } from './src/collectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3040', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = (process.env.PLATFORM_PUBLIC_URL || 'http://localhost:3040').replace(/\/$/, '');

const app = express();
app.use(express.json({ limit: '2mb' }));

const store = createTraceStore();
registerTraceRoutes(app, store);

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

startCollectors(store);

app.listen(PORT, HOST, () => {
  console.log(`[platform-trace] http://${HOST}:${PORT} (public ${PUBLIC})`);
});
