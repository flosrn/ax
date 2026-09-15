// The project's own commands, run as one bounded conversation.
//
// Authentication freshness is project knowledge (KTD4): whether a MakerKit
// session needs a new sign-in, whether a TOTP secret still works, what a
// storage state should contain. AX therefore does not understand any of it — it
// asks, on a protocol, and grades the answer's envelope rather than its
// meaning.
//
// WHY NOT `src/exec.mjs`. The shared `run` is spawnSync with `stdio[0]:
// 'ignore'` and no stdin contract at all, deliberately: every other caller
// asks git or gh a question through argv. This protocol is a REQUEST, and it
// has to be written to a child's standard input, so the spawn lives here with
// the rules that bound it. The runner stays injectable for the same reason
// every machine answer in this package does.
//
// EVERY BOUND IS THE PROJECT'S, EXCEPT THE OUTPUT CAP. The deadline is
// `prepare.timeoutSeconds`, declared and defaulted nowhere (R26): the number AX
// would have invented is precisely the one that kills a cold sign-in halfway
// through, and the repair for that looks like a broken adapter. The 64 KiB
// output cap is AX's, because an answer is one small JSON object and a project
// that prints more has a bug AX must not buffer without bound.
//
// THE STDERR TAIL IS THE ONLY DIAGNOSTIC. An adapter that fails prints its
// reason there — a missing TOTP secret, a Supabase that is not running — and a
// refusal without it leaves an operator with "the adapter failed". It is
// bounded and redacted, because the same stream is where a failing request
// dumps its headers.
//
// NOTHING AX RESOLVED IS PASSED DOWN (R26/R27). The child inherits the ambient
// environment the caller hands over, and never a value AX read out of an
// `.env.local` — an adapter that needs project credentials reads its own
// project configuration, exactly as it does when a developer runs it by hand.

import { spawn } from 'node:child_process';

import { scrub } from './emit.mjs';

/** The protocol version both halves of every request and answer carry. */
export const ADAPTER_PROTOCOL = 1;

/** One answer is one small object; beyond this the adapter is misbehaving. */
export const MAX_ADAPTER_OUTPUT = 64 * 1024;

/** Enough of a failure to act on, bounded so a runaway log is not the refusal. */
const MAX_STDERR_TAIL = 2000;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const refusal = (message, fix) => Object.assign(new Error(scrub(message)), { fix });

/** The adapter's own last words, bounded and redacted. */
const tail = text => {
  const trimmed = String(text).trimEnd();
  if (trimmed === '') return '';
  const kept = trimmed.length > MAX_STDERR_TAIL ? `…${trimmed.slice(-MAX_STDERR_TAIL)}` : trimmed;
  return `\n${kept}`;
};

/**
 * Ask a project command one question and return its single JSON answer.
 *
 * `request` is any JSON-serializable object; AX adds `protocol` and nothing
 * else. `at` names the declaration being run, so a refusal points at the
 * configuration key an operator must fix rather than at this file.
 */
export async function runAdapter({ command, timeoutSeconds, request = {}, cwd, env = process.env, spawnImpl = spawn, at = 'debugAs.browser.prepare' }) {
  if (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string' && part !== '')) {
    throw refusal(
      `${at}.command is not an argv array of non-empty strings, and AX runs project commands without a shell`,
      `declare "${at}.command" as an argv array, such as ["node", "scripts/debug-auth-adapter.mjs"]`,
    );
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw refusal(
      `${at} declares an adapter without its own deadline, and AX defaults none — the number AX would invent is the one that kills a cold sign-in`,
      `declare "${at}.timeoutSeconds" above this project's own authentication budget`,
    );
  }

  const child = spawnImpl(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  let stdoutBytes = 0;
  const stdoutChunks = [];
  let stderr = '';
  let overflowed = false;
  let timedOut = false;
  let settled = false;

  const killGroup = () => {
    const pid = child.pid;
    if (typeof pid === 'number') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  };

  const dropStdio = () => {
    try {
      child.stdout?.destroy();
    } catch {
      /* closed */
    }
    try {
      child.stderr?.destroy();
    } catch {
      /* closed */
    }
    try {
      child.stdin?.destroy();
    } catch {
      /* closed */
    }
  };

  const onParentSignal = () => {
    killGroup();
    dropStdio();
  };

  const outcome = await new Promise(resolve => {
    let settleTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      process.off('SIGINT', onParentSignal);
      process.off('SIGTERM', onParentSignal);
      resolve(result);
    };

    const boundKill = () => {
      killGroup();
      dropStdio();
      settleTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 1000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      boundKill();
    }, timeoutSeconds * 1000);

    process.on('SIGINT', onParentSignal);
    process.on('SIGTERM', onParentSignal);

    // A child that never reads its stdin closes the pipe under us; that is its
    // prerogative, not an AX failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${JSON.stringify({ protocol: ADAPTER_PROTOCOL, ...request })}\n`);

    child.stdout?.on('data', chunk => {
      if (overflowed || settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (stdoutBytes > MAX_ADAPTER_OUTPUT) {
        overflowed = true;
        boundKill();
        return;
      }
      stdoutChunks.push(buf);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-(MAX_STDERR_TAIL * 2));
    });

    child.on('error', error => finish({ spawnError: error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');

  if (outcome.spawnError) {
    throw refusal(
      `${at}.command could not be run (${scrub(String(outcome.spawnError.message))})`,
      `install or correct the command declared at "${at}.command" — AX never installs a project's own tooling`,
    );
  }
  if (overflowed) {
    throw refusal(
      `${at} printed more than ${MAX_ADAPTER_OUTPUT / 1024} KiB on standard output, which is more than one answer, so AX stopped reading and killed it`,
      `print exactly one bounded JSON object from "${at}.command", and send progress to standard error`,
    );
  }
  if (timedOut) {
    throw refusal(
      `${at} exceeded its declared ${timeoutSeconds}s deadline and was killed${tail(stderr)}`,
      `fix the adapter, or raise "${at}.timeoutSeconds" above this project's own authentication budget`,
    );
  }
  if (outcome.code !== 0) {
    throw refusal(
      `${at} exited ${outcome.code ?? `on ${outcome.signal}`}${tail(stderr)}`,
      `run "${command.join(' ')}" by hand in this worktree to see why it fails`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    throw refusal(
      `${at} did not print exactly one JSON object on standard output — standard output IS the protocol, so progress belongs on standard error${tail(stderr)}`,
      `print one JSON object from "${at}.command", such as {"protocol":${ADAPTER_PROTOCOL},"ok":true}`,
    );
  }
  if (parsed.protocol !== ADAPTER_PROTOCOL) {
    throw refusal(
      `${at} answered protocol ${JSON.stringify(parsed.protocol ?? null)}, and AX speaks version ${ADAPTER_PROTOCOL}`,
      `answer with "protocol": ${ADAPTER_PROTOCOL} from "${at}.command"`,
    );
  }

  return parsed;
}
