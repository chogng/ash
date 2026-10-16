import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildGraph, collectNodeIds, parseSnapshot } from './parseSnapshot.ts';
import { compareSnapshots } from './compareSnapshots.ts';
import { findDirectRetainers, findNodeById, findNodesByName, findRetainerPaths } from './findRetainers.ts';
import { findArrayStart, findTokenOffsets, parseMeta, parseStrings, streamNumberArray, streamNumberTuples } from './streamSnapshot.mjs';

const meta = {
	node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
	node_types: [['synthetic', 'object']],
	edge_fields: ['type', 'name_or_index', 'to_node'],
	edge_types: [['property', 'weak', 'internal']],
};

function snapshot(ownerSize = 64) {
	return {
		snapshot: { meta, node_count: 4, edge_count: 3 },
		nodes: [0, 0, 1, 0, 3, 1, 1, 3, ownerSize, 0, 1, 2, 5, 32, 0, 1, 3, 7, 48, 0],
		edges: [0, 4, 5, 1, 5, 10, 2, 6, 15],
		strings: ['(GC roots)', 'Owner', 'WeakOnly', 'ConditionalOnly', 'owned', 'weak', '1 / part of key (Object @1) -> value (Object @7) pair in WeakMap', 'escaped "] \\ 🧠\n'],
	};
}

function fixture(context, contents = snapshot()) {
	const directory = mkdtempSync(join(tmpdir(), 'ash-heap-analysis-'));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, 'heap.heapsnapshot');
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

test('Buffer and streaming parsers agree across one-byte chunks and escaped strings', context => {
	const expected = snapshot();
	const path = fixture(context, expected);
	const parsed = parseSnapshot(path);
	assert.deepEqual(parsed, { meta, nodes: expected.nodes, edges: expected.edges, strings: expected.strings });
	assert.deepEqual(parseMeta(path), meta);
	const { size, offsets } = findTokenOffsets(path, ['"nodes"', '"edges"', '"strings"'], { chunkSize: 3, overlap: 16 });
	const tuples = [];
	const counts = streamNumberTuples(path, findArrayStart(path, offsets.get('"nodes"')), offsets.get('"edges"'), meta.node_fields.length, tuple => tuples.push(tuple.slice()), { chunkSize: 1 });
	assert.deepEqual(counts, { numberCount: expected.nodes.length, tupleCount: 4 });
	assert.deepEqual(tuples.flat(), expected.nodes);
	const edges = [];
	streamNumberArray(path, findArrayStart(path, offsets.get('"edges"')), offsets.get('"strings"'), number => edges.push(number), { chunkSize: 1 });
	assert.deepEqual(edges, expected.edges);
	assert.deepEqual(parseStrings(path, offsets.get('"strings"'), { fileSize: size }), expected.strings);
	assert.throws(() => parseStrings(path, offsets.get('"strings"'), { maxBytes: 1 }), /Refusing to parse/);
});

test('a short string table near EOF remains parseable', context => {
	const expected = { snapshot: { meta, node_count: 1, edge_count: 1 }, nodes: [0, 0, 1, 0, 1], edges: [0, 0, 0], strings: [''] };
	assert.deepEqual(parseSnapshot(fixture(context, expected)).strings, ['']);
});

test('strong ownership is traceable without treating weak and conditional edges as roots', context => {
	const parsed = parseSnapshot(fixture(context));
	const graph = buildGraph(parsed);
	assert.deepEqual([...collectNodeIds(parsed)], [1, 3, 5, 7]);
	assert.equal(findNodeById(graph, 3, 'Owner'), 1);
	assert.equal(findNodesByName(graph, 'Owner').length, 1);
	assert.deepEqual(findDirectRetainers(graph, 1).map(entry => ({ name: entry.node.name, edge: entry.edgeName })), [{ name: '(GC roots)', edge: 'owned' }]);
	assert.deepEqual(findDirectRetainers(graph, 2), []);
	assert.deepEqual(findDirectRetainers(graph, 3), []);
	assert.equal(findRetainerPaths(graph, 'Owner', { maxPaths: 1 }), 1);
	assert.equal(findRetainerPaths(graph, 'WeakOnly'), 0);
	assert.equal(findRetainerPaths(graph, 'ConditionalOnly'), 0);
});

test('comparison reports constructor growth and total self-size reductions', context => {
	const before = fixture(context, snapshot(64));
	const after = fixture(context, snapshot(128));
	const comparison = compareSnapshots(before, after);
	assert.deepEqual(comparison.summary, { beforeNodes: 4, afterNodes: 4, beforeSize: 144, afterSize: 208, nodeDelta: 0, sizeDelta: 64 });
	assert.equal(comparison.topBySize[0].name, 'Owner');
	assert.equal(comparison.topBySize[0].sizeDiff, 64);
	assert.deepEqual(comparison.newObjectGroups, []);
	assert.equal(compareSnapshots(after, before).summary.sizeDelta, -64);
});

test('streaming rejects incomplete tuples instead of reporting a complete sample', context => {
	const path = fixture(context);
	writeFileSync(path, '[1,23,456]');
	assert.throws(() => streamNumberTuples(path, 1, 10, 2, () => { }, { chunkSize: 1 }), /incomplete tuple/);
});
