import type { Express, NextFunction, Request, Response } from 'express';
import { StudioServiceError, type StudioService } from './studio-service.js';
import { STUDIO_APP_JS, STUDIO_CSS, STUDIO_HTML, STUDIO_WEBMCP_JS } from './studio-page.js';

const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

type HttpStudioService = Pick<
  StudioService,
  'listMacros' | 'createPreview' | 'requestRun' | 'getRun' | 'approveRun'
>;

function setStudioHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', STUDIO_CSP);
}

function sendStudioError(res: Response, status: number, code: string, message: string): void {
  setStudioHeaders(res);
  res.status(status).json({ code, message });
}

function hasExactLoopbackOrigin(req: Request): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;

  try {
    const requestUrl = new URL('http://' + host);
    const originUrl = new URL(origin);
    const requestIsAuthorityOnly =
      requestUrl.username === '' &&
      requestUrl.password === '' &&
      requestUrl.pathname === '/' &&
      requestUrl.search === '' &&
      requestUrl.hash === '';
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname);
    return (
      requestIsAuthorityOnly &&
      loopback &&
      originUrl.protocol === 'http:' &&
      origin === originUrl.origin &&
      originUrl.host === requestUrl.host
    );
  } catch {
    return false;
  }
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

export function mountStudio(app: Express, service: HttpStudioService): void {
  app.use('/studio', (_req, res, next) => {
    setStudioHeaders(res);
    next();
  });
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

  app.post('/studio/api/previews', requireLoopbackMutation, (req, res, next) => {
    Promise.resolve(service.createPreview(req.body))
      .then(preview => res.status(201).json(preview))
      .catch(next);
  });

  app.post('/studio/api/runs', requireLoopbackMutation, (req, res, next) => {
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

  app.post('/studio/api/runs/:runId/approve', requireLoopbackMutation, (req, res, next) => {
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
    handleStudioError(error, res);
  });
}
