import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDebugAdapterProcessService } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { DebugService } from '../../../../contrib/debug/browser/debugService.js';
import { DebugAdapterFactoryRegistry, IDebugAdapterFactorySource } from '../../common/debugAdapterFactory.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';

test('DAP runInTerminal creates an integrated PowerShell terminal with quoted arguments', async () => {
	const writes: string[] = [];
	const terminals = {
		getProfiles: async () => [{ profileId: 'powershell', title: 'PowerShell', isDefault: true }],
		createTerminal: async () => ({ state: 'running', processId: 1234, write: (value: string) => writes.push(value) }),
	} as unknown as ITerminalService;
	const response = await launchWithTerminalRequest(terminals, { kind: 'integrated', title: 'Debug app', cwd: 'C:\\work tree', args: ['C:\\bin\\app.exe', 'a b', "don't"], env: { MODE: 'debug value', REMOVE_ME: null } });

	assert.equal(response.success, true);
	assert.deepEqual(response.body, { shellProcessId: 1234 });
	assert.deepEqual(writes, ["$env:MODE='debug value'; Remove-Item -LiteralPath 'Env:REMOVE_ME' -ErrorAction SilentlyContinue; Set-Location -LiteralPath 'C:\\work tree'; & 'C:\\bin\\app.exe' 'a b' 'don''t'\r"]);
});

test('DAP runInTerminal rejects external terminals before acquiring a profile', async () => {
	const terminals = { getProfiles: async () => { throw new Error('must not run'); } } as unknown as ITerminalService;
	const response = await launchWithTerminalRequest(terminals, { kind: 'external', args: ['app'] });
	assert.equal(response.success, false);
	assert.match(String(response.message), /External debug terminals are not supported/);
});

suite('DAP terminal availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const persistence of ['connectionOwned', 'reconnectable'] as const) {
		test(`fails the reverse request when its ${persistence} terminal cannot accept commands`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization(persistence === 'reconnectable' ? 'zh-CN' : 'en');
			using resources = new DisposableStore();
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				getConnectionState: async () => 'crashed',
				onConnectionState: () => Disposable.None,
				listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId: 'debug-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: persistence }),
				read: async () => { throw new Error('Disconnected terminal must not poll'); },
				write: async () => { calls.push('write'); },
				resize: async () => { },
				close: async options => { calls.push(`close:${options.terminalId}`); },
			};
			const workspace = resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
			const services = resources.add(new InstantiationService(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
			const terminals = resources.add(services.createInstance(TerminalService));
			const response = await launchWithTerminalRequest(terminals, { kind: 'integrated', args: ['app'] });
			assert.deepEqual({ success: response.success, message: response.message, calls, terminals: terminals.instances }, {
				success: false,
				message: persistence === 'reconnectable' ? '终端不可用，调试命令尚未执行。请重新启动调试。' : 'The terminal is unavailable. The debug command was not sent. Restart debugging.',
				calls: ['close:debug-process'],
				terminals: [],
			});
		});
	}
});

async function launchWithTerminalRequest(terminals: ITerminalService, argumentsValue: unknown): Promise<Record<string, unknown>> {
	using resources = new DisposableStore();
	const adapters = resources.add(new DebugAdapterFactoryRegistry());
	let resolveResponse!: (response: Record<string, unknown>) => void;
	const response = new Promise<Record<string, unknown>>(resolve => { resolveResponse = resolve; });
	const messages: Array<{ sequence: number; message: unknown; }> = [];
	const enqueue = (message: unknown): void => { messages.push({ sequence: messages.length, message }); };
	const processes: IDebugAdapterProcessService = {
		onConnectionState: () => Event.None(() => { }),
		getConnectionState: async () => 'ready',
		start: async () => 'adapter-process',
		send: async (_id, value) => {
			const message = value as Record<string, unknown>;
			if (message.type === 'response') { resolveResponse(message); return; }
			if (message.command === 'launch') {
				enqueue({ seq: 100, type: 'event', event: 'initialized' });
				enqueue({ seq: 101, type: 'request', command: 'runInTerminal', arguments: argumentsValue });
			}
			enqueue({ seq: 102, type: 'response', request_seq: message.seq, command: message.command, success: true, body: {} });
		},
		read: async (_id, afterSequence, maxMessages) => ({ messages: messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages), nextSequence: messages.length, outputGap: false, stderr: '', exited: false, exitCode: null, protocolError: null }),
		close: async () => { },
	};
	const browser = new JSDOM('', { url: 'https://ash.test' });
	resources.add(toDisposable(() => browser.window.close()));
	const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	const workspace = resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
	const services = resources.add(new InstantiationService(new ServiceCollection(
		[IFileService, { onDidChangeFiles: Event.None } as IFileService],
		[IWorkspaceContextService, workspace],
		[IStorageService, storage],
		[IDebugAdapterProcessService, processes],
		[ITerminalService, terminals],
		[ITaskService, {} as ITaskService],
		[IDebugAdapterFactorySource, adapters],
		[ILogService, new NullLoggerService()],
	)));
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	using service = services.createInstance(DebugService);
	const session = await service.startDebugging({ id: 'debug-terminal', name: 'Terminal request', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: { cwd: URI.file('/workspace').fsPath } });
	try { return await response; }
	finally { await service.stop(session); }
}
