# Snapshot

`ash.snapshot` is a preinstalled Browser extension. It owns region selection,
annotations, undo, code-image rendering and their English/Chinese messages.
Its only host import is the public `@ash/sdk`; view code and styles stay inside
this package. The browser package compiler rejects imports outside the package
except the SDK and declared dependencies.

The platform owns screen permissions, acquisition, isolated windows, image output
and global-keybinding leases. Workbench's image-editor service owns Provider
registrations and interaction lifetimes. Chat owns the attachment destination,
draft cancellation, its screenshot command and the existing shortcut preference.
It never imports this package's renderer or executes its script in a Workbench
realm. The extension registers `snapshot.editor` with
`window.registerImageEditorProvider`, through the existing `image.editor.v1`
capability and invocation lifecycle. Retiring that registration cancels its views.
The Browser runtime publishes registration removal to the host; this also applies
when only the Provider's disposable is retired, without stopping the extension.

The SDK audit found reusable commands, configuration, localization and runtime
registration, but no image-editor provider, host-owned image interaction, or
selection snapshot with resolved syntax and font styles. The public additions
cover those gaps: `registerImageEditorProvider`, `showImageEditor`, and their
view/input/completion types. The SDK contains no re-exports of Workbench modules.

## Screen captures

The Chat attachment source and `workbench.action.chat.attachScreenshot` resolve
the registered default editor. Desktop captures every display into native overlay
windows; Browser uses the browser's screen-sharing picker. Pixels go directly to
the extension's opaque view. Region selection, resize, rectangle, arrow, pen,
text, mosaic, undo, retake, copy, save and Add to Chat share the same image editor.
The screenshot command opens independently of Chat. Copy, save and cancel never
open Chat or reserve a draft. Enter copies standalone images; a capture started
from Chat's attachment picker attaches on Enter. Add to Chat remains an explicit
action in both cases.

The default shortcuts remain Control+Command+A on macOS and Control+Alt+S on
Windows/Linux. `screenshot.globalShortcut` keeps its existing key and default.
Disabling the extension removes the global registration and closes active views;
the host does not start a second built-in annotation implementation.

## Code images

Select code and run `snapshot.code` (Snapshot: Create Code Image), also available
in the editor context menu. The command calls `window.showImageEditor`. The host
supplies a read-only selection snapshot containing unsaved text, original line
numbers, resolved token styles and editor font information. It requests no desktop
pixels or screen permission. The extension renders the snapshot into a PNG, then
offers the same annotation and output controls. Accessibility view includes the
selected code as text.
Chat registers its attachment handler with the image-editor service. Captures
started from Chat bind the originating draft before capture, and switching drafts
cancels those captures. Standalone screen and code images acquire the current
destination only after Add to Chat; switching drafts does not cancel them. The
SDK adapter does not invoke Chat commands or construct attachments. The native
image-view platform receives opaque presentation data and has no editor or Chat
dependencies.

This feature references the public behavior of
[CodeSnap for VS Code](https://github.com/kufii/CodeSnap), whose extension uses
public commands and a Webview. The rendering here is independently implemented;
it does not depend on VS Code internals or modify the clipboard to read syntax.

Settings are declared in this package's `package.json`. User values remain in
the profile's `settings.json`. `snapshot.code.*` controls padding, resolution,
background, original/relative line numbers, window controls, title and transparency.
`accessibility.verbosity.chatScreenshot` retains its existing key.
Settings presents separate Screen capture and Code images groups, each with the
current shortcut and a link to its command in Keyboard Shortcuts. Bindings stay
in the profile's `keybindings.json`; changing the background toggle does not
create a second shortcut.

The image view owns one bitmap, selection and annotation history. OCR, translation,
additional editing and sharing can consume this package's image workflow later;
they must use public capabilities for host resources. No unused provider APIs or
placeholder implementations are installed for those future features.

The compact capture toolbar uses icon buttons with localized tooltips and accessible
names. Its package-local WOFF2 is built from the artwork listed in `media/icons.json`;
runtime code never imports host UI modules. Independent icon customization, font
rebuilding and native-window validation follow the
[Snapshot toolbar workflow](../../.agents/skills/svg-icon-font/SKILL.md#snapshot-工具栏独立图标).

The package also owns the macOS screen permission guide, including its application
card, drag instructions, keyboard alternative and translations. The host supplies
the running application's icon and performs the finite native permission actions;
the extension receives neither arbitrary filesystem access nor permission grants.
