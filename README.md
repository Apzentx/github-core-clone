# github-core-clone

A standalone GitHub-compatible git forge in one Node 22 process with no dependencies:
git smart HTTP (protocol v2 `upload-pack` with `ls-refs`/`fetch`, v0 `receive-pack` with
`report-status`/`side-band-64k`), REST v3 (repositories, branches, commits, contents,
labels, issues, comments, pull requests, files, squash merges), GraphQL v4 (the
documents `gh` and `github-mcp-server` send, plus Relay global ids and operation
batching), and MCP over streamable HTTP (`initialize`, `tools/list`, `tools/call`).

State is in-memory and deterministic: a logical clock drives every timestamp, and the
viewer identity comes from the contest's fixed scenario seed (viewer `adaiversen`).

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
poll `GET $MAKEFUN_ENV_URL/done`, exit 0. `app.ts` is the server; `store.ts` holds the
in-memory store and the git object model; `git.ts`, `rest.ts`, `graphql.ts` and `mcp.ts`
are the four surfaces.

## Layout

- `main.ts` — entry <-> env lifecycle (starter, unchanged apart from the token).
- `app.ts` — HTTP routing, auth, response discipline.
- `store.ts` — store, git objects (blob/tree/commit/tag), packfiles, pkt-line.
- `git.ts` — git smart HTTP.
- `rest.ts` — REST v3.
- `graphql.ts` — GraphQL v4 parser + executor.
- `mcp.ts` — MCP tools over JSON-RPC 2.0.

## Licence

MIT.
