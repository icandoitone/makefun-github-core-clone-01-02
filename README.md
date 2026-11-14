# Forge — one-process GitHub-compatible git forge

A single Node 22 TypeScript process (standard library only, no git binary,
no dependencies, no network) that implements enough of GitHub to pass the
`github-core-clone-01` conformance suite: REST v3, git smart HTTP, GraphQL,
and MCP, all backed by one in-memory store.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), then polls
`GET $MAKEFUN_ENV_URL/done` until the environment answers
`{"done": true}` and exits 0. The bearer token for the API is read from
`MAKEFUN_SHOP_TOKEN`.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entrypoint: lifecycle (bind, register, wait for done, exit). |
| `app.ts` | HTTP server and the REST v3 routes under `/api/v3`. |
| `store.ts` | In-memory repository/issue/pull-request store, deterministic timestamps, viewer learning. |
| `gitobj.ts` | Git object model: SHA-1 objects, trees, commits, tags, pack read/write (OFS/REF deltas), pkt-line codec. |
| `gitproto.ts` | Git smart HTTP: `upload-pack` protocol v2 and v0, `receive-pack` v0, shallow fetch/deepen, fast-forward-only pushes. |
| `graphql.ts` | GraphQL executor for `/api/graphql` (viewer, repository, issues, pull requests, mutations, batched operations, introspection). |
| `mcp.ts` | MCP (JSON-RPC 2.0 Streamable HTTP) at `/mcp`: `server/discover`, `initialize`, `tools/list`, `tools/call` (8 tools). |

## Surfaces

- **REST v3** (`/api/v3`): repositories, branches, commits, git refs, file
  contents (create/update with stale-sha 409), labels, issues + comments,
  pull requests + files + squash merge. Every reply is JSON with a
  non-empty `X-GitHub-Request-Id`; missing token is 401; a repository under
  another owner is 404, never 403.
- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 advertisement and
  `ls-refs`/`fetch`, v0 fallback, `receive-pack` v0 with `report-status`.
  Packfiles are built and read in-process (`node:zlib`), including delta
  resolution and side-band-64k framing. Pushes are fast-forward only.
- **GraphQL** (`/api/graphql`): repository/issue/pull-request queries with
  cursor pagination, mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`), batched operation
  arrays, and `__type`/`__schema` introspection. Global IDs are opaque.
- **MCP** (`/mcp`): `create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request`,
  acting on the same store as REST.

## Notes

- State is deterministic: timestamps derive from a fixed epoch plus a
  sequence number, and no wall clock or randomness appears in served state,
  so repeated trials reproduce the same answers.
- The viewer (token owner) login is learned from the first owner-bearing
  request that names an existing repository; the token itself is treated as
  an opaque credential and never assumed to be a login.
