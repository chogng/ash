import { bindColorTheme } from "../../../platform/theme/browser/themeStyles.js";
import { darkColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { lightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import type { IThemeService } from "../../../platform/theme/common/themeService.js";
import type { IColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { Emitter } from "../../../base/common/event.js";
import { combinedDisposable } from "../../../base/common/lifecycle.js";
import { toDisposable } from "../../../base/common/lifecycle.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";

const DarkColorSchemeQuery = "(prefers-color-scheme: dark)";

/** Projects a system-matched Ash color theme into a standalone Sessions page. */
export function bindSessionsTheme(root: HTMLElement): IDisposable {
	const ownerWindow = root.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error("Sessions theme requires an owner window");
	const systemColorScheme = ownerWindow.matchMedia(DarkColorSchemeQuery);
	const themeChanges = new Emitter<IColorTheme>();
	const themeService: IThemeService = {
		onDidColorThemeChange: themeChanges.event,
		getColorTheme: () => selectTheme(systemColorScheme),
	};
	const handleSystemColorSchemeChange = (): void => themeChanges.fire(themeService.getColorTheme());
	systemColorScheme.addEventListener("change", handleSystemColorSchemeChange);
	return combinedDisposable(
		themeChanges,
		bindColorTheme(themeService, root),
		toDisposable(() => systemColorScheme.removeEventListener("change", handleSystemColorSchemeChange)),
	);
}

function selectTheme(systemColorScheme: MediaQueryList) {
	return systemColorScheme.matches ? darkColorTheme : lightColorTheme;
}
