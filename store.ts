// The in-memory store and the git object model for the github-core-clone forge.
// Everything is deterministic: a logical clock (no wall time, no Math.random) drives
// every timestamp, so two runs of the same request sequence produce the same state.
//
// Scenario identities (from the contest's fixed seed, wire.ts SCENARIO_SEED):
//   viewer   = adaiversen (id 1000) — the login the bearer token names.
//   stranger = olgabauer — another seeded login with no rights on the viewer's repos.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

const SHA40 = /^[0-9a-f]{40}$/;

/** A logical clock: base 2025-01-01T00:00:00Z, +1s per tick. Deterministic. */
export class Clock {
  private seconds = 1_735_689_600;
  tick(): number {
    this.seconds += 1;
    return this.seconds;
  }
  now(): number {
    return this.seconds;
  }
  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }
}

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return SHA40.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git-canonical order (dirs sort as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  // The raw object ends the message with a newline; the API surfaces it without one.
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  const who = (ident: string): string => `${ident} ${fields.timestamp} +0000`;
  lines.push(`author ${who(fields.author)}`, `committer ${who(fields.committer)}`, '');
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of `descendant` (or equal)? Walks commit parents only. */
export function isAncestor(
  ancestor: string,
  descendant: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found by BFS from both sides. */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  if (a === b) return a;
  const ancestorsOf = (start: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length) {
      const [oid, d] = queue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, d);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
    }
    return dist;
  };
  const da = ancestorsOf(a);
  const db = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, d] of da) {
    const e = db.get(oid);
    if (e === undefined) continue;
    const score = d + e;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Flat path -> blob oid map of a tree (recursive). */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (or rebuild) the tree for `files` (path -> blob oid) on top of `baseTreeOid`. */
export function buildTreeForFiles(
  baseTreeOid: string | null,
  files: Map<string, string>,
  lookup: (oid: string) => GitObject | undefined,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  const load = (treeOid: string | null, node: Node): void => {
    if (!treeOid) return;
    const object = lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        const child = make();
        node.dirs.set(entry.name, child);
        load(entry.oid, child);
      } else {
        node.files.set(entry.name, entry.oid);
      }
    }
  };
  load(baseTreeOid, root);
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const remove = (node: Node, segments: string[]): void => {
    if (segments.length === 1) {
      node.files.delete(segments[0]!);
      return;
    }
    const child = node.dirs.get(segments[0]!);
    if (!child) return;
    remove(child, segments.slice(1));
    if (child.files.size === 0 && child.dirs.size === 0) node.dirs.delete(segments[0]!);
  };
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Remove `paths` from the tree at `baseTreeOid`; returns the new root tree oid. */
export function removeFromTree(
  baseTreeOid: string,
  paths: readonly string[],
  lookup: (oid: string) => GitObject | undefined,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  const load = (treeOid: string, node: Node): void => {
    const object = lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        const child = make();
        node.dirs.set(entry.name, child);
        load(entry.oid, child);
      } else {
        node.files.set(entry.name, entry.oid);
      }
    }
  };
  load(baseTreeOid, root);
  const remove = (node: Node, segments: string[]): void => {
    if (segments.length === 1) {
      node.files.delete(segments[0]!);
      return;
    }
    const child = node.dirs.get(segments[0]!);
    if (!child) return;
    remove(child, segments.slice(1));
    if (child.files.size === 0 && child.dirs.size === 0) node.dirs.delete(segments[0]!);
  };
  for (const path of paths) remove(root, path.split('/'));
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// packfiles (v2, no deltas on write; deltas resolved on read)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return size;
  };
  const baseSize = readSize();
  const resultSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      // Copy from base: offset/size bytes follow in flag order.
      let p = pos;
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[p]!; p += 1; }
      if (op & 0x02) { offset |= delta[p]! << 8; p += 1; }
      if (op & 0x04) { offset |= delta[p]! << 16; p += 1; }
      if (op & 0x08) { offset |= delta[p]! << 24; p += 1; }
      if (op & 0x10) { size = delta[p]!; p += 1; }
      if (op & 0x20) { size |= delta[p]! << 8; p += 1; }
      if (op & 0x40) { size |= delta[p]! << 16; p += 1; }
      if (size === 0) size = 0x10000;
      pos = p;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Parse a packfile into objects (resolving OFS_DELTA and REF_DELTA against the pack itself). */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  interface PendingDelta { offset: number; type: 'ofs' | 'ref'; base: number | string; data: Buffer }
  const pending: PendingDelta[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: the base offset is encoded git-style (base position = start - value).
      let p = offset;
      let baseOffset = pack[p]! & 0x7f;
      p += 1;
      while (pack[p - 1]! & 0x80) {
        baseOffset = ((baseOffset + 1) << 7) | (pack[p]! & 0x7f);
        p += 1;
      }
      const basePos = start - baseOffset;
      const inflated = inflateSync(pack.subarray(p));
      const consumed = packInflatedLength(pack, p);
      offset = p + consumed;
      pending.push({ offset: start, type: 'ofs', base: basePos, data: inflated });
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      const consumed = packInflatedLength(pack, offset);
      offset += consumed;
      pending.push({ offset: start, type: 'ref', base: baseOid, data: inflated });
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateSync(pack.subarray(offset));
      const consumed = packInflatedLength(pack, offset);
      offset += consumed;
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated);
      const object: GitObject = { type, data: inflated };
      objects.set(oid, object);
      byOffset.set(start, object);
    }
  }
  // Resolve deltas (possibly chained).
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i]!;
      const base = entry.type === 'ofs' ? byOffset.get(entry.base as number) : objects.get(entry.base as string);
      if (!base) continue;
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(object.type, data);
      objects.set(oid, object);
      byOffset.set(entry.offset, object);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length) throw new Error('unresolved pack delta base');
  return objects;
}

