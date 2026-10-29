import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import {
	ILanguageServerService,
	type LanguageServerControl,
} from '../../../../../platform/language/common/languageServerService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { TestConfigurationService } from '../../../configuration/test/common/testServices.js';
import { AppServerLanguageLifecycleService } from '../../browser/appServerLanguageLifecycleService.js';

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

function fixture(resources: DisposableStore, source = '{"languageServers.autoSuspend":true}') {
	const workspace = resources.add(
		new TestConfigurationService({ workspace: { id: 'project', uri: URI.file('/project') }, source }),
	);
	const notifications = resources.add(new Emitter<ServerNotification>());
	const added = resources.add(new Emitter<TextModel>());
	const removed = resources.add(new Emitter<TextModel>());
	const models: TextModel[] = [];
	const controls: LanguageServerControl[] = [];
	const state = (type: 'ready' | 'idle' | 'stopped' | 'starting') =>
		notifications.fire({ method: 'language/serverState', params: { server: 'rust-analyzer', state: { type } } });
	const services = resources.add(new InstantiationService());
	const editors = resources.add(new StandaloneCodeEditorService());
	const modelEditors = new Map<TextModel, ICodeEditor>();
	services.registerInstance(ICodeEditorService, editors);
	services.registerInstance(IConfigurationService, workspace);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IModelService, {
		_serviceBrand: undefined,
		getModels: () => models,
		getModel: () => null,
		createModel: () => {
			throw new Error('unused');
		},
		updateModel() {},
		destroyModel() {},
		getCreationOptions: () => {
			throw new Error('unused');
		},
		onModelAdded: added.event,
		onModelRemoved: removed.event,
		onModelLanguageChanged: Event.None,
	});
	services.registerInstance(IServerEventApi, { subscribe: listener => notifications.event(listener) });
	services.registerInstance(ILogService, { trace() {}, debug() {}, info() {}, warn() {}, error() {} });
	const capabilities = () =>
		notifications.fire({
			method: 'language/serverCapabilities',
			params: {
				server: 'rust-analyzer',
				languageIds: ['rust'],
				features: ['hover'],
				completionTriggerCharacters: [],
				onTypeFormattingTriggerCharacters: [],
				signatureHelpTriggerCharacters: [],
				signatureHelpRetriggerCharacters: [],
			},
		});
	const serverService: ILanguageServerService = {
		read: async () => ({ revision: 0, configurations: {}, servers: [] }),
		configure: async () => {},
		removeConfiguration: async () => {},
		control: async request => {
			controls.push(request);
			if (request.action === 'resume') {
				state('starting');
				state('ready');
				capabilities();
			} else state(request.action === 'suspend' ? 'idle' : 'stopped');
		},
	};
	services.registerInstance(ILanguageServerService, serverService);
	const lifecycle = resources.add(services.createInstance(AppServerLanguageLifecycleService));
	lifecycle.start();
	capabilities();
	state('ready');
	const open = () => {
		const model = resources.add(
			new TextModel('fn main() {}', { languageId: 'rust', resource: URI.file('/project/main.rs') }),
		);
		models.push(model);
		const editor = {
			getId: () => String(models.length),
			getModel: () => model,
			onDidChangeModel: Event.None,
			onDidFocusEditorText: Event.None,
			onDidFocusEditorWidget: Event.None,
			hasWidgetFocus: () => false,
		} as unknown as ICodeEditor;
		modelEditors.set(model, editor);
		editors.addCodeEditor(editor);
		added.fire(model);
		return model;
	};
	const close = (model: TextModel) => {
		editors.removeCodeEditor(modelEditors.get(model)!);
	};
	return { workspace, lifecycle, controls, state, open, close, notifications, serverService, capabilities };
}

