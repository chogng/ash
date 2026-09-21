import { LanguageWorkerWireServer } from '../languages/languageWorkerWire.js';
import { start } from '../../editor.worker.start.js';
import { EditorWorker } from './editorWebWorker.js';
import { editorWorkerWireCodec } from './editorWorkerWire.js';

start(({ port, resources }) => {
	resources.add(new LanguageWorkerWireServer(port, editorWorkerWireCodec, new EditorWorker()));
});
