import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableMap, Disposable } from '../../../../base/common/lifecycle.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { createSettingWidget, type SettingWidget, type SettingWidgetOptions } from './settingsWidgets.js';

/** Creates and retains one Widget per stable Settings ID. */
export class SettingsRenderer extends Disposable {
	private readonly widgets = this._register(new DisposableMap<string, SettingWidget>());

	constructor(private readonly container: HTMLElement, private readonly options: SettingWidgetOptions, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}

	public render(setting: ISetting): HTMLElement {
		const existing = this.getWidget(setting.id);
		if (existing) return existing.domNode;
		const widget = createSettingWidget(this.container, setting, this.options, this.instantiationService);
		this.widgets.set(setting.id, widget);
		return widget.domNode;
	}

	public update(setting: ISetting): void {
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
