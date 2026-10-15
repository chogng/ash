import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { documentFromShapes, parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/creator/common/model/document.js';
import { cubicBezierPoint } from '../../contrib/creator/common/core/geometry.js';
import { designPathContours, designShapeContours, moveDesignPathNode, splitDesignPathSegment, type DesignPath } from '../../contrib/creator/common/model/designVector.js';
import { hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';

const rectangle = (): DesignShape => ({ id: generateUuid(), kind: 'rectangle', x: 10, y: 20, width: 200, height: 100, rotation: 0, fill: '#ff0000' });
const path = (): DesignPath => ({ ...rectangle(), kind: 'path', ...designShapeContours(rectangle())[0], strokeWidth: 0 });

test('Vector booleans retain operands, take the correct appearance and round-trip through one undo step', () => {
	for (const operation of ['union', 'subtract', 'intersect', 'exclude'] as const) {
		using model = new DesignModel(); const commands = new DocumentCommands(model);
		const back = rectangle(), front = { ...rectangle(), x: 80, rotation: 30, fill: '#00ff00' };
		model.replace(documentFromShapes([back, front]));
		const id = commands.group(new Set([back.id, front.id]), operation)!;
		const group = model.value.shapes[0]; assert.equal(group.kind, 'group'); if (group.kind !== 'group') { return; }
		assert.equal(group.id, id); assert.equal(group.booleanOperation, operation);
		assert.equal(group.fill, operation === 'subtract' ? back.fill : front.fill);
		assert.deepEqual(group.children.map(child => child.id), [back.id, front.id]);
		commands.updateShape({ ...group.children[1], x: 60 });
		assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
		model.undo(); assert.deepEqual(model.value.shapes[0], group);
		model.undo(); assert.deepEqual(model.value.shapes, [back, front]);
		model.redo(); assert.equal(model.value.shapes[0].id, id);
	}
});

test('Vector split preserves every sample of a cubic including a closed contour last segment', () => {
	for (const closed of [false, true]) {
		const contour = { closed, nodes: [{ x: 0, y: 0, incoming: { x: -.2, y: .5 }, outgoing: { x: .3, y: 1 } }, { x: 1, y: 0, incoming: { x: .7, y: 1 }, outgoing: { x: 1.2, y: .5 } }] };
		const index = closed ? 1 : 0, a = contour.nodes[index], b = contour.nodes[(index + 1) % 2];
		const split = splitDesignPathSegment(contour, index, .35);
		for (let t = 0; t <= 1; t += .05) {
			const expected = cubicBezierPoint(a, a.outgoing, b.incoming, b, t);
			const first = split.nodes[index], middle = split.nodes[index + 1], last = split.nodes[(index + 2) % 3];
			const actual = t <= .35 ? cubicBezierPoint(first, first.outgoing, middle.incoming, middle, t / .35) : cubicBezierPoint(middle, middle.outgoing, last.incoming, last, (t - .35) / .65);
			assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-10);
		}
	}
});

test('Vector anchors carry handles and mirroring preserves lengths in non-square design pixels', () => {
	const node = { x: .5, y: .5, incoming: { x: .4, y: .5 }, outgoing: { x: .7, y: .5 }, mirroring: 'angle' as const };
	assert.deepEqual(moveDesignPathNode(node, 'anchor', { x: 1.5, y: -.5 }, 200, 100), { ...node, x: 1.5, y: -.5, incoming: { x: 1.4, y: -.5 }, outgoing: { x: 1.7, y: -.5 } });
	const moved = moveDesignPathNode(node, 'outgoing', { x: .5, y: 1 }, 200, 100);
	assert.ok(Math.abs(moved.incoming.x - .5) < 1e-10); assert.ok(Math.abs(moved.incoming.y - .3) < 1e-10);
	assert.deepEqual(moveDesignPathNode(node, 'outgoing', { x: .5, y: 1 }, 200, 100, true).incoming, node.incoming);
});

test('Vector conversion, cutting, joining, mirroring and reversing preserve topology and immutable history', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model), source = rectangle(); model.replace(documentFromShapes([source]));
	commands.vector.convert(source); let value = model.value.shapes[0] as DesignPath; assert.equal(value.nodes.length, 4); assert.equal(value.strokeWidth, 0);
	commands.vector.cut(value, 0, 1); value = model.value.shapes[0] as DesignPath; assert.equal(value.closed, false); assert.equal(value.nodes.length, 5);
	commands.vector.cut(value, 0, 2); value = model.value.shapes[0] as DesignPath; assert.deepEqual(designPathContours(value).map(contour => contour.nodes.length), [3, 3]);
	commands.vector.join(value, 0, 1); value = model.value.shapes[0] as DesignPath; assert.equal(value.nodes.length, 5); assert.equal(value.subpaths?.length, 0);
	commands.vector.setMirroring(value, 0, new Set([1]), 'angle-length'); value = model.value.shapes[0] as DesignPath; assert.equal(value.nodes[1].mirroring, 'angle-length');
	commands.vector.reverse(value, 0); const reversed = model.value.shapes[0] as DesignPath;
	assert.deepEqual(reversed.nodes.map(node => node.outgoing), value.nodes.slice().reverse().map(node => node.incoming));
	assert.ok(Object.isFrozen(reversed.nodes)); assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	model.undo(); assert.deepEqual(model.value.shapes[0], value);
});

