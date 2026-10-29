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
import { hitTestDesignShapes } from '../../contrib/creator/common/model/hitTest.js';

type Frame = Extract<DesignShape, { kind: 'frame' }>;
type Text = Extract<DesignShape, { kind: 'text' }>;
function text(name = 'Label'): Text {
	return {
		id: generateUuid(),
		kind: 'text',
		name,
		text: 'Default',
		fontSize: 16,
		x: 8,
		y: 8,
		width: 80,
		height: 24,
		rotation: 0,
		fill: '#000000',
	};
}
function main(children: readonly DesignShape[] = [text()]): Frame {
	return {
		id: generateUuid(),
		name: 'Button',
		kind: 'frame',
		x: 20,
		y: 20,
		width: 120,
		height: 40,
		rotation: 0,
		fill: '#ffffff',
		clip: false,
		children,
		component: { kind: 'main' },
	};
}
function find<T extends DesignShape = Frame>(model: DesignModel, id: string): T {
	return flattenDesignShapes(model.value.shapes).find(shape => shape.id === id) as T;
}
function roundTrip(model: DesignModel): void {
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
}

test('Design components propagate main edits while overrides, stable IDs and undo survive save', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const id = commands.components.createInstance(source.id)!;
	const childId = find(model, id).children[0].id;
	commands.updateShape({ ...find<Text>(model, childId), text: 'Custom' });
	commands.updateShape({ ...find<Text>(model, source.children[0].id), text: 'Changed main', fill: '#ff0000' });
	assert.deepEqual(find<Text>(model, childId).overrides, ['text', 'textRuns']);
	assert.equal(find<Text>(model, childId).text, 'Custom');
	assert.equal(find(model, childId).fill, '#ff0000');
	const version = model.version;
	model.applyEdit(model.value.shapes);
	assert.equal(model.version, version);
	commands.components.reset(id, 'text');
	assert.equal(find<Text>(model, childId).text, 'Changed main');
	model.undo();
	assert.equal(find<Text>(model, childId).text, 'Custom');
	model.redo();
	assert.equal(find(model, id).children[0].id, childId);
	roundTrip(model);
	assert.ok(Object.isFrozen(find(model, id).instance));
});

test('Design component commands create from siblings, duplicate as instances and guard inherited structure', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const a = commands.addShape('rectangle', { x: 20, y: 20 });
	const b = commands.addShape('text', { x: 250, y: 20 }, 'Label');
	const id = commands.components.create(new Set([a, b]))!;
	assert.equal(find(model, id).component?.kind, 'main');
	const instance = commands.duplicate(new Set([id]))[0];
	assert.equal(find(model, instance).instance?.componentId, id);
	const inherited = find(model, instance).children.map(child => child.id);
	const version = model.version;
	commands.removeShapes(new Set(inherited));
	commands.reorder(new Set([inherited[0]]), 'front');
	assert.deepEqual(commands.duplicate(new Set(inherited)), []);
	assert.equal(commands.canGroup(new Set(inherited)), false);
	assert.equal(commands.components.canCreate(new Set(inherited)), false);
	assert.equal(model.version, version);
	commands.removeShapes(new Set([a]));
	assert.equal(find(model, instance).children.length, 1);
	commands.updateShape({ ...find<Frame>(model, id), children: [...find(model, id).children, text('New')] });
	assert.equal(find(model, instance).children.length, 2);
	roundTrip(model);
});

