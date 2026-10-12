# WezTerm PTY provenance

Ash uses one local copy of [`portable-pty 0.9.0`](portable-pty/Cargo.toml) for
PTY allocation and Windows ConPTY. It comes from the published crate at
WezTerm revision `f8921727a11b9f8b073e8c24821d72fd41283500` (`pty` directory).
The root Cargo dependency selects this source for product code and tests.
Retain the MIT license in release notices; the WezTerm terminal emulator is not bundled.

The Windows changes preserve system ConPTY loading, VT input flags, creation
pipe lifetimes, optional `ReleasePseudoConsole`, and an owned process handle in
the waiter thread. A borrowed Job can be attached atomically during process
creation; the library owns the attribute mechanism, while Ash owns Job limits,
cancellation, and normal-exit descendant preservation. The prepared-console
interface supports a sandbox launcher that creates its own restricted process.

Windows CommandBuilder also accepts a pre-escaped command-line tail: it quotes
the executable, preserves the tail, and rejects mixed argv, NUL, or a complete
CreateProcessW command line exceeding the UTF-16 limit. Ordinary argv still uses
the upstream quoting algorithm. Ash selects the representation through the
existing PTY owner; Job attachment and release rules stay in that owner.

Unix implementation and the published manifest remain upstream-owned. Review
Windows lifecycle and sandbox attachment tests when updating this copy.
See [`ash-utils-pty/NOTICE`](../../crates/utils/pty/NOTICE) for integration provenance.
