// GitHub GraphQL v4: a small hand-rolled parser + executor for the documents gh and
// github-mcp-server send. No GraphQL library; the schema is the subset the checks use.

import {
  computeMergeable,
  diffFiles,
  doMergePull,
} from './rest.ts';
import {
  globalId,
  parseGlobalId,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'int', value: parseInt(source.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export interface FieldNode {
  alias: string | null;
  name: string;
  arguments: Record<string, unknown>;
  selections: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = this.next().value as 'query' | 'mutation' | 'subscription';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.expectName();
    // Variable definitions: ($x: Type!, ...).
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.skipParens();
    }
    const selections = this.parseSelectionSet();
    return { operation, name, selections };
  }

  private skipParens(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated parentheses in GraphQL document');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next.kind === 'name') {
        // Named fragment spread: not used by the checks; skip its name.
        this.next();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (@skip/@include): not used by the checks; skip them.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, arguments: args, selections } };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        list.push(this.parseValue());
      }
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
    const record = value as Record<string, unknown>;
    if ('__var' in record && typeof record.__var === 'string') return variables[record.__var] ?? null;
    if ('__enum' in record) return record.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// the schema the checks probe
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'url',
  ],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Node: ['id'],
};

const SCHEMA_FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestFileConnection', author: 'User', mergeCommit: 'Commit' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  Issue: { author: 'User' },
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MARKETPLACE', 'TOPIC', 'WIKI'];

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Value =
  | { __kind: 'User'; login: string; id: number; name: string; email: string }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'Ref'; name: string }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'IssueConnection'; repo: Repo; all: Issue[]; first: number | null; after: number }
  | { __kind: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __kind: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __kind: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] }
  | { __kind: 'PullRequestFileConnection'; repo: Repo; pull: PullRequest }
  | { __kind: 'PullRequestFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __kind: '__Type'; name: string }
  | { __kind: 'Node'; id: string; inner: Value | null };

function typeOf(value: Value): string {
  switch (value.__kind) {
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Ref': return 'Ref';
    case 'Issue': return 'Issue';
    case 'IssueConnection': return 'IssueConnection';
    case 'IssueEdge': return 'IssueEdge';
    case 'PullRequest': return 'PullRequest';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'PullRequestFileConnection': return 'PullRequestFileConnection';
    case 'PullRequestFile': return 'PullRequestFile';
    case 'PageInfo': return 'PageInfo';
    case '__Type': return '__Type';
    case 'Node': return value.inner ? typeOf(value.inner) : 'Node';
  }
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isNaN(n) ? -1 : n;
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Issue') return null;
  const hash = parsed.key.lastIndexOf('#');
  if (hash < 0) return null;
  const fullName = parsed.key.slice(0, hash);
  const number = parseInt(parsed.key.slice(hash + 1), 10);
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return null;
  const repo = findRepo(store, owner, name);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'PullRequest') return null;
  const hash = parsed.key.lastIndexOf('#');
  if (hash < 0) return null;
  const fullName = parsed.key.slice(0, hash);
  const number = parseInt(parsed.key.slice(hash + 1), 10);
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return null;
  const repo = findRepo(store, owner, name);
  if (!repo) return null;
  const pull = repo.pulls.get(number);
  return pull ? { repo, pull } : null;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return null;
  return findRepo(store, owner, name);
}

/** Validate the document against the schema; returns error messages (empty when valid). */
function validate(selections: SelectionNode[], parentType: string, path: string[]): string[] {
  const errors: string[] = [];
  const fields = SCHEMA_FIELDS[parentType] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const type = selection.typeCondition ?? parentType;
      errors.push(...validate(selection.selections, type, path));
      continue;
    }
    const field = selection.field;
    if (!fields.includes(field.name)) {
      errors.push(`Cannot query field "${field.name}" on type "${parentType}".`);
      continue;
    }
    const childType = SCHEMA_FIELD_TYPES[parentType]?.[field.name];
    if (childType && field.selections.length) {
      errors.push(...validate(field.selections, childType, [...path, field.name]));
    }
  }
  return errors;
}

