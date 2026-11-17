# LiveKit Server inputs

`runtime-lock.json` pins six native server archives from the
[independent LiveKit distribution repository](https://github.com/chogng/ash-livekit-server).
The current release is `livekit-v1.13.7-ash.1`. Every archive has a fixed URL,
size and SHA-256. The producer verifies the actual server version on each native
runner, retains upstream and build provenance, and generates the complete
consumer lock only after all six targets pass.

Windows/Linux executables retain the upstream official release inputs. macOS
executables are built from the locked upstream source with the pinned Go toolchain
in the dependency repository. Normal Ash development, CI and packaging consume
these binaries without installing Go or rebuilding LiveKit.

`build/lib/livekit.py` validates the size and SHA-256 of cached/downloaded archives
before extracting the server. Missing locked binaries fail without falling back
to source compilation. Source builds belong to the dependency repository.

The hosting capability is separate from media clients and is installed only for
explicit local call hosting. Its product binding and installation remain owned by
the existing [LiveKit distribution declaration](../../livekit-server/README.md).
Room/client compatibility tests remain in Ash's `media.yml`; locked distribution
checks run independently in `livekit-server.yml`.

Upstream source remains [livekit/livekit](https://github.com/livekit/livekit).
The Apache-2.0 license and notices are retained in `LICENSE` and `NOTICE`, and
inside the independently published archives.
