import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import {
	documentFromShapes,
	flattenDesignShapes,
	parseDesignDocument,
	serializeDesignDocument,
	type DesignShape,
} from '../../contrib/creator/common/model/document.js';
import {
	getDesignResourceCatalog,
	resolveDesignVariable,
	type DesignLibrary,
} from '../../contrib/creator/common/model/designResources.js';
import { hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';

type Frame = Extract<DesignShape, { kind: 'frame' }>;
type Text = Extract<DesignShape, { kind: 'text' }>;
function rectangle(): DesignShape {
	return { id: generateUuid(), kind: 'rectangle', x: 0, y: 0, width: 100, height: 40, rotation: 0, fill: '#808080' };
}
function frame(children: readonly DesignShape[]): Frame {
	return { ...rectangle(), kind: 'frame', children, clip: false };
}
function text(): Text {
	return { ...rectangle(), kind: 'text', text: 'Label', fontSize: 16 };
}
function find<T extends DesignShape = DesignShape>(model: DesignModel, id: string): T {
	return flattenDesignShapes(model.value.shapes).find(shape => shape.id === id) as T;
}
function roundTrip(model: DesignModel): void {
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
}
function library(model: DesignModel, version = 'a'.repeat(64)): DesignLibrary {
	return {
		id: model.value.documentId,
		name: 'UI',
		uri: 'file:///ui.ash-design-library',
		version,
		enabled: true,
		document: model.value,
	};
}

test('Design variables inherit collection modes through frames, aliases and styles, including reload and undo', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const a = rectangle();
	const b = rectangle();
	const parent = frame([a, frame([b])]);
	model.applyEdit([parent]);
	const collection = resources.addCollection('Theme');
	const light = resources.value.collections[0].defaultMode;
	const dark = resources.addMode(collection, 'Dark');
	const color = resources.addVariable(collection, 'Colors/Primary', 'color');
	resources.setVariableValue(color, light, '#ffffff');
	resources.setVariableValue(color, dark, '#111111');
	const alias = resources.addVariable(collection, 'Semantic/Surface', 'color');
	resources.setVariableValue(alias, light, { alias: color });
	resources.setVariableValue(alias, dark, { alias: color });
	resources.bind(new Set([a.id, b.id]), 'fill', alias);
	const style = resources.createStyle(find(model, a.id), 'fill', 'Surface');
	resources.applyStyle(new Set([b.id]), 'fill', style);
	resources.setMode(new Set([parent.id]), collection, dark);
	assert.equal(find(model, a.id).fill, '#111111');
	assert.equal(find(model, b.id).fill, '#111111');
	resources.setMode(new Set([b.id]), collection, light);
	assert.equal(find(model, b.id).fill, '#ffffff');
	resources.setVariableValue(color, dark, '#222222');
	assert.equal(find(model, a.id).fill, '#222222');
	assert.equal(find(model, b.id).fill, '#ffffff');
	model.undo();
	assert.equal(find(model, a.id).fill, '#111111');
	model.redo();
	roundTrip(model);
	const persisted = model.value;
	model.replace(parseDesignDocument(serializeDesignDocument(persisted)));
	assert.deepEqual(model.value, persisted);
	assert.ok(Object.isFrozen(model.value.resources!.variables[0].values));
});

test('Design variable aliases reject cross-type and cyclic dependencies before committing history', () => {
	using model = new DesignModel();
	const resources = new DocumentCommands(model).resources;
	const collection = resources.addCollection('Theme');
	const mode = resources.value.collections[0].defaultMode;
	const first = resources.addVariable(collection, 'First', 'number');
	const second = resources.addVariable(collection, 'Second', 'number');
	const color = resources.addVariable(collection, 'Color', 'color');
	resources.setVariableValue(first, mode, { alias: second });
	const before = serializeDesignDocument(model.value);
	const version = model.version;
	assert.throws(() => resources.setVariableValue(second, mode, { alias: first }), /circular/u);
	assert.throws(() => resources.setVariableValue(second, mode, { alias: color }), /Invalid design resource/u);
	assert.equal(model.version, version);
	assert.equal(serializeDesignDocument(model.value), before);
});

