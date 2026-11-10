import { h } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import type { Project, ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ProjectMaterialRow } from '../../chat/browser/chatListModel.js';
import { IProjectsService } from './projectsService.js';
import './media/projectMaterials.css';

interface ProjectMaterialsContent {
	readonly rows: readonly ProjectMaterialRow[] | undefined;
	readonly busy?: boolean;
	readonly status?: { readonly text: string; readonly retry?: () => void; };
	readonly addFiles?: (resources: readonly URI[]) => Promise<unknown>;
	readonly addFolders?: (resources: readonly URI[]) => Promise<unknown>;
}

/** Presents project references and delegates their storage and file access to the owning services. */
export class ProjectMaterials extends Disposable {
	constructor(
		private readonly reportError: (message: string) => void,
		@IProjectsService private readonly projects: IProjectsService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super();
	}

	renderLocal(document: Document, project: Project, busy: boolean, content: DisposableStore): HTMLElement {
		const add = async (resources: readonly URI[], kind: ProjectMaterial['kind']) => {
			const materials = [...project.materials];
			for (const resource of resources) {
				if (!materials.some(item => item.resource.toString() === resource.toString())) materials.push({ resource, name: basename(resource), kind });
			}
			await this.projects.update(project, project.name, project.description, materials);
		};
		return this.render(document, {
			busy, addFiles: resources => add(resources, 'file'), addFolders: resources => add(resources, 'folder'),
			rows: project.materials.map(material => ({
				id: material.resource.toString(), name: material.name, kind: material.kind, tooltip: material.resource.fsPath,
				open: () => this.openMaterial(material),
				remove: async () => {
					await this.projects.update(project, project.name, project.description,
						project.materials.filter(item => item.resource.toString() !== material.resource.toString()));
				},
			})),
		}, content);
	}

	/** The pane mounts the section with the rest of the details and owns this render's controls. */
	render(document: Document, model: ProjectMaterialsContent, content: DisposableStore): HTMLElement {
		const label = localize('projects.context', 'Context');
		const materials = h(document, 'section', { className: 'ash-projects-materials', attributes: { 'aria-label': label } });
		const heading = h(document, 'div', { className: 'ash-projects-section-heading' }, h(document, 'h2', {}, label));
		materials.append(heading);
		const { addFiles, addFolders } = model;
		if (addFiles) {
			const addLabel = localize('projects.addFiles', 'Add files');
			this.action(content, heading, 'add-files', {
				label: addLabel, title: addLabel, icon: Lxicon.add, iconOnly: true, enabled: !model.busy,
			}, () => this.pickMaterials('file', addFiles));
		}
		if (model.status) {
			materials.append(h(document, 'p', { className: 'ash-projects-muted', attributes: { role: 'status' } }, model.status.text));
			if (model.status.retry) this.action(content, materials, 'retry-details', { label: localize('projects.retry', 'Try again') }, model.status.retry);
		}
		if (model.rows?.length === 0 && !model.status) {
			const illustration = h(document, 'div', {
				className: 'ash-projects-materials-illustration', attributes: { 'aria-hidden': 'true' },
			});
			for (let index = 0; index < 3; index++) {
				const sheet = h(document, 'span', { className: 'ash-projects-materials-sheet' });
				appendIcon(Lxicon.fileText, sheet);
				illustration.append(sheet);
			}
			materials.append(h(document, 'div', { className: 'ash-projects-materials-empty' }, illustration,
				h(document, 'p', {}, addFiles
					? localize('projects.contextEmpty', 'Add PDFs, documents, or other files to reference in this project.')
					: localize('projects.noMaterialsReadOnly', 'No materials in this project.'))));
		}
		const list = h(document, 'ul', { className: 'ash-projects-material-list' });
		for (const material of model.rows ?? []) {
			const row = h(document, 'li', { className: 'ash-projects-material' });
			const { download, open, remove } = material;
			const activate = download ? () => this.saveMaterial(material.name, download) : open;
			if (activate) {
				const button = this.action(content, row, material.id, {
					label: material.name,
					ariaLabel: download ? localize('projects.downloadMaterial', 'Download {0}', material.name) : undefined,
					icon: material.kind === 'folder' ? Lxicon.folders : Lxicon.file,
				}, activate);
				content.add(this.hover.setupDelayedHover(button.domNode, { content: material.tooltip ?? material.name }));
			} else {
				row.append(h(document, 'span', { className: 'ash-projects-material-name', properties: { title: material.name } }, material.name));
			}
			if (remove) this.action(content, row, `remove:${material.id}`, {
				label: localize('projects.removeMaterial', 'Remove {0} from project', material.name),
				icon: Lxicon.close, iconOnly: true, enabled: !model.busy,
			}, async () => {
				const confirmation = await this.dialogs.confirm({
					message: localize('projects.confirmRemoveMaterial', 'Remove {0} from this project?', material.name),
					primaryButton: localize('projects.confirmRemoveMaterialAction', 'Remove'),
				});
				if (confirmation.confirmed && !this.isDisposed) await remove();
			});
			list.append(row);
		}
		if (list.childElementCount) materials.append(list);
		if (addFolders) {
			const footer = h(document, 'div', { className: 'ash-projects-materials-footer' });
			this.action(content, footer, 'add-folder', {
				label: localize('projects.useFolder', 'Use a folder'), icon: Lxicon.folders, enabled: !model.busy,
			}, () => this.pickMaterials('folder', addFolders));
			footer.append(h(document, 'p', { className: 'ash-projects-source-note' }, localize('projects.referenceHint', 'Files stay in their original location.')));
			materials.append(footer);
		}
		return materials;
	}

