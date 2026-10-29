import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { BreadcrumbsIconsConfiguration } from './breadcrumbs.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { SymbolKinds } from '../../../../editor/common/languages.js';
import { IResourceLabelService, type ResourceLabels } from '../../labels.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { EditorResourceAccessor, SideBySideEditor, type IResourceEditorInput } from '../../../common/editor.js';
import './media/breadcrumbscontrol.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { BreadcrumbsItem, BreadcrumbsWidget } from '../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { BreadcrumbsModel, FileElement, SymbolElement } from './breadcrumbsModel.js';
import type { BreadcrumbsPathMode } from './breadcrumbs.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import type {
	EditorTitleScrollbarSizing,
	EditorTitleScrollbarVisibility,
} from '../../../services/editor/common/editorConfiguration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../platform/theme/browser/defaultStyles.js';

/** Renders the active editor's resource path in one group title. */
export class EditorBreadcrumbsControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly widget: BreadcrumbsWidget;
	private readonly labels: ResourceLabels;
	private showIcons = true;
	private readonly editorTypeButton: HTMLButtonElement;
	private selectEditorType: ((anchor: HTMLElement) => void) | undefined;
	private input: IResourceEditorInput | undefined;
	private symbols: readonly SymbolElement[] = [];
	private filePath: BreadcrumbsPathMode = 'on';
	private symbolPath: BreadcrumbsPathMode = 'on';

	constructor(
		container: HTMLElement,
		private readonly onSelect: ((element: FileElement) => void) | undefined,
		private readonly onSelectSymbol: ((element: SymbolElement) => void) | undefined,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IResourceLabelService resourceLabels: IResourceLabelService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.labels = this._register(resourceLabels.createGroup());
		this.showIcons = configuration.getValue(BreadcrumbsIconsConfiguration);
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(BreadcrumbsIconsConfiguration)) {
					this.showIcons = configuration.getValue(BreadcrumbsIconsConfiguration);
					this.render();
				}
			}),
		);
		this.domNode = h(container.ownerDocument, 'nav');
		this.domNode.className = 'ash-editor-breadcrumbs empty';
		this.domNode.setAttribute('aria-label', localize('breadcrumbs.editorLabel', 'Editor breadcrumbs'));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.widget = this._register(
			new BreadcrumbsWidget(this.domNode, 3, undefined, Lxicon.chevronRight, defaultBreadcrumbsWidgetStyles),
		);
		this.editorTypeButton = h(container.ownerDocument, 'button');
		this.editorTypeButton.type = 'button';
		this.editorTypeButton.className = 'ash-breadcrumbs-editor-type';
		this.editorTypeButton.hidden = true;
		this.editorTypeButton.setAttribute('aria-haspopup', 'menu');
		this.domNode.append(this.editorTypeButton);
		this._register(
			addDisposableListener(this.editorTypeButton, 'click', () => this.selectEditorType?.(this.editorTypeButton)),
		);
		this._register(
			this.widget.onDidSelectItem(event => {
				if (!(event.item instanceof EditorBreadcrumbItem)) {
					return;
				}
				const element = event.item.element;
				if (element instanceof FileElement) {
					this.onSelect?.(element);
				} else {
					this.onSelectSymbol?.(element);
				}
			}),
		);
		this._register(this.workspaceContextService.onDidChangeWorkspace(() => this.render()));
	}

	focus(): boolean {
		if (this.domNode.hidden) return false;
		const item = this.widget.getItems().at(-1);
		if (!item) return false;
		this.widget.setFocused(item);
		return true;
	}

	setScrollbarOptions(sizing: EditorTitleScrollbarSizing, visibility: EditorTitleScrollbarVisibility): void {
		this.widget.setHorizontalScrollbarSize(sizing === 'large' ? 8 : 3);
		const values = {
			auto: ScrollbarVisibility.Auto,
			visible: ScrollbarVisibility.Visible,
			hidden: ScrollbarVisibility.Hidden,
		};
		this.widget.setHorizontalScrollbarVisibility(values[visibility]);
	}

	setInput(input: IResourceEditorInput | undefined): void {
		this.input = input;
		this.symbols = [];
		this.render();
	}

	setSymbols(symbols: readonly SymbolElement[]): void {
		this.symbols = symbols;
		this.render();
	}

	setEditorType(label: string | undefined, select: ((anchor: HTMLElement) => void) | undefined): void {
		this.selectEditorType = select;
		this.editorTypeButton.hidden = label === undefined;
		this.editorTypeButton.textContent = label ?? '';
		this.editorTypeButton.setAttribute(
			'aria-label',
			localize('breadcrumbs.editorTypeLabel', 'Select editor: {0}', label ?? ''),
		);
		const chevron = h(this.domNode.ownerDocument, 'span');
		chevron.className = 'lxicon lxicon-chevron-down';
		chevron.setAttribute('aria-hidden', 'true');
		this.editorTypeButton.append(chevron);
	}

	setPathModes(filePath: BreadcrumbsPathMode, symbolPath: BreadcrumbsPathMode): void {
		this.filePath = filePath;
		this.symbolPath = symbolPath;
		this.render();
	}

	private render(): void {
		// A comparison's tab identity is synthetic; navigation follows its modified resource.
		const resource = EditorResourceAccessor.getOriginalUri(this.input, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		});
		if (!this.input || !resource) {
			this.widget.setItems([]);
			this.domNode.classList.add('empty');
			this.domNode.hidden = true;
			return;
		}
		const workspaceFolder = this.workspaceContextService.getWorkspaceFolder(resource);
		const files =
			this.filePath === 'off'
				? []
				: new BreadcrumbsModel(
						resource,
						workspaceFolder,
						this.input.label,
						this.workspaceContextService.getWorkspace().folders.length > 1,
					).getElements();
		const visibleFiles = this.filePath === 'last' ? files.slice(-1) : files;
		const visibleSymbols =
			this.symbolPath === 'off' ? [] : this.symbolPath === 'last' ? this.symbols.slice(-1) : this.symbols;
		const elements = [...visibleFiles, ...visibleSymbols];
		this.widget.setItems(
			elements.map(
				(element, index) =>
					new EditorBreadcrumbItem(element, index === elements.length - 1, this.labels, this.showIcons),
			),
		);
		this.domNode.title = resource.toString();
		// Content emptiness is independent of configuration hiding a nonempty path.
		this.domNode.classList.toggle('empty', elements.length === 0);
		this.domNode.hidden = elements.length === 0;
		this.widget.revealLast();
	}
}

