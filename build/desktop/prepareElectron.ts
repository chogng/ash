import { resolve } from 'node:path';
import { prepareDevelopmentElectron } from './electron.ts';

if (process.argv.length > 2) throw new Error('Usage: prepareElectron.ts');
console.log(prepareDevelopmentElectron(resolve(import.meta.dirname, '../..')));
