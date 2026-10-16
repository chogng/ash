---
name: heap-snapshot-analysis
description: Analyze existing V8 .heapsnapshot files from Ash Electron or browser runtimes. Compare object counts and self sizes, find retainer paths, and stream large snapshots. Does not measure Rust allocations, GPU memory, or whole-process footprint.
---

# Heap snapshot analysis

Use [auto-perf-optimize](../auto-perf-optimize/SKILL.md) when snapshots still need to be captured. This skill analyzes existing files; keep investigation scripts and outputs under an ignored `.build/` directory. Reuse current-session evidence that still describes the same source and workload, and verify older hypotheses against the current snapshots.

The helpers are adapted from VS Code's [heap-snapshot-analysis](https://github.com/microsoft/vscode/tree/9ec085756845ef1e24e5623fc05bf6cf70ed4956/.github/skills/heap-snapshot-analysis). Their Microsoft copyright notices and [MIT license](LICENSE.txt) are retained.

## Choose the smallest analysis

Check input size before reading it. For counts, sizes, or a large snapshot, start with [streamSnapshot.mjs](helpers/streamSnapshot.mjs). It reads numeric arrays in chunks without expanding every node and edge into objects. Resolve only the string indexes needed for the question when the string table is large. `parseStrings` has a byte limit; that limit bounds the input section, not the memory used by decoded strings.

For a modest snapshot and sufficient available memory, [parseSnapshot.ts](helpers/parseSnapshot.ts) extracts arrays from a Buffer. It still reads the entire file and creates large intermediate arrays. `buildGraph` adds forward and reverse adjacency objects and can consume much more memory than the file. Build that graph only when a retainer question requires it. Do not respond to an allocation failure by automatically increasing Node's heap to many gigabytes; switch to streaming or a narrower analysis.

From the repository root, a streaming count looks like this:

```javascript
import { findArrayStart, findTokenOffsets, parseMeta, streamNumberTuples } from './.agents/skills/heap-snapshot-analysis/helpers/streamSnapshot.mjs';

const snapshotPath = process.argv[2];
const { size, offsets } = findTokenOffsets(snapshotPath, ['"nodes"', '"edges"', '"strings"']);
const meta = parseMeta(snapshotPath);
if (offsets.get('"nodes"') === undefined || offsets.get('"edges"') === undefined) throw new Error('Missing snapshot arrays');
const start = findArrayStart(snapshotPath, offsets.get('"nodes"'));
const sizeField = meta.node_fields.indexOf('self_size');
if (sizeField < 0) throw new Error('Missing self_size field');
let selfBytes = 0;
const { tupleCount } = streamNumberTuples(snapshotPath, start, offsets.get('"edges"'), meta.node_fields.length, node => {
    selfBytes += node[sizeField];
}, { chunkSize: 1024 * 1024 });
console.log({ fileBytes: size, nodes: tupleCount, selfBytes });
```

`streamNumberTuples` reuses its tuple buffer. Copy a tuple before retaining it, or pass `copyTuple: true`. Read field positions and enum tables from `snapshot.meta`; V8 versions can use different tuple widths.

## Compare snapshots

For files small enough for the Buffer parser:

```bash
node --input-type=module - before.heapsnapshot after.heapsnapshot <<'JS'
import { compareSnapshots, printComparison } from './.agents/skills/heap-snapshot-analysis/helpers/compareSnapshots.ts';
printComparison(compareSnapshots(process.argv[2], process.argv[3]));
JS
```

The summary reports node-count and self-size deltas. The tables emphasize growing groups; they are not a complete list of reductions. `newObjectGroups` groups new node IDs and is meaningful only for captures from the same V8 isolate. Across restarts or separate builds, compare aggregate groups instead of treating matching IDs as surviving objects. Minified constructor names can also change across builds; corroborate them with fields and source ownership.

Do not add self sizes of overlapping reachable subgraphs and label the sum retained size. Shared services, caches, and GC roots make that attribution unreliable. Report direct owned fields as a lower bound, or use a dominator analysis when an exact retained-size claim is needed.

## Trace a suspected owner

Use `buildGraph` with [findRetainers.ts](helpers/findRetainers.ts) to find named instances, direct incoming references, or bounded paths toward roots:

```typescript
import { parseSnapshot, buildGraph } from './.agents/skills/heap-snapshot-analysis/helpers/parseSnapshot.ts';
import { findRetainerPaths } from './.agents/skills/heap-snapshot-analysis/helpers/findRetainers.ts';

const graph = buildGraph(parseSnapshot(process.argv[2]));
findRetainerPaths(graph, process.argv[3], { maxPaths: 3, maxDepth: 25, maxAttempts: 50 });
```

The reverse graph excludes weak edges and V8's conditional `part of key` WeakMap bookkeeping. This is a diagnostic approximation, not a full GC liveness model. A bounded search finding no path does not establish that an object is collectible. Check DevTools global handles and inspector-held objects before attributing retention to the application.

Connect a path to an actual Ash owner and its release event. For a disposed editor or Chat row, follow listeners, stores, pools, closures, model references, and pending operations through their complete lifecycle. Fix the missing release at its owner; clearing arbitrary fields can break deferred rendering or asynchronous completion.

After a product fix, return to the capture workflow and compare the same settled states. Report the snapshots, process/isolate identity, workload, counts, byte units, path, and uncertainty. A smaller V8 heap alone does not establish a smaller application footprint.
