import { designEndpointContours, designPathEndpoints, designStrokeLayers } from '../../contrib/creator/common/model/designVectorStroke.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { documentFromShapes, parseDesignDocument, serializeDesignDocument } from '../../contrib/creator/common/model/document.js';
import { designPathFillContours, designPathStrokeContours, designShapeContours, fitDesignPathBounds, type DesignPath } from '../../contrib/creator/common/model/designVector.js';
import { connectDesignNetwork, toDesignVectorNetwork, withDesignVectorNetwork } from '../../contrib/creator/common/model/designVectorNetwork.js';
import {
	designVariableStrokeContours,
	designWidthAt,
	designWidthPointAt,
	designWidthLocation,
	nearestDesignWidthLocation,
	supportsDesignVariableWidth,
} from '../../contrib/creator/common/model/designVariableWidth.js';
import { hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';

const rectangle = () => ({
	id: generateUuid(),
	kind: 'rectangle' as const,
	x: 0,
	y: 0,
	width: 200,
	height: 100,
	rotation: 0,
	fill: '#3366ff',
});
const box = (radius = 20): DesignPath => ({
	...rectangle(),
	kind: 'path',
	nodes: designShapeContours(rectangle())[0].nodes.map(node => ({ ...node, cornerRadius: radius })),
	closed: true,
	strokeWidth: 0,
});
const line = (): DesignPath => ({
	...box(0),
	closed: false,
	strokeWidth: 10,
	nodes: box(0).nodes.slice(0, 2),
	widthPoints: [
		{ id: generateUuid(), contour: 0, position: 0, width: 0 },
		{ id: generateUuid(), contour: 0, position: 0.5, width: 4 },
		{ id: generateUuid(), contour: 0, position: 1, width: 0 },
	],
});

test('Node radii keep editable anchors and round in pixels with tangent cubic arcs', () => {
	const path = box(),
		nodes = designPathStrokeContours(path)[0].nodes;
	assert.equal(nodes.length, 8);
	assert.equal(path.nodes.length, 4);
	assert.equal(path.nodes[0].cornerRadius, 20);
	assert.ok(Math.abs(nodes[0].y * path.height - 20) < 1e-8);
	assert.ok(Math.abs(nodes[1].x * path.width - 20) < 1e-8);
	assert.ok(Math.abs((nodes[1].x - nodes[1].incoming.x) * path.width - 20 * 0.5522847498307936) < 1e-8);
	assert.equal(hitTestDesignShapes([path], { x: 1, y: 1 }), undefined);
	assert.equal(hitTestDesignShapes([path], { x: 20, y: 20 })?.id, path.id);
	assert.equal(designPathFillContours(withDesignVectorNetwork(path, toDesignVectorNetwork(path)))[0].nodes.length, 8);
});

test('Oversized adjacent radii share edge space, while endpoints and existing curves retain their geometry', () => {
	const path = box(1000),
		nodes = designPathStrokeContours(path)[0].nodes;
	assert.ok(nodes.every(node => node.x >= -1e-8 && node.x <= 1 + 1e-8 && node.y >= -1e-8 && node.y <= 1 + 1e-8));
	assert.ok(Math.abs(nodes[0].y - 0.5) < 1e-8);
	assert.equal(path.nodes[0].cornerRadius, 1000);
	const open = { ...path, closed: false, nodes: path.nodes.slice(0, 2) };
	assert.deepEqual(designPathStrokeContours(open)[0].nodes, open.nodes);
	const ellipse = {
		...path,
		nodes: designShapeContours({ ...rectangle(), kind: 'ellipse' })[0].nodes.map(node => ({
			...node,
			cornerRadius: 10,
		})),
	};
	assert.deepEqual(designPathStrokeContours(ellipse)[0].nodes, ellipse.nodes);
});

test('Corner radii and width points round-trip with immutable atomic history and strict persistence validation', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		source = line();
	model.replace(documentFromShapes([source]));
	commands.vector.update({ ...source, nodes: source.nodes.map(node => ({ ...node, cornerRadius: 12 })) });
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	const path = model.value.shapes[0] as DesignPath;
	assert.ok(Object.isFrozen(path.widthPoints));
	assert.ok(Object.isFrozen(path.widthPoints![0]));
	model.undo();
	assert.deepEqual(model.value.shapes[0], source);
	model.redo();
	assert.deepEqual(model.value.shapes[0], path);
	for (const change of [
		{ nodes: [{ ...source.nodes[0], cornerRadius: -1 }, source.nodes[1]] },
		{ widthPoints: [{ ...source.widthPoints![0], position: 2 }] },
		{ widthPoints: [{ ...source.widthPoints![0], width: -1 }] },
		{ widthPoints: [source.widthPoints![0], source.widthPoints![0]] },
	]) {
		assert.throws(() => parseDesignDocument(JSON.stringify({ ...model.value, shapes: [{ ...source, ...change }] })));
	}
	const network = withDesignVectorNetwork(path, toDesignVectorNetwork(path));
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(documentFromShapes([network]))).shapes[0], network);
	assert.throws(() =>
		parseDesignDocument(
			JSON.stringify({
				...model.value,
				shapes: [
					{
						...network,
						network: {
							...network.network,
							vertices: network.network!.vertices.map(vertex => ({ ...vertex, cornerRadius: -3 })),
						},
					},
				],
			}),
		),
	);
});

