import { h } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import type { Project, ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IProjectsService } from './projectsService.js';
import './media/projectMaterials.css';

/** Presents project references and delegates their storage and file access to the owning services. */
export class ProjectMaterials extends Disposable {
	constructor(
		private readonly reportError: (message: string) => void,
		@IProjectsService private readonly projects: IProjectsService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super();
	}

	/** The pane mounts the section with the rest of the details and owns this render's controls. */
	render(document: Document, project: Project, busy: boolean, content: DisposableStore): HTMLElement {
		const label = localize('projects.materials', 'Materials');
		const materials = h(document, 'section', {
			className: 'ash-projects-materials',
			attributes: { 'aria-label': label },
		});
		const materialsHeading = h(
			document,
			'div',
			{ className: 'ash-projects-section-heading' },
			h(document, 'h2', {}, label),
		);
		this.button(
			content,
			materialsHeading,
			{
				label: localize('projects.addFiles', 'Add files'),
				icon: Lxicon.add,
				enabled: !busy,
				onClick: () => {
					void this.addMaterials(project, 'file');
				},
			},
			'add-files',
		);
		materials.append(
			materialsHeading,
			h(
				document,
				'p',
				{ className: 'ash-projects-muted' },
				localize(
					'projects.materialsDescription',
					'Keep images, PDFs, documents and other files close at hand.',
				),
			),
		);
		if (!project.materials.length) {
			materials.append(
				h(
					document,
					'p',
					{ className: 'ash-projects-materials-empty' },
					localize('projects.noMaterials', 'Add your first material to this project.'),
				),
			);
		}
		const list = h(document, 'ul', { className: 'ash-projects-material-list' });
		for (const material of project.materials) {
			const row = h(document, 'li', { className: 'ash-projects-material' });
			const open = this.button(
				content,
				row,
				{
					label: material.name,
					icon: material.kind === 'folder' ? Lxicon.folders : Lxicon.file,
					onClick: () => {
						void this.openMaterial(material);
					},
				},
				material.resource.toString(),
			);
			content.add(this.hover.setupDelayedHover(open.domNode, { content: material.resource.fsPath }));
			this.button(
				content,
				row,
				{
					label: localize('projects.removeMaterial', 'Remove {0} from project', material.name),
					icon: Lxicon.close,
					iconOnly: true,
					enabled: !busy,
					onClick: () => {
						void this.projects.update(
							project,
							project.name,
							project.description,
							project.materials.filter(item => item.resource.toString() !== material.resource.toString()),
						);
					},
				},
				`remove:${material.resource}`,
			);
			list.append(row);
		}
		materials.append(list);
		this.button(
			content,
			materials,
			{
				label: localize('projects.useFolder', 'Use a folder'),
				icon: Lxicon.folders,
				enabled: !busy,
				onClick: () => {
					void this.addMaterials(project, 'folder');
				},
			},
			'add-folder',
		);
		materials.append(
			h(
				document,
				'p',
				{ className: 'ash-projects-source-note' },
				localize('projects.referenceHint', 'Files stay in their original location.'),
			),
		);
		return materials;
	}

	private button(content: DisposableStore, parent: HTMLElement, options: IButtonOptions, key: string): Button {
		const button = content.add(new Button(parent, { ...defaultButtonStyles, ...options }));
		button.domNode.dataset.projectControl = key;
		return button;
	}

	private async addMaterials(project: Project, kind: ProjectMaterial['kind']): Promise<void> {
		try {
			const resources = await this.files.showOpenDialog({
				title: localize('projects.addMaterials', 'Add project materials'),
				canSelectFiles: kind === 'file',
				canSelectFolders: kind === 'folder',
				canSelectMany: true,
			});
			if (!resources || this.isDisposed) {
				return;
			}
			const materials = [...project.materials];
			for (const resource of resources) {
				if (!materials.some(item => item.resource.toString() === resource.toString())) {
					materials.push({ resource, name: basename(resource), kind });
				}
			}
			await this.projects.update(project, project.name, project.description, materials);
		} catch {
			this.reportError(localize('projects.pickFailed', 'Could not add these materials. Try again.'));
		}
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
