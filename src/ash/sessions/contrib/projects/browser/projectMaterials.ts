import { containsDragType, DataTransfers } from '../../../../base/browser/dnd.js';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { createObjectUrl, pickFiles } from '../../../../base/browser/fileAccess.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { Badge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import type { IAction } from '../../../../base/common/actions.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, type DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { LRUCache } from '../../../../base/common/map.js';
import { autorun, observableFromEvent, observableValue, type IReader, type ISettableObservable } from '../../../../base/common/observable.js';
import { extname } from '../../../../base/common/path.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { ByteSize, FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { projectMaterialFilesLocation, projectMaterialFilesRoot, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';
import type { Project, ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ChatInputAttachMenu } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputAttachMenu.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import type { CatalogProjectDetails, ProjectMaterialRow } from '../../chat/browser/chatListModel.js';
import { IProjectDialogService } from './projectDialogService.js';
import { ProjectMaterialFiles } from './projectMaterialFiles.js';
import { IProjectsService } from './projectsService.js';
import './media/projectMaterials.css';

interface ProjectMaterialPresentation extends ProjectMaterialRow {
	readonly readText?: (signal: AbortSignal) => Promise<string>;
	readonly previewText?: string;
	readonly resolveFile?: () => Promise<URI>;
	readonly selectedFile?: File;
}

interface ProjectMaterialsContent {
	readonly rows: readonly ProjectMaterialPresentation[] | undefined;
	readonly busy?: boolean;
	readonly status?: { readonly text: string; readonly retry?: () => void; };
	readonly pickFiles?: () => Promise<void>;
	readonly pickFolders?: () => Promise<void>;
	readonly addText?: (id: string, title: string, content: string) => Promise<void>;
	readonly dropFiles?: (transfer: DataTransfer) => Promise<void>;
	readonly removeFiles?: (ids: ReadonlySet<string>) => Promise<void>;
	readonly isCurrent: (reader?: IReader) => boolean;
}

type CatalogMaterialUpload = NonNullable<CatalogProjectDetails['upload']>;

const thumbnailFileLimit = 8 * 1024 * 1024;
const textThumbnailLength = 512;
const previewCopyLimit = 64 * 1024 * 1024;

function isPreviewableFile(name: string): boolean {
	return extname(name).toLowerCase() === '.pdf' || getMediaOrTextMime(name)?.startsWith('image/') === true;
}

function materialId(material: ProjectMaterial): string {
	return material.kind === 'text' ? `text:${material.id}` : material.resource.toString();
}

/** Presents project references and delegates their storage and file access to the owning services. */
export class ProjectMaterials extends Disposable {
	readonly fileRoot;
	private readonly localFiles = this._register(new MutableDisposable<ProjectMaterialFiles>());
	// A native selection can preview its File without granting the referenced directory to the agent.
	private readonly selectedFiles = new LRUCache<string, File>(64);
	private fileScope: string | undefined;
	private readonly pendingAdds = new Set<string>();
	private selection: { readonly key: string; readonly ids: ISettableObservable<ReadonlySet<string>>; } | undefined;
	private readonly removingFiles = observableValue<ReadonlySet<string>>(this, new Set());

