import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { documentFromShapes, flattenDesignShapes, parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/creator/common/model/document.js';
import { designTextSegments, designTextStyleAt, formatDesignText, parseDesignTextProperties, parseDesignTextStyle, replaceDesignText, updateDesignText, type DesignTextShape } from '../../contrib/creator/common/model/designText.js';
import { resolveDesignLayout } from '../../contrib/creator/common/model/layout.js';

function text(content = 'Hello world'): DesignTextShape { return { id: generateUuid(), kind: 'text', text: content, x: 0, y: 0, width: 100, height: 24, rotation: 0, fill: '#000000', fontSize: 20 }; }
function find(model: DesignModel, id: string): DesignTextShape { return flattenDesignShapes(model.value.shapes).find(shape => shape.id === id) as DesignTextShape; }

test('Text formatting splits and merges runs while deleting and inserting preserve unaffected styles', () => {
	let shape = formatDesignText(text(), 0, 5, { fontWeight: 700 });
	shape = formatDesignText(shape, 3, 8, { fontStyle: 'italic' });
	assert.deepEqual(shape.textRuns?.map(run => [run.start, run.end]), [[0, 3], [3, 5], [5, 8]]);
	shape = replaceDesignText(shape, 4, 7, '你好');
	assert.equal(shape.text, 'Hell你好orld');
	assert.equal(designTextStyleAt(shape, 4).fontWeight, 700);
	assert.equal(designTextStyleAt(shape, 6).fontStyle, 'italic');
	shape = formatDesignText(shape, 0, shape.text.length, { fontWeight: 400, fontStyle: 'normal' });
	assert.equal(shape.textRuns?.length, 1);
	assert.equal(designTextSegments(shape).map(run => shape.text.slice(run.start, run.end)).join(''), shape.text);
});

test('Full-text replacement preserves rich suffixes and never splits surrogate pairs', () => {
	const shape = formatDesignText(text('A😀tail'), 3, 7, { fill: '#ff0000' });
	const updated = updateDesignText(shape, 'A😃tail');
	assert.deepEqual(updated.textRuns, [{ start: 3, end: 7, style: { fill: '#ff0000' } }]);
	assert.deepEqual(parseDesignTextProperties({ ...updated }).textRuns, updated.textRuns);
	assert.equal(updateDesignText(shape, '').textRuns?.length, 0);
});

test('Text persistence rejects overlapping ranges, split Unicode, invalid OpenType values and unknown CSS', () => {
	for (const runs of [
		[{ start: 0, end: 3, style: {} }, { start: 2, end: 4, style: {} }],
		[{ start: 2, end: 4, style: {} }],
		[{ start: 0, end: 99, style: {} }],
		[{ start: 0, end: 1, style: { fontFeatures: { 'bad"': 1 } } }],
	]) { assert.throws(() => parseDesignTextProperties({ ...text('A😀tail'), textRuns: runs })); }
	assert.throws(() => parseDesignTextStyle({ fontSize: Infinity }));
	assert.throws(() => parseDesignTextStyle({ backgroundImage: 'url(https://example.com)' }));
	assert.throws(() => parseDesignTextStyle({ fontFeatures: { liga: -1 } }));
	assert.doesNotThrow(() => parseDesignTextStyle({ fontVariations: { slnt: -15, wght: 650 }, fontFeatures: { liga: 0, ss01: 1 }, lineHeight: 0 }));
});

test('Rich text, advanced typography and linked styles round-trip as immutable document values', () => {
	const shape: DesignTextShape = { ...formatDesignText(text(), 1, 4, { fontFamily: 'serif', fontSize: 28, fontStyle: 'italic', textDecoration: 'underline', fontVariations: { wght: 550 } }), textAutoResize: 'height', textVerticalAlign: 'center', paragraphSpacing: 12, paragraphIndent: 20, textDirection: 'rtl', textAlign: 'justify', textWrap: 'pretty', textTrim: 'cap-height', maxLines: 3, textTruncate: true };
	const document = documentFromShapes([shape]);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(document)), document);
	const saved = document.shapes[0] as DesignTextShape;
	assert.ok(Object.isFrozen(saved.textRuns)); assert.ok(Object.isFrozen(saved.textRuns![0].style.fontVariations));
});

test('Continuous typing shares history but formatting and another view split the undo group', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model); const shape = text(); model.applyEdit([shape]); const group = {};
	commands.text.replace(shape.id, 0, 5, 'Hi', undefined, group); commands.text.replace(shape.id, 2, 2, '!', undefined, group);
	assert.equal(find(model, shape.id).text, 'Hi! world'); model.undo(); assert.equal(find(model, shape.id).text, 'Hello world'); model.redo();
	commands.text.format(shape.id, 0, 3, { fontWeight: 700 }); commands.text.replace(shape.id, 3, 3, '?', undefined, group);
	model.undo(); assert.equal(find(model, shape.id).text, 'Hi! world'); assert.equal(find(model, shape.id).textRuns![0].style.fontWeight, 700);
	model.undo(); assert.equal(find(model, shape.id).textRuns?.length, 0);
});

