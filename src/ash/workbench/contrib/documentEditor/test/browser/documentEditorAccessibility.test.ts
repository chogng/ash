import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/documentEditor.contribution.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import type { IDocumentAccessibleEditor } from '../../browser/documentEditorAccessibility.js';

test('document focus hints use the editor accessibility contract across product-owned surfaces', () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const root = document.createElement('section');
	const first = document.createElement('button');
	const second = document.createElement('button');
	const outside = document.createElement('button');
	root.append(first, second);
	document.body.append(root, outside);
	lifetime.add(toDisposable(() => { root.remove(); outside.remove(); }));
	const announcements: string[] = [];
	let pane: IDocumentAccessibleEditor | undefined = {
		containsAccessibilityFocus: (target: HTMLElement) => root.contains(target),
		getAccessibleContent: () => 'Document content',
		getAccessibilityHelp: () => ['Document help'],
	} as unknown as IDocumentAccessibleEditor;
	services.registerInstance(IEditorPart, { get activePane() { return pane; } } as IEditorPart);
	services.registerInstance(ILayoutService, { containers: [document.body], onDidChangeActiveContainer: Event.None } as unknown as ILayoutService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Open document help' } as unknown as IAccessibleViewService);
	services.registerInstance(IAccessibilityService, {
		isScreenReaderOptimized: () => true,
		status: (message: string) => { announcements.push(message); },
	} as unknown as IAccessibilityService);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.documentAccessibility']);
	host.advance(WorkbenchPhase.AfterRestored);
	first.focus();
	second.focus();
	assert.deepEqual(announcements, ['Open document help']);
	outside.focus();
	first.focus();
	assert.deepEqual(announcements, ['Open document help', 'Open document help']);
	outside.focus();
	pane = undefined;
	first.focus();
	assert.equal(announcements.length, 2);
});
