import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { documentFromShapes, parseDesignDocument, serializeDesignDocument } from '../../contrib/creator/common/model/document.js';
import { designPathContours, type DesignPath } from '../../contrib/creator/common/model/designVector.js';
import { connectDesignNetwork, designNetworkRegions, moveDesignNetworkVertices, paintDesignNetworkFromPath, splitDesignNetworkEdge, toDesignVectorNetwork, withDesignVectorNetwork } from '../../contrib/creator/common/model/designVectorNetwork.js';
import { cubicBezierPoint } from '../../contrib/creator/common/core/geometry.js';
import { hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';
import { intersectDesignNetwork, mergeDesignNetworkVertices, simplifyDesignNetwork } from '../../contrib/creator/common/model/designVectorTopology.js';
import type { DesignVectorNetwork } from '../../contrib/creator/common/model/designVectorNetwork.js';

const square = (): DesignPath => ({ id: generateUuid(), kind: 'path', x: 0, y: 0, width: 200, height: 100, rotation: 0, fill: '#ff0000', strokeWidth: 2, closed: true, nodes: [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({ x, y, incoming: { x, y }, outgoing: { x, y } })) });
const lines = (points: readonly (readonly [number, number])[], edges: readonly (readonly [number, number])[]): DesignVectorNetwork => ({ vertices: points.map(([x, y]) => ({ x, y })), edges: edges.map(([start, end]) => ({ id: generateUuid(), start, end, outgoing: { x: points[start][0], y: points[start][1] }, incoming: { x: points[end][0], y: points[end][1] } })) });

test('Crossings become one shared junction independent of intersection order, with exact cubic pieces', () => {
	const network = lines([[0, 0], [1, 1], [0, 1], [1, 0], [.5, -1], [.5, 2]], [[0, 1], [2, 3], [4, 5]]);
	const hits = [{ first: { edge: 0, time: .5 }, second: { edge: 1, time: .5 } }, { first: { edge: 2, time: .5 }, second: { edge: 0, time: .5 } }];
	const result = intersectDesignNetwork(network, hits).network;
	assert.equal(result.vertices.length, 7); assert.equal(result.edges.length, 6);
	assert.equal(result.edges.filter(edge => edge.start === 6 || edge.end === 6).length, 6);
	assert.deepEqual(result.vertices[6], { x: .5, y: .5 });
	assert.deepEqual(intersectDesignNetwork(network, hits.slice().reverse()).network.vertices, result.vertices);
	for (let index = 0; index < 3; index++) {
		const edge = network.edges[index], [left, right] = result.edges.slice(index * 2, index * 2 + 2);
		for (let i = 0; i <= 20; i++) {
			const t = i / 20, part = t <= .5 ? left : right, u = t <= .5 ? t * 2 : (t - .5) * 2;
			const expected = cubicBezierPoint(network.vertices[edge.start], edge.outgoing, edge.incoming, network.vertices[edge.end], t), actual = cubicBezierPoint(result.vertices[part.start], part.outgoing, part.incoming, result.vertices[part.end], u);
			assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-10);
		}
	}
	const moved = moveDesignNetworkVertices(result, new Set([6]), .1, .2);
	assert.equal(moved.edges.filter((edge, i) => edge.outgoing.x !== result.edges[i].outgoing.x || edge.incoming.x !== result.edges[i].incoming.x).length, 6);
});

