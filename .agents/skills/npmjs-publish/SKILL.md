---
name: npmjs-publish
description: Configure, run, verify, and rotate secure npm publishing through GitHub Actions. Use when Codex needs to create an npm granular access token, configure NPM_TOKEN, migrate to npm trusted publishing/OIDC, add or repair an npm publish workflow, publish a package version, rotate an expiring token, or document npm release operations.
---

# Publish to npm

Publish through GitHub Actions and keep npm credentials out of git, shell
history, logs, and chat output.

## Choose authentication

Prefer npm trusted publishing (OIDC) for an existing package:

1. Enable 2FA on the npm account.
2. Open the package on npm, then configure its GitHub Actions trusted
   publisher with the exact owner, repository, workflow filename, and optional
   environment.
3. Grant the workflow `id-token: write`.
4. Publish with `npm publish --provenance` without `NPM_TOKEN`.

Use a granular access token only when trusted publishing is unavailable or the
user explicitly requests a token. npm currently limits write tokens to 90
days. Tokens that bypass 2FA are being phased out; treat them as a temporary
CI fallback, not a permanent design.

## Create a granular access token

Use the user's logged-in npm website session when authorized:

1. Open **Account settings → Access Tokens → Generate New Token**.
2. Give the token a unique CI-specific name and description.
3. Enable **Bypass two-factor authentication** only when the workflow must
   publish with a token.
4. Set **Packages and scopes** to **Read and write**.
5. Select **Only select packages and scopes**, then choose the exact package.
6. Leave **Organizations** at **No access** unless publishing genuinely needs
   organization administration.
7. Choose **90 days** or a shorter duration requested by the user.
8. Review the summary, generate the token, and capture the value once.

For the first release of a package that does not yet exist, npm cannot offer
that package in the selector. Use the narrowest temporary account or scope
permission that permits the first publish. Immediately replace it with a
package-specific token after the package exists and revoke the broader token.

Never print the generated value. Never put it in a command argument, tracked
file, `.npmrc`, issue, pull request, or workflow YAML.

## Store the GitHub Actions secret

Prefer the interactive GitHub CLI prompt so the token does not enter shell
history:

```bash
gh secret set NPM_TOKEN --app actions --repo OWNER/REPOSITORY
```

Paste the token when prompted, then verify only the secret name and update
time:

```bash
gh secret list --app actions --repo OWNER/REPOSITORY
```

If automation must transfer the value, use a mode-`0600` temporary file, feed
it through standard input, and securely delete it immediately:

```bash
gh secret set NPM_TOKEN --app actions --repo OWNER/REPOSITORY < /path/to/locked-token-file
shred -u /path/to/locked-token-file
```

Use an exact validated temporary path. Do not expose the token while checking
the file.

## Configure the workflow

Use a manually triggered workflow unless the repository already has an
intentional tag- or release-based policy:

```yaml
name: Publish package

on:
  workflow_dispatch:

concurrency:
  group: npm-publish
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - run: npm ci
      - run: npm test
      - run: npm run build --if-present
      - run: npm pack --dry-run

      - run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Adapt the install, test, and build commands to the repository's package
manager. Preserve lockfile enforcement. For trusted publishing, remove
`NODE_AUTH_TOKEN` and the `NPM_TOKEN` dependency after OIDC is configured.

## Publish and verify

Confirm ownership, package name, registry state, and version before triggering
the workflow:

```bash
npm view PACKAGE name version dist-tags --json
npm pack --dry-run
git status --short
```

npm versions are immutable. Bump `package.json` and relevant lockfiles before
publishing if the version already exists. Run the repository's required
checks, commit only intended files, and push the branch requested by the user.

Trigger and watch the workflow:

```bash
gh workflow run publish.yml --repo OWNER/REPOSITORY
gh run list --repo OWNER/REPOSITORY --workflow publish.yml --limit 3
gh run watch RUN_ID --repo OWNER/REPOSITORY --exit-status
```

Verify the registry independently after the workflow succeeds:

```bash
npm view PACKAGE@VERSION name version dist-tags.latest dist.tarball --json
```

Do not report success from the workflow alone. Confirm that the requested
version is visible on the public registry.

## Rotate safely

1. Create the replacement token with equal or narrower access.
2. Update `NPM_TOKEN` in GitHub.
3. Verify the secret timestamp.
4. Exercise the next legitimate publish or a planned version release.
5. Revoke the old token only after the replacement is proven.
6. Record the expiration date outside source control.

If a token appears in git history or logs, treat it as compromised: revoke it
immediately, replace the GitHub secret, and remove the exposed value from the
history or log surface as appropriate.
