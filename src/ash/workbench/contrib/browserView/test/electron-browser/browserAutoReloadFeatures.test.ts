import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService, type IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IBrowserViewWorkbenchService, type IBrowserViewModel } from '../../common/browserView.js';
import { BrowserAutoReloadWatcher } from '../../electron-browser/features/browserAutoReloadFeatures.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';

test('auto reload settings independently control file and localhost watchers', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new InMemoryConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	const watched = new Set<string>();
	services.registerInstance(IFileService, {
		onDidChangeFiles: Event.None,
		watch: resource => {
			const key = resource.toString();
			watched.add(key);
			return toDisposable(() => watched.delete(key));
		},
	} as IFileService);
	services.registerInstance(IWorkspaceContextService, {
		getWorkspace: () => ({ folders: [{ uri: URI.file('/workspace') }] }),
		onDidChangeWorkspace: Event.None,
	} as unknown as IWorkspaceContextService);
	const pages = new Map(['file:///workspace/index.html', 'http://localhost:3000/', 'https://example.test/'].map(url => [url, {
		onDidResolveModel: Event.None,
		model: {
			state: { url }, info: { owner: { type: 'user' } },
			onDidChangeState: Event.None, onWillDispose: Event.None,
		},
	}]));
	services.registerInstance(IBrowserViewWorkbenchService, {
		onDidChangeBrowserViews: Event.None, initialize: async () => { }, getKnownBrowserViews: () => pages,
	} as unknown as IBrowserViewWorkbenchService);
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.browserView.autoReload']));
	host.advance(WorkbenchPhase.BlockRestore);
	await Promise.resolve();
	assert.deepEqual([...watched], [URI.file('/workspace/index.html').toString()]);
	await configuration.updateValue('workbench.browser.autoReloadLocalhostOnFileChange', true, ConfigurationTarget.MEMORY);
	assert.deepEqual([...watched].sort(), [URI.file('/workspace').toString(), URI.file('/workspace/index.html').toString()].sort());
	await configuration.updateValue('workbench.browser.autoReloadOnFileChange', false, ConfigurationTarget.MEMORY);
	assert.deepEqual([...watched], [URI.file('/workspace').toString()]);
	host.dispose();
	assert.equal(watched.size, 0);
});

test('file reloads debounce matching changes, cancel on navigation and release watches with the page', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using changes = new Emitter<IFileChangeEvent>();
		using state = new Emitter<never>();
		using closing = new Emitter<void>();
		let reloads = 0;
		let watches = 0;
		const model = {
			state: { url: 'file:///workspace/index.html' }, info: { owner: { type: 'user' } },
			onDidChangeState: state.event, onWillDispose: closing.event,
			reload: async () => { reloads++; },
		} as unknown as IBrowserViewModel;
		const files = { onDidChangeFiles: changes.event, watch: () => { watches++; return toDisposable(() => { watches--; }); } } as unknown as IFileService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/workspace') }] }), onDidChangeWorkspace: Event.None } as unknown as IWorkspaceContextService;
		using watcher = new BrowserAutoReloadWatcher(model, files, workspace);
		watcher.update(true);
		assert.equal(watches, 1);
		changes.fire({ resources: [URI.file('/workspace/other.html')] });
		mock.timers.tick(250);
		assert.equal(reloads, 0);
		for (let i = 0; i < 3; i++) { changes.fire({ resources: [URI.file('/workspace/index.html')] }); }
		mock.timers.tick(250);
		assert.equal(reloads, 1);
		changes.fire({ resources: [URI.file('/workspace/index.html')] });
		Object.assign(model.state, { url: 'https://example.test/' });
		state.fire(undefined as never);
		mock.timers.tick(250);
		assert.deepEqual([reloads, watches], [1, 0]);
		Object.assign(model.state, { url: 'file:///workspace/index.html' });
		state.fire(undefined as never);
		assert.equal(watches, 1);
		closing.fire();
		assert.equal(watches, 0);
	} finally { mock.timers.reset(); }
});
