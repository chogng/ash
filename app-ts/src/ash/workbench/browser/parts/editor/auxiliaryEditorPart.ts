import "./media/auxiliaryEditorPart.css";
import { Dimension } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IAuxiliaryWindow } from "../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { StatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarPart } from "../statusbar/statusbarPart.js";
import type { IAuxiliaryTitlebarPart } from "../titlebar/titlebarPart.js";
import type { IEditorPart } from "./editorPart.js";
import { EditorStatusContribution } from "./editorStatus.js";

export interface AuxiliaryEditorPartCreation {
	readonly part: IEditorPart;
	readonly titlebar: IAuxiliaryTitlebarPart;
	readonly resources?: readonly IDisposable[];
}

export type AuxiliaryEditorPartFactory = (container: HTMLElement) => AuxiliaryEditorPartCreation;

/** Owns the editor UI and workbench chrome inside an auxiliary window. */
export class AuxiliaryEditorPart extends Disposable {
	constructor(window: IAuxiliaryWindow, creation: AuxiliaryEditorPartCreation, accessibility: IAccessibilityService) {
		super();
		// The window service owns registry lifetime; this part only requests close.
		this._register(toDisposable(() => window[Symbol.dispose]()));
		const resources = this._register(new DisposableStore());
		for (const resource of creation.resources ?? []) resources.add(resource);
		this._register(creation.part);
		// The title service owns the part; closing this window releases its registration.
		this._register(toDisposable(() => creation.titlebar.dispose()));
		creation.titlebar.updateOptions({ compact: false });
		this._register(creation.titlebar.onDidChange!(() => window.layout()));
		const statusbarService = this._register(new StatusbarService());
		const statusbarPart = this._register(new StatusbarPart(window.container, statusbarService));
		this._register(new EditorStatusContribution(creation.part, statusbarService, accessibility));
		this._register(window.onBeforeUnload(event => {
			if (creation.part.getEditorState().groups.some(group => group.editors.some(editor => editor.isDirty))) {
				event.veto("The auxiliary editor window contains unsaved changes.");
			}
		}));
		this._register(window.onDidLayout(dimension => {
			creation.part.layout(new Dimension(
				dimension.width,
				Math.max(0, dimension.height - StatusbarHeight - creation.titlebar.height),
			));
			statusbarPart.layout(new Dimension(dimension.width, StatusbarHeight));
		}));
		window.layout();
	}
}
