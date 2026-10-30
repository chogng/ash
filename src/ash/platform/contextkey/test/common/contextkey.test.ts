import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../browser/contextKeyService.js';

test('serialized shortcut conditions retain values, operators and grouping after editing', () => {
	using context = new ContextKeyService();
	const expressions = [
		'editorFocus && (mode == edit || resourceExtname =~ /\\.ts$/i)',
		'!readOnly && count >= 2 && count < 5',
		'mode in modes && otherMode not in modes',
		'!(readOnly || mode != edit)',
		'path == "C:\\\\Users\\\\O\'Brien"',
	];
	for (const text of expressions) {
		const original = ContextKeyExpr.deserialize(text)!;
		const restored = ContextKeyExpr.deserialize(original.serialize())!;
		assert.deepEqual(restored.keys(), original.keys());
		for (const mode of ['edit', 'preview']) for (const readOnly of [true, false]) {
			context.setContext('mode', mode);
			context.setContext('editorFocus', true);
			context.setContext('readOnly', readOnly);
			context.setContext('count', 3);
			context.setContext('modes', ['edit']);
			context.setContext('resourceExtname', '.ts');
			context.setContext('path', "C:\\Users\\O'Brien");
			assert.equal(restored.evaluate(context), original.evaluate(context), text);
		}
	}
});

test('typed context keys reset to their declared default', () => {
	using service = new ContextKeyService();
	const ready = new RawContextKey<boolean>(
		'test.ready.typed',
		false,
	).bindTo(service);

	assert.equal(ready.get(), false);
	ready.set(true);
	assert.equal(ready.get(), true);
	ready.reset();
	assert.equal(ready.get(), false);
});

test('scoped contexts inherit values and override the nearest DOM subtree', () => {
	using root = new ContextKeyService();
	const scopeElement = fakeNode();
	const childElement = fakeNode(scopeElement);
	const nestedElement = fakeNode(childElement);
	using scope = root.createScoped(scopeElement as HTMLElement);
	using nestedScope = root.createScoped(nestedElement as HTMLElement);

	root.setContext('test.language', 'global');
	scope.setContext('test.language', 'local');
	scope.setContext('test.focused', true);
	nestedScope.setContext('test.nested', true);

	const childContext = root.getContext(childElement);
	const nestedContext = root.getContext(nestedElement);
	assert.equal(childContext.getValue('test.language'), 'local');
	assert.equal(childContext.getValue('test.focused'), true);
	assert.equal(nestedContext.getValue('test.language'), 'local');
	assert.equal(nestedContext.getValue('test.nested'), true);
	assert.equal(
		root.contextMatchesRules(
			ContextKeyExpr.equals('test.language', 'local'),
			childElement,
		),
		true,
	);

	scope.removeContext('test.language');
	assert.equal(childContext.getValue('test.language'), 'global');
});

test('context key change buffering publishes one complete change set', () => {
	using contexts = new ContextKeyService();
	const changes: string[][] = [];
	using listener = contexts.onDidChangeContext(event => {
		changes.push([...event.keys].sort());
	});

	contexts.bufferChangeEvents(() => {
		contexts.setContext('resource', 'file:///project/main.ts');
		contexts.setContext('resourceScheme', 'file');
		contexts.bufferChangeEvents(() => {
			contexts.setContext('resourceLangId', 'typescript');
			contexts.setContext('resourceScheme', 'file');
		});
	});

	assert.deepEqual(changes, [[
		'resource',
		'resourceLangId',
		'resourceScheme',
	]]);
});

suite('scoped context change isolation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('scoped context changes reach descendants without invalidating parents or siblings', () => {
		using root = new ContextKeyService();
		const row = fakeNode();
		using scope = root.createScoped(row as HTMLElement);
		using child = scope.createScoped(fakeNode(row) as HTMLElement);
		using sibling = root.createScoped(fakeNode() as HTMLElement);
		const changes: string[] = [];
		using rootListener = root.onDidChangeContext(() => changes.push('root'));
		using rowListener = scope.onDidChangeContext(() => changes.push('row'));
		using childListener = child.onDidChangeContext(() => changes.push('child'));
		using siblingListener = sibling.onDidChangeContext(() => changes.push('sibling'));

		scope.setContext('scmHistoryProviderId', 'git');
		assert.deepEqual(changes.sort(), ['child', 'row']);
		assert.equal(child.getValue('scmHistoryProviderId'), 'git');
		assert.equal(sibling.getValue('scmHistoryProviderId'), undefined);
		changes.length = 0;
		scope.dispose();
		assert.deepEqual(changes.sort(), ['child', 'row']);
		assert.equal(child.getValue('scmHistoryProviderId'), undefined);
		changes.length = 0;
		root.setContext('scmHistoryProviderId', 'root');
		assert.deepEqual(changes.sort(), ['root', 'sibling']);
	});

	test('parent context changes only invalidate scopes that inherit changed keys', () => {
		using root = new ContextKeyService();
		const row = fakeNode();
		using scope = root.createScoped(row as HTMLElement);
		using child = scope.createScoped(fakeNode(row) as HTMLElement);
		scope.setContext('scmHistoryProviderId', 'git');
		const changes: string[][] = [];
		using listener = child.onDidChangeContext(event => changes.push([...event.keys].sort()));
		root.setContext('scmHistoryProviderId', 'other');
		assert.equal(changes.length, 0);
		root.bufferChangeEvents(() => {
			root.setContext('scmHistoryProviderId', 'another');
			root.setContext('scmHistoryBusy', true);
		});
		assert.equal(changes.length, 1);
		assert.ok(changes[0].includes('scmHistoryBusy'));
		assert.equal(child.getValue('scmHistoryBusy'), true);
		scope.removeContext('scmHistoryProviderId');
		assert.equal(child.getValue('scmHistoryProviderId'), 'another');
	});

	test('buffered scope changes retain their owners when nested and when callbacks throw', () => {
		using root = new ContextKeyService();
		using first = root.createScoped(fakeNode() as HTMLElement);
		using second = root.createScoped(fakeNode() as HTMLElement);
		const changes: string[][] = [];
		using rootListener = root.onDidChangeContext(() => changes.push(['root']));
		using firstListener = first.onDidChangeContext(event => changes.push(['first', ...event.keys].sort()));
		using secondListener = second.onDidChangeContext(event => changes.push(['second', ...event.keys].sort()));
		const failure = new Error('fixture failure');
		assert.throws(() => root.bufferChangeEvents(() => {
			first.setContext('firstKey', true);
			second.bufferChangeEvents(() => {
				second.setContext('secondKey', true);
				first.setContext('extraKey', true);
			});
			assert.deepEqual(changes, []);
			throw failure;
		}), error => error === failure);
		assert.deepEqual(changes, [['extraKey', 'first', 'firstKey'], ['second', 'secondKey']]);
	});
});

function fakeNode(parentNode: Node | null = null): Node {
	return {
		nodeType: 1,
		parentNode,
		getRootNode: () => parentNode?.getRootNode() ?? ({} as Node),
	} as Node;
}