test('Design nested components inherit outer overrides, push to their owning main and detach without losing inner links', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const inner = main();
	model.applyEdit([inner]);
	const nested = commands.components.createInstance(inner.id)!;
	const innerLabel = find(model, nested).children[0].id;
	commands.updateShape({ ...find<Text>(model, innerLabel), text: 'Outer default' });
	const outer = main([find(model, nested)]);
	model.applyEdit([find(model, inner.id), outer]);
	const id = commands.components.createInstance(outer.id)!;
	const nestedCopy = find(model, id).children[0] as Frame;
	const label = nestedCopy.children[0].id;
	assert.equal(find<Text>(model, label).text, 'Outer default');
	commands.updateShape({ ...find<Text>(model, label), text: 'Pushed outer' });
	commands.components.push(id);
	assert.equal(find<Text>(model, inner.children[0].id).text, 'Default');
	assert.equal(find<Text>(model, innerLabel).text, 'Pushed outer');
	assert.equal(find<Text>(model, label).text, 'Pushed outer');
	commands.components.detach(id);
	assert.equal(find(model, id).instance, undefined);
	assert.equal(find(model, nestedCopy.id).instance?.componentId, inner.id);
	assert.equal(find<Text>(model, label).text, 'Pushed outer');
	commands.updateShape({ ...find<Text>(model, inner.children[0].id), fill: '#123456' });
	assert.equal(find(model, label).fill, '#123456');
	roundTrip(model);
});

test('Design component variants preserve matching overrides and stable IDs across multiple properties', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const variant = commands.components.addVariant(source.id)!;
	const set = commands.components.getSet(source.id)!;
	assert.equal(set.children.length, 2);
	assert.equal(commands.components.setProperties(set.id, ['State', 'Size']), true);
	assert.equal(commands.components.setVariantValue(source.id, 'State', 'Default'), true);
	assert.equal(commands.components.setVariantValue(variant, 'State', 'Hover'), true);
	assert.equal(commands.components.setVariantValue(variant, 'State', 'Default'), false);
	const id = commands.components.createInstance(set.id)!;
	const label = find(model, id).children[0].id;
	commands.updateShape({ ...find<Text>(model, label), text: 'Saved label', name: 'Custom layer' });
	commands.updateShape({ ...find(model, variant), fill: '#ffee00', width: 160 });
	commands.components.selectVariant(id, 'State', 'Hover');
	assert.equal(find(model, id).instance?.componentId, variant);
	assert.equal(find(model, id).width, 160);
	assert.equal(find(model, id).fill, '#ffee00');
	assert.equal(find(model, id).children[0].id, label);
	assert.equal(find<Text>(model, label).text, 'Saved label');
	assert.equal(commands.components.setProperties(set.id, ['Size']), false);
	assert.equal(commands.components.setProperties(set.id, ['Status', 'Size'], ['State', 'Status']), true);
	assert.deepEqual((find(model, variant).component as { variant: object }).variant, {
		Status: 'Hover',
		Size: 'Default',
	});
	roundTrip(model);
	model.undo();
	roundTrip(model);
});

test('Design swaps drop overrides from unmatched layers and reject recursive component dependencies', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const first = main();
	const second = main([text('Other')]);
	model.applyEdit([first, second]);
	const id = commands.components.createInstance(first.id)!;
	commands.updateShape({ ...find<Text>(model, find(model, id).children[0].id), text: 'Override' });
	commands.components.swap(id, second.id);
	assert.equal((find(model, id).children[0] as Text).text, 'Default');
	const outer = main([find(model, id)]);
	model.applyEdit([find(model, first.id), find(model, second.id), outer]);
	assert.equal(commands.components.canSwap(id, outer.id), false);
	const version = model.version;
	commands.components.swap(id, outer.id);
	assert.equal(model.version, version);
	roundTrip(model);
});

test('Design variant swaps preserve equal-source styles but adopt differing target styles', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const variant = commands.components.addVariant(source.id)!;
	const id = commands.components.createInstance(source.id)!;
	commands.updateShape({ ...find(model, id), fill: '#ff0000' });
	commands.components.swap(id, variant);
	assert.equal(find(model, id).fill, '#ff0000');
	commands.updateShape({ ...find(model, source.id), fill: '#0000ff' });
	commands.components.swap(id, source.id);
	assert.equal(find(model, id).fill, '#0000ff');
	assert.equal(find(model, id).overrides?.includes('fill') ?? false, false);
});

