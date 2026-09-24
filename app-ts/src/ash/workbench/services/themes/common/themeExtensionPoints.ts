import { Emitter } from '../../../../base/common/event.js';
import { type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IWorkbenchFileIconTheme } from './workbenchThemeService.js';

class WorkbenchFileIconThemeRegistry {
	private readonly changed = new Emitter<void>();
	private readonly registrations = new Map<object, readonly IWorkbenchFileIconTheme[]>();
	public readonly onDidChange = this.changed.event;

	public getThemes(): readonly IWorkbenchFileIconTheme[] {
		return [...this.registrations.values()].flat();
	}

	public registerThemes(): IDisposable & { replace(themes: readonly IWorkbenchFileIconTheme[]): void } {
		const owner = {};
		let disposed = false;
		const registration = toDisposable(() => {
			disposed = true;
			if (this.registrations.delete(owner)) {
				this.changed.fire();
			}
		});
		return Object.assign(registration, { replace: (themes: readonly IWorkbenchFileIconTheme[]): void => {
			if (disposed) {
				throw new ReferenceError('File icon theme registration is disposed');
			}
			const ids = new Set<string>();
			for (const [other, values] of this.registrations) {
				if (other !== owner) {
					for (const theme of values) {
						ids.add(theme.id);
					}
				}
			}
			for (const theme of themes) {
				if (ids.has(theme.id)) {
					throw new Error(`Duplicate file icon theme: ${theme.id}`);
				}
				ids.add(theme.id);
			}
			this.registrations.set(owner, Object.freeze([...themes]));
			this.changed.fire();
		} });
	}
}

export const WorkbenchFileIconThemesRegistry = new WorkbenchFileIconThemeRegistry();

