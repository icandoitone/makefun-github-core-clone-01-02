// The forge's HTTP server: REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, git smart HTTP at /{owner}/{repo}.git, and /healthz.
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.
// A missing bearer token is 401; a repository under another owner is 404,
// never 403. Malformed JSON bodies are 400; unknown routes are 404 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { commitChain, parseCommit } from './gitobj.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store, type Issue, type PullRequest, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO = '0'.repeat(40);

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...extraHeaders };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers['authorization'];
  return typeof header === 'string' && header === `Bearer ${TOKEN}`;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
}

/** Parse a JSON body; returns null when the body is empty, throws on malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  return JSON.parse(raw.toString('utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- JSON shapes

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const stamp = store.stamp(repo.createdSeq);
  return {
    id: repo.databaseId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.example/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.example:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000000 + issue.number,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    created_at: store.stamp(issue.createdSeq),
    updated_at: store.stamp(issue.closedSeq ?? issue.createdSeq),
    closed_at: issue.closedSeq === null ? null : store.stamp(issue.closedSeq),
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    comments: issue.comments.length,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.head) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.base) ?? pull.baseSha;
  return {
    id: repo.databaseId * 1000000 + pull.number,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    merged: pull.merged,
    merged_at: pull.mergedAtSeq === null ? null : store.stamp(pull.mergedAtSeq),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: store.stamp(pull.createdSeq),
    updated_at: store.stamp(pull.createdSeq),
    closed_at: pull.state === 'closed' ? store.stamp(pull.mergedAtSeq ?? pull.createdSeq) : null,
    draft: false,
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
  };
}

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
  } catch {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rawPath = url.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const query = url.searchParams;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1] as string);
    const repoName = decodeSegment(gitMatch[2] as string);
    const service = gitMatch[3] as string;
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    // The git handlers only ever read the git-protocol header (Node already
    // lowercases header names); copying the whole header table per request
    // is pure overhead.
    const headers: Record<string, string> = { 'git-protocol': req.headers['git-protocol'] ?? '' };
    if (service === 'info/refs') {
      const outcome = handleInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', headers['git-protocol']);
      sendRaw(res, outcome.status, outcome.contentType, outcome.body);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      const outcome = handleUploadPack(store, owner, repoName, { method, headers, body });
      sendRaw(res, outcome.status, outcome.contentType, outcome.body);
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      const outcome = handleReceivePack(store, owner, repoName, { method, headers, body });
      sendRaw(res, outcome.status, outcome.contentType, outcome.body);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = parseJsonBody(raw);
    } catch {
      sendError(res, 400, 'Malformed JSON body');
      return;
    }
    const result = executeGraphQL(store, body);
    sendJson(res, 200, result);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const raw = await readBody(req);
    const outcome = handleMcp(store, raw.toString('utf8'), isAuthorized(req));
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'content-type': outcome.contentType });
      res.end();
      return;
    }
    res.writeHead(outcome.status, { 'content-type': outcome.contentType, 'content-length': String(Buffer.byteLength(outcome.body)) });
    res.end(outcome.body);
    return;
  }

  // Everything else is REST v3 (or a 404).
  if (!path.startsWith('/api/v3')) {
    sendError(res, 404, 'Not Found');
    return;
  }
  await handleRest(store, req, res, method, path, query);
}

async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams): Promise<void> {
  const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
  const segments = restPath.split('/').filter((part) => part !== '').map(decodeSegment);

  // The API root needs no token (the starter answered it the same way).
  if (method === 'GET' && segments.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  let body: unknown = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    try {
      body = parseJsonBody(raw);
    } catch {
      sendError(res, 400, 'Malformed JSON body');
      return;
    }
  }
  const input = asRecord(body);

  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);

  function paginate<T>(items: T[], total: number): { page: T[]; link: string | undefined } {
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    let link: string | undefined;
    if (start + perPage < total) {
      const host = req.headers.host ?? 'entry';
      const base = `http://${host}/api/v3${restPath}`;
      const next = `${base}?per_page=${perPage}&page=${page + 1}`;
      const last = `${base}?per_page=${perPage}&page=${Math.ceil(total / perPage)}`;
      link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return { page: slice, link };
  }

  function sendPage<T>(items: T[]): void {
    const { page: slice, link } = paginate(items, items.length);
    sendJson(res, 200, slice, link === undefined ? {} : { link });
  }

  // GET /meta
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }

  // GET /user
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    const login = store.viewerLogin();
    sendJson(res, 200, { login, id: 1, node_id: Buffer.from(`user:${login}`, 'utf8').toString('base64url'), type: 'User', site_admin: false });
    return;
  }

  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      sendPage(store.listRepos().map((repo) => repoJson(store, repo)));
      return;
    }
    if (method === 'POST') {
      const name = str(input['name']);
      if (name === '') {
        sendError(res, 422, 'Repository name is required');
        return;
      }
      const repo = store.createRepo(name, bool(input['private']), str(input['description']));
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return;
      }
      sendJson(res, 201, repoJson(store, repo));
      return;
    }
  }

  // /repos/{owner}/{repo}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(store, repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof input['description'] === 'string') repo.description = input['description'] as string;
        if (typeof input['private'] === 'boolean') repo.isPrivate = input['private'] as boolean;
        sendJson(res, 200, repoJson(store, repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        sendJson(res, 204, null);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1] as string;
        const sha = store.branchTip(repo, branch);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const refName = query.get('sha') ?? repo.defaultBranch;
        const tip = store.branchTip(repo, refName) ?? repo.refs.get(refName);
        if (tip === undefined) {
          sendJson(res, 200, []);
          return;
        }
        const chain = commitChain(repo.objects, tip);
        const commits = chain.map((sha) => {
          const obj = repo.objects.get(sha);
          const info = obj === undefined ? null : parseCommit(obj.data);
          return {
            sha,
            commit: {
              message: (info?.message ?? '').replace(/\n+$/, ''),
              author: { name: store.viewerLogin(), email: `${store.viewerLogin()}@example.invalid`, date: store.stamp(repo.createdSeq) },
              committer: { name: store.viewerLogin(), email: `${store.viewerLogin()}@example.invalid`, date: store.stamp(repo.createdSeq) },
            },
            author: { login: store.viewerLogin() },
          };
        });
        sendPage(commits);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = rest[1] as string;
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const info = parseCommit(obj.data);
        sendJson(res, 200, {
          sha,
          commit: {
            message: info.message.replace(/\n+$/, ''),
            author: { name: store.viewerLogin(), email: `${store.viewerLogin()}@example.invalid`, date: store.stamp(repo.createdSeq) },
            committer: { name: store.viewerLogin(), email: `${store.viewerLogin()}@example.invalid`, date: store.stamp(repo.createdSeq) },
          },
        });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = str(input['ref']);
        const sha = str(input['sha']);
        if (!ref.startsWith('refs/') || sha === '') {
          sendError(res, 422, 'Invalid ref');
          return;
        }
        if (repo.objects.get(sha) === undefined) {
          sendError(res, 422, 'Object does not exist');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` });
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: { sha } });
        return;
      }
      if (method === 'DELETE' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        if (!repo.refs.has(ref)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        repo.refs.delete(ref);
        sendJson(res, 204, null);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const refName = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const branch = refName ?? repo.defaultBranch;
        const tip = store.branchTip(repo, branch) ?? repo.refs.get(branch);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const files = store.filesAt(repo, tip);
        if (contentPath === '') {
          const entries = directoryEntries(store, repo, files, '');
          sendJson(res, 200, entries);
          return;
        }
        const exact = files.get(contentPath);
        if (exact !== undefined) {
          const obj = repo.objects.get(exact.oid);
          const data = obj?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            content: data.toString('base64'),
            sha: exact.oid,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
            html_url: `https://github.example/${owner}/${repoName}/blob/${branch}/${contentPath}`,
            download_url: null,
          });
          return;
        }
        const prefix = `${contentPath}/`;
        const hasChildren = [...files.keys()].some((key) => key.startsWith(prefix));
        if (hasChildren) {
          sendJson(res, 200, directoryEntries(store, repo, files, contentPath));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const branch = str(input['branch'], repo.defaultBranch);
        const content = str(input['content']);
        const message = str(input['message'], 'Update file');
        const sha = typeof input['sha'] === 'string' ? (input['sha'] as string) : undefined;
        const tip = store.branchTip(repo, branch);
        const current = tip === undefined ? undefined : store.fileAt(repo, tip, contentPath);
        if (sha !== undefined && current !== undefined && sha !== current.oid) {
          sendError(res, 409, 'sha does not match the current file');
          return;
        }
        if (sha !== undefined && current === undefined) {
          sendError(res, 409, 'sha does not match the current file');
          return;
        }
        let data: Buffer;
        try {
          data = Buffer.from(content, 'base64');
        } catch {
          sendError(res, 422, 'content is not valid base64');
          return;
        }
        const isNew = current === undefined;
        const { commitSha, blobSha } = store.commitFile(repo, branch, contentPath, data, message);
        sendJson(res, isNew ? 201 : 200, {
          content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobSha, size: data.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = str(input['branch'], repo.defaultBranch);
        const sha = typeof input['sha'] === 'string' ? (input['sha'] as string) : undefined;
        const tip = store.branchTip(repo, branch);
        const current = tip === undefined ? undefined : store.fileAt(repo, tip, contentPath);
        if (current === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (sha !== undefined && sha !== current.oid) {
          sendError(res, 409, 'sha does not match the current file');
          return;
        }
        const message = str(input['message'], 'Delete file');
        const deleted = store.deleteFile(repo, branch, contentPath, message);
        if (deleted === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { commit: { sha: deleted.commitSha, message } });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = str(input['name']);
        if (name === '') {
          sendError(res, 422, 'Label name is required');
          return;
        }
        const label = { name, color: str(input['color'], 'ededed'), description: str(input['description']) };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let issues = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          sendPage(issues.map((issue) => issueJson(store, repo, issue)));
          return;
        }
        if (method === 'POST') {
          const title = str(input['title']);
          if (title === '') {
            sendError(res, 422, 'Title is required');
            return;
          }
          const labels = Array.isArray(input['labels']) ? (input['labels'] as unknown[]).map((entry) => (typeof entry === 'string' ? entry : str(asRecord(entry)['name']))) : [];
          const unknown = labels.find((name) => !repo.labels.has(name));
          if (unknown !== undefined) {
            sendError(res, 422, `Label does not exist: ${unknown}`);
            return;
          }
          const issue = store.createIssue(repo, title, str(input['body']), labels);
          sendJson(res, 201, issueJson(store, repo, issue));
          return;
        }
      }
      const number = Number(rest[1]);
      if (rest.length === 2 && Number.isInteger(number)) {
        const issue = store.findIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(store, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof input['title'] === 'string') issue.title = input['title'] as string;
          if (typeof input['body'] === 'string') issue.body = input['body'] as string;
          if (typeof input['state'] === 'string' && (input['state'] === 'open' || input['state'] === 'closed')) {
            issue.state = input['state'] as 'open' | 'closed';
            issue.closedSeq = issue.state === 'closed' ? store.nextSeq() : null;
          }
          sendJson(res, 200, issueJson(store, repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(number)) {
        const issue = store.findIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: store.commentGlobalId(repo, comment),
              body: comment.body,
              user: { login: store.viewerLogin(), id: 1, type: 'User' },
              created_at: store.stamp(comment.createdSeq),
              updated_at: store.stamp(comment.createdSeq),
              html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
              url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}/comments/${comment.id}`,
            })),
          );
          return;
        }
        if (method === 'POST') {
          const commentBody = str(input['body']);
          if (commentBody === '') {
            sendError(res, 422, 'Comment body is required');
            return;
          }
          const comment = store.addComment(repo, issue, commentBody);
          sendJson(res, 201, {
            id: comment.id,
            node_id: store.commentGlobalId(repo, comment),
            body: comment.body,
            user: { login: store.viewerLogin(), id: 1, type: 'User' },
            created_at: store.stamp(comment.createdSeq),
            updated_at: store.stamp(comment.createdSeq),
            html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}/comments/${comment.id}`,
          });
          return;
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let pulls = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          sendPage(pulls.map((pull) => pullJson(store, repo, pull)));
          return;
        }
        if (method === 'POST') {
          const title = str(input['title']);
          const head = str(input['head']);
          const base = str(input['base'], repo.defaultBranch);
          if (title === '' || head === '') {
            sendError(res, 422, 'A pull request needs a title and a head branch');
            return;
          }
          const pull = store.createPull(repo, title, str(input['body']), head, base);
          if (pull === null) {
            sendError(res, 422, 'Head or base branch does not exist');
            return;
          }
          sendJson(res, 201, pullJson(store, repo, pull));
          return;
        }
      }
      const number = Number(rest[1]);
      if (rest.length === 2 && Number.isInteger(number)) {
        const pull = store.findPull(repo, number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(store, repo, pull));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(number) && method === 'GET') {
        const pull = store.findPull(repo, number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const files = store.pullFiles(repo, pull).map((file) => ({
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          sha: store.branchTip(repo, pull.head) ?? pull.headSha,
        }));
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(number) && method === 'PUT') {
        const pull = store.findPull(repo, number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (pull.state !== 'open' || pull.merged) {
          sendError(res, 405, 'Pull request is already closed');
          return;
        }
        const sha = store.mergePull(repo, pull);
        if (sha === null) {
          sendError(res, 405, 'Merge conflict: the pull request cannot be merged');
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged.` });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

function directoryEntries(store: Store, repo: Repo, files: Map<string, { mode: string; oid: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = repo.objects.get(entry.oid);
      seen.set(rest, { type: 'file', oid: entry.oid, size: obj?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // The directory's sha: the tree object id at this level, or the zero id.
        seen.set(name, { type: 'dir', oid: ZERO, size: 0 });
      }
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      size: entry.size,
      name,
      path: prefix + name,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
      html_url: `https://github.example/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${prefix}${name}`,
    }));
}
