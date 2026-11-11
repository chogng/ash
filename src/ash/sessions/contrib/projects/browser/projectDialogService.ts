import { addDisposableListener, getActiveElement, getWindow, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ContextView } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Hover } from '../../../../base/browser/ui/hover/hover.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorCoreCommandId } from '../../../../editor/browser/coreCommands.js';
import { EditorContributionInstantiation } from '../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModelChangeReason } from '../../../../editor/common/core/textChange.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { PlaceholderTextContribution } from '../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IMemoriesService } from '../../../../platform/memories/common/memoriesService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProjectService, type Project, type ProjectAppearance, type ProjectMaterial, type ProjectScope } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { OPEN_MEMORIES_COMMAND_ID } from '../../../../workbench/contrib/memories/browser/memorySettings.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionFolderAuthorizationService } from '../../../common/sessionWorkspace.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { SessionWorkspaceSelection } from '../../../services/sessions/common/session.js';
import { IChatListCatalog, type CatalogProjectDetails } from '../../chat/browser/chatListModel.js';
import type { CatalogProjectCreator, CatalogProjectMemoryMode, ConversationProjectEditor } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ProjectAppearancePicker } from './projectAppearancePicker.js';
import { ProjectMemoryDialog } from './projectMemoryDialog.js';
import { ProjectTextInput } from './projectTextInput.js';
import { IProjectsService, type CatalogProjectAppearance } from './projectsService.js';
import './media/projectForm.css';

function projectMemoryOptions() {
	return [
		{ value: 'default', label: localize('projects.defaultMemory', 'Default memory'), description: localize('projects.defaultMemoryDescription', 'Uses your ChatGPT memory settings.') },
		{ value: 'projectOnly', label: localize('projects.projectOnlyMemory', 'Project-only memory'), description: localize('projects.projectOnlyMemoryDescription', 'References conversations only within this project.') },
	] satisfies readonly { value: CatalogProjectMemoryMode; label: string; description: string; }[];
}

function createProjectFormDialog(
	container: HTMLElement,
	title: string,
	form: HTMLFormElement,
	actions: HTMLElement,
	options: { canClose: () => boolean; shouldConfirmDiscard: () => boolean; code?: boolean; appearanceOnly?: boolean; instructionsOnly?: boolean; withCreationDetails?: boolean; textContent?: boolean; },
): Dialog {
	return new Dialog(container, title, [], createWorkbenchDialogOptions({
		extraClasses: [
			'ash-projects-dialog',
			...(options.code ? ['ash-code-project-dialog'] : []),
			...(options.appearanceOnly ? ['ash-project-appearance-dialog'] : []),
			...(options.instructionsOnly ? ['ash-project-instructions-dialog'] : []),
			...(options.withCreationDetails ? ['ash-project-creation-dialog'] : []),
			...(options.textContent ? ['ash-project-text-dialog'] : []),
		],
		layout: 'form',
		modal: false,
		closeOnBackdropClick: true,
		disableDefaultAction: true,
		canClose: options.canClose,
		shouldConfirmDiscard: options.shouldConfirmDiscard,
		renderBody: body => body.append(form),
		renderFooter: footer => footer.append(actions),
	}));
}

export type ChatProjectEdit =
	| (({ readonly project: Project; } | { readonly conversation: ConversationProjectEditor; readonly appearance?: CatalogProjectAppearance; }) & { readonly instructionsOnly?: boolean; })
	| { readonly title: string; readonly appearance: CatalogProjectAppearance; };

export async function readCatalogProjectEdit(
	title: string, appearance: CatalogProjectAppearance | undefined,
	read: ((signal: AbortSignal) => Promise<ConversationProjectEditor>) | undefined, signal: AbortSignal,
): Promise<ChatProjectEdit> {
	if (read) {
		try {
			return { conversation: await read(signal), appearance };
		} catch (error) {
			if (!appearance || signal.aborted || isCancellationError(error)) throw error;
		}
	}
	return { title, appearance: appearance! };
}

interface CodeProjectEdit {
	readonly id: string;
	readonly restoreFocus: () => void;
}

type ProjectMemoryTarget =
	| { readonly localProjectId: string; }
	| { readonly editMemory: CatalogProjectDetails['editMemory']; };

export interface IProjectDialogService {
	showChatProjectDialog(owner: HTMLElement, restoreFocus: () => void, edit?: ChatProjectEdit, creator?: CatalogProjectCreator): void;
	showProjectMemories(owner: HTMLElement, target: ProjectMemoryTarget, isCurrent: (reader?: IReader) => boolean, restoreFocus: () => void): void;
	showAddTextDialog(owner: HTMLElement, restoreFocus: () => void, save: (title: string, content: string) => Promise<void>): void;
	showTextPreview(owner: HTMLElement, title: string, read: (signal: AbortSignal) => Promise<string>, isCurrent: (reader?: IReader) => boolean, restoreFocus: () => void): void;
	showCodeProjectDialog(owner: HTMLElement, edit?: CodeProjectEdit): Promise<void>;
	close(owner: HTMLElement): void;
}

export const IProjectDialogService = createServiceIdentifier<IProjectDialogService>('projectDialogService');

interface ActiveProjectDialog extends IDisposable {
	readonly owner: HTMLElement;
	readonly store: DisposableStore;
}

/** Owns project dialog presentation and draft lifetime for the window. */
export class ProjectDialogService extends Disposable implements IProjectDialogService {
	private readonly active = this._register(new MutableDisposable<ActiveProjectDialog>());

