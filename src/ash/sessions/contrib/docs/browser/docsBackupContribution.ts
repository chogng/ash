import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IFileTextModelService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { WorkingCopyBackupTracker } from '../../../../workbench/services/workingCopy/browser/workingCopyBackupTracker.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import { LEGACY_DOCS_CONTENT_TYPE } from '../common/docs.js';
import { createArkdownDocsInput } from './docsEditorInput.js';
import { migrateLegacyDocsInput } from './legacyDocsMigration.js';

/** Profile-owned Docs recovery remains independent of the selected conversation workspace. */
export function createDocsBackupContribution(accessor: ServicesAccessor): IWorkbenchContribution {
	const lifetime = new DisposableStore();
	const instantiation = accessor.get(IInstantiationService);
	const backups = accessor.get(IWorkingCopyBackupService);
	const copies = accessor.get(IWorkingCopyService);
	const models = accessor.get(IFileTextModelService);
	const editors = accessor.get(IEditorPart) as EditorParts;
	const lifecycle = accessor.get(ILifecycleService);
	const log = accessor.get(ILogService);
	const notifications = accessor.get(INotificationService);
	const generated = accessor.get(IGeneratedFilesService);
	// Source and Docs facades share a Markdown model, including after either view closes.
	const isDocsCopy = (copy: IWorkingCopy) => copy.backupContentType === 'text/markdown' || copy.backupContentType === LEGACY_DOCS_CONTENT_TYPE || /\.md$/iu.test(copy.resource.path);
	const docsEvent = (event: Event<IWorkingCopy>): Event<IWorkingCopy> => (listener, thisArgs, disposables) =>
		event(copy => { if (isDocsCopy(copy)) listener.call(thisArgs, copy); }, undefined, disposables);
	const tracker = lifetime.add(new WorkingCopyBackupTracker({
		getAll: () => copies.getAll().filter(isDocsCopy),
		get: resource => copies.get(resource).filter(isDocsCopy),
		onDidRegister: docsEvent(copies.onDidRegister),
		onDidUnregister: docsEvent(copies.onDidUnregister),
	}, backups, editors.domNode.ownerDocument.defaultView!, error => {
		log.error('Docs backup failed', error);
		notifications.error(error instanceof Error ? error : String(error));
	}, resource => models.hasPendingSaveRecovery(resource)));
	lifetime.add(models.addSaveCompletionParticipant({ prepare: (model, signal, recovery) => tracker.prepareSave(model, signal, recovery) }));
	lifetime.add(lifecycle.onWillShutdown(event => event.join(() => tracker.shutdown(), 'Docs backup drain', () => tracker.isShutdownCurrent)));
	lifetime.add(lifecycle.onDidShutdown(() => tracker.completeShutdown()));
	lifetime.add(lifecycle.onDidShutdownError(reason => { if (reason !== 'pageHide') tracker.cancelShutdown(); }));
	lifetime.add(lifecycle.onBeforeShutdownError(event => { if (event.reason === 'pageHide') tracker.completeShutdown(); }));

	return Object.assign(lifetime, {
		async onWorkspaceRestored(): Promise<void> {
			const pending = await backups.list();
			const generatedResources = new Set(pending
				.filter(backup => generated.isProfileGeneratedPath(backup.resource) || generated.isGeneratedResource(backup.resource))
				.map(backup => backup.resource.toString()));
			let generatedReady = false;
			if (generatedResources.size) {
				try { await generated.refresh(); generatedReady = true; }
				catch (error) { log.error('Docs generated-file recovery catalog failed', error); }
			}
			for (const backup of pending) {
				if (lifetime.isDisposed) return;
				if (generatedResources.has(backup.resource.toString()) && (!generatedReady || !generated.files.some(file => file.resource.toString() === backup.resource.toString()))) continue;
				const legacy = backup.contentType === LEGACY_DOCS_CONTENT_TYPE || /\.ash-doc$/iu.test(backup.resource.path);
				if (!legacy && backup.contentType !== 'text/markdown' && !/\.md$/iu.test(backup.resource.path)) continue;
				try {
					const source = { resource: backup.resource, label: backup.label, initialText: backup.resource.scheme === 'untitled' ? backup.content : undefined };
					const docs = legacy || backup.contentType === 'text/markdown';
					const input = legacy
						? await instantiation.invokeFunction(accessor => migrateLegacyDocsInput(source, accessor))
						: docs ? createArkdownDocsInput(source) : { ...source, languageId: 'markdown' };
					if (lifetime.isDisposed) return;
					const recovery = await backups.resolve(input.resource);
					const copy = copies.get(input.resource).find(copy => copy.backupKind === 'text');
					if (copy) {
						if (!copy.isDirty && recovery?.kind === 'text') copy.restoreBackup(recovery.content);
						continue;
					}
					// Retain recovered Docs in Artifacts without replacing the restored conversation.
					const groupId = docs ? editors.pageGroupId : editors.groups.find(group => group.id !== editors.pageGroupId)!.id;
					const pane = await editors.openEditor(input, { pinned: true, inactive: true, preserveFocus: true }, { groupId });
					if (recovery?.kind === 'text' && pane.workingCopy && !pane.workingCopy.isDirty) pane.workingCopy.restoreBackup(recovery.content);
				} catch (error) {
					log.error('Docs recovery failed', error);
					notifications.error(error instanceof Error ? error : String(error));
				}
			}
		},
	});
}
