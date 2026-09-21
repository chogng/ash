# Backend test fixtures

- `task_completed.json` and `task_failed.json` are synthetic backend responses for prompt, message, diff, and error extraction through `read_task`.
- `ca.der`, `server.der`, and `server-key.der` are the repository's local test certificates, copied from `livekit-client/tests/fixtures` so this crate owns its test resources.
- The server certificate covers `localhost` and `127.0.0.1`, valid from September 16, 2026 to September 13, 2036.
- The key is public test data. Tests trust this CA only in their own HTTP client and connect directly to a loopback listener on a random port.
