import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { GitHubError, GitHubErrorCode } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { CreatePullRequestWidget, type ICreatePullRequestWidgetOptions } from '../../browser/createPullRequestWidget.js';
import type { ISessionPullRequestDetails, ISessionPullRequestOptions } from '../../common/pullRequestCreation.js';
import { getSessionsChangesAccessibilityProviders } from '../../browser/sessionsChangesAccessibilityHelp.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { registerTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Event } from '../../../../../base/common/event.js';

const details: ISessionPullRequestDetails = {
	title: 'Suggested title', description: 'Suggested description', branchName: 'feature', baseBranchName: 'main', repository: 'github.com/team/repo', autoMergeAllowed: true, mergeMethods: ['SQUASH'],
	context: { workingDirectory: '/workspace', repository: 'github.com/team/repo', branchName: 'feature', baseBranchName: 'main' },
};

function create(services: InstantiationService, options: ICreatePullRequestWidgetOptions): CreatePullRequestWidget {
	registerTestComponentServices(services);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(IConfigurationService, { onDidChangeConfiguration: Event.None } as unknown as IConfigurationService);
	return services.createInstance(CreatePullRequestWidget, options, document);
}

suite('Changes Create PR form', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stored preferences cannot restore a disallowed merge method or an unavailable agent action', async () => {
		using services = registerTestComponentServices(new InstantiationService());
		services.get(IStorageService).store('sessions.createPullRequest.preferences', JSON.stringify({ draft: true, mergeMode: 'auto', mergeMethod: 'REBASE', primaryAction: 'sendToChat', title: 'Private old title' }), StorageScope.PROFILE, StorageTarget.MACHINE);
		const calls: ISessionPullRequestOptions[] = [];
		using widget = create(services, {
			creation: { prepare: async () => details, create: async options => { calls.push(options); return 'Created'; } },
			onCancel: () => undefined, onCreated: () => undefined, onDetachedError: error => { throw error; },
		});
		await widget.ready;
		assert.equal(widget.domNode.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value, details.title);
		assert.equal(widget.domNode.querySelector<HTMLSelectElement>('select[aria-label="Merge mode"]')!.value, '');
		assert.equal(widget.domNode.querySelector<HTMLSelectElement>('select[aria-label="Merge mode"]')!.disabled, true);
		assert.equal(widget.domNode.querySelector<HTMLSelectElement>('select[aria-label="Pull request action"]')!.value, 'create');
		widget.domNode.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true }));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(calls, [{ title: details.title, description: details.description, draft: true, expectedContext: details.context }]);
		assert.deepEqual(JSON.parse(services.get(IStorageService).get('sessions.createPullRequest.preferences', StorageScope.PROFILE)!), { draft: true, mergeMode: 'manual', primaryAction: 'create' });
	});

	test('late defaults preserve edits and one submission survives closing its form', async () => {
		using services = new InstantiationService();
		const prepared = new DeferredPromise<ISessionPullRequestDetails>();
		const submitted = new DeferredPromise<string>();
		const calls: ISessionPullRequestOptions[] = [];
		const results: string[] = [];
		using widget = create(services, {
			creation: { prepare: async () => prepared.p, create: async options => { calls.push(options); return submitted.p; } },
			onCancel: () => undefined, onCreated: (_options, message) => results.push(message), onDetachedError: error => { throw error; },
		});
		document.body.append(widget.domNode);
		services.registerInstance(IContextViewService, { container: document.body } as IContextViewService);
		const accessible = getSessionsChangesAccessibilityProviders().find(provider => provider.name === `sessionsCreatePullRequest.${AccessibleViewType.View}`)!;
		using reader = accessible.getProvider(services)!;
		const title = widget.domNode.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
		title.value = 'Edited title';
		title.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
		const description = widget.domNode.querySelector<HTMLTextAreaElement>('textarea')!;
		description.value = 'Edited description';
		description.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
		await prepared.complete(details);
		await widget.ready;
		assert.equal(title.value, 'Edited title');
		assert.equal(description.value, 'Edited description');
		assert.match(reader.provideContent(), /Title: Edited title/u);
		widget.domNode.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
		widget.domNode.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
		assert.deepEqual(calls, [{ title: 'Edited title', description: 'Edited description', draft: false, expectedContext: details.context }]);
		widget.dispose();
		assert.equal(reader.provideContent(), 'Pull request form closed.');
		await submitted.complete('Created PR #8');
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(results, ['Created PR #8']);
	});

	test('uncertain submission stays disabled and preserves the form for inspection', async () => {
		using services = new InstantiationService();
		let writes = 0;
		using widget = create(services, {
			creation: { prepare: async () => details, create: async () => { writes++; throw new GitHubError(GitHubErrorCode.SubmissionUncertain); } },
			onCancel: () => undefined, onCreated: () => { throw new Error('Uncertain outcomes are not success'); }, onDetachedError: error => { throw error; },
		});
		await widget.ready;
		widget.domNode.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true }));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.match(widget.domNode.querySelector('[role="status"]')!.textContent!, /may have created/u);
		assert.equal(widget.domNode.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
		widget.domNode.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true }));
		assert.equal(writes, 1);
	});
});
