import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	documentFromShapes,
	flattenDesignShapes,
	parseDesignDocument,
	serializeDesignDocument,
	type DesignAsset,
	type DesignAutoLayout,
	type DesignShape,
} from '../../contrib/creator/common/model/document.js';
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
		assert.throws(
			() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [{ ...model.value.shapes[0], fill }] })),
			TypeError,
		);
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
	const motion = {
		duration: 1000,
		loop: false,
		keyframes: [
			{ offset: 0, x: 0, y: 0, rotation: 0, opacity: 1 },
			{ offset: 1, x: 100, y: 200, rotation: 90, opacity: 0 },
		],
	};
	commands.updateShape({ ...shape, motion });
	assert.deepEqual(sampleDesignMotion(model.value.shapes[0], 500), {
		offset: 0.5,
		x: 50,
		y: 100,
		rotation: 45,
		opacity: 0.5,
	});
	for (const invalid of [
		{ ...motion, duration: 0 },
		{ ...motion, loop: 'true' },
		{ ...motion, keyframes: [...motion.keyframes].reverse() },
		{ ...motion, keyframes: [{ ...motion.keyframes[0], opacity: 2 }, motion.keyframes[1]] },
		{ ...motion, keyframes: [motion.keyframes[0], motion.keyframes[0], motion.keyframes[1]] },
	]) {
		assert.throws(
			() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [{ ...shape, motion: invalid }] })),
			TypeError,
		);
	}
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
	]) {
		assert.throws(() => parseDesignDocument(JSON.stringify(document)), TypeError);
	}
});

