import { ArtifactCanvasTextEditor } from './text/artifactCanvasTextEditor.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ArtifactCanvasEditorContributionContext, ArtifactCanvasEditorContributionFactory, IArtifactCanvasEditorContributions, IArtifactCanvasCodeContribution, IArtifactCanvasMotionContribution, IArtifactCanvasPrototypeContribution } from './artifactCanvasEditorBrowser.js';
import { ArtifactCanvasView } from './view/artifactCanvasView.js';
import { ArtifactCanvasDrawingController } from './controller/artifactCanvasDrawingController.js';
import { ArtifactCanvasPropertiesWidget } from './properties/artifactCanvasPropertiesWidget.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

let createMotionContribution: ((context: ArtifactCanvasEditorContributionContext) => IArtifactCanvasMotionContribution & IDisposable) | undefined;
let createCodeContribution: ((context: ArtifactCanvasEditorContributionContext, exportCode: () => Promise<void>) => IArtifactCanvasCodeContribution & IDisposable) | undefined;
let createPrototypeContribution: ((context: ArtifactCanvasEditorContributionContext, instantiation: IInstantiationService) => IArtifactCanvasPrototypeContribution & IDisposable) | undefined;

export function registerArtifactCanvasMotionContribution(create: NonNullable<typeof createMotionContribution>): void {
	if (createMotionContribution) throw new Error('The Design motion contribution is already registered');
	createMotionContribution = create;
}

export function registerArtifactCanvasCodeContribution(create: NonNullable<typeof createCodeContribution>): void {
	if (createCodeContribution) throw new Error('The artifact canvas code contribution is already registered');
	createCodeContribution = create;
}

export function registerArtifactCanvasPrototypeContribution(create: NonNullable<typeof createPrototypeContribution>): void {
	if (createPrototypeContribution) throw new Error('The Design prototype contribution is already registered');
	createPrototypeContribution = create;
}

/** Product assembly selects concrete features; the browser editor consumes only their contracts. */
export function createArtifactCanvasEditorContributionFactory(instantiationService: IInstantiationService): ArtifactCanvasEditorContributionFactory {
	return {
		createCanvasView: ownerDocument => instantiationService.createInstance(ArtifactCanvasView, ownerDocument),
		createFeatures: context => createArtifactCanvasEditorContributions(context, instantiationService),
	};
}

function createArtifactCanvasEditorContributions(context: ArtifactCanvasEditorContributionContext, instantiationService: IInstantiationService): IArtifactCanvasEditorContributions {
	if (!createCodeContribution) throw new Error('The artifact canvas code contribution has not been registered');
	if (!createMotionContribution) throw new Error('The Design motion contribution has not been registered');
	if (!createPrototypeContribution) throw new Error('The Design prototype contribution has not been registered');
	const resources = new DisposableStore();
	const { ownerDocument, documentController, commands, selection } = context;
	const exportArtifactCanvas = (format: 'svg' | 'html'): Promise<void> => context.runFileOperation(() => format === 'svg' ? documentController.exportDocument() : documentController.exportDocument({
		title: localize('sessions.design.exportCode', 'Export code'),
		filename: 'design.html',
		extension: 'html',
		content: code.getSource(),
	}));
	const text = resources.add(instantiationService.createInstance(ArtifactCanvasTextEditor, context));
	const drawing = resources.add(new ArtifactCanvasDrawingController({ ...context, editText: id => text.edit(id) }, commands));
	const code = resources.add(createCodeContribution(context, () => exportArtifactCanvas('html')));
	const properties = resources.add(instantiationService.createInstance(ArtifactCanvasPropertiesWidget, ownerDocument, documentController, commands, selection, () => context.renderCanvas(), exportArtifactCanvas, text, () => context.focusCanvas()));
	const prototype = resources.add(createPrototypeContribution(context, instantiationService));
	if (documentController.mode === ArtifactWorkspaceId.Prototype) { properties.domNode.insertBefore(prototype.domNode, properties.domNode.children[1]); } else { properties.domNode.append(prototype.domNode); }
	const motion = resources.add(createMotionContribution(context));
	return Object.assign(resources, { drawing, properties, motion, code, prototype, text });
}
