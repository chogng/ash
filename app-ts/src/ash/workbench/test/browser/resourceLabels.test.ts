import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind } from '../../../platform/files/common/files.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { LabelService } from '../../../platform/label/common/labelService.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { FileLabelDecorationService } from '../../services/labels/browser/fileLabelDecorationService.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels, type IResourceIconRenderer } from '../../browser/labels.js';

test('ResourceLabels formats files and reacts to icon and decoration changes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root = URI.file('C:\\project');
	const resource = URI.file('C:\\project\\src\\main.ts');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using decorations = new FileLabelDecorationService();
	using labelService = new LabelService(workspace, OperatingSystem.Linux);
	const iconThemeChange = new Emitter<void>();
	const resourceIconRenderer: IResourceIconRenderer = {
		onDidChangeResourceIcons: iconThemeChange.event,
		renderFileIcon: (_resource, container) => {
			container.classList.add('test-file-icon');
			container.textContent = 'T';
		},
	};
	using labels = new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
		workspaceContextService: workspace,
		resourceIconRenderer,
		fileLabelDecorationService: decorations,
		labelService,
	});
	const label = labels.create(dom.window.document.body);
	let decorationChanges = 0;
	using decorationListener = labels.onDidChangeDecorations(() => decorationChanges += 1);
	label.setFile(resource, {
		fileKind: FileKind.File,
		fileDecorations: { colors: true, badges: true },
	});

	assert.equal(label.element.querySelector('.ash-icon-label-text')?.textContent, 'main.ts');
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'src');
	assert.equal(label.element.querySelector('.test-file-icon')?.textContent, 'T');

	decorations.setDecoration(resource, { colorClassName: 'test-color', strikethrough: true });
	assert.equal(label.element.classList.contains('test-color'), true);
	assert.equal(label.element.classList.contains('strikethrough'), true);
	assert.equal(decorationChanges, 1);

	using formatter = labelService.registerFormatter({
		scheme: 'file',
		format: candidate => `formatted:${candidate.path}`,
	});
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'formatted:/C:/project/src/');
	formatter.dispose();
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'src');

	iconThemeChange.fire();
	assert.equal(label.element.querySelector('.test-file-icon')?.textContent, 'T');

	dom.window.close();
});

test('Workspace labels use the closest folder for nested resources', () => {
	const root = URI.file('/project');
	const nested = URI.file('/project/src');
	using workspace = new WorkspaceContextService({
		id: 'workspace',
		configuration: URI.file('/project.code-workspace'),
		folders: [
			{ id: 'root', uri: root, name: 'project', index: 0 },
			{ id: 'nested', uri: nested, name: 'src', index: 1 },
		],
	});
	using labels = new LabelService(workspace, OperatingSystem.Linux);
	const resource = URI.file('/project/src/main.ts').withQuery('preview');

	assert.equal(workspace.getWorkspaceFolder(resource)?.id, 'nested');
	assert.equal(labels.getUriLabel(resource, { relative: true }), 'src • main.ts');
	assert.equal(workspace.getWorkspaceFolder(URI.file('/project/src-other/main.ts'))?.id, 'root');
	assert.equal(workspace.getWorkspaceFolder(URI.file('/elsewhere/main.ts')), null);
});
