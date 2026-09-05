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

/**
 * A payload, not a message: the record a caller reads or pipes. No glyph, no
 * indent, nothing prepended — a verb that prints JSON must print JSON, and it
 * must print it through this file like every other emission, so redaction and
 * the stream choice stay decided in one place.
 */
export function raw(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * One line about ax's own machinery — armed, not armed — on stderr, so stdout
 * stays the payload above. Unlike `warn` it carries no tag: these lines are
 * read by an operator watching a dispatch scroll past, not triaged later.
 */
export function status(message) {
  process.stderr.write(`${message}\n`);
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

/**
 * A refusal and its repair, on STDERR, for a verb whose stdout is a payload.
 *
 * `bad`/`fix` write to stdout, which is correct for a doctor and wrong for
 * `ax worker transcript --dispatch-proof`: a remote reader takes the first
 * stdout line as the proof, so a finding printed there would be parsed as one.
 * Before this existed that branch printed NOTHING at all — measured 2026-09-05
 * on #204, exit 1 with both streams empty, and an ambiguous needle, a request
 * with no record and a dispatch with two owners were indistinguishable to the
 * caller that ran it.
 *
 * ONE call carries both halves because the alternative is the rule AGENTS.md
 * states ("a `bad` without a `fix` is a finding neither an agent nor a human
 * can act on") re-broken on a second stream: `command` has no default, so a
 * refusal here cannot be emitted without naming what repairs it.
 */
export function refuse(message, command) {
  process.stderr.write(`  ${red('✗')} ${message}\n`);
  process.stderr.write(`      → ${command}\n`);
}

export function warn(message) {
  process.stderr.write(`${yellow('warning')}: ${message}\n`);
}

export function fatal(message) {
  process.stderr.write(`${red('error')}: ${message}\n`);
  process.exitCode = 1;
}
