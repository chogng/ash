import { LanguageWorkerWireServer } from '../../common/languages/languageWorkerWire.js';
import { start } from '../../editor.worker.start.js';
import { EditorWorkerRequestExecutor } from '../../common/services/editorWorkerRequestExecutor.js';
import { editorWorkerWireCodec } from '../../common/services/editorWorkerWire.js';

start(({ port, resources }) => {
	resources.add(new LanguageWorkerWireServer(port, editorWorkerWireCodec, new EditorWorkerRequestExecutor()));
});
