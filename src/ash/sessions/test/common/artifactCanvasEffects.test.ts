import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/artifact/common/commands/documentCommands.js';
import { ArtifactCanvasModel } from '../../contrib/artifact/common/model/artifactCanvasModel.js';
import { canAddArtifactCanvasEffect, createArtifactCanvasEffect, artifactCanvasEffectPadding, artifactCanvasEffects, parseArtifactCanvasEffects, supportsArtifactCanvasShadowSpread, type ArtifactCanvasEffect } from '../../contrib/artifact/common/model/artifactCanvasEffects.js';
import { createArtifactCanvasPaint } from '../../contrib/artifact/common/model/artifactCanvasPaint.js';
import { documentFromShapes, flattenArtifactCanvasShapes, parseArtifactCanvasDocument, serializeArtifactCanvasDocument, type ArtifactCanvasShape } from '../../contrib/artifact/common/model/artifactCanvasDocument.js';

const rectangle = (): ArtifactCanvasShape => ({ id: generateUuid(), kind: 'rectangle', x: 0, y: 0, width: 200, height: 100, rotation: 0, fill: '#3366ff' });
const progressive = { startBlur: 32, start: { x: -.25, y: .1 }, end: { x: 1.25, y: .9 } };
const stack = (): readonly ArtifactCanvasEffect[] => [
	createArtifactCanvasEffect('inner-shadow'), createArtifactCanvasEffect('drop-shadow'),
	{ id: generateUuid(), type: 'layer-blur', blur: 4, progressive },
	{ id: generateUuid(), type: 'background-blur', blur: 24, progressive: { ...progressive, startBlur: 0 } }
];

test('Progressive blur validates both endpoints, preserves reversed ranges and expands bounds for the larger radius', () => {
	const blur = { id: generateUuid(), type: 'layer-blur' as const, blur: 4, progressive };
	assert.deepEqual(parseArtifactCanvasEffects([blur]), [blur]);
	assert.equal(artifactCanvasEffectPadding({ ...rectangle(), effects: [blur] }), 64);
	const coincident = { ...blur, progressive: { ...progressive, start: progressive.end } };
	assert.deepEqual(parseArtifactCanvasEffects([coincident]), [coincident]);
	for (const invalid of [
		null, {}, { ...progressive, startBlur: -1 }, { ...progressive, startBlur: Infinity },
		{ ...progressive, start: { x: 0 } }, { ...progressive, end: { x: NaN, y: 0 } },
		{ ...progressive, end: { x: 0, y: 0, z: 1 } }, { ...progressive, unexpected: true }
	]) { assert.throws(() => parseArtifactCanvasEffects([{ ...blur, progressive: invalid }]), /Invalid design effect/u); }
	assert.throws(() => parseArtifactCanvasEffects([{ ...createArtifactCanvasEffect('drop-shadow'), progressive }]), /Invalid design effect/u);
	using model = new ArtifactCanvasModel();
	model.replace(documentFromShapes([{ ...rectangle(), effects: [blur] }]));
	const saved = artifactCanvasEffects(model.value.shapes[0])[0];
	assert.ok('progressive' in saved && Object.isFrozen(saved.progressive?.start));
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)), model.value);
});

test('Effect stacks retain order, visibility, immutable history and legacy shadow compatibility', () => {
	using model = new ArtifactCanvasModel();
	const commands = new DocumentCommands(model);
	const shape = { ...rectangle(), effects: { x: -4, y: 8, blur: 12, color: '#12345680' } };
	model.replace(documentFromShapes([shape]));
	assert.equal(artifactCanvasEffects(shape)[0].type, 'drop-shadow');
	assert.equal((artifactCanvasEffects(shape)[0] as Extract<ArtifactCanvasEffect, { type: 'drop-shadow' | 'inner-shadow'; }>).showBehind, true);
	commands.updateShape({ ...shape, effects: stack().map((effect, index) => ({ ...effect, visible: index !== 2 })) });
	assert.ok(Array.isArray(model.value.shapes[0].effects));
	assert.ok(Object.isFrozen(model.value.shapes[0].effects));
	assert.ok(Object.isFrozen(artifactCanvasEffects(model.value.shapes[0])[0]));
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)), model.value);
	model.undo(); assert.deepEqual(model.value.shapes[0].effects, shape.effects);
	model.redo(); assert.equal(artifactCanvasEffects(model.value.shapes[0]).length, 4);
	commands.updateShape({ ...model.value.shapes[0], effects: [] });
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(model.value)).shapes[0].effects, []);
});