test('Design hit testing respects paint order, ellipse contours and rotation', () => {
	const rectangle: DesignShape = {
		id: 'back',
		kind: 'rectangle',
		x: -100,
		y: -100,
		width: 200,
		height: 200,
		rotation: 0,
		fill: '#808080',
	};
	const ellipse: DesignShape = {
		...rectangle,
		id: 'front',
		kind: 'ellipse',
		x: 0,
		y: 0,
		width: 100,
		height: 40,
		rotation: 90,
	};
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
	assert.ok(
		Math.abs(text.x + text.width / 2 - (100 + group.width - ((child.y + child.height / 2) * 2 - group.height))) <
			1e-8,
	);
	assert.ok(
		Math.abs(text.y + text.height / 2 - (200 + group.height + ((child.x + child.width / 2) * 2 - group.width))) <
			1e-8,
	);
	assert.deepEqual(
		[text.width, text.height, text.rotation, text.fontSize],
		[child.width * 2, child.height * 2, 90, 48],
	);
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
		{ ...text, text: null },
		{ ...text, fontSize: -1 },
		{ ...path, nodes: [] },
		{ ...path, strokeWidth: -1 },
		{ ...path, closed: 'false' },
		{ ...path, nodes: [{ ...path.nodes[0], incoming: { x: Infinity, y: 0 } }, path.nodes[1]] },
		{ ...group, children: [text, text] },
		{ ...group, height: group.height * 2 },
	]) {
		assert.throws(() => parseDesignDocument(JSON.stringify({ version: 1, shapes: [shape] })), TypeError);
	}
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
	assert.deepEqual(
		flattenDesignShapes(model.value.shapes).find(shape => shape.id === childId),
		original,
	);
	const groupId = commands.group(new Set([childId, textId]))!;
	assert.ok(groupId);
	assert.deepEqual(commands.ungroup(groupId), [childId, textId]);
	assert.deepEqual(
		flattenDesignShapes(model.value.shapes).find(shape => shape.id === childId),
		original,
	);
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
	const asset: DesignAsset = {
		id: generateUuid(),
		name: 'product.png',
		versions: [
			{
				id: generateUuid(),
				sha256: 'a'.repeat(64),
				path: `assets/${'a'.repeat(64)}`,
				mediaType: 'image/png',
				width: 800,
				height: 600,
			},
		],
	};
	const image: DesignShape = {
		id: generateUuid(),
		kind: 'image',
		assetId: asset.id,
		assetVersionId: asset.versions[0].id,
		crop: { x: 0, y: 0, width: 1, height: 1 },
		x: 0,
		y: 0,
		width: 400,
		height: 300,
		rotation: 0,
		fill: '#ffffff',
	};
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
	type Manifest = {
		artifacts: Record<string, { roots: string[]; objects: Record<string, Record<string, unknown>> }>;
	};
	for (const mutate of [
		(value: Manifest) => {
			value.artifacts[model.value.artifactId].objects[frameId].children = [frameId];
		},
		(value: Manifest) => {
			value.artifacts[model.value.artifactId].roots.push(childId);
		},
		(value: Manifest) => {
			value.artifacts[model.value.artifactId].objects[frameId].children = [];
		},
		(value: Manifest) => {
			Object.assign(value.artifacts[model.value.artifactId].objects[childId], {
				kind: 'image',
				assetId: generateUuid(),
				assetVersionId: generateUuid(),
				crop: { x: 0, y: 0, width: 1, height: 1 },
			});
		},
	]) {
		const value = JSON.parse(source) as Manifest;
		mutate(value);
		assert.throws(() => parseDesignDocument(JSON.stringify(value)), TypeError);
	}
	const image: DesignShape = {
		id: generateUuid(),
		kind: 'image',
		assetId: generateUuid(),
		assetVersionId: generateUuid(),
		crop: { x: 0, y: 0, width: 1, height: 1 },
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		rotation: 0,
		fill: '#ffffff',
	};
	const asset: DesignAsset = {
		id: image.assetId,
		name: 'image',
		versions: [
			{
				id: image.assetVersionId,
				sha256: 'a'.repeat(64),
				path: '../external.png',
				mediaType: 'image/png',
				width: 1,
				height: 1,
			},
		],
	};
	assert.throws(
		() => parseDesignDocument(serializeDesignDocument(documentFromShapes([image], undefined, [asset]))),
		TypeError,
	);
	const validAsset = {
		...asset,
		versions: asset.versions.map(version => ({ ...version, path: `assets/${version.sha256}` })),
	};
	const duplicate = { ...validAsset, id: generateUuid() };
	assert.throws(
		() =>
			parseDesignDocument(
				serializeDesignDocument(documentFromShapes([image], undefined, [validAsset, duplicate])),
			),
		/Invalid design asset version/u,
	);
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
	const animated: DesignShape = {
		...entry.world,
		id: generateUuid(),
		motion: {
			duration: 1000,
			loop: false,
			keyframes: [
				{ offset: 0, x: 440, y: 460, rotation: 0, opacity: 1 },
				{ offset: 1, x: 480, y: 460, rotation: 45, opacity: 1 },
			],
		},
	};
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
	if (text.kind !== 'text') {
		throw new Error('Expected text');
	}
	assert.equal(text.width, 480);
	assert.equal(text.fontSize, 48);
	assert.equal(text.x, 400);
	model.undo();
	assert.equal(model.value.shapes[0].kind, 'group');
});

function layoutRectangle(x = 0, y = 0, width = 40, height = 20): DesignShape {
	return { id: generateUuid(), kind: 'rectangle', x, y, width, height, rotation: 0, fill: '#808080' };
}

function layoutFrame(
	children: readonly DesignShape[],
	autoLayout?: DesignAutoLayout,
): Extract<DesignShape, { kind: 'frame' }> {
	return {
		id: generateUuid(),
		kind: 'frame',
		x: 0,
		y: 0,
		width: 300,
		height: 200,
		rotation: 0,
		fill: '#ffffff',
		clip: true,
		children,
		...(autoLayout ? { autoLayout } : {}),
	};
}

const rowLayout: DesignAutoLayout = {
	direction: 'horizontal',
	gap: 10,
	padding: { top: 5, right: 20, bottom: 15, left: 10 },
	align: 'center',
	justify: 'start',
	width: 'fixed',
	height: 'fixed',
};

