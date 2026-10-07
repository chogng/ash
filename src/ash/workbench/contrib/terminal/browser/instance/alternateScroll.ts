const ALTERNATE_SCROLL_MODE = 1007;

type TerminalScreen = 'normal' | 'alternate';
type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
type TerminalParameters = ArrayLike<number | readonly number[]>;

/** Tracks xterm alternate-scroll control sequences that xterm.js does not expose as a mode. */
export class AlternateScrollMode {
	private enabled = true;
	private saved: boolean | undefined;

	public set(parameters: TerminalParameters, enabled: boolean): void {
		if (hasAlternateScroll(parameters)) {
			this.enabled = enabled;
		}
	}

	public save(parameters: TerminalParameters): void {
		if (hasAlternateScroll(parameters)) {
			this.saved = this.enabled;
		}
	}

	public restore(parameters: TerminalParameters): void {
		if (hasAlternateScroll(parameters) && this.saved !== undefined) {
			this.enabled = this.saved;
			this.saved = undefined;
		}
	}

	public shouldProcessWheel(screen: TerminalScreen, mouseTracking: MouseTrackingMode): boolean {
		return screen !== 'alternate' || mouseTracking !== 'none' || this.enabled;
	}
}

function hasAlternateScroll(parameters: TerminalParameters): boolean {
	for (let index = 0; index < parameters.length; index++) {
		if (parameters[index] === ALTERNATE_SCROLL_MODE) {
			return true;
		}
	}
	return false;
}
