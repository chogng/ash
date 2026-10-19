import { registerEditorContribution } from "../../../registration.js";
import { UnusualLineTerminatorsController } from "./unusualLineTerminatorsController.js";
import { TextDecorationCollection } from "../../../../../../src/ash/editor/common/model/decorationCollection.js";

registerEditorContribution({
	id: "editor.contrib.unusualLineTerminators", install: context => {
		if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
		const decorations = context.register(new TextDecorationCollection<void>(context.model));
		return new UnusualLineTerminatorsController(context.model, decorations);
	}
});