test('Local and library text styles update ranges without replacing explicit emphasis or alignment', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model); const a = { ...text('Source'), fontSize: 24, textAlign: 'right' as const, paragraphSpacing: 8, fontFeatures: { liga: 0 } }; const b = { ...text(), textAlign: 'center' as const }; model.applyEdit([a, b]);
	const styleId = commands.resources.createStyle(a, 'text', 'Body');
	const style = commands.resources.value.styles[0]; assert.equal(style.values.textAlign, undefined);
	commands.text.format(b.id, 0, 5, style.values, styleId); commands.text.format(b.id, 0, 5, { fontStyle: 'italic' });
	commands.resources.updateStyle(styleId, { ...a, fontSize: 32, fontFamily: 'serif', paragraphSpacing: 14 });
	assert.equal(designTextStyleAt(find(model, b.id), 0).fontSize, 32); assert.equal(designTextStyleAt(find(model, b.id), 0).fontStyle, 'italic');
	assert.equal(find(model, b.id).textAlign, 'center'); assert.equal(find(model, b.id).textRuns![0].styleId, styleId);
	assert.equal(designTextStyleAt(find(model, b.id), 8).fontSize, 20);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	using consumer = new DesignModel(); const other = text('Library'); const consuming = new DocumentCommands(consumer); consumer.applyEdit([other]);
	consuming.resources.acceptLibrary({ id: model.value.documentId, name: 'Typography', uri: 'file:///typography.ash-design-library', version: 'a'.repeat(64), enabled: true, document: model.value });
	consuming.text.format(other.id, 0, 7, style.values, styleId); assert.equal(designTextStyleAt(find(consumer, other.id), 0).fontSize, 32);
});

test('Text variable replacements preserve styles and leave no out-of-bounds runs', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model); const shape = formatDesignText(text('A😀tail'), 3, 7, { fontWeight: 700 }); model.applyEdit([shape]);
	const collection = commands.resources.addCollection('Copy'); const mode = commands.resources.value.collections[0].defaultMode; const variable = commands.resources.addVariable(collection, 'Label', 'string');
	commands.resources.setVariableValue(variable, mode, 'A😃tail'); commands.resources.bind(new Set([shape.id]), 'text', variable);
	assert.equal(designTextStyleAt(find(model, shape.id), 3).fontWeight, 700);
	commands.resources.setVariableValue(variable, mode, 'A'); assert.deepEqual(find(model, shape.id).textRuns, []);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Component text overrides carry their ranges and reset together after main text changes', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model); const label = formatDesignText(text(), 0, 5, { fontWeight: 700 });
	const main: DesignShape = { id: generateUuid(), x: 0, y: 0, width: 120, height: 80, rotation: 0, fill: '#ffffff', kind: 'frame', children: [label], clip: true, component: { kind: 'main' } }; model.applyEdit([main]);
	const instanceId = commands.components.createInstance(main.id)!; const instance = flattenDesignShapes(model.value.shapes).find(shape => shape.id === instanceId)! as Extract<DesignShape, { kind: 'frame'; }>;
	const id = instance.children[0].id; commands.text.replace(id, 0, 5, 'Custom'); commands.text.format(id, 0, 6, { fontStyle: 'italic' });
	commands.text.replace(label.id, 0, 11, 'Main'); assert.equal(find(model, id).text, 'Custom world'); assert.equal(designTextStyleAt(find(model, id), 0).fontStyle, 'italic');
	commands.components.reset(instanceId, 'text'); assert.equal(find(model, id).text, 'Main'); assert.deepEqual(find(model, id).textRuns, find(model, label.id).textRuns);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Font measurement feeds auto width, wrapping auto height, limits and parent hug in one layout', () => {
	const measure = (shape: DesignTextShape, width: number | undefined) => ({ width: width ?? shape.text.length * 10, height: 20 * Math.max(1, Math.ceil(shape.text.length * 10 / (width ?? Infinity))) });
	const auto = { ...text('1234567890'), textAutoResize: 'width' as const, sizeLimits: { maxWidth: 40 } };
	let result = resolveDesignLayout([auto], [], measure)[0]; assert.equal(result.width, 40); assert.equal(result.height, 60);
	const child = { ...auto, textAutoResize: 'height' as const, sizeLimits: undefined, sizing: { width: 'fill' as const, height: 'fixed' as const } };
	const frame: DesignShape = { id: generateUuid(), kind: 'frame', x: 0, y: 0, width: 50, height: 20, rotation: 0, fill: '#ffffff', clip: false, children: [child], autoLayout: { direction: 'vertical', gap: 0, padding: { top: 5, right: 5, bottom: 5, left: 5 }, align: 'start', justify: 'start', width: 'fixed', height: 'hug' } };
	result = resolveDesignLayout([frame], [], measure)[0]; assert.equal(result.height, 70); assert.equal((result as typeof frame).children[0].width, 40);
	const stable = resolveDesignLayout([result], [result], measure); assert.deepEqual(stable[0], result);
});

