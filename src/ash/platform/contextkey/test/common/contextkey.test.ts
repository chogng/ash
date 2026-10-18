import assert from "node:assert/strict";
import { test } from "mocha";
import { ContextKeyExpr, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { ContextKeyService } from "../../browser/contextKeyService.js";

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

test("typed context keys reset to their declared default", () => {
	using service = new ContextKeyService();
	const ready = new RawContextKey<boolean>(
		"test.ready.typed",
		false,
	).bindTo(service);

	assert.equal(ready.get(), false);
	ready.set(true);
	assert.equal(ready.get(), true);
	ready.reset();
	assert.equal(ready.get(), false);
});

test("scoped contexts inherit values and override the nearest DOM subtree", () => {
	using root = new ContextKeyService();
	const scopeElement = fakeNode();
	const childElement = fakeNode(scopeElement);
	const nestedElement = fakeNode(childElement);
	using scope = root.createScoped(scopeElement as HTMLElement);
	using nestedScope = root.createScoped(nestedElement as HTMLElement);

	root.setContext("test.language", "global");
	scope.setContext("test.language", "local");
	scope.setContext("test.focused", true);
	nestedScope.setContext("test.nested", true);

	const childContext = root.getContext(childElement);
	const nestedContext = root.getContext(nestedElement);
	assert.equal(childContext.getValue("test.language"), "local");
	assert.equal(childContext.getValue("test.focused"), true);
	assert.equal(nestedContext.getValue("test.language"), "local");
	assert.equal(nestedContext.getValue("test.nested"), true);
	assert.equal(
		root.contextMatchesRules(
			ContextKeyExpr.equals("test.language", "local"),
			childElement,
		),
		true,
	);

	scope.removeContext("test.language");
	assert.equal(childContext.getValue("test.language"), "global");
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

function fakeNode(parentNode: Node | null = null): Node {
	return {
		nodeType: 1,
		parentNode,
		getRootNode: () => parentNode?.getRootNode() ?? ({} as Node),
	} as Node;
}
