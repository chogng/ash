import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IProjectService, type Project, type ProjectAppearance, type ProjectMaterial, type ProjectScope } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import type { ConversationProjectEditor } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ProjectAppearancePicker } from './projectAppearancePicker.js';
import { IProjectsService, type CatalogProjectAppearance } from './projectsService.js';
import './media/projectForm.css';

function createProjectFormDialog(
	container: HTMLElement,
	title: string,
	form: HTMLFormElement,
	actions: HTMLElement,
	options: { canClose: () => boolean; shouldConfirmDiscard: () => boolean; code?: boolean; appearanceOnly?: boolean; instructionsOnly?: boolean; },
): Dialog {
	return new Dialog(container, title, [], createWorkbenchDialogOptions({
		extraClasses: [
			'ash-projects-dialog',
			...(options.code ? ['ash-code-project-dialog'] : []),
			...(options.appearanceOnly ? ['ash-project-appearance-dialog'] : []),
			...(options.instructionsOnly ? ['ash-project-instructions-dialog'] : []),
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

export interface IProjectDialogService {
	showChatProjectDialog(owner: HTMLElement, restoreFocus: () => void, edit?: ChatProjectEdit): void;
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
		@IProjectsService private readonly chatProjects: IProjectsService,
		@IProjectService private readonly projects: IProjectService,
		@IFileDialogService private readonly files: IFileDialogService,
	) {
		super();
	}

	close(owner: HTMLElement): void {
		if (this.active.value?.owner === owner) this.active.clear();
	}

	private begin(owner: HTMLElement): ActiveProjectDialog | undefined {
		if (this.active.value) return undefined;
		const store = new DisposableStore();
		const active = Object.assign(toDisposable(() => store.dispose()), { owner, store });
		this.active.value = active;
		return active;
	}

	private async saveProjectAppearance(project: Project, appearance: ProjectAppearance, scope: ProjectScope): Promise<Project> {
		for (const field of ['icon', 'color'] as const) {
			if (project[field] === appearance[field]) continue;
			await this.projects.setAppearance(project, field, appearance[field]);
			project = await this.projects.read(project.id, scope);
		}
		return project;
	}

	showChatProjectDialog(container: HTMLElement, restoreFocus: () => void, edit?: ChatProjectEdit): void {
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
		const nameGroup = h(document, 'div', { className: 'ash-project-name-group' },
			nameLabel, nameField);
		const instructionsLabel = localize('projects.instructions', 'Instructions');
		const description = h(document, 'textarea', {
			properties: {
				value: project?.description ?? conversation?.details.description ?? '',
				maxLength: 20000,
				placeholder: localize('projects.instructionsPlaceholder', 'For example, use concise explanations and include examples where helpful.'),
			},
		});
		const initialName = name.value;
		const initialDescription = description.value;
		let materials = [...(project?.materials ?? [])];
		let base = project;
		const instructionsChanged = () => description.value !== (base?.description ?? initialDescription).replace(/\r\n?/g, '\n');
		let needsMerge = false;
		const unresolved = new Set<HTMLInputElement | HTMLTextAreaElement>();
		const mergeControls = store.add(new DisposableStore());
		let chosenFolder: ProjectMaterial | undefined;
		let pickingFolder = false;
		const folderRow = h(document, 'div', { className: 'ash-projects-folder-choice' });
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
							if (!materials.some(item => item.resource.toString() === resource.toString())) {
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
		const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
		const conflicts = h(document, 'div', { className: 'ash-projects-conflicts', properties: { hidden: true } });
		if (instructionsOnly) {
			const intro = h(document, 'p', { className: 'ash-project-instructions-intro' },
				localize('projects.instructionsIntro', 'Write the instructions and background for this project.'));
			intro.id = generateUuid();
			description.setAttribute('aria-label', instructionsLabel);
			description.setAttribute('aria-describedby', intro.id);
			form.append(intro, description);
		} else {
			form.append(nameGroup);
			if (!appearanceEdit) form.append(h(document, 'label', {}, instructionsLabel, description));
			if (!conversation && !appearanceEdit) form.append(folderRow);
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
				actions,
				{
					appearanceOnly: !!appearanceEdit,
					instructionsOnly,
					canClose: () => !name.disabled && !pickingFolder,
					shouldConfirmDiscard: () => name.value !== (base?.name ?? initialName) ||
						instructionsChanged() ||
						!!chosenFolder || appearanceChanged() || unresolved.size > 0,
				},
			),
		);
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
			submit.enabled = !needsMerge && unresolved.size === 0 && (instructionsOnly ? instructionsChanged() : !!name.value.trim());
		};
		store.add(addDisposableListener(name, 'input', updateSubmit));
		if (instructionsOnly) store.add(addDisposableListener(description, 'input', updateSubmit));
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
			input: HTMLInputElement | HTMLTextAreaElement,
			previous: string,
			saved: string,
			label: string,
		): void => {
			let draft = input.value;
			const value = instructionsOnly ? draft : draft.trim();
			const textAreaValue = (text: string) => input === description ? text.replace(/\r\n?/g, '\n') : text;
			if (value === textAreaValue(previous) || value === textAreaValue(saved)) {
				input.value = saved;
				return;
			}
			if (saved === previous) {
				return;
			}
			unresolved.add(input);
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
			mergeControls.add(
				addDisposableListener(input, 'input', () => {
					draft = input.value;
					choice.value = 'draft';
					unresolved.delete(input);
					updateSubmit();
				}),
			);
			mergeControls.add(
				addDisposableListener(choice, 'change', () => {
					if (!choice.value) {
						unresolved.add(input);
					} else {
						input.value = choice.value === 'saved' ? saved : draft;
						unresolved.delete(input);
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
			description.disabled = true;
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
					name,
					base.name,
					latest.name,
					localize('projects.nameConflict', 'The project name changed in both versions.'),
				);
				mergeField(
					description,
					base.description,
					latest.description,
					localize('projects.descriptionConflict', 'The project instructions changed in both versions.'),
				);
				// The dialog only adds a folder. Start with the latest materials so a
				// concurrent addition or removal cannot be undone by the old draft.
				materials = [...latest.materials];
				if (
					chosenFolder &&
					!materials.some(item => item.resource.toString() === chosenFolder!.resource.toString())
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
			description.disabled = false;
			folder.enabled = true;
			updateSubmit();
			(conflicts.querySelector('select') ?? (instructionsOnly ? description : name)).focus();
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
				if (
					name.disabled || pickingFolder || (instructionsOnly ? !instructionsChanged() : !name.value.trim()) ||
					this.chatProjects.state.get().busy ||
					needsMerge ||
					unresolved.size ||
					offerMerge()
				) {
					return;
				}
				submit.enabled = false;
				feedback.textContent = '';
				name.disabled = true;
				description.disabled = true;
				folder.enabled = false;
				if (appearance) appearance.enabled = false;
				const details = instructionsOnly
					? { name: name.value, description: description.value }
					: { name: name.value.trim(), description: description.value.trim() };
				const save = async (): Promise<boolean> => {
					try {
						if (conversation) {
							if (details.name !== initialName || details.description !== initialDescription) await conversation.save(details);
							if (catalogAppearance && appearance && appearanceChanged()) catalogAppearance.save(appearance.appearance);
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
					} else {
						const message = this.chatProjects.state.get().message;
						if (!conversation && message && !feedback.textContent) feedback.textContent = message;
						name.disabled = false;
						description.disabled = false;
						folder.enabled = true;
						if (appearance) appearance.enabled = true;
						updateSubmit();
						if (!offerMerge() && getActiveElement(document) === document.body) (instructionsOnly ? description : name).focus();
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
		else (instructionsOnly ? description : name).focus();
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
						canSelectFiles: false, canSelectFolders: true, availableFileSystems: ['file'],
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
					base = await this.saveProjectAppearance(base, appearance.appearance, 'code');
				} else {
					await this.projects.create(id, title, '', [...materials.values()], 'code', appearance.appearance);
				}
				if (!store.isDisposed) dialog.dispose();
			} catch (error) {
				if (store.isDisposed) return;
				feedback.textContent = toErrorMessage(error);
				saving = name.disabled = source.disabled = false;
				appearance.enabled = true;
				updateSubmit();
				name.focus();
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
	}
}
