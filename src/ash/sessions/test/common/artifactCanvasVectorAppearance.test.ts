import { artifactCanvasEndpointContours, artifactCanvasPathEndpoints, artifactCanvasStrokeLayers } from '../../contrib/artifact/common/model/artifactCanvasVectorStroke.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/artifact/common/commands/documentCommands.js';
import { ArtifactCanvasModel } from '../../contrib/artifact/common/model/artifactCanvasModel.js';
import { documentFromShapes, parseArtifactCanvasDocument, serializeArtifactCanvasDocument } from '../../contrib/artifact/common/model/artifactCanvasDocument.js';
import { artifactCanvasPathFillContours, artifactCanvasPathStrokeContours, artifactCanvasShapeContours, fitArtifactCanvasPathBounds, type ArtifactCanvasPath } from '../../contrib/artifact/common/model/artifactCanvasVector.js';
import { connectArtifactCanvasNetwork, toArtifactCanvasVectorNetwork, withArtifactCanvasVectorNetwork } from '../../contrib/artifact/common/model/artifactCanvasVectorNetwork.js';
import { artifactCanvasVariableStrokeContours, artifactCanvasWidthAt, artifactCanvasWidthPointAt, artifactCanvasWidthLocation, nearestArtifactCanvasWidthLocation, supportsArtifactCanvasVariableWidth } from '../../contrib/artifact/common/model/artifactCanvasVariableWidth.js';
import { hitTestArtifactCanvasShapes } from '../../contrib/artifact/common/model/hitTest.js';

const rectangle = () => ({ id: generateUuid(), kind: 'rectangle' as const, x: 0, y: 0, width: 200, height: 100, rotation: 0, fill: '#3366ff' });
const box = (radius = 20): ArtifactCanvasPath => ({ ...rectangle(), kind: 'path', nodes: artifactCanvasShapeContours(rectangle())[0].nodes.map(node => ({ ...node, cornerRadius: radius })), closed: true, strokeWidth: 0 });
const line = (): ArtifactCanvasPath => ({ ...box(0), closed: false, strokeWidth: 10, nodes: box(0).nodes.slice(0, 2), widthPoints: [{ id: generateUuid(), contour: 0, position: 0, width: 0 }, { id: generateUuid(), contour: 0, position: .5, width: 4 }, { id: generateUuid(), contour: 0, position: 1, width: 0 }] });

test('Node radii keep editable anchors and round in pixels with tangent cubic arcs', () => {
	const path = box(), nodes = artifactCanvasPathStrokeContours(path)[0].nodes;
	assert.equal(nodes.length, 8); assert.equal(path.nodes.length, 4); assert.equal(path.nodes[0].cornerRadius, 20);
	assert.ok(Math.abs(nodes[0].y * path.height - 20) < 1e-8); assert.ok(Math.abs(nodes[1].x * path.width - 20) < 1e-8);
	assert.ok(Math.abs((nodes[1].x - nodes[1].incoming.x) * path.width - 20 * .5522847498307936) < 1e-8);
	assert.equal(hitTestArtifactCanvasShapes([path], { x: 1, y: 1 }), undefined);
	assert.equal(hitTestArtifactCanvasShapes([path], { x: 20, y: 20 })?.id, path.id);
	assert.equal(artifactCanvasPathFillContours(withArtifactCanvasVectorNetwork(path, toArtifactCanvasVectorNetwork(path)))[0].nodes.length, 8);
});

test('Oversized adjacent radii share edge space, while endpoints and existing curves retain their geometry', () => {
	const path = box(1000), nodes = artifactCanvasPathStrokeContours(path)[0].nodes;
	assert.ok(nodes.every(node => node.x >= -1e-8 && node.x <= 1 + 1e-8 && node.y >= -1e-8 && node.y <= 1 + 1e-8));
	assert.ok(Math.abs(nodes[0].y - .5) < 1e-8); assert.equal(path.nodes[0].cornerRadius, 1000);
	const open = { ...path, closed: false, nodes: path.nodes.slice(0, 2) };
	assert.deepEqual(artifactCanvasPathStrokeContours(open)[0].nodes, open.nodes);
	const ellipse = { ...path, nodes: artifactCanvasShapeContours({ ...rectangle(), kind: 'ellipse' })[0].nodes.map(node => ({ ...node, cornerRadius: 10 })) };
	assert.deepEqual(artifactCanvasPathStrokeContours(ellipse)[0].nodes, ellipse.nodes);
});

