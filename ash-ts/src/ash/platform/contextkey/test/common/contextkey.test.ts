import assert from "node:assert/strict";
import { test } from "mocha";
import {
	ContextKeyExpr,
	ContextKeyService,
	RawContextKey,
} from "../../../../platform/contextkey/common/contextkey.js";

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