test('Line height and letter spacing unit changes preserve pixels independently for rich font sizes', () => {
	const shape = formatDesignText({ ...text(), lineHeight: 30, letterSpacing: 2 }, 0, 5, { fontSize: 40 });
	const formatted = formatDesignText(shape, 0, 11, { lineHeightUnit: 'percent', letterSpacingUnit: 'percent' });
	assert.equal(designTextStyleAt(formatted, 0).lineHeight, 75); assert.equal(designTextStyleAt(formatted, 8).lineHeight, 150);
	assert.equal(designTextStyleAt(formatted, 0).letterSpacing, 5); assert.equal(designTextStyleAt(formatted, 8).letterSpacing, 10);
	const restored = formatDesignText(formatted, 0, 11, { lineHeightUnit: 'px', letterSpacingUnit: 'px' });
	assert.equal(designTextStyleAt(restored, 0).lineHeight, 30); assert.equal(designTextStyleAt(restored, 8).letterSpacing, 2);
});

test('Loaded font metrics update auto sizing and history without creating an undo step', () => {
	let advance = 10;
	using model = new DesignModel(undefined, (shape, width) => ({ width: width ?? shape.text.length * advance, height: 20 }));
	const commands = new DocumentCommands(model); const shape = { ...text('AB'), textAutoResize: 'width' as const }; model.applyEdit([shape]);
	commands.text.replace(shape.id, 2, 2, 'CD'); advance = 20; model.refreshTextLayout(); assert.equal(find(model, shape.id).width, 80);
	model.undo(); assert.equal(find(model, shape.id).text, 'AB'); assert.equal(find(model, shape.id).width, 40);
	model.undo(); assert.equal(model.value.shapes.length, 0);
});

test('Rich text keeps linked style overrides on inserted text and after scaling a group', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model); const a = { ...text('AB'), fontSize: 18, letterSpacing: 2 }; model.applyEdit([a]);
	const id = commands.resources.createStyle(a, 'text', 'Body'); commands.text.format(a.id, 0, 2, commands.resources.value.styles[0].values, id);
	commands.text.replace(a.id, 1, 1, 'X', { fontStyle: 'italic' }); assert.equal(designTextStyleAt(find(model, a.id), 1).fontStyle, 'italic');
	commands.resources.updateStyle(id, { ...a, fontSize: 24 }); assert.equal(designTextStyleAt(find(model, a.id), 1).fontSize, 24); assert.equal(designTextStyleAt(find(model, a.id), 1).fontStyle, 'italic');
	const group: DesignShape = { id: generateUuid(), kind: 'group', x: 0, y: 0, width: 200, height: 48, contentWidth: 100, contentHeight: 24, rotation: 0, fill: '#808080', children: [find(model, a.id)] };
	model.applyEdit([group]); commands.ungroup(group.id);
	assert.equal(designTextStyleAt(find(model, a.id), 1).fontSize, 48); assert.equal(designTextStyleAt(find(model, a.id), 1).fontStyle, 'italic');

});

test('Bold and underline shortcuts normalize mixed selections while preserving strikethrough', () => {
	using model = new DesignModel(); const commands = new DocumentCommands(model);
	const shape = formatDesignText(formatDesignText(text(), 0, 5, { fontWeight: 700, textDecoration: 'line-through' }), 6, 11, { textDecoration: 'underline' }); model.applyEdit([shape]);
	commands.text.toggle(shape.id, 0, 11, 'bold'); assert.equal(designTextStyleAt(find(model, shape.id), 8).fontWeight, 700); assert.equal(designTextStyleAt(find(model, shape.id), 0).fontWeight, 700);
	commands.text.toggle(shape.id, 0, 11, 'underline'); assert.equal(designTextStyleAt(find(model, shape.id), 0).textDecoration, 'underline line-through'); assert.equal(designTextStyleAt(find(model, shape.id), 8).textDecoration, 'underline');
	model.undo(); assert.equal(designTextStyleAt(find(model, shape.id), 0).textDecoration, 'line-through'); assert.equal(designTextStyleAt(find(model, shape.id), 8).textDecoration, 'underline');
});