	private action(content: DisposableStore, parent: HTMLElement, key: string, options: IButtonOptions, run: () => unknown): Button {
		let running = false;
		const button = content.add(new Button(parent, {
			...defaultButtonStyles, ...options, onClick: () => {
				if (running) return;
				running = true;
				button.domNode.setAttribute('aria-busy', 'true');
				void Promise.resolve().then(run).catch(error => {
					if (!isCancellationError(error)) this.reportError(toErrorMessage(error));
				}).finally(() => {
					running = false;
					button.domNode.removeAttribute('aria-busy');
				});
			}
		}));
		button.domNode.dataset.projectControl = key;
		return button;
	}

	private async pickMaterials(kind: ProjectMaterial['kind'], add: (resources: readonly URI[]) => Promise<unknown>): Promise<void> {
		let resources: readonly URI[] | undefined;
		try {
			resources = await this.files.showOpenDialog({
				title: localize('projects.addMaterials', 'Add project materials'),
				canSelectFiles: kind === 'file', canSelectFolders: kind === 'folder', canSelectMany: true
			});
		} catch {
			throw new Error(localize('projects.pickFailed', 'Could not add these materials. Try again.'));
		}
		if (resources?.length && !this.isDisposed) await add(resources);
	}

	private async saveMaterial(name: string, download: (target: URI) => Promise<void>): Promise<void> {
		const target = await this.files.showSaveDialog({ defaultUri: isValidBasename(name) ? URI.file('/' + name) : undefined });
		if (target && !this.isDisposed) await download(target);
	}

	private async openMaterial(material: ProjectMaterial): Promise<void> {
		try {
			const resource =
				material.kind === 'folder'
					? (
						await this.files.showOpenDialog({
							defaultUri: material.resource,
							canSelectFiles: true,
							canSelectFolders: false,
						})
					)?.[0]
					: material.resource;
			if (resource && !this.isDisposed) {
				await this.editors.openEditor({ resource });
			}
		} catch {
			this.reportError(
				localize(
					'projects.openFailed',
					'Could not open this material. Check that the source file is still available.',
				),
			);
		}
	}
}
