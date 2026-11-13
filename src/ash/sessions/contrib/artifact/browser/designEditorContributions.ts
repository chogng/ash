import { DesignTextEditor } from './text/designTextEditor.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { DesignEditorContributionContext, DesignEditorContributionFactory, IDesignCanvasView, IDesignEditorContributions, IDesignMotionContribution, IDesignPrototypeContribution } from './designEditorBrowser.js';
import { DesignDrawingController } from './controller/designDrawingController.js';
import { DesignPropertiesWidget } from './properties/designPropertiesWidget.js';
import { DesignCodeWidget } from './code/designCodeWidget.js';
import { generateDesignCode } from './code/designCodeGenerator.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

let createCanvasView: ((ownerDocument: Document, instantiation: IInstantiationService) => IDesignCanvasView) | undefined;
let createMotionContribution: ((context: DesignEditorContributionContext) => IDesignMotionContribution & IDisposable) | undefined;
let createPrototypeContribution: ((context: DesignEditorContributionContext, instantiation: IInstantiationService) => IDesignPrototypeContribution & IDisposable) | undefined;

export function registerDesignCanvasView(create: NonNullable<typeof createCanvasView>): void {
	if (createCanvasView) throw new Error('The Design canvas view is already registered');
	createCanvasView = create;
}

export function registerDesignMotionContribution(create: NonNullable<typeof createMotionContribution>): void {
	if (createMotionContribution) throw new Error('The Design motion contribution is already registered');
	createMotionContribution = create;
}

export function registerDesignPrototypeContribution(create: NonNullable<typeof createPrototypeContribution>): void {
	if (createPrototypeContribution) throw new Error('The Design prototype contribution is already registered');
	createPrototypeContribution = create;
}

/** Product assembly selects concrete features; the browser editor consumes only their contracts. */
export function createDesignEditorContributionFactory(instantiationService: IInstantiationService): DesignEditorContributionFactory {
	const canvas = createCanvasView;
	if (!canvas) throw new Error('The Design canvas view has not been registered');
	return {
		createCanvasView: ownerDocument => canvas(ownerDocument, instantiationService),
		createFeatures: context => createDesignEditorContributions(context, instantiationService),
	};
}

function createDesignEditorContributions(context: DesignEditorContributionContext, instantiationService: IInstantiationService): IDesignEditorContributions {
	if (!createMotionContribution) throw new Error('The Design motion contribution has not been registered');
	if (!createPrototypeContribution) throw new Error('The Design prototype contribution has not been registered');
	const resources = new DisposableStore();
	const { ownerDocument, documentController, commands, selection } = context;
	const exportDesign = (format: 'svg' | 'html'): Promise<void> => context.runFileOperation(() => format === 'svg' ? documentController.exportDocument() : documentController.exportDocument({
		title: localize('sessions.design.exportCode', 'Export code'),
		filename: 'design.html',
		extension: 'html',
		content: generateDesignCode(documentController.model.value, documentController.getEmbeddedImageSources()),
	}));
	const text = resources.add(instantiationService.createInstance(DesignTextEditor, context));
	const drawing = resources.add(new DesignDrawingController({ ...context, editText: id => text.edit(id) }, commands));
	const properties = resources.add(instantiationService.createInstance(DesignPropertiesWidget, ownerDocument, documentController, commands, selection, () => context.renderCanvas(), exportDesign, text, () => context.focusCanvas()));
	const prototype = resources.add(createPrototypeContribution(context, instantiationService));
	if (documentController.mode === ArtifactWorkspaceId.Prototype) { properties.domNode.insertBefore(prototype.domNode, properties.domNode.children[1]); } else { properties.domNode.append(prototype.domNode); }
	const motion = resources.add(createMotionContribution(context));
	const code = resources.add(new DesignCodeWidget(ownerDocument, documentController, () => exportDesign('html')));
	return Object.assign(resources, { drawing, properties, motion, code, prototype, text });
}
