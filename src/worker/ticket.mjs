// The ticket half of `ax worker dispatch`: everything that happens BEFORE anything
// is created, because every failure here is one a child would have inherited.
//
// A brief whose ticket line is empty sends a child to improvise — the 2026-08-01
// failure, where three worktrees ran without ever reading their brief. So the
// ticket is read here, by name, and a read that does not answer stops the dispatch
// instead of producing a session pointing at nothing.
//
// Nothing in this module writes, mutates or prints. It answers questions and
// returns refusal TEXT; the verb decides what to do with it, and `src/log.mjs`
// is the only thing that puts it on a stream.
//
// Every machine-facing call is injected: `run` is a `createRunner` product for
// the Orca CLI, `exec(bin, args, cwd)` is `gh` and `git`. That is what lets the
// suite decide these propositions with no tracker credential and no network.

import { defaultExec } from '../exec.mjs';

/**
 * `GAP-353` is a Linear ref, `1234` a GitHub issue. Both are anchored: the ref
 * has to BE one of the two grammars, never merely contain one. Anything else
 * returns null so the caller refuses, because guessing a tracker from a
 * free-form string is how a brief ends up pointing at nothing.
 */
const LINEAR = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const GITHUB = /^[0-9]+$/;

export function ticketKind(ref) {
  const text = String(ref ?? '');
  if (LINEAR.test(text)) return 'linear';
  if (GITHUB.test(text)) return 'github';
  return null;
}

/**
 * A slug that repeats the ticket ref, corrected rather than refused.
 *
 * The request id is built as `<ticket>-<slug>`, so the repetition doubles.
 * Measured on the first real use, 2026-08-15: `--slug GAP-356-cache-components`
 * produced the branch `feat/gap-356-gap-356-cache-components`. The intent is
 * unambiguous, so this normalises — but it returns the correction in `note`,
 * because a silent correction to a NAME is the other way to be wrong about it:
 * the name is what the operator will later search for.
 *
 * Comparison is case-insensitive (`gap-356` is the same ref as `GAP-356`), and
 * the slug is sliced by the ref's LENGTH, so the surviving text keeps the case
 * the operator typed.
 */
export function normalizeSlug(ref, slug) {
  const given = String(slug ?? '');
  const refText = String(ref ?? '');
  if (given === '' || refText === '') return { slug: given, note: '' };

  const lower = given.toLowerCase();
  const refLower = refText.toLowerCase();
  const carries = `(the request id already carries ${refText})`;

  if (lower === refLower) {
    return { slug: '', note: `--slug was just the ticket ref; dropping it ${carries}` };
  }
  if (lower.startsWith(`${refLower}-`)) {
    const kept = given.slice(refText.length + 1);
    return { slug: kept, note: `--slug repeated the ticket ref; using '${kept}' ${carries}` };
  }
  return { slug: given, note: '' };
}

