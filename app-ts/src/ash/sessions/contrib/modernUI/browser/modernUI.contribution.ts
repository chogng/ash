import './media/modernUI.css';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SessionsConfiguration, type SessionsLayoutStyle } from '../../../common/configuration.js';
import type { SessionsWorkbenchLayout } from '../../../browser/layoutPolicy.js';

/** Applies the Sessions appearance preference to this window and its layout. */
export class SessionsModernUIContribution extends Disposable {
	constructor(
		private readonly container: HTMLElement,
		private readonly layout: SessionsWorkbenchLayout,
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.update();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.layoutStyle)) this.update();
		}));
		this._register(toDisposable(() => {
			container.removeAttribute('data-layout-style');
			container.classList.remove('modern-ui');
		}));
	}

	private update(): void {
		const style = this.configurationService.getValue<SessionsLayoutStyle>(SessionsConfiguration.layoutStyle);
		this.layout.setLayoutStyle(style);
		this.container.dataset.layoutStyle = style;
		this.container.classList.toggle('modern-ui', style === 'modern');
	}
}
