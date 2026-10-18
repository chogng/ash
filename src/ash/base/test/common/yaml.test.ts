import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parse, type YamlNode, type YamlParseError } from '../../common/yaml.js';

test('YAML syntax keeps string scalars, collection styles and original UTF-16 offsets', () => {
	const source = 'name: "🌲: tree"\r\nvalues: [true, 12, null, "", ~]\r\nbody: >-\r\n  first\r\n  next\r\nnested:\r\n  item: {a: one}\r\n';
	const errors: YamlParseError[] = [];
	const root = parse(source, errors);
	assert.deepEqual(errors, []);
	assert.equal(root?.type, 'map');
	if (root?.type !== 'map') throw new Error('Expected map');
	assert.equal(root.style, 'block');
	assert.deepEqual(root.properties.map(property => property.key.value), ['name', 'values', 'body', 'nested']);
	const name = root.properties[0]!.value;
	assert.equal(name.type, 'scalar');
	if (name.type !== 'scalar') throw new Error('Expected scalar');
	assert.deepEqual([name.value, name.format, name.rawValue], ['🌲: tree', 'double', '"🌲: tree"']);
	assert.equal(name.startOffset, source.indexOf('"🌲'));
	assert.equal(name.endOffset, name.startOffset + name.rawValue.length);
	const values = root.properties[1]!.value;
	assert.equal(values.type, 'sequence');
	if (values.type !== 'sequence') throw new Error('Expected sequence');
	assert.equal(values.style, 'flow');
	assert.deepEqual(values.items.map(item => item.type === 'scalar' ? [item.value, item.format] : undefined), [
		['true', 'none'], ['12', 'none'], ['null', 'none'], ['', 'double'], ['~', 'none'],
	]);
	const body = root.properties[2]!.value;
	assert.equal(body.type === 'scalar' && body.value, 'first next');
	assert.equal(body.type === 'scalar' && body.format, 'folded');
	assert.ok(body.type === 'scalar' && body.rawValue.includes('\r\n'));
	const pending = [root as YamlNode];
	while (pending.length) {
		const node = pending.pop()!;
		assert.equal(Object.getPrototypeOf(node), Object.prototype, 'the public AST contains ordinary objects');
		if (node.type === 'scalar') assert.equal(source.slice(node.startOffset, node.endOffset), node.rawValue);
		else if (node.type === 'sequence') pending.push(...node.items);
		else for (const property of node.properties) pending.push(property.key, property.value);
	}
});

test('YAML duplicate-key policy reports offsets and preserves every property in source order', () => {
	const source = 'name: one\r\nname: two\r\n';
	for (const allowDuplicateKeys of [false, true]) {
		const errors: YamlParseError[] = [];
		const root = parse(source, errors, { allowDuplicateKeys });
		assert.equal(root?.type, 'map');
		if (root?.type !== 'map') throw new Error('Expected map');
		assert.deepEqual(root.properties.map(property => property.value.type === 'scalar' && property.value.value), ['one', 'two']);
		const duplicate = errors.find(error => error.code === 'DUPLICATE_KEY');
		assert.equal(duplicate === undefined, allowDuplicateKeys);
		if (duplicate) {
			assert.equal(duplicate.startOffset, source.lastIndexOf('name'));
			assert.equal(duplicate.endOffset, duplicate.startOffset + 1);
		}
	}
});

test('YAML unsupported references and tags produce isolated scalar placeholders', () => {
	const source = 'anchor: &saved { self: *saved }\nalias: *saved\ntag: !!str text\nsafe: plain\n';
	const errors: YamlParseError[] = [];
	const root = parse(source, errors);
	assert.equal(root?.type, 'map');
	if (root?.type !== 'map') throw new Error('Expected map');
	const unsupported = errors.filter(error => error.code.startsWith('YAML_'));
	assert.deepEqual(unsupported.map(error => error.code), ['YAML_ANCHOR', 'YAML_ALIAS', 'YAML_TAG']);
	for (let index = 0; index < unsupported.length; index++) {
		const value: YamlNode = root.properties[index]!.value;
		assert.equal(value.type, 'scalar');
		if (value.type !== 'scalar') throw new Error('Expected scalar');
		assert.equal(value.value, '');
		assert.equal(value.startOffset, unsupported[index]!.startOffset);
		assert.equal(value.endOffset, unsupported[index]!.endOffset);
		assert.equal(value.rawValue, source.slice(value.startOffset, value.endOffset));
	}
	const safe = root.properties[3]!.value;
	assert.equal(safe.type === 'scalar' && safe.value, 'plain');
});

test('YAML syntax has no application depth limit and returns recoverable malformed trees', () => {
	const errors: YamlParseError[] = [];
	let node = parse('['.repeat(32) + 'leaf' + ']'.repeat(32), errors);
	assert.deepEqual(errors, []);
	for (let depth = 0; depth < 32; depth++) {
		assert.equal(node?.type, 'sequence');
		if (node?.type !== 'sequence') throw new Error('Expected sequence');
		node = node.items[0];
	}
	assert.equal(node?.type === 'scalar' && node.value, 'leaf');
	assert.equal(parse(' # comment\r\n'), undefined);
	const malformedErrors: YamlParseError[] = [];
	assert.equal(parse('name: [one', malformedErrors)?.type, 'map');
	assert.ok(malformedErrors.length > 0);
	assert.ok(malformedErrors.every(error => error.startOffset >= 0 && error.endOffset >= error.startOffset));
});
