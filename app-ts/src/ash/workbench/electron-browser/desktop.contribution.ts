import {
	registerAction2,
} from "../../platform/actions/common/actions.js";
import {
	ToggleDeveloperToolsAction,
} from "./actions/developerActions.js";
import { OpenFolderAction } from "./actions/workspaceActions.js";

registerAction2(ToggleDeveloperToolsAction);
registerAction2(OpenFolderAction);
