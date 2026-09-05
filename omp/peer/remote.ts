// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * THE REPORT IS ON THE HOST THE RECORD NAMES, and this is the boundary that
 * goes and gets it.
 *
 * A dispatch placed with `--on <env>` runs its worker in a worktree on that
 * host, and the Report it writes is a file over there. `./completion.ts` used to
 * stop at that fact and name it: "Report inaccessible from this host". Honest,
 * and avoidable — the project's own declaration already carries how ax reaches
 * that host (`dispatch.hosts.<env>.ssh`), which is the same argument #76 made
 * for `ax worker ls` asking a remote host for its own terminal list.
 *
 * WHAT MUST NEVER HAPPEN is the shortcut: every worktree tree is laid out
 * identically, so the derived path usually EXISTS on this machine and holds
 * another slice's file. So the host is not a formatting detail on the way to a
 * local read; it is part of the address. The record decides both — the recorded
 * argv's `--on` (`./route.ts`), the recorded worktree effect and the recorded
 * request (`./completion.ts`) — and `payload.reportPath` decides neither.
 *
 * THE TRANSPORT IS THE ONE `proveHost` ALREADY USES (`src/worker/hosts.mjs`):
 * closed ssh target grammar, `--` to end option parsing, `BatchMode=yes`, and
 * every value that crosses into the remote command POSIX-quoted, because
 * everything after the target is rejoined by ssh into one string and handed to a
 * shell. One round trip, and it is SYNCHRONOUS inside the receive loop — the
 * receiver appends this block to a message it is about to inject — so the
 * deadline is short by design. A completion must not hang the session it
 * annotates; a slow host produces a named inability, which is the same outcome
 * as an unreachable one and costs the orchestrator nothing but the wait.
 *
 * THE ANSWER'S SHAPE, and why it is not just `cat`:
 *
 *   AX-REPORT/1 worktree <realpath>     the host's own resolution
 *   AX-REPORT/1 file <realpath>         the host's own resolution
 *   AX-REPORT/1 bytes                   the fence; everything after it is payload
 *   <base64>
 *
 * or exactly one refusal token in place of the fence. Header lines are read ONLY
 * from before the FIRST fence, so a child that writes `AX-REPORT/1 file
 * /etc/shadow` into its own Report cannot forge one: its text is payload by
 * position, whatever it says.
 *
 * BASE64, so stdout stays ASCII. The bound the sibling contract puts on a Report
 * is a bound on BYTES, cut at the last newline before anything decodes it
 * (#180), and a raw payload decoded by the ssh reader would already have turned
 * the byte the bound cut in half into U+FFFD. Encoded, the receiver holds the
 * host's bytes exactly and spends the same `boundWindow` on them as on a local
 * descriptor — one bounding rule, not a second one for remote evidence.
 *
 * REALPATH IS THE OWNING HOST'S TO ANSWER. Only that host can resolve its own
 * symlinks, so it reports the two real paths and the receiver decides
 * containment (`./completion.ts` owns that rule, for local and remote alike).
 * `cd -P` plus a bounded `readlink` loop rather than `realpath` or
 * `readlink -f`: neither is on every host, and a probe-and-fall-back would be a
 * second code path answering the same question. The loop is bounded because a
 * symlink cycle is a real shape and an unbounded remote loop is a hung session.
 *
 * The host ALSO refuses to send bytes from a path outside the worktree. That is
 * a transport guard, not the proof: it keeps refused bytes off the wire, while
 * the receiver's own check is what authorizes evidence. Two tests keep them from
 * disagreeing in silence — the composed command runs through a real POSIX shell
 * in `remote.test.ts`, and a lying boundary that returns escaped bytes anyway is
 * refused in `completion.test.ts`.
 *
 * ABSENCE IS NOT A FAULT, AND A FAULT IS NOT AN ABSENCE. `file-absent` is the
 * only answer that means the worker never wrote one, and it is the only one whose
 * repair is aimed at the worker. A path that exists and will not resolve, one
 * that is not a regular file, one that cannot be read: each is a fault on the
 * host, reported as such, because pointing recovery at a worker with no fault in
 * it hides the fault there is.
 *
 * `head -c` AND `base64` ARE PROBED BEFORE USE. A POSIX shell reports a
 * pipeline's exit status from its LAST command, so a missing `head` would deliver
 * an empty payload through a successful `base64` — an empty Report, which is a
 * finding about the worker. The probe turns that into a finding about the host.
 *
 * FAIL CLOSED, ALWAYS. Anything that is not a complete marked answer is a named
 * inability with a repair. Nothing here guesses, and nothing here falls back to
 * a local file.
 */

import { loadCheckoutConfig, repoPaths } from '../../src/config.mjs';
import { run } from '../../src/exec.mjs';
import { hostFor, quote, remote } from '../../src/worker/hosts.mjs';

/** The protocol's own prefix, on every line the host authors and on no other. */
export const MARK = 'AX-REPORT/1';

/**
 * The ssh deadline, and it is not `proveHost`'s 60 s. That budget belongs to a
 * dispatch an operator is waiting on; this one is spent inside a receive loop,
 * on a message that arrived on its own. A host that has not answered in this
 * long is reported as one that did not answer.
 */
const SSH_TIMEOUT_MS = 20_000;

/** Symlink hops before the resolution is called a cycle. Linux's own limit is 40. */
const LINK_HOPS = 40;

/** Base64 as `base64` emits it — wrapped or not, padded or not. Nothing else decodes. */
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The one remote command, composed as program text: every value is quoted, and
 * nothing interpolates a caller's value into it afterwards.
 *
 * Exported because it is the contract `remote.test.ts` runs through a real
 * POSIX shell. That test is the whole reason this is a pure function of three
 * values rather than something assembled inside the ssh call: a shell contract
 * nothing executes offline is a shell contract nobody has run.
 */
export function remoteReadCommand({ worktree, path, cap }) {
  return [
    `w=${quote(worktree)}`,
    `f=${quote(path)}`,
    'n=0',
    // Before anything is read: a pipeline's status is its last command's, so an
    // absent `head` would look like an empty file rather than a missing tool.
    `for t in head base64; do command -v "$t" > /dev/null 2>&1 || { printf '${MARK} tool-missing %s\\n' "$t"; exit 0; }; done`,
    `r=$(CDPATH= cd -P -- "$w" 2> /dev/null && pwd) || r=''`,
    `[ -n "$r" ] || { printf '${MARK} worktree-unresolved\\n'; exit 0; }`,
    `printf '${MARK} worktree %s\\n' "$r"`,
    // Neither a file nor a link here is the ONE absence: the worker wrote none.
    `[ -e "$f" ] || [ -L "$f" ] || { printf '${MARK} file-absent\\n'; exit 0; }`,
    'while [ -L "$f" ]; do',
    `  n=$((n + 1))`,
    `  [ "$n" -le ${LINK_HOPS} ] || { printf '${MARK} file-unresolved ELOOP\\n'; exit 0; }`,
    `  t=$(readlink -- "$f") || { printf '${MARK} file-unresolved readlink\\n'; exit 0; }`,
    '  case "$t" in /*) f=$t ;; *) f=$(dirname -- "$f")/$t ;; esac',
    'done',
    `d=$(CDPATH= cd -P -- "$(dirname -- "$f")" 2> /dev/null && pwd) || d=''`,
    `[ -n "$d" ] || { printf '${MARK} file-unresolved directory\\n'; exit 0; }`,
    'case "$d" in */) f=$d$(basename -- "$f") ;; *) f=$d/$(basename -- "$f") ;; esac',
    // A link that resolved to nothing is an absence, exactly as a local
    // `realpath` answers ENOENT for a dangling one.
    `[ -e "$f" ] || { printf '${MARK} file-absent\\n'; exit 0; }`,
    `[ -f "$f" ] || { printf '${MARK} file-not-regular\\n'; exit 0; }`,
    `[ -r "$f" ] || { printf '${MARK} file-unreadable\\n'; exit 0; }`,
    `printf '${MARK} file %s\\n' "$f"`,
    // The transport guard: refused bytes never leave the host. The receiver's own
    // containment check is the authority, and both are pinned by tests.
    `case "$f" in "$r"/*) ;; *) printf '${MARK} file-outside\\n'; exit 0 ;; esac`,
    `printf '${MARK} bytes\\n'`,
    `head -c ${cap + 1} -- "$f" | base64`,
  ].join('\n');
}

/**
 * `{ worktreeReal, fileReal, buf }` | `{ token }` — what the host said, or the
 * one word for why it said nothing usable.
 *
 * The fence splits authorship: header lines are read only from before the FIRST
 * `bytes` marker, so nothing a child wrote inside its own Report can appear as
 * one. A path carrying a newline would break its own header line and land here
 * as `no-answer`, which is the closed direction.
 */
export function parseRemoteAnswer(stdout, maxBytes) {
  const text = String(stdout ?? '');
  const fence = `${MARK} bytes\n`;
  const at = text.indexOf(fence);
  const header = at === -1 ? text : text.slice(0, at);

  // Two named fields rather than a table: they are the only two the header
  // carries, and a `worktree` line the host never printed must read as absent
  // rather than as an empty path (F-028).
  let worktreeReal;
  let fileReal;
  const tokens = [];
  for (const line of header.split('\n')) {
    if (!line.startsWith(`${MARK} `)) continue;
    const rest = line.slice(MARK.length + 1);
    const gap = rest.indexOf(' ');
    const key = gap === -1 ? rest : rest.slice(0, gap);
    const value = gap === -1 ? '' : rest.slice(gap + 1);
    if (key === 'worktree') worktreeReal = value;
    else if (key === 'file') fileReal = value;
    else tokens.push(value === '' ? key : `${key} ${value}`);
  }
  // A refusal token wins over the fields printed before it: the host prints its
  // worktree as soon as it has one, and then may still refuse.
  if (tokens.length > 0) return { token: tokens[0] };
  if (at === -1) return { token: 'no-answer' };
  // Present-and-empty is not a location: an empty realpath plus `/` contains
  // every absolute path, which is the opposite of a proof.
  if (!worktreeReal || !fileReal) return { token: 'no-answer' };

  // The payload past the fence is the host's bytes, base64. A host that honoured
  // `head -c` sends at most `maxBytes`; one that sent more is a protocol break,
  // and accepting a prefix of it would let an incomplete Report look complete.
  // Length is checked on the raw slice BEFORE compacting or decoding, so a lying
  // seam that returns a megabyte never pays for a second copy of it.
  const payload = text.slice(at + fence.length);
  if (Number.isInteger(maxBytes) && maxBytes > 0) {
    const maxChars = 4 * Math.ceil(maxBytes / 3);
    const wrapSlack = Math.ceil(maxChars / 76) + 8;
    if (payload.length > maxChars + wrapSlack) return { token: 'payload-oversize' };
    const encoded = payload.replace(/\s+/g, '');
    if (!BASE64_ONLY.test(encoded)) return { token: 'payload-corrupt' };
    if (encoded.length > maxChars) return { token: 'payload-oversize' };
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length > maxBytes) return { token: 'payload-oversize' };
    return { worktreeReal, fileReal, buf };
  }
  const encoded = payload.replace(/\s+/g, '');
  if (!BASE64_ONLY.test(encoded)) return { token: 'payload-corrupt' };
  return { worktreeReal, fileReal, buf: Buffer.from(encoded, 'base64') };
}

