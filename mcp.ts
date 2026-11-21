// Model Context Protocol over streamable HTTP (POST /mcp): the legacy era — initialize,
// notifications/initialized, tools/list, tools/call. No sessions; stateless JSON-RPC 2.0.

import { computeMergeable, doMergePull, issueJson, pullJson, repoJson } from './rest.ts';
import {
  VIEWER_LOGIN,
  type Repo,
  type Store,
} from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (must be the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function requireRepo(store: Store, owner: string, repo: string): Repo {
  if (owner !== VIEWER_LOGIN) throw new Error(`repository ${owner}/${repo} not found`);
  const found = store.getRepo(owner, repo);
  if (!found) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { ok: boolean; result?: Record<string, unknown>; error?: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, error: `missing required argument: ${required}` };
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (store.getRepo(VIEWER_LOGIN, repoName)) throw new Error(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
        const repo = store.createRepo(VIEWER_LOGIN, repoName, {
          private: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
        return { ok: true, result: toolResult(JSON.stringify(repoJson(repo))) };
      }
      case 'get_repo': {
        const repo = requireRepo(store, String(args.owner), String(args.repo));
        return { ok: true, result: toolResult(JSON.stringify(repoJson(repo))) };
      }
      case 'create_issue': {
        const repo = requireRepo(store, String(args.owner), String(args.repo));
        const { iso } = store.timestamp();
        const issue = {
          id: store.nextGlobalId(),
          number: repo.nextIssueNumber,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open' as const,
          labels: [],
          userLogin: VIEWER_LOGIN,
          createdSeq: store.nextSeq(),
          createdAt: iso,
          updatedAt: iso,
          comments: [],
        };
        repo.nextIssueNumber += 1;
        repo.issues.set(issue.number, issue);
        return { ok: true, result: toolResult(JSON.stringify(issueJson(repo, issue))) };
      }
      case 'list_issues': {
        const repo = requireRepo(store, String(args.owner), String(args.repo));
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
        return { ok: true, result: toolResult(JSON.stringify(issues.map((i) => issueJson(repo, i)))) };
      }
      case 'create_pull_request': {
        const repo = requireRepo(store, String(args.owner), String(args.repo));
        const head = String(args.head);
        const base = String(args.base);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha) throw new Error(`head branch ${head} does not exist`);
        if (!baseSha) throw new Error(`base branch ${base} does not exist`);
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
            throw new Error('a pull request already exists for this head and base');
          }
        }
        const { iso } = store.timestamp();
        const pull = {
          id: store.nextGlobalId(),
          number: repo.nextPullNumber,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open' as const,
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          mergeBaseSha: baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdSeq: store.nextSeq(),
          createdAt: iso,
          updatedAt: iso,
        };
        repo.nextPullNumber += 1;
        repo.pulls.set(pull.number, pull);
        return { ok: true, result: toolResult(JSON.stringify(pullJson(repo, pull))) };
      }
      case 'merge_pull_request': {
        const repo = requireRepo(store, String(args.owner), String(args.repo));
        const number = Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (!pull) throw new Error(`pull request #${number} not found`);
        if (pull.state !== 'open') throw new Error('pull request is already closed');
        if (!computeMergeable(repo, pull)) throw new Error('merge conflict: the pull request cannot be merged');
        doMergePull(store, repo, pull);
        return { ok: true, result: toolResult(JSON.stringify(pullJson(repo, pull))) };
      }
      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface McpResponse {
  status: number;
  body: string | null; // null = empty body
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and the response body (a JSON string,
 * or null for an empty body, as for notifications).
 */
export function handleMcp(store: Store, rawBody: string): McpResponse {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const req = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in req ? req.id : undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id): acknowledge with an empty 202.
  if (id === undefined) {
    return { status: 202, body: null };
  }

  const error = (code: number, message: string): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });
  const result = (value: unknown): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result: value }),
  });

  switch (method) {
    case 'initialize': {
      return result({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list': {
      // A fixed array: byte-identical across calls.
      return result({ tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return error(-32602, `unknown tool: ${toolName}`);
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return error(-32602, `missing required argument: ${required}`);
        }
      }
      const called = callTool(store, toolName, args);
      if (!called.ok) return result(toolResult(`Error: ${called.error ?? 'tool call failed'}`, true));
      return result(called.result);
    }
    default:
      return error(-32601, `method not found: ${method}`);
  }
}
