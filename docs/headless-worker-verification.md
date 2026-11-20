# DSH and ZCode worker verification

## Runtime smoke test

On macOS arm64, the actual CLIs were driven through Foreman against local scripted streaming providers. No account, production API key or paid model request was used.

| CLI | Version | Verified |
| --- | --- | --- |
| Official `dsh headless` | `0.2.2-rc.5` | `check`, discussion, diff review, explicit same-ID discussion resume, per-step usage. The mocked provider requested a project read, a direct file write and a shell redirection; the read succeeded and both writes were denied in read-only mode. Opt-in `run.simple` was also tested end to end: direct and Bash writes succeeded in the workspace, while both mechanisms denied writes to a sibling directory, writes through a symlink to that directory, and requests to escalate. |
| `zcode-app-cli` | `3.18.2-47` (runtime `0.17.1`) | `check`, discussion, diff review and explicit same-ID discussion resume using a personal provider config. The provider request exposed no tools with these versions and Foreman's settings. |

The tested ZCode build rejects `--mode plan`, despite official source documentation mentioning it. Foreman uses `build` with extensions and known tools disabled, a separate workspace and an enforced macOS write sandbox. The CLI never runs with the project as its working directory. This is not a general filesystem read or network sandbox. Foreman does not reuse the Desktop session database or assume its authentication can be shared.

DSH’s native preset may allow writes in system temp directories. The outside-write probes use a sibling project directory under the home directory (not a system temp directory). This test does not establish a general read or network sandbox, or validate modified DSH profiles.

## Regression tests

```sh
node --test tests/headless-workers.test.mjs tests/codebuddy.test.mjs
node tools/sync-shared.mjs --check
```

The headless tests use local fixture processes. They exercise missing and failed terminal records, wrong resume IDs, same-session report repair, the prompt byte budget, cancellation of regular and detached descendants, and macOS write denial through both a direct path and a symlink. They do not validate live provider behaviour or cross-platform support beyond the tested platform.

To repeat the end-to-end write checks using the installed official DSH CLI on macOS:

```sh
FOREMAN_TEST_REAL_DSH=1 node --test tests/dsh-live.test.mjs
```
