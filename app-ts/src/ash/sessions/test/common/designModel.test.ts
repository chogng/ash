import assert from 'node:assert/strict';
import { test } from 'mocha';
import { documentFromShapes, flattenDesignShapes, parseDesignDocument, serializeDesignDocument, type DesignAsset, type DesignShape } from '../../contrib/creator/common/model/document.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { getDesignShapeEntries, hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';
import { sampleDesignMotion } from '../../contrib/creator/contrib/motion/common/motion.js';

test('Design transparent fills survive serialization and the committed undo history', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	commands.addShape('rectangle', { x: 60, y: 40 });
	commands.updateShape({ ...model.value.shapes[0], fill: '#ff800040' });
	assert.equal(parseDesignDocument(serializeDesignDocument(model.value)).shapes[0].fill, '#ff800040');
	model.undo();
	assert.equal(model.value.shapes[0].fill, '#808080');
	model.redo();
	assert.equal(model.value.shapes[0].fill, '#ff800040');
	for (const fill of ['#fff', '#ff80004', '#ff8000400', 'rgba(255, 0, 0, 0.5)']) {
		assert.throws(() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [{ ...model.value.shapes[0], fill }] })), TypeError);
	}
});

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

test('Frame children keep local geometry through resizing, grouping and versioned file round trips', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const frameId = commands.addFrame({ x: 500, y: 400 });
	const childId = commands.addShape('rectangle', { x: 500, y: 400 });
	const textId = commands.addShape('text', { x: 600, y: 400 }, '产品');
	const original = flattenDesignShapes(model.value.shapes).find(shape => shape.id === childId)!;
	const frame = model.value.shapes[0];
	assert.equal(original.x, 260);
	commands.updateGeometry(frame, 'width', 1000);
	assert.deepEqual(flattenDesignShapes(model.value.shapes).find(shape => shape.id === childId), original);
	const groupId = commands.group(new Set([childId, textId]))!;
	assert.ok(groupId);
	assert.deepEqual(commands.ungroup(groupId), [childId, textId]);
	assert.deepEqual(flattenDesignShapes(model.value.shapes).find(shape => shape.id === childId), original);
	const content = serializeDesignDocument(model.value);
	const manifest = JSON.parse(content);
	assert.deepEqual(manifest.artifacts[model.value.artifactId].roots, [frameId]);
	assert.deepEqual(manifest.artifacts[model.value.artifactId].objects[frameId].children, [childId, textId]);
	assert.deepEqual(parseDesignDocument(content), model.value);
	assert.equal(hitTestDesignShapes(model.value.shapes, { x: 450, y: 400 })!.id, childId);
});

test('Image uses share immutable media versions while crop edits and deletion undo independently', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const asset: DesignAsset = { id: generateUuid(), name: 'product.png', versions: [{ id: generateUuid(), sha256: 'a'.repeat(64), path: `assets/${'a'.repeat(64)}`, mediaType: 'image/png', width: 800, height: 600 }] };
	const image: DesignShape = { id: generateUuid(), kind: 'image', assetId: asset.id, assetVersionId: asset.versions[0].id, crop: { x: 0, y: 0, width: 1, height: 1 }, x: 0, y: 0, width: 400, height: 300, rotation: 0, fill: '#ffffff' };
	commands.insertShape(image, [asset]);
	const second = { ...image, id: generateUuid(), x: 500 };
	commands.insertShape(second);
	commands.updateShape({ ...image, crop: { x: 0.2, y: 0, width: 0.8, height: 1 } });
	assert.deepEqual(model.value.shapes[1], second);
	assert.equal(model.value.assets.length, 1);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	commands.removeShapes(new Set([image.id, second.id]));
	assert.equal(model.value.assets[0].versions[0].id, asset.versions[0].id);
	model.undo();
	assert.equal(model.value.shapes.length, 2);
	model.undo();
	assert.deepEqual(model.value.shapes[0], image);
});

