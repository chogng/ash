import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/design/common/model/document.js';
import { DesignModel } from '../../contrib/design/common/model/designModel.js';
import { DocumentCommands } from '../../contrib/design/common/commands/documentCommands.js';
import { DesignViewport } from '../../contrib/design/common/viewport.js';
import { hitTestDesignShapes } from '../../contrib/design/common/model/hitTest.js';
import { sampleDesignMotion } from '../../contrib/design/contrib/motion/common/motion.js';

test('Design documents round trip fractional coordinates and discard redo after a new edit', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const id = commands.addShape('rectangle', { x: 0.25, y: -10.5 });
	const shape = { ...model.value.shapes[0], width: 1.25, rotation: 37 };
	commands.updateShape(shape);
	const serialized = serializeDesignDocument(model.value);
	assert.deepEqual(parseDesignDocument(serialized), model.value);
	model.undo();
	model.redo();
	assert.equal(serializeDesignDocument(model.value), serialized);
	model.undo();
	commands.removeShapes(new Set([id]));
	assert.deepEqual([model.value.shapes, model.canRedo], [[], false]);
	model.undo();
	assert.equal(model.value.shapes[0].width, 120);
});

test('Design motion validates ordered keyframes and keeps animation positions through edits, groups and history', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const id = commands.addShape('rectangle', { x: 60, y: 40 });
	const shape = model.value.shapes[0];
	const motion = { duration: 1000, loop: false, keyframes: [
		{ offset: 0, x: 0, y: 0, rotation: 0, opacity: 1 },
		{ offset: 1, x: 100, y: 200, rotation: 90, opacity: 0 },
	] };
	commands.updateShape({ ...shape, motion });
	assert.deepEqual(sampleDesignMotion(model.value.shapes[0], 500), { offset: 0.5, x: 50, y: 100, rotation: 45, opacity: 0.5 });
	for (const invalid of [
		{ ...motion, duration: 0 },
		{ ...motion, loop: 'true' },
		{ ...motion, keyframes: [...motion.keyframes].reverse() },
		{ ...motion, keyframes: [{ ...motion.keyframes[0], opacity: 2 }, motion.keyframes[1]] },
		{ ...motion, keyframes: [motion.keyframes[0], motion.keyframes[0], motion.keyframes[1]] },
	]) { assert.throws(() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [{ ...shape, motion: invalid }] })), TypeError); }
	commands.updateGeometry(model.value.shapes[0], 'x', 20);
	assert.equal(sampleDesignMotion(model.value.shapes[0], 500).x, 70);
	model.undo();
	assert.equal(sampleDesignMotion(model.value.shapes[0], 500).x, 50);
	const second = commands.addShape('ellipse', { x: 200, y: 40 });
	const group = commands.group(new Set([id, second]))!;
	commands.updateGeometry(model.value.shapes[0], 'rotation', 90);
	commands.ungroup(group);
	const animated = model.value.shapes.find(shape => shape.id === id)!;
	assert.equal(animated.motion!.keyframes[1].rotation, 180);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(animated.motion!.keyframes[0]));
});

test('Design files reject unsupported versions, duplicate identities and invalid geometry', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	commands.addShape('rectangle', { x: 0, y: 0 });
	const shape = model.value.shapes[0];
	for (const document of [
		{ version: 2, shapes: [] },
		{ version: 1, shapes: [shape, shape] },
		{ version: 1, shapes: [{ ...shape, width: 0 }] },
		{ version: 1, shapes: [{ ...shape, rotation: null }] },
		{ version: 1, shapes: [{ ...shape, fill: 'url(https://example.com)' }] },
		{ version: 1, shapes: [{ ...shape, kind: 'path' }] },
		{ version: 1, shapes: [], unknown: true },
	]) { assert.throws(() => parseDesignDocument(JSON.stringify(document)), TypeError); }
});

test('Design hit testing respects paint order, ellipse contours and rotation', () => {
	const rectangle: DesignShape = { id: 'back', kind: 'rectangle', x: -100, y: -100, width: 200, height: 200, rotation: 0, fill: '#808080' };
	const ellipse: DesignShape = { ...rectangle, id: 'front', kind: 'ellipse', x: 0, y: 0, width: 100, height: 40, rotation: 90 };
	assert.equal(hitTestDesignShapes([rectangle, ellipse], { x: 50, y: 60 })?.id, 'front');
	assert.equal(hitTestDesignShapes([rectangle, ellipse], { x: 68, y: 65 })?.id, 'back');
	assert.equal(hitTestDesignShapes([ellipse], { x: 0, y: 0 }), undefined);
	assert.equal(hitTestDesignShapes([{ ...ellipse, kind: 'rectangle' }], { x: 68, y: 65 })?.id, 'front');
});