/** Bytes consumed by the zlib stream starting at `offset` (by trial inflate with growing input). */
function packInflatedLength(pack: Buffer, offset: number): number {
  // inflateSync needs the exact end; find it by scanning: zlib streams end with an adler32 and
  // the next object starts right after. Use a bounded binary search on the input length.
  let low = 1;
  let high = pack.length - offset;
  // First find any length that inflates cleanly.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'end' });
      offset += 4;
    } else {
      if (offset + len > buffer.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, PullRequest>;
  nextPullNumber: number;
  labels: Map<string, Label>;
}

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextGlobalId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  nextComment(): number {
    this.nextCommentId += 1;
    return this.nextCommentId;
  }

  nextLabel(): number {
    this.nextLabelId += 1;
    return this.nextLabelId;
  }

  timestamp(): { sec: number; iso: string } {
    const sec = this.clock.tick();
    return { sec, iso: this.clock.iso(sec) };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const { sec, iso } = this.timestamp();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      createdAt: iso,
      updatedAt: iso,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      labels: new Map(),
    };
    this.nextRepoId += 1;
    void sec;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Store an object in a repo (idempotent by hash). Returns the oid. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Commit a single file (path -> bytes) on `branch`, creating the branch if needed. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; treeSha: string } {
    const blobOid = this.putObject(repo, 'blob', content);
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName);
    const baseTree = parent ? parseCommit(repo.objects.get(parent)!.data).tree : null;
    const files = new Map<string, string>();
    files.set(path, blobOid);
    const treeOid = buildTreeForFiles(
      baseTree,
      files,
      (oid) => repo.objects.get(oid),
      (type, data) => this.putObject(repo, type, data),
    );
    const { sec } = this.timestamp();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      timestamp: sec,
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha, contentSha: blobOid, treeSha: treeOid };
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const branchRef = `refs/heads/${ref}`;
    if (repo.refs.has(branchRef)) return repo.refs.get(branchRef)!;
    if (isOid(ref) && repo.objects.has(ref) && repo.objects.get(ref)!.type === 'commit') return ref;
    return null;
  }

  /** Commits reachable from `tip`, newest first (BFS by generation, parents after children). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }
}

/** Opaque Relay-style global id: base64url of "Type:opaque". */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
