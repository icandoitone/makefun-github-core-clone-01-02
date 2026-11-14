// GraphQL v4: a small executor for the documents gh and github-mcp-server
// actually send — no general GraphQL engine, just the queries, mutations and
// introspection probes the suite uses, answered from the same store as REST.

import type { Repo, Store } from './store.ts';

type JsonValue = unknown;

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, JsonValue>;
  children: FieldNode[];
  inlineType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: FieldNode[];
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'];
const PULL_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'headRefOid', 'baseRefOid', 'mergeCommit', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'defaultBranch'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

// ---------------------------------------------------------------- tokenizer / parser

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < query.length && query[j] !== '"') {
        if (query[j] === '\\' && j + 1 < query.length) {
          out += query[j + 1];
          j += 2;
        } else {
          out += query[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch) || ch === '.' ) {
      if (ch === '.' && query.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    let j = i;
    while (j < query.length && /[A-Za-z0-9_-]/.test(query[j] as string)) j += 1;
    tokens.push(query.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;
  variables: Record<string, JsonValue>;

  constructor(query: string, variables: Record<string, JsonValue>) {
    this.tokens = tokenize(query);
    this.variables = variables;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseOperations(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next();
        if (this.peek() === '(') this.skipVariableDefinitions();
        const fields = this.parseSelectionSet();
        operations.push({ kind, name, fields });
      } else if (token === '{') {
        operations.push({ kind: 'query', name: null, fields: this.parseSelectionSet() });
      } else {
        this.pos += 1;
      }
    }
    return operations;
  }

  skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): FieldNode {
    let alias: string | null = null;
    let name: string;
    let inlineType: string | null = null;
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        inlineType = this.next();
      } else {
        // Named fragment spread: skip the name; fragments are not used by the suite.
        this.next();
        return { alias: null, name: '__fragment__', args: {}, children: [], inlineType: null };
      }
      const children = this.parseSelectionSet();
      return { alias: null, name: '__inline__', args: {}, children, inlineType };
    }
    const first = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    } else {
      name = first;
    }
    const args: Record<string, JsonValue> = {};
    if (this.peek() === '(') args['__args__'] = this.parseArguments();
    let children: FieldNode[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias, name, args: (args['__args__'] as Record<string, JsonValue>) ?? {}, children, inlineType };
  }

  parseArguments(): Record<string, JsonValue> {
    this.expect('(');
    const args: Record<string, JsonValue> = {};
    while (this.peek() !== ')' && this.pos < this.tokens.length) {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): JsonValue {
    const token = this.next();
    if (token === '$') {
      const name = this.next();
      return this.variables[name];
    }
    if (token === '{') {
      const obj: Record<string, JsonValue> = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (token === '[') {
      const list: JsonValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const num = Number(token);
    if (token !== '' && !Number.isNaN(num)) return num;
    return token; // enum literal
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function stateOf(state: string): string {
  return state.toUpperCase();
}

function issueNode(store: Store, repo: Repo, issue: { number: number; title: string; body: string; state: string; createdSeq: number; closedSeq: number | null; labels: string[] }, fields: FieldNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = store.issueGlobalId(repo, issue as never);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = stateOf(issue.state);
        break;
      case 'createdAt':
        out[key] = store.stamp(issue.createdSeq);
        break;
      case 'updatedAt':
        out[key] = store.stamp(issue.closedSeq ?? issue.createdSeq);
        break;
      case 'closedAt':
        out[key] = issue.closedSeq === null ? null : store.stamp(issue.closedSeq);
        break;
      case 'url':
        out[key] = `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'author':
        out[key] = field.children.length > 0 ? { login: store.viewerLogin() } : { login: store.viewerLogin() };
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        break;
      case 'comments':
        out[key] = { nodes: [] };
        break;
      default:
        out[key] = null;
    }
  }
  return out;
}

function pullNode(store: Store, repo: Repo, pull: { number: number; title: string; body: string; state: string; merged: boolean; head: string; base: string; headSha: string; baseSha: string; createdSeq: number; mergeCommitSha: string | null }, fields: FieldNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = store.pullGlobalId(repo, pull as never);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = stateOf(pull.state);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'headRefName':
        out[key] = pull.head;
        break;
      case 'baseRefName':
        out[key] = pull.base;
        break;
      case 'headRefOid':
        out[key] = pull.headSha;
        break;
      case 'baseRefOid':
        out[key] = pull.baseSha;
        break;
      case 'mergeable':
        out[key] = store.pullConflict(repo, pull as never) ? 'CONFLICTING' : 'MERGEABLE';
        break;
      case 'mergeCommit':
        out[key] = pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
        break;
      case 'createdAt':
        out[key] = store.stamp(pull.createdSeq);
        break;
      case 'updatedAt':
        out[key] = store.stamp(pull.createdSeq);
        break;
      case 'files': {
        const files = store.pullFiles(repo, pull as never);
        const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 10;
        const page = files.slice(0, first);
        const conn: Record<string, JsonValue> = {};
        for (const child of field.children) {
          const childKey = child.alias ?? child.name;
          if (child.name === 'nodes') {
            conn[childKey] = page.map((file) => pickFields({ path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }, child.children));
          } else if (child.name === 'totalCount') conn[childKey] = files.length;
          else if (child.name === 'pageInfo') conn[childKey] = { hasNextPage: false, endCursor: null };
        }
        if (Object.keys(conn).length === 0) {
          conn['nodes'] = page.map((file) => ({ path: file.path }));
        }
        out[key] = conn;
        break;
      }
      case 'author':
        out[key] = { login: store.viewerLogin() };
        break;
      default:
        out[key] = null;
    }
  }
  return out;
}

function pickFields(source: Record<string, JsonValue>, fields: FieldNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__inline__') {
      Object.assign(out, pickFields(source, field.children));
      continue;
    }
    out[key] = source[field.name] ?? null;
  }
  return out;
}

function paginate<T>(items: T[], first: number | undefined, after: string | undefined): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let start = 0;
  if (after !== undefined && after !== null && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const index = Number(decoded.split(':')[1]);
      if (Number.isInteger(index)) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const limit = first ?? 30;
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  return {
    nodes: page,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: page.length === 0 ? null : Buffer.from(`cursor:${end - 1}`, 'utf8').toString('base64url'),
    },
  };
}

function repoNode(ctx: Ctx, repo: Repo, fields: FieldNode[]): Record<string, JsonValue> {
  const { store } = ctx;
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__inline__') {
      Object.assign(out, repoNode(ctx, repo, field.children));
      continue;
    }
    switch (field.name) {
      case 'id':
        out[key] = store.repoGlobalId(repo);
        break;
      case 'databaseId':
        out[key] = repo.databaseId;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = pickFields({ login: repo.owner }, field.children);
        break;
      case 'defaultBranchRef': {
        const tip = store.branchTip(repo, repo.defaultBranch);
        out[key] = tip === undefined ? null : pickFields({ name: repo.defaultBranch }, field.children.length > 0 ? field.children : [{ alias: null, name: 'name', args: {}, children: [], inlineType: null }]);
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'isPrivate':
        out[key] = repo.isPrivate;
        break;
      case 'defaultBranch':
        out[key] = repo.defaultBranch;
        break;
      case 'createdAt':
        out[key] = store.stamp(repo.createdSeq);
        break;
      case 'updatedAt':
        out[key] = store.stamp(repo.createdSeq);
        break;
      case 'issue': {
        const number = field.args['number'] as number | undefined;
        const issue = number === undefined ? undefined : store.findIssue(repo, number);
        out[key] = issue === undefined ? null : issueNode(store, repo, issue, field.children);
        break;
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = field.args['states'] as string[] | undefined;
        if (states !== undefined) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = field.args['orderBy'] as Record<string, JsonValue> | undefined;
        if (orderBy !== undefined && String(orderBy['field'] ?? '').toUpperCase() === 'CREATED_AT') {
          const direction = String(orderBy['direction'] ?? 'ASC').toUpperCase();
          issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : undefined;
        const after = typeof field.args['after'] === 'string' ? (field.args['after'] as string) : undefined;
        const page = paginate(issues, first, after);
        out[key] = {
          nodes: page.nodes.map((issue) => issueNode(store, repo, issue, field.children.filter((child) => child.name !== 'pageInfo' && child.name !== 'totalCount'))),
          totalCount: issues.length,
          pageInfo: page.pageInfo,
        };
        // pageInfo/totalCount live on the connection, not the nodes: rebuild
        // the connection object honouring the requested sub-fields.
        const conn: Record<string, JsonValue> = {};
        for (const child of field.children) {
          const childKey = child.alias ?? child.name;
          if (child.name === 'nodes') conn[childKey] = page.nodes.map((issue) => issueNode(store, repo, issue, child.children));
          else if (child.name === 'pageInfo') conn[childKey] = page.pageInfo;
          else if (child.name === 'totalCount') conn[childKey] = issues.length;
          else if (child.name === 'edges') conn[childKey] = page.nodes.map((issue) => ({ node: issueNode(store, repo, issue, child.children) }));
        }
        out[key] = conn;
        break;
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
        const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : undefined;
        const after = typeof field.args['after'] === 'string' ? (field.args['after'] as string) : undefined;
        const page = paginate(pulls, first, after);
        const conn: Record<string, JsonValue> = {};
        for (const child of field.children) {
          const childKey = child.alias ?? child.name;
          if (child.name === 'nodes') conn[childKey] = page.nodes.map((pull) => pullNode(store, repo, pull, child.children));
          else if (child.name === 'pageInfo') conn[childKey] = page.pageInfo;
          else if (child.name === 'totalCount') conn[childKey] = pulls.length;
          else if (child.name === 'edges') conn[childKey] = page.nodes.map((pull) => ({ node: pullNode(store, repo, pull, child.children) }));
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const number = field.args['number'] as number | undefined;
        const pull = number === undefined ? undefined : store.findPull(repo, number);
        out[key] = pull === undefined ? null : pullNode(store, repo, pull, field.children);
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
        out[key] = null;
    }
  }
  return out;
}

function typeIntrospection(name: string, fields: FieldNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === 'fields') {
      const list = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
      out[key] = list.map((fieldName) => ({ name: fieldName }));
    } else if (field.name === 'enumValues') {
      out[key] = name === 'SearchType' ? SEARCH_ENUM.map((value) => ({ name: value })) : [];
    } else if (field.name === 'name') {
      out[key] = name;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function executeOperation(ctx: Ctx, operation: Operation): Record<string, JsonValue> {
  const { store } = ctx;
  const data: Record<string, JsonValue> = {};
  for (const field of operation.fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__type') {
      const name = String(field.args['name'] ?? '');
      data[key] = typeIntrospection(name, field.children);
      continue;
    }
    if (field.name === '__schema') {
      data[key] = { types: [{ name: 'Query' }, { name: 'Repository' }, { name: 'Issue' }, { name: 'PullRequest' }] };
      continue;
    }
    if (field.name === 'viewer') {
      const viewer: Record<string, JsonValue> = {};
      for (const child of field.children) {
        const childKey = child.alias ?? child.name;
        if (child.name === 'login') viewer[childKey] = store.viewerLogin();
        else if (child.name === 'id') viewer[childKey] = Buffer.from(`user:${store.viewerLogin()}`, 'utf8').toString('base64url');
        else {
          ctx.errors.push({ message: `Cannot query field "${child.name}" on type "User".` });
          viewer[childKey] = null;
        }
      }
      data[key] = viewer;
      continue;
    }
    if (field.name === 'repository') {
      const owner = String(field.args['owner'] ?? '');
      const name = String(field.args['name'] ?? '');
      const repo = store.getRepo(owner, name);
      data[key] = repo === undefined ? null : repoNode(ctx, repo, field.children);
      continue;
    }
    if (field.name === 'node') {
      const id = String(field.args['id'] ?? '');
      const decoded = store.decodeGlobalId(id);
      let node: Record<string, JsonValue> | null = null;
      if (decoded !== null && decoded.kind === 'repo') {
        const repo = store.findRepoById(decoded.databaseId);
        if (repo !== undefined) {
          node = { id };
          for (const child of field.children) {
            if (child.name === '__inline__') {
              if (child.inlineType === 'Repository' || child.inlineType === null) Object.assign(node, repoNode(ctx, repo, child.children));
              continue;
            }
            const childKey = child.alias ?? child.name;
            if (child.name === 'id') node[childKey] = id;
            else {
              ctx.errors.push({ message: `Cannot query field "${child.name}" on type "Node".` });
              node[childKey] = null;
            }
          }
        }
      } else if (decoded !== null && (decoded.kind === 'issue' || decoded.kind === 'pull')) {
        const repo = store.findRepoById(decoded.databaseId);
        if (repo !== undefined) {
          node = { id };
          for (const child of field.children) {
            if (child.name === '__inline__') continue;
            const childKey = child.alias ?? child.name;
            if (child.name === 'id') node[childKey] = id;
            else node[childKey] = null;
          }
        }
      }
      data[key] = node;
      continue;
    }
    if (operation.kind === 'mutation') {
      data[key] = executeMutation(ctx, field);
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    data[key] = null;
  }
  return data;
}

function executeMutation(ctx: Ctx, field: FieldNode): Record<string, JsonValue> | null {
  const { store } = ctx;
  const input = (field.args['input'] ?? {}) as Record<string, JsonValue>;
  if (field.name === 'createIssue') {
    const decoded = store.decodeGlobalId(String(input['repositoryId'] ?? ''));
    const repo = decoded === null ? undefined : store.findRepoById(decoded.databaseId);
    if (repo === undefined) return null;
    const issue = store.createIssue(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
    const out: Record<string, JsonValue> = {};
    for (const child of field.children) {
      const childKey = child.alias ?? child.name;
      if (child.name === 'issue') out[childKey] = issueNode(store, repo, issue, child.children);
      else if (child.name === 'clientMutationId') out[childKey] = null;
    }
    return out;
  }
  if (field.name === 'closeIssue') {
    const decoded = store.decodeGlobalId(String(input['issueId'] ?? ''));
    if (decoded === null || decoded.kind !== 'issue') return null;
    const repo = store.findRepoById(decoded.databaseId);
    const issue = repo === undefined ? undefined : store.findIssue(repo, decoded.number);
    if (repo === undefined || issue === undefined) return null;
    issue.state = 'closed';
    issue.closedSeq = store.nextSeq();
    const out: Record<string, JsonValue> = {};
    for (const child of field.children) {
      const childKey = child.alias ?? child.name;
      if (child.name === 'issue') out[childKey] = issueNode(store, repo, issue, child.children);
    }
    return out;
  }
  if (field.name === 'createPullRequest') {
    const decoded = store.decodeGlobalId(String(input['repositoryId'] ?? ''));
    const repo = decoded === null ? undefined : store.findRepoById(decoded.databaseId);
    if (repo === undefined) return null;
    const head = String(input['headRefName'] ?? '');
    const base = String(input['baseRefName'] ?? repo.defaultBranch);
    const pull = store.createPull(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), head, base);
    if (pull === null) return null;
    const out: Record<string, JsonValue> = {};
    for (const child of field.children) {
      const childKey = child.alias ?? child.name;
      if (child.name === 'pullRequest') out[childKey] = pullNode(store, repo, pull, child.children);
    }
    return out;
  }
  if (field.name === 'mergePullRequest') {
    const decoded = store.decodeGlobalId(String(input['pullRequestId'] ?? ''));
    if (decoded === null || decoded.kind !== 'pull') return null;
    const repo = store.findRepoById(decoded.databaseId);
    const pull = repo === undefined ? undefined : store.findPull(repo, decoded.number);
    if (repo === undefined || pull === undefined) return null;
    store.mergePull(repo, pull);
    const out: Record<string, JsonValue> = {};
    for (const child of field.children) {
      const childKey = child.alias ?? child.name;
      if (child.name === 'pullRequest') out[childKey] = pullNode(store, repo, pull, child.children);
    }
    return out;
  }
  if (field.name === 'addComment') {
    const decoded = store.decodeGlobalId(String(input['subjectId'] ?? ''));
    if (decoded === null || decoded.kind !== 'issue') return null;
    const repo = store.findRepoById(decoded.databaseId);
    const issue = repo === undefined ? undefined : store.findIssue(repo, decoded.number);
    if (repo === undefined || issue === undefined) return null;
    const comment = store.addComment(repo, issue, String(input['body'] ?? ''));
    const out: Record<string, JsonValue> = {};
    for (const child of field.children) {
      const childKey = child.alias ?? child.name;
      if (child.name === 'commentEdge') {
        const edge: Record<string, JsonValue> = {};
        for (const edgeChild of child.children) {
          const edgeKey = edgeChild.alias ?? edgeChild.name;
          if (edgeChild.name === 'node') {
            edge[edgeKey] = { id: store.commentGlobalId(repo, comment), body: comment.body };
          }
        }
        out[childKey] = edge;
      }
    }
    return out;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

/** Execute one GraphQL body (a single operation object or a batch array). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, JsonValue>;
  const query = typeof record['query'] === 'string' ? (record['query'] as string) : '';
  const variables = (typeof record['variables'] === 'object' && record['variables'] !== null ? record['variables'] : {}) as Record<string, JsonValue>;
  const ctx: Ctx = { store, errors: [] };
  if (query.trim() === '') {
    return { errors: [{ message: 'No query was provided.' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(query, variables).parseOperations();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query.' }] };
  }
  if (operations.length === 0) {
    return { errors: [{ message: 'No operation was provided.' }] };
  }
  const data = executeOperation(ctx, operations[0] as Operation);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}