/** Keeps resource and outline identity in Workbench, outside the generic widget. */
class EditorBreadcrumbItem extends BreadcrumbsItem {
	private label: { dispose(): void } | undefined;

	constructor(
		public readonly element: FileElement | SymbolElement,
		private readonly current: boolean,
		private readonly labels: ResourceLabels,
		private readonly showIcons: boolean,
	) {
		super();
	}

	public override dispose(): void {
		this.label?.dispose();
	}

	public override equals(other: BreadcrumbsItem): boolean {
		if (
			!(other instanceof EditorBreadcrumbItem) ||
			this.current !== other.current ||
			this.showIcons !== other.showIcons ||
			this.element.label !== other.element.label
		) {
			return false;
		}
		if (this.element instanceof FileElement && other.element instanceof FileElement) {
			return extUri.isEqual(this.element.uri, other.element.uri);
		}
		return (
			this.element instanceof SymbolElement &&
			other.element instanceof SymbolElement &&
			this.element.symbol === other.element.symbol
		);
	}

	public override render(container: HTMLElement): void {
		if (this.element instanceof FileElement) {
			const label = (this.label = this.labels.create(container));
			label.setResource(
				{ resource: this.element.uri, name: this.element.label },
				{
					fileKind: this.element.kind,
					hideIcon: !this.showIcons || this.element.kind === FileKind.Directory,
					fileDecorations: { colors: true, badges: false },
				},
			);
		} else {
			this.label = new IconLabel(container, {
				label: this.element.label,
				icon: SymbolKinds.toIcon(this.element.symbol.kind),
				hideIcon: !this.showIcons,
				title: this.element.label,
			});
		}
		if (this.current) {
			container.classList.add('current');
			container.setAttribute('aria-current', 'page');
		}
	}
}