test('Endpoint intersections reuse anchors, multiple cuts stay exact and subdivision retains region paint', () => {
	const network = lines([[0, .5], [1, .5], [.25, 0], [.25, 1], [.75, 0], [.75, 1]], [[0, 1], [2, 3], [4, 5]]);
	const curve = { ...network, edges: network.edges.map((edge, i) => i ? edge : { ...edge, outgoing: { x: 1 / 3, y: .5 }, incoming: { x: 2 / 3, y: .5 } }) };
	const result = intersectDesignNetwork(curve, [{ first: { edge: 0, time: .75 }, second: { edge: 2, time: .5 } }, { first: { edge: 0, time: .25 }, second: { edge: 1, time: .5 } }]).network;
	assert.equal(result.edges.length, 7); assert.equal(result.vertices.length, 8);
	const base = connectDesignNetwork(toDesignVectorNetwork(square()), 0, 2), region = designNetworkRegions(base)[0];
	const painted = { ...base, regionFills: { [region.key]: '#0088ff' }, unfilledRegions: [region.key] };
	const crossed = connectDesignNetwork(painted, 1, 3);
	const subdivided = intersectDesignNetwork(crossed, [{ first: { edge: 4, time: .5 }, second: { edge: 5, time: .5 } }], painted).network;
	assert.equal(designNetworkRegions(subdivided).length, 4);
	assert.equal(designNetworkRegions(subdivided).filter(region => !region.filled).length, 2); assert.deepEqual(Object.values(subdivided.regionFills!), ['#0088ff', '#0088ff']);
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([withDesignVectorNetwork(square(), subdivided)]))));
	const tee = lines([[0, 0], [1, 0], [.5, 0], [.5, 1]], [[0, 1], [2, 3]]);
	const joined = intersectDesignNetwork(tee, [{ first: { edge: 0, time: .5 }, second: { edge: 1, time: 0 } }]).network;
	assert.equal(joined.vertices.length, 4); assert.equal(joined.edges.filter(edge => edge.start === 2 || edge.end === 2).length, 3);
});

test('Merging moves incident handles, removes collapsed straight segments and retains a curved loop', () => {
	const network = lines([[0, 0], [1, 0], [1, 1], [2, 1]], [[0, 1], [2, 3]]);
	const result = mergeDesignNetworkVertices(network, new Set([1, 2]));
	assert.deepEqual(result.network.vertices, [{ x: 0, y: 0 }, { x: 1, y: .5 }, { x: 2, y: 1 }]);
	assert.deepEqual(result.network.edges[0].incoming, { x: 1, y: .5 }); assert.deepEqual(result.network.edges[1].outgoing, { x: 1, y: .5 });
	const curved = { ...lines([[0, 0], [1, 0]], [[0, 1]]), edges: [{ id: generateUuid(), start: 0, end: 1, outgoing: { x: 0, y: -1 }, incoming: { x: 1, y: 1 } }] };
	const loop = mergeDesignNetworkVertices(curved, new Set([0, 1])).network;
	assert.equal(loop.edges.length, 2); assert.ok(loop.edges.every(edge => edge.start !== edge.end));
	assert.equal(mergeDesignNetworkVertices(lines([[0, 0], [1, 0]], [[0, 1]]), new Set([0, 1])).network.edges.length, 0);
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([withDesignVectorNetwork(square(), loop)]))));
});

test('Partially overlapping segments share their overlap exactly once despite different cubic parameter speeds', () => {
	const network = lines([[0, 0], [1, 0], [.5, 0], [1.5, 0]], [[0, 1], [2, 3]]);
	const result = intersectDesignNetwork(network, [{ first: { edge: 0, time: .5 }, second: { edge: 1, time: 0 } }, { first: { edge: 0, time: 1 }, second: { edge: 1, time: .5 } }]).network;
	assert.equal(result.vertices.length, 4); assert.equal(result.edges.length, 3);
	assert.equal(result.edges.filter(edge => Math.min(result.vertices[edge.start].x, result.vertices[edge.end].x) === .5 && Math.max(result.vertices[edge.start].x, result.vertices[edge.end].x) === 1).length, 1);
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([withDesignVectorNetwork(square(), result)]))));
});

test('Simplification removes redundant anchors but protects junctions, endpoints, corners and painted holes', () => {
	const network = lines([[0, 0], [.2, 0], [.4, 0], [.6, 0], [1, 0], [.4, .5]], [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]]);
	assert.equal(simplifyDesignNetwork(network, 100, 100, 0).network, network);
	const result = simplifyDesignNetwork(network, 100, 100, .5);
	assert.deepEqual(result.network.vertices, [network.vertices[0], network.vertices[2], network.vertices[4], network.vertices[5]]);
	assert.equal(result.network.edges.length, 3); assert.equal(result.network.edges.filter(edge => edge.start === 1 || edge.end === 1).length, 3);
	const base = toDesignVectorNetwork(square()), key = designNetworkRegions(base)[0].key;
	const split = splitDesignNetworkEdge({ ...base, regionFills: { [key]: '#0022ff' }, unfilledRegions: [key] }, 0, .3);
	const simplified = simplifyDesignNetwork(split, 200, 100, .5).network;
	assert.equal(simplified.vertices.length, 4); assert.equal(designNetworkRegions(simplified).length, 1); assert.equal(designNetworkRegions(simplified)[0].filled, false); assert.deepEqual(Object.values(simplified.regionFills!), ['#0022ff']);
});