test('Corner radii and width points round-trip with immutable atomic history and strict persistence validation', () => {
	using model = new ArtifactCanvasModel(); const commands = new DocumentCommands(model), source = line(); model.replace(documentFromShapes([source]));
	commands.vector.update({ ...source, nodes: source.nodes.map(node => ({ ...node, cornerRadius: 12 })) });
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)), model.value);
	const path = model.value.shapes[0] as ArtifactCanvasPath; assert.ok(Object.isFrozen(path.widthPoints)); assert.ok(Object.isFrozen(path.widthPoints![0]));
	model.undo(); assert.deepEqual(model.value.shapes[0], source); model.redo(); assert.deepEqual(model.value.shapes[0], path);
	for (const change of [{ nodes: [{ ...source.nodes[0], cornerRadius: -1 }, source.nodes[1]] }, { widthPoints: [{ ...source.widthPoints![0], position: 2 }] }, { widthPoints: [{ ...source.widthPoints![0], width: -1 }] }, { widthPoints: [source.widthPoints![0], source.widthPoints![0]] }]) {
		assert.throws(() => parseArtifactCanvasDocument(JSON.stringify({ ...model.value, shapes: [{ ...source, ...change }] })));
	}
	const network = withArtifactCanvasVectorNetwork(path, toArtifactCanvasVectorNetwork(path)); assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(documentFromShapes([network]))).shapes[0], network);
	assert.throws(() => parseArtifactCanvasDocument(JSON.stringify({ ...model.value, shapes: [{ ...network, network: { ...network.network, vertices: network.network!.vertices.map(vertex => ({ ...vertex, cornerRadius: -3 })) } }] })));
});

test('Variable width follows physical arc length, smooth interpolation, hit testing and stroke weight', () => {
	const path = line(), location = artifactCanvasWidthLocation(path, 0, .25)!;
	assert.deepEqual(location.point, { x: 50, y: 0 }); assert.equal(location.length, 200);
	assert.deepEqual(nearestArtifactCanvasWidthLocation(path, { x: 75, y: 20 }), { contour: 0, position: .375 });
	assert.equal(artifactCanvasWidthAt(path, 0, 0), 0); assert.equal(artifactCanvasWidthAt(path, 0, .5), 40); assert.equal(artifactCanvasWidthAt(path, 0, .25), 20);
	assert.equal(artifactCanvasWidthAt({ ...path, strokeWidth: 20 }, 0, .5), 80);
	assert.equal(artifactCanvasVariableStrokeContours(path).length, 1);
	assert.equal(hitTestArtifactCanvasShapes([path], { x: 100, y: 18 })?.id, path.id); assert.equal(hitTestArtifactCanvasShapes([path], { x: 100, y: 25 }), undefined);
	assert.equal(hitTestArtifactCanvasShapes([path], { x: 10, y: 15 }), undefined);
});

test('Width points measure curved arc length and closed profiles have a continuous seam', () => {
	const path = line(), curved = { ...path, nodes: [{ ...path.nodes[0], outgoing: { x: 0, y: 1 } }, { ...path.nodes[1], incoming: { x: 1, y: 1 } }] };
	const location = artifactCanvasWidthLocation(curved, 0, .5)!;
	assert.ok(Math.abs(location.point.x - 100) < .01); assert.ok(Math.abs(location.point.y - 75) < .01);
	assert.ok(location.length > 260 && location.length < 290);
	const closed = { ...box(), strokeWidth: 10, widthPoints: [{ id: generateUuid(), contour: 0, position: .25, width: 1 }, { id: generateUuid(), contour: 0, position: .75, width: 3 }] };
	assert.equal(artifactCanvasWidthAt(closed, 0, 0), artifactCanvasWidthAt(closed, 0, 1)); assert.equal(artifactCanvasWidthAt(closed, 0, 0), 20);
});

test('Baked path bounds use curve extrema and preserve the world position of rotated artwork', () => {
	const path = { ...line(), rotation: 90, nodes: [{ ...line().nodes[0], outgoing: { x: 0, y: 2 } }, { ...line().nodes[1], incoming: { x: 1, y: 2 } }] };
	const fitted = fitArtifactCanvasPathBounds(path);
	assert.equal(fitted.width, 200); assert.equal(fitted.height, 150);
	const world = (path: ArtifactCanvasPath, i: number) => { const p = path.nodes[i], angle = path.rotation * Math.PI / 180, dx = (p.x - .5) * path.width, dy = (p.y - .5) * path.height; return { x: path.x + path.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), y: path.y + path.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) }; };
	for (const i of [0, 1]) { const a = world(fitted, i), b = world(path, i); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9); }
	assert.deepEqual(fitted.widthPoints, path.widthPoints);
});

