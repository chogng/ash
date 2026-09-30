import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { desktopStartupTracePlugin } from './desktopStartupTracePlugin.ts';

const desktopRoot = resolve(import.meta.dirname, '../../../app-ts');
const plugin = desktopStartupTracePlugin(desktopRoot);
const transform = plugin.transform as (code: string, id: string) => { code: string } | undefined;

for (const [lineEndingName, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
	test(`Desktop trace build injects marks into startup steps with ${lineEndingName} source`, () => {
		for (const [path, marks] of [
			['src/ash/code/electron-browser/workbench/workbench.ts', ['ash.desktop.trace-build-v1', 'ash.desktop.contributions-start']],
			['src/ash/code/electron-browser/workbench/modes/code.ts', ['ash.desktop.contributions-ready']],
			['src/ash/code/electron-browser/workbench/modes/academic.ts', ['ash.desktop.contributions-ready']],
			['src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.ts', ['ash.decoder.schema-start', 'ash.decoder.schema-ready']],
			['src/ash/platform/native/electron-browser/rendererApi.ts', ['ash.rendererApi.start', 'ash.rendererApi.acquire-start', 'ash.rendererApi.acquired', 'ash.rendererApi.initialized', 'ash.rendererApi.workspace-initialized']],
			['src/ash/workbench/electron-browser/desktop.main.ts', ['ash.desktop.open-start', 'ash.desktop.lifecycle-ready']],
			['src/ash/workbench/browser/workbench.ts', ['ash.workbench.constructor-start', 'ash.workbench.auxiliary-restore-start', 'ash.workbench.constructor-done']],
		] as const) {
			const file = resolve(desktopRoot, path);
			const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', lineEnding);
			assert.doesNotMatch(source, /performance\.mark\('ash\./u);
			const output = transform(source, file)?.code;
			assert.ok(output, path);
			for (const mark of marks) assert.ok(output.includes(`performance.mark('${mark}')`), `${path}: ${mark}`);
			if (path.endsWith('/rendererApi.ts')) {
				const backendStart = output.indexOf('backend = createRendererHost(');
				const initialized = 'await initialize();';
				const initializationEnd = output.lastIndexOf(initialized, backendStart) + initialized.length;
				assert.equal(output.slice(initializationEnd, backendStart).trim(), "performance.mark('ash.rendererApi.initialized');");
				assert.equal(output.split("performance.mark('ash.rendererApi.initialized');").length - 1, 1);
			}
		}
	});
}

test('Desktop trace build rejects moved anchors and ignores unrelated modules', () => {
	const file = resolve(desktopRoot, 'src/ash/code/electron-browser/workbench/workbench.ts');
	assert.throws(() => transform('await renamed();', file), /anchor is missing or ambiguous/u);
	assert.throws(() => transform('await modeLoaders[modeId]();\r\nawait modeLoaders[modeId]();', file), /anchor is missing or ambiguous/u);
	assert.equal(transform('export const value = 1;', resolve(desktopRoot, 'src/ash/unrelated.ts')), undefined);
});
