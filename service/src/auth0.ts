/**
 * Auth0 session auth for platform-trace — same pattern as Cascades/Judicium.
 * Callback: /api/auth/callback (configure in Auth0 Allowed Callback URLs).
 */
import type { Express, Request, Response, NextFunction } from 'express';
import openidConnect from 'express-openid-connect';

const { auth, requiresAuth } = openidConnect;

export function isAuth0Configured(): boolean {
  return Boolean(
    process.env.AUTH0_CLIENT_ID?.trim() &&
      process.env.AUTH0_CLIENT_SECRET?.trim() &&
      (process.env.AUTH0_ISSUER_BASE_URL?.trim() || process.env.AUTH0_DOMAIN?.trim()) &&
      process.env.AUTH0_SECRET?.trim() &&
      (process.env.AUTH0_BASE_URL?.trim() || process.env.PLATFORM_PUBLIC_URL?.trim()),
  );
}

function resolveIssuerBaseUrl(): string {
  const raw = process.env.AUTH0_ISSUER_BASE_URL?.trim() || process.env.AUTH0_DOMAIN?.trim();
  if (!raw) throw new Error('AUTH0 issuer not configured');
  return raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`;
}

function resolveBaseUrl(): string {
  const raw =
    process.env.AUTH0_BASE_URL?.trim() ||
    process.env.PLATFORM_PUBLIC_URL?.trim() ||
    'http://127.0.0.1:3040';
  return raw.replace(/\/$/, '');
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/v1/ingest/')) return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname === '/favicon.ico') {
    return true;
  }
  return false;
}

function hasMachineToken(req: Request): boolean {
  const expected = process.env.PLATFORM_TRACE_TOKEN?.trim();
  if (!expected) return false;
  return String(req.headers['x-platform-trace-token'] || '') === expected;
}

export function setupAuth0(app: Express): void {
  const issuerBaseURL = resolveIssuerBaseUrl();
  const baseURL = resolveBaseUrl();
  const audience = process.env.AUTH0_AUDIENCE?.trim();
  const cookieSecure =
    baseURL.startsWith('https://') && process.env.PLATFORM_TRACE_COOKIE_SECURE !== '0';

  app.use(
    auth({
      authRequired: false,
      auth0Logout: true,
      secret: process.env.AUTH0_SECRET!,
      baseURL,
      clientID: process.env.AUTH0_CLIENT_ID!,
      clientSecret: process.env.AUTH0_CLIENT_SECRET!,
      issuerBaseURL,
      routes: {
        login: '/api/auth/login',
        logout: '/api/auth/logout',
        callback: '/api/auth/callback',
      },
      authorizationParams: {
        scope: 'openid profile email',
        ...(audience ? { audience } : {}),
      },
      session: {
        rolling: true,
        rollingDuration: 60 * 60 * 24,
        absoluteDuration: 60 * 60 * 24 * 7,
        cookie: {
          sameSite: 'Lax',
          secure: cookieSecure,
        },
      },
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isPublicPath(req.path)) return next();
    if (hasMachineToken(req)) return next();
    return requiresAuth()(req, res, next);
  });
}
