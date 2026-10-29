import { IExtensionHostService } from '../../../../services/extensionHost/common/extensionHostService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { GitHubError, GitHubErrorCode, IGitHubService, type GitHubShareLink, type GitHubRemoteRepository } from '../../../../../platform/github/common/githubService.js';
import { decodeAppServerRequestParams } from '../../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerGitHubService, createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import '../../browser/github.contribution.js';

const remote: GitHubRemoteRepository = { repository: { host: 'github.com', owner: 'alice', name: 'test' }, description: null, stars: 1, private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/alice/test', cloneUrl: 'https://github.com/alice/test.git', sshUrl: 'git@github.com:alice/test.git' };
const repository = () => ({ id: 'local', label: 'test', path: '/workspace', root: 'file:///workspace', head: { type: 'branch', name: 'feature', objectId: 'a'.repeat(40), upstream: { name: 'origin/remote-feature', ahead: 0, behind: 0 } }, uncommittedChanges: 0, remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'alice', repository: 'test' } }] });

/** Script choices at the public Quick Input boundary; actions still own their sequencing. */
function setup(resources: DisposableStore) {
	const services = resources.add(new InstantiationService());
	let gitStarted = false;
	services.registerInstance(IExtensionHostService, { start: async () => { gitStarted = true; } } as unknown as IExtensionHostService);
	services.registerInstance(IExtensionService, { activateByEvent: async () => { assert.ok(gitStarted); } } as unknown as IExtensionService);
	const requests: { id: string; args: readonly unknown[]; }[] = [];
	const confirmations: IConfirmationDialogOptions[] = [];
	const links: GitHubShareLink[] = [];
	const creates: unknown[][] = [];
	let contexts = [repository()];
	let pushFailure = false;
	let confirm = true;
	let copied = '';
	let protection = true;
	const inputs = ['test', 'github'];
	const picks: number[] = [];
	const pickerTitles: string[] = [];
	const github: IGitHubService = {
		...createDisconnectedGitHubService(),
		listAccounts: async () => [{ id: 'account', host: 'github.com', login: 'alice', status: 'ready', credentialRevision: 1n }],
		searchRepositories: async () => ({ items: [remote], nextPage: null }),
		listRepositoryBranches: async () => ({ items: [{ name: 'topic', default: false }, { name: 'main', default: true }], nextPage: null }),
		createRepository: async (...args) => { creates.push(args); return remote; },
		shareLink: async link => { links.push(link); return 'https://github.com/alice/test/shared'; },
		readBranchProtection: async () => ({ defaultBranch: 'main', rules: [{ include: ['**/*'], exclude: ['scratch/*'] }] }),
	};
	services.registerInstance(IGitHubService, github);
	services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None } as IAccountService);
	services.registerInstance(IConfigurationService, { getValue: (key: string) => key === 'github.gitProtocol' ? 'ssh' : protection } as IConfigurationService);
	services.registerInstance(INotificationService, { info: () => undefined } as unknown as INotificationService);
	services.registerInstance(IDialogService, { confirm: async (options: IConfirmationDialogOptions) => { confirmations.push(options); return { confirmed: confirm }; } } as IDialogService);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(IClipboardService, { writeText: async (text: string) => { copied = text; } } as IClipboardService);
	services.registerInstance(IEditorService, { activeEditor: { resource: URI.file('/workspace/src/a.ts') } } as IEditorService);
	services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => ({ getModel: () => ({ uri: URI.file('/workspace/src/a.ts') }), getSelection: () => ({ startLineNumber: 2, endLineNumber: 5, endColumn: 1 }) }), getActiveCodeEditor: () => null } as unknown as ICodeEditorService);
	services.registerInstance(IWorkingCopyService, { get: () => [] } as unknown as IWorkingCopyService);
	services.registerInstance(IFileService, { stat: async () => ({ kind: FileKind.File }) } as unknown as IFileService);
	services.registerInstance(ICommandService, {
		executeCommand: async (id: string, ...args: unknown[]) => {
			requests.push({ id, args });
			if (id === 'git.getRepositoryContexts') return contexts;
			if (id === 'git.executeRepositoryCommand' && (args[1] as { kind: string; }).kind === 'publishBranch' && pushFailure) throw new Error('push rejected');
			return null;
		}
	} as ICommandService);
	services.registerInstance(IQuickInputService, {
		input: async () => inputs.shift(),
		createQuickPick: () => {
			const accept = resources.add(new Emitter<void>());
			const hide = resources.add(new Emitter<void>());
			let shown = false;
			let items: readonly IQuickPickItem[] = [];
			const picker = {
				placeholder: '', ariaLabel: '', onDidHide: hide.event, onDidAccept: accept.event,
				onDidChangeValue: Event.None,
				get items() { return items; },
				set items(value: readonly IQuickPickItem[]) { items = value; if (shown && items.length) queueMicrotask(() => accept.fire()); },
				get activeItems() { return [items[picks.shift() ?? 0]]; },
				show() { shown = true; pickerTitles.push(this.ariaLabel); if (items.length) queueMicrotask(() => accept.fire()); },
				hide() { hide.fire(); }, dispose() { }, [Symbol.dispose]() { },
			};
			return picker as unknown as IQuickPick<IQuickPickItem>;
		},
	} as unknown as IQuickInputService);
	return {
		services, requests, confirmations, links, creates, picks, pickerTitles, github,
		contexts: (value: typeof contexts) => { contexts = value; }, failPush: () => { pushFailure = true; }, decline: () => { confirm = false; }, copied: () => copied, disableProtection: () => { protection = false; },
		run: (id: string, ...args: unknown[]) => services.invokeFunction(accessor => CommandsRegistry.getCommand(id)!(accessor, ...args)),
	};
}