test('Vector persistence accepts outside handles, multiple contours and zero stroke but rejects corrupt topology', () => {
	const shape = { ...path(), nodes: path().nodes.map(node => ({ ...node, incoming: { x: -2, y: 3 } })), subpaths: designShapeContours({ ...rectangle(), kind: 'ellipse' }), fillRule: 'evenodd' as const, dashArray: [4, 2], stroke: '#11223344' };
	const document = documentFromShapes([shape]); assert.deepEqual(parseDesignDocument(serializeDesignDocument(document)), document);
	for (const changed of [{ dashArray: [-1] }, { fillRule: 'invalid' }, { strokeCap: 'invalid' }, { subpaths: [{ closed: false, nodes: [] }] }, { nodes: shape.nodes.map(node => ({ ...node, mirroring: 'invalid' })) }]) { assert.throws(() => parseDesignDocument(JSON.stringify({ ...document, shapes: [{ ...shape, ...changed }] }))); }
	const frame = { ...rectangle(), kind: 'frame' as const, clip: true, children: [] };
	assert.throws(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([{ ...rectangle(), kind: 'group', children: [rectangle(), frame], contentWidth: 200, contentHeight: 100, booleanOperation: 'union' }]))));
});

test('Compound path hit testing respects holes and open subpaths', () => {
	const outer = path(), inner = designShapeContours(rectangle())[0];
	const hole = { ...inner, nodes: inner.nodes.map(node => ({ x: .25 + node.x / 2, y: .25 + node.y / 2, incoming: { x: .25 + node.incoming.x / 2, y: .25 + node.incoming.y / 2 }, outgoing: { x: .25 + node.outgoing.x / 2, y: .25 + node.outgoing.y / 2 } })).reverse() };
	const shape = { ...outer, subpaths: [hole] };
	assert.equal(hitTestDesignShapes([shape], { x: 30, y: 40 })?.id, shape.id);
	assert.equal(hitTestDesignShapes([shape], { x: 110, y: 70 }), undefined);
});

test('Removing all path points or boolean operands preserves valid groups and undo', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model), first = path(), second = rectangle();
	model.replace(documentFromShapes([first, second]));
	commands.group(new Set([first.id, second.id]), 'subtract');
	commands.vector.removeNodes(first, 0, new Set([0, 1, 2, 3]));
	const group = model.value.shapes[0]; assert.equal(group.kind, 'group');
	if (group.kind === 'group') { assert.equal(group.children.length, 1); }
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	commands.removeShapes(new Set([second.id])); assert.equal(model.value.shapes.length, 0);
	model.undo(); assert.deepEqual(model.value.shapes, [group]);
});


test('Smoothing open endpoints creates a tangent and joining reorients the nearest endpoints', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model);
	const node = (x: number) => ({ x, y: 0, incoming: { x, y: 0 }, outgoing: { x, y: 0 } });
	const shape: DesignPath = { ...path(), closed: false, nodes: [node(0), node(1)], subpaths: [{ closed: false, nodes: [node(2), node(1)] }] };
	model.replace(documentFromShapes([shape])); commands.vector.setMirroring(shape, 0, new Set([0]), 'angle-length');
	const smooth = model.value.shapes[0] as DesignPath; assert.ok(Math.abs(smooth.nodes[0].outgoing.x - 1 / 3) < 1e-10); assert.ok(Math.abs(smooth.nodes[0].incoming.x + 1 / 3) < 1e-10);
	commands.vector.join(smooth, 0, 1); const joined = model.value.shapes[0] as DesignPath;
	assert.deepEqual(joined.nodes.map(node => node.x), [0, 1, 2]); assert.deepEqual(joined.nodes[0].outgoing, smooth.nodes[0].outgoing);
});
