/**
 * Keycloak OIDC gate for platform-trace (trace.noirstack.com).
 */
import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type TraceAuthUser = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  roles?: string[];
};

type OidcState = { state: string; verifier: string; returnTo: string };

function cfg() {
  const base = (process.env.KEYCLOAK_BASE_URL || 'https://auth.noirstack.com').replace(/\/$/, '');
  const realm = process.env.KEYCLOAK_REALM || 'gateway';
  const issuer = `${base}/realms/${realm}`;
  return {
    required: process.env.PLATFORM_TRACE_AUTH_REQUIRED !== '0',
    base,
    realm,
    issuer,
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'platform-trace-noirstack',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
    redirectUri:
      process.env.KEYCLOAK_REDIRECT_URI || 'https://trace.noirstack.com/api/auth/callback',
    homeUrl: process.env.KEYCLOAK_HOME_URL || 'https://trace.noirstack.com',
    authUrl: `${issuer}/protocol/openid-connect/auth`,
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    userInfoUrl: `${issuer}/protocol/openid-connect/userinfo`,
    logoutUrl: `${issuer}/protocol/openid-connect/logout`,
    scope: process.env.KEYCLOAK_SCOPE || 'openid profile email',
    cookieSecure:
      process.env.NODE_ENV === 'production' || process.env.PLATFORM_TRACE_COOKIE_SECURE === '1',
    requiredRoles: (process.env.PLATFORM_TRACE_REQUIRED_ROLES || 'trace.noirstack.com')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractRoles(accessToken: string, clientId: string): string[] {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return [];
  const realmRoles = Array.isArray((payload.realm_access as { roles?: string[] } | undefined)?.roles)
    ? (payload.realm_access as { roles: string[] }).roles.map(String)
    : [];
  const clientRoles = Array.isArray(
    (payload.resource_access as Record<string, { roles?: string[] }> | undefined)?.[clientId]?.roles,
  )
    ? (payload.resource_access as Record<string, { roles: string[] }>)[clientId].roles.map(String)
    : [];
  return Array.from(new Set([...realmRoles, ...clientRoles]));
}

function userHasRequiredRoles(user: TraceAuthUser, requiredRoles: string[]): boolean {
  if (!requiredRoles.length) return true;
  const owned = new Set((user.roles || []).map((r) => r.trim()).filter(Boolean));
  return requiredRoles.some((role) => owned.has(role));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  opts: { maxAgeMs?: number; httpOnly?: boolean; path?: string },
) {
  const c = cfg();
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path || '/'}`,
    'SameSite=Lax',
  ];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (c.cookieSecure) parts.push('Secure');
  if (opts.maxAgeMs != null) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeMs / 1000))}`);
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res: Response, name: string, pathName = '/') {
  const c = cfg();
  const parts = [`${name}=`, `Path=${pathName}`, 'Max-Age=0', 'SameSite=Lax'];
  if (c.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function hasMachineToken(req: Request): boolean {
  const expected = process.env.PLATFORM_TRACE_TOKEN?.trim();
  if (!expected) return false;
  const got = String(req.headers['x-platform-trace-token'] || '');
  return got === expected;
}

export function isTraceHost(req: Request): boolean {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return host.startsWith('trace.noirstack.com');
}

export function getTraceSession(req: Request): TraceAuthUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies.platform_trace_session;
  if (!raw) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      user?: TraceAuthUser;
      exp?: number;
    };
    if (!json?.user?.sub) return null;
    if (json.exp && Date.now() > json.exp) return null;
    return json.user;
  } catch {
    return null;
  }
}

function writeSession(res: Response, user: TraceAuthUser, maxAgeSec: number) {
  const payload = b64url(
    JSON.stringify({
      user,
      exp: Date.now() + maxAgeSec * 1000,
    }),
  );
  setCookie(res, 'platform_trace_session', payload, { maxAgeMs: maxAgeSec * 1000, httpOnly: true });
}

