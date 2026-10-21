// Keep the upstream standalone server unchanged. The provider owns this pipe;
// EOF also retires Node if the provider is killed before Rust can run Drop.
'use strict';
const adapter = process.argv.splice(2, 1)[0];
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
require(adapter);