test('Delete and heal only removes selected degree-two anchors and all edits undo as one document operation', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model);
	const network = lines([[0, 0], [.25, .15], [.5, 0], [.75, .15], [1, 0]], [[0, 1], [1, 2], [2, 3], [3, 4]]), path = withDesignVectorNetwork(square(), network);
	model.replace(documentFromShapes([path])); commands.vector.healNodes(path, 0, new Set([1]));
	const healed = model.value.shapes[0] as DesignPath; assert.equal(healed.network!.vertices.length, 4); assert.deepEqual(healed.network!.vertices, network.vertices.filter((_, i) => i !== 1));
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value); model.undo(); assert.deepEqual(model.value.shapes[0], path);
	commands.vector.mergeNodes(path, 0, new Set([1, 2])); assert.equal((model.value.shapes[0] as DesignPath).network!.vertices.length, 4); model.undo(); assert.deepEqual(model.value.shapes[0], path);
});

test('Simplification reunites subdivided cubic curves without flattening their handles or moving endpoints', () => {
	const original = { ...lines([[0, 0], [1, .4]], [[0, 1]]), edges: [{ id: generateUuid(), start: 0, end: 1, outgoing: { x: .2, y: -.6 }, incoming: { x: .8, y: 1 } }] };
	let split = splitDesignNetworkEdge(original, 0, .3); split = splitDesignNetworkEdge(split, 1, .6); split = splitDesignNetworkEdge(split, 0, .4);
	const simplified = simplifyDesignNetwork(split, 400, 150, .2).network;
	assert.equal(simplified.vertices.length, 2); assert.equal(simplified.edges.length, 1);
	const a = original.edges[0], b = simplified.edges[0];
	for (let i = 0; i <= 100; i++) {
		const expected = cubicBezierPoint(original.vertices[a.start], a.outgoing, a.incoming, original.vertices[a.end], i / 100), actual = cubicBezierPoint(simplified.vertices[b.start], b.outgoing, b.incoming, simplified.vertices[b.end], i / 100);
		assert.ok(Math.hypot((actual.x - expected.x) * 400, (actual.y - expected.y) * 150) < 1e-5);
	}
});

test('Adding shared intersections preserves even-odd holes and nonzero fills of overlapping contours', () => {
	const source = square(), offset = (point: { x: number; y: number; }) => ({ x: point.x + .5, y: point.y + .5 });
	const path: DesignPath = { ...source, strokeWidth: 0, fillRule: 'evenodd', subpaths: [{ closed: true, nodes: source.nodes.map(node => ({ ...offset(node), incoming: offset(node.incoming), outgoing: offset(node.outgoing) })) }] };
	const network = toDesignVectorNetwork(path), divided = intersectDesignNetwork(network, [{ first: { edge: 1, time: .5 }, second: { edge: 4, time: .5 } }, { first: { edge: 2, time: .5 }, second: { edge: 7, time: .5 } }]).network;
	const evenodd = paintDesignNetworkFromPath(path, divided); assert.equal(designNetworkRegions(evenodd).length, 3); assert.equal(designNetworkRegions(evenodd).filter(region => !region.filled).length, 1);
	assert.equal(hitTestDesignShapes([withDesignVectorNetwork(path, evenodd)], { x: 150, y: 75 }), undefined);
	const nonzero = paintDesignNetworkFromPath({ ...path, fillRule: 'nonzero' }, evenodd); assert.equal(nonzero.unfilledRegions, undefined); assert.equal(hitTestDesignShapes([withDesignVectorNetwork(path, nonzero)], { x: 150, y: 75 })?.id, path.id);
});

