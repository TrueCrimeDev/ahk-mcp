import type { Express, NextFunction, Request, Response } from 'express';
import { StudioServiceError, type StudioService } from './studio-service.js';
import { STUDIO_APP_JS, STUDIO_CSS, STUDIO_HTML, STUDIO_WEBMCP_JS } from './studio-page.js';

const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const LOOPBACK_HOST_AUTHORITY = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

type HttpStudioService = Pick<
  StudioService,
  'listMacros' | 'createPreview' | 'requestRun' | 'getRun' | 'approveRun'
>;

export function setStudioHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', STUDIO_CSP);
}

export function sendStudioError(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  setStudioHeaders(res);
  res.status(status).json({ code, message });
}

function isLoopbackSocketAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.toLowerCase().startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function hasExactBoundLoopbackAuthority(req: Request): boolean {
  const host = req.headers.host;
  const localPort = req.socket.localPort;
  if (
    typeof host !== 'string' ||
    typeof localPort !== 'number' ||
    !isLoopbackSocketAddress(req.socket.remoteAddress)
  ) {
    return false;
  }
  const match = LOOPBACK_HOST_AUTHORITY.exec(host);
  if (!match) return false;
  const authorityPort = Number(match[1]);
  return authorityPort >= 1 && authorityPort <= 65_535 && authorityPort === localPort;
}

function hasExactLoopbackOrigin(req: Request): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  if (!hasExactBoundLoopbackAuthority(req)) return false;

  try {
    const requestUrl = new URL('http://' + host);
    const originUrl = new URL(origin);
    const requestIsAuthorityOnly =
      requestUrl.username === '' &&
      requestUrl.password === '' &&
      requestUrl.pathname === '/' &&
      requestUrl.search === '' &&
      requestUrl.hash === '';
    return (
      requestIsAuthorityOnly &&
      originUrl.protocol === 'http:' &&
      origin === originUrl.origin &&
      originUrl.host === requestUrl.host
    );
  } catch {
    return false;
  }
}

function requireLoopbackRequest(req: Request, res: Response, next: NextFunction): void {
  if (!hasExactBoundLoopbackAuthority(req)) {
    sendStudioError(
      res,
      403,
      'loopback_required',
      req.method === 'POST'
        ? 'Studio changes require the local page.'
        : 'Studio is available only on this PC.'
    );
    return;
  }
  next();
}

function requireLoopbackMutation(req: Request, res: Response, next: NextFunction): void {
  if (!hasExactLoopbackOrigin(req)) {
    sendStudioError(res, 403, 'loopback_required', 'Studio changes require the local page.');
    return;
  }
  next();
}

function handleStudioError(error: unknown, res: Response): void {
  if (error instanceof StudioServiceError) {
    sendStudioError(res, error.statusCode, error.code, error.message);
    return;
  }
  sendStudioError(res, 500, 'internal_error', 'Studio request failed.');
}

function isUpstreamJsonParseError(error: unknown): boolean {
  if (!(error instanceof SyntaxError) || typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 400 && candidate.type === 'entity.parse.failed';
}

export function mountStudioHeaderBoundary(app: Express): void {
  app.use('/studio', (_req, res, next) => {
    res.locals.studioBoundaryEntered = true;
    setStudioHeaders(res);
    next();
  });
}

export function mountStudio(app: Express, service: HttpStudioService): void {
  mountStudioHeaderBoundary(app);
  app.use('/studio', requireLoopbackRequest);
  app.use('/studio', (req, res, next) => {
    if (req.method === 'POST') {
      requireLoopbackMutation(req, res, next);
      return;
    }
    next();
  });

  app.get(['/studio', '/studio/'], (_req, res) => {
    res.type('html').send(STUDIO_HTML);
  });
  app.get('/studio/styles.css', (_req, res) => {
    res.type('css').send(STUDIO_CSS);
  });
  app.get('/studio/app.js', (_req, res) => {
    res.type('application/javascript').send(STUDIO_APP_JS);
  });
  app.get('/studio/webmcp.js', (_req, res) => {
    res.type('application/javascript').send(STUDIO_WEBMCP_JS);
  });

  app.get('/studio/api/macros', (_req, res, next) => {
    try {
      res.status(200).json(service.listMacros());
    } catch (error) {
      next(error);
    }
  });

  app.post('/studio/api/previews', (req, res, next) => {
    Promise.resolve(service.createPreview(req.body))
      .then(preview => res.status(201).json(preview))
      .catch(next);
  });

  app.post('/studio/api/runs', (req, res, next) => {
    try {
      res.status(201).json(service.requestRun(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.get('/studio/api/runs/:runId', (req, res, next) => {
    try {
      res.status(200).json(service.getRun(req.params.runId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/studio/api/runs/:runId/approve', (req, res, next) => {
    Promise.resolve(service.approveRun(req.params.runId))
      .then(run => res.status(200).json(run))
      .catch(next);
  });

  app.use('/studio', (_req, res) => {
    sendStudioError(res, 404, 'not_found', 'Studio resource was not found.');
  });

  app.use('/studio', (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (req.method === 'POST' && !hasExactLoopbackOrigin(req)) {
      sendStudioError(res, 403, 'loopback_required', 'Studio changes require the local page.');
      return;
    }
    if (isUpstreamJsonParseError(error)) {
      sendStudioError(res, 400, 'invalid_input', 'Studio input is invalid.');
      return;
    }
    handleStudioError(error, res);
  });
}
