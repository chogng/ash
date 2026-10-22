import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { timeout } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { StatusbarService, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { ProgressService } from '../../../../services/progress/browser/progressService.js';
import { ChatContextPickService } from '../../../../services/chat/browser/chatContextPickService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { parseExtensionManifest } from '../../../../services/extensions/common/extensionManifest.js';
import { canSetBreakpointsIn } from '../../common/breakpoints.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { DebugMemoryFileSystemProvider, memoryResource } from '../../browser/debugMemory.js';
import { DebugProgressContribution } from '../../browser/debugProgress.js';
import { DebugChatContextContribution } from '../../browser/debugChatIntegration.js';
import { DebugVisualizerService } from '../../common/debugVisualizers.js';
import { StatusBarColorProvider } from '../../browser/statusbarColorProvider.js';
import { MockDebugService, MockDebugSession } from '../common/mockDebug.js';
import type { IDebugProgressStart, IDebugProgressUpdate } from '../../common/debug.js';

const descriptor = {
	id: 'test.visualizer',
	name: 'visualizer',
	publisher: 'test',
	version: '1.0.0',
	displayName: 'Visualizer',
	sourceKind: 'builtIn' as const,
	manifestSha256: 'a'.repeat(64),
	packageSha256: 'b'.repeat(64),
};

function enableMemory(session: MockDebugSession): void {
	Object.defineProperty(session, 'capabilities', {
		value: { ...session.capabilities, supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true },
	});
}

test('Debug memory editor codec preserves raw bytes and rejects stale or conflicting writes', async () => {
	using debug = new MockDebugService();
	const session = debug.sessions[0] as MockDebugSession;
	enableMemory(session);
	let bytes = new Uint8Array([0, 255]);
	const writes: number[][] = [];
	session.readMemory = async () => ({ address: '0x1000', data: bytes, unreadableBytes: 0 });
	session.writeMemory = async (_reference, _offset, value) => {
		writes.push([...value]);
		bytes = new Uint8Array(value);
		return value.length;
	};
	using files = new FileService();
	using provider = new DebugMemoryFileSystemProvider(debug, files);
	const resource = memoryResource(session.id, session.inspectionRevision, 'memory:answer', 0, 2);
	assert.deepEqual([...(await files.readFileBytes(resource)).bytes], [0, 255]);
	const text = await files.readFile(resource, 'utf8');
	assert.equal(text.content, '00 ff');
	await files.writeFile(
		{ resource, content: '01 fe', encoding: 'utf8', expectedRevision: text.revision },
		{ create: false, overwrite: true },
	);
	assert.deepEqual(writes, [[1, 254]]);
	await assert.rejects(
		files.writeFile(
			{ resource, content: '02 fd', encoding: 'utf8', expectedRevision: text.revision },
			{ create: false, overwrite: true },
		),
		/Memory changed/,
	);
	await assert.rejects(files.writeFile({ resource, content: 'oops', encoding: 'utf8' }), /hexadecimal/);
	using invalidations = new Emitter<{ memoryReference: string; offset: number; count: number; }>();
	Object.defineProperty(session, 'onDidInvalidateMemory', { value: invalidations.event });
	let changes = 0;
	using changed = files.onDidChangeFiles(() => { changes++; });
	const watch = files.watch(resource);
	invalidations.fire({ memoryReference: 'other', offset: 0, count: 2 });
	assert.equal(changes, 0);
	invalidations.fire({ memoryReference: 'memory:answer', offset: 1, count: 1 });
	assert.equal(changes, 1);
	watch.dispose();
	invalidations.fire({ memoryReference: 'memory:answer', offset: 0, count: 2 });
	assert.equal(changes, 1);
	session.inspectionRevision++;
	await assert.rejects(files.readFile(resource, 'utf8'), /expired/);
	await assert.rejects(files.writeFile({ resource, content: '03 fc', encoding: 'utf8' }), /expired/);
	assert.equal(writes.length, 1);
});

test('Debug adapter progress owns real notification lifetime and cancellation reaches the session', async () => {
	using debug = new MockDebugService();
	const session = debug.sessions[0] as MockDebugSession;
	using starts = new Emitter<IDebugProgressStart>();
	using updates = new Emitter<IDebugProgressUpdate>();
	using ends = new Emitter<{ progressId: string; }>();
	Object.defineProperties(session, {
		onDidProgressStart: { value: starts.event },
		onDidProgressUpdate: { value: updates.event },
		onDidProgressEnd: { value: ends.event },
		capabilities: { value: { ...session.capabilities, supportsCancelRequest: true } },
	});
	const cancelled: string[] = [];
	session.cancelProgress = async (id) => {
		cancelled.push(id);
	};
	using services = new InstantiationService();
	using notifications = new TestNotificationService();
	using statusbar = new StatusbarService();
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IStatusbarService, statusbar);
	services.registerSingleton(ICommandService, () => new CommandService(services));
	using progress = services.createInstance(ProgressService);
	using contribution = new DebugProgressContribution(debug, progress, notifications);
	starts.fire({ progressId: 'symbols', title: 'Loading symbols', cancellable: true });
	updates.fire({ progressId: 'symbols', message: 'Half loaded', percentage: 50 });
	await timeout(550);
	const item = notifications.model.getNotifications()[0];
	assert.match(item.message, /Half loaded/);
	assert.equal(item.progress?.worked, 50);
	await item.actions?.primary?.[0].run();
	assert.deepEqual(cancelled, ['symbols']);
	ends.fire({ progressId: 'symbols' });
	await timeout(0);
	assert.equal(notifications.model.getNotifications().length, 0);
});

