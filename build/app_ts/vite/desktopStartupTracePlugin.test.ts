import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { desktopStartupTracePlugin } from './desktopStartupTracePlugin.ts';

const desktopRoot = resolve(import.meta.dirname, '../../../app-ts');

test('Desktop trace checks emitted marks without rewriting startup source', () => {
	const plugin = desktopStartupTracePlugin();
	assert.equal(plugin.transform, undefined);
	const generateBundle = plugin.generateBundle as (_options: unknown, bundle: unknown) => void;
	const files = [
		'src/ash/code/electron-browser/workbench/workbench.ts',
		'src/ash/platform/native/electron-browser/rendererApi.ts',
		'src/ash/workbench/electron-browser/desktop.main.ts',
		'src/ash/workbench/browser/workbench.ts',
	];
	const bundle = Object.fromEntries(files.map(path => [path, { type: 'chunk', code: readFileSync(resolve(desktopRoot, path), 'utf8') }]));
	assert.doesNotThrow(() => generateBundle({}, bundle));
	assert.throws(() => generateBundle({}, { 'entry.js': { type: 'chunk', code: 'export const ready = true;' } }), /startup marks missing/u);
	assert.throws(() => generateBundle({}, { 'source.txt': { type: 'asset', source: Object.values(bundle).map(chunk => chunk.code).join('\n') } }), /startup marks missing/u);
});

test('Desktop trace marks each restored region and waits for asynchronous view creation', async () => {
	const file = resolve(desktopRoot, 'src/ash/workbench/browser/workbench.ts');
	const output = readFileSync(file, 'utf8');
	const start = output.indexOf('let isStartupRestoration = true;');
	const end = output.indexOf('const paneRestoration =', start);
	const restoration = ts.transpileModule(output.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText;
	const locations = { Sidebar: 0, Panel: 1, AuxiliaryBar: 2, AgentSidebar: 3 };
	const marks: string[] = [];
	const opened: string[] = [];
	let finish: () => void = () => assert.fail('view creation was not requested');
	const pending = new Promise<void>(resolvePromise => { finish = resolvePromise; });
	const context: { restoreActiveViewContainers?: () => Promise<void> } = {};
	const install = new Function('paneParts', 'layout', 'panes', 'viewDescriptors', 'requiredViewContainerToRestore', 'views', 'ViewContainerLocation', 'performance', restoration);
	install.call(context,
		new Map(Object.values(locations).map(location => [location, { getCompositeIdToRestore: () => `view-${location}` }])),
		{ isPartVisible: (part: string) => part !== 'agentSidebar' },
		{ getPartId: (location: number) => `part-${location}` },
		{},
		(_service: unknown, _location: number, id: string) => ({ id }),
		{ openViewContainer: (id: string) => { opened.push(id); return pending; }, closeViewContainer: () => assert.fail('all restored regions are visible') },
		locations,
		{ mark: (name: string) => marks.push(name) },
	);
	const restored = context.restoreActiveViewContainers!();
	assert.deepEqual({ opened, marks }, {
		opened: ['view-0', 'view-1', 'view-2'],
		marks: ['ash.workbench.shell-ready', 'ash.workbench.sidebar-restore-start', 'ash.workbench.panel-restore-start', 'ash.workbench.auxiliary-restore-start'],
	});
	finish();
	await restored;
	assert.equal(marks.at(-1), 'ash.workbench.views-restored');
	assert.equal(marks.filter(mark => mark === 'ash.workbench.views-restored').length, 1);
	const startupMarks = [...marks];
	await context.restoreActiveViewContainers!();
	assert.deepEqual(marks, startupMarks, 'workspace restoration must not repeat startup marks');
	assert.equal(opened.length, 6);
});

test('Workbench completion mark waits for services, editor restoration, and backup restoration', async () => {
	const path = resolve(desktopRoot, 'src/ash/workbench/browser/workbench.ts');
	const source = readFileSync(path, 'utf8');
	const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2024, true);
	const owner = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'Workbench') as ts.ClassDeclaration;
	const method = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(ast) === 'completeStartupRestoration')!;
	const code = ts.transpileModule(`class Restoration { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText;
	const marks: string[] = [];
	const events: string[] = [];
	let finishServices!: () => void;
	let finishEditors!: () => void;
	let finishBackups!: () => void;
	const services = new Promise<void>(resolvePromise => { finishServices = resolvePromise; });
	const editors = new Promise<void>(resolvePromise => { finishEditors = resolvePromise; });
	const backups = new Promise<void>(resolvePromise => { finishBackups = resolvePromise; });
	const Restoration = new Function('LifecyclePhase', 'WorkbenchPhase', 'performance', `${code}\nreturn Restoration;`)({ Restored: 3 }, { AfterRestored: 3 }, { mark: (name: string) => marks.push(name) });
	const context = Object.assign(new Restoration(), {
		isDisposed: false,
		restoreEditorParts: () => { events.push('editors'); return editors; },
		restoreWorkingCopyBackups: () => { events.push('backups'); return backups; },
		lifecycleService: { phase: 2 },
		logService: { info: () => events.push('logged') },
	});
	const restored = context.completeStartupRestoration([services], {}, {}, {}, { advance: () => events.push('phase') }, () => events.push('fonts'));
	assert.deepEqual({ marks, events }, { marks: [], events: [] });
	finishServices();
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	assert.deepEqual({ marks, events }, { marks: [], events: ['editors'] });
	finishEditors();
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	assert.deepEqual({ marks, events }, { marks: [], events: ['editors', 'backups'] });
	finishBackups();
	await restored;
	assert.deepEqual({ marks, events, phase: context.lifecycleService.phase }, {
		marks: ['ash.workbench.restored'],
		events: ['editors', 'backups', 'fonts', 'phase', 'logged'],
		phase: 3,
	});
});
