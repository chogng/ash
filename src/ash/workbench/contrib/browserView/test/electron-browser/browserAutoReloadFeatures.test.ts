import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService, IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserAutoReloadWatcher } from '../../electron-browser/features/browserAutoReloadFeatures.js';

test('file reloads debounce matching changes, cancel on navigation and release watches with the page', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using changes = new Emitter<IFileChangeEvent>();
		using state = new Emitter<never>();
		using closing = new Emitter<void>();
		let reloads = 0;
		let watches = 0;
		const model = {
			state: { url: 'file:///workspace/index.html' },
			info: { owner: { type: 'user' } },
			onDidChangeState: state.event,
			onWillDispose: closing.event,
			reload: async () => {
				reloads++;
			},
		} as unknown as IBrowserViewModel;
		const files = {
			onDidChangeFiles: changes.event,
			watch: () => {
				watches++;
				return toDisposable(() => {
					watches--;
				});
			},
		} as unknown as IFileService;
		const workspace = {
			getWorkspace: () => ({ folders: [{ uri: URI.file('/workspace') }] }),
			onDidChangeWorkspace: Event.None,
		} as unknown as IWorkspaceContextService;
		using watcher = new BrowserAutoReloadWatcher(model, files, workspace);
		watcher.update(true);
		assert.equal(watches, 1);
		changes.fire({ resources: [URI.file('/workspace/other.html')] });
		mock.timers.tick(250);
		assert.equal(reloads, 0);
		for (let i = 0; i < 3; i++) {
			changes.fire({ resources: [URI.file('/workspace/index.html')] });
		}
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
	} finally {
		mock.timers.reset();
	}
});
