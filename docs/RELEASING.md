# Package and release verification

ICC SDK is a personal, independent toolkit for prototypes and sandbox integrations. It is unaffiliated with Visa and is not endorsed, sponsored, or certified by Visa. A passing build does not establish payment authorization, certification, or production readiness.

## Validate a candidate

Use Node 22.18 or newer, Python 3 and OpenSSL with a clean checkout:

```sh
npm ci
npm run verify
```

Verification builds from a clean `dist`, runs workflow and adapter tests, checks TypeScript in the implementation/tests/examples, executes the local checkout and purchasing-agent demos, and installs an `npm pack` tarball in a separate consumer. The consumer checks the ESM export, runtime contract JSON, and public TypeScript declarations. Installation is offline and package lifecycle scripts are disabled in the consumer. The runtime package has no dependencies; the official SDK and database driver are development dependencies used for compatibility tests.

CI runs on Node 22.18 and Node 24 with PostgreSQL 16. For database tests locally, supply a dedicated disposable test database through `TEST_DATABASE_URL`; do not use a production database. Without it, database integration tests are explicitly skipped. Official-client compatibility tests run against the pinned SDK version without live Visa credentials. Keep those checks distinct from authenticated JWT/MLE sandbox verification.

## Before distribution

Review the tarball with `npm pack --dry-run`, review changes to generated contracts, and retain the exact source commit and test results. Obtain approved sandbox fixtures and complete the applicable live authentication, response decryption, lifecycle, error, and reconciliation tests for each supported merchant configuration before enabling real payments.

The repository currently has no redistribution license. Package metadata therefore says `UNLICENSED`; the owner must choose and add an appropriate license before public package distribution. No npm publication or release automation is enabled. Confirm package ownership, license, registry access, release notes, and sandbox evidence before publishing. The scoped package name is `@gupta799/icc-sdk`.