async function exchangeCode(code: string, verifier: string) {
  const c = cfg();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    code_verifier: verifier,
  });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);

  const tokenRes = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    id_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tokenJson)}`);
  }

  const uiRes = await fetch(c.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const userInfo = (await uiRes.json()) as Record<string, unknown>;
  if (!uiRes.ok || !userInfo?.sub) {
    throw new Error(`userinfo failed: ${JSON.stringify(userInfo)}`);
  }

  return {
    accessToken: String(tokenJson.access_token),
    idToken: tokenJson.id_token ? String(tokenJson.id_token) : '',
    expiresIn: Number(tokenJson.expires_in || 3600),
    user: {
      sub: String(userInfo.sub),
      email: userInfo.email ? String(userInfo.email) : undefined,
      name: userInfo.name ? String(userInfo.name) : undefined,
      preferred_username: userInfo.preferred_username
        ? String(userInfo.preferred_username)
        : undefined,
      roles: extractRoles(String(tokenJson.access_token), c.clientId),
    } satisfies TraceAuthUser,
  };
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/api/v1/ingest/')) return true;
  return false;
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/css/') ||
    pathname.startsWith('/js/') ||
    pathname === '/favicon.ico'
  );
}

/** Require Keycloak session for UI and read APIs; machine token for ingest/API automation. */
export function requireTraceAuth(req: Request, res: Response, next: NextFunction) {
  const c = cfg();
  if (!c.required) return next();

  if (isPublicPath(req.path)) return next();
  if (hasMachineToken(req)) return next();

  if (!isTraceHost(req) && !req.path.startsWith('/api/')) {
    return next();
  }

  if (isStaticAsset(req.path)) return next();

  const user = getTraceSession(req);
  if (user) {
    if (!userHasRequiredRoles(user, c.requiredRoles)) {
      const wantsJson =
        req.path.startsWith('/api/') ||
        String(req.headers.accept || '').includes('application/json');
      if (wantsJson) {
        return res.status(403).json({
          error: 'forbidden',
          message: `Missing required role: ${c.requiredRoles.join(' or ')}`,
        });
      }
      return res.status(403).type('text/plain').send('Forbidden — missing Platform Trace access role');
    }
    (req as Request & { traceUser?: TraceAuthUser }).traceUser = user;
    return next();
  }

  const wantsJson =
    req.path.startsWith('/api/') ||
    String(req.headers.accept || '').includes('application/json');

  if (wantsJson) {
    return res.status(401).json({
      error: 'authentication_required',
      loginUrl: '/api/auth/login',
    });
  }

  const returnTo = req.originalUrl || '/';
  return res.redirect(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`);
}

export function registerTraceAuthRoutes(app: Express): void {
  app.get('/api/auth/status', (req, res) => {
    const c = cfg();
    const user = getTraceSession(req);
    res.json({
      required: c.required,
      requiredRoles: c.requiredRoles,
      authenticated: Boolean(user),
      user,
      issuer: c.issuer,
      clientId: c.clientId,
      loginUrl: '/api/auth/login',
      logoutUrl: '/api/auth/logout',
    });
  });

  app.get('/api/auth/login', (req, res) => {
    const c = cfg();
    if (!c.clientId || !c.redirectUri) {
      return res.status(500).json({ error: 'Keycloak client not configured' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const returnToRaw = String(req.query.return_to || '/');
    const returnTo = returnToRaw.startsWith('/') ? returnToRaw : '/';
    const payload: OidcState = { state, verifier, returnTo };
    setCookie(res, 'platform_trace_oidc', b64url(JSON.stringify(payload)), {
      maxAgeMs: 600_000,
      httpOnly: true,
      path: '/api/auth',
    });

    const url = new URL(c.authUrl);
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', c.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', c.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return res.redirect(url.toString());
  });

  app.get('/api/auth/callback', async (req, res) => {
    try {
      const err = String(req.query.error || '').trim();
      if (err) {
        return res
          .status(401)
          .send(`Keycloak authorization failed: ${err} ${req.query.error_description || ''}`);
      }
      const code = String(req.query.code || '').trim();
      const state = String(req.query.state || '').trim();
      if (!code || !state) return res.status(400).send('Missing code/state');

      const cookies = parseCookies(req.headers.cookie);
      let parsed: OidcState | null = null;
      try {
        parsed = JSON.parse(
          Buffer.from(String(cookies.platform_trace_oidc || ''), 'base64url').toString('utf8'),
        ) as OidcState;
      } catch {
        parsed = null;
      }
      if (!parsed?.state || !parsed.verifier || parsed.state !== state) {
        return res.redirect('/api/auth/login');
      }

      const exchanged = await exchangeCode(code, parsed.verifier);
      clearCookie(res, 'platform_trace_oidc', '/api/auth');
      writeSession(res, exchanged.user, exchanged.expiresIn);
      if (exchanged.idToken) {
        setCookie(res, 'platform_trace_id_token', exchanged.idToken, {
          maxAgeMs: exchanged.expiresIn * 1000,
          httpOnly: true,
        });
      }
      const dest = parsed.returnTo.startsWith('/') ? parsed.returnTo : '/';
      return res.redirect(dest);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[platform-trace-auth] callback error:', message);
      return res.status(500).send(`Auth callback failed: ${message}`);
    }
  });

  app.get('/api/auth/logout', (req, res) => {
    const c = cfg();
    const cookies = parseCookies(req.headers.cookie);
    const idToken = cookies.platform_trace_id_token || '';
    clearCookie(res, 'platform_trace_session');
    clearCookie(res, 'platform_trace_id_token');
    clearCookie(res, 'platform_trace_oidc', '/api/auth');

    if (c.logoutUrl && c.clientId) {
      const url = new URL(c.logoutUrl);
      url.searchParams.set('client_id', c.clientId);
      url.searchParams.set('post_logout_redirect_uri', c.homeUrl);
      if (idToken) url.searchParams.set('id_token_hint', idToken);
      return res.redirect(url.toString());
    }
    return res.redirect('/');
  });

  app.get('/api/auth/me', (req, res) => {
    const user = getTraceSession(req);
    if (!user) return res.status(401).json({ error: 'not_authenticated' });
    res.json({ user });
  });
}
