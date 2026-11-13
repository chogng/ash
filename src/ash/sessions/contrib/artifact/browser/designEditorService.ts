import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { DesignDocumentController, getDesignDraftHome } from './designDocumentController.js';
import type { ArtifactEditorWidget } from './widget/artifactEditorWidget.js';
import { ArtifactWorkspaceId, artifactCanvasModes, type ArtifactCanvasKind } from '../common/artifactWorkspace.js';
import type { DesignShape } from '../common/model/designDocument.js';

export const DESIGN_LAYERS_CONTAINER_ID = 'workbench.sessions.sidebar.designLayers';
export const DESIGN_PROPERTIES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.designProperties';

/** Each mode retains its document; panels borrow the active canvas's selection and components. */
export interface IDesignEditorService {
	readonly document: DesignDocumentController;
	readonly activeEditor: IObservable<ArtifactEditorWidget | undefined>;
	readonly artifactDocuments: IObservable<ReadonlyMap<string, DesignDocumentController>>;
	getDocument(mode: ArtifactWorkspaceId): DesignDocumentController;
	loadArtifactDocuments(): Promise<void>;
	createArtifactDocument(kind: ArtifactCanvasKind, shapes: readonly DesignShape[]): DesignDocumentController;
	deleteArtifactDocument(document: DesignDocumentController): Promise<void>;
	adoptExampleDocument(document: DesignDocumentController, ownerWindow: Window): void;
	setActiveEditor(editor: ArtifactEditorWidget | undefined): void;
}

export const IDesignEditorService = createServiceIdentifier<IDesignEditorService>('designEditorService');

