// MCP (Model Context Protocol) over Streamable HTTP, revision 2026-07-28.
//
// server/discover answers the modern handshake; initialize +
// notifications/initialized answer the legacy one. tools/list is a fixed,
// byte-stable list; tools/call dispatches onto the same store REST uses.

import type { Store } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
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
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
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
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
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
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
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
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : '';
  let repo = typeof args['repo'] === 'string' ? (args['repo'] as string) : '';
  const fullName = typeof args['full_name'] === 'string' ? (args['full_name'] as string) : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [left, right] = fullName.split('/', 2);
    if (owner === '') owner = left ?? '';
    if (repo === '') repo = right ?? '';
  }
  return { owner, repo };
}

function repoJson(store: Store, repo: { databaseId: number; name: string; owner: string; description: string; isPrivate: boolean; defaultBranch: string }): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: store.repoGlobalId(repo as never),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
  };
}

/** Run one tool; returns {result} or {error} (a tool-level error, isError). */
export function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: string } {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = (canonical: string): boolean => normalized === canonical || normalized.endsWith(canonical);
  if (suffix('createrepo') || suffix('createrepository')) {
    const repoName = typeof args['name'] === 'string' ? (args['name'] as string) : '';
    if (repoName === '') return { error: 'create_repo requires a name' };
    const existing = store.findRepoByName(repoName);
    const repo =
      existing ??
      store.createRepo(repoName, args['private'] === true, typeof args['description'] === 'string' ? (args['description'] as string) : '');
    if (repo === null) return { error: `repository ${repoName} could not be created` };
    return { result: toolResult(repoJson(store, repo)) };
  }
  if (suffix('getrepo') || suffix('getrepository')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    return { result: toolResult(repoJson(store, repo)) };
  }
  if (suffix('listrepos')) {
    return { result: toolResult({ repositories: store.listRepos().map((repo) => repoJson(store, repo)) }) };
  }
  if (suffix('createissue')) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args['title'] === 'string' ? (args['title'] as string) : '';
    if (owner === '' || repoName === '' || title === '') return { error: 'create_issue requires owner, repo and title' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const issue = store.createIssue(repo, title, typeof args['body'] === 'string' ? (args['body'] as string) : '', []);
    return {
      result: toolResult({
        id: store.issueGlobalId(repo, issue),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
      }),
    };
  }
  if (suffix('listissues')) {
    const { owner, repo: repoName } = splitFullName(args);
    if (owner === '' || repoName === '') return { error: 'list_issues requires owner and repo' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const state = typeof args['state'] === 'string' ? (args['state'] as string).toLowerCase() : 'open';
    const issues = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({ id: store.issueGlobalId(repo, issue), number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
    return { result: toolResult({ issues }) };
  }
  if (suffix('getissue')) {
    const { owner, repo: repoName } = splitFullName(args);
    const number = Number(args['issue_number'] ?? args['number']);
    const repo = store.getRepo(owner, repoName);
    const issue = repo === undefined ? undefined : store.findIssue(repo, number);
    if (repo === undefined || issue === undefined) return { error: `issue #${number} not found` };
    return { result: toolResult({ id: store.issueGlobalId(repo, issue), number: issue.number, title: issue.title, body: issue.body, state: issue.state }) };
  }
  if (suffix('createpullrequest') || suffix('createpr')) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args['title'] === 'string' ? (args['title'] as string) : '';
    const head = typeof args['head'] === 'string' ? (args['head'] as string) : '';
    const base = typeof args['base'] === 'string' ? (args['base'] as string) : '';
    if (owner === '' || repoName === '' || title === '' || head === '' || base === '') return { error: 'create_pull_request requires owner, repo, title, head and base' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const pull = store.createPull(repo, title, typeof args['body'] === 'string' ? (args['body'] as string) : '', head, base);
    if (pull === null) return { error: `head branch ${head} or base branch ${base} does not exist` };
    return {
      result: toolResult({
        id: store.pullGlobalId(repo, pull),
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: pull.head,
        base: pull.base,
      }),
    };
  }
  if (suffix('mergepullrequest') || suffix('mergepr')) {
    const { owner, repo: repoName } = splitFullName(args);
    const number = Number(args['pull_number'] ?? args['number']);
    if (owner === '' || repoName === '' || !Number.isInteger(number)) return { error: 'merge_pull_request requires owner, repo and pull_number' };
    const repo = store.getRepo(owner, repoName);
    const pull = repo === undefined ? undefined : store.findPull(repo, number);
    if (repo === undefined || pull === undefined) return { error: `pull request #${number} not found` };
    const sha = store.mergePull(repo, pull);
    if (sha === null) return { error: `pull request #${number} cannot be merged (conflicted or already closed)` };
    return { result: toolResult({ number: pull.number, merged: true, state: pull.state, sha, message: `Pull request #${number} merged.` }) };
  }
  return { error: `unknown tool ${name}` };
}

export interface McpOutcome {
  status: number;
  body: string | null; // null: no body (notification / 202)
  contentType: string;
}

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }), contentType: 'application/json' };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), contentType: 'application/json' };
}

/** Handle one POST /mcp body (already read as text). */
export function handleMcp(store: Store, rawBody: string, authorized: boolean): McpOutcome {
  if (!authorized) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }), contentType: 'application/json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), contentType: 'application/json' };
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const id = record['id'] ?? null;
  const method = typeof record['method'] === 'string' ? (record['method'] as string) : '';
  const params = (typeof record['params'] === 'object' && record['params'] !== null ? record['params'] : {}) as Record<string, unknown>;
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null, contentType: 'application/json' };
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, { protocolVersion: negotiated, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // A fixed list, serialized the same way every time (byte-identical).
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => {
      const normalized = tool.name.replace(/[^a-z0-9]/g, '');
      const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return wanted === normalized || wanted.endsWith(normalized);
    });
    if (!known) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const outcome = callTool(store, name, args);
    if (outcome.error !== undefined) {
      // Missing required arguments surface as a tool error (isError), which
      // the suite accepts; a genuinely unknown tool is answered above.
      return rpcResult(id, toolError(outcome.error));
    }
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
