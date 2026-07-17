import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTraceStore } from './src/store.js';
import { registerTraceRoutes } from './src/routes.js';
import { startCollectors } from './src/collectors.js';
import { registerTraceAuthRoutes, requireTraceAuth } from './src/auth.js';
import { isAuth0Configured, setupAuth0 } from './src/auth0.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3040', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE = (process.env.PLATFORM_TRACE_BASE_PATH || '').replace(/\/$/, '');
const PUBLIC = (process.env.PLATFORM_PUBLIC_URL || 'http://localhost:3040').replace(/\/$/, '');
const AUTH_MODE =
  process.env.PLATFORM_TRACE_AUTH_REQUIRED === '0'
    ? 'off'
    : isAuth0Configured()
      ? 'auth0'
      : process.env.PLATFORM_TRACE_AUTH_PROVIDER || 'keycloak';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

if (BASE) {
  app.use((req, _res, next) => {
    if (req.url === BASE || req.url.startsWith(`${BASE}/`)) {
      req.url = req.url.slice(BASE.length) || '/';
    }
    next();
  });
}

const store = createTraceStore();
if (AUTH_MODE === 'auth0') {
  setupAuth0(app);
} else if (AUTH_MODE !== 'off') {
  registerTraceAuthRoutes(app);
  app.use(requireTraceAuth);
}
registerTraceRoutes(app, store);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (!BASE) {
    return res.sendFile(indexPath);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const withBase = html.includes('<base ')
    ? html
    : html.replace('<head>', `<head>\n<base href="${BASE}/" />`);
  res.type('html').send(withBase);
});

startCollectors(store);

app.listen(PORT, HOST, () => {
  console.log(
    `[platform-trace] http://${HOST}:${PORT} (public ${PUBLIC}, base=${BASE || '/'}, auth=${AUTH_MODE})`,
  );
});