test('Design auto layout wraps siblings, reflows edits and round trips one undoable document', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const first = layoutRectangle(10, 30);
	const second = layoutRectangle(90, 80, 60, 30);
	model.replace(documentFromShapes([first, second]));
	const id = commands.addAutoLayout(new Set([first.id, second.id]))!;
	let frame = model.value.shapes[0];
	assert.equal(frame.kind, 'frame');
	if (frame.kind !== 'frame') {
		return;
	}
	assert.deepEqual([frame.id, frame.x, frame.y, frame.width, frame.height], [id, 10, 30, 136, 54]);
	assert.deepEqual(
		frame.children.map(({ x, y, width, height }) => [x, y, width, height]),
		[
			[12, 12, 40, 20],
			[64, 12, 60, 30],
		],
	);
	commands.updateGeometry(frame.children[0], 'width', 80);
	frame = model.value.shapes[0] as typeof frame;
	assert.equal(frame.width, 176);
	assert.equal(frame.children[1].x, 104);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(frame.autoLayout!.padding));
	const version = model.version;
	model.applyEdit(model.value.shapes);
	assert.equal(model.version, version, 'resolved layout is idempotent');
	model.undo();
	assert.equal(model.value.shapes[0].width, 136);
	model.undo();
	assert.deepEqual(model.value.shapes, [first, second]);
	model.redo();
	assert.equal(model.value.shapes[0].id, id);
});

test('Design nested auto layout allocates fill space and carries child animation with reflow', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const fixed = layoutRectangle();
	const child: DesignShape = {
		...layoutRectangle(),
		motion: {
			duration: 100,
			loop: false,
			keyframes: [
				{ offset: 0, x: 0, y: 0, rotation: 0, opacity: 1 },
				{ offset: 1, x: 20, y: 10, rotation: 0, opacity: 1 },
			],
		},
	};
	const nested = {
		...layoutFrame([child], { ...rowLayout, width: 'hug', height: 'hug' }),
		sizing: { width: 'fill', height: 'fill' },
	} as const;
	const frame = layoutFrame([fixed, nested], rowLayout);
	model.applyEdit([frame]);
	let resolved = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		resolved.children.map(({ x, y, width, height }) => [x, y, width, height]),
		[
			[10, 85, 40, 20],
			[60, 5, 220, 180],
		],
	);
	let inner = resolved.children[1] as typeof frame;
	assert.deepEqual(
		inner.children[0].motion!.keyframes.map(({ x, y }) => [x, y]),
		[
			[10, 75],
			[30, 85],
		],
	);
	commands.updateGeometry(resolved, 'width', 400);
	resolved = model.value.shapes[0] as typeof frame;
	assert.equal(resolved.children[1].width, 320);
	inner = resolved.children[1] as typeof frame;
	assert.equal(inner.children[0].motion!.keyframes[1].x, 30, 'reflow never accumulates animation offsets');
	const serialized = serializeDesignDocument(model.value);
	model.applyEdit(model.value.shapes);
	assert.equal(serializeDesignDocument(model.value), serialized);
});