test('A network junction owns one anchor and moving it carries all incident handles', () => {
	let network = connectDesignNetwork(toDesignVectorNetwork(square()), 0, { x: -.5, y: -.5 });
	assert.equal(network.vertices.length, 5); assert.equal(network.edges.length, 5);
	const before = network;
	network = moveDesignNetworkVertices(network, new Set([0]), .1, .2);
	assert.deepEqual(network.vertices[0], { x: .1, y: .2 });
	assert.deepEqual(network.edges[0].outgoing, network.vertices[0]);
	assert.deepEqual(network.edges[3].incoming, network.vertices[0]);
	assert.deepEqual(network.edges[4].outgoing, network.vertices[0]);
	assert.deepEqual(network.vertices[4], before.vertices[4]);
	assert.deepEqual(before.vertices[0], { x: 0, y: 0 });
});

test('Network faces exclude the exterior and bridges, split at chords, and retain fill removal when an edge splits', () => {
	let network = connectDesignNetwork(toDesignVectorNetwork(square()), 0, { x: -.5, y: -.5 });
	assert.equal(designNetworkRegions(network).length, 1);
	network = connectDesignNetwork(network, 0, 2);
	let regions = designNetworkRegions(network); assert.equal(regions.length, 2);
	network = { ...network, unfilledRegions: [regions[0].key] };
	const edge = network.edges.findIndex(edge => regions[0].key.split(',').includes(edge.id));
	network = splitDesignNetworkEdge(network, edge, .4);
	regions = designNetworkRegions(network); assert.equal(regions.length, 2); assert.equal(regions.filter(region => !region.filled).length, 1);
});

test('Splitting a network curve keeps its exact cubic and connectivity', () => {
	const base = toDesignVectorNetwork(square());
	const network = { ...base, edges: base.edges.map((edge, i) => i ? edge : { ...edge, outgoing: { x: .2, y: -.7 }, incoming: { x: .8, y: .4 } }) };
	const split = splitDesignNetworkEdge(network, 0, .3), edge = network.edges[0], a = network.vertices[edge.start], b = network.vertices[edge.end];
	const left = split.edges[0], right = split.edges.at(-1)!, middle = split.vertices.at(-1)!;
	assert.equal(left.end, right.start);
	for (let i = 0; i <= 20; i++) {
		const t = i / 20, expected = cubicBezierPoint(a, edge.outgoing, edge.incoming, b, t);
		const actual = t <= .3 ? cubicBezierPoint(a, left.outgoing, left.incoming, middle, t / .3) : cubicBezierPoint(middle, right.outgoing, right.incoming, b, (t - .3) / .7);
		assert.ok(Math.hypot(expected.x - actual.x, expected.y - actual.y) < 1e-10);
	}
});

test('Network document round-trip, deletion, cut and undo preserve topology and reject conflicting geometry', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model);
	const path = withDesignVectorNetwork(square(), connectDesignNetwork(toDesignVectorNetwork(square()), 0, { x: -.5, y: -.5 }));
	model.replace(documentFromShapes([path]));
	const serialized = serializeDesignDocument(model.value), raw = JSON.parse(serialized);
	const object = Object.values(raw.artifacts)[0] as { objects: Record<string, unknown>; };
	assert.ok(!Object.hasOwn(object.objects[path.id] as object, 'nodes'));
	assert.deepEqual(parseDesignDocument(serialized), model.value);
	commands.vector.cut(path, 0, 0);
	const cut = model.value.shapes[0] as DesignPath;
	assert.equal(cut.network!.vertices.length, 7); assert.equal(designNetworkRegions(cut.network!).length, 0);
	model.undo(); assert.deepEqual(model.value.shapes[0], path);
	commands.vector.removeNodes(path, 0, new Set([0]));
	const removed = model.value.shapes[0] as DesignPath;
	assert.equal(removed.network!.edges.length, 2); assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(model.value)));
	model.undo(); assert.deepEqual(model.value.shapes[0], path);
	const invalid = JSON.parse(serialized); invalid.artifacts[model.value.artifactId].objects[path.id].nodes = square().nodes;
	assert.throws(() => parseDesignDocument(JSON.stringify(invalid)), /network/iu);
	const bad = JSON.parse(serialized); bad.artifacts[model.value.artifactId].objects[path.id].network.edges[0].end = 999;
	assert.throws(() => parseDesignDocument(JSON.stringify(bad)), /network/iu);
});

