import { scm, editors } from 'ash';
import { commands, workspace, Uri, EventEmitter } from 'vscode';

export function activate(context) {
	scm.initialize();
	let provider;
	let refreshes = 0;
	const changes = new EventEmitter();
	context.subscriptions.push(changes);
	context.subscriptions.push(commands.registerCommand('ash.scm.fixture.refresh', () => provider.refresh()));
	context.subscriptions.push(commands.registerCommand('ash.scm.fixture.activate', () => {
		if (provider) { scm.selectRepository(provider.id); return; }
		const root = workspace.workspaceFolders[0].uri;
		const file = Uri.joinPath(root, 'main.ts');
		const original = { resource: 'snapshot:/independent/main.ts', label: 'Independent baseline', initialText: 'const value = 1;\n' };
		const modified = { resource: file.toString(), label: 'main.ts' };
		provider = {
			id: 'independent-scm', providerId: 'independent', label: 'Independent SCM', rootUri: root,
			onDidChangeResources: changes.event,
			groups: [{
				id: 'changes', label: 'Independent changes', actions: [], resources: [{
					sourceUri: file, path: 'main.ts', decorations: { badge: 'M', tooltip: 'Independent change', kind: 'modified' },
					openLabel: 'Open independent diff', actions: [],
					open: (options, sideBySide) => editors.request({ method: 'open', input: { kind: 'diff', label: 'Independent comparison', original, modified }, options, sideBySide }),
				}]
			}],
			input: { value: '', placeholder: 'Independent message', enabled: true, canAccept: true, buttonLabel: 'Record', buttonTooltip: 'Record independent message', async accept() { provider.statusMessage = `Recorded: ${provider.input.value}`; provider.input.value = ''; changes.fire(); } },
			statusBarCommands: [], statusMessage: '', isBusy: false,
			async refresh() { provider.statusMessage = `Independent refresh ${++refreshes}`; changes.fire(); },
			async activate() { },
		};
		context.subscriptions.push(scm.registerSCMProvider(provider, {
			parseUri: Uri.parse,
			quickDiff: { async provideOriginalResource(resource) { return resource.toString() === file.toString() ? { originalResource: 'snapshot:/independent/main.ts', label: 'Independent baseline', text: 'const value = 1;\n', revision: 1 } : null; } },
		}));
		scm.selectRepository(provider.id);
	}));
}
