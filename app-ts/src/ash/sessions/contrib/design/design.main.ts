import { DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { DesignEditorContributionContext, IDesignEditorContributions } from './browser/designEditorBrowser.js';
import { DesignDrawingController } from './contrib/drawing/browser/designDrawingController.js';
import { DesignPropertiesWidget } from './contrib/properties/browser/designPropertiesWidget.js';
import { DesignMotionWidget } from './contrib/motion/browser/designMotionWidget.js';
import { DesignCodeWidget } from './contrib/code/browser/designCodeWidget.js';
import { generateDesignCode } from './contrib/code/browser/designCodeGenerator.js';

/** Product assembly selects concrete features; the browser editor consumes only their contracts. */
export function createDesignEditorContributions(context: DesignEditorContributionContext): IDesignEditorContributions {
	const resources = new DisposableStore();
	const { ownerDocument, documentController, commands, selection } = context;
	const drawing = resources.add(new DesignDrawingController(context, commands));
	const properties = resources.add(new DesignPropertiesWidget(ownerDocument, documentController, commands, selection, () => context.renderCanvas()));
	const motion = resources.add(new DesignMotionWidget(ownerDocument, documentController.model, commands));
	const code = resources.add(new DesignCodeWidget(ownerDocument, () => context.runFileOperation(() => documentController.exportDocument({
		title: localize('sessions.design.exportCode', 'Export code'),
		filename: 'design.html',
		extension: 'html',
		content: generateDesignCode(documentController.model.value),
	}))));
	return Object.assign(resources, { drawing, properties, motion, code });
}