test('Network hit testing covers filled faces and strokes without filling an open branch', () => {
	const source = square(), network = connectDesignNetwork(toDesignVectorNetwork(source), 0, { x: -.5, y: -.5 });
	const path = withDesignVectorNetwork(source, network);
	assert.equal(designPathContours(path).length, 5);
	assert.equal(hitTestDesignShapes([path], { x: 100, y: 50 })?.id, path.id);
	const empty = withDesignVectorNetwork(path, { ...network, unfilledRegions: designNetworkRegions(network).map(region => region.key) });
	assert.equal(hitTestDesignShapes([empty], { x: 100, y: 50 }), undefined);
});

test('Network conversion preserves compound holes and region paint through subdivisions', () => {
	const outer = square(), inner = { closed: true, nodes: outer.nodes.slice().reverse().map(node => { const x = .25 + node.x / 2, y = .25 + node.y / 2; return { x, y, incoming: { x, y }, outgoing: { x, y } }; }) };
	const path = { ...outer, subpaths: [inner] }, network = toDesignVectorNetwork(path);
	assert.equal(designNetworkRegions(network).filter(region => region.filled).length, 1);
	const converted = withDesignVectorNetwork(path, network);
	assert.equal(hitTestDesignShapes([converted], { x: 100, y: 50 }), undefined);
	assert.equal(hitTestDesignShapes([converted], { x: 20, y: 20 })?.id, path.id);
	const base = toDesignVectorNetwork(square()), key = designNetworkRegions(base)[0].key;
	const divided = connectDesignNetwork({ ...base, unfilledRegions: [key], regionFills: { [key]: '#0088ff' } }, 0, 2);
	assert.equal(designNetworkRegions(divided).filter(region => region.filled).length, 0);
	assert.deepEqual(Object.values(divided.regionFills!), ['#0088ff', '#0088ff']);
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([withDesignVectorNetwork(square(), divided)]))));
});

test('Network mirroring survives conversion and all handles remain serializable', async () => {
	const { moveDesignNetworkHandle } = await import('../../contrib/creator/common/model/designVectorNetwork.js');
	using model = new DesignModel(); const commands = new DocumentCommands(model), source = square();
	let path = withDesignVectorNetwork(source, toDesignVectorNetwork(source)); model.replace(documentFromShapes([path]));
	commands.vector.setMirroring(path, 0, new Set([0]), 'angle-length'); path = model.value.shapes[0] as DesignPath;
	let network = moveDesignNetworkHandle(path.network!, 0, 'outgoing', { x: .3, y: .2 }, path.width, path.height);
	assert.deepEqual(network.edges[3].incoming, { x: -.3, y: -.2 });
	network = moveDesignNetworkHandle(network, 0, 'outgoing', { x: .7, y: .2 }, path.width, path.height, true);
	assert.deepEqual(network.edges[3].incoming, { x: -.3, y: -.2 });
	assert.equal(network.vertices[0].mirroring, 'none');
	commands.vector.update(withDesignVectorNetwork(path, network));
	commands.vector.corner(model.value.shapes[0] as DesignPath, 0, new Set([0]));
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(model.value)));
});

test('Network topology supports parallel curved edges and keeps compound contour colors', () => {
	const source = square();
	const open: DesignPath = { ...source, closed: false, nodes: [{ x: 0, y: 0, incoming: { x: 0, y: 0 }, outgoing: { x: .3, y: -.3 } }, { x: 1, y: 0, incoming: { x: .7, y: -.3 }, outgoing: { x: 1, y: 0 } }] };
	const closed = connectDesignNetwork(toDesignVectorNetwork(open), 1, 0);
	assert.equal(closed.edges.length, 2); assert.equal(designNetworkRegions(closed).length, 1);
	const second = { closed: true, fill: '#0022cc', nodes: source.nodes.map(node => ({ x: node.x + 2, y: node.y, incoming: { x: node.incoming.x + 2, y: node.incoming.y }, outgoing: { x: node.outgoing.x + 2, y: node.outgoing.y } })) };
	const network = toDesignVectorNetwork({ ...source, subpaths: [second] });
	assert.equal(designNetworkRegions(network).length, 2); assert.deepEqual(Object.values(network.regionFills!), ['#0022cc']);
	assert.doesNotThrow(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([withDesignVectorNetwork(source, network)]))));
});
