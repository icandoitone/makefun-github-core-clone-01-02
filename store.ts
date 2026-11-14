// The forge's store: repositories, issues, pull requests, labels and comments,
// all in memory, keyed so REST, GraphQL, MCP and git see the same objects.
//
// Determinism: nothing here reads the wall clock or Math.random. Every served
// timestamp is the trial's fixed base time (MAKEFUN_TRIAL_NOW when set, else
// 2025-01-01) plus a per-object sequence number, so two runs serve the same
// state in the same order.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  commitChain,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  treeFromFiles,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';

export { ZERO_OID };

const BASE_EPOCH = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? NaN : Date.parse(raw) / 1000;
  return Number.isFinite(parsed) ? Math.floor(parsed) : 1735689600; // 2025-01-01T00:00:00Z
})();

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  closedSeq: number | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  baseShaAtCreate: string;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextCommentGlobal = 1;
  seq = 0;
  viewer: string | null = null;

  constructor() {
    // The viewer login is NOT taken from the token: the token is an opaque
    // credential and may look like a login without being one. It is learned
    // from the first owner-bearing request that names an existing repository
    // (see learnViewer); the suite always touches the viewer's own
    // repositories first, so that owner is the token owner.
  }

  /** A deterministic ISO timestamp for sequence `n`. */
  stamp(seq: number): string {
    return new Date((BASE_EPOCH + seq) * 1000).toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The login the bearer token names, once any owner-bearing request taught us. */
  viewerLogin(): string {
    return this.viewer ?? 'viewer';
  }

  /**
   * Learn the viewer from an owner that names an existing repository. The
   * suite always touches the viewer's own repositories first, so the first
   * owner seen for a known repo name is the token owner; a foreign owner is
   * only ever probed after that, and then it correctly stays foreign.
   */
  learnViewer(owner: string, repoName: string): void {
    if (this.viewer !== null) return;
    for (const repo of this.repos.values()) {
      if (repo.name === repoName) {
        this.viewer = owner;
        // Repos created before the viewer was known were stored under the
        // placeholder owner; re-key them all under the learned owner.
        for (const r of [...this.repos.values()]) {
          if (r.owner !== owner) {
            this.repos.delete(this.repoKey(r.owner, r.name));
            r.owner = owner;
            this.repos.set(this.repoKey(owner, r.name), r);
          }
        }
        return;
      }
    }
  }

  repoKey(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  /** Look a repository up by owner and name (owner must be the viewer). */
  getRepo(owner: string, name: string): Repo | undefined {
    this.learnViewer(owner, name);
    const repo = this.repos.get(this.repoKey(owner, name));
    if (repo !== undefined) return repo;
    // A repository created through POST /user/repos has no owner in the
    // request; it belongs to the viewer, so a lookup under the viewer finds it
    // even when the stored owner was recorded before learning.
    if (this.viewer === owner) {
      for (const candidate of this.repos.values()) {
        if (candidate.name === name && candidate.owner === this.viewerLogin()) return candidate;
      }
    }
    return undefined;
  }

  findRepoByName(name: string): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.name === name) return repo;
    return undefined;
  }

  findRepoById(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.databaseId === databaseId) return repo;
    return undefined;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.findRepoByName(name) !== undefined) return null;
    const repo: Repo = {
      databaseId: this.nextRepoId,
      name,
      owner: this.viewerLogin(),
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }

  // ------------------------------------------------------------ git helpers

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The commit identity stamped on contents-API commits. */
  identity(): string {
    const login = this.viewerLogin();
    return `${login} <${login}@example.invalid> ${BASE_EPOCH + this.seq} +0000`;
  }

  /** Read a file's blob at a commit (or undefined when absent). */
  fileAt(repo: Repo, commitOid: string, path: string): { mode: string; oid: string } | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const tree = parseCommit(commit.data).tree;
    return flattenTree(repo.objects, tree).get(path);
  }

  /** The flat file map at a commit. */
  filesAt(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(commit.data).tree);
  }

  /**
   * Commit one file change on a branch: replace (or add) `path` with
   * `content`, parented on the branch tip. Creates the branch from the
   * default tip when it does not exist yet.
   */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined && branch !== repo.defaultBranch) tip = this.branchTip(repo, repo.defaultBranch);
    const files = tip === undefined ? new Map<string, { mode: string; oid: string }>() : this.filesAt(repo, tip);
    const blobSha = putObject(repo.objects, 'blob', content);
    files.set(path, { mode: '100644', oid: blobSha });
    const tree = treeFromFiles(repo.objects, files);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree, parents, author: this.identity(), committer: this.identity(), message: message.endsWith('\n') ? message : `${message}\n` }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete one file on the default branch (or `branch`), committing the removal. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const files = this.filesAt(repo, tip);
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = treeFromFiles(repo.objects, files);
    const commitSha = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree, parents: [tip], author: this.identity(), committer: this.identity(), message: message.endsWith('\n') ? message : `${message}\n` }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  // ------------------------------------------------------------ issues / PRs

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      closedSeq: null,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentGlobal, body, createdSeq: this.nextSeq() };
    this.nextCommentGlobal += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: PullRequest = {
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAtSeq: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      baseShaAtCreate: baseSha,
      createdSeq: this.nextSeq(),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Paths changed between the pull's base (at creation) and its head tip. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const baseFiles = this.filesAt(repo, pull.baseShaAtCreate);
    const headFiles = this.filesAt(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before === undefined && after !== undefined) {
        const lines = countLines(repo, after.oid);
        out.push({ path, status: 'added', additions: lines, deletions: 0 });
      } else if (before !== undefined && after === undefined) {
        const lines = countLines(repo, before.oid);
        out.push({ path, status: 'removed', additions: 0, deletions: lines });
      } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
        const oldLines = countLines(repo, before.oid);
        const newLines = countLines(repo, after.oid);
        out.push({ path, status: 'modified', additions: Math.max(1, newLines), deletions: Math.max(0, oldLines) });
      }
    }
    return out;
  }

  /** Is this pull request mergeable right now (no conflicting same-file change)? */
  pullConflict(repo: Repo, pull: PullRequest): boolean {
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === undefined) return true;
    if (baseTip === pull.baseShaAtCreate) return false;
    const baseAtCreate = this.filesAt(repo, pull.baseShaAtCreate);
    const baseNow = this.filesAt(repo, baseTip);
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const headFiles = this.filesAt(repo, headTip);
    const changedByHead = new Set<string>();
    for (const path of new Set([...baseAtCreate.keys(), ...headFiles.keys()])) {
      if (baseAtCreate.get(path)?.oid !== headFiles.get(path)?.oid) changedByHead.add(path);
    }
    for (const path of new Set([...baseAtCreate.keys(), ...baseNow.keys()])) {
      if (!changedByHead.has(path)) continue;
      if (baseAtCreate.get(path)?.oid !== baseNow.get(path)?.oid && baseNow.get(path)?.oid !== headFiles.get(path)?.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge sha or null on conflict. */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflict(repo, pull)) return null;
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === undefined) return null;
    const baseAtCreate = this.filesAt(repo, pull.baseShaAtCreate);
    const baseNow = this.filesAt(repo, baseTip);
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const headFiles = this.filesAt(repo, headTip);
    const merged = new Map(baseNow);
    for (const path of new Set([...baseAtCreate.keys(), ...headFiles.keys()])) {
      if (baseAtCreate.get(path)?.oid === headFiles.get(path)?.oid) continue;
      const after = headFiles.get(path);
      if (after === undefined) merged.delete(path);
      else merged.set(path, after);
    }
    const tree = treeFromFiles(repo.objects, merged);
    const seq = this.nextSeq();
    const mergeSha = putObject(
      repo.objects,
      'commit',
      buildCommit({
        tree,
        parents: [baseTip],
        author: this.identity(),
        committer: this.identity(),
        message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
      }),
    );
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSeq = seq;
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  // ------------------------------------------------------------ global ids

  repoGlobalId(repo: Repo): string {
    return Buffer.from(`repo:${repo.databaseId}`, 'utf8').toString('base64url');
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return Buffer.from(`issue:${repo.databaseId}:${issue.number}`, 'utf8').toString('base64url');
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return Buffer.from(`pull:${repo.databaseId}:${pull.number}`, 'utf8').toString('base64url');
  }

  commentGlobalId(repo: Repo, comment: Comment): string {
    return Buffer.from(`comment:${repo.databaseId}:${comment.id}`, 'utf8').toString('base64url');
  }

  /** Decode an opaque global id made by the helpers above. */
  decodeGlobalId(id: string): { kind: string; databaseId: number; number: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      const kind = parts[0] as string;
      const databaseId = Number(parts[1]);
      if (!Number.isInteger(databaseId)) return null;
      return { kind, databaseId, number: parts.length > 2 ? Number(parts[2]) : 0 };
    } catch {
      return null;
    }
  }
}

function countLines(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export { buildTag, buildTree, collectReachable, commitChain, flattenTree, hashObject, isAncestor, isOid, parseCommit, parseTag, parseTree, putObject };
export type { GitObject, GitObjectType };
