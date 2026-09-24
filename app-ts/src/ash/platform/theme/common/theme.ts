/** Color scheme used by the operating system and color themes. */
export enum ColorScheme {
	Dark = "dark",
	Light = "light",
	HighContrastDark = "high-contrast-dark",
	HighContrastLight = "high-contrast-light",
}

export function isDarkColorScheme(scheme: ColorScheme): boolean {
	return scheme === ColorScheme.Dark ||
		scheme === ColorScheme.HighContrastDark;
}