test('Design instances reject inherited position and text-bound edits while root placement stays independent', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const id = commands.components.createInstance(source.id)!;
	const label = find(model, id).children[0];
	const version = model.version;
	commands.updateShape({ ...label, x: 100, y: 200, rotation: 45, width: 500, height: 400 });
	assert.equal(model.version, version);
	commands.updateShape({ ...find(model, id), x: 300, y: 400, rotation: 15 });
	assert.deepEqual([find(model, id).x, find(model, id).y, find(model, id).rotation], [300, 400, 15]);
	assert.equal(find(model, id).overrides, undefined);
});

test('Design deleted mains retain instance appearance and can be restored, including overrides and history', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const id = commands.components.createInstance(source.id)!;
	const label = find(model, id).children[0].id;
	commands.updateShape({ ...find<Text>(model, label), text: 'Orphan label' });
	commands.removeShapes(new Set([source.id]));
	assert.equal(find<Text>(model, label).text, 'Orphan label');
	roundTrip(model);
	assert.equal(commands.components.restore(id), source.id);
	assert.equal(find<Text>(model, label).text, 'Orphan label');
	commands.components.reset(id);
	assert.equal(find<Text>(model, label).text, 'Orphan label');
	roundTrip(model);
	model.undo();
	model.undo();
	assert.equal(commands.components.getMain(id), undefined);
});

test('Design instance dimensions apply constraints without cumulative drift or derived child overrides', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const label = { ...text(), constraints: { horizontal: 'end' as const, vertical: 'start' as const } };
	const source = main([label]);
	model.applyEdit([source]);
	const id = commands.components.createInstance(source.id)!;
	commands.updateGeometry(find(model, id), 'width', 220);
	assert.equal(find(model, id).children[0].x, 108);
	assert.equal(find(model, id).children[0].overrides, undefined);
	commands.updateShape({ ...find(model, source.id), fill: '#112233' });
	assert.equal(find(model, id).children[0].x, 108);
	commands.updateGeometry(find(model, source.id), 'width', 170);
	assert.equal(find(model, id).children[0].x, 108);
	commands.components.reset(id);
	assert.equal(find(model, id).width, 170);
	assert.equal(find(model, id).children[0].x, 58);
	roundTrip(model);
});

test('Design component schema rejects malformed metadata, variant conflicts and dependency cycles', () => {
	const source = main();
	const validate = (shapes: readonly DesignShape[]): void => {
		parseDesignDocument(serializeDesignDocument(documentFromShapes(shapes)));
	};
	assert.throws(() => validate([{ ...source, sourceId: generateUuid() }]), TypeError);
	assert.throws(() => validate([{ ...source, overrides: ['fill'] }]), TypeError);
	assert.throws(() => validate([{ ...source, instance: { componentId: source.id } }]), TypeError);
	assert.throws(
		() => validate([{ ...source, component: { kind: 'main', variant: { State: 'Default' } } }]),
		TypeError,
	);
	const recursive: Frame = {
		...source,
		children: [{ ...main([]), component: undefined, instance: { componentId: source.id } }],
	};
	assert.throws(() => validate([recursive]), TypeError);
	const set: Frame = { ...main([]), component: { kind: 'set', properties: ['State'] }, children: [source] };
	assert.throws(() => validate([set]), TypeError);
	const variant: Frame = { ...source, component: { kind: 'main', variant: { State: 'Default' } } };
	assert.throws(
		() => validate([{ ...set, children: [variant, { ...variant, id: generateUuid(), children: [] }] }]),
		TypeError,
	);
});

