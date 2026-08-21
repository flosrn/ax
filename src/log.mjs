// The one place that decides what a check result looks like.
//
// Before this file the same four helpers were redefined in ofmchat's
// worktree-doctor.sh, docs-ownership.sh and orca/doctor.sh — byte-identical,
// three times — and log()/warn() in six more scripts with only the tag
// differing. Duplicated output is how two checks start disagreeing about what
// "ok" looks like.

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const paint = (code, text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);

export const bold = text => paint('1', text);
export const green = text => paint('32', text);
export const red = text => paint('31', text);
export const yellow = text => paint('33', text);
export const dim = text => paint('90', text);

/** Section header. One per group of checks. */
export function section(title) {
  process.stdout.write(`${title}\n`);
}

export function ok(message) {
  process.stdout.write(`  ${green('✓')} ${message}\n`);
}

export function bad(message) {
  process.stdout.write(`  ${red('✗')} ${message}\n`);
}

export function note(message) {
  process.stdout.write(`  ${dim('·')} ${message}\n`);
}

/** The command that repairs the line above it. Always actionable, never advice. */
export function fix(command) {
  process.stdout.write(`      → ${command}\n`);
}

export function warn(message) {
  process.stderr.write(`${yellow('warning')}: ${message}\n`);
}

export function fatal(message) {
  process.stderr.write(`${red('error')}: ${message}\n`);
  process.exitCode = 1;
}
