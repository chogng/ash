import './creatorPage.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CreatorMode } from '../common/creator.js';
import { CreatorModes, type ICreatorWorkspace } from './creatorWorkspace.js';

const pages = new WeakMap<Element, CreatorPage>();
const navigationViews = new WeakMap<Element, CreatorNavigationView>();

export class CreatorEditorPane extends Disposable implements IEditorPane {
	public readonly id = 'sessions.editor.creator';
	public page!: CreatorPage;
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { super(); }
	public create(parent: HTMLElement): void {
		this.page = this._register(this.instantiation.createInstance(CreatorPage, parent.ownerDocument));
		parent.append(this.page.domNode);
		this.page.initialize();
	}
	public async setInput(_input: EditorInput, _signal: AbortSignal): Promise<void> { }
	public clearInput(): void { }
	public setVisible(visibility: EditorPaneVisibility): void { this.page.setVisible(visibility === EditorPaneVisibility.Visible); }
	public layout(dimension: IDimension): void { this.page.layout(dimension); }
	public focus(): void { this.page.focus(); }
}

/** Home and non-canvas workspaces use the same contributed navigation container. */
export class CreatorNavigationView extends ViewPane {
	constructor(parent: HTMLElement, options: IViewPaneOptions, @ICommandService commands: ICommandService, @IContextKeyService contextKeys: IContextKeyService, @IAccessibleViewService accessibleViews: IAccessibleViewService) {
		super(parent, { ...options, minimumBodySize: 52, maximumBodySize: 52 });
		this.contentElement.classList.add('ash-creator-navigation');
		navigationViews.set(this.contentElement, this);
		this._register(contextKeys.createScoped(this.contentElement)).createKey('sessionsCreatorNavigationFocused', true);
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Creator);
		if (hint) this.contentElement.setAttribute('aria-description', hint);
		this._register(new Button(this.contentElement, { label: localize('sessions.creator.home', 'Creator home'), onClick: () => { void commands.executeCommand('sessions.show.creator'); } }));
	}
	public static getFocused(element: HTMLElement): CreatorNavigationView | undefined {
		const root = element.closest('.ash-creator-navigation');
		return root ? navigationViews.get(root) : undefined;
	}
	public getAccessibleContent(): string { return localize('sessions.creator.home', 'Creator home'); }
	public focus(): void { this.contentElement.querySelector<HTMLButtonElement>('button')!.focus(); }
}