test('Design vertical hugging frames propagate nested content edits and distribute free space', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const child = layoutRectangle();
	const inner = layoutFrame([child], { ...rowLayout, width: 'hug', height: 'hug' });
	const outer = layoutFrame([inner, layoutRectangle()], {
		...rowLayout,
		direction: 'vertical',
		width: 'hug',
		height: 'hug',
	});
	model.applyEdit([outer]);
	let resolved = model.value.shapes[0] as typeof outer;
	assert.deepEqual([resolved.width, resolved.height], [100, 90]);
	commands.updateGeometry((resolved.children[0] as typeof inner).children[0], 'height', 60);
	resolved = model.value.shapes[0] as typeof outer;
	assert.equal(resolved.height, 130);
	assert.equal(resolved.children[1].y, 95);
	commands.updateShape({
		...resolved,
		height: 200,
		autoLayout: { ...resolved.autoLayout!, height: 'fixed', justify: 'space-between' },
	});
	resolved = model.value.shapes[0] as typeof outer;
	assert.equal(resolved.children[1].y, 165);
	commands.removeShapes(new Set([child.id]));
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Design frame constraints resize nested contents in local coordinates and undo atomically', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const children = (['start', 'center', 'end', 'stretch', 'scale'] as const).map(mode => ({
		...layoutRectangle(30, 40, 60, 50),
		constraints: { horizontal: mode, vertical: mode },
	}));
	const inner = {
		...layoutFrame([{ ...layoutRectangle(10, 10), constraints: { horizontal: 'end', vertical: 'end' } }]),
		width: 100,
		height: 100,
		constraints: { horizontal: 'stretch', vertical: 'stretch' },
	} as const;
	const frame = { ...layoutFrame([...children, inner]), rotation: 90 };
	model.replace(documentFromShapes([frame]));
	commands.updateShape({ ...frame, width: 600, height: 400 });
	const resized = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		resized.children.slice(0, 5).map(({ x, y, width, height }) => [x, y, width, height]),
		[
			[30, 40, 60, 50],
			[180, 140, 60, 50],
			[330, 240, 60, 50],
			[30, 40, 360, 250],
			[60, 80, 120, 100],
		],
	);
	const resizedInner = resized.children[5] as typeof inner;
	assert.deepEqual(
		[resizedInner.width, resizedInner.height, resizedInner.children[0].x, resizedInner.children[0].y],
		[400, 300, 310, 210],
	);
	model.undo();
	assert.deepEqual(model.value.shapes, [frame]);
	model.redo();
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Design alignment uses rotated bounds, distributes equal gaps and respects sibling ownership', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const shapes = [layoutRectangle(0, 30, 20, 20), layoutRectangle(50, 70, 40, 20), layoutRectangle(130, 10, 30, 20)];
	model.replace(documentFromShapes(shapes));
	const ids = new Set(shapes.map(shape => shape.id));
	commands.distribute(ids, 'horizontal');
	assert.deepEqual(
		model.value.shapes.map(shape => shape.x),
		[0, 55, 130],
	);
	commands.align(ids, 'vertical', 'end');
	assert.deepEqual(
		model.value.shapes.map(shape => shape.y),
		[70, 70, 70],
	);
	const child = { ...layoutRectangle(50, 40, 40, 20), rotation: 90 };
	const frame = layoutFrame([child]);
	model.replace(documentFromShapes([frame, shapes[0]]));
	commands.align(new Set([child.id]), 'horizontal', 'start');
	assert.equal((model.value.shapes[0] as typeof frame).children[0].x, -10);
	const version = model.version;
	commands.align(new Set([child.id, shapes[0].id]), 'vertical', 'center');
	assert.equal(model.version, version, 'cross-parent selections do not mutate geometry');
});

test('Design duplicates complete subtrees once and reorders stable selections without reversing them', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const child = layoutRectangle();
	const frame = { ...layoutFrame([child]), name: 'Card' };
	const a = layoutRectangle();
	const b = layoutRectangle();
	const c = layoutRectangle();
	model.replace(documentFromShapes([a, b, frame, c]));
	const copies = commands.duplicate(new Set([frame.id, child.id]));
	assert.equal(copies.length, 1);
	const copy = model.value.shapes[3] as typeof frame;
	assert.deepEqual([copy.name, copy.x, copy.y, copy.children[0].x], ['Card', 20, 20, 0]);
	assert.notEqual(copy.id, frame.id);
	assert.notEqual(copy.children[0].id, child.id);
	assert.equal(new Set(flattenDesignShapes(model.value.shapes).map(shape => shape.id)).size, 7);
	model.undo();
	commands.reorder(new Set([a.id, frame.id]), 'front');
	assert.deepEqual(
		model.value.shapes.map(shape => shape.id),
		[b.id, c.id, a.id, frame.id],
	);
	commands.reorder(new Set([a.id, frame.id]), 'backward');
	assert.deepEqual(
		model.value.shapes.map(shape => shape.id),
		[b.id, a.id, frame.id, c.id],
	);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Design files reject malformed layout, sizing and constraints at the persistence boundary', () => {
	const frame = layoutFrame([layoutRectangle()], rowLayout);
	const document = documentFromShapes([frame]);
	for (const override of [
		{ autoLayout: { ...rowLayout, gap: -1 } },
		{ autoLayout: { ...rowLayout, padding: { ...rowLayout.padding, left: null } } },
		{ autoLayout: { ...rowLayout, padding: { ...rowLayout.padding, extra: 2 } } },
		{ autoLayout: { ...rowLayout, width: 'fill' } },
		{ autoLayout: { ...rowLayout, direction: 'diagonal' } },
		{ autoLayout: { ...rowLayout, justify: 'invalid' } },
		{ autoLayout: { ...rowLayout, direction: ['horizontal'] } },
		{ sizing: { width: ['fixed'], height: 'fixed' } },
		{ constraints: { horizontal: ['end'], vertical: 'start' } },
		{ sizing: { width: 'stretch', height: 'fixed' } },
		{ constraints: { horizontal: 'center' } },
		{ name: 42 },
	]) {
		const serialized = JSON.parse(serializeDesignDocument(document));
		Object.assign(serialized.artifacts[document.artifactId].objects[frame.id], override);
		assert.throws(() => parseDesignDocument(JSON.stringify(serialized)), TypeError);
	}
});