test('Variable stroke cap geometry and closed ribbons preserve empty centers', () => {
	const path = { ...line(), widthPoints: [{ id: generateUuid(), contour: 0, position: .5, width: 1 }] };
	for (const cap of ['butt', 'square', 'round'] as const) {
		const shape = { ...path, strokeCap: cap }, contours = artifactCanvasVariableStrokeContours(shape);
		const x = contours.flatMap(contour => contour.nodes.map(node => node.x * shape.width));
		assert.ok(Math.abs(Math.min(...x) - (cap === 'butt' ? 0 : -5)) < 1e-6);
		assert.ok(Math.abs(Math.max(...x) - (cap === 'butt' ? 200 : 205)) < 1e-6);
	}
	const closed = { ...box(0), strokeWidth: 10, widthPoints: [{ id: generateUuid(), contour: 0, position: .5, width: 2 }] };
	const outlines = artifactCanvasVariableStrokeContours(closed); assert.equal(outlines.length, 2);
	const stroke: ArtifactCanvasPath = { ...closed, widthPoints: undefined, strokeWidth: 0, nodes: outlines[0].nodes, subpaths: outlines.slice(1) };
	assert.equal(hitTestArtifactCanvasShapes([stroke], { x: 100, y: 50 }), undefined);
	assert.equal(hitTestArtifactCanvasShapes([stroke], { x: 100, y: -8 })?.id, stroke.id);
});

test('Width points survive contour splitting and reversal, and branching restores uniform strokes atomically', () => {
	using model = new ArtifactCanvasModel(); const commands = new DocumentCommands(model), source = line(), path = { ...source, widthPoints: source.widthPoints!.map(point => point.position === .5 ? { ...point, position: .25 } : point) }; model.replace(documentFromShapes([path]));
	commands.vector.insertNode(path, 0, 0, .3); let next = model.value.shapes[0] as ArtifactCanvasPath;
	assert.equal(artifactCanvasWidthAt(next, 0, .25), 40);
	commands.vector.reverse(next, 0); next = model.value.shapes[0] as ArtifactCanvasPath;
	assert.equal(artifactCanvasWidthAt(next, 0, .75), 40);
	const network = toArtifactCanvasVectorNetwork(next); commands.vector.update(withArtifactCanvasVectorNetwork(next, network)); next = model.value.shapes[0] as ArtifactCanvasPath;
	assert.ok(supportsArtifactCanvasVariableWidth(next)); assert.equal(artifactCanvasWidthAt(next, 0, .75), 40);
	const branch = withArtifactCanvasVectorNetwork(next, connectArtifactCanvasNetwork(next.network!, 1, { x: .5, y: 1 }));
	assert.equal(supportsArtifactCanvasVariableWidth(branch), false); commands.vector.update(branch); assert.equal((model.value.shapes[0] as ArtifactCanvasPath).widthPoints, undefined);
	model.undo(); assert.deepEqual(model.value.shapes[0], next);
	assert.equal(supportsArtifactCanvasVariableWidth({ ...path, dashArray: [4, 4] }), false);
});

test('Moving anchors carries width points along the path without changing their fractional positions', () => {
	using model = new ArtifactCanvasModel(); const commands = new DocumentCommands(model), path = line(); model.replace(documentFromShapes([path]));
	commands.vector.editContour(path, 0, contour => ({ ...contour, nodes: contour.nodes.map(node => ({ ...node, x: node.x + 1, incoming: { ...node.incoming, x: node.incoming.x + 1 }, outgoing: { ...node.outgoing, x: node.outgoing.x + 1 } })) }));
	const moved = model.value.shapes[0] as ArtifactCanvasPath;
	assert.deepEqual(moved.widthPoints, path.widthPoints); assert.deepEqual(artifactCanvasWidthLocation(moved, 0, .5)!.point, { x: 300, y: 0 });
});

test('Inserting a width point subdivides its interpolation without changing the visible stroke', () => {
	const path = line(), position = .27, point = { id: generateUuid(), contour: 0, position, ...artifactCanvasWidthPointAt(path, 0, position) };
	const next = { ...path, widthPoints: [...path.widthPoints!, point] };
	for (let t = 0; t <= 1; t += .01) { assert.ok(Math.abs(artifactCanvasWidthAt(path, 0, t) - artifactCanvasWidthAt(next, 0, t)) < 1e-9); }
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(documentFromShapes([next]))).shapes[0], next);
});


