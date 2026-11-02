import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'mocha';

// Runtime detection and mainWindow are realm-owned. A fresh process exercises
// their production initialization without changing shared module state.
function runFontScenario(runtime: 'electron' | 'web', scenario: string): void {
	const moduleUrl = new URL('../../browser/fonts.js', import.meta.url).href;
	const script = `
		import assert from 'node:assert/strict';
		globalThis.ash = { environment: { runtime: ${JSON.stringify(runtime)}, os: 'linux', arch: 'x64' } };
		globalThis.window = {};
		const fonts = await import(${JSON.stringify(moduleUrl)});
		${scenario}
	`;
	assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' }));
}

test('getFonts queries the main window lazily and preserves family order and duplicates', () => {
	runFontScenario('electron', `
		let calls = 0;
		globalThis.queryLocalFonts = () => { throw new Error('Wrong font query realm'); };
		window.queryLocalFonts = async function () {
			assert.equal(this, window);
			calls++;
			return [{ family: 'Test Serif' }, { family: 'Test Sans' }, { family: 'Test Serif' }];
		};
		assert.equal(calls, 0);
		assert.deepEqual(await fonts.getFonts(), ['Test Serif', 'Test Sans', 'Test Serif']);
		assert.equal(calls, 1);
	`);
});

test('font queries return an empty list when the main window has no font API', () => {
	runFontScenario('electron', `
		assert.deepEqual(await fonts.getFonts(), []);
		assert.deepEqual(await fonts.getFontSnippets(), []);
	`);
});

test('font queries contain denied permission and synchronous host failures', () => {
	runFontScenario('electron', `
		const errors = [];
		console.error = message => errors.push(message);
		window.queryLocalFonts = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
		assert.deepEqual(await fonts.getFonts(), []);
		assert.deepEqual(await fonts.getFontSnippets(), []);
		window.queryLocalFonts = () => { throw new Error('Host unavailable'); };
		assert.deepEqual(await fonts.getFonts(), []);
		assert.equal(errors.length, 3);
		assert.ok(errors[0].includes('Denied'));
		assert.ok(errors[2].includes('Host unavailable'));
	`);
});

test('desktop font snippets retain the exact installed family names', () => {
	runFontScenario('electron', `
		window.queryLocalFonts = async () => [{ family: 'Test Mono' }, { family: '字体 "测试"' }, { family: 'Test Mono' }];
		assert.deepEqual(await fonts.getFontSnippets(), [{ body: 'Test Mono' }, { body: '字体 "测试"' }, { body: 'Test Mono' }]);
	`);
});

test('web configuration skips font queries while explicit font loading remains available', () => {
	runFontScenario('web', `
		let calls = 0;
		window.queryLocalFonts = async () => { calls++; return [{ family: 'Web Serif' }]; };
		assert.deepEqual(await fonts.getFontSnippets(), []);
		assert.equal(calls, 0);
		assert.deepEqual(await fonts.getFonts(), ['Web Serif']);
		assert.equal(calls, 1);
	`);
});
