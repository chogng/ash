import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';

interface ComponentFixtureContext {
	readonly container: HTMLElement;
	readonly disposableStore: DisposableStore;
	readonly theme: IColorTheme;
}

interface ComponentFixture {
	readonly labels?: readonly string[];
	readonly render: (context: ComponentFixtureContext) => readonly HTMLElement[] | Promise<readonly HTMLElement[]>;
}

export interface ThemedFixture extends ComponentFixture {
	readonly id: string;
	readonly name: string;
	readonly theme: IColorTheme;
}

/** Marks actual component roots for computed-style and screenshot sampling. */
export function defineComponentFixture(options: ComponentFixture): ComponentFixture {
	return {
		labels: options.labels ?? [],
		render: async context => {
			const roots = await options.render(context);
			if (!roots.length) throw new Error('A component fixture must expose at least one rendered root');
			for (const [index, root] of roots.entries()) {
				if (!root.isConnected || root.ownerDocument !== context.container.ownerDocument) throw new Error('Fixture roots must belong to the rendered document');
				root.dataset.fixtureTarget = String(index);
			}
			return roots;
		},
	};
}

/** Expands each named scenario across all four product color schemes. */
export function defineThemedFixtureGroup(options: { readonly path: string; }, scenarios: Readonly<Record<string, ComponentFixture>>): readonly ThemedFixture[] {
	return Object.entries(scenarios).flatMap(([name, fixture]) =>
		[darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme].map(theme => ({
			...fixture, id: `${options.path}${name}/${theme.id}`, name, theme,
		})));
}