test('Variable width follows physical arc length, smooth interpolation, hit testing and stroke weight', () => {
	const path = line(),
		location = designWidthLocation(path, 0, 0.25)!;
	assert.deepEqual(location.point, { x: 50, y: 0 });
	assert.equal(location.length, 200);
	assert.deepEqual(nearestDesignWidthLocation(path, { x: 75, y: 20 }), { contour: 0, position: 0.375 });
	assert.equal(designWidthAt(path, 0, 0), 0);
	assert.equal(designWidthAt(path, 0, 0.5), 40);
	assert.equal(designWidthAt(path, 0, 0.25), 20);
	assert.equal(designWidthAt({ ...path, strokeWidth: 20 }, 0, 0.5), 80);
	assert.equal(designVariableStrokeContours(path).length, 1);
	assert.equal(hitTestDesignShapes([path], { x: 100, y: 18 })?.id, path.id);
	assert.equal(hitTestDesignShapes([path], { x: 100, y: 25 }), undefined);
	assert.equal(hitTestDesignShapes([path], { x: 10, y: 15 }), undefined);
});

test('Width points measure curved arc length and closed profiles have a continuous seam', () => {
	const path = line(),
		curved = {
			...path,
			nodes: [
				{ ...path.nodes[0], outgoing: { x: 0, y: 1 } },
				{ ...path.nodes[1], incoming: { x: 1, y: 1 } },
			],
		};
	const location = designWidthLocation(curved, 0, 0.5)!;
	assert.ok(Math.abs(location.point.x - 100) < 0.01);
	assert.ok(Math.abs(location.point.y - 75) < 0.01);
	assert.ok(location.length > 260 && location.length < 290);
	const closed = {
		...box(),
		strokeWidth: 10,
		widthPoints: [
			{ id: generateUuid(), contour: 0, position: 0.25, width: 1 },
			{ id: generateUuid(), contour: 0, position: 0.75, width: 3 },
		],
	};
	assert.equal(designWidthAt(closed, 0, 0), designWidthAt(closed, 0, 1));
	assert.equal(designWidthAt(closed, 0, 0), 20);
});

test('Baked path bounds use curve extrema and preserve the world position of rotated artwork', () => {
	const path = {
		...line(),
		rotation: 90,
		nodes: [
			{ ...line().nodes[0], outgoing: { x: 0, y: 2 } },
			{ ...line().nodes[1], incoming: { x: 1, y: 2 } },
		],
	};
	const fitted = fitDesignPathBounds(path);
	assert.equal(fitted.width, 200);
	assert.equal(fitted.height, 150);
	const world = (path: DesignPath, i: number) => {
		const p = path.nodes[i],
			angle = (path.rotation * Math.PI) / 180,
			dx = (p.x - 0.5) * path.width,
			dy = (p.y - 0.5) * path.height;
		return {
			x: path.x + path.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
			y: path.y + path.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
		};
	};
	for (const i of [0, 1]) {
		const a = world(fitted, i),
			b = world(path, i);
		assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9);
	}
	assert.deepEqual(fitted.widthPoints, path.widthPoints);
});