test('Design boolean and numeric variables drive hidden children, auto layout and hit testing', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const a = rectangle();
	const b = rectangle();
	const parent: Frame = {
		...frame([a, b]),
		width: 400,
		autoLayout: {
			direction: 'horizontal',
			gap: 10,
			padding: { top: 0, bottom: 0, left: 0, right: 0 },
			align: 'start',
			justify: 'start',
			width: 'hug',
			height: 'hug',
		},
	};
	model.applyEdit([parent]);
	const collection = resources.addCollection('Layout');
	const mode = resources.value.collections[0].defaultMode;
	const gap = resources.addVariable(collection, 'Gap', 'number');
	resources.setVariableValue(gap, mode, 24);
	resources.bind(new Set([parent.id]), 'gap', gap);
	assert.equal(find(model, b.id).x, 124);
	assert.equal(find(model, parent.id).width, 224);
	const visible = resources.addVariable(collection, 'Show first', 'boolean');
	resources.bind(new Set([a.id]), 'visible', visible);
	resources.setVariableValue(visible, mode, false);
	assert.equal(find(model, b.id).x, 0);
	assert.equal(find(model, parent.id).width, 100);
	assert.equal(find<Frame>(model, parent.id).children.length, 2);
	assert.equal(hitTestDesignShapes(model.value.shapes, { x: 5, y: 5 })?.id, b.id);
	resources.setVariableValue(visible, mode, true);
	assert.equal(find(model, b.id).x, 124);
	roundTrip(model);
});

test('Design direct edits detach just their variable property and retain literal values on deletion', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const shape = rectangle();
	model.applyEdit([shape]);
	const collection = resources.addCollection('Sizes');
	const mode = resources.value.collections[0].defaultMode;
	const width = resources.addVariable(collection, 'Width', 'number');
	resources.setVariableValue(width, mode, 220);
	resources.bind(new Set([shape.id]), 'width', width);
	resources.bind(new Set([shape.id]), 'height', width);
	commands.updateShape({ ...find(model, shape.id), width: 150 });
	resources.setVariableValue(width, mode, 180);
	assert.equal(find(model, shape.id).width, 150);
	assert.equal(find(model, shape.id).height, 180);
	assert.equal(find(model, shape.id).bindings?.width, undefined);
	resources.deleteVariable(width);
	assert.equal(find(model, shape.id).height, 180);
	assert.deepEqual(find(model, shape.id).bindings, {});
	roundTrip(model);
});

test('Design deleting modes and collections preserves materialized values and rewrites dependent aliases', () => {
	using model = new DesignModel();
	const resources = new DocumentCommands(model).resources;
	const collection = resources.addCollection('Base');
	const mode = resources.value.collections[0].defaultMode;
	const dark = resources.addMode(collection, 'Dark');
	const number = resources.addVariable(collection, 'Number', 'number');
	resources.setVariableValue(number, mode, 42);
	resources.setVariableValue(number, dark, 84);
	const semantic = resources.addCollection('Semantic');
	const semanticMode = resources.value.collections[1].defaultMode;
	const alias = resources.addVariable(semantic, 'Alias', 'number');
	resources.setVariableValue(alias, semanticMode, { alias: number });
	resources.setMode(new Set(), collection, dark);
	assert.equal(resolveDesignVariable(resources.value, alias, resources.value.modes), 84);
	resources.deleteMode(collection, dark);
	assert.equal(resources.value.modes?.[collection], undefined);
	assert.equal(resolveDesignVariable(resources.value, alias), 42);
	resources.deleteCollection(collection);
	assert.equal(resolveDesignVariable(resources.value, alias), 42);
	assert.equal(resources.value.variables.length, 1);
	roundTrip(model);
});