test('Version 2 rejects cycles, duplicate placement, unowned objects and missing or escaping media references', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const frameId = commands.addFrame({ x: 0, y: 0 });
	const childId = commands.addShape('rectangle', { x: 0, y: 0 });
	const source = serializeDesignDocument(model.value);
	type Manifest = { artifacts: Record<string, { roots: string[]; objects: Record<string, Record<string, unknown>> }> };
	for (const mutate of [
		(value: Manifest) => { value.artifacts[model.value.artifactId].objects[frameId].children = [frameId]; },
		(value: Manifest) => { value.artifacts[model.value.artifactId].roots.push(childId); },
		(value: Manifest) => { value.artifacts[model.value.artifactId].objects[frameId].children = []; },
		(value: Manifest) => { Object.assign(value.artifacts[model.value.artifactId].objects[childId], { kind: 'image', assetId: generateUuid(), assetVersionId: generateUuid(), crop: { x: 0, y: 0, width: 1, height: 1 } }); },
	]) {
		const value = JSON.parse(source) as Manifest;
		mutate(value);
		assert.throws(() => parseDesignDocument(JSON.stringify(value)), TypeError);
	}
	const image: DesignShape = { id: generateUuid(), kind: 'image', assetId: generateUuid(), assetVersionId: generateUuid(), crop: { x: 0, y: 0, width: 1, height: 1 }, x: 0, y: 0, width: 1, height: 1, rotation: 0, fill: '#ffffff' };
	const asset: DesignAsset = { id: image.assetId, name: 'image', versions: [{ id: image.assetVersionId, sha256: 'a'.repeat(64), path: '../external.png', mediaType: 'image/png', width: 1, height: 1 }] };
	assert.throws(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([image], undefined, [asset]))), TypeError);
	const validAsset = { ...asset, versions: asset.versions.map(version => ({ ...version, path: `assets/${version.sha256}` })) };
	const duplicate = { ...validAsset, id: generateUuid() };
	assert.throws(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([image], undefined, [validAsset, duplicate]))), /Invalid design asset version/u);
});

test('Edit tokens change on undo, redo, replacement and Save As while no-op edits retain the token', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const initial = model.version;
	commands.addShape('rectangle', { x: 0, y: 0 });
	const edited = model.version;
	const identity = model.value.documentId;
	assert.notEqual(initial, edited);
	model.applyEdit(model.value.shapes);
	assert.equal(model.version, edited);
	model.undo();
	assert.notEqual(model.version, initial);
	model.redo();
	assert.notEqual(model.version, edited);
	const replacement = model.version;
	model.replace(model.value);
	assert.notEqual(model.version, replacement);
	commands.addShape('ellipse', { x: 0, y: 0 });
	const copyId = generateUuid();
	model.changeIdentity(copyId);
	model.undo();
	assert.equal(model.value.documentId, copyId);
	assert.notEqual(model.value.documentId, identity);
	assert.equal(model.value.shapes.length, 1);
});

test('Rotated frames use the same local coordinates for rendering, input and hit testing', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	commands.addFrame({ x: 500, y: 400 });
	commands.updateGeometry(model.value.shapes[0], 'rotation', 90);
	const id = commands.addShape('rectangle', { x: 500, y: 500 });
	const entry = getDesignShapeEntries(model.value.shapes).find(entry => entry.shape.id === id)!;
	assert.deepEqual([entry.world.x, entry.world.y, entry.world.rotation], [440, 460, 0]);
	assert.equal(hitTestDesignShapes(model.value.shapes, { x: 500, y: 500 })!.id, id);
	const animated: DesignShape = { ...entry.world, id: generateUuid(), motion: { duration: 1000, loop: false, keyframes: [{ offset: 0, x: 440, y: 460, rotation: 0, opacity: 1 }, { offset: 1, x: 480, y: 460, rotation: 45, opacity: 1 }] } };
	commands.insertShape(animated);
	const stored = getDesignShapeEntries(model.value.shapes).find(entry => entry.shape.id === animated.id)!;
	assert.deepEqual(stored.world.motion, animated.motion);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Ungrouping scaled frames preserves their visible contents and nested text', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const frameId = commands.addFrame({ x: 0, y: 0 });
	const textId = commands.addShape('text', { x: 0, y: 0 }, 'Product');
	const otherId = commands.addShape('rectangle', { x: 1000, y: 0 });
	const groupId = commands.group(new Set([frameId, otherId]))!;
	commands.updateGeometry(model.value.shapes[0], 'width', model.value.shapes[0].width * 2);
	commands.ungroup(groupId);
	const frame = model.value.shapes.find(shape => shape.id === frameId)!;
	assert.equal(frame.kind, 'frame');
	assert.equal(frame.width, 1280);
	const text = flattenDesignShapes(model.value.shapes).find(shape => shape.id === textId)!;
	assert.equal(text.kind, 'text');
	if (text.kind !== 'text') { throw new Error('Expected text'); }
	assert.equal(text.width, 480);
	assert.equal(text.fontSize, 48);
	assert.equal(text.x, 400);
	model.undo();
	assert.equal(model.value.shapes[0].kind, 'group');
});