test('Design wrap breaks horizontal rows and vertical columns in layer order and hugs the result', () => {
	for (const horizontal of [true, false]) {
		using model = new DesignModel();
		const children = [20, 30, 40].map(size =>
			layoutRectangle(0, 0, horizontal ? 100 : size, horizontal ? size : 100),
		);
		const layout: DesignAutoLayout = {
			...rowLayout,
			direction: horizontal ? 'horizontal' : 'vertical',
			wrap: true,
			crossGap: 7,
			padding: { top: 10, right: 10, bottom: 10, left: 10 },
			align: 'start',
			width: horizontal ? 'fixed' : 'hug',
			height: horizontal ? 'hug' : 'fixed',
		};
		const frame = { ...layoutFrame(children, layout), width: 240, height: 240 };
		model.applyEdit([frame]);
		let resolved = model.value.shapes[0] as typeof frame;
		assert.deepEqual([resolved.width, resolved.height], horizontal ? [240, 97] : [97, 240]);
		assert.deepEqual(
			resolved.children.map(child => (horizontal ? [child.x, child.y] : [child.y, child.x])),
			[
				[10, 10],
				[120, 10],
				[10, 47],
			],
		);
		new DocumentCommands(model).updateGeometry(resolved, horizontal ? 'width' : 'height', 130);
		resolved = model.value.shapes[0] as typeof frame;
		assert.equal(resolved[horizontal ? 'height' : 'width'], 124);
		assert.deepEqual(
			resolved.children.map(child => (horizontal ? [child.x, child.y] : [child.y, child.x])),
			[
				[10, 10],
				[10, 37],
				[10, 74],
			],
		);
		const version = model.version;
		model.applyEdit(model.value.shapes);
		assert.equal(model.version, version, 'line breaks do not depend on previous positions');
	}
});

test('Design size limits clamp fixed and hugging dimensions, including max-driven wrapping', () => {
	using model = new DesignModel();
	const layout: DesignAutoLayout = {
		...rowLayout,
		wrap: true,
		crossGap: 8,
		padding: { top: 10, right: 10, bottom: 10, left: 10 },
		align: 'start',
		width: 'hug',
		height: 'hug',
	};
	model.applyEdit([
		{
			...layoutFrame(
				Array.from({ length: 3 }, () => layoutRectangle(0, 0, 80, 20)),
				layout,
			),
			sizeLimits: { minWidth: 100, maxWidth: 200, minHeight: 80 },
		},
	]);
	let frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual([frame.width, frame.height, frame.children[2].y], [200, 80, 38]);
	const commands = new DocumentCommands(model);
	commands.updateGeometry(frame, 'width', 500);
	frame = model.value.shapes[0] as typeof frame;
	assert.equal(frame.width, 200);
	assert.equal(frame.autoLayout?.width, 'fixed');
	commands.updateGeometry(frame, 'width', 30);
	frame = model.value.shapes[0] as typeof frame;
	assert.equal(frame.width, 100);
	assert.equal(frame.height, 96);
	model.undo();
	assert.equal(model.value.shapes[0].width, 200);
	model.redo();
	assert.equal(model.value.shapes[0].width, 100);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(frame.sizeLimits));
});

test('Design fill redistributes bounded shares and preserves minimum sizes when space runs out', () => {
	using model = new DesignModel();
	const layout: DesignAutoLayout = { ...rowLayout, gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
	const children: DesignShape[] = [{ minWidth: 150 }, { maxWidth: 40 }, {}].map(sizeLimits => ({
		...layoutRectangle(),
		sizing: { width: 'fill', height: 'fixed' },
		sizeLimits,
	}));
	model.applyEdit([layoutFrame(children, layout)]);
	let frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual(
		frame.children.map(child => child.width),
		[150, 40, 110],
	);
	new DocumentCommands(model).updateGeometry(frame, 'width', 100);
	frame = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		frame.children.map(child => child.width),
		[150, 0.001, 0.001],
	);
	new DocumentCommands(model).updateGeometry(frame, 'width', 600);
	frame = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		frame.children.map(child => child.width),
		[280, 40, 280],
	);
});