for (const fail of [false, true]) {
	test(`publish action creates once with explicit visibility and preserves the remote after push failure=${fail}`, async () => {
		using resources = new DisposableStore();
		using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
		const fixture = setup(resources);
		if (fail) fixture.failPush();
		if (fail) await assert.rejects(fixture.run('github.publish') as Promise<void>, /created at https:\/\/github.com\/alice\/test.*Do not create/s);
		else await fixture.run('github.publish');
		assert.deepEqual(fixture.creates, [['account', 'test', '', 'private']]);
		const mutations = fixture.requests.filter(request => request.id === 'git.executeRepositoryCommand');
		assert.deepEqual(mutations.map(request => request.args), [
			['local', { kind: 'addRemote', name: 'github', url: remote.sshUrl }, 'account'],
			['local', { kind: 'publishBranch', remote: 'github', name: 'feature', branch: 'feature', expectedHead: 'a'.repeat(40) }, 'account'],
		]);
		assert.match(fixture.confirmations.at(-1)!.message, /private repository/);
	});
}

test('publish cancellation performs no remote write and Chinese confirmation uses the client catalog', async () => {
	using resources = new DisposableStore();
	using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
	const fixture = setup(resources); fixture.decline();
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try { await fixture.run('github.publish'); } finally { setNlsMessages('en', {}); }
	assert.deepEqual(fixture.creates, []);
	assert.match(fixture.confirmations[0]!.message, /私有仓库/);
});

test('repository search selection feeds the default branch and selected protocol into the real Git clone command', async () => {
	using resources = new DisposableStore(); const fixture = setup(resources);
	await fixture.run('github.clone');
	assert.deepEqual(fixture.requests, [{ id: 'git.clone', args: [remote.sshUrl, 'main', 'account'] }]);
	assert.deepEqual(fixture.pickerTitles, ['Search GitHub repositories or paste a repository URL', 'Choose a branch to clone']);
});

test('sharing prefers the tracked GitHub remote and uses the displayed selection with an exclusive end line', async () => {
	using resources = new DisposableStore();
	using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
	const fixture = setup(resources);
	const context = repository(); context.remotes.unshift({ name: 'upstream', identity: { provider: 'github', host: 'github.com', owner: 'other', repository: 'fork' } });
	fixture.contexts([context]);
	await fixture.run('github.copyPermalink');
	assert.deepEqual(fixture.links, [{ repository: remote.repository, reference: 'a'.repeat(40), referenceKind: 'commit', target: 'gitHub', path: 'src/a.ts', pathKind: 'file', lines: { start: 2, end: 4 } }]);
	assert.equal(fixture.copied(), 'https://github.com/alice/test/shared');
	await fixture.run('github.copyVscodeDevLink');
	assert.equal(fixture.links[1]!.reference, 'remote-feature');
});