test('Variable stroke cap geometry and closed ribbons preserve empty centers', () => {
	const path = { ...line(), widthPoints: [{ id: generateUuid(), contour: 0, position: 0.5, width: 1 }] };
	for (const cap of ['butt', 'square', 'round'] as const) {
		const shape = { ...path, strokeCap: cap },
			contours = designVariableStrokeContours(shape);
		const x = contours.flatMap(contour => contour.nodes.map(node => node.x * shape.width));
		assert.ok(Math.abs(Math.min(...x) - (cap === 'butt' ? 0 : -5)) < 1e-6);
		assert.ok(Math.abs(Math.max(...x) - (cap === 'butt' ? 200 : 205)) < 1e-6);
	}
	const closed = {
		...box(0),
		strokeWidth: 10,
		widthPoints: [{ id: generateUuid(), contour: 0, position: 0.5, width: 2 }],
	};
	const outlines = designVariableStrokeContours(closed);
	assert.equal(outlines.length, 2);
	const stroke: DesignPath = {
		...closed,
		widthPoints: undefined,
		strokeWidth: 0,
		nodes: outlines[0].nodes,
		subpaths: outlines.slice(1),
	};
	assert.equal(hitTestDesignShapes([stroke], { x: 100, y: 50 }), undefined);
	assert.equal(hitTestDesignShapes([stroke], { x: 100, y: -8 })?.id, stroke.id);
});

test('Width points survive contour splitting and reversal, and branching restores uniform strokes atomically', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		source = line(),
		path = {
			...source,
			widthPoints: source.widthPoints!.map(point => (point.position === 0.5 ? { ...point, position: 0.25 } : point)),
		};
	model.replace(documentFromShapes([path]));
	commands.vector.insertNode(path, 0, 0, 0.3);
	let next = model.value.shapes[0] as DesignPath;
	assert.equal(designWidthAt(next, 0, 0.25), 40);
	commands.vector.reverse(next, 0);
	next = model.value.shapes[0] as DesignPath;
	assert.equal(designWidthAt(next, 0, 0.75), 40);
	const network = toDesignVectorNetwork(next);
	commands.vector.update(withDesignVectorNetwork(next, network));
	next = model.value.shapes[0] as DesignPath;
	assert.ok(supportsDesignVariableWidth(next));
	assert.equal(designWidthAt(next, 0, 0.75), 40);
	const branch = withDesignVectorNetwork(next, connectDesignNetwork(next.network!, 1, { x: 0.5, y: 1 }));
	assert.equal(supportsDesignVariableWidth(branch), false);
	commands.vector.update(branch);
	assert.equal((model.value.shapes[0] as DesignPath).widthPoints, undefined);
	model.undo();
	assert.deepEqual(model.value.shapes[0], next);
	assert.equal(supportsDesignVariableWidth({ ...path, dashArray: [4, 4] }), false);
});

test('Moving anchors carries width points along the path without changing their fractional positions', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		path = line();
	model.replace(documentFromShapes([path]));
	commands.vector.editContour(path, 0, contour => ({
		...contour,
		nodes: contour.nodes.map(node => ({
			...node,
			x: node.x + 1,
			incoming: { ...node.incoming, x: node.incoming.x + 1 },
			outgoing: { ...node.outgoing, x: node.outgoing.x + 1 },
		})),
	}));
	const moved = model.value.shapes[0] as DesignPath;
	assert.deepEqual(moved.widthPoints, path.widthPoints);
	assert.deepEqual(designWidthLocation(moved, 0, 0.5)!.point, { x: 300, y: 0 });
});

test('Inserting a width point subdivides its interpolation without changing the visible stroke', () => {
	const path = line(),
		position = 0.27,
		point = { id: generateUuid(), contour: 0, position, ...designWidthPointAt(path, 0, position) };
	const next = { ...path, widthPoints: [...path.widthPoints!, point] };
	for (let t = 0; t <= 1; t += 0.01) {
		assert.ok(Math.abs(designWidthAt(path, 0, t) - designWidthAt(next, 0, t)) < 1e-9);
	}
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(documentFromShapes([next]))).shapes[0], next);
});