test('Design wrapping fill children use minimum dimensions for stable line breaking', () => {
	using model = new DesignModel();
	const children: DesignShape[] = Array.from({ length: 3 }, () => ({
		...layoutRectangle(),
		sizing: { width: 'fill', height: 'fixed' },
		sizeLimits: { minWidth: 80 },
	}));
	const layout: DesignAutoLayout = {
		...rowLayout,
		wrap: true,
		align: 'start',
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		height: 'hug',
	};
	model.applyEdit([{ ...layoutFrame(children, layout), width: 250 }]);
	let frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual(
		frame.children.map(child => [child.x, child.y, child.width]),
		[
			[0, 0, 120],
			[130, 0, 120],
			[0, 30, 250],
		],
	);
	const version = model.version;
	model.applyEdit(model.value.shapes);
	assert.equal(model.version, version);
	new DocumentCommands(model).updateGeometry(frame, 'width', 500);
	frame = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		frame.children.map(child => [child.y, child.width]),
		[
			[0, 160],
			[0, 160],
			[0, 160],
		],
	);
});

test('Design nested wrap remeasures hug height after receiving a fill width', () => {
	using model = new DesignModel();
	const inner: DesignShape = {
		...layoutFrame(
			Array.from({ length: 3 }, () => layoutRectangle(0, 0, 80, 20)),
			{
				...rowLayout,
				wrap: true,
				height: 'hug',
				align: 'start',
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			},
		),
		sizing: { width: 'fill', height: 'fixed' },
	};
	const outer = {
		...layoutFrame([inner], {
			...rowLayout,
			height: 'hug',
			align: 'start',
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
		}),
		width: 170,
	};
	model.applyEdit([outer]);
	let resolved = model.value.shapes[0] as typeof outer;
	assert.deepEqual([resolved.width, resolved.height, resolved.children[0].height], [170, 50, 50]);
	new DocumentCommands(model).updateGeometry(resolved, 'width', 260);
	resolved = model.value.shapes[0] as typeof outer;
	assert.deepEqual([resolved.height, resolved.children[0].height], [20, 20]);
});

const gridLayout: DesignAutoLayout = {
	...rowLayout,
	direction: 'grid',
	gap: 10,
	crossGap: 8,
	padding: { top: 10, right: 10, bottom: 10, left: 10 },
	grid: {
		columns: [
			{ sizing: 'fill', value: 1 },
			{ sizing: 'fill', value: 2 },
		],
		rows: [{ sizing: 'fill', value: 1 }],
		autoRows: true,
		positioning: 'auto',
	},
};

test('Design grid allocates fractional tracks, automatic rows and spans without overlapping cells', () => {
	using model = new DesignModel();
	const children: DesignShape[] = Array.from({ length: 4 }, (_, index) => ({
		...layoutRectangle(),
		sizing: { width: 'fill', height: 'fill' },
		...(index === 1 ? { gridCell: { columnSpan: 2 } } : {}),
	}));
	model.applyEdit([{ ...layoutFrame(children, gridLayout), width: 330, height: 216 }]);
	let frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual(
		frame.children.map(child => [child.x, child.y, child.width, child.height]),
		[
			[10, 10, 100, 60],
			[10, 78, 310, 60],
			[10, 146, 100, 60],
			[120, 146, 200, 60],
		],
	);
	const commands = new DocumentCommands(model);
	commands.removeShapes(new Set([children[1].id]));
	frame = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		frame.children.map(child => [child.x, child.y, child.height]),
		[
			[10, 10, 94],
			[120, 10, 94],
			[10, 112, 94],
		],
	);
	commands.removeShapes(new Set([children[3].id]));
	frame = model.value.shapes[0] as typeof frame;
	assert.equal(frame.children[0].height, 196);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(frame.autoLayout!.grid!.columns[0]));
	const version = model.version;
	model.applyEdit(model.value.shapes);
	assert.equal(model.version, version);
});