	constructor(
		private readonly owner: HTMLElement,
		private readonly reportError: (message: string) => void,
		@IProjectsService private readonly projects: IProjectsService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IHoverService private readonly hover: IHoverService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService,
		@IProjectDialogService private readonly projectDialogs: IProjectDialogService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(toDisposable(() => this.selectedFiles.clear()));
		this.fileRoot = observableFromEvent(this, listener => configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(projectMaterialFilesLocation)) listener(event);
		}), () => {
			const profile = environment.userRoamingDataHome;
			return profile && fileService.hasProvider(URI.from({ scheme: projectMaterialFilesScheme }))
				? projectMaterialFilesRoot(profile, configuration.getValue<string>(projectMaterialFilesLocation)) : undefined;
		});
	}

	setProject(key: string | undefined, root: URI | undefined): void {
		const scope = key !== undefined && root ? JSON.stringify([key, root.toString()]) : undefined;
		if (scope === this.fileScope) return;
		this.fileScope = scope;
		this.localFiles.value = key !== undefined && root ? new ProjectMaterialFiles(this.fileService, root, key) : undefined;
	}

	renderCatalog(target: HTMLElement, key: string,
		model: Omit<ProjectMaterialsContent, 'pickFiles' | 'pickFolders' | 'dropFiles' | 'addText' | 'removeFiles'> & { readonly upload?: CatalogMaterialUpload; },
		content: DisposableStore): HTMLElement {
		const localFiles = this.localFiles.value;
		const isCurrent = () => !this.isDisposed && this.localFiles.value === localFiles && model.isCurrent();
		const rows = model.rows?.map((file): ProjectMaterialPresentation => {
			if (file.open || file.kind !== 'file') return file;
			const resolveFile = localFiles ? async () => {
				if (!isCurrent()) throw new CancellationError();
				return localFiles.ensure(file, file.read);
			} : undefined;
			if (/\.md$/iu.test(file.name)) {
				const read = file.read;
				const readText = resolveFile ? async (signal: AbortSignal) => {
					const resource = await resolveFile();
					signal.throwIfAborted();
					if (!isCurrent()) throw new CancellationError();
					return new TextDecoder().decode((await this.fileService.readFileBytes(resource)).bytes);
				} : read ? async (signal: AbortSignal) => {
					if (!isCurrent()) throw new CancellationError();
					return (await read(signal)).text();
				} : undefined;
				return {
					...file,
					readText, resolveFile,
				};
			}
			return {
				...file,
				resolveFile,
				open: resolveFile ? async () => {
					if (!isCurrent()) return;
					const resource = await resolveFile();
					if (isCurrent()) await this.openFile(resource, true);
				} : undefined,
			};
		});
		const { upload } = model;
		const add = upload && (async (files: readonly File[]) => {
			if (this.isDisposed || !model.isCurrent()) return;
			const { limits } = upload;
			if (files.length > limits.count || files.some(file => file.size > limits.fileBytes)
				|| files.reduce((bytes, file) => bytes + file.size, 0) > limits.totalBytes) {
				throw new Error(upload.limitMessage);
			}
			await upload.addFiles(files.map(file => {
				if (file.type) return file;
				const type = getMediaOrTextMime(file.name);
				return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
			}));
		});
		return this.render(target, key, {
			rows, busy: model.busy, status: model.status, isCurrent: model.isCurrent,
			pickFiles: add ? async () => {
				const files = await pickFiles({
					ownerDocument: target.ownerDocument, selection: 'multiple',
					ariaLabel: localize('projects.addMaterials', 'Add project materials'),
				});
				if (files?.length) await add(files);
			} : undefined,
			dropFiles: add ? transfer => add([...transfer.files]) : undefined,
			addText: add ? (_id, title, content) => {
				const safeTitle = title.replace(/[<>:"/\\|?*]/gu, '_');
				const name = /\.md$/iu.test(safeTitle) ? safeTitle : `${safeTitle}.md`;
				return add([new File([content], name, { type: 'text/markdown' })]);
			} : undefined,
		}, content);
	}

	async syncCatalog(rows: readonly ProjectMaterialRow[]): Promise<void> {
		const localFiles = this.localFiles.value;
		if (!localFiles) return;
		const results = await Promise.allSettled(rows.map(row => localFiles.ensure(row, row.read)));
		if (this.localFiles.value === localFiles && results.some(result => result.status === 'rejected' && !isCancellationError(result.reason))) {
			this.reportError(localize('projects.localFilesSyncFailed', 'Could not save all project files. Open the project again to retry.'));
		}
	}

	renderLocal(target: HTMLElement, project: Project, busy: boolean, isCurrent: ProjectMaterialsContent['isCurrent'], content: DisposableStore): HTMLElement {
		const localFiles = this.localFiles.value;
		const previewKey = (resource: URI) => JSON.stringify([project.id, resource.toString()]);
		const removeMaterials = async (ids: ReadonlySet<string>) => {
			const { selected, busy } = this.projects.state.get();
			if (busy || !isCurrent() || selected?.id !== project.id) throw new CancellationError();
			const removed = selected.materials.filter(material => ids.has(materialId(material)));
			if (!removed.length) return;
			const saved = await this.projects.update(selected, selected.name, selected.description,
				selected.materials.filter(material => !ids.has(materialId(material))));
			if (!saved) throw new Error(this.projects.state.get().message ?? localize('projects.removeFilesFailed', 'Could not remove the selected files. Try again.'));
			for (const material of removed) {
				if (material.kind === 'file') this.selectedFiles.delete(previewKey(material.resource));
			}
		};
		const add = async (entries: readonly { resource: URI; file?: File; }[], kind: 'file' | 'folder') => {
			if (this.isDisposed || !isCurrent()) return;
			if (localFiles) {
				await Promise.all(entries.map(async ({ resource, file }) => {
					if (!file || file.size > previewCopyLimit || !isPreviewableFile(file.name)) return;
					const stat = await this.fileService.stat(resource).catch(() => undefined);
					if (stat?.kind === FileKind.File || !isCurrent()) return;
					// A picker grants access to these bytes, without authorizing the containing directory.
					await localFiles.ensure({ id: resource.toString(), name: basename(resource) }, async () => file);
				}));
			}
			const current = this.projects.state.get().selected;
			if (this.isDisposed || !isCurrent() || current?.id !== project.id) return;
			const materials = [...current.materials];
			const previews: string[] = [];
			for (const { resource, file } of entries) {
				if (materials.some(item => item.kind !== 'text' && item.resource.toString() === resource.toString())) continue;
				materials.push({ resource, name: basename(resource), kind });
				if (file) {
					const key = previewKey(resource);
					this.selectedFiles.set(key, file);
					previews.push(key);
				}
			}
			if (materials.length === current.materials.length) return;
			let saved = false;
			try {
				saved = !!await this.projects.update(current, current.name, current.description, materials);
			} finally {
				if (!saved) for (const key of previews) this.selectedFiles.delete(key);
			}
		};
		const invalid = () => new Error(localize('projects.dropLocalFilesOnly', 'Drop local files or use the menu to add a folder.'));
		const addFiles = (files: readonly File[]) => add(files.map(file => {
			const path = getPathForFile(file);
			if (!path) throw invalid();
			return { resource: URI.file(path), file };
		}), 'file');
		return this.render(target, `local:${project.id}`, {
			busy, isCurrent,
			removeFiles: removeMaterials,
			pickFiles: isWeb ? () => this.pickMaterials('file', resources => add(resources.map(resource => ({ resource })), 'file')) : async () => {
				const files = await pickFiles({
					ownerDocument: target.ownerDocument, selection: 'multiple',
					ariaLabel: localize('projects.addMaterials', 'Add project materials'),
				});
				if (files?.length) await addFiles(files);
			},
			pickFolders: () => this.pickMaterials('folder', resources => add(resources.map(resource => ({ resource })), 'folder')),
			addText: async (id, name, content) => {
				const current = this.projects.state.get().selected;
				if (current?.id !== project.id) throw new Error(localize('projects.addTextFailed', 'Could not add text content. Try again.'));
				if (current.materials.some(item => item.kind === 'text' && item.id === id)) return;
				const saved = await this.projects.update(current, current.name, current.description, [...current.materials, { kind: 'text', id, name, content }]);
				if (!saved) throw new Error(this.projects.state.get().message ?? localize('projects.addTextFailed', 'Could not add text content. Try again.'));
			},
			dropFiles: isWeb ? undefined : async transfer => {
				if ([...transfer.items].some(item => item.webkitGetAsEntry()?.isDirectory)) throw invalid();
				await addFiles([...transfer.files]);
			},
			rows: project.materials.map(material => {
				const id = materialId(material);
				const resolveFile = material.kind === 'file' ? async () => {
					if (!localFiles || !isPreviewableFile(material.name)) return material.resource;
					const stat = await this.fileService.stat(material.resource).catch(() => undefined);
					if (stat?.kind === FileKind.File) return material.resource;
					if (!isCurrent()) throw new CancellationError();
					return localFiles.ensure({ id, name: material.name }, undefined);
				} : undefined;
				return {
					id, name: material.name, kind: material.kind === 'text' ? 'file' : material.kind,
					tooltip: material.kind === 'text' ? undefined : material.resource.fsPath,
					sizeBytes: material.kind === 'text' ? new TextEncoder().encode(material.content).length : undefined,
					readText: material.kind === 'text' ? async () => material.content : undefined,
					previewText: material.kind === 'text' ? material.content.slice(0, textThumbnailLength) : undefined,
					resolveFile,
					selectedFile: material.kind === 'file' ? this.selectedFiles.get(previewKey(material.resource)) : undefined,
					open: material.kind !== 'text' ? () => this.openMaterial(material, resolveFile) : undefined,
					remove: material.kind === 'folder' ? () => removeMaterials(new Set([id])) : undefined,
				};
			}),
		}, content);
	}

	clearSelection(): void {
		this.selection = undefined;
	}

	/** The pane mounts the section with the rest of the details and owns this render's controls. */
	private render(target: HTMLElement, key: string, model: ProjectMaterialsContent, content: DisposableStore): HTMLElement {
		const document = target.ownerDocument;
		const headingId = generateUuid();
		const materials = h(document, 'section', { className: 'ash-projects-materials', attributes: { 'aria-labelledby': headingId } });
		const heading = h(document, 'div', { className: 'ash-projects-section-heading' },
			h(document, 'h2', { properties: { id: headingId } },
				h(document, 'span', { className: 'ash-projects-material-context-title' }, localize('projects.context', 'Context')),
				h(document, 'span', { className: 'ash-projects-material-files-title' }, localize('projects.projectFiles', 'Project files'))));
		const actions = h(document, 'div', { className: 'ash-projects-material-actions' });
		heading.append(actions);
		materials.append(heading);
		const { pickFiles, pickFolders, dropFiles, addText, isCurrent } = model;
		let addButton: Button | undefined;
		if (pickFiles) {
			const addLabel = localize('projects.addMaterials', 'Add project materials');
			const button = addButton = content.add(new Button(actions, {
				...defaultButtonStyles,
				label: addLabel, title: addLabel, icon: Lxicon.add, iconOnly: true, enabled: !model.busy,
			}));
			button.domNode.dataset.projectControl = 'add-materials';
			button.domNode.setAttribute('aria-haspopup', 'menu');
			button.domNode.setAttribute('aria-expanded', 'false');
			const additionalActions: IAction[] = [];
			if (addText) additionalActions.push({
				id: 'add-text',
				label: localize('projects.addTextContent', 'Add text content'),
				tooltip: '',
				icon: Lxicon.fileText,
				enabled: true,
				run: () => {
					const id = generateUuid();
					this.projectDialogs.showAddTextDialog(this.owner, () => {
						if (isCurrent()) this.owner.querySelector<HTMLElement>('[data-project-control="add-materials"]')?.focus();
					}, async (title, text) => {
						if (!await this.performAdd(key, isCurrent, () => addText(id, title, text))) {
							throw new Error(localize('projects.addTextFailed', 'Could not add text content. Try again.'));
						}
					});
				},
			});
			if (pickFolders) additionalActions.push({
				id: 'add-folder',
				label: localize('projects.useFolder', 'Use a folder'),
				tooltip: '',
				icon: Lxicon.folders,
				enabled: true,
				run: () => this.runAdd(key, isCurrent, pickFolders),
			});
			const menu = content.add(this.instantiation.createInstance(ChatInputAttachMenu, {
				anchor: button.domNode,
				onUploadFiles: () => void this.runAdd(key, isCurrent, pickFiles),
				showUploadKeybinding: false,
				host: { additionalActions },
			}));
			content.add(button.onDidClick(() => menu.show()));
		}
		const selectable = (model.rows ?? []).filter(row => row.kind === 'file' && (model.removeFiles || row.remove));
		if (this.selection?.key !== key) {
			this.selection = { key, ids: observableValue<ReadonlySet<string>>(this, new Set()) };
		}
		const selection = this.selection.ids;
		const previous = selection.get();
		const ids = new Set(selectable.filter(row => previous.has(row.id)).map(row => row.id));
		if (ids.size !== previous.size) selection.set(ids, undefined);
		if (selectable.length || this.removingFiles.get().has(key)) {
			const removeButton = this.action(content, actions, 'remove-selected-files', { label: '', icon: Lxicon.trash }, async () => {
				const ids = selection.get();
				if (!ids.size || this.removingFiles.get().has(key) || model.busy || !isCurrent()) return;
				const rows = selectable.filter(row => ids.has(row.id));
				const confirmation = await this.dialogs.confirm({
					message: rows.length === 1
						? localize('projects.confirmRemoveMaterial', 'Remove {0} from this project?', rows[0].name)
						: localize('projects.confirmRemoveFiles', 'Remove {0} files from this project?', rows.length),
					primaryButton: localize('projects.confirmRemoveMaterialAction', 'Remove'),
					destructive: true,
				});
				if (!confirmation.confirmed || this.isDisposed || !isCurrent() || this.selection?.ids !== selection
					|| this.removingFiles.get().has(key)) return;
				const currentIds = new Set(rows.filter(row => selection.get().has(row.id)).map(row => row.id));
				if (!currentIds.size) return;
				this.removingFiles.set(new Set(this.removingFiles.get()).add(key), undefined);
				try {
					if (model.removeFiles) {
						await model.removeFiles(currentIds);
					} else {
						// Providers can commit individual removals even when another one fails.
						const results = await Promise.allSettled(rows.filter(row => currentIds.has(row.id)).map(row => row.remove!()));
						const failure = results.find(result => result.status === 'rejected');
						if (failure) throw failure.reason;
					}
					if (isCurrent()) status(localize('projects.filesRemoved', 'Selected files removed from the project.'));
				} catch (error) {
					if (isCurrent() && !isCancellationError(error)) this.reportError(toErrorMessage(error));
				} finally {
					const pending = new Set(this.removingFiles.get());
					pending.delete(key);
					this.removingFiles.set(pending, undefined);
				}
			});
			actions.prepend(removeButton.domNode);
			content.add(autorun(reader => {
				const ids = selection.read(reader);
				const removing = this.removingFiles.read(reader).has(key);
				removeButton.label = removing ? localize('projects.removingFiles', 'Removing files…')
					: localize('projects.removeSelectedFiles', 'Remove selected ({0})', ids.size);
				if (!ids.size && !removing && removeButton.hasFocus()) addButton?.focus();
				removeButton.domNode.hidden = !ids.size && !removing;
				removeButton.enabled = !model.busy || removing;
				if (removing) removeButton.domNode.setAttribute('aria-busy', 'true');
				else removeButton.domNode.removeAttribute('aria-busy');
			}));
		}
		if (dropFiles && !model.busy) {
			this.installDropTarget(target, content, transfer => this.runAdd(key, isCurrent, () => dropFiles(transfer)));
		}
		if (model.status) {
			materials.append(h(document, 'p', { className: 'ash-projects-muted', attributes: { role: 'status' } }, model.status.text));
			if (model.status.retry) this.action(content, materials, 'retry-details', { label: localize('projects.retry', 'Try again') }, model.status.retry);
		}
		if (model.rows?.length === 0) {
			const illustration = h(document, 'div', {
				className: 'ash-projects-materials-illustration', attributes: { 'aria-hidden': 'true' },
			});
			for (let index = 0; index < 3; index++) {
				const sheet = h(document, 'span', { className: 'ash-projects-materials-sheet' });
				appendIcon(Lxicon.fileText, sheet);
				illustration.append(sheet);
			}
			materials.append(h(document, 'div', { className: 'ash-projects-materials-empty' }, illustration,
				h(document, 'p', {}, pickFiles
					? localize('projects.contextEmpty', 'Add PDFs, documents, or other files to reference in this project.')
					: localize('projects.noMaterialsReadOnly', 'No materials in this project.'))));
		}
		const list = h(document, 'ul', { className: 'ash-projects-material-list' });
		const previews = new CancellationTokenSource();
		content.add(toDisposable(() => previews.dispose(true)));
		for (const material of model.rows ?? []) {
			const row = h(document, 'li', { className: 'ash-projects-material' });
			const { open, remove } = material;
			const isFile = material.kind === 'file';
			row.classList.toggle('ash-projects-material-card', isFile);
			if (isFile) {
				this.renderFileCard(row, material, isCurrent, content, previews.token);
				if (model.removeFiles || remove) {
					const checkbox = content.add(new Checkbox(row, {
						...defaultCheckboxStyles,
						ariaLabel: localize('projects.selectFile', 'Select {0}', material.name),
						onChange: checked => {
							const ids = new Set(selection.get());
							if (checked) ids.add(material.id);
							else ids.delete(material.id);
							selection.set(ids, undefined);
						},
					}));
					checkbox.element.classList.add('ash-projects-material-card-select');
					checkbox.input.dataset.projectControl = `select:${material.id}`;
					content.add(autorun(reader => {
						checkbox.checked = selection.read(reader).has(material.id);
						checkbox.enabled = !model.busy && !this.removingFiles.read(reader).has(key);
					}));
				}
			} else if (open) {
				const button = this.action(content, row, material.id, {
					label: material.name,
					icon: Lxicon.folders,
				}, open);
				content.add(this.hover.setupDelayedHover(button.domNode, { content: material.tooltip ?? material.name }));
			} else {
				row.append(h(document, 'span', { className: 'ash-projects-material-name', properties: { title: material.name } }, material.name));
			}
			if (!isFile && remove) {
				this.action(content, row, `remove:${material.id}`, {
					label: localize('projects.removeMaterial', 'Remove {0} from project', material.name),
					icon: Lxicon.close, iconOnly: true, enabled: !model.busy,
				}, async () => {
					const confirmation = await this.dialogs.confirm({
						message: localize('projects.confirmRemoveMaterial', 'Remove {0} from this project?', material.name),
						primaryButton: localize('projects.confirmRemoveMaterialAction', 'Remove'),
					});
					if (confirmation.confirmed && !this.isDisposed) await remove();
				});
			}
			list.append(row);
		}
		if (list.childElementCount) materials.append(list);
		return materials;
	}

	private renderFileCard(row: HTMLElement, material: ProjectMaterialPresentation, isCurrent: ProjectMaterialsContent['isCurrent'],
		content: DisposableStore, token: CancellationToken): void {
		const document = row.ownerDocument;
		const { name, readText, open, resolveFile, previewText, selectedFile } = material;
		const sizeBytes = material.sizeBytes ?? selectedFile?.size;
		const run = readText ? () => {
			this.projectDialogs.showTextPreview(this.owner, name, readText, isCurrent, () => {
				if (!isCurrent()) return;
				const controls = this.owner.querySelectorAll<HTMLButtonElement>('[data-project-control]');
				Array.from(controls).find(control => control.dataset.projectControl === material.id)?.focus();
			});
		} : open;
		const card = run
			? this.action(content, row, material.id, { label: '', ariaLabel: name, title: material.tooltip ?? name }, run).domNode
			: row.appendChild(h(document, 'div', { properties: { title: name } }));
		card.classList.add('ash-projects-material-card-open');
		if (readText || resolveFile && isPreviewableFile(name)) card.setAttribute('aria-haspopup', 'dialog');
		const mime = getMediaOrTextMime(name);
		const isImage = mime?.startsWith('image/') === true;
		const isText = readText !== undefined || mime?.startsWith('text/') === true || mime === 'application/json' || mime === 'application/xml';
		const extension = extname(name).slice(1).toUpperCase();
		const format = previewText !== undefined ? localize('projects.textBadge', 'TEXT')
			: extension || localize('projects.fileBadge', 'FILE');
		const size = h(document, 'span', { className: 'ash-file-card-size', properties: { id: generateUuid() } },
			sizeBytes === undefined ? localize('projects.fileSizeUnavailable', 'Size unavailable') : ByteSize.formatSize(sizeBytes));
		const preview = h(document, 'span', { className: 'ash-file-card-preview', attributes: { 'aria-hidden': 'true' } });
		const tag = h(document, 'span', { className: 'ash-file-card-format', properties: { id: generateUuid() } });
		content.add(new Badge(tag, format, { presentation: 'outlined' }));
		card.append(h(document, 'span', { className: 'ash-file-card-name' }, name), size, preview, tag);
		if (run) card.setAttribute('aria-describedby', `${size.id} ${tag.id}`);
		if (previewText) {
			preview.append(h(document, 'span', { className: 'ash-projects-material-card-excerpt' }, previewText));
		}
		if (!resolveFile || sizeBytes !== undefined && !isImage && !isText) return;
		const load = selectedFile
			? this.paintFileCardPreview(selectedFile, preview, mime, isText, token, content)
			: this.loadFileCardPreview(resolveFile, preview, sizeBytes === undefined ? size : undefined, mime, isText, token, content);
		void load.catch(() => {
			// The title and format still identify a file when its preview is unavailable.
		});
	}

	private async loadFileCardPreview(resolveFile: () => Promise<URI>, preview: HTMLElement, size: HTMLElement | undefined,
		mime: string | undefined, isText: boolean, token: CancellationToken, content: DisposableStore): Promise<void> {
		const resource = await resolveFile();
		if (token.isCancellationRequested) return;
		const stat = await this.fileService.stat(resource);
		if (token.isCancellationRequested || stat.kind !== FileKind.File) return;
		if (size) size.textContent = ByteSize.formatSize(stat.sizeBytes);
		const isImage = mime?.startsWith('image/') === true;
		if ((!isImage && !isText) || stat.sizeBytes === 0 || stat.sizeBytes > thumbnailFileLimit) return;
		const file = await this.fileService.readFileStream(resource, {
			limits: { size: thumbnailFileLimit },
			...(isText ? { length: textThumbnailLength } : {}),
		}, token);
		const bytes = new Uint8Array((await streamToBuffer(file.value)).buffer);
		await this.paintFileCardPreview(new Blob([bytes]), preview, mime, isText, token, content);
	}

	private async paintFileCardPreview(file: Blob, preview: HTMLElement, mime: string | undefined, isText: boolean,
		token: CancellationToken, content: DisposableStore): Promise<void> {
		if (token.isCancellationRequested || file.size === 0 || file.size > thumbnailFileLimit) return;
		const document = preview.ownerDocument;
		if (isText) {
			const excerpt = (await file.slice(0, textThumbnailLength).text()).trim();
			if (!token.isCancellationRequested && excerpt && !excerpt.includes('\0')) {
				preview.replaceChildren(h(document, 'span', { className: 'ash-projects-material-card-excerpt' }, excerpt));
			}
		} else {
			const { url, registration } = createObjectUrl(getWindow(document), file.slice(0, file.size, mime));
			content.add(registration);
			const image = h(document, 'img', { properties: { alt: '', src: url.href, decoding: 'async' } });
			try {
				await image.decode();
				if (!token.isCancellationRequested) preview.replaceChildren(image);
			} catch {
				if (content.delete(registration)) registration.dispose();
			}
		}
	}

	private installDropTarget(target: HTMLElement, content: DisposableStore, add: (transfer: DataTransfer) => Promise<void>): void {
		const document = target.ownerDocument;
		const icons = h(document, 'div', { className: 'ash-projects-drop-icons' });
		for (const icon of [Lxicon.image, Lxicon.file, Lxicon.table]) appendIcon(icon, icons);
		const overlay = h(document, 'div', {
			className: 'ash-projects-drop-overlay', properties: { hidden: true }, attributes: { 'aria-hidden': 'true' },
		}, icons, h(document, 'span', {}, localize('projects.dropFiles', 'Drop files here to add to project context')));
		target.append(overlay);
		content.add(addDisposableListener(target, 'dragover', event => {
			if (!event.dataTransfer || !containsDragType(event, DataTransfers.FILES)) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = 'copy';
			overlay.hidden = false;
		}));
		content.add(addDisposableListener(target, 'dragleave', event => {
			if (!target.contains(event.relatedTarget as Node | null)) overlay.hidden = true;
		}));
		content.add(addDisposableListener(document, 'dragend', () => { overlay.hidden = true; }, true));
		content.add(addDisposableListener(target, 'drop', event => {
			overlay.hidden = true;
			const transfer = event.dataTransfer;
			if (!transfer?.files.length) return;
			event.preventDefault();
			event.stopPropagation();
			void add(transfer);
		}));
	}

	private async runAdd(key: string, isCurrent: () => boolean, run: () => Promise<unknown>): Promise<void> {
		try {
			await this.performAdd(key, isCurrent, run);
		} catch (error) {
			if (!this.isDisposed && isCurrent() && !isCancellationError(error)) this.reportError(toErrorMessage(error));
		}
	}

	private async performAdd(key: string, isCurrent: () => boolean, run: () => Promise<unknown>): Promise<boolean> {
		if (this.isDisposed || !isCurrent() || this.pendingAdds.has(key)) return false;
		this.pendingAdds.add(key);
		try {
			await run();
			return true;
		} finally {
			this.pendingAdds.delete(key);
		}
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

	private async pickMaterials(kind: 'file' | 'folder', add: (resources: readonly URI[]) => Promise<unknown>): Promise<void> {
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

	private async openMaterial(material: Exclude<ProjectMaterial, { kind: 'text'; }>, resolveFile?: () => Promise<URI>): Promise<void> {
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
					: await resolveFile?.() ?? material.resource;
			if (resource && !this.isDisposed) {
				await this.openFile(resource, resource.scheme === projectMaterialFilesScheme);
			}
		} catch (error) {
			if (isCancellationError(error)) return;
			this.reportError(
				localize(
					'projects.openFailed',
					'Could not open this material. Check that the source file is still available.',
				),
			);
		}
	}

	private openFile(resource: URI, readOnly: boolean): Promise<void> {
		if (isPreviewableFile(resource.path)) {
			return this.editors.openEditor({ resource, readOnly: true, showBreadcrumbs: false }, {}, 'modalGroup');
		}
		return this.editors.openEditor({ resource, ...(readOnly && { readOnly, showBreadcrumbs: false }) });
	}
}
