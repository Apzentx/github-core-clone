// The HTTP server: routing, auth, and the response discipline (JSON always, request ids).
// Routes: /healthz, /api/v3/*, /api/graphql, /mcp, /<owner>/<repo>.git/*.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { infoRefs, lsRefs, receivePack, uploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, httpError, isHttpError } from './rest.ts';
import { Store, VIEWER_LOGIN } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export interface AppOptions {
  /** The bearer token the env presents (MAKEFUN_SHOP_TOKEN). Empty = accept any non-empty token. */
  token: string;
}

export function createApp(options: AppOptions): Server {
  const store = new Store();
  let requestCounter = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === null ? '' : `${JSON.stringify(body)}\n`;
    requestCounter += 1;
    const allHeaders: Record<string, string> = {
      'content-type': JSON_TYPE,
      'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
      ...headers,
    };
    if (body === null) {
      res.writeHead(status, allHeaders);
      res.end();
      return;
    }
    allHeaders['content-length'] = String(Buffer.byteLength(text));
    res.writeHead(status, allHeaders);
    res.end(text);
  };

  const sendRaw = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    requestCounter += 1;
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    });
    res.end(body);
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length);
    if (presented === '') return false;
    if (options.token === '') return true;
    return presented === options.token;
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 64 * 1024 * 1024) {
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const service = gitMatch[3]!;
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (service === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const svc = url.searchParams.get('service');
            if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' });
              return;
            }
            const gitProtocol = req.headers['git-protocol'];
            const answer = infoRefs(repo, svc, typeof gitProtocol === 'string' ? gitProtocol : undefined);
            sendRaw(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          if (service === 'git-upload-pack') {
            // v2 command dispatch on the first pkt-line.
            const first = body.subarray(0, 4).toString('ascii');
            const len = parseInt(first, 16);
            if (Number.isNaN(len) || len < 4 || body.length < len) {
              sendJson(res, 400, { message: 'malformed pkt-line' });
              return;
            }
            const command = body.subarray(4, len).toString('utf8');
            if (command.startsWith('command=ls-refs')) {
              const answer = lsRefs(repo, body);
              sendRaw(res, answer.status, 'application/x-git-upload-pack-result', answer.body);
            } else if (command.startsWith('command=fetch')) {
              const answer = uploadPack(repo, body);
              sendRaw(res, answer.status, 'application/x-git-upload-pack-result', answer.body);
            } else {
              sendJson(res, 400, { message: 'unknown git command' });
            }
            return;
          }
          // git-receive-pack
          const answer = receivePack(repo, body);
          sendRaw(res, answer.status, 'application/x-git-receive-pack-result', answer.body);
          return;
        }

        // Everything below needs auth (except /healthz, handled above).
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s !== '');
          let parsedBody: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length) {
              try {
                parsedBody = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
          const result = handleRest(store, method, segments, url.searchParams, parsedBody, baseUrl);
          if (result.body === null) {
            requestCounter += 1;
            res.writeHead(result.status, {
              'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
              ...(result.headers ?? {}),
            });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              if (!entry || typeof entry !== 'object') return { data: null, errors: [{ message: 'Invalid operation' }] };
              const record = entry as { query?: unknown; variables?: unknown };
              if (typeof record.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
              return executeGraphQL(store, record.query, (record.variables ?? {}) as Record<string, unknown>);
            });
            sendJson(res, 200, results);
            return;
          }
          const record = (parsed ?? {}) as { query?: unknown; variables?: unknown };
          if (typeof record.query !== 'string') {
            sendJson(res, 400, { message: 'query is required' });
            return;
          }
          const result = executeGraphQL(store, record.query, (record.variables ?? {}) as Record<string, unknown>);
          sendJson(res, 200, result);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            requestCounter += 1;
            res.writeHead(200, { 'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}` });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'));
          if (answer.body === null) {
            requestCounter += 1;
            res.writeHead(answer.status, {
              'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
            });
            res.end();
            return;
          }
          sendJson(res, answer.status, JSON.parse(answer.body));
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (isHttpError(err)) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The response may already be gone; nothing more to do.
        }
      }
    })();
  });
}
