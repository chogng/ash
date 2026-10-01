# Theme resource provenance

The Visual Studio dark, light, and high-contrast theme data in this package originates from the
sibling VS Code source tree (`extensions/theme-defaults`) and remains subject to the upstream
Microsoft MIT license. Their syntax rules are shared through package-relative `include` files.
The four `ash-*` documents contain Ash window colors and include those same syntax rules.
Ash extends the shared keyword and constant color rules to cover ignore-rule negation,
wildcards, character classes and escapes, so these remain distinct from plain text
in dark, light and high-contrast themes.

`ExtensionColorThemeService` validates the documents and registers selectable Workbench color
themes. The active theme supplies TextMate token styles. The upstream MIT license text is shipped
at `ash-resources/licenses/vscode/LICENSE.txt` by both package builders.