test('Design nested instance swaps reset to their outer source and cannot push recursive definitions', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const first = main();
	const second = main();
	model.applyEdit([first, second]);
	const childId = commands.components.createInstance(first.id)!;
	const outer = main([find(model, childId)]);
	model.applyEdit([find(model, first.id), find(model, second.id), outer]);
	const instanceId = commands.components.createInstance(outer.id)!;
	const nestedId = find(model, instanceId).children[0].id;
	commands.components.swap(nestedId, second.id);
	assert.equal(find(model, nestedId).instance?.componentId, second.id);
	commands.updateShape({ ...find<Text>(model, second.children[0].id), text: 'Second' });
	assert.equal((find(model, nestedId).children[0] as Text).text, 'Second');
	commands.components.reset(instanceId);
	assert.equal(find(model, nestedId).instance?.componentId, first.id);
	commands.components.swap(nestedId, outer.id);
	assert.equal(commands.components.canPush(instanceId), false);
	const version = model.version;
	commands.components.push(instanceId);
	assert.equal(model.version, version);
	roundTrip(model);
});

test('Design component hit testing selects its root unless deep selection is requested', () => {
	const source = main();
	const point = { x: source.x + 12, y: source.y + 12 };
	assert.equal(hitTestDesignShapes([source], point)?.id, source.id);
	assert.equal(hitTestDesignShapes([source], point, true)?.id, source.children[0].id);
});

test('Design pushing a nested swap retains its overrides without modifying the swapped component', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const first = main();
	const second = main();
	model.applyEdit([first, second]);
	const childId = commands.components.createInstance(first.id)!;
	const outer = main([find(model, childId)]);
	model.applyEdit([find(model, first.id), find(model, second.id), outer]);
	const instanceId = commands.components.createInstance(outer.id)!;
	const nestedId = find(model, instanceId).children[0].id;
	commands.components.swap(nestedId, second.id);
	commands.updateShape({ ...find<Text>(model, find(model, nestedId).children[0].id), text: 'Only outer' });
	commands.components.push(instanceId);
	assert.equal(find(model, childId).instance?.componentId, second.id);
	assert.equal((find(model, childId).children[0] as Text).text, 'Only outer');
	assert.equal(find<Text>(model, second.children[0].id).text, 'Default');
	assert.equal(((find(model, instanceId).children[0] as Frame).children[0] as Text).text, 'Only outer');
	roundTrip(model);
});

test('Design restoring a missing outer main preserves nested instance appearance and future inheritance', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const inner = main();
	model.applyEdit([inner]);
	const nested = commands.components.createInstance(inner.id)!;
	commands.updateShape({ ...find<Text>(model, find(model, nested).children[0].id), text: 'Outer label' });
	const outer = main([find(model, nested)]);
	model.applyEdit([find(model, inner.id), outer]);
	const id = commands.components.createInstance(outer.id)!;
	commands.removeShapes(new Set([outer.id]));
	commands.components.restore(id);
	assert.equal(((find(model, id).children[0] as Frame).children[0] as Text).text, 'Outer label');
	commands.updateShape({ ...find<Text>(model, inner.children[0].id), fill: '#ff0099' });
	assert.equal((find(model, id).children[0] as Frame).children[0].fill, '#ff0099');
	roundTrip(model);
});

test('Design reopens instances from the owning main while retaining explicit overrides and orphan snapshots', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const source = main();
	model.applyEdit([source]);
	const id = commands.components.createInstance(source.id)!;
	const instance = find(model, id);
	const label = instance.children[0] as Text;
	const stale: Frame = {
		...instance,
		fill: '#00ffff',
		children: [{ ...label, text: 'Saved override', overrides: ['text'] }],
	};
	model.replace(documentFromShapes([source, stale], model.value));
	assert.equal(find(model, id).fill, source.fill);
	assert.equal((find(model, id).children[0] as Text).text, 'Saved override');
	assert.equal(model.canUndo, false);
	model.replace(documentFromShapes([stale], model.value));
	assert.equal(find(model, id).fill, '#00ffff');
	roundTrip(model);
});
