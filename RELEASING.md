# Releasing `pi-subagents-workflows`

This checklist is operational guidance. Adding or updating it does not publish
anything. The first release is intentionally separate from implementation and
requires an explicit release decision.

## Release invariants

- Release only from a reviewed commit merged to the repository's default
  branch. The workflow checks out the immutable release-event SHA, verifies the
  tag resolves to it, and requires that commit to be an ancestor of the default
  branch. Do not publish from a dirty checkout or move an existing tag.
- Keep `package.json`, `src/version.ts`, the changelog heading, and the Git tag
  on the same exact version.
- Use Node.js 24 and install with lifecycle scripts disabled.
- Consume only published, supported `pi-subagents` artifacts. Never release
  against sibling source, `npm link`, deep imports, or an unreviewed tarball.
- Required Ubuntu and Windows tests, package checks, and the Cartesian Pi
  0.81.0/0.82.1 by provider 0.36.0/0.37.0 artifact/real-extension matrix must
  finish successfully. A timeout, retry, or skipped required combination is
  not green.
- Preserve the documented foreground and Windows threat boundaries. A release
  does not silently widen authority, persistence, or reparse guarantees.

## Prepare `0.1.0`

1. Confirm the package name is still available on npm and that no Git tag or
   GitHub release named `v0.1.0` exists.
2. Rotate the previously exposed npm credential. Revoke the old credential;
   never paste either credential into a command, issue, log, or release note.
3. Confirm the protected GitHub Actions environment named `npm-publish`
   requires reviewer approval and allows only `v*` tags. The workflow's
   immutable-SHA preflight separately requires the tag commit to belong to the
   default branch.
4. Because npm cannot configure a trusted publisher until a package exists,
   create a short-lived granular token for the first publish only:
   - restrict it to this package when npm permits;
   - grant publish access and bypass 2FA only when required for unattended CI;
   - choose the shortest practical expiry; and
   - store it only as the `NPM_TOKEN` secret in the protected `npm-publish`
     environment, never as a repository secret or command-line argument.
5. Replace `Unreleased` in `CHANGELOG.md` with the UTC release date and review
   the notes against the final branch diff.
6. Confirm the release workflow still has least privilege: repository contents
   are read-only and only the protected publish job receives
   `id-token: write`.

## Validate the candidate

From a clean checkout of the exact candidate commit:

```bash
npm ci --ignore-scripts
npm test
npm run pack:check
npm publish --dry-run --ignore-scripts --access public
```

Also require the branch CI matrix to pass:

- Node 24 unit, type, and exact-package tests on Ubuntu and Windows;
- SHA-verified `pi-subagents` 0.36.0 and 0.37.0 artifact smoke tests; and
- packed real-extension Pi-session tests for Pi 0.81.0 and 0.82.1 with both
  provider versions on both operating systems.

Inspect the dry-run file list. It must contain only the declared package
manifest, license, changelog, public documentation, and `src/` TypeScript
sources. It must not contain credentials, local audit records, test fixtures,
research intake, generated logs, or sibling dependencies.

## Publish the first release

1. Merge the reviewed release commit to the default branch.
2. Create and publish a GitHub release tagged exactly `v0.1.0` at that commit.
   Do not create the tag from an older branch head. The workflow must verify
   the immutable event SHA against both the tag and the default branch.
3. The release workflow must rerun the complete supported host/provider matrix
   on Ubuntu and Windows before the protected publish environment can be
   approved.
4. After an authorized reviewer approves that environment, the publish job
   checks the tag against `package.json`, then runs:

   ```bash
   npm publish --ignore-scripts --provenance --access public
   ```

5. If any gate fails before publication starts, leave the failed release and
   tag as immutable evidence. Correct the cause, bump the package version and
   changelog, and create a new release/tag; never move or reuse the failed tag.
6. If publication fails, times out, or returns an ambiguous result, query npm
   registry metadata and integrity before retrying anything:
   - if that version exists, never retry or replace it; verify and deprecate it
     if necessary, then publish a bumped correction; or
   - if it does not exist, retire the failed release/tag, correct the cause,
     bump the package version, and publish a newly reviewed candidate.

## Verify and remove the bootstrap secret

After npm reports success:

1. Verify `pi-subagents-workflows@0.1.0` metadata, integrity, provenance, public
   exports, and clean installation from the registry.
2. Run one real Pi foreground workflow using the registry package and a
   supported published provider.
3. Configure npm trusted publishing for:
   - GitHub organization/user: `neumie`;
   - repository: `pi-subagents-workflows`; and
   - workflow: `.github/workflows/release.yml`.
4. Update the workflow to use OIDC trusted publishing without
   `NODE_AUTH_TOKEN`, validate that change before the next release, and delete
   the GitHub `NPM_TOKEN` secret.
5. Revoke the short-lived first-publish token immediately, even if it has not
   yet expired.

If a published package is defective, prefer an immediate corrected release and
an npm deprecation notice for the bad version. Unpublish only when npm policy
and the severity of the incident require it.
