import { Event } from '../../../base/common/event.js';
import { noneDisposable } from '../../../base/common/lifecycle.js';
import type { IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { WorkbenchState, type IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkbenchContextKeysHandler } from '../../browser/contextkeys.js';
import type { IEditorGroup, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../services/editor/common/editorService.js';
import type { EditorGroupState } from '../../services/editor/common/editorState.js';
import { Position, type IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import type { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { emptyEditorServiceState } from './testEditorService.js';

export interface TestWorkbenchContextKeyServices {
	readonly workspaceContextService?: IWorkspaceContextService;
	readonly editorGroupsService?: IEditorGroupsService;
	readonly editorService?: IEditorService;
	readonly layoutService?: IWorkbenchLayoutService;
	readonly workingCopyService?: IWorkingCopyService;
	readonly openFolderWorkspaceSupported?: boolean;
	readonly browserLocalFolderSupported?: boolean;
}

/** Creates the production handler with explicit no-op services for unrelated test domains. */
export function createTestWorkbenchContextKeysHandler(contextKeyService: IContextKeyService, services: TestWorkbenchContextKeyServices = {}): WorkbenchContextKeysHandler {
	return new WorkbenchContextKeysHandler(
		contextKeyService,
		services.workspaceContextService ?? emptyWorkspaceContextService,
		services.editorGroupsService ?? emptyEditorGroupsService,
		services.editorService ?? emptyEditorService,
		services.layoutService ?? emptyLayoutService,
		services.workingCopyService ?? emptyWorkingCopyService,
		services.openFolderWorkspaceSupported ?? false,
		services.browserLocalFolderSupported ?? false,
	);
}

const emptyGroupState: EditorGroupState = Object.freeze({ id: 1, editors: Object.freeze([]), activeEditorInstanceId: undefined });
const emptyGroup: IEditorGroup = Object.freeze({
	createEditorActions: () => ({ actions: { primary: [], secondary: [] }, onDidChange: Event.None }),
	...emptyGroupState,
	onDidChangeEditors: Event.None,
	inputs: Object.freeze([]),
	selectedInputs: Object.freeze([]),
	activeInput: undefined,
	isLocked: false,
	setLocked() { },
	getEditorState: () => emptyGroupState,
	isPreview: () => false,
	isSticky: () => false,
	pinEditor() { },
	stickEditor() { },
	unstickEditor() { },
	closeEditor: async () => true,
	focus() { },
});

const emptyWorkspaceContextService: IWorkspaceContextService = Object.freeze({
	onDidChangeWorkspace: Event.None,
	onDidChangeWorkspaceFolders: Event.None,
	onDidChangeWorkbenchState: Event.None,
	onDidChangeWorkspaceName: Event.None,
	getWorkspace: () => Object.freeze({ id: 'test-workspace', folders: Object.freeze([]) }),
	getWorkbenchState: () => WorkbenchState.EMPTY,
	getWorkspaceFolder: () => null,
});

export const emptyEditorGroupsService: IEditorGroupsService = Object.freeze({
	whenReady: Promise.resolve(),
	onDidChangeGroups: Event.None,
	onDidAddGroup: Event.None,
	onDidRemoveGroup: Event.None,
	onDidActivateGroup: Event.None,
	groups: Object.freeze([emptyGroup]),
	activeGroup: emptyGroup,
	count: 1,
	getGroup: (id: number) => id === emptyGroup.id ? emptyGroup : undefined,
	findGroup: () => undefined,
	addGroup: () => { throw new Error('Unexpected editor group creation in context-key fixture'); },
	removeGroup: async () => { throw new Error('Unexpected editor group removal in context-key fixture'); },
});

const emptyEditorService: IEditorService = Object.freeze({
	...emptyEditorServiceState,
	openEditor: async () => { },
	focusActiveEditor: () => { },
});

const emptyLayoutService: IWorkbenchLayoutService = Object.freeze({
	onDidLayoutMainContainer: Event.None,
	onDidLayoutContainer: Event.None,
	onDidLayoutActiveContainer: Event.None,
	onDidChangeActiveContainer: Event.None,
	mainContainerDimension: { width: 0, height: 0 },
	activeContainerDimension: { width: 0, height: 0 },
	get mainContainer(): HTMLElement { throw new Error('Context key tests do not host a layout container'); },
	get activeContainer(): HTMLElement { throw new Error('Context key tests do not host a layout container'); },
	containers: [],
	getContainer(): HTMLElement { throw new Error('Context key tests do not host a layout container'); },
	whenContainerStylesLoaded: () => undefined,
	mainContainerOffset: { top: 0, quickInputTop: 0 },
	activeContainerOffset: { top: 0, quickInputTop: 0 },
	focus: () => { },
	layout: () => { },
	setLayoutStyle: () => { },
	onDidChangePartVisibility: Event.None,
	isPartVisible: () => false,
	hasFocus: () => false,
	getVisibleNeighborPart: () => undefined,
	onDidChangeAuxiliaryBarMaximized: Event.None,
	isAuxiliaryBarMaximized: () => false,
	toggleMaximizedAuxiliaryBar: () => { },
	setAuxiliaryBarMaximized: () => false,
	onDidChangePanelPosition: Event.None,
	getPanelPosition: () => Position.BOTTOM,
	setPanelPosition: () => { },
	isPanelMaximized: () => false,
	toggleMaximizedPanel: () => { },
	showPart: () => { },
	showParts: () => { },
	hidePart: () => { },
	hideParts: () => { },
	getPartSize: () => ({ width: 0, height: 0 }),
	resizePart: () => { },
});

const emptyWorkingCopyService: IWorkingCopyService = Object.freeze({
	onDidRegister: Event.None,
	onDidUnregister: Event.None,
	onDidChangeDirty: Event.None,
	hasDirtyWorkingCopies: false,
	register: () => noneDisposable,
	get: () => Object.freeze([]),
	getAll: () => Object.freeze([]),
	dispose: () => { },
	[Symbol.dispose]: () => { },
});