test('Corner smoothing preserves editable radii and uses tangent cubic transitions with radius-first space allocation', () => {
	const source = box(20), smooth = { ...source, cornerSmoothing: .6 }, nodes = artifactCanvasPathStrokeContours(smooth)[0].nodes;
	assert.equal(nodes.length, 16); assert.deepEqual(smooth.nodes, source.nodes);
	assert.ok(Math.abs(nodes[0].y * source.height - 32) < 1e-8);
	assert.ok(Math.abs(nodes[0].outgoing.x - nodes[0].x) < 1e-10);
	assert.ok(Math.abs(nodes[1].incoming.x - nodes[0].x) < 1e-10);
	assert.deepEqual(artifactCanvasPathStrokeContours({ ...box(1000), cornerSmoothing: 1 }), artifactCanvasPathStrokeContours(box(1000)));
	assert.deepEqual(artifactCanvasPathStrokeContours({ ...source, cornerSmoothing: 0 }), artifactCanvasPathStrokeContours(source));
	for (const amount of [.01, .6, 1]) { const contour = artifactCanvasPathStrokeContours({ ...source, cornerSmoothing: amount })[0]; assert.ok(contour.nodes.every(node => [node, node.incoming, node.outgoing].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -1e-8 && p.y >= -1e-8 && p.x <= 1 + 1e-8 && p.y <= 1 + 1e-8))); }
});

test('Inside and outside strokes partition mixed paths and preserve open strokes and dynamic centering', () => {
	const path: ArtifactCanvasPath = { ...box(0), strokeWidth: 20, strokeAlignment: 'inside', subpaths: [{ nodes: line().nodes, closed: false }] };
	assert.deepEqual(artifactCanvasStrokeLayers(path).map(layer => [layer.width, layer.alignment, layer.contours.length]), [[40, 'inside', 1], [20, 'center', 1]]);
	assert.equal(hitTestArtifactCanvasShapes([{ ...path, subpaths: [] }], { x: -8, y: 50 }), undefined);
	assert.equal(hitTestArtifactCanvasShapes([{ ...path, subpaths: [], strokeAlignment: 'outside' }], { x: -18, y: 50 })?.id, path.id);
	assert.equal(hitTestArtifactCanvasShapes([{ ...path, subpaths: [], strokeAlignment: 'center' }], { x: -18, y: 50 }), undefined);
	assert.deepEqual(artifactCanvasStrokeLayers({ ...path, widthPoints: line().widthPoints }).map(layer => [layer.width, layer.alignment]), [[20, 'center']]);
});

test('Endpoint direction follows curve handles and only degree-one network vertices carry tips', () => {
	const source: ArtifactCanvasPath = { ...line(), widthPoints: undefined, nodes: line().nodes.map((node, i) => ({ ...node, endpoint: i ? 'triangle-arrow' : 'butt' })) };
	assert.equal(artifactCanvasEndpointContours(source).length, 1);
	assert.equal(hitTestArtifactCanvasShapes([source], { x: 174, y: 12 })?.id, source.id);
	assert.equal(hitTestArtifactCanvasShapes([{ ...source, nodes: line().nodes }], { x: 174, y: 12 }), undefined);
	const curved = { ...source, nodes: [source.nodes[0], { ...source.nodes[1], incoming: { x: 1, y: .5 } }] };
	assert.deepEqual(artifactCanvasPathEndpoints(curved)[1].direction, { x: 0, y: -1 });
	let network = toArtifactCanvasVectorNetwork(source); network = connectArtifactCanvasNetwork(network, 1, { x: .5, y: 1 }); network = connectArtifactCanvasNetwork(network, 1, { x: 1, y: 1 });
	const fork = withArtifactCanvasVectorNetwork(source, network);
	assert.equal(artifactCanvasPathEndpoints(fork).length, 3); assert.ok(artifactCanvasPathEndpoints(fork).every(endpoint => endpoint.index !== 1)); assert.equal(artifactCanvasEndpointContours(fork).length, 0);
	assert.equal(artifactCanvasEndpointContours({ ...source, closed: true }).length, 0);
});

