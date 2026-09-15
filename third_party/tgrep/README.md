# tgrep runtime

- Pins the Agent grep executable, target mapping, archive size and SHA-256 in `runtime-lock.json`.
- Development and release resolve the same verified artifacts into `third_party/.cache/tgrep/`; downloaded binaries are not committed.
- Packages carry `ash-resources/tgrep/tgrep[.exe]` and `ash-resources/licenses/tgrep/LICENSE`.
- `ash-tgrep` owns process lifetime and the version-specific protocol. The application never downloads the runtime during a search.
- Upgrade the lock and adapter together, verify all release assets, and run package and real-engine integration tests.