	constructor(
		private readonly memoryHost: { readonly readEnabled: () => Promise<boolean>; readonly records?: IMemoriesService; } | undefined,
		@IProjectsService private readonly chatProjects: IProjectsService,
		@IProjectService private readonly projects: IProjectService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IChatListCatalog private readonly catalog: IChatListCatalog,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IModelService private readonly models: IModelService,
		@ILanguageService private readonly languages: ILanguageService,
		@ICommandService private readonly commands: ICommandService,
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionFolderAuthorizationService private readonly folderAuthorization: ISessionFolderAuthorizationService,
	) {
		super();
	}

	close(owner: HTMLElement): void {
		if (this.active.value?.owner === owner) this.active.clear();
	}

	showProjectMemories(owner: HTMLElement, target: ProjectMemoryTarget, isCurrent: (reader?: IReader) => boolean, restoreFocus: () => void): void {
		if (!isCurrent()) return;
		const active = this.begin(owner);
		if (!active) return;
		const memories = this.memoryHost?.records;
		const source = 'localProjectId' in target
			? (memories ? { scope: { type: 'chatProject', projectId: target.localProjectId } as const, memories } : undefined)
			: (target.editMemory ? { open: target.editMemory } : undefined);
		const dialog = active.store.add(this.instantiation.createInstance(ProjectMemoryDialog, owner, source));
		active.store.add(autorun(reader => {
			if (!isCurrent(reader)) this.active.clear();
		}));
		void dialog.show().then(() => {
			if (this.active.value !== active) return;
			this.active.clear();
			restoreFocus();
		});
	}

	private begin(owner: HTMLElement): ActiveProjectDialog | undefined {
		if (this.active.value) return undefined;
		const store = new DisposableStore();
		const active = Object.assign(toDisposable(() => store.dispose()), { owner, store });
		this.active.value = active;
		return active;
	}

	private createMemoryButton(container: HTMLElement, readEnabled: () => Promise<boolean>, store: DisposableStore): Button {
		const openSettings = localize('projects.openMemorySettings', 'Open memory settings');
		let readVersion = 0;
		const updateMemory = async () => {
			const version = ++readVersion;
			const enabled = await readEnabled().catch(() => undefined);
			if (store.isDisposed || version !== readVersion) return;
			button.label = enabled === undefined ? openSettings : enabled
				? localize('projects.memoryOn', 'Memory is on')
				: localize('projects.memoryOff', 'Memory is off');
		};
		const button = store.add(new Button(container, {
			label: openSettings,
			icon: Lxicon.brain,
			size: 'small',
			onClick: () => {
				void this.commands.executeCommand(OPEN_MEMORIES_COMMAND_ID)
					.then(updateMemory, error => this.notifications.error(toErrorMessage(error)));
			},
		}));
		button.domNode.classList.add('ash-project-memory');
		button.domNode.setAttribute('aria-description', openSettings);
		store.add(new Hover({
			target: button.domNode,
			content: openSettings,
			contextViewProvider: store.add(new ContextView(container)),
		}));
		void updateMemory();
		return button;
	}

	private async saveProjectAppearance(project: Project, appearance: ProjectAppearance, scope: ProjectScope): Promise<Project> {
		for (const field of ['icon', 'color'] as const) {
			if (project[field] === appearance[field]) continue;
			await this.projects.setAppearance(project, field, appearance[field]);
			project = await this.projects.read(project.id, scope);
		}
		return project;
	}

	showTextPreview(container: HTMLElement, title: string, read: (signal: AbortSignal) => Promise<string>, isCurrent: (reader?: IReader) => boolean, restoreFocus: () => void): void {
		if (!isCurrent()) return;
		const active = this.begin(container);
		if (!active) return;
		const { store } = active;
		const controller = new AbortController();
		store.add(toDisposable(() => controller.abort()));
		store.add(autorun(reader => {
			if (!isCurrent(reader)) this.active.clear();
		}));
		const host = h(container.ownerDocument, 'div', { className: 'ash-project-text-preview-editor', properties: { hidden: true } });
		const message = h(container.ownerDocument, 'p', { attributes: { role: 'status' } }, localize('projects.loadingTextPreview', 'Loading content…'));
		const dialog = store.add(new Dialog(container, title, [], createWorkbenchDialogOptions({
			extraClasses: ['ash-project-text-preview'],
			layout: 'form',
			disableDefaultAction: true,
			closeOnBackdropClick: true,
			renderBody: body => body.append(message, host),
		})));
		void dialog.show().then(() => {
			if (this.active.value === active) {
				this.active.clear();
				restoreFocus();
			}
		});
		void read(controller.signal).then(text => {
			// A cached file read can finish after its preview has been closed.
			if (store.isDisposed || !isCurrent()) return;
			host.hidden = false;
			const model = store.add(this.models.createModel(text, this.languages.createById('markdown'), undefined, true));
			store.add(this.instantiation.createInstance(CodeEditorWidget, {
				container: host,
				model,
				presentation: 'embedded',
				ariaLabel: localize('projects.textPreviewLabel', 'Project content'),
				readOnly: true,
				domReadOnly: true,
				automaticLayout: true,
				tabFocusMode: true,
				lineNumbers: 'on',
				minimap: { enabled: false },
				folding: false,
				glyphMargin: false,
				renderLineHighlight: 'none',
				wordWrap: 'on',
				scrollBeyondLastLine: false,
				padding: { top: 4, bottom: 4 },
				contributions: [],
			}));
			message.hidden = true;
		}).catch(() => {
			if (!store.isDisposed && isCurrent()) {
				host.hidden = true;
				message.textContent = localize('projects.textPreviewFailed', 'Could not open this content.');
			}
		});
	}

