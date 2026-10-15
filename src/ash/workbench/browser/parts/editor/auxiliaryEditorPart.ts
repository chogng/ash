import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import "./media/auxiliaryEditorPart.css";
import { Dimension } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IAuxiliaryWindow } from "../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { IStatusbarService, StatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarPart } from "../statusbar/statusbarPart.js";
import type { IAuxiliaryTitlebarPart } from "../titlebar/titlebarPart.js";
import type { IEditorPart } from "./editorPart.js";
import { EditorStatusContribution } from "./editorStatus.js";
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';

export interface AuxiliaryEditorPartCreation {
	readonly part: IEditorPart;
	readonly titlebar: IAuxiliaryTitlebarPart;
	readonly resources?: readonly IDisposable[];
}

export type AuxiliaryEditorPartFactory = (container: HTMLElement) => AuxiliaryEditorPartCreation;

/** Owns the editor UI and workbench chrome inside an auxiliary window. */
export class AuxiliaryEditorPart extends Disposable {
	constructor(
		window: IAuxiliaryWindow,
		creation: AuxiliaryEditorPartCreation,
		accessibility: IAccessibilityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStatusbarService rootStatusbar: IStatusbarService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		try {
			// The window service owns registry lifetime; this part only requests close.
			this._register(toDisposable(() => window[Symbol.dispose]()));
			const resources = this._register(new DisposableStore());
			for (const resource of creation.resources ?? []) resources.add(resource);
			this._register(creation.part);
			// The title service owns the part; closing this window releases its registration.
			this._register(toDisposable(() => creation.titlebar.dispose()));
			creation.titlebar.updateOptions({ compact: false });
			this._register(creation.titlebar.onDidChange!(() => window.layout()));
			const statusbarService = this._register(new StatusbarService(rootStatusbar));
			const statusbarPart = this._register(instantiationService.createInstance(StatusbarPart, window.container, statusbarService));
			const statusServices = this._register(instantiationService.createChild());
			statusServices.registerInstance(IAccessibilityService, accessibility);
			this._register(statusServices.createInstance(EditorStatusContribution, creation.part, statusbarService));
			const updateWindowChrome = (): void => {
				creation.titlebar.updateOptions({ compact: creation.part.activePane?.prefersCompactTitlebar === true });
				const hidden = creation.part.activePane?.prefersStatusbarHidden === true || configuration.getValue<boolean>(WorkbenchConfiguration.statusBarVisible) === false;
				if (statusbarPart.domNode.hidden !== hidden) {
					statusbarPart.setVisible(!hidden);
					window.layout();
				}
			};
			this._register(creation.part.onDidChangeEditors(updateWindowChrome));
			this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(WorkbenchConfiguration.statusBarVisible)) updateWindowChrome(); }));
			let isConfirmingClose = false;
			const confirmClose = async (): Promise<void> => {
				isConfirmingClose = true;
				try {
					// beforeunload cannot await the editor's save dialog. Keep the window
					// alive until it settles, then retry through the normal unload path.
					if (await creation.part.confirmCloseAllEditors() && !this.isDisposed) {
						window.window.close();
					}
				} finally {
					isConfirmingClose = false;
				}
			};
			this._register(window.onBeforeUnload(event => {
				if (creation.part.activePane?.prefersWindowCloseConfirmation && creation.part.getEditorState().groups.some(group => group.editors.some(editor => editor.isDirty))) {
					event.veto(localize({ bundle: 'ash', key: 'auxiliaryWindow.unsavedChanges' }, 'The auxiliary editor window contains unsaved changes.'));
					if (!isConfirmingClose) {
						void confirmClose().catch(onUnexpectedError);
					}
				}
			}));
			this._register(window.onDidLayout(dimension => {
				const statusbarHeight = statusbarPart.domNode.hidden ? 0 : StatusbarHeight;
				creation.part.layout(new Dimension(
					dimension.width,
					Math.max(0, dimension.height - statusbarHeight - creation.titlebar.height),
				));
				statusbarPart.layout(new Dimension(dimension.width, statusbarHeight));
			}));
			updateWindowChrome();
			window.layout();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
}
