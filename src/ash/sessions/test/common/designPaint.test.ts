import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import {
	createDesignPaint,
	designGradientPosition,
	designPaints,
	parseDesignPaints,
	sampleDesignPaint,
	withDesignPaintColor,
	type DesignPaint,
} from '../../contrib/creator/common/model/designPaint.js';
import {
	documentFromShapes,
	flattenDesignShapes,
	parseDesignDocument,
	serializeDesignDocument,
	type DesignShape,
} from '../../contrib/creator/common/model/document.js';
const rectangle = (): DesignShape => ({
	id: generateUuid(),
	kind: 'rectangle',
	x: 0,
	y: 0,
	width: 200,
	height: 100,
	rotation: 0,
	fill: '#3366ff',
});
const gradient = (type: Exclude<DesignPaint['type'], 'solid'> = 'linear') =>
	createDesignPaint(type, '#ff0000') as Exclude<DesignPaint, { type: 'solid' }>;
test('Paint stacks preserve order, empty fills, immutable history and legacy single-color files', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		source = rectangle();
	model.replace(documentFromShapes([source]));
	assert.equal(designPaints(source)[0].type, 'solid');
	assert.equal(withDesignPaintColor(source, undefined, undefined, '#112233').fill, '#112233');
	const fills: DesignPaint[] = [
		{ ...gradient(), opacity: 0.4, blendMode: 'multiply' },
		{ ...createDesignPaint('solid'), visible: false },
	];
	commands.updateShape({ ...source, fills, blendMode: 'normal' });
	const painted = model.value.shapes[0];
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(painted.fills));
	assert.ok(Object.isFrozen((painted.fills![0] as ReturnType<typeof gradient>).stops[0]));
	assert.ok(Object.isFrozen((painted.fills![0] as ReturnType<typeof gradient>).handles[0]));
	model.undo();
	assert.deepEqual(model.value.shapes[0], source);
	model.redo();
	assert.deepEqual(model.value.shapes[0], painted);
	commands.updateShape({ ...painted, fills: [] });
	assert.deepEqual(designPaints(model.value.shapes[0]), []);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)).shapes[0].fills, []);
});
test('Gradient coordinates use the full affine axes for linear, elliptical, clockwise angular and diamond fills', () => {
	const handles = [
		{ x: 0.2, y: 0.3 },
		{ x: 0.6, y: 0.5 },
		{ x: 0.1, y: 0.8 },
	] as const;
	const p = { x: 0.2 + 0.4 * 0.3 - 0.1 * 0.4, y: 0.3 + 0.2 * 0.3 + 0.5 * 0.4 };
	for (const [type, expected] of [
		['linear', 0.3],
		['radial', 0.5],
		['diamond', 0.7],
		['angular', Math.atan2(0.4, 0.3) / (2 * Math.PI)],
	] as const) {
		assert.ok(Math.abs(designGradientPosition({ ...gradient(type), handles }, p) - expected) < 1e-10);
	}
	assert.equal(designGradientPosition(gradient('angular'), { x: 0.5, y: 1 }), 0.25);
	assert.equal(designGradientPosition(gradient('angular'), { x: 0.5, y: 0 }), 0.75);
});
test('Gradient interpolation premultiplies transparent colors and retains coincident hard stops', () => {
	const paint = gradient(),
		stops = [
			{ id: generateUuid(), position: 0, color: '#ff000000' },
			{ id: generateUuid(), position: 1, color: '#0000ff' },
		];
	assert.deepEqual(sampleDesignPaint({ ...paint, stops }, 0.5), [0, 0, 255, 127.5]);
	const hard = {
		...paint,
		stops: [
			{ ...stops[0], position: 0.5, color: '#ff0000' },
			{ ...stops[1], position: 0.5 },
		],
	};
	assert.deepEqual(sampleDesignPaint(hard, 0.499), [255, 0, 0, 255]);
	assert.deepEqual(sampleDesignPaint(hard, 0.5), [0, 0, 255, 255]);
	assert.deepEqual(parseDesignPaints([hard]), [hard]);
});
test('Persistence rejects invalid paint identities, colors, blend scopes, stops and degenerate axes', () => {
	const paint = gradient();
	for (const bad of [
		[paint, paint],
		[{ ...paint, opacity: -1 }],
		[{ ...paint, blendMode: 'pass-through' }],
		[{ ...paint, visible: 1 }],
		[{ ...paint, handles: [paint.handles[0], paint.handles[0], paint.handles[2]] }],
		[{ ...paint, stops: [paint.stops[0]] }],
		[{ ...paint, stops: paint.stops.slice().reverse() }],
		[{ ...paint, stops: [paint.stops[0], paint.stops[0]] }],
		[{ ...paint, stops: [{ ...paint.stops[0], color: 'url(https://example.com)' }, paint.stops[1]] }],
		[{ ...paint, type: 'mesh' }],
		[{ ...paint, extra: true }],
	]) {
		assert.throws(() => parseDesignPaints(bad), /Invalid design fill/u);
	}
	assert.throws(() =>
		parseDesignDocument(
			JSON.stringify({ ...documentFromShapes([]), shapes: [{ ...rectangle(), blendMode: 'invalid' }] }),
		),
	);
});
test('Fill styles and library instances retain stacks, inherit updates and isolate local overrides', () => {
	using source = new DesignModel();
	const author = new DocumentCommands(source),
		shape = { ...rectangle(), fills: [gradient(), createDesignPaint('solid')] };
	const main: DesignShape = {
		...rectangle(),
		kind: 'frame',
		clip: false,
		children: [shape],
		component: { kind: 'main' },
	};
	source.applyEdit([main]);
	const find = (model: DesignModel, id: string) =>
		flattenDesignShapes(model.value.shapes).find(shape => shape.id === id)!;
	const style = author.resources.createStyle(find(source, shape.id), 'fill', 'Gradient');
	using consumer = new DesignModel();
	const commands = new DocumentCommands(consumer);
	const publish = (version: string) =>
		commands.resources.acceptLibrary({
			id: source.value.documentId,
			name: 'Paints',
			uri: 'file:///paint.ash-design-library',
			version: version.repeat(64),
			enabled: true,
			document: source.value,
		});
	publish('a');
	const instance = commands.components.createInstance(main.id)!;
	const child = (find(consumer, instance) as Extract<DesignShape, { kind: 'frame' }>).children[0];
	assert.deepEqual(child.fills, shape.fills);
	author.resources.updateStyle(style, { ...shape, fills: [gradient('radial')] });
	publish('b');
	assert.equal(find(consumer, child.id).fills![0].type, 'radial');
	commands.updateShape({
		...find(consumer, child.id),
		fills: [createDesignPaint('solid', '#00ff00')],
		blendMode: 'screen',
	});
	author.resources.updateStyle(style, { ...shape, fills: [gradient('diamond')] });
	publish('c');
	assert.equal(find(consumer, child.id).fills![0].type, 'solid');
	commands.components.reset(child.id);
	assert.equal(find(consumer, child.id).fills![0].type, 'diamond');
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(consumer.value)), consumer.value);
});
test('Color variables target the first paint without duplicating legacy fallback state or changing other stops', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		source = { ...rectangle(), fills: [gradient()] };
	model.applyEdit([source]);
	const resources = commands.resources,
		collection = resources.addCollection('Theme'),
		mode = resources.value.collections[0].defaultMode,
		color = resources.addVariable(collection, 'Accent', 'color');
	resources.setVariableValue(color, mode, '#112233');
	resources.bind(new Set([source.id]), 'fill', color);
	const painted = model.value.shapes[0],
		paint = painted.fills![0] as ReturnType<typeof gradient>;
	assert.equal(painted.fill, source.fill);
	assert.equal(paint.stops[0].color, '#112233');
	assert.equal(paint.stops[1].color, '#ffffff');
	commands.updateShape(withDesignPaintColor(painted, paint.id, paint.stops[0].id, '#aabbcc'));
	resources.setVariableValue(color, mode, '#000000');
	assert.equal((model.value.shapes[0].fills![0] as ReturnType<typeof gradient>).stops[0].color, '#aabbcc');
	assert.equal(model.value.shapes[0].bindings?.fill, undefined);
});

test('Color edits recover stale inspector identities and create a paint when binding an empty fill stack', () => {
	const paint = gradient(),
		shape = { ...rectangle(), fills: [paint] };
	const edited = withDesignPaintColor(shape, generateUuid(), generateUuid(), '#123456');
	assert.equal((edited.fills![0] as ReturnType<typeof gradient>).stops[0].color, '#123456');
	assert.equal((edited.fills![0] as ReturnType<typeof gradient>).stops[1].color, '#ffffff');
	const empty = withDesignPaintColor({ ...shape, fills: [] }, undefined, undefined, '#abcdef');
	assert.equal(empty.fills?.length, 1);
	assert.deepEqual(sampleDesignPaint(empty.fills![0], 0), [171, 205, 239, 255]);
});
