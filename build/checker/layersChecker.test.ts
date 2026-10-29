import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkLayers } from './layersChecker.ts';
import { PROJECTS } from './layersTypeCheck.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const compiler = join(repositoryRoot, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');

function fixture(t: test.TestContext) {
	const directory = mkdtempSync(join(repositoryRoot, '.build/layer-checker-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const sourceRoot = join(directory, 'src/ash');
	const write = (name: string, content: string): void => {
		const path = join(sourceRoot, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	write('platform/ipc/common/mainProcessService.ts', 'export interface IMainProcessService { getChannel(name: string): unknown; }\nexport const IMainProcessService = {};\n');
	const config = join(directory, 'tsconfig.json');
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				noLib: true,
				types: [],
			},
		}),
	);
	return { directory, sourceRoot, write, check: () => checkLayers(config, sourceRoot) };
}

test('runtime imports reject Node/Electron through every literal import form', t => {
	const project = fixture(t);
	const cases = [
		['common/import.ts', "import 'node:fs';"],
		['common/reexport.ts', "export * from 'fs/promises';"],
		['browser/dynamic.ts', "void import('node:os');"],
		['browser/type.ts', "export type Host = typeof import('electron');"],
		['worker/require.ts', "declare const require: (name: string) => unknown; require('node:path');"],
		['electron-browser/import.ts', "import 'node:crypto';"],
		['browser/equal.ts', "import host = require('electron/renderer'); void host;"],
	] as const;
	for (const [name, content] of cases) project.write(`base/${name}`, content);
	const violations = project.check();
	assert.deepEqual(violations.map(item => relative(project.sourceRoot, item.fileName).replaceAll('\\', '/')).sort(), cases.map(([name]) => `base/${name}`).sort());
	assert.ok(violations.every(item => item.line === 1 && item.character > 0 && item.message.includes('unavailable')));
});

test('native IPC type checks follow import aliases, namespaces and re-exports', t => {
	const project = fixture(t);
	project.write('platform/ipc/electron-browser/public.ts', "export { IMainProcessService as DesktopIPC } from '../common/mainProcessService.js';");
	project.write('workbench/browser/alias.ts', "import type { DesktopIPC as Host } from '../../platform/ipc/electron-browser/public.js'; export type Leak = Host;");
	project.write('workbench/common/namespace.ts', "import type * as IPC from '../../platform/ipc/common/mainProcessService.js'; export type Leak = IPC.IMainProcessService;");
	const violations = project.check();
	assert.deepEqual([...new Set(violations.map(item => relative(project.sourceRoot, item.fileName).replaceAll('\\', '/')))].sort(), ['workbench/browser/alias.ts', 'workbench/common/namespace.ts']);
	assert.ok(violations.every(item => item.message.includes('IMainProcessService')));
});

test('native IPC checks identify inferred receivers without a native type name in the consumer', t => {
	const project = fixture(t);
	project.write('platform/ipc/electron-browser/factory.ts', "import type { IMainProcessService } from '../common/mainProcessService.js'; export declare function getHost(): IMainProcessService;");
	project.write('workbench/browser/inferred.ts', "import { getHost } from '../../platform/ipc/electron-browser/factory.js'; getHost().getChannel('logger');");
	const violations = project.check();
	assert.equal(violations.length, 1);
	assert.equal(relative(project.sourceRoot, violations[0]!.fileName).replaceAll('\\', '/'), 'workbench/browser/inferred.ts');
	assert.match(violations[0]!.message, /Inferred IMainProcessService/);
});

test('unrelated same-name types, host adapters and excluded test fixtures remain valid', t => {
	const project = fixture(t);
	project.write('workbench/browser/local.ts', 'interface IMainProcessService { getChannel(): void; } declare const local: IMainProcessService; local.getChannel(); export {};');
	project.write(
		'platform/ipc/electron-browser/client.ts',
		"import type { IMainProcessService } from '../common/mainProcessService.js'; export const use = (host: IMainProcessService) => host.getChannel('logger');",
	);
	project.write('base/node/client.ts', "import 'node:fs';");
	project.write('base/test/browser/invalid.ts', "import 'node:fs';");
	project.write('base/browser/fixtures/invalid.ts', "import 'electron';");
	assert.deepEqual(project.check(), []);
});

test('sandbox preload exceptions permit Electron but do not permit Node modules', t => {
	const project = fixture(t);
	const path = 'platform/browserView/electron-browser/preload-browserView.ts';
	project.write(path, "declare const require: (name: string) => unknown; require('electron');");
	assert.deepEqual(project.check(), []);
	project.write(path, "declare const require: (name: string) => unknown; require('node:fs');");
	assert.equal(project.check().length, 1);
	assert.match(project.check()[0]!.message, /node:fs/);
});