/** Owns mode navigation and retained workspaces; each contribution owns its editing experience. */
export class CreatorPage extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly homeDomNode: HTMLElement;
	private readonly workspacesDomNode: HTMLElement;
	private readonly titleDomNode: HTMLElement;
	private readonly back: Button;
	private readonly modeButtons = new Map<CreatorMode, Button>();
	private readonly workspaces = this._register(new DisposableMap<CreatorMode, ICreatorWorkspace>());
	private mode: CreatorMode | undefined;
	public get activeMode(): CreatorMode | undefined { return this.mode; }
	private visible = false;
	private dimension: IDimension = { width: 0, height: 0 };
	public get usesCanvasPanels(): boolean { return this.mode !== undefined && this.workspaces.get(this.mode)!.usesCanvasPanels; }

	constructor(ownerDocument: Document, @IInstantiationService private readonly instantiation: IInstantiationService, @IContextKeyService contextKeys: IContextKeyService, @IStorageService private readonly storage: IStorageService, @IAccessibleViewService accessibleViews: IAccessibleViewService, @ICommandService commands: ICommandService) {
		super();
		this.domNode = h(ownerDocument, 'section', { className: 'ash-creator', attributes: { role: 'region', 'aria-label': localize('sessions.creator.title', 'Creator') } });
		pages.set(this.domNode, this);
		this._register(contextKeys.createScoped(this.domNode)).createKey('sessionsCreatorFocused', true);
		const header = h(ownerDocument, 'header', { className: 'ash-creator-header' });
		this.back = this._register(new Button(header, { label: localize('sessions.creator.home', 'Creator home'), onClick: () => { void commands.executeCommand('sessions.show.creator'); } }));
		this.back.hidden = true;
		this.titleDomNode = h(ownerDocument, 'h1', { className: 'ash-creator-title' }, localize('sessions.creator.title', 'Creator'));
		header.append(this.titleDomNode);
		this.homeDomNode = h(ownerDocument, 'div', { className: 'ash-creator-home' });
		const introduction = h(ownerDocument, 'p', { className: 'ash-creator-introduction' }, localize('sessions.creator.introduction', 'Choose what you want to create. Each workspace keeps your work when you switch modes.'));
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Creator);
		if (hint) { introduction.setAttribute('aria-label', `${introduction.textContent} ${hint}`); }
		const modes = h(ownerDocument, 'div', { className: 'ash-creator-modes' });
		for (const contribution of CreatorModes.values()) {
			const card = h(ownerDocument, 'article', { className: 'ash-creator-mode-card' });
			const button = this._register(new Button(card, { label: contribution.title, icon: contribution.icon, onClick: () => { void commands.executeCommand('sessions.creator.openMode', contribution.id); } }));
			button.domNode.dataset.creatorMode = contribution.id;
			const description = h(ownerDocument, 'p', { className: 'ash-creator-mode-description', attributes: { id: `creator-${contribution.id}-description` } }, contribution.description);
			button.domNode.setAttribute('aria-describedby', description.id);
			card.append(description);
			modes.append(card);
			this.modeButtons.set(contribution.id, button);
		}
		this.homeDomNode.append(introduction, modes);
		this.workspacesDomNode = h(ownerDocument, 'div', { className: 'ash-creator-workspaces' });
		this.workspacesDomNode.hidden = true;
		this.domNode.append(header, this.homeDomNode, this.workspacesDomNode);
	}
	public initialize(): void {
		const restored = this.storage.get('sessions.creator.activeMode', StorageScope.WORKSPACE);
		if (restored !== undefined) {
			if (!CreatorModes.has(restored as CreatorMode)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Creator document mode.')); }
			this.openMode(restored as CreatorMode);
		}
	}
	public static getFocused(element: HTMLElement): CreatorPage | undefined {
		const root = element.closest('.ash-creator');
		return root ? pages.get(root) : undefined;
	}
	public openMode(mode: CreatorMode): void {
		const contribution = CreatorModes.get(mode)!;
		let workspace = this.workspaces.get(mode);
		if (!workspace) {
			workspace = contribution.create(this.instantiation, this.domNode.ownerDocument);
			this.workspaces.set(mode, workspace);
			workspace.create(this.workspacesDomNode);
		}
		this.mode = mode;
		this.titleDomNode.textContent = contribution.title;
		this.storage.store('sessions.creator.activeMode', mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.updateVisibility();
		this.layout(this.dimension);
		if (this.visible) { workspace.focus(); status(localize('sessions.creator.entered', '{0} workspace', contribution.title)); }
	}
	public showHome(): void {
		const previous = this.mode;
		this.mode = undefined;
		this.titleDomNode.textContent = localize('sessions.creator.title', 'Creator');
		this.storage.remove('sessions.creator.activeMode', StorageScope.WORKSPACE);
		this.updateVisibility();
		if (previous) { this.modeButtons.get(previous)!.focus(); }
	}
	private updateVisibility(): void {
		this.homeDomNode.hidden = this.mode !== undefined;
		this.workspacesDomNode.hidden = this.mode === undefined;
		this.back.hidden = this.mode === undefined;
		for (const [mode, workspace] of this.workspaces) {
			workspace.domNode.hidden = mode !== this.mode;
			workspace.setVisible(this.visible && mode === this.mode);
		}
	}
	public setVisible(visible: boolean): void { this.visible = visible; this.updateVisibility(); }
	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		if (this.mode !== undefined) { this.workspaces.get(this.mode)!.layout({ width: dimension.width, height: Math.max(0, dimension.height - 52) }); }
	}
	public focus(): void {
		if (this.mode !== undefined) { this.workspaces.get(this.mode)!.focus(); }
		else { this.modeButtons.get(CreatorMode.Design)!.focus(); }
	}
	public getAccessibleContent(): string {
		if (this.mode !== undefined) { return `${CreatorModes.get(this.mode)!.title}\n${CreatorModes.get(this.mode)!.help}\n\n${this.workspaces.get(this.mode)!.getAccessibleContent()}`; }
		return [...CreatorModes.values()].map(mode => `${mode.title}: ${mode.description}`).join('\n');
	}
	protected override disposeCore(): void { pages.delete(this.domNode); super.disposeCore(); this.domNode.remove(); }
}
