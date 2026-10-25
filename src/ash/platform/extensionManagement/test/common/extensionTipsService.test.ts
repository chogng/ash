import assert from 'node:assert/strict';
import { test } from 'mocha';
import { extensionTips, readExtensionTips } from '../../common/extensionTipsService.js';

const catalog = () => ({ schemaVersion: 1, ...structuredClone(extensionTips) });

test('The product catalog includes resolvable package identities for every recommendation context', () => {
	assert.ok(extensionTips.editors.length && extensionTips.projects.length);
	for (const tips of [extensionTips.executables, extensionTips.keymaps, extensionTips.remote, extensionTips.web]) {
		assert.ok(tips.length);
		assert.equal(new Set(tips.map(tip => tip.id)).size, tips.length);
	}
	assert.deepEqual(readExtensionTips(catalog()), extensionTips);
});

test('Recommendation rules cannot redefine package UI targets', () => {
	for (const field of ['targets', 'uiTargets']) {
		assert.throws(() => readExtensionTips({ ...catalog(), keymaps: [{ id: 'example.tool@ash', name: 'Tool', [field]: ['ide'] }] }), /package manifests/u);
	}
});

test('Release data rejects unknown versions, paths, executable commands and malformed identities', () => {
	for (const value of [
		{ ...catalog(), schemaVersion: 2 },
		{ ...catalog(), unexpected: true },
		{ ...catalog(), projects: [{ filename: '../Cargo.toml', language: 'rust' }] },
		{ ...catalog(), executables: [{ id: 'example.tool@ash', name: 'Tool', executables: ['python --version'], important: true }] },
		{ ...catalog(), keymaps: [{ id: 'https://example.test', name: 'Invalid' }] },
	]) { assert.throws(() => readExtensionTips(value), TypeError); }
});
