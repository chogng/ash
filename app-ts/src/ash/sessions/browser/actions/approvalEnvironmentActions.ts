import { DisposableStore } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IApprovalEnvironmentService, type ReviewEnvironmentEntry, type ReviewEnvironmentScanOptions, type ReviewEnvironmentScope } from '../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { OPEN_GUARDIAN_SETUP_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';

interface Item extends IQuickPickItem { readonly id: string }

registerAction2(class PrepareApprovalEnvironment extends Action2 {
	constructor() {
		super({ id: OPEN_GUARDIAN_SETUP_COMMAND_ID, title: localize2('approvalEnvironment.title', 'Prepare review environment…') });
	}
	override async run(accessor: ServicesAccessor, model: IChatWidgetModel, argument = ''): Promise<void> {
		if (argument.trim() && argument.trim() !== 'setup') { throw new Error(localize('approvalEnvironment.commandUsage', 'Use /guardian or /guardian setup to prepare review background.')); }
		const input = accessor.get(IQuickInputService);
		const service = accessor.get(IApprovalEnvironmentService);
		const notifications = accessor.get(INotificationService);
		const sessions = accessor.get(ISessionsManagementService);
		const threadId = model.threadId;
		const taskModel = model.inputState.selectedModel;
		let selectedRoot: string | undefined;
		if (model.untitledSessionId) {
			const workspace = sessions.untitledSessions.find(session => session.untitledSessionId === model.untitledSessionId)?.workspace;
			if (workspace?.type === 'local' || workspace?.type === 'ssh') { selectedRoot = workspace.root; }
			if (workspace?.type === 'current') {
				const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
				if (folders.length === 1) { selectedRoot = folders[0]!.uri.fsPath; }
				else if (folders.length > 1) { selectedRoot = (await pick(input, localize('approvalEnvironment.project', 'Choose the project to prepare'), folders.map(folder => ({ id: folder.uri.fsPath, label: folder.name, description: folder.uri.fsPath }))))?.id; }
			}
		}
		if (!threadId && !selectedRoot) { throw new Error(localize('approvalEnvironment.noProject', 'Choose a project for this chat before preparing its review environment.')); }
		const scope: ReviewEnvironmentScope = threadId ? { type: 'thread', threadId } : { type: 'directory', root: selectedRoot! };
		const profile = await service.read(scope);
		const root = profile.root;
		let entries = [...profile.entries];
		let revision = profile.revision;
		let draftId: string | undefined;
		const editedSources = new Set<string>();
		for (;;) {
			const choice = await pick(input, localize('approvalEnvironment.review', 'Review environment: {0}', root), [
				{ id: 'scan', label: localize('approvalEnvironment.scan', 'Scan project…'), description: localize('approvalEnvironment.scanDetail', 'Choose scope and create a draft; nothing is accepted automatically') },
				{ id: 'add', label: localize('approvalEnvironment.add', 'Add a description…') },
				...entries.map(entry => ({ id: entry.id, label: entry.title, picked: entry.accepted && entry.current, description: entry.current ? entry.accepted ? localize('approvalEnvironment.accepted', 'Accepted') : localize('approvalEnvironment.pending', 'Pending review') : localize('approvalEnvironment.stale', 'Source changed — excluded from review'), detail: `${sourceLabel(entry)}\n${entry.content}` })),
				{ id: 'save', label: localize('approvalEnvironment.save', 'Save accepted entries'), description: localize('approvalEnvironment.following', 'Saved project sources refresh before review. New observations remain unconfirmed; changed target descriptions need confirmation.') },
			]);
			if (!choice) { return; }
			if (choice.id === 'scan') {
				const options = await scanOptions(input, !!threadId);
				if (!options) { continue; }
				const operationId = generateUuid();
				using progress = new DisposableStore();
				const waiting = progress.add(input.createQuickPick<Item>());
				waiting.ariaLabel = localize('approvalEnvironment.scanning', 'Preparing review environment');
				waiting.placeholder = localize('approvalEnvironment.cancelHint', 'Press Escape to cancel the scan.');
				waiting.items = [{ id: 'cancel', label: localize('approvalEnvironment.cancel', 'Cancel scan') }];
				let cancelled = false;
				let finished = false;
				const cancel = (): void => {
					if (finished || cancelled) { return; }
					cancelled = true;
					void service.cancel(operationId).catch(error => notifications.error(error instanceof Error ? error.message : String(error)));
				};
				progress.add(waiting.onDidAccept(() => { cancel(); waiting.hide(); }));
				progress.add(waiting.onDidHide(cancel));
				progress.add(waiting.onDidBlur(cancel));
				waiting.show();
				try {
					const draft = await service.scan(scope, operationId, options, taskModel);
					if (!cancelled) {
						const edited = new Map(entries.filter(entry => editedSources.has(sourceKey(entry))).map(entry => [sourceKey(entry), entry]));
						const retained = entries.filter(entry => entry.source.kind === 'manual' && !draft.entries.some(scanned => scanned.id === entry.id));
						entries = [...draft.entries.map(entry => entry.current && edited.has(sourceKey(entry)) ? edited.get(sourceKey(entry))! : entry), ...retained];
						revision = draft.baseRevision;
						draftId = draft.id;
					}
				} catch (error) { if (!cancelled) { notifications.error(error instanceof Error ? error.message : String(error)); } }
				finally { finished = true; waiting.hide(); }
			} else if (choice.id === 'add') {
				const content = await input.input({ title: localize('approvalEnvironment.description', 'Describe project tools, environments, or a target you own'), placeHolder: localize('approvalEnvironment.noSecrets', 'Do not include credentials. This description does not grant permissions.') });
				if (!content?.trim()) { continue; }
				const title = await input.input({ title: localize('approvalEnvironment.entryTitle', 'Description title'), value: content.slice(0, 80) });
				if (!title?.trim()) { continue; }
				const id = generateUuid();
				entries.push({ id, kind: 'fact', title, content, accepted: true, current: true, source: { id: `manual:${id}`, kind: 'manual', label: '', revision: '' } });
			} else if (choice.id === 'save') {
				try {
					await service.save(scope, generateUuid(), revision, entries.filter(entry => entry.accepted && entry.current).map(entry => ({ id: entry.id, kind: entry.kind, title: entry.title, content: entry.content, sourceId: entry.source.kind === 'manual' ? undefined : entry.source.id })), draftId);
					notifications.info(localize('approvalEnvironment.saved', 'Review environment saved for this project.'));
					return;
				} catch (error) { notifications.error(error instanceof Error ? error.message : String(error)); }
			} else {
				const entry = entries.find(entry => entry.id === choice.id)!;
				const action = await pick(input, entry.title, [
					...(entry.current ? [{ id: 'accept', label: localize('approvalEnvironment.acceptFact', 'Accept as project background') }] : []),
					...(entry.current && (entry.source.kind === 'projectFile' || entry.source.kind === 'manual') ? [{ id: 'target', label: localize('approvalEnvironment.confirmTarget', 'Confirm target ownership…'), description: localize('approvalEnvironment.targetDetail', 'Describe exactly which target is yours and its purpose; this does not authorize actions') }] : []),
					{ id: 'edit', label: localize('approvalEnvironment.edit', 'Edit description…') },
					{ id: 'exclude', label: localize('approvalEnvironment.exclude', 'Exclude this entry') },
				]);
				if (!action) { continue; }
				let updated: ReviewEnvironmentEntry;
				if (action.id === 'edit' || action.id === 'target') {
					const content = await input.input({ title: action.id === 'target' ? localize('approvalEnvironment.targetPrompt', 'Which exact target do you own, and what is it used for?') : localize('approvalEnvironment.edit', 'Edit description…'), value: entry.content });
					if (!content?.trim()) { continue; }
					updated = { ...entry, content, kind: action.id === 'target' ? 'target' : entry.kind, accepted: entry.current };
				} else { updated = { ...entry, kind: 'fact', accepted: action.id === 'accept' }; }
				entries = entries.map(old => old === entry ? updated : old);
				editedSources.add(sourceKey(updated));
			}
		}
	}
});

