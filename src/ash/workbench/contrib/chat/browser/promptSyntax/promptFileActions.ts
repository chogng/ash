import { IAppServerHookApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstructionService, type InstructionImportPreview, type InstructionImportSource } from '../../../../../platform/instructions/common/instructionService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { parseClaudeHooks } from '../../common/promptSyntax/hookClaudeCompat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

async function pick<T extends IQuickPickItem>(quickInput: IQuickInputService, lifetime: DisposableStore, items: readonly T[], label: string, many = false): Promise<readonly T[] | undefined> {
	using controls = new DisposableStore();
	const picker = controls.add(quickInput.createQuickPick<T>());
	picker.items = items;
	picker.canSelectMany = many;
	picker.placeholder = picker.ariaLabel = label;
	controls.add(picker.onDidChangeValue(value => { picker.items = filterQuickPickItems(items, value); }));
	const stop = lifetime.add(toDisposable(() => picker.hide()));
	try {
		return await new Promise(resolve => {
			controls.add(picker.onDidAccept(() => {
				if (!picker.selectedItems.length) return;
				resolve([...picker.selectedItems]);
				picker.hide();
			}));
			controls.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
	} finally { lifetime.delete(stop); stop.dispose(); }
}

function reviewText(preview: InstructionImportPreview): string {
	return [
		localize('prompt.import.reviewHelp', 'Review the converted Instructions below. Use Import in the notification to publish these exact files. Closing the notification cancels the import.'),
		...preview.diagnostics.map(diagnostic => `${diagnostic.path}: ${diagnostic.message}`),
		...preview.items.map(item => [
			'─'.repeat(48),
			localize('prompt.import.file', 'Source: {0}\nTarget: {1}', item.source, URI.joinPath(preview.targetDirectory, item.target).toString()),
			...(item.message ? [item.message] : []), '', item.content,
		].join('\n')),
	].join('\n\n');
}

async function importInstructions(accessor: ServicesAccessor, lifetime: DisposableStore, scope: 'directory' | 'user'): Promise<void> {
	const configuration = accessor.get(IConfigurationService);
	if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
	const dialogs = accessor.get(IDialogService);
	const instructions = accessor.get(IInstructionService);
	const navigation = accessor.get(IChatSessionNavigationService);
	const notifications = accessor.get(INotificationService);
	const quickInput = accessor.get(IQuickInputService);
	const editors = accessor.get(IEditorService);
	const copies = accessor.get(IWorkingCopyService);
	const active = navigation.getActiveConversation();
	if (!active || !instructions.captureImports) {
		notifications.info(localize('prompt.import.sessionRequired', 'Open a saved chat on the project’s host before importing Instructions.'));
		return;
	}
	const revision = navigation.revision;
	const assertCurrent = (): void => {
		if (lifetime.isDisposed || revision !== navigation.revision || configuration.getValue<boolean>(ChatAIDisabledSettingId)) throw new CancellationError();
	};
	const imports = instructions.captureImports(active.sessionId);
	const directories = await imports.directories(scope);
	assertCurrent();
	if (!directories.length) {
		notifications.info(localize('prompt.import.noDirectories', 'This chat has no project directory available for import.'));
		return;
	}
	const selectedDirectory = await pick(quickInput, lifetime, directories.map(directory => ({ label: directory.path, description: directory.resource.toString(), directory })), scope === 'user' ? localize('prompt.import.userSource', 'Choose the external user home directory') : localize('prompt.import.directory', 'Choose the project directory whose Instructions you want to import'));
	if (!selectedDirectory) return;
	assertCurrent();
	const directory = selectedDirectory[0].directory;
	const selectedSource = await pick(quickInput, lifetime, (scope === 'user' ? ['claude', 'codex'] as const : ['copilot', 'claude', 'codex', 'cursor'] as const).map(source => ({ label: ({ copilot: 'Copilot', claude: 'Claude', codex: 'Codex', cursor: 'Cursor' })[source], source: source as InstructionImportSource })), localize('prompt.import.source', 'Choose the source format'));
	if (!selectedSource) return;
	assertCurrent();
	if (directory.needsAccess && scope === 'user') {
		notifications.info(localize('prompt.import.userGrantRequired', 'Add the external user home and the Ash profile directory to this Session with the required directory permissions before importing user Instructions.'));
		return;
	}
	if (directory.needsAccess) {
		const consent = await dialogs.confirm({
			custom: true,
			message: localize('prompt.import.access', 'Allow all chats and Agents in this Session to read, browse and write files in {0}?', directory.path),
			detail: localize('prompt.import.accessDetail', 'Instructions import requires a Session directory grant. This access applies to all files in the directory.'),
			primaryButton: localize('prompt.import.allowAccess', 'Allow directory access'),
		});
		if (!consent.confirmed) return;
		assertCurrent();
		await imports.grantAccess(directory.path);
		assertCurrent();
	}
	const selection = { ...(scope === 'user' ? { scope } : {}), directory: directory.path, source: selectedSource[0].source, sources: [] as readonly string[] };
	const catalog = await imports.preview(selection);
	assertCurrent();
	const eligible = catalog.items.filter(item => item.status === 'ready' || item.status === 'unchanged');
	if (!eligible.length) {
		await editors.openEditor({ resource: URI.from({ scheme: Schemas.untitled, path: '/instructions-import-review.txt', query: generateUuid() }), label: localize('prompt.import.reviewTitle', 'Instructions Import Review'), languageId: 'plaintext', readOnly: true, initialText: reviewText(catalog) }, { pinned: true });
		assertCurrent();
		notifications.info(localize('prompt.import.noCandidates', 'No Instructions can be imported from this source. Review the diagnostics and existing target files.'));
		return;
	}
	const selected = await pick(quickInput, lifetime, eligible.map(item => ({ label: item.source, description: item.target, item })), localize('prompt.import.chooseFiles', 'Select the Instructions to review and import'), true);
	if (!selected) return;
	assertCurrent();
	const exact = { ...selection, sources: selected.map(entry => entry.item.source) };
	// The backend digest binds the exact selected source set, not the discovery preview.
	const preview = await imports.preview(exact);
	assertCurrent();
	const assertClean = (): void => {
		if (preview.items.some(item => copies.get(URI.joinPath(preview.targetDirectory, item.target)).some(copy => copy.isDirty))) {
			throw new Error(localize('prompt.import.dirtyTarget', 'Save or revert unsaved target Instructions before importing.'));
		}
	};
	assertClean();
	await editors.openEditor({ resource: URI.from({ scheme: Schemas.untitled, path: '/instructions-import-review.txt', query: generateUuid() }), label: localize('prompt.import.reviewTitle', 'Instructions Import Review'), languageId: 'plaintext', readOnly: true, initialText: reviewText(preview) }, { pinned: true });
	assertCurrent();
	if (preview.items.some(item => item.status !== 'ready' && item.status !== 'unchanged')) {
		notifications.warn(localize('prompt.import.changedTargets', 'Some selected Instructions cannot be imported. Review the diagnostics and start the import again.'));
		return;
	}
	await new Promise<void>(resolve => {
		let applied = false;
		const notification = notifications.notify({
			severity: Severity.Info, sticky: true,
			message: localize('prompt.import.ready', 'Review the {0} converted Instructions in the editor, then choose Import.', preview.items.length),
			actions: {
				primary: [{
					id: 'prompt.import.apply', label: localize('prompt.import.apply', 'Import'), tooltip: '', enabled: true, run: async () => {
						if (applied) return;
						applied = true;
						notification.updateActions({});
						try {
							assertCurrent();
							assertClean();
							const results = await imports.apply(exact, preview.digest);
							const imported = results.filter(item => item.status === 'imported').length;
							const unchanged = results.filter(item => item.status === 'unchanged').length;
							const failed = results.filter(item => item.status !== 'imported' && item.status !== 'unchanged');
							const summary = localize('prompt.import.result', 'Instructions import: {0} imported, {1} unchanged, {2} failed or conflicting.', imported, unchanged, failed.length);
							if (failed.length) notifications.warn([summary, ...failed.map(item => `${item.source}: ${item.message ?? item.target}`)].join('\n'));
							else notifications.info(summary);
						} catch (error) {
							if (!isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
						} finally { notification.close(); resolve(); }
					}
				}]
			},
		});
		lifetime.add(notification.onDidClose(() => resolve()));
		lifetime.add(toDisposable(() => notification.close()));
	});
}

/** Native imports reuse the Instructions authority and the editor's review/dirty owners. */
export function registerPromptActions(): DisposableStore {
	const registrations = new DisposableStore();
	for (const [scope, id, title] of [
		['directory', 'workbench.action.chat.importInstructions', localize2('prompt.import.command', 'Chat: Import Instructions…')],
		['user', 'workbench.action.chat.importUserInstructions', localize2('prompt.import.userCommand', 'Chat: Import User Instructions…')],
	] as const) {
		registrations.add(registerAction2(class extends Action2 {
			constructor() { super({ id, title, f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
			public override async run(accessor: ServicesAccessor): Promise<void> {
				const lifetime = registrations.add(new DisposableStore());
				try { await importInstructions(accessor, lifetime, scope); }
				finally { registrations.delete(lifetime); lifetime.dispose(); }
			}
		}));
	}
	registrations.add(registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.reviewClaudeHookMigration',
				title: localize2('prompt.hooks.reviewCommand', 'Chat: Review Claude Hook Migration…'),
				f1: true,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
			});
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const dialogs = accessor.get(IFileDialogService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			const hooks = accessor.get(IAppServerHookApi);
			const notifications = accessor.get(INotificationService);
			const configuration = accessor.get(IConfigurationService);
			const current = () => !registrations.isDisposed && !configuration.getValue<boolean>(ChatAIDisabledSettingId);
			if (!current()) return;
			const apply = await hooks.captureClaudeHookImport?.();
			if (!current()) return;
			const paths = await dialogs.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: 'JSON', extensions: ['json'] }],
				title: localize('prompt.hooks.source', 'Select Claude Settings'),
			});
			const source = paths?.[0];
			if (!source || !current()) return;
			const maximumBytes = 1024 * 1024;
			if ((await files.stat(source)).sizeBytes > maximumBytes) {
				throw new Error(localize('prompt.hooks.tooLarge', 'Claude settings exceed the 1 MiB import limit.'));
			}
			const { content } = await files.readFile(source);
			const bytes = new TextEncoder().encode(content);
			if (bytes.byteLength > maximumBytes) {
				throw new Error(localize('prompt.hooks.tooLarge', 'Claude settings exceed the 1 MiB import limit.'));
			}
			if (!current()) return;
			let settings: unknown;
			try { settings = JSON.parse(content); }
			catch { throw new Error(localize('prompt.hooks.invalidJson', 'The selected Claude settings are not valid JSON.')); }
			const id = generateUuid();
			const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
			if (!current()) return;
			const sourceIdentity = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
			const { toml, commands, skipped } = parseClaudeHooks(settings, sourceIdentity);
			if (!current()) return;
			const notes = [
				localize('prompt.hooks.reviewHelp', 'Review each command before importing these disabled declarations into your Ash user configuration. Commands receive Ash tool names and arguments. Check their scripts before enabling them.'),
				localize('prompt.hooks.skipped', 'Skipped unsupported events, groups, or commands: {0}', skipped),
				...(toml ? [] : [localize('prompt.hooks.noCandidates', 'There are no supported enabled Claude declarations to convert.')]),
			];
			await editors.openEditor({
				resource: URI.from({ scheme: Schemas.untitled, path: '/claude-hook-review.toml', query: id }),
				label: localize('prompt.hooks.reviewTitle', 'Claude Hook Migration Review'),
				languageId: 'toml',
				readOnly: true,
				initialText: notes.map(note => `# ${note}`).join('\n') + '\n\n' + toml,
			}, { pinned: true });
			if (!apply || !commands.length || !current()) return;
			using lifetime = registrations.add(new DisposableStore());
			try {
				await new Promise<void>(resolve => {
					let applying = false;
					const notification = notifications.notify({
						severity: Severity.Info,
						sticky: true,
						message: localize('prompt.hooks.ready', 'Review the Hook declarations in the editor before importing.'),
						actions: {
							primary: [{
								id: 'prompt.hooks.apply',
								label: localize('prompt.hooks.apply', 'Import Disabled Hooks'),
								tooltip: '',
								enabled: true,
								run: async () => {
									if (applying || lifetime.isDisposed || !current()) return;
									applying = true;
									notification.updateActions({});
									try {
										const result = await apply(commands, () => !lifetime.isDisposed && current());
										const summary = localize('prompt.hooks.result', 'Imported {0} of {1} Hooks as disabled. Already present: {2}.', result.imported, commands.length, result.existing);
										if (result.error) notifications.warn(`${summary} ${String(result.error)}`);
										else notifications.info(summary);
									} finally {
										notification.close();
										resolve();
									}
								},
							}]
						},
					});
					lifetime.add(notification.onDidClose(() => resolve()));
					lifetime.add(toDisposable(() => notification.close()));
				});
			} finally { registrations.delete(lifetime); }
		}
	}));
	return registrations;
}