test('Design paint, text, effect and guide styles update references atomically and detach without visual changes', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const a = text();
	const b = text();
	const board = frame([]);
	model.applyEdit([a, b, board]);
	const style = resources.createStyle(a, 'text', 'Body');
	resources.applyStyle(new Set([b.id]), 'text', style);
	commands.updateShape({
		...find<Text>(model, a.id),
		fontSize: 28,
		fontFamily: 'serif',
		fontWeight: 700,
		lineHeight: 36,
		letterSpacing: 2,
	});
	assert.equal(find(model, a.id).styleBindings?.text, undefined);
	resources.updateStyle(style, find(model, a.id));
	assert.equal(find<Text>(model, b.id).fontSize, 28);
	assert.equal(find<Text>(model, b.id).fontFamily, 'serif');
	resources.deleteStyle(style);
	assert.equal(find<Text>(model, b.id).fontWeight, 700);
	assert.equal(find(model, b.id).styleBindings?.text, undefined);
	commands.updateShape({ ...find(model, a.id), effects: { x: 1, y: 2, blur: 8, color: '#00000040' } });
	const effect = resources.createStyle(find(model, a.id), 'effect', 'Shadow');
	resources.applyStyle(new Set([b.id]), 'effect', effect);
	assert.deepEqual(find(model, b.id).effects, find(model, a.id).effects);
	commands.updateShape({ ...find<Frame>(model, board.id), layoutGuide: { size: 8, color: '#ff000040' } });
	resources.createStyle(find(model, board.id), 'grid', 'Grid');
	roundTrip(model);
	model.undo();
	assert.equal(resources.value.styles.length, 1);
	model.redo();
	assert.equal(resources.value.styles.length, 2);
});

test('Design resource changes preserve literal instance overrides and instance mode choices', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const label = text();
	const source: Frame = { ...frame([label]), component: { kind: 'main' } };
	model.applyEdit([source]);
	const collection = resources.addCollection('Theme');
	const mode = resources.value.collections[0].defaultMode;
	const dark = resources.addMode(collection, 'Dark');
	const color = resources.addVariable(collection, 'Color', 'color');
	resources.setVariableValue(color, mode, '#ff0000');
	resources.setVariableValue(color, dark, '#000000');
	resources.bind(new Set([label.id]), 'fill', color);
	const instance = commands.components.createInstance(source.id)!;
	const child = find<Frame>(model, instance).children[0].id;
	resources.setMode(new Set([instance]), collection, dark);
	assert.equal(find(model, child).fill, '#000000');
	commands.updateShape({ ...find(model, child), fill: '#00ff00' });
	resources.setVariableValue(color, dark, '#333333');
	assert.equal(find(model, child).fill, '#00ff00');
	commands.components.reset(child);
	assert.equal(find(model, child).fill, '#333333');
	roundTrip(model);
});

test('Design libraries accept explicit versions, reuse component variants and preserve instance overrides and history', () => {
	using source = new DesignModel();
	const author = new DocumentCommands(source);
	const label = text();
	const main: Frame = { ...frame([label]), name: 'Button', component: { kind: 'main' } };
	source.applyEdit([main]);
	const collection = author.resources.addCollection('Theme');
	const mode = author.resources.value.collections[0].defaultMode;
	const color = author.resources.addVariable(collection, 'Brand', 'color');
	author.resources.setVariableValue(color, mode, '#ff0000');
	author.resources.bind(new Set([label.id]), 'fill', color);
	using consumer = new DesignModel();
	const commands = new DocumentCommands(consumer);
	commands.resources.acceptLibrary(library(source));
	const id = commands.components.createInstance(main.id)!;
	const child = find<Frame>(consumer, id).children[0].id;
	assert.equal(find(consumer, child).fill, '#ff0000');
	assert.equal(commands.components.canPush(id), false);
	commands.updateShape({ ...find<Text>(consumer, child), text: 'Custom' });
	author.resources.setVariableValue(color, mode, '#0000ff');
	author.updateShape({ ...find<Text>(source, label.id), text: 'Published' });
	assert.equal(find(consumer, child).fill, '#ff0000');
	commands.resources.acceptLibrary(library(source, 'b'.repeat(64)));
	assert.equal(find(consumer, child).fill, '#0000ff');
	assert.equal(find<Text>(consumer, child).text, 'Custom');
	assert.equal(find<Frame>(consumer, id).children[0].id, child);
	consumer.undo();
	assert.equal(find(consumer, child).fill, '#ff0000');
	consumer.redo();
	roundTrip(consumer);
	commands.resources.setLibraryEnabled(source.value.documentId, false);
	assert.equal(commands.components.mains.length, 0);
	assert.equal(getDesignResourceCatalog(commands.resources.value, true).variables.length, 0);
	assert.equal(find(consumer, child).fill, '#0000ff');
	const before = consumer.value;
	consumer.replace(parseDesignDocument(serializeDesignDocument(before)));
	assert.deepEqual(consumer.value, before);
	commands.components.detach(id);
	assert.equal(find<Frame>(consumer, id).instance, undefined);
	assert.equal(find<Text>(consumer, child).text, 'Custom');
	roundTrip(consumer);
});