test('Corner smoothing preserves editable radii and uses tangent cubic transitions with radius-first space allocation', () => {
	const source = box(20),
		smooth = { ...source, cornerSmoothing: 0.6 },
		nodes = designPathStrokeContours(smooth)[0].nodes;
	assert.equal(nodes.length, 16);
	assert.deepEqual(smooth.nodes, source.nodes);
	assert.ok(Math.abs(nodes[0].y * source.height - 32) < 1e-8);
	assert.ok(Math.abs(nodes[0].outgoing.x - nodes[0].x) < 1e-10);
	assert.ok(Math.abs(nodes[1].incoming.x - nodes[0].x) < 1e-10);
	assert.deepEqual(designPathStrokeContours({ ...box(1000), cornerSmoothing: 1 }), designPathStrokeContours(box(1000)));
	assert.deepEqual(designPathStrokeContours({ ...source, cornerSmoothing: 0 }), designPathStrokeContours(source));
	for (const amount of [0.01, 0.6, 1]) {
		const contour = designPathStrokeContours({ ...source, cornerSmoothing: amount })[0];
		assert.ok(
			contour.nodes.every(node =>
				[node, node.incoming, node.outgoing].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -1e-8 && p.y >= -1e-8 && p.x <= 1 + 1e-8 && p.y <= 1 + 1e-8),
			),
		);
	}
});

test('Inside and outside strokes partition mixed paths and preserve open strokes and dynamic centering', () => {
	const path: DesignPath = {
		...box(0),
		strokeWidth: 20,
		strokeAlignment: 'inside',
		subpaths: [{ nodes: line().nodes, closed: false }],
	};
	assert.deepEqual(
		designStrokeLayers(path).map(layer => [layer.width, layer.alignment, layer.contours.length]),
		[
			[40, 'inside', 1],
			[20, 'center', 1],
		],
	);
	assert.equal(hitTestDesignShapes([{ ...path, subpaths: [] }], { x: -8, y: 50 }), undefined);
	assert.equal(hitTestDesignShapes([{ ...path, subpaths: [], strokeAlignment: 'outside' }], { x: -18, y: 50 })?.id, path.id);
	assert.equal(hitTestDesignShapes([{ ...path, subpaths: [], strokeAlignment: 'center' }], { x: -18, y: 50 }), undefined);
	assert.deepEqual(
		designStrokeLayers({ ...path, widthPoints: line().widthPoints }).map(layer => [layer.width, layer.alignment]),
		[[20, 'center']],
	);
});

test('Endpoint direction follows curve handles and only degree-one network vertices carry tips', () => {
	const source: DesignPath = {
		...line(),
		widthPoints: undefined,
		nodes: line().nodes.map((node, i) => ({ ...node, endpoint: i ? 'triangle-arrow' : 'butt' })),
	};
	assert.equal(designEndpointContours(source).length, 1);
	assert.equal(hitTestDesignShapes([source], { x: 174, y: 12 })?.id, source.id);
	assert.equal(hitTestDesignShapes([{ ...source, nodes: line().nodes }], { x: 174, y: 12 }), undefined);
	const curved = { ...source, nodes: [source.nodes[0], { ...source.nodes[1], incoming: { x: 1, y: 0.5 } }] };
	assert.deepEqual(designPathEndpoints(curved)[1].direction, { x: 0, y: -1 });
	let network = toDesignVectorNetwork(source);
	network = connectDesignNetwork(network, 1, { x: 0.5, y: 1 });
	network = connectDesignNetwork(network, 1, { x: 1, y: 1 });
	const fork = withDesignVectorNetwork(source, network);
	assert.equal(designPathEndpoints(fork).length, 3);
	assert.ok(designPathEndpoints(fork).every(endpoint => endpoint.index !== 1));
	assert.equal(designEndpointContours(fork).length, 0);
	assert.equal(designEndpointContours({ ...source, closed: true }).length, 0);
});