function sourceKey(entry: ReviewEnvironmentEntry): string { return `${entry.source.id}:${entry.source.revision}`; }

function sourceLabel(entry: ReviewEnvironmentEntry): string {
	switch (entry.source.kind) {
		case 'projectFile': return localize('approvalEnvironment.projectSource', 'Project file: {0} · {1}', entry.source.label, entry.source.revision.slice(0, 8));
		case 'recentCommand': return localize('approvalEnvironment.sessionSource', 'Historical session command');
		case 'shellHistory': return localize('approvalEnvironment.historySource', 'Historical executable names');
		case 'otherRepository': return localize('approvalEnvironment.repositorySource', 'Historical remote observation: {0}', entry.source.label.split(': ').at(-1)!);
		case 'manual': return localize('approvalEnvironment.manualSource', 'Your description');
	}
}

async function scanOptions(input: IQuickInputService, hasThread: boolean): Promise<ReviewEnvironmentScanOptions | undefined> {
	let options: ReviewEnvironmentScanOptions = { recentCommands: false, shellHistory: false, otherRepositories: false, summarizeWithModel: true };
	for (;;) {
		const choice = await pick(input, localize('approvalEnvironment.scope', 'Scan scope — current project is included'), [
			{ id: 'summarizeWithModel', label: localize('approvalEnvironment.summarize', 'Summarize with the current task model'), description: localize('approvalEnvironment.modelPrivacy', 'Sends filtered observations to this model; no tools or automatic permissions'), picked: options.summarizeWithModel },
			...(hasThread ? [{ id: 'recentCommands', label: localize('approvalEnvironment.recent', 'Include recent commands from this chat'), picked: options.recentCommands }] : []),
			{ id: 'shellHistory', label: localize('approvalEnvironment.history', 'Include shell history executable names'), description: localize('approvalEnvironment.historyDetail', 'Reads bounded history on the execution machine; excludes arguments'), picked: options.shellHistory },
			{ id: 'otherRepositories', label: localize('approvalEnvironment.repositories', 'Include other repositories in the home directory'), description: localize('approvalEnvironment.repositoriesDetail', 'Reads bounded Git remote metadata on the execution machine; excludes source code'), picked: options.otherRepositories },
			{ id: 'continue', label: localize('approvalEnvironment.continue', 'Continue — generate draft') },
		]);
		if (!choice) { return undefined; }
		if (choice.id === 'continue') { return options; }
		const key = choice.id as keyof ReviewEnvironmentScanOptions;
		options = { ...options, [key]: !options[key] };
	}
}

function pick(input: IQuickInputService, title: string, items: readonly Item[]): Promise<Item | undefined> {
	return new Promise(resolve => {
		const store = new DisposableStore();
		const picker = store.add(input.createQuickPick<Item>());
		picker.ariaLabel = title;
		picker.placeholder = title;
		picker.items = items;
		let selected: Item | undefined;
		store.add(picker.onDidAccept(item => { selected = item; picker.hide(); }));
		store.add(picker.onDidHide(() => { store.dispose(); resolve(selected); }));
		picker.show();
	});
}