test('Design library removals retain missing component and variable appearance, and conflicting identities are rejected', () => {
	using source = new DesignModel();
	const main: Frame = { ...frame([text()]), component: { kind: 'main' } };
	source.applyEdit([main]);
	using consumer = new DesignModel();
	const commands = new DocumentCommands(consumer);
	commands.resources.acceptLibrary(library(source));
	const id = commands.components.createInstance(main.id)!;
	source.applyEdit([]);
	commands.resources.acceptLibrary(library(source, 'c'.repeat(64)));
	assert.equal(find<Frame>(consumer, id).children.length, 1);
	assert.equal(commands.components.getMain(id), undefined);
	roundTrip(consumer);
	const token = consumer.version;
	assert.throws(
		() => commands.resources.acceptLibrary({ ...library(source), id: consumer.value.documentId }),
		/conflicting/u,
	);
	assert.equal(consumer.version, token);
});

test('Design resources reject malformed persistence values, type mismatches and recursive library payloads', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const shape = text();
	model.applyEdit([shape]);
	const collection = commands.resources.addCollection('Colors');
	const mode = commands.resources.value.collections[0].defaultMode;
	const color = commands.resources.addVariable(collection, 'Color', 'color');
	commands.resources.bind(new Set([shape.id]), 'fill', color);
	const valid = JSON.parse(serializeDesignDocument(model.value));
	for (const mutate of [
		(value: any) => {
			value.resources.variables[0].values[mode] = '#bad';
		},
		(value: any) => {
			value.resources.variables[0].values[mode] = { alias: color };
		},
		(value: any) => {
			value.resources.collections[0].defaultMode = generateUuid();
		},
		(value: any) => {
			value.artifacts[value.artifactOrder[0]].objects[shape.id].bindings = { width: color };
		},
		(value: any) => {
			value.artifacts[value.artifactOrder[0]].objects[shape.id].opacity = 2;
		},
		(value: any) => {
			value.artifacts[value.artifactOrder[0]].objects[shape.id].effects = {
				x: 0,
				y: 0,
				blur: -1,
				color: '#000000',
			};
		},
	]) {
		const value = structuredClone(valid);
		mutate(value);
		assert.throws(() => parseDesignDocument(JSON.stringify(value)), /Invalid/u);
	}
	using consumer = new DesignModel();
	const resources = new DocumentCommands(consumer).resources;
	resources.acceptLibrary(library(model));
	const recursive = JSON.parse(serializeDesignDocument(consumer.value));
	recursive.resources.libraries[0].document.resources.libraries.push(
		structuredClone(recursive.resources.libraries[0]),
	);
	assert.throws(() => parseDesignDocument(JSON.stringify(recursive)), /Invalid/u);
});