test('cancelled push cannot produce a link to unpublished commits', async () => {
	using resources = new DisposableStore();
	using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
	const fixture = setup(resources); const context = repository(); context.head.upstream.ahead = 2; fixture.contexts([context]);
	await assert.rejects(fixture.run('github.copyPermalink') as Promise<void>, /unpublished commits/);
	assert.equal(fixture.links.length, 0);
	assert.ok(fixture.requests.some(request => request.id === 'git.push'));
});

test('the production protection hook honors exclusions, opt-out and provider failures', async () => {
	using resources = new DisposableStore(); const fixture = setup(resources); const remotes = repository().remotes;
	assert.equal(await fixture.run('github.isBranchProtected', 'main', remotes), true);
	assert.equal(await fixture.run('github.isBranchProtected', 'scratch/test', remotes), false);
	fixture.github.readBranchProtection = async () => { throw new Error('rules unavailable'); };
	await assert.rejects(fixture.run('github.isBranchProtected', 'main', remotes) as Promise<boolean>, /rules unavailable/);
	fixture.disableProtection();
	assert.equal(await fixture.run('github.isBranchProtected', 'main', remotes), false);
});

test('closing repository search on account changes cancels reads and never clones a late private result', async () => {
	using resources = new DisposableStore(); const fixture = setup(resources);
	const changes = resources.add(new Emitter<never>());
	// Replace only this service before the command captures its window dependencies.
	const services = resources.add(fixture.services.createChild());
	services.registerInstance(IAccountService, { onDidChangeAccounts: changes.event } as unknown as IAccountService);
	let started!: () => void;
	let release!: (page: { items: readonly GitHubRemoteRepository[]; nextPage: null; }) => void;
	let cancelled = false;
	const entered = new Promise<void>(resolve => { started = resolve; });
	fixture.github.searchRepositories = async (_account, _query, _page, token) => {
		token!.onCancellationRequested(() => { cancelled = true; });
		started(); return new Promise(resolve => { release = resolve; });
	};
	const pending = services.invokeFunction(accessor => CommandsRegistry.getCommand('github.clone')!(accessor)) as Promise<void>;
	await entered; changes.fire(undefined as never); await pending;
	assert.equal(cancelled, true);
	release({ items: [remote], nextPage: null }); await Promise.resolve();
	assert.equal(fixture.requests.length, 0);
});


test('repository transport validates anonymous links and keeps lost create replies uncertain', async () => {
	const sent: { method: string; params: Record<string, unknown>; }[] = [];
	const github = new AppServerGitHubService({
		state: 'ready', capabilities: { github: true, contracts: { github: { version: 1 } } },
		request: async (definition: { method: string; }, params: Record<string, unknown>) => {
			decodeAppServerRequestParams(definition.method as 'github/share/link', params);
			sent.push({ method: definition.method, params });
			if (definition.method === 'github/share/link') return { url: 'https://github.com/alice/test/tree/main' };
			throw new Error('connection lost');
		},
	} as unknown as AppServerProtocolClient);
	assert.equal(await github.shareLink({ repository: { ...remote.repository, accountId: 'must-not-be-sent' }, reference: 'main', referenceKind: 'branch', target: 'gitHub' }), 'https://github.com/alice/test/tree/main');
	assert.ok(!('accountId' in sent[0]!.params));
	assert.deepEqual(sent[0]!.params.repository, remote.repository);
	await assert.rejects(github.createRepository('account', 'repo', '', 'private'), error => error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain);
	assert.equal(sent.filter(request => request.method === 'github/repository/create').length, 1);
});


test('an empty remote repository can be cloned without inventing a branch', async () => {
	using resources = new DisposableStore(); const fixture = setup(resources);
	fixture.github.listRepositoryBranches = async () => ({ items: [], nextPage: null });
	await fixture.run('github.clone');
	assert.deepEqual(fixture.requests, [{ id: 'git.clone', args: [remote.sshUrl, null, 'account'] }]);
});


test('file and title vscode.dev commands omit editor ranges and use the tracked branch', async () => {
	using resources = new DisposableStore(); const fixture = setup(resources);
	for (const command of ['github.copyVscodeDevLinkFile', 'github.copyVscodeDevLinkWithoutRange']) {
		await fixture.run(command, URI.file('/workspace/src/a.ts'));
	}
	assert.equal(fixture.links.length, 2);
	assert.ok(fixture.links.every(link => link.reference === 'remote-feature' && link.lines === undefined));
});