/** The host declaration governing THIS checkout, or why there is none to read. */
function declarationFor(cwd) {
  const paths = repoPaths(cwd);
  if (paths.root === null)
    return {
      ok: false,
      reason: `nothing at ${cwd} is inside a repository, so no ax.config.json declares how to reach that host`,
      repair:
        'Repair: read the Report on that host by hand — this runtime resolves a declared host from the checkout it is running in, and it is not running in one.',
    };
  const loaded = loadCheckoutConfig(paths);
  if (!loaded.exists)
    return {
      ok: false,
      reason: `no ${loaded.path} governs this checkout, so nothing here declares how to reach that host`,
      repair: `Repair: declare dispatch.hosts.<env>.ssh in ${loaded.path} — that declaration is the only thing that says how this machine reaches a host it dispatched onto.`,
    };
  if (loaded.errors.length > 0)
    return {
      ok: false,
      reason: `${loaded.path} does not validate (${loaded.errors[0]}), so its host declarations were not read`,
      repair: `Repair: ax doctor — it grades that file and names the fix; until it validates, no declared host is readable.`,
    };
  return { ok: true, config: loaded.config, path: loaded.path };
}

/**
 * `{ worktreeReal, fileReal, buf }` | `{ absent: true }` | `{ reason, repair }` —
 * the Report's bytes off the host that owns them, the one absence, or a named
 * inability.
 *
 * `ssh` and `declaration` are named options with real defaults, because both are
 * machine answers: the suite proves this boundary with a local shell and a
 * literal config, and never a credential (`AGENTS.md`).
 */