test('configuration and missing-contract errors fail instead of silently checking nothing', t => {
	const project = fixture(t);
	assert.throws(() => checkLayers(join(project.directory, 'missing.json'), project.sourceRoot), /read|Cannot/i);
	project.write('platform/ipc/common/mainProcessService.ts', 'export {};');
	assert.throws(() => project.check(), /Missing IMainProcessService contract/);
	const result = spawnSync(process.execPath, [join(import.meta.dirname, 'layersChecker.ts'), '--unknown'], {
		cwd: repositoryRoot,
		encoding: 'utf8',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage:/);
});

test('environment projects cover each runtime and keep privileged preloads out of the renderer', () => {
	assert.deepEqual(
		PROJECTS.map(project => project.name),
		['browser', 'worker', 'node', 'electron-browser', 'electron-main', 'electron-utility', 'preload'],
	);
	for (const project of PROJECTS) {
		const parsed = ts.getParsedCommandLineOfConfigFile(
			join(repositoryRoot, project.config),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
			},
		);
		assert.ok(parsed && parsed.fileNames.length > 0, project.name);
		assert.deepEqual(parsed.errors, [], project.name);
		assert.deepEqual(
			parsed.fileNames.filter(path => /\/(?:test|fixtures)\//u.test(path)),
			[],
			project.name,
		);
		if (project.name === 'electron-browser') {
			assert.ok(!parsed.fileNames.some(path => path.endsWith('preload-browserView.ts') || path.endsWith('preload.cts')));
			assert.deepEqual(parsed.options.types, ['vite/client', '@webgpu/types']);
		}
	}
});

test('the real environment configurations reject unavailable globals and accept their own APIs', t => {
	const project = fixture(t);
	const cases = [
		{
			name: 'common',
			config: 'tsconfig.common.json',
			valid: 'export const value = 1;',
			invalid: 'export const value = document.body;',
		},
		{ name: 'browser', valid: 'export const value = document.body;', invalid: 'export const value = process.pid;' },
		{ name: 'worker', valid: "self.postMessage('ready');", invalid: 'export const value = document.body;' },
		{ name: 'node', valid: 'export const value = process.pid;', invalid: 'export const value = document.body;' },
		{
			name: 'electron-browser',
			valid: 'export const value = document.body;',
			invalid: 'export const value = process.pid;',
		},
		{
			name: 'electron-main',
			valid: "import { app } from 'electron/main'; export const value = app.getPath('temp');",
			invalid: 'export const value = document.body;',
		},
		{
			name: 'electron-utility',
			valid: 'export const value = process.pid;',
			invalid: 'export const value = document.body;',
		},
		{
			name: 'preload',
			valid: "const { ipcRenderer } = require('electron') as typeof import('electron'); void ipcRenderer;",
			invalid: 'const value: string = 123; void value;',
		},
	];
	for (const item of cases) {
		const source = join(project.directory, `${item.name}.ts`);
		const config = join(project.directory, `${item.name}.json`);
		const base = 'config' in item ? item.config! : PROJECTS.find(project => project.name === item.name)!.config;
		writeFileSync(
			config,
			JSON.stringify({
				extends: join(repositoryRoot, base),
				compilerOptions: { noEmit: true, incremental: false },
				files: [source],
				include: [],
				exclude: [],
			}),
		);
		for (const [content, status] of [
			[item.valid, 0],
			[item.invalid, 1],
		] as const) {
			writeFileSync(source, content);
			const result = spawnSync(compiler, ['check', '-p', config, '--all'], {
				cwd: repositoryRoot,
				encoding: 'utf8',
				timeout: 30_000,
			});
			assert.equal(result.error, undefined, item.name);
			assert.equal(result.status, status, `${item.name}: ${result.stdout}\n${result.stderr}`);
		}
	}
});

test('ambient Node declarations cannot grant host globals to Web code or ban same-named locals', t => {
	const project = fixture(t);
	project.write('base/common/dependency.d.ts', '/// <reference types="node" />\n');
	project.write('workbench/browser/process.ts', 'export const unavailable = globalThis.process;');
	project.write('workbench/worker/type.ts', 'export type Unavailable = NodeJS.Timeout;');
	project.write('workbench/electron-browser/buffer.ts', 'export const unavailable = Buffer.alloc(1);');
	project.write('workbench/browser/local.ts', 'const process = { pid: 1 }; const Buffer = { value: 1 }; export const valid = process.pid + Buffer.value;');
	const violations = project.check();
	assert.deepEqual(violations.map(item => relative(project.sourceRoot, item.fileName).replaceAll('\\', '/')).sort(), [
		'workbench/browser/process.ts',
		'workbench/electron-browser/buffer.ts',
		'workbench/worker/type.ts',
	]);
	assert.ok(violations.every(item => item.message.includes('Host global')));
});

test('Web code cannot obtain host capabilities by importing an internal Node adapter', t => {
	const project = fixture(t);
	project.write('base/node/host.ts', 'export const host = {};');
	project.write('base/browser/host.ts', "export { host } from '../node/host.js';");
	const violations = project.check();
	assert.equal(violations.length, 1);
	assert.match(violations[0]!.message, /Host module/);
});
