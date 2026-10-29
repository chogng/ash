import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import "./media/auxiliaryEditorPart.css";
import { Dimension, getActiveWindow, getWindow } from "../../../../base/browser/dom.js";
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IAuxiliaryWindow } from "../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarPart, StatusbarService } from "../statusbar/statusbarPart.js";
import type { IAuxiliaryTitlebarPart } from "../titlebar/titlebarPart.js";
import type { IEditorPart } from "./editorPart.js";
import { EditorStatusContribution } from "./editorStatus.js";
import { localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsCompactTitleBarContext } from '../../../common/contextkeys.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

// Commands resolve the window at invocation; the live part owns its mode and chrome.
const compactWindowCommands = new WeakMap<Window, (compact?: boolean) => void>();

for (const compact of [undefined, true, false]) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.action.${compact === undefined ? 'toggle' : compact ? 'enable' : 'disable'}CompactAuxiliaryWindow`,
				title: compact === undefined
					? localize2('toggleCompactAuxiliaryWindow', 'Toggle Window Compact Mode')
					: compact ? localize2('enableCompactAuxiliaryWindow', 'Turn On Compact Mode') : localize2('disableCompactAuxiliaryWindow', 'Turn Off Compact Mode'),
				f1: compact === undefined,
				icon: compact === false ? Lxicon.screenNormal : Lxicon.screenFull,
				menu: compact === undefined ? undefined : {
					id: MenuId.LayoutControlMenu,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.isEqualTo(true), IsCompactTitleBarContext.isEqualTo(!compact)),
					group: 'navigation',
					order: 0,
				},
			});
		}

		override run(accessor: ServicesAccessor): void {
			const focused = getActiveWindow();
			const target = focused === mainWindow ? getWindow(accessor.get(ILayoutService).activeContainer) : focused;
			compactWindowCommands.get(target)?.(compact);
		}
	});
}

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
			const statusServices = this._register(instantiationService.createChild());
			statusServices.registerInstance(IStatusbarService, statusbarService);
			statusServices.registerInstance(IAccessibilityService, accessibility);
			const statusbarPart = this._register(statusServices.createInstance(StatusbarPart, window.container));
			this._register(statusServices.createInstance(EditorStatusContribution, creation.part, statusbarService));
			let compact: boolean | undefined;
			const updateWindowChrome = (): void => {
				const singleEditor = creation.part.groups.length === 1 && creation.part.activeGroup.inputs.length === 1;
				const isCompact = (compact ?? creation.part.activePane?.prefersCompactTitlebar === true) && singleEditor;
				creation.titlebar.updateOptions({ compact: isCompact });
				for (const group of creation.part.groups) group.setTitleVisible(!isCompact);
				const hidden = isCompact || creation.part.activePane?.prefersStatusbarHidden === true || configuration.getValue<boolean>(WorkbenchConfiguration.statusBarVisible) === false;
				if (statusbarPart.domNode.hidden !== hidden) {
					statusbarPart.setVisible(!hidden);
					window.layout();
				}
			};
			compactWindowCommands.set(window.window, value => {
				const focusedElement = window.window.document.activeElement;
				compact = value ?? !(compact ?? creation.part.activePane?.prefersCompactTitlebar === true);
				updateWindowChrome();
				window.layout();
				// The mode button is replaced by its inverse; keep keyboard focus in this window.
				if (focusedElement && !focusedElement.isConnected) creation.part.focus();
			});
			this._register(toDisposable(() => compactWindowCommands.delete(window.window)));
			this._register(creation.part.onDidChangeEditors(() => {
				// Resource replacement briefly opens a second input. Derive navigation
				// from the live inputs without changing the user's presentation choice.
				updateWindowChrome();
			}));
			this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(WorkbenchConfiguration.statusBarVisible)) updateWindowChrome(); }));
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