test('Design grid combines fixed, hug and fill tracks and aligns bounded children inside their cells', () => {
	using model = new DesignModel();
	const children: DesignShape[] = [
		layoutRectangle(0, 0, 20, 30),
		layoutRectangle(0, 0, 60, 20),
		{
			...layoutRectangle(),
			sizing: { width: 'fill', height: 'fill' },
			sizeLimits: { maxWidth: 50, maxHeight: 40 },
			gridCell: { horizontal: 'end', vertical: 'center' },
		},
	];
	const layout: DesignAutoLayout = {
		...gridLayout,
		grid: {
			...gridLayout.grid!,
			columns: [{ sizing: 'fixed', value: 60 }, { sizing: 'hug' }, { sizing: 'fill', value: 1 }],
		},
	};
	model.applyEdit([layoutFrame(children, layout)]);
	const frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual(
		frame.children.map(child => [child.x, child.y, child.width, child.height]),
		[
			[10, 10, 20, 30],
			[80, 10, 60, 20],
			[240, 80, 50, 40],
		],
	);
	const commands = new DocumentCommands(model);
	commands.align(new Set([children[0].id, children[1].id]), 'horizontal', 'center');
	const aligned = model.value.shapes[0] as typeof frame;
	assert.deepEqual(
		aligned.children.slice(0, 2).map(child => child.x),
		[30, 80],
	);
	assert.equal(commands.canArrange(new Set(children.map(child => child.id)), 3), false);
});

test('Design manual grid preserves empty cells and resolves collisions while growing rows', () => {
	using model = new DesignModel();
	const layout: DesignAutoLayout = {
		...gridLayout,
		grid: { ...gridLayout.grid!, positioning: 'manual', autoRows: false, rows: [{ sizing: 'fixed', value: 40 }] },
	};
	const children: DesignShape[] = [
		{ ...layoutRectangle(), gridCell: { row: 2, column: 2, rowSpan: 2 } },
		{ ...layoutRectangle(), gridCell: { row: 2, column: 2 } },
		{ ...layoutRectangle(), gridCell: { row: 1, column: 1 } },
	];
	model.applyEdit([{ ...layoutFrame(children, layout), height: 232 }]);
	const frame = model.value.shapes[0] as Extract<DesignShape, { kind: 'frame' }>;
	assert.deepEqual(
		frame.children.map(child => [child.x, child.y]),
		[
			[110, 58],
			[10, 144],
			[10, 10],
		],
	);
	new DocumentCommands(model).removeShapes(new Set([children[2].id]));
	assert.equal((model.value.shapes[0] as typeof frame).children[0].y, 58);
});

test('Design persistence rejects malformed grid, wrapping and dimension bounds', () => {
	const frame = layoutFrame([layoutRectangle()], gridLayout);
	const document = documentFromShapes([frame]);
	for (const properties of [
		{ sizeLimits: { minWidth: -1 } },
		{ sizeLimits: { maxWidth: 0 } },
		{ sizeLimits: { minWidth: 100, maxWidth: 50 } },
		{ sizeLimits: { maxHeight: '100' } },
		{ sizeLimits: { extra: 1 } },
		{ gridCell: { rowSpan: 0 } },
		{ gridCell: { column: 1.5 } },
		{ gridCell: { columnSpan: 1001 } },
		{ gridCell: { horizontal: ['end'] } },
		{ autoLayout: { ...gridLayout, grid: undefined } },
		{ autoLayout: { ...gridLayout, wrap: true } },
		{ autoLayout: { ...rowLayout, wrap: 'yes' } },
		{ autoLayout: { ...rowLayout, crossGap: -1 } },
		{ autoLayout: { ...gridLayout, grid: { ...gridLayout.grid, columns: [] } } },
		{ autoLayout: { ...gridLayout, grid: { ...gridLayout.grid, rows: [{ sizing: 'fill', value: 0 }] } } },
		{ autoLayout: { ...gridLayout, grid: { ...gridLayout.grid, rows: [{ sizing: 'hug', value: 2 }] } } },
		{ autoLayout: { ...gridLayout, grid: { ...gridLayout.grid, positioning: ['auto'] } } },
	]) {
		const file = JSON.parse(serializeDesignDocument(document));
		Object.assign(file.artifacts[document.artifactId].objects[frame.id], properties);
		assert.throws(() => parseDesignDocument(JSON.stringify(file)), TypeError);
	}
});
