import { ManagedStyleSheet } from '../../../src/ash/base/browser/domStylesheets.js';
import { DisposableStore, type IDisposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { ColorScheme } from '../../../src/ash/platform/theme/common/theme.js';
import type { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { generateColorThemeCSS } from '../../../src/ash/workbench/services/themes/browser/colorThemeCss.js';

let nextThemeRoot = 0;

/** Mounts a fake theme service for component fixtures; product hosts own their styles themselves. */
export function bindTestColorTheme(service: IThemeService, target: HTMLElement, scopeSelector?: string): IDisposable {
	const resources = new DisposableStore();
	const attribute = 'data-test-theme-root';
	const previousRoot = target.getAttribute(attribute);
	const id = String(++nextThemeRoot);
	target.setAttribute(attribute, id);
	const attributes = ['data-color-theme', 'data-color-scheme'].map(name => [name, target.getAttribute(name)] as const);
	const classes = ['hc-black', 'hc-light', 'ash-high-contrast'].map(name => [name, target.classList.contains(name)] as const);
	const styles = resources.add(new ManagedStyleSheet(target.ownerDocument));
	const apply = (): void => {
		const theme = service.getColorTheme();
		styles.setText(generateColorThemeCSS(theme, scopeSelector ?? `[${attribute}="${id}"]`).code);
		target.setAttribute('data-color-theme', theme.id);
		target.setAttribute('data-color-scheme', theme.colorScheme);
		target.classList.toggle('hc-black', theme.colorScheme === ColorScheme.HighContrastDark);
		target.classList.toggle('hc-light', theme.colorScheme === ColorScheme.HighContrastLight);
		target.classList.toggle('ash-high-contrast', theme.colorScheme === ColorScheme.HighContrastDark || theme.colorScheme === ColorScheme.HighContrastLight);
	};
	apply();
	resources.add(service.onDidColorThemeChange(apply));
	resources.add(toDisposable(() => {
		if (previousRoot === null) target.removeAttribute(attribute);
		else target.setAttribute(attribute, previousRoot);
		for (const [name, value] of attributes) {
			if (value === null) target.removeAttribute(name);
			else target.setAttribute(name, value);
		}
		for (const [name, present] of classes) target.classList.toggle(name, present);
	}));
	return resources;
}
