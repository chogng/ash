# LiveKit Server distribution

This root directory owns Ash's independently installed local call-hosting server
declaration, [`runtime.json`](runtime.json). It is not an editor extension.
Joining external rooms and dictation do not install or launch this server.

The locked upstream source, versions and notices remain in
[`third_party/livekit`](../third_party/livekit/README.md). Shared call coordination
stays in `crates/call`; local audio, video and screen clients stay in their existing
client crates. The server is installed only when explicitly hosting a local call.

Build and archive it with the existing packaging entrypoint:

```sh
scripts/.venv/bin/python -B build/release/capabilities.py build \
  --kind livekit --package-dir dist/ash-livekit \
  --archive-dir .build/releases --descriptor-file dist/livekit.json
```

See [media and hosting delivery](../docs/media-delivery.md) for release binding,
download verification, offline overrides and installation reuse.