/** The tracker's own error, flattened to one bounded line — never dropped (F-004). */
const detailOf = (...streams) =>
  streams
    .map(text => String(text ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 160);

const unreadable = (ref, where, detail) => ({
  ok: false,
  reason:
    `could not read ${ref} from ${where}${detail ? `: ${detail}` : ''}. ` +
    `Read it by hand first — a dispatch whose ticket line is empty creates a child that improvises.`,
});

/**
 * Label NAMES out of whatever a tracker calls its label container.
 *
 * Three shapes are accepted because three exist: `gh --json labels` answers
 * `[{name}]`, a GraphQL connection answers `{nodes:[{name}]}`, and a plain
 * string list is what a hand-written fixture or a simpler tracker gives. Nothing
 * here throws and nothing here guesses: an unrecognised shape is NO labels, and
 * the caller that consumes them says what it did with an empty list.
 */
function labelNames(container) {
  const list = Array.isArray(container) ? container : Array.isArray(container?.nodes) ? container.nodes : [];
  return list
    .map(label => (typeof label === 'string' ? label : typeof label?.name === 'string' ? label.name : ''))
    .filter(Boolean);
}

/**
 * A ticket reduced to what a brief needs: identifier, title, url, state, the
 * SIZE of its body — and its LABELS.
 *
 * Two trackers, one shape. Linear answers under `result.issue`, GitHub at the
 * top level, and no caller should have to know which — a reader that parses
 * both inline grows a second parser the day a third tracker appears.
 *
 * The body TEXT never comes back. It is the child's to read, on its own host,
 * with the command `readCommand` teaches; only its emptiness is decidable from
 * here (see `emptyBodyRefusal`). Length, not judgement.
 *
 * LABELS ARE NOT DISPLAY. They are the only machine-readable statement a tracker
 * makes about what a ticket TOUCHES, and one consumer needs it before the child
 * exists: a worktree's database is decided by `planWorktree` from the diff of a
 * tree that is still empty, so an issue whose whole subject is the database was
 * provisioned to share the primary checkout's stack. Measured 2026-08-25 on
 * ofmchat #71 (`domain:database`, `domain:security`): the brief demanded an
 * isolated reset and a full pgTAP run, and setup had announced "this worktree
 * does not touch the database".
 */
export function readTicket(ref, { kind = ticketKind(ref), run, exec = defaultExec } = {}) {
  let ident;
  let title;
  let url;
  let state = '';
  let body = '';
  let detail = '';
  let labels = [];

  if (kind === 'linear') {
    if (typeof run !== 'function') {
      return {
        ok: false,
        reason: `no Orca runtime on this host, so ${ref} cannot be read from Linear. Run the dispatch from a host that has the Orca CLI.`,
      };
    }
    const answer = run(['linear', 'issue', String(ref), '--json']);
    const issue = answer?.receipt?.result?.issue ?? {};
    ident = issue.identifier;
    title = issue.title;
    url = issue.url;
    state = issue.state?.name ?? '';
    body = issue.description ?? '';
    labels = labelNames(issue.labels);
    detail = detailOf(answer?.stderr, answer?.receipt?.error, answer?.receipt?.unparseable);
    if (!ident || !title || !url) return unreadable(ref, 'Linear', detail);
  } else if (kind === 'github') {
    const answer = exec('gh', ['issue', 'view', String(ref), '--json', 'title,url,state,body,labels']);
    // `gh` that cannot RUN is its own refusal: the credential, the network and a
    // missing binary need three different repairs, and one message for all three
    // sends the operator looking in the wrong place.
    if (answer?.error) {
      return {
        ok: false,
        reason: `gh cannot run here, so GitHub issue #${ref} cannot be read (${detailOf(answer.error)}). Install the GitHub CLI, or pass a Linear ref.`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(answer?.stdout ?? '');
    } catch {
      parsed = {};
    }
    ident = `#${ref}`;
    title = parsed.title;
    url = parsed.url;
    state = parsed.state ?? '';
    body = parsed.body ?? '';
    labels = labelNames(parsed.labels);
    detail = detailOf(answer?.stderr);
    if (!title || !url) return unreadable(`#${ref}`, 'GitHub', detail);
  } else {
    return {
      ok: false,
      reason: `--issue expects a Linear ref like GAP-353 or a GitHub issue number, got '${ref}'`,
    };
  }

  // `handle` is the address a CHILD can act on, and only GitHub has one: the
  // harness resolves `issue://<n>` as a read, where `https://…/issues/<n>` is a
  // link an agent cannot follow. Linear answers none, so its brief keeps the url.
  // Both surfaces stay honest: `url` remains what the orchestrator's receipt
  // prints for a human.
  return { ok: true, id: ident, title, url, handle: kind === 'github' ? `issue://${ref}` : '', state, bodyLength: String(body).trim().length, labels };
}

/**
 * How the child is told to read its own ticket.
 *
 * BOTH BRANCHES PUT THE THREAD-CARRYING READ FIRST, for one reason: the comments
 * are part of the instruction, not something left to the child's judgement. On a
 * ticket that has been triaged, the rulings, the Agent Brief and every
 * orchestrator amendment live in the thread and nowhere else.
 *
 * `orca linear issue <KEY> --full` was measured broken on this fleet
 * (GAP-372/356/376): it prints a ~350-byte header and reports `Comments: 0` on
 * issues that HAVE comments — so a child obeying it reads a truncated ticket,
 * never sees the thread where half the decisions live, and its own command
 * exits 0. Five dispatches carried that flag before anyone noticed. The MCP read
 * comes first for that reason; the CLI `--json` form is the fallback for a host
 * with no MCP, and it is the only Linear command line here a child can paste.
 *
 * The GitHub branch said `gh issue view <n> --comments` until 2026-08-26, which
 * was a shell call where an internal URL does the same job — and it made THIS
 * package speak two conventions: `src/triage/spec.mjs` has always dispatched on
 * `issue://<n>`, five times over. `issue://<n>` is one `read` returning the body
 * and the whole thread (verified that day on a live triaged issue: four comments,
 * both orchestrator amendments, one call), so it is what a child is told first.
 * The `gh` line stays as the fallback for a session whose harness has no such
 * scheme — it is not a second convention, it is the same read without the URL.
 */
export function readCommand({ kind = 'linear', ref } = {}) {
  if (kind === 'github') {
    // The handle itself is the brief's address line, so this says only what that
    // one read gets you and what to do without the scheme. Repeating the token
    // here put the same string on two consecutive lines of every brief.
    return (
      `the address above is ONE read — body and the whole comment thread, where the rulings and ` +
      `any Agent Brief live. No such scheme in your session: \`gh issue view ${ref} --comments\`.`
    );
  }
  return (
    `Linear MCP \`get_issue\` on ${ref}, then \`list_comments\` on the same issue — the thread ` +
    `carries decisions the description does not. No MCP: ` +
    `\`orca linear issue ${ref} --json | jq -r ".result.issue.description"\`. NEVER \`--full\`: ` +
    `it truncates to a header and reports \`Comments: 0\` on issues that have comments.`
  );
}

/**
 * A ref the work is DEFINED by has to resolve on `origin`, proved before
 * anything is created.
 *
 * Measured 2026-08-14: the nine Makerkit `v4-step/*` tags existed solely in one
 * Mac's clone, pulled from a paid private third-party remote the other host has
 * neither a remote nor a credential for. A child placed there was therefore
 * defined by a merge it could not perform, and nothing noticed — disk,
 * habitability, context file and marker all proved true while the one
 * indispensable object was missing. `ls-remote` answers for every host at once,
 * which is why this asks origin instead of ssh-ing into the target: a ref on
 * origin is reachable by any clone of it, including hosts this dispatch has never
 * seen.
 */
export function needsRef(ref, { exec = defaultExec, cwd = process.cwd() } = {}) {
  const wanted = String(ref ?? '');
  if (wanted === '') return { ok: true };

  // `ls-remote` takes PATTERNS: `*` matches every ref, exits 0, and would prove
  // that a ref nobody named exists. A ref the work is DEFINED by is one object,
  // so a pattern is refused rather than resolved.
  if (/[*?[\]]/.test(wanted)) {
    return {
      ok: false,
      reason: `--needs-ref '${wanted}' is a pattern, not a ref. \`git ls-remote\` matches patterns and would answer 0 for any ref at all, which proves nothing about the one this work is defined by. Name the ref itself.`,
    };
  }

  const answer = exec('git', ['ls-remote', '--exit-code', '--refs', 'origin', wanted], cwd);
  // Exactly one ref came back, because `--exit-code` alone only proves the
  // pattern matched SOMETHING.
  const named = String(answer?.stdout ?? '')
    .split('\n')
    .map(line => line.trim().split(/\s+/)[1] ?? '')
    .filter(Boolean);
  if (!answer?.error && answer?.status === 0 && named.length === 1) return { ok: true };

  return {
    ok: false,
    reason: `--needs-ref '${wanted}' does not resolve on origin, so no host that clones from origin can
resolve it either. A ref that exists only in a local checkout cannot be merged by a child
anywhere else, however capable that host is otherwise.

  git ls-remote --refs origin            # what origin actually carries
  git push origin 'refs/tags/<ns>/*:refs/tags/<ns>/*'
                                         # if the ref is yours to publish and the objects
                                         # already live in the history of that repo`,
  };
}

/** `--task '<task>'   <why>`, from a string or a `{ task, why }` the caller declared. */
function alternateLine(alternate) {
  const { task, why } = typeof alternate === 'string' ? { task: alternate, why: '' } : (alternate ?? {});
  if (!task) return '';
  return `  --task '${task}'${why ? `   ${why}` : ''}`;
}

/**
 * A ticket that READS is not a ticket that is EXECUTABLE — the refusal text, or
 * '' when there is nothing to refuse.
 *
 * The default entry point's own gate needs a decision already made: a plan
 * document it can open and the heading covering this slice, or acceptance
 * criteria complete enough to pin tests. Measured 2026-08-14: GAP-355 was
 * dispatched carrying a body of zero characters, so the plan it was defined by
 * was named nowhere a child could reach, and the only correct thing left for
 * that child was to escalate — after being created.
 *
 * Only EMPTINESS is decidable from here. A body that exists and says nothing is
 * the child's gate to refuse, not this one's. And a caller who passed `--task`
 * has named another entry point on purpose and is not held to this: refusing it
 * would make the one correct route to an undecided ticket unreachable.
 *
 * The alternates come from the caller. No skill name is written here — `ax` runs
 * in repos whose agents answer to verbs it has never heard of.
 */
export function emptyBodyRefusal({ bodyLength, task, id, alternates = [] } = {}) {
  if (task) return '';
  if (Number(bodyLength) > 0) return '';

  const suggestions = alternates.map(alternateLine).filter(Boolean);
  const escape = suggestions.length
    ? suggestions.join('\n')
    : `  --task '<entry point>'   an entry point that does not need a decision already written down`;

  return `${id} reads, but its body is empty. The default entry point starts from a decision that
already exists: a plan document and the heading that covers this slice, or acceptance criteria
complete enough to pin tests. Neither is reachable from an empty ticket, and the child is told
to treat the ticket as canonical — so it would escalate, correctly, after being created.

Write them on the ticket, or name an entry point that does not need them:
${escape}`;
}
