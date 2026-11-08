import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { Project, ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import type { ConversationProjectEditor } from '../../chat/browser/chatListModel.js';
import { IProjectsService } from './projectsService.js';
import './media/projectDialog.css';

/** Owns the project form, its draft and conflict resolution for one open dialog. */
export class ProjectDialog extends Disposable {
	private readonly active = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly container: HTMLElement,
		private readonly restoreFocus: () => void,
		@IProjectsService private readonly projects: IProjectsService,
		@IFileDialogService private readonly files: IFileDialogService,
	) {
		super();
	}

	close(): void {
		this.active.clear();
	}

	show(project?: Project, conversation?: ConversationProjectEditor): void {
		if (this.active.value) {
			return;
		}
		const store = new DisposableStore();
		this.active.value = store;
		const document = this.container.ownerDocument;
		const previousFocus = getActiveElement(document);
		const form = h(document, 'form', { className: 'ash-projects-form' });
		form.id = generateUuid();
		const nameLabel = h(document, 'label', {}, localize('projects.nameLabel', 'What are you working on?'));
		const name = h(document, 'input', {
			properties: {
				type: 'text',
				value: project?.name ?? conversation?.details.name ?? '',
				required: true,
				maxLength: 200,
				placeholder: localize('projects.namePlaceholder', 'Name your project'),
			},
		});
		nameLabel.append(name);
		const descriptionLabel = h(
			document,
			'label',
			{},
			localize('projects.descriptionLabel', 'What are you trying to achieve?'),
		);
		const description = h(document, 'textarea', {
			properties: {
				value: project?.description ?? conversation?.details.description ?? '',
				maxLength: 20000,
				placeholder: localize('projects.descriptionPlaceholder', 'Describe your project, goals, subject, etc…'),
			},
		});
		descriptionLabel.append(description);
		const initialName = name.value;
		const initialDescription = description.value;
		let materials = [...(project?.materials ?? [])];
		let base = project;
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
		form.append(nameLabel, descriptionLabel);
		if (!conversation) form.append(folderRow);
		form.append(feedback, conflicts);
		let didSave = false;
		const dialog = store.add(
			new Dialog(
				this.container,
				project || conversation
					? localize('projects.edit', 'Edit details')
					: localize('projects.createTitle', 'Create a project'),
				[],
				createWorkbenchDialogOptions({
					extraClasses: ['ash-projects-dialog'],
					layout: 'form',
					modal: false,
					closeOnBackdropClick: true,
					disableDefaultAction: true,
					canClose: () => !name.disabled && !pickingFolder,
					shouldConfirmDiscard: () => name.value !== (base?.name ?? initialName) ||
						description.value !== (base?.description ?? initialDescription) ||
						!!chosenFolder || unresolved.size > 0,
					renderBody: body => body.append(form),
					renderFooter: footer => footer.append(actions),
				}),
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
				label: project || conversation
					? localize('projects.save', 'Save changes')
					: localize('projects.create', 'Create'),
				presentation: 'primary',
				type: 'submit',
				enabled: !!name.value.trim(),
			}),
		);
		submit.domNode.setAttribute('form', form.id);
		const updateSubmit = () => {
			submit.enabled = !!name.value.trim() && !needsMerge && unresolved.size === 0;
		};
		store.add(addDisposableListener(name, 'input', updateSubmit));
		const offerMerge = (): boolean => {
			const latest = this.projects.state.get().projects.find(item => item.id === base?.id);
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
			if (draft.trim() === previous || draft.trim() === saved) {
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
			if (!base || this.projects.state.get().busy) {
				return;
			}
			reload.enabled = false;
			name.disabled = true;
			description.disabled = true;
			folder.enabled = false;
			await this.projects.reload();
			if (store.isDisposed) {
				return;
			}
			const latest = await this.projects.readProject(base.id);
			if (store.isDisposed) {
				return;
			}
			const state = this.projects.state.get();
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
					localize('projects.descriptionConflict', 'The project goals changed in both versions.'),
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
			(conflicts.querySelector('select') ?? name).focus();
		};
		const id = generateUuid();
		store.add(
			addDisposableListener(form, 'submit', event => {
				event.preventDefault();
				if (
					name.disabled || pickingFolder || !name.value.trim() ||
					this.projects.state.get().busy ||
					needsMerge ||
					unresolved.size ||
					offerMerge()
				) {
					return;
				}
				submit.enabled = false;
				name.disabled = true;
				description.disabled = true;
				folder.enabled = false;
				const details = { name: name.value.trim(), description: description.value.trim() };
				const result = conversation
					? conversation.save(details).then(() => true, error => {
						if (!store.isDisposed) feedback.textContent = toErrorMessage(error);
						return false;
					})
					: base ? this.projects.update(base, details.name, details.description, materials)
						: this.projects.create(id, details.name, details.description, materials);
				void result.then(saved => {
					if (store.isDisposed) {
						return;
					}
					if (saved) {
						didSave = true;
						dialog.dispose();
					} else {
						if (!conversation) feedback.textContent = this.projects.state.get().message ?? '';
						name.disabled = false;
						description.disabled = false;
						folder.enabled = true;
						updateSubmit();
						if (!offerMerge() && getActiveElement(document) === document.body) name.focus();
					}
				});
			}),
		);
		void dialog.show().then(() => {
			if (this.active.value === store) {
				this.active.clear();
			}
			// Updating action availability can replace the toolbar trigger during a save attempt.
			if (!this.isDisposed && (didSave || !previousFocus?.isConnected)) {
				this.restoreFocus();
			}
		});
		name.focus();
	}
}
