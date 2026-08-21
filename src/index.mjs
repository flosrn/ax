// The package's public surface, kept deliberately small.
//
// Everything else under `src/` is internal: the CLI reaches it by relative
// path, and a consumer that imports it is coupling to a layout that will move.
// What is exported here is what a project's OWN scripts legitimately need in
// order to agree with the CLI rather than approximate it.
//
// `envFiles` sits beside the reader for one reason: reading the right grammar
// from the wrong list of files is the same bug as reading the wrong grammar.
// Next's documented lookup order is not obvious, and a consumer that guesses it
// disagrees with both this package and the framework.

export { parseValue, readKey, readConfigured, writeBlock, removeBlock } from './dotenv.mjs';
export { envFiles } from './worktree/probes.mjs';
export { loadConfig, loadCheckoutConfig, repoPaths, CONFIG_FILE, version } from './config.mjs';
