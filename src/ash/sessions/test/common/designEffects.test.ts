import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { canAddDesignEffect, createDesignEffect, designEffectPadding, designEffects, parseDesignEffects, supportsDesignShadowSpread, type DesignEffect } from '../../contrib/creator/common/model/designEffects.js';
import { createDesignPaint } from '../../contrib/creator/common/model/designPaint.js';
import { documentFromShapes, flattenDesignShapes, parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/creator/common/model/document.js';

const rectangle = (): DesignShape => ({ id: generateUuid(), kind: 'rectangle', x: 0, y: 0, width: 200, height: 100, rotation: 0, fill: '#3366ff' });
const progressive = { startBlur: 32, start: { x: -.25, y: .1 }, end: { x: 1.25, y: .9 } };
const stack = (): readonly DesignEffect[] => [
	createDesignEffect('inner-shadow'), createDesignEffect('drop-shadow'),
	{ id: generateUuid(), type: 'layer-blur', blur: 4, progressive },
	{ id: generateUuid(), type: 'background-blur', blur: 24, progressive: { ...progressive, startBlur: 0 } }
];

test('Progressive blur validates both endpoints, preserves reversed ranges and expands bounds for the larger radius', () => {
	const blur = { id: generateUuid(), type: 'layer-blur' as const, blur: 4, progressive };
	assert.deepEqual(parseDesignEffects([blur]), [blur]);
	assert.equal(designEffectPadding({ ...rectangle(), effects: [blur] }), 64);
	const coincident = { ...blur, progressive: { ...progressive, start: progressive.end } };
	assert.deepEqual(parseDesignEffects([coincident]), [coincident]);
	for (const invalid of [
		null, {}, { ...progressive, startBlur: -1 }, { ...progressive, startBlur: Infinity },
		{ ...progressive, start: { x: 0 } }, { ...progressive, end: { x: NaN, y: 0 } },
		{ ...progressive, end: { x: 0, y: 0, z: 1 } }, { ...progressive, unexpected: true }
	]) { assert.throws(() => parseDesignEffects([{ ...blur, progressive: invalid }]), /Invalid design effect/u); }
	assert.throws(() => parseDesignEffects([{ ...createDesignEffect('drop-shadow'), progressive }]), /Invalid design effect/u);
	using model = new DesignModel();
	model.replace(documentFromShapes([{ ...rectangle(), effects: [blur] }]));
	const saved = designEffects(model.value.shapes[0])[0];
	assert.ok('progressive' in saved && Object.isFrozen(saved.progressive?.start));
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Effect stacks retain order, visibility, immutable history and legacy shadow compatibility', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const shape = { ...rectangle(), effects: { x: -4, y: 8, blur: 12, color: '#12345680' } };
	model.replace(documentFromShapes([shape]));
	assert.equal(designEffects(shape)[0].type, 'drop-shadow');
	assert.equal((designEffects(shape)[0] as Extract<DesignEffect, { type: 'drop-shadow' | 'inner-shadow'; }>).showBehind, true);
	commands.updateShape({ ...shape, effects: stack().map((effect, index) => ({ ...effect, visible: index !== 2 })) });
	assert.ok(Array.isArray(model.value.shapes[0].effects));
	assert.ok(Object.isFrozen(model.value.shapes[0].effects));
	assert.ok(Object.isFrozen(designEffects(model.value.shapes[0])[0]));
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	model.undo(); assert.deepEqual(model.value.shapes[0].effects, shape.effects);
	model.redo(); assert.equal(designEffects(model.value.shapes[0]).length, 4);
	commands.updateShape({ ...model.value.shapes[0], effects: [] });
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)).shapes[0].effects, []);
});

test('Effect persistence rejects duplicate identities, invalid fields and counts beyond Figma limits', () => {
	const drop = createDesignEffect('drop-shadow'), blur = createDesignEffect('layer-blur');
	for (const value of [
		[drop, drop], [{ ...drop, id: 'bad' }], [{ ...drop, blur: -1 }], [{ ...drop, x: Infinity }], [{ ...drop, visible: 'yes' }],
		[{ ...drop, color: 'url(https://example.com)' }], [{ ...drop, blendMode: 'pass-through' }], [{ ...drop, showBehind: 1 }], [{ ...drop, spread: NaN }],
		[{ ...blur, x: 0 }], [{ ...drop, type: 'inner-shadow', showBehind: true }], [{ ...blur, type: 'unknown' }], [{ ...blur, blur: '4' }],
		[blur, { ...blur, id: generateUuid() }], Array.from({ length: 9 }, () => createDesignEffect('inner-shadow')),
	]) { assert.throws(() => parseDesignEffects(value), /Invalid design effect/u); }
	const maximum = [...Array.from({ length: 8 }, () => createDesignEffect('drop-shadow')), ...Array.from({ length: 8 }, () => createDesignEffect('inner-shadow')), blur, createDesignEffect('background-blur')];
	assert.deepEqual(parseDesignEffects(maximum), maximum);
	assert.equal(canAddDesignEffect(maximum, 'drop-shadow'), false);
	assert.equal(canAddDesignEffect(maximum, 'background-blur'), false);
	assert.deepEqual(parseDesignEffects([{ ...drop, x: -20, spread: -12 }]), [{ ...drop, x: -20, spread: -12 }]);
	assert.throws(() => parseDesignDocument(JSON.stringify({ ...documentFromShapes([]), shapes: [{ ...rectangle(), effects: [{ ...blur, blur: -1 }] }] })));
});

