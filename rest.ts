// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments,
// pull requests, files, merges — all on the shared in-memory store.

import {
  buildCommit,
  buildTreeForFiles,
  flattenTree,
  globalId,
  hashObject,
  mergeBase,
  parseCommit,
  parseTree,
  removeFromTree,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  type Comment,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface HttpError {
  status: number;
  message: string;
}

export function httpError(status: number, message: string): HttpError {
  return { status, message };
}

export function isHttpError(value: unknown): value is HttpError {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as HttpError).status === 'number' &&
    typeof (value as HttpError).message === 'string'
  );
}

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: globalId('User', String(id)),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', String(label.id)),
    url: label.url,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.userLogin, issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.userLogin, comment.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001),
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    rebaseable: true,
    merge_method: 'squash',
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') throw httpError(404, 'No commit found for SHA');
  const view = parseCommit(object.data);
  const authorLine = parseIdent(view.author);
  const committerLine = parseIdent(view.committer);
  const parents = view.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` }));
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: { name: authorLine.name, email: authorLine.email, date: authorLine.date },
      committer: { name: committerLine.name, email: committerLine.email, date: committerLine.date },
      message: view.message,
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    parents,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  // "Name <email> 1735689600 +0000"
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(parseInt(match[3]!, 10) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

export function paginate<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

export function linkHeader(base: string, path: string, query: URLSearchParams, params: PageParams, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  if (totalPages <= 1) return null;
  const make = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `${base}${path}?${q.toString()}`;
  };
  const links: string[] = [];
  if (params.page < totalPages) links.push(`<${make(params.page + 1)}>; rel="next"`);
  if (params.page > 1) links.push(`<${make(params.page - 1)}>; rel="prev"`);
  links.push(`<${make(1)}>; rel="first"`);
  links.push(`<${make(totalPages)}>; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// repository helpers
// ---------------------------------------------------------------------------------------------

export function requireRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw httpError(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) throw httpError(404, 'Not Found');
  return repo;
}

function readTreeAt(repo: Repo, ref: string | null): string {
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : storeResolveRef(repo, ref);
  if (!tip) throw httpError(404, 'Not Found');
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') throw httpError(404, 'Not Found');
  return parseCommit(object.data).tree;
}

function storeResolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef)!;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

type PathLookup =
  | {
      kind: 'file';
      blobOid: string;
      treeOid: string;
      name: string;
      path: string;
    }
  | {
      kind: 'dir';
      treeOid: string;
      name: string;
      path: string;
    };

function lookupPath(repo: Repo, treeOid: string, path: string): PathLookup | null {
  const segments = path.split('/').filter((s) => s !== '');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentTree);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    const isLast = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (isLast) return { kind: 'dir', treeOid: entry.oid, name: entry.name, path };
      currentTree = entry.oid;
    } else {
      if (!isLast) return null;
      return { kind: 'file', blobOid: entry.oid, treeOid: currentTree, name: entry.name, path };
    }
  }
  return { kind: 'dir', treeOid: currentTree, name: '', path };
}