function executeSelections(
  ctx: GqlContext,
  value: Value | null,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (value === null) return null;
  // A Node resolves its fields against the concrete value it wraps.
  const effective: Value = value.__kind === 'Node' && value.inner ? value.inner : value;
  const out: Record<string, unknown> = {};
  const type = typeOf(effective);
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== type) continue;
      const inner = executeSelections(ctx, effective, selection.selections, path);
      if (inner) Object.assign(out, inner);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args = resolveVariables(field.arguments, ctx.variables) as Record<string, unknown>;
    const resolved = resolveField(ctx, effective, field.name, args, field.selections, [...path, key]);
    out[key] = resolved;
  }
  return out;
}

function resolveField(
  ctx: GqlContext,
  value: Value,
  name: string,
  args: Record<string, unknown>,
  selections: SelectionNode[],
  path: Array<string | number>,
): unknown {
  const { store } = ctx;
  switch (value.__kind) {
    case 'User': {
      if (name === 'login') return value.login;
      if (name === 'id') return globalId('User', String(value.id));
      if (name === 'name') return value.name;
      if (name === 'email') return value.email;
      if (name === 'url') return `https://github.com/${value.login}`;
      return null;
    }
    case 'Repository': {
      const repo = value.repo;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return executeSelections(ctx, { __kind: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, name: repo.owner === VIEWER_LOGIN ? VIEWER_NAME : repo.owner, email: repo.owner === VIEWER_LOGIN ? VIEWER_EMAIL : '' }, selections, path);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return executeSelections(ctx, { __kind: 'Ref', name: repo.defaultBranch }, selections, path);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const number = args.number as number;
          const issue = repo.issues.get(number);
          if (!issue) return null;
          return executeSelections(ctx, { __kind: 'Issue', repo, issue }, selections, path);
        }
        case 'issues': return executeSelections(ctx, { __kind: 'IssueConnection', repo, all: filterIssues(repo, args), first: typeof args.first === 'number' ? (args.first as number) : null, after: indexFromCursor(args.after) }, selections, path);
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const first = args.first as number | undefined;
          if (typeof first === 'number') pulls = pulls.slice(0, first);
          return executeSelections(ctx, { __kind: 'PullRequestConnection', repo, pulls }, selections, path);
        }
        case 'pullRequest': {
          const number = args.number as number;
          const pull = repo.pulls.get(number);
          if (!pull) return null;
          return executeSelections(ctx, { __kind: 'PullRequest', repo, pull }, selections, path);
        }
        default: return null;
      }
    }
    case 'Ref': {
      if (name === 'name') return value.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return null;
      return null;
    }
    case 'Issue': {
      const issue = value.issue;
      switch (name) {
        case 'id': return issueGlobalId(value.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
        case 'author': return executeSelections(ctx, { __kind: 'User', login: issue.userLogin, id: issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001, name: issue.userLogin, email: '' }, selections, path);
        case 'url': return `https://github.com/${value.repo.owner}/${value.repo.name}/issues/${issue.number}`;
        default: return null;
      }
    }
    case 'IssueConnection': {
      const start = value.after >= 0 ? value.after + 1 : 0;
      const page = value.first === null ? value.all.slice(start) : value.all.slice(start, start + value.first);
      const hasNextPage = start + page.length < value.all.length;
      const endCursor = page.length ? cursorFor(start + page.length - 1) : null;
      if (name === 'nodes') {
        return page.map((issue) => executeSelections(ctx, { __kind: 'Issue', repo: value.repo, issue }, selections, path));
      }
      if (name === 'edges') {
        return page.map((issue, index) => executeSelections(ctx, { __kind: 'IssueEdge', repo: value.repo, issue, cursor: cursorFor(start + index) }, selections, path));
      }
      if (name === 'totalCount') return value.all.length;
      if (name === 'pageInfo') {
        return executeSelections(ctx, { __kind: 'PageInfo', hasNextPage, endCursor }, selections, path);
      }
      return null;
    }
    case 'IssueEdge': {
      if (name === 'node') return executeSelections(ctx, { __kind: 'Issue', repo: value.repo, issue: value.issue }, selections, path);
      if (name === 'cursor') return value.cursor;
      return null;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        return value.pulls.map((pull) => executeSelections(ctx, { __kind: 'PullRequest', repo: value.repo, pull }, selections, path));
      }
      if (name === 'totalCount') return value.pulls.length;
      if (name === 'pageInfo') {
        return executeSelections(ctx, { __kind: 'PageInfo', hasNextPage: false, endCursor: null }, selections, path);
      }
      return null;
    }
    case 'PullRequest': {
      const pull = value.pull;
      switch (name) {
        case 'id': return pullGlobalId(value.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return computeMergeable(value.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'merged': return pull.merged;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
        case 'mergedAt': return pull.mergedAt;
        case 'author': return executeSelections(ctx, { __kind: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, selections, path);
        case 'url': return `https://github.com/${value.repo.owner}/${value.repo.name}/pull/${pull.number}`;
        case 'files': {
          return executeSelections(ctx, { __kind: 'PullRequestFileConnection', repo: value.repo, pull }, selections, path);
        }
        default: return null;
      }
    }
    case 'PullRequestFileConnection': {
      const files = diffFiles(value.repo, value.pull.baseSha, value.pull.headSha);
      const first = (args as Record<string, unknown>).first as number | undefined;
      const limited = typeof first === 'number' ? files.slice(0, first) : files;
      if (name === 'nodes') {
        return limited.map((f) => executeSelections(ctx, { __kind: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }, selections, path));
      }
      if (name === 'totalCount') return files.length;
      if (name === 'pageInfo') {
        return executeSelections(ctx, { __kind: 'PageInfo', hasNextPage: false, endCursor: null }, selections, path);
      }
      return null;
    }
    case 'PullRequestFile': {
      if (name === 'path') return value.path;
      if (name === 'additions') return value.additions;
      if (name === 'deletions') return value.deletions;
      if (name === 'changeType') return value.changeType.toUpperCase();
      return null;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      if (name === 'endCursor') return value.endCursor;
      return null;
    }
    case '__Type': {
      if (name === 'name') return value.name;
      if (name === 'kind') return value.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const list = SCHEMA_FIELDS[value.name] ?? [];
        return list.map((fieldName) => ({ name: fieldName, description: null, type: null }));
      }
      if (name === 'enumValues') {
        if (value.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((entry) => ({ name: entry, description: null }));
      }
      if (name === 'description') return null;
      return null;
    }
    case 'Node': {
      if (name === 'id') return value.id;
      return null;
    }
    default:
      return null;
  }
}

/** Filter + order a repo's issues per the issues() arguments (before pagination). */
function filterIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  return issues;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function executeMutation(
  ctx: GqlContext,
  selections: SelectionNode[],
): Record<string, unknown> {
  const { store } = ctx;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args = resolveVariables(field.arguments, ctx.variables) as Record<string, unknown>;
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const { iso } = store.timestamp();
      const issue: Issue = {
        id: store.nextGlobalId(),
        number: repo.nextIssueNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        userLogin: VIEWER_LOGIN,
        createdSeq: store.nextSeq(),
        createdAt: iso,
        updatedAt: iso,
        comments: [],
      };
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      out[key] = { issue: executeSelections(ctx, { __kind: 'Issue', repo, issue }, wrapPayload(field, 'issue'), [key]) };
      continue;
    }
    if (field.name === 'closeIssue') {
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      const { iso } = store.timestamp();
      found.issue.state = 'closed';
      found.issue.updatedAt = iso;
      out[key] = { issue: executeSelections(ctx, { __kind: 'Issue', repo: found.repo, issue: found.issue }, wrapPayload(field, 'issue'), [key]) };
      continue;
    }
    if (field.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const headSha = resolveRefName(repo, headRef);
      const baseSha = resolveRefName(repo, baseRef);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base ref does not exist.' });
        out[key] = null;
        continue;
      }
      let duplicate = false;
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
        out[key] = null;
        continue;
      }
      const { iso } = store.timestamp();
      const pull: PullRequest = {
        id: store.nextGlobalId(),
        number: repo.nextPullNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: headRef,
        baseRef: baseRef,
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
      out[key] = { pullRequest: executeSelections(ctx, { __kind: 'PullRequest', repo, pull }, wrapPayload(field, 'pullRequest'), [key]) };
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        out[key] = null;
        continue;
      }
      if (found.pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull request is already closed.' });
        out[key] = null;
        continue;
      }
      if (!computeMergeable(found.repo, found.pull)) {
        ctx.errors.push({ message: 'Merge conflict: the pull request cannot be merged.' });
        out[key] = null;
        continue;
      }
      doMergePull(store, found.repo, found.pull);
      out[key] = { pullRequest: executeSelections(ctx, { __kind: 'PullRequest', repo: found.repo, pull: found.pull }, wrapPayload(field, 'pullRequest'), [key]) };
      continue;
    }
    if (field.name === 'addComment') {
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const { iso } = store.timestamp();
      const comment = {
        id: store.nextComment(),
        body,
        userLogin: VIEWER_LOGIN,
        createdAt: iso,
        updatedAt: iso,
      };
      found.issue.comments.push(comment);
      found.issue.updatedAt = iso;
      // The mutation selects addComment { commentEdge { node { id body } } }.
      const edgeSelections = field.selections;
      const edgeOut: Record<string, unknown> = {};
      for (const edgeSel of edgeSelections) {
        if (edgeSel.kind !== 'field') continue;
        if (edgeSel.field.name === 'commentEdge') {
          const nodeOut: Record<string, unknown> = {};
          for (const nodeSel of edgeSel.field.selections) {
            if (nodeSel.kind !== 'field') continue;
            if (nodeSel.field.name === 'node') {
              const nodeFields: Record<string, unknown> = {};
              for (const f of nodeSel.field.selections) {
                if (f.kind !== 'field') continue;
                if (f.field.name === 'id') nodeFields[f.field.alias ?? 'id'] = globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`);
                if (f.field.name === 'body') nodeFields[f.field.alias ?? 'body'] = comment.body;
              }
              nodeOut[nodeSel.field.alias ?? 'node'] = nodeFields;
            }
          }
          edgeOut[edgeSel.field.alias ?? 'commentEdge'] = nodeOut;
        }
      }
      out[key] = edgeOut;
      continue;
    }
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'.` });
    out[key] = null;
  }
  return out;
}

/** The selections under a mutation payload field (e.g. createIssue { issue { ... } }). */
function wrapPayload(field: FieldNode, payloadName: string): SelectionNode[] {
  for (const selection of field.selections) {
    if (selection.kind === 'field' && selection.field.name === payloadName) return selection.field.selections;
  }
  return field.selections;
}

function resolveRefName(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef)!;
  return null;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: unknown;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  const ctx: GqlContext = { store, variables, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
  }
  const operation = operations[0]!;
  // Validation pass (unknown fields -> 200 with errors, data null).
  const parentType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors =
    parentType === 'Mutation'
      ? validateMutation(operation.selections)
      : validate(operation.selections, 'Query', []);
  if (validationErrors.length) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  if (operation.operation === 'mutation') {
    const data = executeMutation(ctx, operation.selections);
    return { data, errors: ctx.errors };
  }
  // Query root.
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args = resolveVariables(field.arguments, ctx.variables) as Record<string, unknown>;
    if (field.name === 'viewer') {
      data[key] = executeSelections(ctx, { __kind: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, field.selections, [key]);
      continue;
    }
    if (field.name === 'repository') {
      const repo = findRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
      data[key] = repo ? executeSelections(ctx, { __kind: 'Repository', repo }, field.selections, [key]) : null;
      continue;
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      let inner: Value | null = null;
      if (parsed?.type === 'Repository') {
        const repo = findRepoByGlobalId(store, id);
        if (repo) inner = { __kind: 'Repository', repo };
      } else if (parsed?.type === 'Issue') {
        const found = findIssueByGlobalId(store, id);
        if (found) inner = { __kind: 'Issue', repo: found.repo, issue: found.issue };
      } else if (parsed?.type === 'PullRequest') {
        const found = findPullByGlobalId(store, id);
        if (found) inner = { __kind: 'PullRequest', repo: found.repo, pull: found.pull };
      }
      if (!inner) {
        data[key] = null;
        continue;
      }
      data[key] = executeSelections(ctx, { __kind: 'Node', id, inner }, field.selections, [key]);
      continue;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const known = ['Issue', 'PullRequest', 'Repository', 'SearchType', 'User'];
      if (!known.includes(name)) {
        data[key] = null;
        continue;
      }
      data[key] = executeSelections(ctx, { __kind: '__Type', name }, field.selections, [key]);
      continue;
    }
    if (field.name === '__schema') {
      data[key] = null;
      continue;
    }
    data[key] = null;
  }
  return { data, errors: ctx.errors };
}

function validateMutation(selections: SelectionNode[]): string[] {
  const known = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
  const errors: string[] = [];
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    if (!known.includes(selection.field.name)) {
      errors.push(`Field '${selection.field.name}' doesn't exist on type 'Mutation'.`);
    }
  }
  return errors;
}
