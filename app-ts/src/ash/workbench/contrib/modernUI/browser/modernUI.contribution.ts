import { Disposable, DisposableMap, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration, type WorkbenchLayoutStyle } from '../../../common/configuration.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IWorkbenchLayoutStyleService } from '../../../services/layout/browser/workbenchLayoutStyleService.js';
import './media/editorBorder.css';
import './media/padding.css';
import './media/roundedCorners.css';
import './media/statusBar.css';
import './media/tabs.css';
import './media/activityBar.css';

/** Applies the selected Workbench layout style to the main and auxiliary windows. */
export class ModernUIContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.modernUI';

	private readonly auxiliaryWindows = new Set<IAuxiliaryWindow>();
	private readonly auxiliaryWindowListeners = this._register(new DisposableMap<number, IDisposable>());

	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly layoutStyleService: IWorkbenchLayoutStyleService,
		auxiliaryWindowService: IAuxiliaryWindowService,
	) {
		super();
		this.applyTo(layoutStyleService.container, this.getStyle());
		this._register(auxiliaryWindowService.onDidOpenWindow(window => this.addAuxiliaryWindow(window)));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle)) this.update();
		}));
		this._register(toDisposable(() => {
			this.clear(layoutStyleService.container);
			for (const window of this.auxiliaryWindows) {
				this.clear(window.container);
			}
			this.auxiliaryWindows.clear();
		}));
		this.update();
	}

	private update(): void {
		const style = this.getStyle();
		this.layoutStyleService.setLayoutStyle(style);
		this.applyTo(this.layoutStyleService.container, style);
		for (const window of this.auxiliaryWindows) this.applyTo(window.container, style);
	}

	private addAuxiliaryWindow(window: IAuxiliaryWindow): void {
		if (this.auxiliaryWindows.has(window)) return;
		this.auxiliaryWindows.add(window);
		this.applyTo(window.container, this.getStyle());
		this.auxiliaryWindowListeners.set(window.id, window.onDidClose(() => {
			this.auxiliaryWindowListeners.deleteAndDispose(window.id);
			this.auxiliaryWindows.delete(window);
		}));
	}

	private applyTo(container: HTMLElement, style: WorkbenchLayoutStyle): void {
		container.setAttribute('data-layout-style', style);
		container.classList.toggle('modern-ui', style === 'modern');
	}

	private clear(container: HTMLElement): void {
		container.removeAttribute('data-layout-style');
		container.classList.remove('modern-ui');
	}

	private getStyle(): WorkbenchLayoutStyle {
		return this.configurationService.getValue(WorkbenchConfiguration.layoutStyle);
	}
}

registerWorkbenchContribution(ModernUIContribution.ID, WorkbenchPhase.BlockRestore, accessor => new ModernUIContribution(
	accessor.get(IConfigurationService),
	accessor.get(IWorkbenchLayoutStyleService),
	accessor.get(IAuxiliaryWindowService),
));
