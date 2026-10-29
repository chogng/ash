import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableMap, Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { createSettingWidget, type SettingWidget, type SettingWidgetOptions } from './settingsWidgets.js';

import type { Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';

/** Creates and retains one Widget per stable Settings ID. */
export class SettingsRenderer extends Disposable {
	private readonly pages = new Map<string, SettingsPageRenderer<ISetting | SettingsSectionReference>>();
	private readonly widgets = this._register(new DisposableMap<string, SettingWidget>());

	constructor(
		private readonly container: HTMLElement,
		private readonly options: SettingWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(toDisposable(() => this.pages.clear()));
	}

	/** Page renderers and their controls belong to this opening's Preferences lifetime. */
	public registerPage(page: SettingsPageRenderer<ISetting | SettingsSectionReference>): IDisposable {
		if (this.pages.has(page.rendererId)) throw new Error('Settings page is already registered');
		this.pages.set(page.rendererId, page);
		return toDisposable(() => this.pages.delete(page.rendererId));
	}

	public render(setting: ISetting | SettingsSectionReference): HTMLElement {
		if ('rendererId' in setting) {
			const page = this.pages.get(setting.rendererId);
			if (!page) throw new Error('Settings page renderer is not registered');
			return page.renderItem(setting);
		}
		const existing = this.getWidget(setting.id);
		if (existing) return existing.domNode;
		const widget = createSettingWidget(this.container, setting, this.options, this.instantiationService);
		this.widgets.set(setting.id, widget);
		return widget.domNode;
	}

	public update(setting: ISetting | SettingsSectionReference): void {
		if ('rendererId' in setting) return;
		this.getWidget(setting.id)?.update(setting);
	}

	public disposeSetting(id: string): void {
		this.widgets.deleteAndDispose(id);
	}

	private getWidget(id: string): SettingWidget | undefined {
		for (const [candidateId, widget] of this.widgets) {
			if (candidateId === id) return widget;
		}
		return undefined;
	}
}

/**
 * Owns retained section controls within Preferences. Search and navigation carry
 * only data references; domain services never implement this renderer contract.
 */
export abstract class SettingsPageRenderer<T extends ISetting | SettingsSectionReference = ISetting | SettingsSectionReference> extends Disposable {
	public readonly rendererId = generateUuid();
	public abstract readonly categoryId: string;
	public get settingIds(): readonly string[] | undefined {
		return undefined;
	}
	public abstract readonly onDidChange: Event<void>;
	private readonly elements = new Map<string, HTMLElement>();

	public getNodes(query = new SettingsSearchQuery('')): readonly SettingsTreeNode<T>[] {
		this.elements.clear();
		return this.buildNodes(query);
	}

	protected abstract buildNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<T>[];
	public abstract setVisible(visible: boolean): void;

	protected retainElement(itemId: string, element: HTMLElement): SettingsSectionReference {
		this.elements.set(itemId, element);
		return { rendererId: this.rendererId, itemId, hidden: !!element.hidden };
	}

	public renderItem(reference: SettingsSectionReference): HTMLElement {
		const element = this.elements.get(reference.itemId);
		if (reference.rendererId !== this.rendererId || !element) throw new Error('Unknown Settings section');
		return element;
	}

	public override dispose(): void {
		this.elements.clear();
		super.dispose();
	}
}