test('Endpoint styles and smoothing persist, reverse with anchors, and width profiles replace arrows atomically', () => {
	using model = new ArtifactCanvasModel(); const commands = new DocumentCommands(model), source = { ...line(), widthPoints: undefined, cornerSmoothing: .6, strokeAlignment: 'outside' as const }; model.replace(documentFromShapes([source]));
	commands.vector.setEndpoints(source, [artifactCanvasPathEndpoints(source)[1]], 'diamond-arrow');
	const arrow = model.value.shapes[0] as ArtifactCanvasPath; assert.equal(arrow.nodes[1].endpoint, 'diamond-arrow');
	assert.deepEqual(JSON.parse(serializeArtifactCanvasDocument(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)))), JSON.parse(serializeArtifactCanvasDocument(model.value)));
	commands.vector.reverse(arrow, 0); const reversed = model.value.shapes[0] as ArtifactCanvasPath;
	assert.equal(reversed.nodes[0].endpoint, 'diamond-arrow'); assert.equal(reversed.nodes[0].x, 1);
	commands.vector.update(withArtifactCanvasVectorNetwork(reversed, toArtifactCanvasVectorNetwork(reversed)));
	const network = model.value.shapes[0] as ArtifactCanvasPath; assert.equal(artifactCanvasPathEndpoints(network)[0].style, 'diamond-arrow');
	assert.deepEqual(JSON.parse(serializeArtifactCanvasDocument(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)))), JSON.parse(serializeArtifactCanvasDocument(model.value)));
	commands.vector.update({ ...network, widthPoints: line().widthPoints }); const dynamic = model.value.shapes[0] as ArtifactCanvasPath;
	assert.equal(dynamic.strokeAlignment, 'center'); assert.equal(artifactCanvasPathEndpoints(dynamic)[0].style, 'butt');
	model.undo(); assert.deepEqual(model.value.shapes[0], network); model.redo(); assert.deepEqual(model.value.shapes[0], dynamic);
	commands.vector.setEndpoints(dynamic, [artifactCanvasPathEndpoints(dynamic)[0]], 'line-arrow'); assert.equal((model.value.shapes[0] as ArtifactCanvasPath).widthPoints, undefined);
});

test('Persistence rejects invalid smoothing, alignment and endpoint properties on paths and networks', () => {
	const source = { ...line(), widthPoints: undefined };
	for (const change of [{ cornerSmoothing: -1 }, { cornerSmoothing: 1.01 }, { cornerSmoothing: '60' }, { strokeAlignment: 'left' }, { nodes: [{ ...source.nodes[0], endpoint: 'invalid' }, source.nodes[1]] }]) {
		assert.throws(() => parseArtifactCanvasDocument(JSON.stringify({ ...documentFromShapes([source]), shapes: [{ ...source, ...change }] })));
	}
	const network = toArtifactCanvasVectorNetwork(source);
	assert.throws(() => parseArtifactCanvasDocument(JSON.stringify(documentFromShapes([withArtifactCanvasVectorNetwork(source, { ...network, vertices: [{ ...network.vertices[0], endpoint: 'invalid' as 'butt' }, network.vertices[1]] })]))));
});


test('Solid arrow tips trim only the rendered stroke body and leave saved anchors and degenerate paths intact', () => {
	const source: ArtifactCanvasPath = { ...line(), widthPoints: undefined, nodes: line().nodes.map((node, i) => ({ ...node, endpoint: i ? 'triangle-arrow' : 'butt' })) };
	const body = artifactCanvasStrokeLayers(source)[0].contours[0]; assert.ok(Math.abs(body.nodes.at(-1)!.x * source.width - 190) < 1e-5); assert.equal(source.nodes[1].x, 1);
	const curve = { ...source, nodes: [{ ...source.nodes[0], outgoing: { x: 0, y: 1 } }, { ...source.nodes[1], incoming: { x: 1, y: 1 } }] };
	assert.ok(artifactCanvasStrokeLayers(curve)[0].contours[0].nodes.at(-1)!.y > 0); assert.equal(artifactCanvasPathEndpoints(curve)[1].point.y, 0);
	assert.equal(artifactCanvasStrokeLayers({ ...source, strokeWidth: 1000 })[0].contours.length, 0);
	assert.equal(artifactCanvasEndpointContours({ ...source, strokeWidth: 1000 }).length, 1);
	assert.equal(artifactCanvasEndpointContours({ ...source, nodes: line().nodes, strokeCap: 'round', dashArray: [10, 20] }).length, 0);
});