test('Endpoint styles and smoothing persist, reverse with anchors, and width profiles replace arrows atomically', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		source = { ...line(), widthPoints: undefined, cornerSmoothing: 0.6, strokeAlignment: 'outside' as const };
	model.replace(documentFromShapes([source]));
	commands.vector.setEndpoints(source, [designPathEndpoints(source)[1]], 'diamond-arrow');
	const arrow = model.value.shapes[0] as DesignPath;
	assert.equal(arrow.nodes[1].endpoint, 'diamond-arrow');
	assert.deepEqual(JSON.parse(serializeDesignDocument(parseDesignDocument(serializeDesignDocument(model.value)))), JSON.parse(serializeDesignDocument(model.value)));
	commands.vector.reverse(arrow, 0);
	const reversed = model.value.shapes[0] as DesignPath;
	assert.equal(reversed.nodes[0].endpoint, 'diamond-arrow');
	assert.equal(reversed.nodes[0].x, 1);
	commands.vector.update(withDesignVectorNetwork(reversed, toDesignVectorNetwork(reversed)));
	const network = model.value.shapes[0] as DesignPath;
	assert.equal(designPathEndpoints(network)[0].style, 'diamond-arrow');
	assert.deepEqual(JSON.parse(serializeDesignDocument(parseDesignDocument(serializeDesignDocument(model.value)))), JSON.parse(serializeDesignDocument(model.value)));
	commands.vector.update({ ...network, widthPoints: line().widthPoints });
	const dynamic = model.value.shapes[0] as DesignPath;
	assert.equal(dynamic.strokeAlignment, 'center');
	assert.equal(designPathEndpoints(dynamic)[0].style, 'butt');
	model.undo();
	assert.deepEqual(model.value.shapes[0], network);
	model.redo();
	assert.deepEqual(model.value.shapes[0], dynamic);
	commands.vector.setEndpoints(dynamic, [designPathEndpoints(dynamic)[0]], 'line-arrow');
	assert.equal((model.value.shapes[0] as DesignPath).widthPoints, undefined);
});

test('Persistence rejects invalid smoothing, alignment and endpoint properties on paths and networks', () => {
	const source = { ...line(), widthPoints: undefined };
	for (const change of [
		{ cornerSmoothing: -1 },
		{ cornerSmoothing: 1.01 },
		{ cornerSmoothing: '60' },
		{ strokeAlignment: 'left' },
		{ nodes: [{ ...source.nodes[0], endpoint: 'invalid' }, source.nodes[1]] },
	]) {
		assert.throws(() => parseDesignDocument(JSON.stringify({ ...documentFromShapes([source]), shapes: [{ ...source, ...change }] })));
	}
	const network = toDesignVectorNetwork(source);
	assert.throws(() =>
		parseDesignDocument(
			JSON.stringify(
				documentFromShapes([
					withDesignVectorNetwork(source, {
						...network,
						vertices: [{ ...network.vertices[0], endpoint: 'invalid' as 'butt' }, network.vertices[1]],
					}),
				]),
			),
		),
	);
});

test('Solid arrow tips trim only the rendered stroke body and leave saved anchors and degenerate paths intact', () => {
	const source: DesignPath = {
		...line(),
		widthPoints: undefined,
		nodes: line().nodes.map((node, i) => ({ ...node, endpoint: i ? 'triangle-arrow' : 'butt' })),
	};
	const body = designStrokeLayers(source)[0].contours[0];
	assert.ok(Math.abs(body.nodes.at(-1)!.x * source.width - 190) < 1e-5);
	assert.equal(source.nodes[1].x, 1);
	const curve = {
		...source,
		nodes: [
			{ ...source.nodes[0], outgoing: { x: 0, y: 1 } },
			{ ...source.nodes[1], incoming: { x: 1, y: 1 } },
		],
	};
	assert.ok(designStrokeLayers(curve)[0].contours[0].nodes.at(-1)!.y > 0);
	assert.equal(designPathEndpoints(curve)[1].point.y, 0);
	assert.equal(designStrokeLayers({ ...source, strokeWidth: 1000 })[0].contours.length, 0);
	assert.equal(designEndpointContours({ ...source, strokeWidth: 1000 }).length, 1);
	assert.equal(designEndpointContours({ ...source, nodes: line().nodes, strokeCap: 'round', dashArray: [10, 20] }).length, 0);
});
