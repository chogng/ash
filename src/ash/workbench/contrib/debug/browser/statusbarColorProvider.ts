import '../../../common/theme.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { localize } from '../../../../nls.js';
import { IDebugService } from '../common/debug.js';

const background = registerColor(
	'statusBar.debuggingBackground',
	{ dark: '#6e3d19', light: '#f3d5bb', hcDark: 'statusBar.background', hcLight: 'statusBar.background' },
	{ owner: 'debug', description: localize('debug.statusBackground', 'Status bar background during debugging.') },
);
const foreground = registerColor(
	'statusBar.debuggingForeground',
	{ dark: '#ffffff', light: '#302014', hcDark: 'statusBar.foreground', hcLight: 'statusBar.foreground' },
	{ owner: 'debug', description: localize('debug.statusForeground', 'Status bar foreground during debugging.') },
);
const border = registerColor(
	'statusBar.debuggingBorder',
	{ dark: null, light: null, hcDark: 'contrastBorder', hcLight: 'contrastBorder' },
	{ owner: 'debug', description: localize('debug.statusBorder', 'Status bar border during debugging.') },
);

export class StatusBarColorProvider extends Disposable {
	private readonly style = this._register(new MutableDisposable<IDisposable>());

	constructor(@IDebugService debug: IDebugService, @IStatusbarService statusbar: IStatusbarService) {
		super();
		const update = (): void => {
			const active = debug.sessions.some(
				session =>
					session.sessionOptions?.noDebug !== true &&
					session.resolvedConfiguration?.arguments.noDebug !== true &&
					session.state !== 'terminated' &&
					session.state !== 'error',
			);
			if (active && !this.style.value)
				this.style.value = statusbar.overrideStyle({ priority: 10, foreground, background, border });
			else if (!active) this.style.clear();
		};
		this._register(debug.onDidChangeSession(update));
		update();
	}
}