export function fetchRemoteReport({ env, worktree, path, cap, ssh, declaration, cwd = process.cwd() } = {}) {
  if (!Number.isInteger(cap) || cap <= 0) {
    return {
      reason: `the retrieval was asked for a ${cap}-byte bound, which is not a byte count it can read within`,
      repair: 'Repair: the fault is in this receiver, not on that host — read the Report there while it is fixed.',
    };
  }

  // The declaration, from the seam or from this checkout's own config. An
  // unreadable config is its own inability: `hostFor(null, env)` would report it
  // as an undeclared host, which sends the repair to the wrong file.
  let declared;
  if (declaration === undefined) {
    const found = declarationFor(cwd);
    if (!found.ok) return { reason: found.reason, repair: found.repair };
    declared = hostFor(found.config, env);
  } else {
    declared = declaration(env);
  }
  if (!declared.ok) {
    return {
      reason: declared.reason,
      repair: `Repair: declare that host under dispatch.hosts in ax.config.json with its ssh target, or read ${path} on it by hand — a host this project never declared is one nothing here knows how to reach.`,
    };
  }
  const at = declared.host.ssh;
  // The stdout budget is the bound that runs BEFORE anything here allocates:
  // spawnSync kills the child once the pipe holds more than a header plus the
  // base64 of `cap + 1` bytes. A host that ignored `head -c` is then a transport
  // failure, not a 64 MiB string this process has to parse.
  const maxBytes = cap + 1;
  const maxChars = 4 * Math.ceil(maxBytes / 3);
  const wrapSlack = Math.ceil(maxChars / 76) + 8;
  const stdoutBudget = 16 * 1024 + maxChars + wrapSlack;
  const answered = remote(
    ssh ?? (args => run('ssh', args, { timeout: SSH_TIMEOUT_MS, maxBuffer: stdoutBudget })),
    at,
    remoteReadCommand({ worktree, path, cap }),
  );
  if (answered.error !== undefined || answered.status !== 0) {
    const why =
      answered.error !== undefined
        ? String(answered.error.message ?? answered.error)
        : `status ${answered.status}: ${String(answered.stderr ?? '').trim().split('\n').pop() ?? ''}`;
    return {
      reason: `the retrieval over ssh to '${at}' failed (${why})`,
      repair: `Repair: ssh ${at} and read ${path} there — the transport, not the Report, is what failed here.`,
    };
  }

  const parsed = parseRemoteAnswer(answered.stdout, maxBytes);
  if (parsed.buf !== undefined) return parsed;

  const token = parsed.token;
  if (token === 'file-absent') return { absent: true };
  if (token === 'payload-oversize')
    return {
      reason: `'${at}' sent more Report bytes than the ${cap}-byte bound this retrieval reads, so nothing from it is trusted — a host that honours the bound sends at most ${cap + 1}`,
      repair: `Repair: ssh ${at} and read ${path} there — the retrieval bounds the read; an answer past that bound is not a Report this side will decode.`,
    };


  const inspect = `Repair: inspect ${path} on '${env}' (ssh ${at}) — the path is the fault there, not the completion here.`;
  if (token === 'worktree-unresolved')
    return {
      reason: `the recorded worktree ${worktree} does not resolve on '${at}', so its Report cannot be read`,
      repair: `Repair: check that worktree still exists on '${env}' — a released one takes its Report with it, and the record is then the only account of the slice.`,
    };
  if (token === 'file-not-regular') return { reason: `the derived path on '${at}' is not a regular file`, repair: inspect };
  if (token === 'file-unreadable') return { reason: `the derived path on '${at}' is not readable there`, repair: inspect };
  if (token.startsWith('file-unresolved'))
    return { reason: `the derived path did not resolve on '${at}' (${token.slice('file-unresolved '.length) || 'unresolved'})`, repair: inspect };
  if (token === 'file-outside')
    return {
      reason: `the derived path resolves outside the recorded worktree on '${at}', so that host refused to send it`,
      repair:
        'Repair: inspect that link before trusting anything from this slice; the Report must be a file under the worktree the record names, and a path leading out of it was not written by the rule.',
    };
  if (token.startsWith('tool-missing'))
    return {
      reason: `'${at}' has no \`${token.slice('tool-missing '.length) || 'tool'}\`, which the retrieval needs to bound the read and encode it`,
      repair: `Repair: install it on '${env}', or read ${path} there — the retrieval bounds the read with \`head -c\` and encodes it with \`base64\`.`,
    };
  return {
    reason: `'${at}' answered, but not in the shape this retrieval reads (${token}), so nothing from it is trusted`,
    repair: `Repair: ssh ${at} and read ${path} yourself — an answer that cannot be parsed is not evidence, whatever it contains.`,
  };
}