export class DesignEditorService extends Disposable implements IDesignEditorService {
	private readonly documents = new Map<ArtifactWorkspaceId, DesignDocumentController>();
	private readonly adoptedExamples = new Set<DesignDocumentController>();
	private readonly artifacts = observableValue<ReadonlyMap<string, DesignDocumentController>>(this, new Map());
	private readonly artifactLifetimes = this._register(new DisposableMap<string, DisposableStore>());
	public readonly artifactDocuments: IObservable<ReadonlyMap<string, DesignDocumentController>> = this.artifacts;
	private readonly draftHome: URI;
	private artifactLoading: Promise<void> | undefined;
	private get managedDocuments(): readonly DesignDocumentController[] {
		return [...this.documents.values(), ...this.adoptedExamples, ...this.artifacts.get().values()];
	}
	public get document(): DesignDocumentController { return this.getDocument(ArtifactWorkspaceId.Design); }
	private readonly active = observableValue<ArtifactEditorWidget | undefined>(this, undefined);
	public readonly activeEditor: IObservable<ArtifactEditorWidget | undefined> = this.active;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IFileService private readonly files: IFileService,
		@ILogService private readonly log: ILogService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IUserDataProfileService profiles: IUserDataProfileService,
	) {
		super();
		this.draftHome = getDesignDraftHome(profiles.currentProfile.location, workspace.getWorkspace().id);
		// Browser reload cannot wait for the final asynchronous write.
		this._register(addDisposableListener(mainWindow, 'beforeunload', (event: BeforeUnloadEvent) => {
			if (!this.lifecycle.willShutdown && [...this.artifacts.get().values()].some(document => document.isDirty || document.needsSaveRetry)) {
				event.preventDefault();
				event.returnValue = '';
			}
		}));
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.confirmDiscard(), 'unsavedCreator')));
		this._register(lifecycle.onWillShutdown(event => event.join(async () => {
			for (const document of this.managedDocuments) {
				if (document.automaticallySaves && !(await document.flushAutoSave())) { throw new Error(document.saveStatus); }
			}
		}, 'Creator automatic save', () => this.managedDocuments.every(document => !document.automaticallySaves || (!document.isDirty && !document.needsSaveRetry && !document.isRestoring)))));
	}
	public loadArtifactDocuments(): Promise<void> {
		return this.artifactLoading ??= this.restoreArtifactDocuments().catch(error => {
			this.artifactLoading = undefined;
			this.log.error('creator', 'Failed to load canvas artifacts', error);
		});
	}

	private async restoreArtifactDocuments(): Promise<void> {
		for (const kind of Object.keys(artifactCanvasModes) as ArtifactCanvasKind[]) {
			await this.restoreArtifactKind(kind);
		}
	}

	private async restoreArtifactKind(kind: ArtifactCanvasKind): Promise<void> {
		const entries = await this.files.readDirectory(this.draftHome.joinPathSegment(kind)).catch(error => {
			if (error instanceof FileNotFoundError) { return []; }
			throw error;
		});
		for (const entry of entries) {
			if (this.isDisposed) { return; }
			const id = entry.name.slice(0, -'.ash-design'.length);
			if (entry.kind !== FileKind.Directory || !entry.name.endsWith('.ash-design') || !isUuid(id) || this.artifacts.get().has(id)) { continue; }
			const document = this.instantiation.createInstance(DesignDocumentController, { kind, id, resource: entry.resource });
			await document.ready;
			if (this.isDisposed || document.needsSaveRetry || this.artifacts.get().has(id)) {
				if (document.needsSaveRetry) { this.log.warn('creator', 'Failed to restore canvas artifact', entry.resource.toString()); }
				document.dispose();
				continue;
			}
			this.addArtifactDocument(id, document);
		}
	}

	public createArtifactDocument(kind: ArtifactCanvasKind, shapes: readonly DesignShape[]): DesignDocumentController {
		const id = generateUuid();
		const resource = this.draftHome.joinPathSegment(kind).joinPathSegment(`${id}.ash-design`);
		const document = this.instantiation.createInstance(DesignDocumentController, { kind, id, resource, shapes });
		this.addArtifactDocument(id, document);
		return document;
	}

	private addArtifactDocument(id: string, document: DesignDocumentController): void {
		const lifetime = this.artifactLifetimes.set(id, new DisposableStore());
		let title = document.name;
		const updateTitle = () => {
			if (document.name === title) { return; }
			title = document.name;
			this.artifacts.set(new Map(this.artifacts.get()), undefined);
		};
		lifetime.add(document.onDidChangeLabel(updateTitle));
		lifetime.add(document.onDidChangeContent(updateTitle));
		lifetime.add(this.workingCopies.register(document));
		lifetime.add(document);
		this.artifacts.set(new Map(this.artifacts.get()).set(id, document));
	}

	public async deleteArtifactDocument(document: DesignDocumentController): Promise<void> {
		const id = document.model.value.documentId;
		if (this.artifacts.get().get(id) !== document) return;
		await document.deleteManagedArtifact();
		const remaining = new Map(this.artifacts.get());
		remaining.delete(id);
		this.artifacts.set(remaining, undefined);
		this.artifactLifetimes.deleteAndDispose(id);
	}
	public getDocument(mode: ArtifactWorkspaceId): DesignDocumentController {
		let document = this.documents.get(mode);
		if (!document) {
			document = this._register(this.instantiation.createInstance(DesignDocumentController, mode));
			this._register(this.workingCopies.register(document));
			this.documents.set(mode, document);
		}
		return document;
	}
	public adoptExampleDocument(document: DesignDocumentController, ownerWindow: Window): void {
		this.adoptedExamples.add(this._register(document));
		this._register(this.workingCopies.register(document));
		// Browser navigation cannot wait for an asynchronous file write.
		this._register(addDisposableListener(ownerWindow, 'beforeunload', (event: BeforeUnloadEvent) => {
			if (!this.lifecycle.willShutdown && (document.isDirty || document.needsSaveRetry)) {
				event.preventDefault();
				event.returnValue = '';
			}
		}));
	}
	private async confirmDiscard(): Promise<boolean> {
		for (const document of this.managedDocuments) {
			if (await document.confirmDiscard()) { return true; }
		}
		return false;
	}
	public setActiveEditor(editor: ArtifactEditorWidget | undefined): void { this.active.set(editor); }
	protected override disposeCore(): void { this.active.set(undefined); super.disposeCore(); }
}