// ---------------------------------------------------------------------------------------------
// diff helpers
// ---------------------------------------------------------------------------------------------

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS on lines (contents here are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: n - lcs, deletions: m - lcs };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffFiles(repo: Repo, baseSha: string, headSha: string): FileChange[] {
  const lookup = (oid: string) => repo.objects.get(oid);
  const base = mergeBase(baseSha, headSha, lookup) ?? baseSha;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(headSha);
  if (!baseCommit || !headCommit) return [];
  const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
  const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const content = repo.objects.get(h!)!.data.toString('utf8');
      const lines = content === '' ? 0 : content.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (h === undefined) {
      const content = repo.objects.get(b)!.data.toString('utf8');
      const lines = content === '' ? 0 : content.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const oldText = repo.objects.get(b)!.data.toString('utf8');
      const newText = repo.objects.get(h)!.data.toString('utf8');
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Perform a squash merge of an open, mergeable pull request. Shared by REST and GraphQL. */
export function doMergePull(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { merged: boolean; sha: string; message: string } {
  const lookup = (oid: string) => repo.objects.get(oid);
  const base = mergeBase(pull.baseSha, pull.headSha, lookup) ?? pull.baseSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const baseCommit = repo.objects.get(baseTip)!;
  const baseTree = parseCommit(baseCommit.data).tree;
  const mergeBaseCommit = repo.objects.get(base)!;
  const mergeBaseFiles = flattenTree(parseCommit(mergeBaseCommit.data).tree, lookup);
  const headCommit = repo.objects.get(pull.headSha)!;
  const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
  const applied = new Map<string, string>();
  for (const [path, oid] of headFiles) {
    if (mergeBaseFiles.get(path) !== oid) applied.set(path, oid);
  }
  const removed: string[] = [];
  for (const path of mergeBaseFiles.keys()) {
    if (!headFiles.has(path)) removed.push(path);
  }
  let newTree = buildTreeForFiles(
    baseTree,
    applied,
    lookup,
    (type, data) => store.putObject(repo, type, data),
  );
  if (removed.length) {
    newTree = removeFromTree(
      newTree,
      removed,
      lookup,
      (type, data) => store.putObject(repo, type, data),
    );
  }
  const { sec, iso } = store.timestamp();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const message = `${pull.title} (#${pull.number})`;
  const commitData = buildCommit({
    tree: newTree,
    parents: [baseTip],
    author: ident,
    committer: ident,
    timestamp: sec,
    message,
  });
  const mergeSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = iso;
  return { merged: true, sha: mergeSha, message };
}
export function computeMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open') return false;
  const lookup = (oid: string) => repo.objects.get(oid);
  const base = mergeBase(pull.baseSha, pull.headSha, lookup);
  if (base === null) return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return false;
  const baseCommit = repo.objects.get(baseTip);
  const mergeBaseCommit = repo.objects.get(base);
  if (!baseCommit || !mergeBaseCommit) return false;
  const currentFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
  const mergeBaseFiles = flattenTree(parseCommit(mergeBaseCommit.data).tree, lookup);
  const headCommit = repo.objects.get(pull.headSha);
  if (!headCommit) return false;
  const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
  const changed = new Set<string>();
  for (const path of new Set([...mergeBaseFiles.keys(), ...headFiles.keys()])) {
    if (mergeBaseFiles.get(path) !== headFiles.get(path)) changed.add(path);
  }
  for (const path of changed) {
    if (currentFiles.get(path) !== mergeBaseFiles.get(path)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// the REST router
// ---------------------------------------------------------------------------------------------

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const noBody = (status: number): RestResult => ({ status, body: null });

function json(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

/**
 * Handle one REST request. `segments` are the path parts after `/api/v3/`.
 * `body` is the parsed JSON body (or null when none / unparsable — the caller maps a
 * parse failure to 400 before calling here).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  const seg = (i: number): string | undefined => segments[i];
  const decode = (value: string | undefined): string => (value === undefined ? '' : decodeURIComponent(value));

  // GET /api/v3/ — root.
  if (segments.length === 0) {
    if (method !== 'GET') throw httpError(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') throw httpError(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (segments.length === 1 && seg(0) === 'user') {
    if (method !== 'GET') throw httpError(404, 'Not Found');
    return json(200, userJson(VIEWER_LOGIN, VIEWER_ID));
  }

  // /api/v3/user/repos
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const params = pageParams(query);
      const all = store.listRepos(VIEWER_LOGIN);
      const page = paginate(all, params).map(repoJson);
      const link = linkHeader(baseUrl, '/api/v3/user/repos', query, params, all.length);
      return json(200, page, link ? { link } : undefined);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') throw httpError(422, 'Repository creation failed: name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw httpError(422, 'Repository creation failed: invalid name');
      if (store.getRepo(VIEWER_LOGIN, name)) throw httpError(422, 'Repository creation failed: name already exists on this account');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: input.private === true,
        description: typeof input.description === 'string' ? input.description : '',
      });
      return json(201, repoJson(repo));
    }
    throw httpError(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = decode(seg(1));
    const name = decode(seg(2));
    const repo = requireRepo(store, owner, name);
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        const { sec, iso } = store.timestamp();
        void sec;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        repo.updatedAt = iso;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noBody(204);
      }
      throw httpError(404, 'Not Found');
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      const branches: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (ref.startsWith('refs/heads/')) branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
      }
      return json(200, branches);
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      const shaParam = query.get('sha');
      const tip = shaParam ? storeResolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) throw httpError(404, 'No commit found for SHA');
      const params = pageParams(query);
      const all = store.listCommits(repo, tip);
      const page = paginate(all, params).map((sha) => commitJson(repo, sha));
      const link = linkHeader(baseUrl, `/api/v3/repos/${owner}/${name}/commits`, query, params, all.length);
      return json(200, page, link ? { link } : undefined);
    }

    // GET /repos/{o}/{r}/commits/{sha}
    if (rest.length === 2 && rest[0] === 'commits') {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      return json(200, commitJson(repo, decode(rest[1])));
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') throw httpError(404, 'Not Found');
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) throw httpError(422, 'Invalid ref or sha');
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') throw httpError(422, 'Object does not exist');
      if (repo.refs.has(ref)) throw httpError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return json(201, {
        ref,
        node_id: globalId('Ref', `${owner}/${name}:${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      });
    }

    // GET /repos/{o}/{r}/git/refs/{ref...} (read a ref)
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      const ref = rest.slice(2).map(decode).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) throw httpError(404, 'Not Found');
      return json(200, {
        ref,
        node_id: globalId('Ref', `${owner}/${name}:${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      });
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decode).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const treeOid = readTreeAt(repo, ref);
        const found = lookupPath(repo, treeOid, path);
        if (!found) throw httpError(404, 'Not Found');
        if (found.kind === 'file') {
          const blob = repo.objects.get(found.blobOid)!;
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: found.name,
            path: found.path,
            content: blob.data.toString('base64'),
            sha: found.blobOid,
            url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${found.blobOid}`,
            html_url: `https://github.com/${owner}/${name}/blob/HEAD/${path}`,
            download_url: null,
            _links: { git: `/api/v3/repos/${owner}/${name}/git/blobs/${found.blobOid}`, self: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, html: `https://github.com/${owner}/${name}/blob/HEAD/${path}` },
          });
        }
        const tree = repo.objects.get(found.treeOid)!;
        const entries: Record<string, unknown>[] = [];
        for (const entry of parseTree(tree.data)) {
          const isDir = entry.mode === '40000';
          const child = repo.objects.get(entry.oid);
          entries.push({
            type: isDir ? 'dir' : 'file',
            size: isDir ? 0 : child?.data.length ?? 0,
            name: entry.name,
            path: found.path ? `${found.path}/${entry.name}` : entry.name,
            sha: entry.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(found.path ? `${found.path}/${entry.name}` : entry.name)}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
            html_url: `https://github.com/${owner}/${name}/tree/HEAD/${found.path ? `${found.path}/${entry.name}` : entry.name}`,
            download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${found.path ? `${found.path}/${entry.name}` : entry.name}`,
          });
        }
        return json(200, entries);
      }
      if (method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        if (contentB64 === '') throw httpError(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          throw httpError(422, 'content is not valid base64');
        }
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip && repo.refs.size > 0) throw httpError(422, 'Branch does not exist');
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        // Current state of the file on the branch.
        let currentBlob: string | null = null;
        if (tip) {
          const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
          const found = lookupPath(repo, treeOid, path);
          if (found && found.kind === 'file') currentBlob = found.blobOid;
        }
        if (currentBlob !== null) {
          if (sha === undefined) throw httpError(422, 'File already exists: sha is required to update it');
          if (sha.toLowerCase() !== currentBlob.toLowerCase()) throw httpError(409, 'Conflict: sha does not match the current file');
        }
        const { commitSha, contentSha } = store.commitFile(repo, branch, path, content, message);
        const blob = repo.objects.get(contentSha)!;
        return json(currentBlob !== null ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: contentSha,
            size: blob.data.length,
            encoding: 'base64',
            url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
            html_url: `https://github.com/${owner}/${name}/blob/HEAD/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${contentSha}`,
            download_url: null,
            type: 'file',
            _links: { git: `/api/v3/repos/${owner}/${name}/git/blobs/${contentSha}`, self: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, html: `https://github.com/${owner}/${name}/blob/HEAD/${path}` },
          },
          commit: {
            sha: commitSha,
            node_id: globalId('Commit', commitSha),
            message,
            url: `/api/v3/repos/${owner}/${name}/commits/${commitSha}`,
            html_url: `https://github.com/${owner}/${name}/commit/${commitSha}`,
          },
        });
      }
      if (method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) throw httpError(404, 'Not Found');
        const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
        const found = lookupPath(repo, treeOid, path);
        if (!found || found.kind !== 'file') throw httpError(404, 'Not Found');
        if (sha !== undefined && sha.toLowerCase() !== found.blobOid.toLowerCase()) {
          throw httpError(409, 'Conflict: sha does not match the current file');
        }
        const newTree = removeFromTree(
          treeOid,
          [path],
          (oid) => repo.objects.get(oid),
          (type, data) => store.putObject(repo, type, data),
        );
        const { sec } = store.timestamp();
        const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
        const commitData = buildCommit({
          tree: newTree,
          parents: [tip],
          author: ident,
          committer: ident,
          timestamp: sec,
          message,
        });
        const commitSha = store.putObject(repo, 'commit', commitData);
        repo.refs.set(refName, commitSha);
        return json(200, {
          commit: {
            sha: commitSha,
            node_id: globalId('Commit', commitSha),
            message,
            url: `/api/v3/repos/${owner}/${name}/commits/${commitSha}`,
            html_url: `https://github.com/${owner}/${name}/commit/${commitSha}`,
          },
        });
      }
      throw httpError(404, 'Not Found');
    }

    // POST/GET /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map(labelJson));
      }
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name === '') throw httpError(422, 'Label name is required');
        if (repo.labels.has(name)) throw httpError(422, 'Label already exists');
        const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
        const label: Label = {
          id: store.nextLabel(),
          name,
          color,
          description: typeof input.description === 'string' ? input.description : '',
          url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(name)}`,
        };
        repo.labels.set(name, label);
        return json(201, labelJson(label));
      }
      throw httpError(404, 'Not Found');
    }

    // /repos/{o}/{r}/issues
    if (rest[0] === 'issues') {
      // GET /repos/{o}/{r}/issues/{n}/comments and POST
      if (rest.length === 3 && rest[2] === 'comments') {
        const number = parseInt(rest[1]!, 10);
        const issue = repo.issues.get(number);
        if (!issue) throw httpError(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const text = typeof input.body === 'string' ? input.body : '';
          if (text === '') throw httpError(422, 'Comment body is required');
          const { iso } = store.timestamp();
          const comment: Comment = { id: store.nextComment(), body: text, userLogin: VIEWER_LOGIN, createdAt: iso, updatedAt: iso };
          issue.comments.push(comment);
          issue.updatedAt = iso;
          return json(201, commentJson(repo, issue, comment));
        }
        throw httpError(404, 'Not Found');
      }
      // GET/PATCH /repos/{o}/{r}/issues/{n}
      if (rest.length === 2) {
        const number = parseInt(rest[1]!, 10);
        const issue = repo.issues.get(number);
        if (!issue) throw httpError(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          const { iso } = store.timestamp();
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          issue.updatedAt = iso;
          return json(200, issueJson(repo, issue));
        }
        throw httpError(404, 'Not Found');
      }
      // GET/POST /repos/{o}/{r}/issues
      if (rest.length === 1) {
        if (method === 'GET') {
          const params = pageParams(query);
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let all = [...repo.issues.values()];
          if (state !== 'all') all = all.filter((i) => i.state === state);
          if (sort === 'created') {
            all.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const page = paginate(all, params).map((i) => issueJson(repo, i));
          const link = linkHeader(baseUrl, `/api/v3/repos/${owner}/${name}/issues`, query, params, all.length);
          return json(200, page, link ? { link } : undefined);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') throw httpError(422, 'Title is required');
          const labelNames = Array.isArray(input.labels)
            ? input.labels.filter((l): l is string => typeof l === 'string')
            : [];
          const labels: Label[] = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (!label) throw httpError(422, `Label does not exist: ${labelName}`);
            labels.push(label);
          }
          const { iso } = store.timestamp();
          const issue: Issue = {
            id: store.nextGlobalId(),
            number: repo.nextIssueNumber,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels,
            userLogin: VIEWER_LOGIN,
            createdSeq: store.nextSeq(),
            createdAt: iso,
            updatedAt: iso,
            comments: [],
          };
          repo.nextIssueNumber += 1;
          repo.issues.set(issue.number, issue);
          return json(201, issueJson(repo, issue));
        }
        throw httpError(404, 'Not Found');
      }
      throw httpError(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls
    if (rest[0] === 'pulls') {
      // GET /repos/{o}/{r}/pulls/{n}/files
      if (rest.length === 3 && rest[2] === 'files') {
        const number = parseInt(rest[1]!, 10);
        const pull = repo.pulls.get(number);
        if (!pull) throw httpError(404, 'Not Found');
        const files = diffFiles(repo, pull.baseSha, pull.headSha).map((f) => ({
          sha: hashObject('blob', Buffer.from(f.filename, 'utf8')),
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: `https://github.com/${owner}/${name}/blob/${pull.headSha}/${f.filename}`,
          raw_url: `https://github.com/${owner}/${name}/raw/${pull.headSha}/${f.filename}`,
          contents_url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(f.filename)}?ref=${pull.headSha}`,
          patch: '',
        }));
        return json(200, files);
      }
      // PUT /repos/{o}/{r}/pulls/{n}/merge
      if (rest.length === 3 && rest[2] === 'merge') {
        const number = parseInt(rest[1]!, 10);
        const pull = repo.pulls.get(number);
        if (!pull) throw httpError(404, 'Not Found');
        if (method !== 'PUT') throw httpError(404, 'Not Found');
        if (pull.state !== 'open') throw httpError(405, 'Pull request is already closed');
        if (!computeMergeable(repo, pull)) throw httpError(405, 'Merge conflict: the pull request cannot be merged');
        const result = doMergePull(store, repo, pull);
        return json(200, result);
      }
      // GET /repos/{o}/{r}/pulls/{n}
      if (rest.length === 2) {
        const number = parseInt(rest[1]!, 10);
        const pull = repo.pulls.get(number);
        if (!pull) throw httpError(404, 'Not Found');
        if (method !== 'GET') throw httpError(404, 'Not Found');
        return json(200, pullJson(repo, pull));
      }
      // GET/POST /repos/{o}/{r}/pulls
      if (rest.length === 1) {
        if (method === 'GET') {
          const params = pageParams(query);
          const state = query.get('state') ?? 'open';
          let all = [...repo.pulls.values()];
          if (state !== 'all') all = all.filter((p) => p.state === state);
          all.sort((a, b) => a.number - b.number);
          const page = paginate(all, params).map((p) => pullJson(repo, p));
          const link = linkHeader(baseUrl, `/api/v3/repos/${owner}/${name}/pulls`, query, params, all.length);
          return json(200, page, link ? { link } : undefined);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          if (title === '' || head === '') throw httpError(422, 'Title and head are required');
          const headSha = storeResolveRef(repo, head);
          const baseSha = storeResolveRef(repo, base);
          if (!headSha) throw httpError(422, 'Head branch does not exist');
          if (!baseSha) throw httpError(422, 'Base branch does not exist');
          if (head === base) throw httpError(422, 'Head and base must differ');
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
              throw httpError(422, 'A pull request already exists for this head and base');
            }
          }
          const lookup = (oid: string) => repo.objects.get(oid);
          const baseOfMerge = mergeBase(baseSha, headSha, lookup) ?? baseSha;
          const { iso } = store.timestamp();
          const pull: PullRequest = {
            id: store.nextGlobalId(),
            number: repo.nextPullNumber,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            mergeBaseSha: baseOfMerge,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdSeq: store.nextSeq(),
            createdAt: iso,
            updatedAt: iso,
          };
          repo.nextPullNumber += 1;
          repo.pulls.set(pull.number, pull);
          return json(201, pullJson(repo, pull));
        }
        throw httpError(404, 'Not Found');
      }
      throw httpError(404, 'Not Found');
    }
  }

  throw httpError(404, 'Not Found');
}
