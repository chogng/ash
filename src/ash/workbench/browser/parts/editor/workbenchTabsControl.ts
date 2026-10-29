import './media/workbenchTabsControl.css';
import { observeResize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { TabList, type TabListItem, type TabListOptions } from '../../../../base/browser/ui/tablist/tabList.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration, type ModernUIEditorTabStyle, type WorkbenchLayoutStyle } from '../../../common/configuration.js';
import {
	EditorTabSizingConfiguration,
	EditorTabSizingFixedMinWidthConfiguration,
	EditorTabSizingFixedMaxWidthConfiguration,
	EditorTitleScrollbarSizingConfiguration,
	EditorTitleScrollbarVisibilityConfiguration,
	type EditorTabSizing,
	type EditorTitleScrollbarSizing,
	type EditorTitleScrollbarVisibility,
} from '../../../services/editor/common/editorConfiguration.js';
import { clearConnectedTabClipping, updateConnectedTabClipping } from './connectedTabClipping.js';
import { CONNECTED_EDITOR_TABS_CLASS } from './editor.js';

/**
 * One workbench tab row for document and conversation hosts. Domain delegates
 * own content and mutations; this controller owns settings, rendering and scroll geometry.
 */
export class WorkbenchTabsControl<T> extends Disposable {
	readonly tabList: TabList<T>;
	private connectedTab: HTMLElement | undefined;
	private connected = false;
	private touchesContent = true;
	private readonly layoutScheduler: AnimationFrameScheduler;

	constructor(
		private readonly container: HTMLElement,
		options: TabListOptions<T>,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		container.classList.add('ash-workbench-tabs-control');
		this.tabList = this._register(new TabList(container, options));
		this.layoutScheduler = this._register(new AnimationFrameScheduler(container.ownerDocument.defaultView!, () => this.updateClipping()));
		this.updatePresentation();
		this.updateSizing();
		this.updateScrollbar();
		this._register(this.tabList.onDidScroll(() => this.layout()));
		this._register(observeResize(this.tabList.scrollableElement, () => this.layout()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle) || event.affectsConfiguration(WorkbenchConfiguration.modernUIEditorTabStyle)) {
				this.updatePresentation();
			}
			if (event.affectsConfiguration(EditorTabSizingConfiguration) || event.affectsConfiguration(EditorTabSizingFixedMinWidthConfiguration) || event.affectsConfiguration(EditorTabSizingFixedMaxWidthConfiguration)) {
				this.updateSizing();
			}
			if (event.affectsConfiguration(EditorTitleScrollbarSizingConfiguration) || event.affectsConfiguration(EditorTitleScrollbarVisibilityConfiguration)) {
				this.updateScrollbar();
			}
		}));
	}

	setTabs(tabs: readonly TabListItem<T>[], activeId: string | undefined, selectedIds?: ReadonlySet<string>): void {
		this.tabList.setTabs(tabs, activeId, selectedIds);
		clearConnectedTabClipping(this.connectedTab, this.tabList.element);
		this.connectedTab = this.tabList.element.querySelector<HTMLElement>('.ash-tab.checked') ?? undefined;
		this.tabList.element.hidden = tabs.length === 0;
		this.layout();
	}

	/** Only the bottom row of a stacked title can connect to the content surface. */
	setConnectedToContent(touchesContent: boolean): void {
		if (this.touchesContent === touchesContent) return;
		this.touchesContent = touchesContent;
		this.updatePresentation();
	}

	private updatePresentation(): void {
		const layout = this.configuration.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
		const style = this.configuration.getValue<ModernUIEditorTabStyle>(WorkbenchConfiguration.modernUIEditorTabStyle);
		const inset = layout === 'modern' && style !== 'standard';
		this.container.classList.toggle('ash-standard-editor-tabs', style === 'standard');
		this.tabList.setPresentation(inset ? 'inset' : 'flush');
		this.connected = inset && style === 'connected' && this.touchesContent;
		this.container.classList.toggle(CONNECTED_EDITOR_TABS_CLASS, this.connected);
		this.layout();
	}

	private updateSizing(): void {
		const mode = this.configuration.getValue<EditorTabSizing>(EditorTabSizingConfiguration);
		this.tabList.setSizing(mode === 'fixed' ? {
			mode,
			minWidth: this.configuration.getValue<number>(EditorTabSizingFixedMinWidthConfiguration),
			maxWidth: this.configuration.getValue<number>(EditorTabSizingFixedMaxWidthConfiguration),
		} : { mode });
		this.layout();
	}

	private updateScrollbar(): void {
		this.tabList.updateScrollbarOptions({
			scrollbarSize: this.configuration.getValue<EditorTitleScrollbarSizing>(EditorTitleScrollbarSizingConfiguration) === 'large' ? 10 : 3,
			horizontal: this.configuration.getValue<EditorTitleScrollbarVisibility>(EditorTitleScrollbarVisibilityConfiguration),
		});
	}

	/** Recompute geometry after a host updates custom label content. */
	layout(): void {
		this.layoutScheduler.schedule();
	}

	private updateClipping(): void {
		const tab = this.connectedTab;
		if (!tab || !this.connected) {
			clearConnectedTabClipping(tab, this.tabList.element);
			return;
		}
		const viewport = this.tabList.scrollableElement;
		const bounds = tab.getBoundingClientRect();
		const viewportBounds = viewport.getBoundingClientRect();
		updateConnectedTabClipping({
			tab,
			overflowEdge: this.tabList.element,
			fillLeft: bounds.left - viewportBounds.left + viewport.scrollLeft,
			fillRight: bounds.right - viewportBounds.left + viewport.scrollLeft,
			viewportLeft: 0,
			viewportRight: viewport.clientWidth,
			shoulderExtent: 6,
		}, viewport.scrollLeft);
	}
}