test('Debug Chat picker resolves selected snapshots and retires with its contribution', async () => {
	using debug = new MockDebugService();
	debug.activate(debug.sessions[0]);
	for (let attempt = 0; !debug.getViewModel().focusedStackFrame && attempt < 50; attempt++) await timeout(5);
	const contexts = new ChatContextPickService();
	const contribution = new DebugChatContextContribution(debug, contexts);
	try {
		const picks = await contexts.items[0].providePicks('parent');
		assert.equal(picks.length, 1);
		const selected = picks[0].attachment;
		(debug.session as MockDebugSession).state = 'running';
		assert.match((await selected.resolve()).content, /parent = Object/);
		assert.deepEqual(await contexts.items[0].providePicks(''), []);
	} finally {
		contribution.dispose();
	}
	assert.equal(contexts.items.length, 0);
});

test('Debug visualizers traverse real variable ports and validate extension command output', async () => {
	using debug = new MockDebugService();
	using extensions = new TestExtensionService();
	const manifest = parseExtensionManifest(
		JSON.stringify({
			name: 'visualizer',
			publisher: 'test',
			version: '1.0.0',
			contributes: { debugVisualizers: [{ id: 'hex', title: 'Hex', command: 'test.visualize', type: 'object' }] },
		}),
		descriptor,
	);
	extensions.getExtensionPointContributions = <T>(name: string) =>
		name === 'debugVisualizers'
			? [{ description: descriptor, value: manifest.contributes.debugVisualizers as T }]
			: [];
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const args: unknown[] = [];
	let invalidResult = false;
	using registration = CommandsRegistry.register('test.visualize', (_accessor, value) => {
		args.push(value);
		return { content: invalidResult ? 42 : 'ff', languageId: 'plaintext' };
	});
	const visualizers = new DebugVisualizerService(debug, extensions, commands);
	const session = debug.sessions[0] as MockDebugSession;
	const variable = { name: 'parent', value: 'Object', type: 'object', variablesReference: 21 };
	const choices = visualizers.getVisualizers(session, variable);
	assert.equal(choices.length, 2);
	assert.match((await choices[0].visualize(new AbortController().signal)).content, /child/);
	assert.equal((await choices[1].visualize(new AbortController().signal)).content, 'ff');
	assert.equal((args[0] as { sessionId: string; }).sessionId, session.id);
	invalidResult = true;
	await assert.rejects(choices[1].visualize(new AbortController().signal), /must return text content/);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(choices[0].visualize(cancelled.signal), isCancellationError);
	session.inspectionRevision++;
	await assert.rejects(choices[0].visualize(new AbortController().signal), isCancellationError);
	assert.throws(() =>
		parseExtensionManifest(
			JSON.stringify({
				name: 'visualizer',
				publisher: 'test',
				version: '1.0.0',
				contributes: { debugVisualizers: [{ id: 'bad', title: 'Bad', command: '' }] },
			}),
			descriptor,
		),
	);
});

test('Breakpoint language and when declarations are honored when unrestricted policy is disabled', async () => {
	using extensions = new TestExtensionService();
	const manifest = parseExtensionManifest(
		JSON.stringify({
			name: 'visualizer',
			publisher: 'test',
			version: '1.0.0',
			contributes: { breakpoints: [{ language: 'typescript', when: 'debugReady' }] },
		}),
		descriptor,
	);
	extensions.getExtensionPointContributions = <T>() => [
		{ description: descriptor, value: manifest.contributes.breakpoints as T },
	];
	using configuration = new TestConfigurationService();
	await configuration.updateValue('debug.allowBreakpointsEverywhere', false);
	using context = new ContextKeyService();
	const ready = context.createKey<boolean>('debugReady', false);
	assert.equal(canSetBreakpointsIn('typescript', extensions, configuration, context), false);
	ready.set(true);
	assert.equal(canSetBreakpointsIn('typescript', extensions, configuration, context), true);
	assert.equal(canSetBreakpointsIn('rust', extensions, configuration, context), false);
});

test('Debug status color lease ends when the last live session ends', () => {
	using debug = new MockDebugService();
	using statusbar = new StatusbarService();
	using contribution = new StatusBarColorProvider(debug, statusbar);
	assert.equal(statusbar.style?.background, 'statusBar.debuggingBackground');
	for (const session of debug.sessions) (session as MockDebugSession).state = 'terminated';
	debug.activate(debug.sessions[0]);
	assert.equal(statusbar.style, undefined);
});
