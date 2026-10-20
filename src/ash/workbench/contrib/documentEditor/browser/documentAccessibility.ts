import { addDisposableListener, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, type IDisposable } from '../../../../base/common/lifecycle.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { DocumentEditorPane } from './documentEditorPane.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Document, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('document.accessibility.invalidVerbosity', 'Document accessibility verbosity must be boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('document.accessibility.verbosityTitle', 'Document accessibility help'); },
		get description() { return localize('document.accessibility.verbosityDescription', 'Announce how to open accessibility help when a document receives focus.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		name: 'document', type, priority: 110,
		getProvider(accessor) {
			const editors = accessor.get(IEditorPart);
			const pane = editors.activePane;
			const active = getActiveElement(editors.domNode.ownerDocument);
			if (!(pane instanceof DocumentEditorPane) || !pane.workingCopy || !isHTMLElement(active) || !active.closest('.stanza-structured-editor-pane')) return undefined;
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.Document, { type }, () => type === AccessibleViewType.View
				? pane.workingCopy ? pane.getAccessibleContent() : ''
				: [
					localize('document.accessibility.overview', 'You are editing a structured document. Tab and Shift+Tab move between text blocks and formatting controls. Use the arrow keys inside a text block and the standard undo and redo commands to edit.'),
					localize('document.accessibility.paragraph', 'Paragraph style controls select Normal, Heading 1 through 6, or a custom document style. Enter a style name and choose Create style to capture paragraph formatting. Update style from paragraph updates its references; Delete style retains their appearance. Reset paragraph overrides restores inherited paragraph formatting and keeps character marks. Paragraph controls set fonts, alignment, spacing, start and end indents, and first line or hanging indents. List numbering controls set the start and number format of the active ordered list. These actions support standard undo.'),
					localize('document.accessibility.find', 'Use Ctrl+F or Command+F to open Find and replace. Search crosses character formatting within a block and supports Match case and Whole word. Enter and Shift+Enter move between matches. Replace all is one undo step and preserves other formatting and objects. Escape closes search and returns to the current match. Read-only documents allow search and navigation.'),
					localize('document.accessibility.actions', '<keybinding:workbench.action.files.save> saves the document. New Document creates a general document. Convert Active Text to Document and Convert Active Markdown to Document create separate drafts and preserve the source.'),
					localize('document.accessibility.export', 'Export Document as Markdown or Export Document as Plain Text creates a separate text draft. Markdown conversion reports unsupported content with its source position or node ID.'),
					localize('document.accessibility.close', 'Open Accessible View reads the document as text. Escape closes help or the accessible view and returns focus to the document.'),
				].join('\n\n'),
				() => { if (active.isConnected) active.focus(); else editors.activePane?.focus(); }, AccessibilityVerbositySettingId.Document);
			provider.onDidChangeContent = pane.workingCopy.onDidChangeContent;
			return provider;
		},
	});
}

class DocumentAccessibilityContribution extends Disposable {
	constructor(@ILayoutService layout: ILayoutService, @IAccessibleViewService views: IAccessibleViewService, @IAccessibilityService accessibility: IAccessibilityService) {
		super();
		const listeners = this._register(new DisposableMap<HTMLElement, IDisposable>());
		const synchronize = (): void => {
			const containers = new Set(layout.containers);
			for (const container of listeners.keys()) if (!containers.has(container)) listeners.deleteAndDispose(container);
			for (const container of containers) {
				if (listeners.has(container)) continue;
				listeners.set(container, addDisposableListener(container, 'focusin', event => {
					if (!isHTMLElement(event.target)) return;
					const pane = event.target.closest('.stanza-structured-editor-pane');
					if (!pane || event.relatedTarget instanceof container.ownerDocument.defaultView!.Node && pane.contains(event.relatedTarget)) return;
					if (!accessibility.isScreenReaderOptimized()) return;
					const hint = views.getOpenAriaHint(AccessibilityVerbositySettingId.Document);
					if (hint) accessibility.status(hint);
				}));
			}
		};
		synchronize();
		this._register(layout.onDidChangeActiveContainer(synchronize));
	}
}

registerWorkbenchContribution('workbench.contrib.documentAccessibility', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(DocumentAccessibilityContribution));
