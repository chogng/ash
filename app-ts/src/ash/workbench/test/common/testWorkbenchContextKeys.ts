import { Event } from '../../../base/common/event.js';
import { noneDisposable } from '../../../base/common/lifecycle.js';
import type { IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { WorkbenchState, type IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkbenchContextKeysHandler } from '../../browser/contextkeys.js';
import type { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../services/editor/common/editorService.js';
import type { EditorGroupState } from '../../services/editor/common/editorState.js';
import type { IWorkbenchLayoutService } from '../../services/layout/common/workbenchLayoutService.js';
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

const emptyGroup: EditorGroupState = Object.freeze({ id: 'test-group', editors: Object.freeze([]), activeEditorInstanceId: undefined });

const emptyWorkspaceContextService: IWorkspaceContextService = Object.freeze({
	onDidChangeWorkspace: Event.None,
	getWorkspace: () => Object.freeze({ id: 'test-workspace', folders: Object.freeze([]) }),
	getWorkbenchState: () => WorkbenchState.EMPTY,
	getWorkspaceFolder: () => null,
});

const emptyEditorGroupsService: IEditorGroupsService = Object.freeze({
	whenReady: Promise.resolve(),
	onDidChangeGroups: Event.None,
	onDidAddGroup: Event.None,
	onDidRemoveGroup: Event.None,
	onDidActivateGroup: Event.None,
	groups: Object.freeze([emptyGroup]),
	activeGroup: emptyGroup,
	count: 1,
});

const emptyEditorService: IEditorService = Object.freeze({
	...emptyEditorServiceState,
	openEditor: async () => {},
	focusActiveEditor: () => {},
});

const emptyLayoutService: IWorkbenchLayoutService = Object.freeze({
	onDidChangePartVisibility: Event.None,
	isPartVisible: () => false,
	isPanelMaximized: () => false,
	showPart: () => {},
	showParts: () => {},
	hidePart: () => {},
	hideParts: () => {},
	getPartSize: () => ({ width: 0, height: 0 }),
	resizePart: () => {},
});

const emptyWorkingCopyService: IWorkingCopyService = Object.freeze({
	onDidRegister: Event.None,
	onDidUnregister: Event.None,
	onDidChangeDirty: Event.None,
	hasDirtyWorkingCopies: false,
	register: () => noneDisposable,
	get: () => Object.freeze([]),
	getAll: () => Object.freeze([]),
	dispose: () => {},
	[Symbol.dispose]: () => {},
});