test('Design Save As preserves resources across undo history and inherited values are resolved from definitions on load', () => {
	using model = new DesignModel();
	const resources = new DocumentCommands(model).resources;
	const shape = rectangle();
	model.applyEdit([shape]);
	const collection = resources.addCollection('Theme');
	const variable = resources.addVariable(collection, 'Color', 'color');
	const mode = resources.value.collections[0].defaultMode;
	resources.setVariableValue(variable, mode, '#112233');
	resources.bind(new Set([shape.id]), 'fill', variable);
	model.changeIdentity(generateUuid());
	const documentId = model.value.documentId;
	model.undo();
	assert.equal(model.value.documentId, documentId);
	assert.equal(model.value.resources!.variables.length, 1);
	model.redo();
	roundTrip(model);
	const file = JSON.parse(serializeDesignDocument(model.value));
	file.artifacts[file.artifactOrder[0]].objects[shape.id].fill = '#ffffff';
	model.replace(parseDesignDocument(JSON.stringify(file)));
	assert.equal(find(model, shape.id).fill, '#112233');
});

test('Design instance binding overrides inherit unrelated new bindings and can reset or push one property', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const label = text();
	const main: Frame = { ...frame([label]), component: { kind: 'main' } };
	model.applyEdit([main]);
	const collection = resources.addCollection('Theme');
	const mode = resources.value.collections[0].defaultMode;
	const color = resources.addVariable(collection, 'Color', 'color');
	const size = resources.addVariable(collection, 'Size', 'number');
	resources.setVariableValue(size, mode, 24);
	const first = commands.components.createInstance(main.id)!;
	const child = find<Frame>(model, first).children[0].id;
	resources.bind(new Set([child]), 'fill', color);
	resources.bind(new Set([label.id]), 'fontSize', size);
	assert.equal(find<Text>(model, child).fontSize, 24);
	assert.equal(find(model, child).bindings?.fill, color);
	assert.equal(find(model, child).bindings?.fontSize, size);
	assert.deepEqual(find(model, child).overrides, ['bindings:fill']);
	commands.components.push(first);
	assert.equal(find(model, label.id).bindings?.fill, color);
	assert.equal(find(model, label.id).bindings?.fontSize, size);
	commands.updateShape({ ...find(model, child), fill: '#123456' });
	resources.setVariableValue(size, mode, 32);
	assert.equal(find<Text>(model, child).fontSize, 32);
	assert.equal(find(model, child).fill, '#123456');
	commands.components.reset(child);
	assert.equal(find(model, child).fill, '#808080');
	assert.equal(find<Text>(model, child).fontSize, 32);
	roundTrip(model);
});

test('Design deleting a variable used inside a style preserves each layer mode and its alias values', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const resources = commands.resources;
	const a = rectangle();
	const b = rectangle();
	model.applyEdit([a, b]);
	const collection = resources.addCollection('Theme');
	const light = resources.value.collections[0].defaultMode;
	const dark = resources.addMode(collection, 'Dark');
	const color = resources.addVariable(collection, 'Color', 'color');
	resources.setVariableValue(color, light, '#ffffff');
	resources.setVariableValue(color, dark, '#000000');
	const alias = resources.addVariable(collection, 'Alias', 'color');
	resources.setVariableValue(alias, light, { alias: color });
	resources.setVariableValue(alias, dark, { alias: color });
	resources.bind(new Set([a.id]), 'fill', alias);
	const style = resources.createStyle(find(model, a.id), 'fill', 'Surface');
	resources.applyStyle(new Set([b.id]), 'fill', style);
	resources.setMode(new Set([b.id]), collection, dark);
	resources.deleteVariable(color);
	assert.equal(find(model, a.id).fill, '#ffffff');
	assert.equal(find(model, b.id).fill, '#000000');
	assert.equal(find(model, b.id).styleBindings?.fill, undefined);
	assert.equal(resolveDesignVariable(resources.value, alias, { [collection]: dark }), '#000000');
	roundTrip(model);
	model.undo();
	assert.equal(find(model, b.id).styleBindings?.fill, style);
});
