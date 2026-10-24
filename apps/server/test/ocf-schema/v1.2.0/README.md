# Open Cap Format (OCF) JSON Schemas, v1.2.0

The official JSON Schemas of the Open Cap Format, vendored unmodified so the
server tests can validate every OCF package Kosmitor exports
(`apps/server/test/ocf-*.test.ts`). Nothing in `src/` reads these files, and they
are not in the Docker image (`.dockerignore` leaves out `apps/server/test`).

| | |
|---|---|
| Source | https://github.com/Open-Cap-Table-Coalition/Open-Cap-Format-OCF |
| Release | `v1.2.0` (published 2024-08-21), the latest tagged release on 2026-10-23 |
| Commit | `9f987b48e288703ff2cd6c4534f7769bb04e724a` |
| Archive | https://github.com/Open-Cap-Table-Coalition/Open-Cap-Format-OCF/archive/refs/tags/v1.2.0.tar.gz (SHA-256 `15f9252f3e65bae957a4f658068d9fcdbdea2630ccdec945cf10e0c1441ee9d4`) |
| Copied | `schema/` (168 files) and `LICENSE.md`, byte for byte |
| Schema `$id`s | `https://schema.opencaptablecoalition.com/v/1.2.0/...` (draft-07) |

## License

`LICENSE.md` is the Open Cap Table Coalition's *Schema and Documentation
License*, version 1.0.1 (not MIT). It allows copying and distributing the
schema files as they are, provided each keeps its `$comment` copyright notice,
which every file here does. Do not edit these files: a derivative of an OCF
file may not be published as a specification. The coalition's sample files and
docs (Apache 2.0 code components) are not vendored; tests build their own
packages from invented data.

## Using them in a test

Load every `*.schema.json` under `schema/` into one validator, then validate a
file by its `file_type` and each item by its `object_type`:

```ts
import Ajv from 'ajv';               // devDependency of apps/server only
import addFormats from 'ajv-formats'; // the schemas use the date, date-time and email formats
const ajv = new Ajv({ strict: false, allErrors: true, schemas });
addFormats(ajv);
ajv.getSchema('https://schema.opencaptablecoalition.com/v/1.2.0/files/StakeholdersFile.schema.json');
```

`ajv` and `ajv-formats` are dev dependencies of `@kosmitor/server`; production
installs (`npm ci --omit=dev`) never get them.

## A new OCF release

Add it beside this one in its own folder (`v1.3.0/`), copied unmodified with
its own README, and move the tests over when the export writes that version.
Keep this folder until nothing reads it.
