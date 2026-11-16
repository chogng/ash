# CI responsibilities

`blocking-ci.yml` selects required product checks from `.github/ci-workflows.json`.
App Server library and real-process tests run in `app-server.yml`, independently
of frontend success. Existing stdio/SSH lifecycle coverage lives with those tests.
`rust-warnings.yml` retains compilation checks and the TUI suites.

On main, selection compares with the most recent completed main push and also
retries domains selected there that failed, were cancelled, or never ran. This
covers changes from replaced pending runs without rerunning successful unrelated
domains. `ci-results-<run-id>` records the original selection and GitHub job
results, including failures. Expired, missing, incompatible or untrusted evidence
selects all product checks. Deletions are included in the diff. A selected job
must succeed; only a job explicitly excluded by selection may be skipped.

Dependency source production and releases have separate repositories and queues:

- [V8](https://github.com/chogng/ash-rusty-v8) owns patched source validation,
  eight-target archive/binding releases and producer/native consumer verification.
  Ash's required `v8-security.yml` checks the pinned pairs and runtime mitigations.
- [LiveKit Server](https://github.com/chogng/ash-livekit-server) owns upstream
  source/build pins and six-target native binary releases. Ash consumes exact
  archive hashes; its normal builds do not compile the Go server.

`media.yml` retains real LiveKit room, authority and process integration tests.
It is selected for media changes, not every native-resource helper change.
`livekit-server.yml` independently verifies the locked server and the Ash hosting
capability package on relevant changes, weekly, or by manual dispatch. It neither
publishes dependencies nor blocks unrelated product commits.

Product release jobs accept the reserved `v<product-version>` tag namespace.
Historical dependency releases remain available for old source checkouts; new
dependency releases live in their own repositories. Consumers use immutable tags,
archive sizes/checksums, matching bindings, and verified producer provenance.
