// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0).
//
// The wire shapes follow what the suite's client parses: v2 capability
// advertisement, ls-refs and fetch sections; v0 service preambles, ref lists
// with capabilities on the first line, side-band-64k pack framing, and a
// report-status reply inside side-band band 1.

import {
  collectReachable,
  commitChain,
  decodePktLines,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  PKT_FLUSH,
  pktLine,
  pktLines,
  readPack,
  sidebandPackets,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitRequest {
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message })) };
}

/** All refs of a repo, sorted, HEAD first when present. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : 1));
  return refs;
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The peeled commit of a tag object (or the oid itself when it is not a tag). */
function peelToCommit(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj !== undefined && obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    return peelToCommit(repo, target);
  }
  return oid;
}

/** HEAD's oid: the default branch tip, or the zero id when unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(defaultBranchRef(repo)) ?? ZERO_OID;
}

// ---------------------------------------------------------------- v0 advertisement

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack thin-pack side-band side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1 shallow'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        lines.push(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------- v2 advertisement

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The v2 capability advertisement never changes; build it once. */
const V2_ADVERTISEMENT: Buffer = pktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'server-option\n',
  'flush',
]);

/** GET /info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, protocolVersion: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (protocolVersion === 'version=2') return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  return notFound();
}

// ---------------------------------------------------------------- v2 ls-refs / fetch

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    const head = headOid(repo);
    if (head === ZERO_OID) {
      if (args.unborn) lines.push(`unborn HEAD symref-target:${defaultBranchRef(repo)}\n`);
    } else if (args.symrefs) {
      lines.push(`${head} HEAD symref-target:${defaultBranchRef(repo)}\n`);
    } else {
      lines.push(`${head} HEAD\n`);
    }
  }
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, ref.oid)}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines as Array<string | 'flush'>);
}

/** Commits within `depth` generations of `tips` (depth 1 = the tips only). */
function depthLimitedCommits(repo: Repo, tips: readonly string[], depth: number): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  let frontier = [...tips];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      commits.add(oid);
      if (level === depth - 1) boundary.add(oid);
      for (const parent of parseCommit(obj.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return { commits, boundary };
}

/** Objects under a set of commits without descending into their parents. */
function collectWithoutParents(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return seen;
}

/** Objects the client already holds: everything reachable from its haves,
 * except the ancestors of its shallow boundaries (a shallow clone holds the
 * boundary commit and its tree, but not the boundary's parents). */
function heldObjects(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const boundary = new Set(shallowBoundaries);
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      stack.push(parseCommit(obj.data).tree);
      if (!boundary.has(oid)) {
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return seen;
}

function handleFetchV2(repo: Repo, args: { wants: string[]; haves: string[]; depth: number | null; shallow: string[] }): Buffer {
  const parts: Buffer[] = [];
  const haveSet = new Set(args.haves);
  // Objects the client already holds (see heldObjects: shallow boundaries
  // stop the walk, since their parents are not held).
  const haveObjects = heldObjects(repo, args.haves, args.shallow);
  // Wanted commits and the objects under them.
  let wantedCommits: Set<string>;
  let shallowBoundary = new Set<string>();
  if (args.depth !== null) {
    const limited = depthLimitedCommits(repo, args.wants, args.depth);
    wantedCommits = limited.commits;
    shallowBoundary = limited.boundary;
  } else {
    wantedCommits = new Set<string>();
    for (const want of args.wants) {
      for (const oid of commitChain(repo.objects, want)) wantedCommits.add(oid);
    }
    // Tags wanted directly: include the tag object itself.
    for (const want of args.wants) {
      const obj = repo.objects.get(want);
      if (obj !== undefined && obj.type === 'tag') wantedCommits.add(want);
    }
  }
  const wantedObjects =
    args.depth !== null ? collectWithoutParents(repo, wantedCommits) : collectReachable(repo.objects, wantedCommits);
  for (const oid of haveObjects) wantedObjects.delete(oid);
  const nothingNew = args.wants.every((want) => haveSet.has(want) || wantedObjects.size === 0) && wantedObjects.size === 0;
  if (args.haves.length > 0) {
    const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (nothingNew) {
      for (const have of args.haves) if (repo.objects.has(have)) ackLines.push(`ACK ${have}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    ackLines.push('delim');
    parts.push(pktLines(ackLines));
  }
  if (args.depth !== null && shallowBoundary.size > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of [...shallowBoundary].sort()) shallowLines.push(`shallow ${oid}\n`);
    for (const boundary of args.shallow) shallowLines.push(`unshallow ${boundary}\n`);
    shallowLines.push('delim');
    parts.push(pktLines(shallowLines));
  }
  if (!nothingNew) {
    // Keep each object's oid alongside it: re-deriving it with hashObject
    // inside the comparator costs O(n log n) SHA-1s, and the commit order
    // used to re-walk the whole history on every fetch.
    const packEntries: Array<{ oid: string; obj: GitObject }> = [];
    for (const oid of wantedObjects) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) packEntries.push({ oid, obj });
    }
    // Deterministic pack order: commits first (newest chain order), then the rest by oid.
    // wantedCommits is already computed above in chain order (newest first),
    // so no extra history walk is needed here.
    const order = new Map<string, number>();
    let index = 0;
    for (const oid of wantedCommits) order.set(oid, index++);
    packEntries.sort((a, b) => {
      const ao = order.get(a.oid) ?? 100000;
      const bo = order.get(b.oid) ?? 100000;
      if (ao !== bo) return ao - bo;
      return a.oid < b.oid ? -1 : 1;
    });
    const pack = writePack(packEntries.map((entry) => entry.obj));
    parts.push(pktLines(['packfile\n']));
    parts.push(sidebandPackets(1, pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

/** POST /{o}/{r}.git/git-upload-pack (v2 when Git-Protocol: version=2). */
export function handleUploadPack(store: Store, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePktLines(req.body);
  const textLines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') textLines.push(packet.payload.toString('utf8'));
  }
  if (!isV2) return handleUploadPackV0(repo, textLines);
  const command = textLines.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';
  // One pass over the request lines: ls-refs flags and fetch arguments.
  const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of textLines) {
    const clean = line.trim();
    if (clean === 'peel') args.peel = true;
    else if (clean === 'symrefs') args.symrefs = true;
    else if (clean === 'unborn') args.unborn = true;
    else if (clean.startsWith('ref-prefix ')) args.prefixes.push(clean.slice('ref-prefix '.length));
    else if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0] as string);
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7).trim());
  }
  if (command === 'ls-refs') {
    return ok('application/x-git-upload-pack-result', handleLsRefs(repo, args));
  }
  if (command === 'fetch') {
    return ok('application/x-git-upload-pack-result', handleFetchV2(repo, { wants, haves, depth, shallow }));
  }
  return badRequest(`unknown upload-pack command ${command}`);
}

// ---------------------------------------------------------------- v0 upload-pack

function handleUploadPackV0(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const clean = line.trim();
    if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0] as string);
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7).trim());
  }
  const haveObjects = heldObjects(repo, haves, shallow);
  let wantedCommits = new Set<string>();
  let shallowBoundary = new Set<string>();
  if (depth !== null) {
    const limited = depthLimitedCommits(repo, wants, depth);
    wantedCommits = limited.commits;
    shallowBoundary = limited.boundary;
  } else {
    for (const want of wants) for (const oid of commitChain(repo.objects, want)) wantedCommits.add(oid);
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (obj !== undefined && obj.type === 'tag') wantedCommits.add(want);
    }
  }
  const wantedObjects = depth !== null ? collectWithoutParents(repo, wantedCommits) : collectReachable(repo.objects, wantedCommits);
  for (const oid of haveObjects) wantedObjects.delete(oid);
  const parts: Buffer[] = [];
  const nothingNew = wantedObjects.size === 0;
  if (haves.length > 0) {
    if (nothingNew) {
      for (const have of haves) if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  }
  if (depth !== null) {
    for (const oid of [...shallowBoundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const boundary of shallow) parts.push(pktLine(`unshallow ${boundary}\n`));
  }
  if (!nothingNew) {
    const packObjects: GitObject[] = [];
    for (const oid of wantedObjects) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) packObjects.push(obj);
    }
    parts.push(sidebandPackets(1, writePack(packObjects)));
  }
  parts.push(PKT_FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{o}/{r}.git/git-receive-pack (v0). */
export function handleReceivePack(store: Store, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  // Parse command pkt-lines up to the first flush; everything after it is
  // the raw packfile (its bytes must never be re-read as pkt-lines).
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = req.body.length;
  while (offset + 4 <= req.body.length) {
    const length = parseInt(req.body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > req.body.length) break;
    const text = req.body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    offset += length;
  }
  const rest = req.body.subarray(packStart);
  if (commands.length === 0) return badRequest('no push commands');
  // Store the pack's objects first (all of them, even for refused refs).
  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const checksum = verifyPackChecksum(rest);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      const read = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push('unpack index-pack failed\n');
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reportLines.push(`ng ${command.ref} remote ref does not match\n`);
      else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const newObj = repo.objects.get(command.newOid);
    if (newObj === undefined) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not match\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (newObj.type === 'commit' && !isAncestor(repo.objects, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const inner = pktLines([...reportLines, 'flush']);
  const body = Buffer.concat([sidebandPackets(1, inner), PKT_FLUSH]);
  return ok('application/x-git-receive-pack-result', body);
}