test('Spread follows geometry and clipped-frame fill coverage without discarding unsupported values', () => {
	const shape = rectangle();
	const frame: DesignShape = { ...shape, kind: 'frame', children: [], clip: true };
	assert.equal(supportsDesignShadowSpread(shape), true);
	assert.equal(supportsDesignShadowSpread({ ...shape, kind: 'ellipse' }), true);
	assert.equal(supportsDesignShadowSpread(frame), true);
	assert.equal(supportsDesignShadowSpread({ ...frame, clip: false }), false);
	assert.equal(supportsDesignShadowSpread({ ...frame, fills: [] }), false);
	assert.equal(supportsDesignShadowSpread({ ...frame, fills: [{ ...createDesignPaint('solid'), opacity: .009 }] }), false);
	assert.equal(supportsDesignShadowSpread({ ...frame, fills: [{ ...createDesignPaint('solid'), visible: false }] }), false);
	assert.equal(supportsDesignShadowSpread({ ...frame, fills: [createDesignPaint('solid', '#ffffff00')] }), false);
	assert.equal(supportsDesignShadowSpread({ ...frame, fills: [{ ...createDesignPaint('solid'), opacity: .01 }] }), true);
	assert.equal(supportsDesignShadowSpread({ ...shape, kind: 'text', text: 'Shadow', fontSize: 20 }), false);
});

test('Effect bounds include shadow offsets, layer blur and scaled nested content but respect clipping', () => {
	const drop = { ...createDesignEffect('drop-shadow'), x: -20, y: 5, spread: 10, blur: 8 } as DesignEffect;
	const child = { ...rectangle(), effects: [drop, { ...createDesignEffect('layer-blur'), blur: 5 }] };
	assert.equal(designEffectPadding(child), 56);
	assert.equal(designEffectPadding({ ...child, effects: [{ ...drop, visible: false }] }), 0);
	const frame: DesignShape = { ...rectangle(), kind: 'frame', children: [child], clip: true };
	assert.equal(designEffectPadding(frame), 0);
	assert.equal(designEffectPadding({ ...frame, clip: false }), 56);
	assert.equal(designEffectPadding({ ...rectangle(), kind: 'group', children: [child], contentWidth: 100, contentHeight: 50 }), 112);
});

test('Effect styles publish complete stacks, update library instances and retain local overrides', () => {
	using source = new DesignModel();
	const author = new DocumentCommands(source), shape = { ...rectangle(), effects: stack() };
	const main: DesignShape = { ...rectangle(), kind: 'frame', clip: false, children: [shape], component: { kind: 'main' } };
	source.applyEdit([main]);
	const find = (model: DesignModel, id: string) => flattenDesignShapes(model.value.shapes).find(shape => shape.id === id)!;
	const style = author.resources.createStyle(find(source, shape.id), 'effect', 'Glass');
	using consumer = new DesignModel();
	const commands = new DocumentCommands(consumer);
	const publish = (version: string) => commands.resources.acceptLibrary({ id: source.value.documentId, name: 'Effects', uri: 'file:///effects.ash-design-library', version: version.repeat(64), enabled: true, document: source.value });
	publish('a');
	const instance = commands.components.createInstance(main.id)!;
	const child = (find(consumer, instance) as Extract<DesignShape, { kind: 'frame'; }>).children[0];
	assert.deepEqual(child.effects, shape.effects);
	author.resources.updateStyle(style, { ...shape, effects: [createDesignEffect('layer-blur')] });
	publish('b');
	assert.equal(designEffects(find(consumer, child.id))[0].type, 'layer-blur');
	commands.updateShape({ ...find(consumer, child.id), effects: [createDesignEffect('inner-shadow')] });
	author.resources.updateStyle(style, { ...shape, effects: [createDesignEffect('background-blur')] });
	publish('c');
	assert.equal(designEffects(find(consumer, child.id))[0].type, 'inner-shadow');
	commands.components.reset(child.id);
	assert.equal(designEffects(find(consumer, child.id))[0].type, 'background-blur');
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(consumer.value)), consumer.value);
});
