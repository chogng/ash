import { GitIgnoreDecorationProvider } from './gitIgnoreDecorationProvider.js';
import { scm, editors } from 'ash';
import { workspace, window, env, type ExtensionContext } from 'vscode';
import { DisposableStore, toDisposable, URI } from '../../../sdk/browser/index.js';
import { GitBackendMonitor } from './monitor.js';
import { GitService } from './gitService.js';
import { GitSCMProvider } from './gitSCMProvider.js';
import { GitHistoryProvider } from './gitHistoryProvider.js';
import { GitQuickDiffProvider } from './gitQuickDiffProvider.js';
import { createGitApi } from './backend.js';
import { registerGitCommands } from './commands.js';
import { commandClient, dialogClient, editorClient, viewsClient, workingCopyClient } from './editors.js';
import { createGitMultiDiffEditorInput } from './multiDiff.js';
import { localize, setLanguage } from './support.js';

export async function activate(context: ExtensionContext): Promise<void> {
	setLanguage(env.language);
	const lifetime = new DisposableStore();
	context.subscriptions.push(lifetime);
	scm.initialize();
	const channel = window.createOutputChannel('Git');
	context.subscriptions.push(channel);
	const report = (error: unknown): void => channel.appendLine(String(error));
	const monitor = lifetime.add(new GitBackendMonitor(report));
	const facts = await editors.request<{ canClone: boolean; }>({ method: 'hostFacts' });
	const git = lifetime.add(new GitService({ api: createGitApi(), appServerApi: monitor.connection, eventApi: monitor.notifications, workspaceContext: monitor.workspace, canCloneRepository: facts.canClone }, {
		inspect: key => ({ userLocalValue: workspace.getConfiguration().inspect(key)?.globalValue }),
		updateValue: (key, value) => Promise.resolve(workspace.getConfiguration().update(key, value, true)),
	}, { error: (_category, message, error) => channel.appendLine(`${message}${error ? `: ${String(error)}` : ''}`) }));
	const providers = new Map<string, GitSCMProvider>();
	const owners = new Map<string, DisposableStore>();
	lifetime.add(toDisposable(() => { for (const owner of owners.values()) { owner.dispose(); } owners.clear(); providers.clear(); }));
	const quickDiff = lifetime.add(new GitQuickDiffProvider(git));
	const ignored = lifetime.add(new GitIgnoreDecorationProvider(git));
	const sync = (): void => {
		const current = new Set(git.repositories.map(repository => repository.id));
		for (const [id, owner] of owners) { if (!current.has(id)) { owner.dispose(); owners.delete(id); providers.delete(id); } }
		for (const repository of git.repositories) {
			if (providers.has(repository.id)) { continue; }
			const owner = new DisposableStore();
			const history = owner.add(new GitHistoryProvider(git, repository.id));
			const provider = owner.add(new GitSCMProvider(git, repository, history, { commandService: commandClient, dialogService: dialogClient, editorService: editorClient, viewsService: viewsClient, workingCopyService: workingCopyClient }));
			owners.set(repository.id, owner);
			providers.set(repository.id, provider);
			owner.add(scm.registerSCMProvider(provider, {
				parseUri: URI.parse, quickDiff, multiDiff: {
					metadata: {
						resourcePrefix: URI.from({ scheme: 'ash-scm', authority: 'ash.git', path: `/${encodeURIComponent(repository.id)}` }).toString(),
						sourceActions: ['staged', 'unstaged', 'uncommitted'].map(scope => ({ id: `git.source.${repository.id}.${scope}`, label: `${repository.label}: ${scope === 'staged' ? localize('git.stagedChanges', 'Staged Changes') : scope === 'unstaged' ? localize('git.changes', 'Changes') : localize('git.uncommittedChanges', 'Uncommitted Changes')}`, tooltip: repository.label, command: 'git.openChangesSource', arguments: [repository.id, scope] })),
						repositoryActions: [
							['git.commitFromChanges', localize('git.commit', 'Commit'), 'git-commit'], ['git.commitAndPushFromChanges', localize('git.commitAndPush', 'Commit and Push'), 'repo-push'], ['git.push', localize('git.push', 'Push'), 'repo-push'], ['git.stageAll', localize('git.stageAll', 'Stage All'), 'check'], ['git.cleanAll', localize('git.discardChanges', 'Discard Changes'), 'discard'],
						].map(([command, label, icon]) => ({ id: command, label, tooltip: label, icon, command, arguments: [repository.id] })),
					},
					async resolve(resource) { const scope = new URLSearchParams(resource.query).get('scope'); if (scope !== 'staged' && scope !== 'unstaged' && scope !== 'uncommitted') throw new TypeError('Invalid Git change scope'); return createGitMultiDiffEditorInput(git, scope, await git.status(repository.id)); },
				}, decorations: {
					label: 'Git', onDidChange: listener => { const listeners = new DisposableStore(); listeners.add(provider.onDidChange(listener)); listeners.add(ignored.onDidChange(listener)); return listeners; },
					async provideDecorations(resource, token) {
						const decoration = provider.provideDecorations(resource);
						if (decoration) { return decoration; }
						return ignored.provideDecorations(resource, token);
					},
				}
			}));
			owner.add(provider.onDidChangeResources(() => { if (provider.statusMessage) { channel.appendLine(`[${repository.label}] ${provider.statusMessage}`); } }));
		}
	};
	lifetime.add(git.onDidChangeRepositories(sync));
	lifetime.add(git.onDidChangeActiveRepository(repository => scm.selectRepository(repository?.id)));
	// GitService discovers repositories from workspace/connection events in the background.
	// An immediate command joins that discovery instead of running before its provider exists.
	const initialized = monitor.start();
	registerGitCommands(context, git, providers, monitor, () => channel.show(), async () => {
		await initialized;
		if (!git.repositories.length && monitor.workspace.getWorkspace().folders.length) { await git.listRepositories(); }
	});
	sync();
}
