# zapdev-mcp

MCP server exposing zapdev repository, commit and pull request tools over stdio.

## Usage

Once published, add this server to your MCP client:

```json
{
  "mcpServers": {
    "zapdev": {
      "command": "npx",
      "args": ["--yes", "zapdev-mcp"]
    }
  }
}
```

Requires Node.js >=20, Git, authenticated GitHub CLI (`gh`) for pull requests,
and zapdev's `ZD_*` configuration for commit and PR generation.

## Development

```sh
npm ci
npm run typecheck
npm test
npm start
```

## Releases

Conventional Commits on `main` update a Release Please PR. Merging that PR
creates the GitHub release and publishes to npm using OIDC; `prepack` builds
the executable automatically.

One-time setup:

1. Enable **Allow GitHub Actions to create and approve pull requests** in the
   repository's Actions settings.
2. For this new package, publish the initial version manually with `npm login`
   and `npm publish --access public`.
3. In the npm package settings, add a GitHub Actions Trusted Publisher:
   user `mvagnon`, repository `zapdev-mcp`, workflow filename `release.yml`,
   no environment. Allow direct `npm publish` and complete the first automated
   publication within two days of configuring it.

Optionally set the GitHub Actions variable `RELEASE_REVIEWER` to request a
reviewer on release PRs. No npm token secret is needed for automated publishing.
