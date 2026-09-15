# ASCII bigram frequency order v1

`ascii-bigram-frequency-order-v1.bin` is the canonical v1 frequency table. Its 26,500 unique little-endian `u16` values are byte-pair IDs ordered from most common to least common; its reviewed SHA-256 is `97c07c74fb0947242a253597db342e1e3e0734dc3a7dde351a0a56fb53686919`.

The legacy comparison module `benches/algorithms/ngram.rs` expands the ordered IDs into one rank for every possible byte pair at compile time. Learned ranks apply only when both bytes are ASCII; other byte pairs use their deterministic pair ID as the weight. The table is retained for reproducible sparse n-gram comparisons. Production v8 indexes use trigrams and do not read this table.

Each later table is a new versioned file. Updating the benchmark version requires changing the `include_bytes!` path, reviewed digest test, this document, and performance benchmark results in the same change.