	showAddTextDialog(container: HTMLElement, restoreFocus: () => void, save: (title: string, content: string) => Promise<void>): void {
		const active = this.begin(container);
		if (!active) return;
		const { store } = active;
		const document = container.ownerDocument;
		const title = h(document, 'input', {
			properties: { type: 'text', required: true, maxLength: 200, placeholder: localize('projects.textTitlePlaceholder', 'Name your content') },
		});
		const content = store.add(this.instantiation.createInstance(ProjectTextInput, container));
		const feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const form = h(document, 'form', { className: 'ash-projects-form' },
			h(document, 'label', {}, localize('projects.textTitle', 'Title'), title),
			content.element,
			feedback);
		form.id = generateUuid();
		const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
		let saving = false;
		const dialog = store.add(createProjectFormDialog(
			container, localize('projects.addTextContent', 'Add text content'), form, actions, {
			textContent: true,
			canClose: () => !saving,
			shouldConfirmDiscard: () => !!(title.value || content.value),
		},
		));
		const cancel = store.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('projects.cancel', 'Cancel'),
			presentation: 'secondary',
			onClick: () => void dialog.requestClose(),
		}));
		const submit = store.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('projects.addContent', 'Add Content'),
			presentation: 'primary',
			type: 'submit',
			enabled: false,
		}));
		submit.domNode.setAttribute('form', form.id);
		let tooLong = false;
		const updateSubmit = () => {
			const text = content.value;
			const nextTooLong = text.length > 20000;
			if (tooLong !== nextTooLong) {
				tooLong = nextTooLong;
				feedback.textContent = tooLong ? localize('projects.textTooLong', 'Keep the content to 20,000 characters or fewer.') : '';
			}
			submit.enabled = !saving && !tooLong && !!title.value.trim() && !!text.trim();
		};
		store.add(addDisposableListener(form, 'input', updateSubmit));
		store.add(content.onDidChange(updateSubmit));
		store.add(addDisposableListener(form, 'submit', async event => {
			event.preventDefault();
			if (!submit.enabled) return;
			saving = true;
			title.readOnly = true;
			content.setReadOnly(true);
			cancel.enabled = false;
			feedback.textContent = '';
			form.setAttribute('aria-busy', 'true');
			updateSubmit();
			try {
				await save(title.value.trim(), content.value);
				if (!store.isDisposed) dialog.dispose();
			} catch (error) {
				if (store.isDisposed) return;
				saving = false;
				title.readOnly = false;
				content.setReadOnly(false);
				cancel.enabled = true;
				form.removeAttribute('aria-busy');
				feedback.textContent = toErrorMessage(error);
				updateSubmit();
				submit.focus();
			}
		}));
		void dialog.show().then(() => {
			if (this.active.value === active) {
				this.active.clear();
				restoreFocus();
			}
		});
		title.focus();
	}

	showChatProjectDialog(container: HTMLElement, restoreFocus: () => void, edit?: ChatProjectEdit, creator?: CatalogProjectCreator): void {
		const active = this.begin(container);
		if (!active) return;
		const { store } = active;
		const document = container.ownerDocument;
		const previousFocus = getActiveElement(document);
		const project = edit && 'project' in edit ? edit.project : undefined;
		const conversation = edit && 'conversation' in edit ? edit.conversation : undefined;
		const appearanceEdit = edit && 'title' in edit ? edit : undefined;
		const instructionsOnly = edit && 'instructionsOnly' in edit && edit.instructionsOnly;
		const catalogAppearance = edit && 'appearance' in edit ? edit.appearance : undefined;
		const savedAppearance = catalogAppearance ?? project;
		const form = h(document, 'form', { className: 'ash-projects-form' });
		form.id = generateUuid();
		const nameLabel = h(document, 'label', {}, appearanceEdit
			? localize('projects.appearanceProject', 'Project name')
			: localize('projects.nameLabel', 'What are you working on?'));
		const name = h(document, 'input', {
			properties: {
				type: 'text',
				value: project?.name ?? conversation?.details.name ?? appearanceEdit?.title ?? '',
				readOnly: !!appearanceEdit,
				required: true,
				maxLength: 200,
				placeholder: localize('projects.namePlaceholder', 'Name your project'),
			},
		});
		name.id = generateUuid();
		nameLabel.htmlFor = name.id;
		const nameField = h(document, 'div', { className: 'ash-project-name' });
		const appearance = !instructionsOnly && (!edit || savedAppearance)
			? store.add(new ProjectAppearancePicker(container, nameField, Lxicon.projects, savedAppearance))
			: undefined;
		const appearanceChanged = () => appearance?.appearance.icon !== savedAppearance?.icon || appearance?.appearance.color !== savedAppearance?.color;
		if (!appearance) {
			const leadingIcon = h(document, 'span', { attributes: { 'aria-hidden': 'true' } });
			appendIcon(Lxicon.projects, leadingIcon);
			nameField.append(leadingIcon);
		}
		nameField.append(name);
		const nameGroup = h(document, 'div', { className: 'ash-project-form-field' },
			nameLabel, nameField);
		const instructionsLabel = localize('projects.instructions', 'Instructions');
		const instructionsTitle = h(document, 'label', {}, instructionsLabel);
		const instructionsViewport = h(document, 'div', { className: 'ash-project-text-viewport' });
		const instructionsHost = h(document, 'div', { className: 'ash-project-instructions-editor' }, instructionsViewport);
		const instructionsError = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		instructionsError.id = generateUuid();
		const instructionsField = h(document, 'div', { className: 'ash-project-form-field' },
			instructionsOnly ? undefined : instructionsTitle, instructionsHost, instructionsError);
		const instructionsModel = store.add(this.models.createModel(
			project?.description ?? conversation?.details.description ?? '',
			this.languages.createById('markdown'), undefined, true,
		));
		const instructionsValue = () => instructionsModel.getValue(EndOfLinePreference.LF);
		const instructionsTooLong = () => instructionsModel.getValueLength(EndOfLinePreference.LF) > 20000;
		const initialName = name.value;
		const initialDescription = instructionsValue();
		let materials = [...(project?.materials ?? [])];
		let base = project;
		const instructionsChanged = () => instructionsValue() !== (base?.description ?? initialDescription).replace(/\r\n?/g, '\n');
		let needsMerge = false;
		const unresolved = new Set<'name' | 'instructions'>();
		const mergeControls = store.add(new DisposableStore());
		let chosenFolder: Extract<ProjectMaterial, { kind: 'folder'; }> | undefined;
		let pickingFolder = false;
		const folderRow = h(document, 'div', { className: 'ash-projects-folder-choice' });
		const locationRow = h(document, 'div', { className: 'ash-project-location' }, folderRow);
		const feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const folder = store.add(
			new Button(folderRow, {
				...defaultButtonStyles,
				label: localize('projects.useFolder', 'Use a folder'),
				icon: Lxicon.newFolder,
				title: localize(
					'projects.useFolderTooltip',
					'Ash can work in this folder when you use the project from this computer.',
				),
				onClick: () => {
					if (pickingFolder) return;
					pickingFolder = true;
					void this.files
						.showOpenDialog({ canSelectFiles: false, canSelectFolders: true })
						.then(resources => {
							if (store.isDisposed || !resources?.[0]) {
								return;
							}
							const resource = resources[0];
							if (chosenFolder) {
								materials.splice(materials.indexOf(chosenFolder), 1);
								chosenFolder = undefined;
							}
							if (!materials.some(item => item.kind !== 'text' && item.resource.toString() === resource.toString())) {
								chosenFolder = { resource, name: basename(resource), kind: 'folder' };
								materials.push(chosenFolder);
							}
							folder.label = basename(resource);
						})
						.catch(() => {
							if (!store.isDisposed) {
								feedback.textContent = localize(
									'projects.pickFailed',
									'Could not add these materials. Try again.',
								);
							}
						})
						.finally(() => { pickingFolder = false; });
				},
			}),
		);
		const catalogCreators = edit ? [] : creator ? [creator] : this.catalog.sources.flatMap(source => {
			const available = source.snapshot.get().projectCreator;
			return available ? [available] : [];
		});
		const sourceControls = h(document, 'div', { className: 'ash-project-source-controls' });
		const readMemory = !edit && !creator ? this.memoryHost?.readEnabled : undefined;
		const initialMemoryMode = !instructionsOnly ? conversation?.details.memoryMode : undefined;
		const memoryLabel = localize('projects.memoryMode', 'Project memory');
		const memoryField = initialMemoryMode || catalogCreators.some(source => source.supportsMemoryMode)
			? h(document, 'div', { className: 'ash-project-form-field', properties: { hidden: !initialMemoryMode } }, h(document, 'span', {}, memoryLabel))
			: undefined;
		const memoryMode = (): CatalogProjectMemoryMode | undefined => {
			if (memoryField?.hidden !== false) return undefined;
			const value = memoryChoice?.value;
			return value === 'default' || value === 'projectOnly' ? value : undefined;
		};
		const memoryModeChanged = () => {
			const mode = memoryMode();
			return mode !== undefined && mode !== (initialMemoryMode ?? 'default');
		};
		if (catalogCreators.length) locationRow.append(sourceControls);
		const hasCreationDetails = catalogCreators.length > 0 || !!readMemory;
		const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
		const footer = readMemory ? h(document, 'div', { className: 'ash-project-creation-footer' }) : actions;
		const conflicts = h(document, 'div', { className: 'ash-projects-conflicts', properties: { hidden: true } });
		const intro = instructionsOnly ? h(document, 'p', { className: 'ash-project-instructions-intro' },
			localize('projects.instructionsIntro', 'Write the instructions and background for this project.')) : undefined;
		if (intro) {
			intro.id = generateUuid();
			form.append(intro, instructionsField);
		} else {
			form.append(nameGroup);
			if (!appearanceEdit) form.append(instructionsField);
			if (!conversation && !appearanceEdit) form.append(locationRow);
			if (memoryField) form.append(memoryField);
		}
		form.append(feedback, conflicts);
		let didSave = false;
		const dialog = store.add(
			createProjectFormDialog(
				container,
				instructionsOnly ? localize('projects.setInstructions', 'Set project instructions')
					: edit ? localize('projects.edit', 'Edit details')
						: localize('projects.createTitle', 'Create a project'),
				form,
				footer,
				{
					appearanceOnly: !!appearanceEdit,
					instructionsOnly,
					withCreationDetails: hasCreationDetails,
					canClose: () => !name.disabled && !pickingFolder,
					shouldConfirmDiscard: () => name.value !== (base?.name ?? initialName) ||
						instructionsChanged() ||
						!!chosenFolder || appearanceChanged() || memoryModeChanged() || unresolved.size > 0,
				},
			),
		);
		const style = getWindow(container).getComputedStyle(container);
		const fontSize = Number.parseFloat(style.fontSize);
		const instructionsEditor = appearanceEdit ? undefined : store.add(this.instantiation.createInstance(CodeEditorWidget, {
			container: instructionsViewport,
			model: instructionsModel,
			presentation: 'embedded',
			ariaLabel: instructionsLabel,
			placeholder: localize('projects.instructionsPlaceholder', 'For example, use concise explanations and include examples where helpful.'),
			fontFamily: style.fontFamily,
			fontSize,
			lineHeight: Math.round(fontSize * 1.5),
			automaticLayout: true,
			tabFocusMode: true,
			multiCursorLimit: 1,
			lineDecorationsWidth: 0,
			folding: false,
			glyphMargin: false,
			overviewRulerLanes: 0,
			wordWrap: 'on',
			scrollBeyondLastLine: false,
			padding: { top: 12, bottom: 12 },
			contributionIds: [EditorCoreCommandId.selectAll, 'editor.contrib.codeServices'],
			contributions: [{ id: PlaceholderTextContribution.ID, ctor: PlaceholderTextContribution, instantiation: EditorContributionInstantiation.Eager }],
		}));
		const instructionsInput = instructionsEditor?.controller.textArea ?? instructionsEditor?.controller.element;
		if (instructionsInput) {
			instructionsInput.id = generateUuid();
			instructionsTitle.htmlFor = instructionsInput.id;
			instructionsInput.setAttribute('aria-describedby', intro ? `${intro.id} ${instructionsError.id}` : instructionsError.id);
		}
		const setInstructionsReadOnly = (readOnly: boolean) => {
			instructionsEditor?.updateOptions({ readOnly, domReadOnly: readOnly, tabIndex: readOnly ? -1 : 0 });
		};
		const focusDraft = () => (instructionsOnly ? instructionsEditor : name)?.focus();
		// The shared dropdown and hover stay inside the dialog's top layer.
		const sourceChoice = catalogCreators.length ? store.add(new SelectBox(sourceControls, {
			options: [
				...(creator ? [] : [{ value: 'ash', label: 'Ash' }]),
				...catalogCreators.map((source, index) => ({ value: String(index), label: source.label })),
			],
			ariaLabel: localize('projects.source', 'Project source'),
			presentation: 'field',
		}, defaultSelectBoxStyles)) : undefined;
		const selectedCreator = () => creator ?? (sourceChoice ? catalogCreators[sourceChoice.selectedIndex - 1] : undefined);
		const memoryChoice = memoryField ? store.add(new SelectBox(memoryField, {
			options: projectMemoryOptions(),
			selectedValue: initialMemoryMode ?? 'default',
			ariaLabel: memoryLabel,
			presentation: 'field',
		}, defaultSelectBoxStyles)) : undefined;
		const memory = readMemory ? this.createMemoryButton(footer, readMemory, store) : undefined;
		if (readMemory) footer.append(actions);
		if (sourceChoice) {
			sourceChoice.enabled = !creator;
			const helpLabel = localize('projects.sourceHelp', 'About the project source');
			const help = store.add(new Button(sourceControls, {
				label: helpLabel,
				icon: Lxicon.question,
				iconOnly: true,
				onClick: () => sourceHover.show(true),
			}));
			const sourceHover = store.add(new Hover({
				target: help.domNode,
				content: undefined,
				contextViewProvider: store.add(new ContextView(form)),
			}));
			const updateSource = () => {
				const selected = selectedCreator();
				folderRow.hidden = !!selected;
				if (memory) memory.hidden = !!selected;
				if (memoryField) memoryField.hidden = !selected?.supportsMemoryMode;
				const hint = selected?.description ?? localize('projects.localCreationDescription', 'Saved locally in Ash.');
				help.domNode.setAttribute('aria-description', hint);
				sourceHover.update(hint);
			};
			store.add(sourceChoice.onDidSelect(updateSource));
			updateSource();
		}
		const reload = store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('projects.reloadMerge', 'Reload and merge'),
				presentation: 'secondary',
				onClick: () => {
					void reloadAndMerge();
				},
			}),
		);
		reload.domNode.hidden = true;
		store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('projects.cancel', 'Cancel'),
				presentation: 'secondary',
				onClick: () => void dialog.requestClose(),
			}),
		);
		const submit = store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: instructionsOnly ? localize('projects.saveInstructions', 'Save instructions')
					: edit ? localize('projects.save', 'Save changes')
						: localize('projects.create', 'Create'),
				presentation: 'primary',
				type: 'submit',
				enabled: !instructionsOnly && (!!appearanceEdit || !!name.value.trim()),
			}),
		);
		submit.domNode.setAttribute('form', form.id);
		const updateSubmit = () => {
			const tooLong = instructionsTooLong();
			const message = tooLong ? localize('projects.textTooLong', 'Keep the content to 20,000 characters or fewer.') : '';
			if (instructionsError.textContent !== message) {
				instructionsError.textContent = message;
				if (tooLong) instructionsInput?.setAttribute('aria-invalid', 'true');
				else instructionsInput?.removeAttribute('aria-invalid');
			}
			submit.enabled = !name.disabled && !tooLong && !needsMerge && unresolved.size === 0 &&
				(instructionsOnly ? instructionsChanged() : !!name.value.trim());
		};
		store.add(addDisposableListener(name, 'input', updateSubmit));
		store.add(instructionsModel.onDidChangeContent(updateSubmit));
		updateSubmit();
		const offerMerge = (): boolean => {
			const latest = this.chatProjects.state.get().projects.find(item => item.id === base?.id);
			if (!base || !latest || latest.revision === base.revision) {
				return false;
			}
			needsMerge = true;
			feedback.textContent = localize(
				'projects.editConflict',
				'This project changed in another window. Reload and merge to keep your draft and include the saved changes.',
			);
			reload.domNode.hidden = false;
			updateSubmit();
			reload.focus();
			return true;
		};
		const mergeField = (
			field: 'name' | 'instructions',
			previous: string,
			saved: string,
			label: string,
		): void => {
			const read = field === 'name' ? () => name.value : instructionsValue;
			const write = (value: string) => {
				if (field === 'name') name.value = value;
				else instructionsModel.setValue(value);
			};
			let draft = read();
			const value = instructionsOnly ? draft : draft.trim();
			const normalize = (text: string) => field === 'instructions' ? text.replace(/\r\n?/g, '\n') : text;
			if (value === normalize(previous) || value === normalize(saved)) {
				write(saved);
				return;
			}
			if (saved === previous) {
				return;
			}
			unresolved.add(field);
			const choiceLabel = h(document, 'label', {}, label);
			const choice = h(
				document,
				'select',
				{ attributes: { 'aria-label': label } },
				h(
					document,
					'option',
					{ properties: { value: '' } },
					localize('projects.chooseValue', 'Choose which value to keep'),
				),
				h(document, 'option', { properties: { value: 'draft' } }, localize('projects.keepDraft', 'Keep draft')),
				h(
					document,
					'option',
					{ properties: { value: 'saved' } },
					localize('projects.useSaved', 'Use saved value'),
				),
			);
			choiceLabel.append(
				h(
					document,
					'span',
					{ properties: { tabIndex: 0 } },
					localize('projects.savedValue', 'Saved value: {0}', saved),
				),
				choice,
			);
			conflicts.append(choiceLabel);
			const keepEditedDraft = () => {
				draft = read();
				choice.value = 'draft';
				unresolved.delete(field);
				updateSubmit();
			};
			mergeControls.add(field === 'name'
				? addDisposableListener(name, 'input', keepEditedDraft)
				: instructionsModel.onDidChangeContent(event => {
					// Switching the merge choice replaces the model without changing the stored draft.
					if (event.reason !== TextModelChangeReason.Reset) keepEditedDraft();
				}));
			mergeControls.add(
				addDisposableListener(choice, 'change', () => {
					if (!choice.value) {
						unresolved.add(field);
					} else {
						write(choice.value === 'saved' ? saved : draft);
						unresolved.delete(field);
					}
					updateSubmit();
				}),
			);
		};
		const reloadAndMerge = async (): Promise<void> => {
			if (!base || this.chatProjects.state.get().busy) {
				return;
			}
			reload.enabled = false;
			name.disabled = true;
			setInstructionsReadOnly(true);
			folder.enabled = false;
			await this.chatProjects.reload();
			if (store.isDisposed) {
				return;
			}
			const latest = await this.chatProjects.readProject(base.id);
			if (store.isDisposed) {
				return;
			}
			const state = this.chatProjects.state.get();
			if (state.message || latest?.id !== base.id) {
				feedback.textContent =
					state.message ?? localize('projects.loadFailed', 'Could not load projects. Try again.');
			} else {
				mergeControls.clear();
				conflicts.replaceChildren();
				unresolved.clear();
				mergeField(
					'name',
					base.name,
					latest.name,
					localize('projects.nameConflict', 'The project name changed in both versions.'),
				);
				mergeField(
					'instructions',
					base.description,
					latest.description,
					localize('projects.descriptionConflict', 'The project instructions changed in both versions.'),
				);
				// The dialog only adds a folder. Start with the latest materials so a
				// concurrent addition or removal cannot be undone by the old draft.
				materials = [...latest.materials];
				if (
					chosenFolder &&
					!materials.some(item => item.kind !== 'text' && item.resource.toString() === chosenFolder!.resource.toString())
				) {
					materials.push(chosenFolder);
				} else {
					chosenFolder = undefined;
				}
				base = latest;
				needsMerge = false;
				reload.domNode.hidden = true;
				conflicts.hidden = unresolved.size === 0;
				feedback.textContent = unresolved.size
					? localize(
						'projects.resolveConflict',
						'Your draft is preserved. Choose which value to keep for each conflict before saving.',
					)
					: localize(
						'projects.merged',
						'Saved changes and materials have been merged with your draft. Review and save the project.',
					);
			}
			reload.enabled = true;
			name.disabled = false;
			setInstructionsReadOnly(false);
			folder.enabled = true;
			updateSubmit();
			const conflict = conflicts.querySelector('select');
			if (conflict) conflict.focus();
			else focusDraft();
		};
		const id = generateUuid();
		store.add(
			addDisposableListener(form, 'submit', event => {
				event.preventDefault();
				if (appearanceEdit && appearance) {
					try {
						appearanceEdit.appearance.save(appearance.appearance);
						didSave = true;
						dialog.dispose();
					} catch (error) {
						feedback.textContent = toErrorMessage(error);
					}
					return;
				}
				const remote = selectedCreator();
				if (
					name.disabled || pickingFolder || instructionsTooLong() || (instructionsOnly ? !instructionsChanged() : !name.value.trim()) ||
					(!remote && this.chatProjects.state.get().busy) ||
					needsMerge ||
					unresolved.size ||
					offerMerge()
				) {
					return;
				}
				submit.enabled = false;
				feedback.textContent = '';
				name.disabled = true;
				setInstructionsReadOnly(true);
				folder.enabled = false;
				if (sourceChoice) sourceChoice.enabled = false;
				if (memory) memory.enabled = false;
				if (memoryChoice) memoryChoice.enabled = false;
				if (appearance) appearance.enabled = false;
				const details = instructionsOnly
					? { name: name.value, description: instructionsValue() }
					: { name: name.value.trim(), description: instructionsValue().trim(), memoryMode: memoryMode() };
				let creationWarning: string | undefined;
				const save = async (): Promise<boolean> => {
					try {
						if (conversation) {
							if (details.name !== initialName || details.description !== initialDescription || memoryModeChanged()) await conversation.save(details);
							if (catalogAppearance && appearance && appearanceChanged()) catalogAppearance.save(appearance.appearance);
							return true;
						}
						if (remote) {
							const { id, preferenceKey, warning } = await remote.create(details);
							if (preferenceKey && appearance && appearanceChanged()) {
								this.chatProjects.getCatalogProjectAppearance(preferenceKey).save(appearance.appearance);
							}
							if (!creator && !store.isDisposed) this.chatProjects.openConversationProject(id);
							creationWarning = warning;
							return true;
						}
						if (!base) return this.chatProjects.create(id, details.name, details.description, materials, appearance?.appearance);
						if ((details.name !== base.name || details.description !== base.description || chosenFolder)
							&& !await this.chatProjects.update(base, details.name, details.description, materials)) return false;
						if (appearance && appearanceChanged()) {
							base = await this.projects.read(base.id, 'chat');
							base = await this.saveProjectAppearance(base, appearance.appearance, 'chat');
						}
						return true;
					} catch (error) {
						if (!store.isDisposed) feedback.textContent = toErrorMessage(error);
						return false;
					}
				};
				const result = save();
				void result.then(saved => {
					if (store.isDisposed) {
						return;
					}
					if (saved) {
						didSave = true;
						dialog.dispose();
						if (creationWarning) this.notifications.warn(creationWarning);
					} else {
						const message = this.chatProjects.state.get().message;
						if (!conversation && !remote && message && !feedback.textContent) feedback.textContent = message;
						name.disabled = false;
						setInstructionsReadOnly(false);
						folder.enabled = true;
						if (sourceChoice) sourceChoice.enabled = !creator;
						if (memory) memory.enabled = true;
						if (memoryChoice) memoryChoice.enabled = true;
						if (appearance) appearance.enabled = true;
						updateSubmit();
						if (!offerMerge() && getActiveElement(document) === document.body) focusDraft();
					}
				});
			}),
		);
		void dialog.show().then(() => {
			if (this.active.value === active) {
				this.active.clear();
			}
			// Updating action availability can replace the toolbar trigger during a save attempt.
			if (!this.isDisposed && (didSave || !previousFocus?.isConnected)) {
				restoreFocus();
			}
		});
		if (appearanceEdit) appearance?.focus();
		else focusDraft();
	}

	async showCodeProjectDialog(container: HTMLElement, edit?: CodeProjectEdit): Promise<void> {
		const active = this.begin(container);
		if (!active) return;
		const { store } = active;
		let base: Project | undefined;
		if (edit) {
			try {
				base = await this.projects.read(edit.id, 'code');
			} catch (error) {
				if (store.isDisposed) return;
				this.active.clear();
				throw error;
			}
			if (store.isDisposed) return;
		}
		const document = container.ownerDocument;
		const nameLabel = localize('projects.nameLabel', 'What are you working on?');
		const name = h(document, 'input', {
			attributes: { 'aria-label': nameLabel },
			properties: { type: 'text', maxLength: 200, placeholder: nameLabel, value: base?.name ?? '' },
		});
		const nameField = h(document, 'div', { className: 'ash-project-name' });
		const appearance = store.add(new ProjectAppearancePicker(container, nameField, Lxicon.folder, base));
		nameField.append(name);
		const feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const form = h(document, 'form', { className: 'ash-projects-form' }, nameField);
		form.id = generateUuid();
		const id = generateUuid();
		const initialMaterials = base?.materials.filter(material => material.kind === 'folder') ?? [];
		const materials = new Map(initialMaterials.map(material => [extUriBiasedIgnorePathCase.getComparisonKey(material.resource), material]));
		const rows = store.add(new DisposableStore());
		const sourceLabel = localize('projects.code.sourceFolders', 'Source folders');
		const list = h(document, 'ul', { className: 'ash-code-project-folder-list', attributes: { 'aria-label': sourceLabel }, properties: { hidden: true } });
		const panel = h(document, 'div', { className: 'ash-code-project-folder-panel' }, list);
		const source = h(document, 'fieldset', { className: 'ash-code-project-source' },
			h(document, 'legend', sourceLabel), panel);
		form.append(source, feedback);
		let picking = false;
		let saving = false;
		let created: { readonly projectId: string; readonly workspace: SessionWorkspaceSelection; readonly navigationRevision: number; } | undefined;
		const add = store.add(new Button(panel, {
			...defaultButtonStyles,
			label: localize('projects.code.addFolder', 'Add folder'),
			icon: Lxicon.newFolder,
			presentation: 'quiet',
			onClick: async () => {
				if (picking || saving) return;
				picking = true;
				feedback.textContent = '';
				updateSubmit();
				try {
					const folders = await this.files.showOpenDialog({
						title: localize('sessions.workspace.browseTitle', 'Choose a folder'),
						canSelectFiles: false, canSelectFolders: true, canSelectMany: true, availableFileSystems: ['file'],
					});
					if (store.isDisposed) return;
					for (const resource of folders ?? []) {
						if (resource.scheme !== 'file' || resource.authority) continue;
						const folderName = basename(resource);
						materials.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), {
							kind: 'folder', resource, name: folderName.trim() ? folderName : resource.fsPath,
						});
					}
					renderFolders();
				} catch {
					if (!store.isDisposed) feedback.textContent = localize('projects.code.pickFailed', 'Could not add folders. Try again.');
				} finally {
					picking = false;
					if (!store.isDisposed) {
						updateSubmit();
						add.focus();
					}
				}
			},
		}));
		function firstFolderName(): string | undefined {
			return materials.values().next().value?.name;
		}

		function renderFolders(): void {
			rows.clear();
			list.replaceChildren();
			list.hidden = materials.size === 0;
			name.placeholder = firstFolderName() ?? nameLabel;
			for (const [key, material] of materials) {
				const path = material.resource.fsPath;
				const row = h(document, 'li');
				appendIcon(Lxicon.folder, row);
				row.append(h(document, 'span', { className: 'ash-code-project-folder-name', attributes: { title: path } }, material.name));
				list.append(row);
				const label = localize('projects.code.removeFolder', 'Remove {0}', path);
				rows.add(new Button(row, {
					...defaultButtonStyles,
					label,
					title: label,
					icon: Lxicon.close,
					iconOnly: true,
					presentation: 'quiet',
					onClick: () => {
						materials.delete(key);
						renderFolders();
						updateSubmit();
						add.focus();
					},
				}));
			}
		}
		const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
		const foldersChanged = (): boolean => {
			const savedFolders = base?.materials.filter(material => material.kind === 'folder') ?? [];
			return materials.size !== savedFolders.length ||
				savedFolders.some(material => !materials.has(extUriBiasedIgnorePathCase.getComparisonKey(material.resource)));
		};
		const dialog = store.add(createProjectFormDialog(container, edit
			? localize({ bundle: 'ash.menu', key: 'edit' }, 'Edit')
			: localize('projects.createTitle', 'Create a project'), form, actions, {
			code: true,
			canClose: () => !picking && !saving,
			shouldConfirmDiscard: () => name.value !== (base?.name ?? '') || foldersChanged() ||
				appearance.appearance.icon !== base?.icon || appearance.appearance.color !== base?.color,
		}));
		store.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('projects.cancel', 'Cancel'),
			presentation: 'secondary',
			onClick: () => void dialog.requestClose(),
		}));
		const submit = store.add(new Button(actions, {
			...defaultButtonStyles, label: edit ? localize('projects.save', 'Save changes') : localize('projects.create', 'Create'),
			presentation: 'primary', type: 'submit', enabled: false,
		}));
		submit.domNode.setAttribute('form', form.id);
		function projectName(): string | undefined {
			return name.value.trim() || firstFolderName();
		}

		function updateSubmit(): void {
			submit.enabled = !!projectName() && !picking && !saving;
		}
		store.add(addDisposableListener(name, 'input', updateSubmit));
		store.add(addDisposableListener(form, 'submit', async event => {
			event.preventDefault();
			const title = projectName();
			if (picking || saving || !title) return;
			saving = name.disabled = source.disabled = true;
			appearance.enabled = false;
			feedback.textContent = '';
			updateSubmit();
			try {
				if (base) {
					if (title !== base.name || foldersChanged()) {
						const files = base.materials.filter(material => material.kind !== 'folder');
						base = await this.projects.update(base, title, base.description, [...files, ...materials.values()]);
					}
					// Keep each committed revision so a retry only saves the remaining draft fields.
					const draft = appearance.appearance;
					for (const field of ['icon', 'color'] as const) {
						if (base[field] !== draft[field]) {
							base = await this.projects.setAppearance(base, field, draft[field]);
						}
					}
				} else {
					const navigationRevision = this.sessions.navigationRevision;
					const folders = [...materials.values()].map(material => material.resource.fsPath);
					const firstFolder = folders[0];
					let workspace: SessionWorkspaceSelection = { type: 'current' };
					if (firstFolder) {
						const controller = new AbortController();
						using cancelOnClose = store.add(toDisposable(() => controller.abort()));
						using navigation = this.sessions.onDidChange(() => {
							if (this.sessions.navigationRevision !== navigationRevision) controller.abort();
						});
						try {
							const accepted = await this.folderAuthorization.authorize(folders, controller.signal, { explicitGrant: true });
							if (!accepted || controller.signal.aborted || this.sessions.navigationRevision !== navigationRevision) return;
						} finally {
							store.delete(cancelOnClose);
						}
						workspace = { type: 'local', root: firstFolder };
					}
					const project = await this.projects.create(id, title, '', [...materials.values()], 'code', appearance.appearance);
					if (!store.isDisposed) created = { projectId: project.id, workspace, navigationRevision };
				}
				if (!store.isDisposed) dialog.dispose();
			} catch (error) {
				if (!store.isDisposed && !isCancellationError(error)) feedback.textContent = toErrorMessage(error);
			} finally {
				if (!store.isDisposed && !dialog.isDisposed) {
					saving = name.disabled = source.disabled = false;
					appearance.enabled = true;
					updateSubmit();
					if (form.isConnected) name.focus();
				}
			}
		}));
		try {
			renderFolders();
			updateSubmit();
			edit?.restoreFocus();
			const closed = dialog.show();
			name.focus();
			await closed;
		} finally {
			if (this.active.value === active) this.active.clear();
		}
		if (!created || this.isDisposed || this.active.value || this.sessions.navigationRevision !== created.navigationRevision) return;
		this.sessions.openNewSession(undefined, { providerId: LOCAL_AGENT_HOST_PROVIDER_ID, projectId: created.projectId, workspace: created.workspace });
		await this.commands.executeCommand('sessions.open.code', 'conversation');
	}
}
