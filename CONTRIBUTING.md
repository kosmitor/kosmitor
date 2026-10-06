# Contributing to Kosmitor

Thank you for helping. Bug reports, fixes and new features are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it, what you expected and what happened.
- For a new feature or a large change, open an issue first so we can agree on the approach before you write the code.
- Do not report security problems in a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 26 and PostgreSQL 14 or newer. Then follow [Running it](README.md#running-it) in the README.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Keep the change small and focused on one thing.
3. Add or update tests for the behaviour you change. Financial math in `packages/core` needs tests whose expected values come from the rules, not from the code.
4. If you change `kosmitor.config.schema.json` or the defaults, run `npm run config:docs`.
5. Run the checks:

   ```bash
   npm run build
   npm test
   ```

   The server tests create and drop their own databases. If your PostgreSQL needs a password, set `PG_ADMIN_URL`, for example `postgres://postgres:postgres@localhost:5432/postgres`.

6. Open a pull request against `main` that says what changed and why. CI runs the same checks.

## License

By contributing, you agree that your contributions are licensed under the [Mozilla Public License 2.0](LICENSE).
