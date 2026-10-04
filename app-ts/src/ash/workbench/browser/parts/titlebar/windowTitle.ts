import { isWindows } from '../../../../base/common/platform.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { template } from '../../../../base/common/labels.js';
import { dirname } from '../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { ITitleProperties, ITitleVariable } from './titlebarPart.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILabelService } from '../../../../platform/label/common/labelService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IEditorGroupsContainer } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Owns the document title for one window and its window-local editor groups. */
export class WindowTitle extends Disposable {
	private readonly groupListener = this._register(new MutableDisposable<IDisposable>());
	private readonly editorLabelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly titleChanged = this._register(new Emitter<void>());
	public readonly onDidChange = this.titleChanged.event;
	private readonly variables = new Map<string, string>();
	private properties: ITitleProperties = {};

	public get value(): string {
		return this.targetWindow.document.title;
	}

	constructor(
		private readonly targetWindow: Window,
		private readonly productName: string,
		private readonly editorGroupsContainer: IEditorGroupsContainer,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@ILabelService private readonly labelService: ILabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILocalizationService private readonly localizationService: ILocalizationService,
	) {
		super();
		this._register(editorGroupsContainer.onDidChangeActiveGroup(() => this.bindActiveGroup()));
		this._register(workspaceService.onDidChangeWorkspace(() => this.updateTitle()));
		this._register(labelService.onDidChangeFormatters(() => this.updateTitle()));
		this._register(workingCopyService.onDidChangeDirty(() => this.updateTitle()));
		this._register(workingCopyService.onDidRegister(() => this.updateTitle()));
		this._register(workingCopyService.onDidUnregister(() => this.updateTitle()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.windowTitle) || event.affectsConfiguration(WorkbenchConfiguration.windowTitleSeparator)) {
				this.updateTitle();
			}
		}));
		this._register(contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(this.variables.values()))) {
				this.updateTitle();
			}
		}));
		this.bindActiveGroup();
	}

	public updateProperties(properties: ITitleProperties): void {
		this.properties = { ...this.properties, ...properties };
		this.updateTitle();
	}

	public registerVariables(variables: ITitleVariable[]): void {
		for (const variable of variables) {
			this.variables.set(variable.name, variable.contextKey);
		}
		this.updateTitle();
	}

	private bindActiveGroup(): void {
		this.groupListener.value = this.editorGroupsContainer.activeGroup.onDidChangeEditors(event => {
			if (event.kind === 'activeEditorChanged') {
				this.handleActiveEditorChange();
			}
		});
		this.handleActiveEditorChange();
	}

	private handleActiveEditorChange(): void {
		this.editorLabelListener.value = this.editorGroupsContainer.activeGroup.activeInput?.onDidChangeLabel?.(() => this.updateTitle());
		this.updateTitle();
	}

	private updateTitle(): void {
		const editor = this.editorGroupsContainer.activeGroup.activeInput;
		const workspace = this.workspaceService.getWorkspace();
		const resource = editor?.resource;
		const folder = resource ? this.workspaceService.getWorkspaceFolder(resource) : undefined;
		const activeFolder = resource ? dirname(resource) : undefined;
		const workspaceResource = workspace.configuration ?? (workspace.folders.length === 1 ? workspace.folders[0]!.uri : undefined);
		// Working copies remain owned by editor domains; the title only reads their persistence state.
		const dirty = resource && this.workingCopyService.get(resource).some(copy => copy.isDirty);
		const customValues: Record<string, string> = {};
		for (const [name, contextKey] of this.variables) {
			const value = this.contextKeyService.getValue(contextKey);
			customValues[name] = value == null ? '' : String(value);
		}
		const titleText = template(this.configurationService.getValue<string>(WorkbenchConfiguration.windowTitle), {
			activeEditorShort: editor?.label ?? (resource ? this.labelService.getUriBasenameLabel(resource) : ''),
			activeEditorMedium: resource ? this.labelService.getUriLabel(resource, { relative: true }) : '',
			activeEditorLong: resource ? this.labelService.getUriLabel(resource) : '',
			activeFolderShort: activeFolder ? this.labelService.getUriBasenameLabel(activeFolder) : '',
			activeFolderMedium: activeFolder ? this.labelService.getUriLabel(activeFolder, { relative: true }) : '',
			activeFolderLong: activeFolder ? this.labelService.getUriLabel(activeFolder) : '',
			folderName: folder?.name,
			folderPath: folder ? this.labelService.getUriLabel(folder.uri) : '',
			rootName: workspace.name ?? workspace.folders.map(folder => folder.name).join(', '),
			rootPath: workspaceResource ? this.labelService.getUriLabel(workspaceResource) : '',
			appName: this.productName,
			dirty: dirty ? '● ' : '',
			separator: { label: this.configurationService.getValue<string>(WorkbenchConfiguration.windowTitleSeparator) },
			...customValues,
		});
		const admin = this.properties.isAdmin
			? this.localizationService.translate('ash', isWindows ? 'window.title.admin' : 'window.title.superuser', isWindows ? '[Administrator]' : '[Superuser]')
			: '';
		const title = [this.properties.prefix, titleText, admin].filter(Boolean).join(' ');
		if (this.targetWindow.document.title !== title) {
			this.targetWindow.document.title = title;
			this.titleChanged.fire();
		}
	}
}
