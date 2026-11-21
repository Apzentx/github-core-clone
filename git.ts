// git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 receive-pack (push).
// Packs are written without deltas; incoming packs may carry deltas (resolved on read).

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export const GIT_AGENT = 'github-core-clone/1.0';

const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${GIT_AGENT}`];
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${GIT_AGENT}`];

/** All refs of a repo, sorted by name. */
export function listRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Peel an annotated tag (following tag chains) to its commit oid. */
function peel(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return object.type === 'commit' ? current : null;
  }
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// info/refs advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = ['version 2\n', ...UPLOAD_V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
  return encodePktLines(lines);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:${defaultBranchRef(repo)} object-format=sha1 agent=${GIT_AGENT}`
    : RECEIVE_CAPS.join(' ');
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = listRefs(repo);
  const headTip = repo.refs.get(defaultBranchRef(repo));
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first, carrying the capabilities.
    parts.push(encodePktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peel(repo, ref.oid);
        if (peeled) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function infoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

export function lsRefs(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const lines = decodePktLines(body);
  let peelRequested = false;
  let symrefsRequested = false;
  let unbornRequested = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  let firstLine = true;
  for (const packet of lines) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      // The command line is first; agent=/object-format= lines may follow it.
      if (firstLine && !text.startsWith('command=ls-refs')) throw new Error('expected command=ls-refs');
      firstLine = false;
      continue;
    }
    if (text === 'peel') peelRequested = true;
    else if (text === 'symrefs') symrefsRequested = true;
    else if (text === 'unborn') unbornRequested = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    // agent= / object-format= ignored
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const headRef = defaultBranchRef(repo);
  const headTip = repo.refs.get(headRef);
  if (symrefsRequested && keep('HEAD')) {
    if (headTip) out.push(encodePktLine(`${headTip} HEAD symref-target:${headRef}\n`));
    else if (unbornRequested) out.push(encodePktLine(`unborn HEAD symref-target:${headRef}\n`));
  }
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = repo.objects.get(ref.oid);
    if (peelRequested && object && object.type === 'tag') {
      const peeled = peel(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(encodePktLine(`${line}\n`));
  }
  out.push(Buffer.from('0000', 'ascii'));
  return { status: 200, body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------------------------
// v2 fetch (upload-pack)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchRequest(body: Buffer): FetchRequest {
  const lines = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  let seenDelim = false;
  let firstLine = true;
  for (const packet of lines) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      // The command line is first; agent=/object-format= lines may follow it.
      if (firstLine && !text.startsWith('command=fetch')) throw new Error('expected command=fetch');
      firstLine = false;
      continue;
    }
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) request.depth = parseInt(text.slice(7), 10);
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no behaviour change.
  }
  return request;
}

/**
 * Compute the objects to send for a fetch.
 * Without depth: reachable(wants) minus reachable(haves).
 * With depth N: commits within N generations of the wants (the Nth generation is the
 * shallow boundary), plus their trees and blobs, minus what the client already has.
 */
function computeFetch(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already has: the closure of its haves, but never the ancestors of a
  // shallow boundary — a shallow clone holds the boundary commit itself, not its parents.
  const haveSet = collectReachable(request.haves, lookup);
  if (request.shallowBoundaries.length) {
    const beyond = new Set<string>();
    for (const boundary of request.shallowBoundaries) {
      const object = lookup(boundary);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        for (const oid of collectReachable([parent], lookup)) beyond.add(oid);
      }
    }
    for (const oid of beyond) haveSet.delete(oid);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let sendSet: Set<string>;
  if (request.depth === null) {
    sendSet = collectReachable(request.wants, lookup);
  } else {
    const depth = Math.max(1, request.depth);
    // BFS over commits from the wants, tracking the shortest generation distance.
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const want of request.wants) {
      if (!dist.has(want)) {
        dist.set(want, 0);
        queue.push(want);
      }
    }
    const included = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      const d = dist.get(oid)!;
      if (d >= depth) continue;
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        included.add(oid);
        if (d === depth - 1) shallow.push(oid);
        for (const parent of parseCommit(object.data).parents) {
          if (!dist.has(parent)) {
            dist.set(parent, d + 1);
            queue.push(parent);
          }
        }
      } else {
        included.add(oid);
      }
    }
    // Include trees/blobs of the included commits.
    const roots: string[] = [];
    for (const oid of included) {
      const object = lookup(oid);
      if (object && object.type === 'commit') roots.push(parseCommit(object.data).tree);
      else if (object) roots.push(oid);
    }
    sendSet = collectReachable(roots, lookup);
    for (const oid of included) sendSet.add(oid);
    // Previous shallow boundaries that are now fully present become unshallow.
    for (const old of request.shallowBoundaries) {
      if (!included.has(old)) continue;
      if (shallow.includes(old)) continue;
      const object = lookup(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((p) => included.has(p))) unshallow.push(old);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of sendSet) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

export function uploadPack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const request = parseFetchRequest(body);
  const { objects, shallow, unshallow } = computeFetch(repo, request);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  const knownHaves = request.haves.filter((oid) => repo.objects.has(oid));
  if (knownHaves.length) {
    for (const oid of knownHaves) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii')); // delim
  // shallow-info
  if (shallow.length || unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // packfile
  if (objects.length) {
    const pack = writePack(objects);
    parts.push(encodePktLine('packfile\n'));
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      const banded = Buffer.concat([Buffer.from([1]), slice]);
      parts.push(encodePktLine(banded));
    }
  }
  parts.push(Buffer.from('0000', 'ascii')); // flush
  return { status: 200, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push, v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(
  repo: Repo,
  body: Buffer,
): { status: number; body: Buffer } {
  // The command list is pkt-lines until the first flush; everything after is the raw pack.
  // (Do NOT decodePktLines the whole body: the pack is not pkt-framed.)
  const commands: PushCommand[] = [];
  let packStart = body.length;
  {
    let cursor = 0;
    let first = true;
    while (cursor < body.length) {
      if (cursor + 4 > body.length) throw new Error('truncated pkt-line');
      const len = parseInt(body.subarray(cursor, cursor + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line length');
      if (len === 0) {
        packStart = cursor + 4;
        break;
      }
      if (len < 4 || cursor + len > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(cursor + 4, cursor + len).toString('utf8');
      const text = first ? payload.split('\0')[0]! : payload;
      first = false;
      const line = text.replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
      if (!match) throw new Error(`bad push command line: ${JSON.stringify(line.slice(0, 80))}`);
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
      cursor += len;
    }
  }
  if (commands.length === 0) throw new Error('push with no commands');
  // Unpack the pack (if any).
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const incoming = new Map<string, GitObject>();
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const parsed = readPack(packBytes);
        for (const [oid, object] of parsed) incoming.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }
  // Validate incoming objects' hashes (readPack already keyed them by recomputed hash).
  // Store them.
  if (unpackOk) {
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  // Apply commands, per ref.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (command.oldOid === ZERO_OID && !current) {
        results.push({ ref: command.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Create or update: the new object must exist.
    const target = lookup(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: must be a fast-forward (new is a descendant of old), or old == new.
    if (command.newOid === command.oldOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!isOid(command.newOid) || target.type !== 'commit') {
      // Non-commit updates (e.g. tag ref pointing at a tag object) are allowed when the
      // old value matches; fast-forward does not apply to tags.
      if (command.ref.startsWith('refs/tags/')) {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (isAncestor(command.oldOid, command.newOid, lookup)) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  // Report-status (v2 preferred by the client when advertised): pkt-lines inside sideband band 1.
  const reportLines: Array<string | 'flush'> = [
    `unpack ${unpackOk ? 'ok' : unpackDetail}\n`,
    ...results.flatMap((r) => (r.ok ? [`ok ${r.ref}\n`] : [`ng ${r.ref} ${r.reason}\n`])),
    'flush',
  ];
  const inner = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < inner.length; off += CHUNK) {
    const slice = inner.subarray(off, Math.min(inner.length, off + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return { status: 200, body: Buffer.concat(parts) };
}
