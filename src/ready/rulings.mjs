// The grammar of the question channel — what an ask carries out, and what a
// ruling carries back in.
//
// The channel exists because a child that hits an underdetermined decision must
// not decide it alone and must not die: it writes `Q<n>:` lines into its draft,
// sends EXACTLY those lines to the coordinator, and blocks until each one gets a
// ruling. Before this grammar the middle of that loop was hand work — the first
// real campaign (2026-08-22) folded rulings back with ~200-line string edits per
// ticket, four of which crashed — and a hand-rolled reply validated nothing: a
// ruling could name a question that did not exist, skip one that did, or carry
// stray prose that meant something to its author and nothing to the child.
//
// So every function here is a refusal or a rendering, and the pairing rule is
// single: a ruling reaches a question BY NUMBER, one to one, no leftovers on
// either side. What enters a LIVE child has to be right the first time — there
// is no second read of a message already consumed.

/**
 * How many inbox rows the channel reads when it has to find a message.
 *
 * A bound, not a filter: `orca orchestration inbox` answers newest-first across
 * every recipient on the machine, and a pending question is by construction
 * recent — its child is blocked on it. A message past this window is not proven
 * absent, and callers must treat it that way (F-028).
 */
export const INBOX_WINDOW = 500;

/**
 * The body `ask` puts on the wire: a header naming the sender and the draft
 * version it asked from, then the draft's own `Q<n>:` lines, verbatim.
 *
 * Verbatim is the contract — `answer` re-parses these lines and refuses to
 * reply when they no longer match the draft, which is what makes "the questions
 * asked" and "the questions on record" provably the same set.
 */
export function composeAsk({ request, sha, questions }) {
  return [
    `${request} is blocked on the question(s) below, asked from draft ${sha}. Each needs one ruling, paired by number.`,
    ...questions.map(question => `Q${question.n}: ${question.text}`),
  ].join('\n');
}

/**
 * Read back the header `composeAsk` wrote, or null for a body it did not write.
 *
 * The header is what pins an ask to ONE pass and ONE draft version: Q-line text
 * can legitimately coincide across issues ("bug or enhancement?" asks the same
 * words everywhere), so `answer` must not pair on content alone — a reply keyed
 * to the wrong ask would wake the wrong live child with rulings it never asked
 * for. A body with no header was not sent by `ax ready ask`, and nothing can
 * prove which draft it asked from.
 */
export function askHeader(body) {
  const first = String(body ?? '').split('\n', 1)[0];
  const match = /^(\S+) is blocked on the question\(s\) below, asked from draft ([0-9a-f]{40})\./.exec(first);
  return match === null ? null : { request: match[1], sha: match[2] };
}

/**
 * Read a rulings file: `A<n>:` markers, with any following lines belonging to
 * the marker above them.
 *
 * Three refusals, each a way an answer silently loses meaning:
 *   * a line under no marker — its author meant it, and no question would get it
 *   * an empty or duplicated `A<n>` — the child could not tell what stands
 *   * a `Q<n>:` marker — questions live in the draft; a copy here would fork them
 */
export function parseRulings(text) {
  const collected = [];
  let current = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    if (/^Q[0-9]+:/.test(line)) {
      return { ok: false, reason: `line ${at + 1} carries a Q<n>: marker — questions live in the draft, and a copy here would fork them; this file carries rulings only`, rulings: [] };
    }
    const marker = /^A([0-9]+):\s*(.*)$/.exec(line);
    if (marker !== null) {
      current = { n: Number(marker[1]), parts: [marker[2]] };
      collected.push(current);
      continue;
    }
    if (current === null) {
      if (line.trim() === '') continue;
      return { ok: false, reason: `line ${at + 1} is under no A<n>: marker — an orphan line cannot be paired to any question`, rulings: [] };
    }
    current.parts.push(line);
  }
  if (collected.length === 0) {
    return { ok: false, reason: 'no A<n>: line — a ruling names the question it answers, or it cannot reach it', rulings: [] };
  }
  const rulings = collected.map(({ n, parts }) => ({ n, text: parts.join('\n').trim() }));
  const empty = rulings.find(ruling => ruling.text === '');
  if (empty !== undefined) {
    return { ok: false, reason: `A${empty.n} carries no ruling — an empty answer cannot close the question it names`, rulings: [] };
  }
  const numbers = rulings.map(ruling => ruling.n);
  const twice = numbers.filter((n, index) => numbers.indexOf(n) !== index);
  if (twice.length > 0) {
    return { ok: false, reason: `two rulings are numbered A${twice[0]} — the child could not tell which one stands`, rulings: [] };
  }
  return { ok: true, rulings };
}

/**
 * One ruling per question, by number, no leftovers — or the reason there isn't.
 *
 * Both directions are refusals because both lose something silently: a skipped
 * question leaves the child waiting on it forever, and a ruling with no
 * question is an answer to something that was never asked — usually a wrong
 * `--id`, sometimes a draft that moved.
 */
export function pairRulings(questions, rulings) {
  const asked = new Set(questions.map(question => question.n));
  const ruled = new Set(rulings.map(ruling => ruling.n));
  const unanswered = questions.map(question => question.n).filter(n => !ruled.has(n));
  if (unanswered.length > 0) {
    return { ok: false, reason: `Q${unanswered.join(', Q')} got no ruling — a partial answer leaves the child blocked on the rest` };
  }
  const unmatched = rulings.map(ruling => ruling.n).filter(n => !asked.has(n));
  if (unmatched.length > 0) {
    return { ok: false, reason: `A${unmatched.join(', A')} answers no question in the draft — the number is wrong, or the id names another ask` };
  }
  return { ok: true };
}

/**
 * The reply body the child receives: each question restated above its ruling,
 * in draft order, so the child can verify the pairing without holding anything
 * but the message.
 */
export function composeReply(questions, rulings) {
  const byNumber = new Map(rulings.map(ruling => [ruling.n, ruling.text]));
  return questions.map(question => `Q${question.n}: ${question.text}\nA${question.n}: ${byNumber.get(question.n)}`).join('\n\n');
}

/**
 * `Q1`, `Q1-Q3`, or `Q1, Q4` — the compact name of a question set for a status
 * line. Draft questions are consecutive by construction, so the range form is
 * the ordinary one; the list form survives a hand-rolled ask.
 */
export function questionSpan(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `Q${sorted[0]}`;
  const consecutive = sorted.every((n, index) => index === 0 || n === sorted[index - 1] + 1);
  return consecutive ? `Q${sorted[0]}-Q${sorted[sorted.length - 1]}` : sorted.map(n => `Q${n}`).join(', ');
}
