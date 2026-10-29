import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createTrustedTypesPolicy } from '../../browser/trustedTypes.js';

interface TestGlobals {
	MonacoEnvironment?: {
		createTrustedTypesPolicy?(name: string, options?: { readonly createHTML?: (value: string) => string }): { readonly name: string; readonly createHTML?: (value: string) => string };
	};
	trustedTypes?: {
		createPolicy(name: string, options?: { readonly createHTML?: (value: string) => string }): { readonly name: string; readonly createHTML?: (value: string) => string };
	};
}

test('createTrustedTypesPolicy prefers the embedding environment and preserves its receiver', () => {
	const globals = globalThis as typeof globalThis & TestGlobals;
	const previousEnvironment = globals.MonacoEnvironment;
	const previousFactory = globals.trustedTypes;
	const environment = {
		prefix: 'host',
		createTrustedTypesPolicy(this: { prefix: string }, name: string, options?: { readonly createHTML?: (value: string) => string }) {
			return { name: `${this.prefix}:${name}`, createHTML: options?.createHTML };
		},
	};
	try {
		globals.MonacoEnvironment = environment;
		globals.trustedTypes = { createPolicy: name => ({ name: `browser:${name}` }) };
		const policy = createTrustedTypesPolicy('editor', { createHTML: value => value.toUpperCase() });
		assert.equal(policy?.name, 'host:editor');
		assert.equal(policy?.createHTML?.('safe'), 'SAFE');
	} finally {
		globals.MonacoEnvironment = previousEnvironment;
		globals.trustedTypes = previousFactory;
	}
});

test('createTrustedTypesPolicy uses the browser realm when no host factory exists', () => {
	const globals = globalThis as typeof globalThis & TestGlobals;
	const previousEnvironment = globals.MonacoEnvironment;
	const previousFactory = globals.trustedTypes;
	try {
		globals.MonacoEnvironment = undefined;
		globals.trustedTypes = { createPolicy: (name, options) => ({ name, createHTML: options?.createHTML }) };
		const policy = createTrustedTypesPolicy('editor', { createHTML: value => `<safe>${value}</safe>` });
		assert.equal(policy?.name, 'editor');
		assert.equal(policy?.createHTML?.('content'), '<safe>content</safe>');
		assert.throws(() => createTrustedTypesPolicy(''), TypeError);
	} finally {
		globals.MonacoEnvironment = previousEnvironment;
		globals.trustedTypes = previousFactory;
	}
});
