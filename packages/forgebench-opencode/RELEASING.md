# Releasing @forgebench/opencode

Not published to npm yet: the first publish is a human step (H1 #1061). The source package here is `private: true`;
only the staged copy (`node scripts/release.mjs stage --destination <dir>`) is publishable.

Source lives in the private monorepo. The npm publisher runs in the public `seedlinglabs/forgebench-cli`
repo (decision #1062) so provenance comes from public source.

1. Set `VERSION` (exact semver, no range, no `v`), run `node scripts/release.mjs stamp`, commit both. The mirror
   workflow stages the package and strips `private` in the staged copy only.
2. Merge to `develop` to publish a dev edition, then promote through `staging` to `main`. `.github/workflows/release-forgebench-opencode.yml`
   mirrors the package to `packages/forgebench-opencode` in forgebench-cli. It never publishes and never writes
   under `.github/`.
3. **Workflow install (human, once).** Copy `publisher/publish-opencode-plugin.yml` to
   `.github/workflows/publish-opencode-plugin.yml` in forgebench-cli through a reviewed PR. The sync App has
   Contents permission only; do not assume it can change workflow files (grant Workflows explicitly if you
   want that).
4. **Create the `npm-publish` GitHub environment (owner, before binding the trusted publisher).** In
   `seedlinglabs/forgebench-cli` settings, create environment `npm-publish`, restrict deployment branches to `main`, `opencode-dev`, and `opencode-staging`,
   and add a required reviewer. The publish job runs in it, so no publish happens without that approval.
5. **H1 (#1061), authorised npm owner only, once, before trusted publishing exists.**
   1. Explicit publication approval: record who approved publishing exactly the version in `VERSION` before running
      anything below. Without that approval, stop.
   2. From a clean checkout of a named commit (note its SHA), stage and review:
      ```
      STAGE="$(mktemp -d)/pkg"
      node scripts/release.mjs stage --require-clean --destination "$STAGE"   # refuses a dirty tree, prints "source SHA <sha>"
      cd "$STAGE" && node scripts/release.mjs inspect && node scripts/release.mjs scan
      npm pack
      ```
      Review the `npm pack` file list and integrity (sha512) against the approved version; `inspect` must list only
      the shippable files.
   3. Publish from the staged directory:
      ```
      npm publish --ignore-scripts --access public --registry https://registry.npmjs.org
      ```
      `--ignore-scripts` is the documented way past the `prepublishOnly` guard, which otherwise only passes inside the
      public repo's Actions run or under `--dry-run`. Nobody else bypasses the guard.
   4. Record on #1061: the package/version URL `https://www.npmjs.com/package/@forgebench/opencode/v/<version>`, the
      source SHA, the tarball integrity and the approver.
   5. Configure the trusted publisher for repository `seedlinglabs/forgebench-cli`, workflow
      `publish-opencode-plugin.yml`, environment `npm-publish`.
   6. Validate the steady-state OIDC/provenance path: publish the next approved version through the workflow and
      confirm the npm page shows the provenance attestation built from forgebench-cli. Record that evidence on #1061.
5a. **CI token.** The publish job also authenticates with the `NPM_TOKEN` Actions secret in `seedlinglabs/forgebench-cli` (granular token, write access to `@forgebench`, bypass 2FA, short expiry). Rotate the secret rather than widening the token; trusted publishing (step 5.5) can replace it later.
6. Later releases: run the publisher workflow manually on `main` with the exact version. The `test` job tests the
   mirrored source, checks the installed workflow equals the reviewed source, scans for secrets, inspects the pack,
   refuses an already-published version and refuses a stable version not greater than `latest`. The `publish` job
   (approved through `npm-publish`) publishes with `--provenance` (prereleases go to the `next` tag). The version
   is passed through an environment variable, never interpolated into shell.

## What stops a stray publish

The source package keeps `"private": true`, so `npm publish` from the monorepo fails with EPRIVATE before any
upload (or ENEEDAUTH when not logged in; EPRIVATE comes first), even with `--ignore-scripts` (a `--dry-run` still prints the tarball and exits 0, because npm skips the
private check there). The staged copy has `private` removed. The `prepublishOnly` guard is only defence in depth: it
can be skipped (`--ignore-scripts`, `ignore-scripts=true`, publishing a tarball), and npm scope authentication is
the final control. A passing local `npm publish --dry-run` of a staged copy does not mean anything is published.

## For the CLI (T10 #1076)

- Reviewed version: the `VERSION` file (bundle it at CLI build time). Write exactly that version into the
  OpenCode config, never a range.
- Published check (read only): import `checkPublished` from `scripts/check-published.mjs` (do not shell out, and do
  not honour `FORGEBENCH_NPM_REGISTRY`, which exists for this package's tests only), or reproduce its
  contract: one unauthenticated `GET https://registry.npmjs.org/@forgebench%2fopencode/<version>`; HTTP 200 with
  the exact name and version is published, 404 is not-published, anything else is unverifiable. Exit codes 0,
  3, 4. Only `published` may migrate; the other two must leave the legacy integration untouched.

## Automatic publication

After the source sync on `develop`, `staging`, or `main`, the `sync` job in `release-forgebench-opencode.yml` runs `gh workflow run publish-opencode-plugin.yml` in `seedlinglabs/forgebench-cli` with the exact `VERSION`, unless npm already has that version. This needs two things in place, once:

1. `publisher/publish-opencode-plugin.yml` installed at `.github/workflows/publish-opencode-plugin.yml` in `seedlinglabs/forgebench-cli`.
2. The sync GitHub App granted **Actions: write** on `forgebench-cli`.

Until both are done the job fails loudly on the dispatch step; the sync itself has already landed.

## Dev and staging editions

Pushes to `develop` and `staging` mirror a stamped copy (`VERSION-dev.<run>` / `VERSION-staging.<run>`; the source `VERSION` stays the stable base) to the `opencode-dev` / `opencode-staging` branches of `seedlinglabs/forgebench-cli`, rebuilt from public `main` each run, then dispatch the publisher on that branch. npm tags: `dev`, `staging`; `latest` is untouched. The publisher's `verify-channel` step refuses a version published from the wrong branch. One-time human step: add `opencode-dev` and `opencode-staging` to the `npm-publish` environment's allowed deployment branches in forgebench-cli, and reinstall the updated `publisher/publish-opencode-plugin.yml` there.