test('Design camera keeps a fractional world point fixed across pan and zoom', () => {
	const camera = new DesignViewport();
	camera.panBy(123.5, -77.25);
	const point = { x: 211.25, y: 33.5 };
	const world = camera.toWorld(point);
	camera.zoomAt(point, 2);
	assert.deepEqual(camera.toWorld(point), world);
	camera.zoomAt(point, 100);
	assert.equal(camera.scale, 4);
	camera.zoomAt(point, 0.0001);
	assert.equal(camera.scale, 0.2);
	camera.reset();
	assert.deepEqual(camera.toWorld(point), point);
});

test('Design text, paths and nested groups round trip and undo as complete edits', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const text = commands.addShape('text', { x: 0, y: 0 }, '中文 <text>\nsecond line');
	const path = commands.addShape('path', { x: 200, y: 100 });
	const original = model.value;
	const group = commands.group(new Set([text, path]))!;
	commands.addShape('ellipse', { x: -50, y: -30 });
	const nested = commands.group(new Set(model.value.shapes.map(shape => shape.id)))!;
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.equal(Object.isFrozen((model.value.shapes[0] as Extract<DesignShape, { kind: 'group' }>).children), true);
	commands.ungroup(nested);
	commands.ungroup(group);
	assert.deepEqual(model.value.shapes.slice(0, 2), original.shapes);
	model.undo();
	assert.equal(model.value.shapes[0].kind, 'group');
	model.redo();
	assert.deepEqual(model.value.shapes.slice(0, 2), original.shapes);
});

test('Ungroup preserves child centers, rotation and size after a group transform', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const textId = commands.addShape('text', { x: 0, y: 0 }, 'Hello');
	const pathId = commands.addShape('path', { x: 200, y: 100 });
	const id = commands.group(new Set([textId, pathId]))!;
	const group = model.value.shapes[0] as Extract<DesignShape, { kind: 'group' }>;
	commands.updateShape({ ...group, x: 100, y: 200, width: group.width * 2, height: group.height * 2, rotation: 90 });
	commands.ungroup(id);
	const text = model.value.shapes[0] as Extract<DesignShape, { kind: 'text' }>;
	const child = group.children[0];
	assert.ok(Math.abs(text.x + text.width / 2 - (100 + group.width - ((child.y + child.height / 2) * 2 - group.height))) < 1e-8);
	assert.ok(Math.abs(text.y + text.height / 2 - (200 + group.height + ((child.x + child.width / 2) * 2 - group.width))) < 1e-8);
	assert.deepEqual([text.width, text.height, text.rotation, text.fontSize], [child.width * 2, child.height * 2, 90, 48]);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Design files reject malformed text, path points, groups and duplicate nested IDs', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const textId = commands.addShape('text', { x: 0, y: 0 });
	const pathId = commands.addShape('path', { x: 200, y: 100 });
	const text = model.value.shapes[0] as Extract<DesignShape, { kind: 'text' }>;
	const path = model.value.shapes[1] as Extract<DesignShape, { kind: 'path' }>;
	commands.group(new Set([textId, pathId]));
	const group = model.value.shapes[0] as Extract<DesignShape, { kind: 'group' }>;
	for (const shape of [
		{ ...text, text: null }, { ...text, fontSize: -1 },
		{ ...path, nodes: [] }, { ...path, strokeWidth: 0 }, { ...path, closed: 'false' },
		{ ...path, nodes: [{ ...path.nodes[0], incoming: { x: 2, y: 0 } }, path.nodes[1]] },
		{ ...group, children: [text, text] }, { ...group, height: group.height * 2 },
	]) { assert.throws(() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [shape] })), TypeError); }
});

test('Open path hit testing follows its cubic curve instead of its rectangular bounds', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	commands.addShape('path', { x: 60, y: 40 });
	const path = model.value.shapes[0];
	assert.equal(hitTestDesignShapes([path], { x: 60, y: 40 })?.id, path.id);
	assert.equal(hitTestDesignShapes([path], { x: 60, y: 0 }), undefined);
});
