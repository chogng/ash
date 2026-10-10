import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IIssueReporterService } from '../../../../../platform/issue/common/issue.js';
import { IProcessService } from '../../../../../platform/process/common/process.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IIssueFormService } from '../../common/issue.js';
import '../../../../services/process/electron-browser/processService.js';
import '../../electron-browser/issue.contribution.js';

suite('Desktop issue diagnostics', () => {
	test('collects local diagnostics through the registered process channel and keeps App Server identity separate', async () => {
		using resources = new DisposableStore();
		const calls: string[] = [];
		const host: IProcessService = {
			_serviceBrand: undefined,
			getSystemInfo: async () => {
				calls.push('system');
				return { os: 'Darwin arm64 test', cpus: 'Local CPU', memory: '16 GiB', gpuStatus: { webgl: 'enabled' }, screenReader: 'no', vmHint: '', processArgs: '', remoteData: [] };
			},
			getPerformanceInfo: async options => { assert.equal(options, undefined); calls.push('performance'); return { processInfo: '123\t0.1\t20.0\tAsh Main' }; },
			resolveProcesses: async () => { throw new Error('Not used by the report'); },
			getSystemStatus: async () => 'local system status',
		};
		const server = ProxyChannel.fromService(host, resources);
		const channel: IChannel = { call: (command, arg) => server.call('window:1', command, JSON.parse(JSON.stringify(arg))), listen: () => Event.None };
		const collection = new ServiceCollection(...getSingletonServiceDescriptors(),
			[IMainProcessService, { getChannel: (name: string) => { assert.equal(name, 'process'); return channel; }, registerChannel: () => { } }],
			[IIssueReporterService, createReporter()],
			[IExtensionService, { currentCatalog: { extensions: [], diagnostics: [] } } as unknown as IExtensionService],
		);
		const services = resources.add(new InstantiationService(collection));
		const form = services.get(IIssueFormService);
		await form.initialize({});
		assert.deepEqual(calls, ['system', 'performance']);
		assert.match(form.serialize(), /Desktop\nOS: Darwin arm64 test/);
		assert.match(form.serialize(), /App Server\nAsh: server-version\nOS: linux \(x86_64\)/);
		assert.match(form.serialize(), /Desktop processes\n123/);
		using commands = new CommandService(services);
		assert.equal(await commands.executeCommand('_issues.getSystemStatus'), 'local system status');
	});

	test('invalid host diagnostics leave a usable report with explicit collection failures', async () => {
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(),
			[IMainProcessService, { getChannel: () => ({ call: async () => ({ gpuStatus: 42, processInfo: 42 }), listen: () => Event.None }), registerChannel: () => { } }],
			[IIssueReporterService, createReporter()],
			[IExtensionService, { currentCatalog: { extensions: [], diagnostics: [] } } as unknown as IExtensionService],
		));
		const form = services.get(IIssueFormService);
		await form.initialize({ issueTitle: 'Retained draft', issueBody: 'Reproduction steps' });
		assert.equal(form.state.error, undefined);
		assert.equal(form.state.loading, false);
		assert.match(form.serialize(), /Desktop system diagnostics could not be collected/);
		assert.match(form.serialize(), /Desktop process diagnostics could not be collected/);
		assert.match(form.serialize(), /Reproduction steps/);
		assert.equal(form.state.context?.version, 'server-version');
	});

	test('window disposal discards a pending diagnostic result', async () => {
		let requested!: () => void;
		const started = new Promise<void>(resolve => { requested = resolve; });
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(),
			[IMainProcessService, { getChannel: () => ({ call: async () => { requested(); await pending; throw new Error('Window closed'); }, listen: () => Event.None }), registerChannel: () => { } }],
			[IIssueReporterService, createReporter()],
			[IExtensionService, { currentCatalog: { extensions: [], diagnostics: [] } } as unknown as IExtensionService],
		));
		const form = services.get(IIssueFormService);
		let state = form.state;
		using listener = form.onDidChange(value => { state = value; });
		const operation = form.initialize({ issueTitle: 'Window-local draft' });
		await started;
		const beforeDisposal = state;
		services.dispose();
		release();
		await operation;
		assert.equal(state, beforeDisposal);
	});

	test('requires the Main process channel at service construction', () => {
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors()));
		assert.throws(() => services.get(IProcessService), /mainProcessService/);
	});
});

function createReporter(): IIssueReporterService {
	return {
		read: async () => ({ reportIssueUrl: 'https://example.test', version: 'server-version', os: 'linux', arch: 'x86_64' }),
		searchGitHubIssues: async () => [],
		submitIssue: async () => { throw new Error('Unexpected submission'); },
	};
}