suite('Language server idle lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('default policy retains started analysis between visits until idle release is explicitly enabled', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using resources = new DisposableStore();
			const f = fixture(resources, '{}');
			const first = f.open();
			f.close(first);
			await flush();
			mock.timers.tick(24 * 60 * 60_000);
			await flush();
			assert.equal(f.controls.length, 0, 'closing the last editor keeps the existing server by default');
			const second = f.open();
			await f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => undefined);
			assert.equal(f.controls.length, 0, 'returning to Rust does not restart the server');
			await f.workspace.updateValue('languageServers.autoSuspend', true);
			f.close(second);
			await flush();
			mock.timers.tick(600_000);
			await flush();
			assert.deepEqual(
				f.controls.map(control => control.action),
				['suspend'],
			);
		} finally {
			mock.timers.reset();
		}
	});

	test('open files keep the server warm and reopening cancels the last-file grace period', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using resources = new DisposableStore();
			const f = fixture(resources);
			const first = f.open();
			mock.timers.tick(30 * 60_000);
			assert.equal(f.controls.length, 0);
			f.close(first);
			await flush();
			mock.timers.tick(599_999);
			assert.equal(f.controls.length, 0);
			const second = f.open();
			mock.timers.tick(600_000);
			assert.equal(f.controls.length, 0);
			f.close(second);
			await flush();
			mock.timers.tick(600_000);
			await flush();
			assert.deepEqual(f.controls, [{ action: 'suspend', dirId: undefined, serverId: 'rust-analyzer' }]);
			f.open();
			await flush();
			assert.equal(f.controls.at(-1)?.action, 'resume');
		} finally {
			mock.timers.reset();
		}
	});

	test('requests hold an activity lease and concurrent requests share one demand restart', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using resources = new DisposableStore();
			const f = fixture(resources);
			const pending = new DeferredPromise<number>();
			const work = f.lifecycle.withActivity({ languageId: 'rust' }, undefined, () => pending.p);
			await flush();
			mock.timers.tick(1_200_000);
			assert.equal(f.controls.length, 0);
			await pending.complete(7);
			assert.equal(await work, 7);
			mock.timers.tick(600_000);
			await flush();
			assert.equal(f.controls[0].action, 'suspend');
			assert.deepEqual(
				await Promise.all(
					[1, 2].map(value => f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => value)),
				),
				[1, 2],
			);
			assert.deepEqual(
				f.controls.map(control => control.action),
				['suspend', 'resume'],
			);
			f.state('stopped');
			await f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => undefined);
			assert.equal(f.controls.length, 2, 'explicit user stop is never automatically restarted');
		} finally {
			mock.timers.reset();
		}
	});

	test('background progress delays release and disabling resumes only automatically released servers', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using resources = new DisposableStore();
			const f = fixture(resources);
			f.notifications.fire({
				method: 'language/serverProgress',
				params: {
					server: 'rust-analyzer',
					token: 'check',
					title: null,
					message: null,
					percentage: null,
					done: false,
				},
			});
			mock.timers.tick(600_000);
			assert.equal(f.controls.length, 0);
			f.notifications.fire({
				method: 'language/serverProgress',
				params: {
					server: 'rust-analyzer',
					token: 'check',
					title: null,
					message: null,
					percentage: null,
					done: true,
				},
			});
			mock.timers.tick(600_000);
			await flush();
			await f.workspace.updateValue('languageServers.autoSuspend', false);
			await flush();
			assert.deepEqual(
				f.controls.map(control => control.action),
				['suspend', 'resume'],
			);
			mock.timers.tick(1_200_000);
			assert.equal(f.controls.length, 2);
			await assert.rejects(f.workspace.updateValue('languageServers.idleTimeoutMinutes', 0), TypeError);
			await assert.rejects(f.workspace.updateValue('languageServers.idleTimeoutMinutes', 1.5), TypeError);
		} finally {
			mock.timers.reset();
		}
	});

	test('activation failures wait for new demand instead of retrying continuously', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		f.state('idle');
		f.serverService.control = async request => {
			f.controls.push(request);
			throw new Error('offline');
		};
		f.open();
		await flush();
		assert.equal(f.controls.length, 1);
		await flush();
		assert.equal(f.controls.length, 1);
		await assert.rejects(
			f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => undefined),
			/offline/,
		);
		assert.equal(f.controls.length, 2);
	});

	test('the first request after resume waits for the new capability catalog as well as Ready', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		f.state('idle');
		f.serverService.control = async request => {
			f.controls.push(request);
			f.state('starting');
			f.state('ready');
		};
		let called = false;
		const pending = f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => {
			called = true;
			return 1;
		});
		await flush();
		assert.equal(called, false);
		f.capabilities();
		assert.equal(await pending, 1);
	});

	test('disposing during activation rejects pending work and releases its timeout', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using resources = new DisposableStore();
			const f = fixture(resources);
			f.state('idle');
			f.serverService.control = async request => {
				f.controls.push(request);
				f.state('starting');
			};
			const pending = f.lifecycle.withActivity({ languageId: 'rust' }, undefined, async () => undefined);
			await flush();
			const rejected = assert.rejects(pending, /workspace closed/);
			f.lifecycle.dispose();
			await rejected;
			mock.timers.tick(30_000);
			assert.equal(f.controls.length, 1);
		} finally {
			mock.timers.reset();
		}
	});
});
