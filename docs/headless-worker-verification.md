# DSH and ZCode worker verification

## Runtime smoke test

On macOS arm64, the actual CLIs were driven through Foreman against local scripted streaming providers. No account, production API key or paid model request was used.

| CLI | Version | Verified |
| --- | --- | --- |
| Official `dsh headless` | `0.2.2-rc.5` | `check`, discussion, diff review, explicit same-ID discussion resume, per-step usage. The mocked provider requested a project read, a direct file write and a shell redirection; the read succeeded and both writes were denied. |
| `zcode-app-cli` | `3.18.2-47` (runtime `0.17.1`) | `check`, discussion, diff review and explicit same-ID discussion resume using a personal provider config. The provider request exposed no tools with these versions and Foreman's settings. |

The tested ZCode build rejects `--mode plan`, despite official source documentation mentioning it. Foreman uses `build` with extensions and known tools disabled, a separate workspace and an enforced macOS write sandbox. The CLI never runs with the project as its working directory. This is not a general filesystem read or network sandbox. Foreman does not reuse the Desktop session database or assume its authentication can be shared.

## Regression tests

```sh
node --test tests/headless-workers.test.mjs tests/codebuddy.test.mjs
node tools/sync-shared.mjs --check
```

The headless tests use local fixture processes. They exercise missing and failed terminal records, wrong resume IDs, same-session report repair, the prompt byte budget, cancellation of regular and detached descendants, and macOS write denial through both a direct path and a symlink. They do not validate live provider behaviour or cross-platform support beyond the tested platform.