test('Effect persistence rejects duplicate identities, invalid fields and counts beyond Figma limits', () => {
	const drop = createArtifactCanvasEffect('drop-shadow'), blur = createArtifactCanvasEffect('layer-blur');
	for (const value of [
		[drop, drop], [{ ...drop, id: 'bad' }], [{ ...drop, blur: -1 }], [{ ...drop, x: Infinity }], [{ ...drop, visible: 'yes' }],
		[{ ...drop, color: 'url(https://example.com)' }], [{ ...drop, blendMode: 'pass-through' }], [{ ...drop, showBehind: 1 }], [{ ...drop, spread: NaN }],
		[{ ...blur, x: 0 }], [{ ...drop, type: 'inner-shadow', showBehind: true }], [{ ...blur, type: 'unknown' }], [{ ...blur, blur: '4' }],
		[blur, { ...blur, id: generateUuid() }], Array.from({ length: 9 }, () => createArtifactCanvasEffect('inner-shadow')),
	]) { assert.throws(() => parseArtifactCanvasEffects(value), /Invalid design effect/u); }
	const maximum = [...Array.from({ length: 8 }, () => createArtifactCanvasEffect('drop-shadow')), ...Array.from({ length: 8 }, () => createArtifactCanvasEffect('inner-shadow')), blur, createArtifactCanvasEffect('background-blur')];
	assert.deepEqual(parseArtifactCanvasEffects(maximum), maximum);
	assert.equal(canAddArtifactCanvasEffect(maximum, 'drop-shadow'), false);
	assert.equal(canAddArtifactCanvasEffect(maximum, 'background-blur'), false);
	assert.deepEqual(parseArtifactCanvasEffects([{ ...drop, x: -20, spread: -12 }]), [{ ...drop, x: -20, spread: -12 }]);
	assert.throws(() => parseArtifactCanvasDocument(JSON.stringify({ ...documentFromShapes([]), shapes: [{ ...rectangle(), effects: [{ ...blur, blur: -1 }] }] })));
});

test('Spread follows geometry and clipped-frame fill coverage without discarding unsupported values', () => {
	const shape = rectangle();
	const frame: ArtifactCanvasShape = { ...shape, kind: 'frame', children: [], clip: true };
	assert.equal(supportsArtifactCanvasShadowSpread(shape), true);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...shape, kind: 'ellipse' }), true);
	assert.equal(supportsArtifactCanvasShadowSpread(frame), true);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, clip: false }), false);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, fills: [] }), false);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, fills: [{ ...createArtifactCanvasPaint('solid'), opacity: .009 }] }), false);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, fills: [{ ...createArtifactCanvasPaint('solid'), visible: false }] }), false);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, fills: [createArtifactCanvasPaint('solid', '#ffffff00')] }), false);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...frame, fills: [{ ...createArtifactCanvasPaint('solid'), opacity: .01 }] }), true);
	assert.equal(supportsArtifactCanvasShadowSpread({ ...shape, kind: 'text', text: 'Shadow', fontSize: 20 }), false);
});

test('Effect bounds include shadow offsets, layer blur and scaled nested content but respect clipping', () => {
	const drop = { ...createArtifactCanvasEffect('drop-shadow'), x: -20, y: 5, spread: 10, blur: 8 } as ArtifactCanvasEffect;
	const child = { ...rectangle(), effects: [drop, { ...createArtifactCanvasEffect('layer-blur'), blur: 5 }] };
	assert.equal(artifactCanvasEffectPadding(child), 56);
	assert.equal(artifactCanvasEffectPadding({ ...child, effects: [{ ...drop, visible: false }] }), 0);
	const frame: ArtifactCanvasShape = { ...rectangle(), kind: 'frame', children: [child], clip: true };
	assert.equal(artifactCanvasEffectPadding(frame), 0);
	assert.equal(artifactCanvasEffectPadding({ ...frame, clip: false }), 56);
	assert.equal(artifactCanvasEffectPadding({ ...rectangle(), kind: 'group', children: [child], contentWidth: 100, contentHeight: 50 }), 112);
});

test('Effect styles publish complete stacks, update library instances and retain local overrides', () => {
	using source = new ArtifactCanvasModel();
	const author = new DocumentCommands(source), shape = { ...rectangle(), effects: stack() };
	const main: ArtifactCanvasShape = { ...rectangle(), kind: 'frame', clip: false, children: [shape], component: { kind: 'main' } };
	source.applyEdit([main]);
	const find = (model: ArtifactCanvasModel, id: string) => flattenArtifactCanvasShapes(model.value.shapes).find(shape => shape.id === id)!;
	const style = author.resources.createStyle(find(source, shape.id), 'effect', 'Glass');
	using consumer = new ArtifactCanvasModel();
	const commands = new DocumentCommands(consumer);
	const publish = (version: string) => commands.resources.acceptLibrary({ id: source.value.documentId, name: 'Effects', uri: 'file:///effects.ash-design-library', version: version.repeat(64), enabled: true, document: source.value });
	publish('a');
	const instance = commands.components.createInstance(main.id)!;
	const child = (find(consumer, instance) as Extract<ArtifactCanvasShape, { kind: 'frame'; }>).children[0];
	assert.deepEqual(child.effects, shape.effects);
	author.resources.updateStyle(style, { ...shape, effects: [createArtifactCanvasEffect('layer-blur')] });
	publish('b');
	assert.equal(artifactCanvasEffects(find(consumer, child.id))[0].type, 'layer-blur');
	commands.updateShape({ ...find(consumer, child.id), effects: [createArtifactCanvasEffect('inner-shadow')] });
	author.resources.updateStyle(style, { ...shape, effects: [createArtifactCanvasEffect('background-blur')] });
	publish('c');
	assert.equal(artifactCanvasEffects(find(consumer, child.id))[0].type, 'inner-shadow');
	commands.components.reset(child.id);
	assert.equal(artifactCanvasEffects(find(consumer, child.id))[0].type, 'background-blur');
	assert.deepEqual(parseArtifactCanvasDocument(serializeArtifactCanvasDocument(consumer.value)), consumer.value);
});
