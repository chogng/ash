import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parse } from '../../common/marshalling.js';
import { URI } from '../../common/uri.js';

test('marshalling restores nested tagged URIs without changing encoded resource identity', () => {
	const file = URI.file('/workspace/中文 #100%.ts');
	const remote = URI.parse('ash-remote://ssh+build/workspace/a%2Fb.ts?name=a%26b&literal=%2520#L3');
	const result = parse(JSON.stringify({ resources: [file, { remote }], value: '%20 中文', empty: null })) as {
		resources: [URI, { remote: URI }];
		value: string;
		empty: null;
	};
	assert.ok(result.resources[0] instanceof URI);
	assert.ok(result.resources[1].remote instanceof URI);
	assert.equal(result.resources[0].toString(), file.toString());
	assert.equal(result.resources[1].remote.toString(), remote.toString());
	assert.equal(
		result.resources[1].remote.with({ fragment: 'L4' }).toString(),
		remote.with({ fragment: 'L4' }).toString(),
	);
	assert.equal(result.value, '%20 中文');
	assert.equal(result.empty, null);
});

test('marshalling accepts component-only URI payloads and preserves ordinary and unknown tagged data', () => {
	const restored = parse('{"$mid":1,"scheme":"file","path":"/workspace/a#b.ts"}');
	assert.ok(restored instanceof URI);
	assert.equal(restored.toString(), URI.file('/workspace/a#b.ts').toString());
	assert.equal((parse('{"$mid":1,"scheme":"file"}') as URI).toString(), 'file:///');
	assert.equal((parse('{"$mid":1,"scheme":"command","path":"ash.open"}') as URI).toString(), 'command:ash.open');
	assert.equal((parse('{"$mid":1,"scheme":"untitled","path":"/draft.ts"}') as URI).toString(), 'untitled:/draft.ts');
	assert.equal(
		(parse('{"$mid":1,"scheme":"https","authority":"[::1]:8443","path":"/workspace"}') as URI).toString(),
		'https://[::1]:8443/workspace',
	);
	assert.equal(
		(parse('{"$mid":1,"scheme":"https","authority":"EXAMPLE.TEST:8443","path":"/workspace"}') as URI).toString(),
		'https://example.test:8443/workspace',
	);
	assert.equal(
		(parse('{"$mid":1,"scheme":"HTTPS","authority":"EXAMPLE.TEST","path":"/folder/../file"}') as URI).toString(),
		'https://example.test/file',
	);
	for (const value of [
		null,
		false,
		0,
		'text',
		[],
		{ scheme: 'file', path: '/ordinary' },
		{ $mid: 15, instanceId: 3 },
		{ $mid: 999, value: '/unknown' },
	]) {
		assert.deepEqual(parse(JSON.stringify(value)), value);
	}
});

test('marshalling rejects malformed tags and conflicting external URI spelling', () => {
	const resource = URI.parse('ash-remote://ssh+build/workspace/a%2Fb.ts?name=a%26b#L3');
	for (const value of [
		{ $mid: 1 },
		{ $mid: 1, scheme: '' },
		{ $mid: 1, scheme: 'file', path: 3 },
		{ ...resource.toJSON(), authority: 'ssh+other' },
		{ ...resource.toJSON(), path: '/workspace/other.ts' },
		{ ...resource.toJSON(), query: 'other' },
		{ ...resource.toJSON(), fragment: 'L4' },
		{ ...resource.toJSON(), external: 3 },
		{ ...resource.toJSON(), external: '/relative' },
		{ ...resource.toJSON(), external: 'ash-remote://ssh+build/%ZZ' },
	]) {
		assert.throws(() => parse(JSON.stringify(value)), TypeError);
	}
	assert.throws(() => parse('not-json'), SyntaxError);
});

test('marshalling rejects components that inject URL structure before canonicalization', () => {
	for (const scheme of ['https://attacker.invalid/', 'https:', 'https\n', ' https', '1https']) {
		assert.throws(() => parse(JSON.stringify({ $mid: 1, scheme, path: '/workspace' })), TypeError);
	}
	assert.throws(() => parse(JSON.stringify({ $mid: 1, scheme: 'https', path: '/workspace' })), TypeError);
	for (const authority of [
		'example.test/other',
		'example.test?query',
		'example.test#fragment',
		'example.test\\other',
		'@example.test',
		'user@example.test',
		'example.test\n',
		' example.test',
	]) {
		assert.throws(
			() => parse(JSON.stringify({ $mid: 1, scheme: 'https', authority, path: '/workspace' })),
			TypeError,
		);
	}
});

test('marshalling retains JSON prototype keys as own data without modifying object prototypes', () => {
	const result = parse(
		'{"__proto__":{"marshallingPolluted":true},"constructor":{"prototype":{"marshallingPolluted":true}}}',
	) as Record<string, unknown>;
	assert.equal(Object.getPrototypeOf(result), Object.prototype);
	assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), true);
	assert.equal('marshallingPolluted' in {}, false);
});
