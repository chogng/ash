import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { PROMPT_TIMELINE_DISPLAY_SETTING, type PromptTimelineRailStyle } from '../../common/promptTimeline.js';
import { PromptTimelineGutterRail } from './promptTimelineGutterRail.js';
import { PromptTimelineRulerRail } from './promptTimelineRulerRail.js';
import type { PromptTimelineModel } from './promptTimelineModel.js';
import type { IPromptTimelineActions, IPromptTimelineRail } from './promptTimelineRail.js';
import './media/promptTimeline.css';

export class PromptTimelineWidgetContrib extends Disposable {
	private readonly rail = this._register(new MutableDisposable<IPromptTimelineRail>());
	private style: PromptTimelineRailStyle | undefined;
	private active: string | undefined;

	constructor(
		private readonly host: HTMLElement,
		private readonly viewport: HTMLElement,
		private readonly actions: IPromptTimelineActions,
		private readonly refresh: () => void,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PROMPT_TIMELINE_DISPLAY_SETTING)) this.refresh();
		}));
	}

	render(model: PromptTimelineModel, visible: boolean): void {
		const style = visible && this.viewport.clientWidth >= 320 && model.prompts.length >= 2
			? this.configuration.getValue<PromptTimelineRailStyle>(PROMPT_TIMELINE_DISPLAY_SETTING) ?? 'gutter' : 'off';
		if (this.style !== style) {
			this.style = style;
			this.rail.value = style === 'gutter' ? new PromptTimelineGutterRail(this.host, this.actions)
				: style === 'ruler' ? new PromptTimelineRulerRail(this.host, this.actions) : undefined;
		}
		if (this.rail.value) {
			const ticks = style === 'ruler' ? model.ticks(this.viewport) : model.prompts.map(prompt => ({ prompt, position: 0 }));
			this.rail.value.render(ticks, this.viewport.clientHeight);
			this.rail.value.setActive(this.active);
		}
	}

	contains(element: HTMLElement): boolean {
		return this.host.contains(element) && !!element.closest('.ash-prompt-timeline-gutter, .ash-prompt-timeline-ruler');
	}

	setActive(id: string | undefined): void {
		if (this.active === id) return;
		this.active = id;
		this.rail.value?.setActive(id);
	}
}
