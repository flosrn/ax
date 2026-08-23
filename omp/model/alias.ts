/**
 * The one contract between a parent agent and the session it dispatches.
 *
 * WHY A MARKER AT ALL
 * `worker-start` does carry `--model` and `--effort`, but they apply to Claude,
 * Codex and Cursor only — `omp` is not among the agents they accept, and the
 * flags cannot combine with `--terminal` either. So a session Orca launches for
 * us serves whatever the harness defaults to, not what the parent asked for: an
 * unmarked `worker-start --agent omp` gets the premium interactive default,
 * chosen by nobody. This marker is how the parent's intent survives that gap.
 *
 * WHY AN ALIAS AND NOT A CONCRETE MODEL
 * A concrete id rots (`grok-4.5` becomes `grok-5`); a role alias does not. The
 * parent states the KIND of work and the fleet's config decides which model
 * serves it, so retuning the fleet is one edit to `config.yml` instead of a
 * rewrite of every spec. A concrete id is still accepted, because
 * `models.resolve()` takes both and refusing one would buy nothing.
 */

/**
 * Marker the parent writes in the Task spec. Case-insensitive, anywhere in the text.
 *
 * ONE bracket, parsed as a bag of `key=value` pairs, because the marker was
 * always going to carry more than the model. The first grammar required
 * `model=` to follow `[omp` immediately, and that made a second key fail two
 * different ways — one of them silent. Measured on all four forms, 2026-08-07:
 *
 *   [omp model=@smol]                     -> "@smol"
 *   [omp role=supervisor model=@default]  -> NO MATCH  -> supervised default
 *   [omp model=@default role=supervisor]  -> captured "@default role=supervisor"
 *   [omp role=supervisor]                 -> NO MATCH  -> supervised default
 *
 * The no-match cases are the dangerous ones: absent is indistinguishable from
 * never-written, so the adapter takes SUPERVISED_DEFAULT and journals a clean
 * `serving … from supervised-default`. A parent that carefully named the premium
 * model would get the bulk one, with a log saying everything was fine — the true
 * proposition ("the marker was handled") standing in for the untested one
 * ("the marker was READ").
 *
 * So: order-independent, unknown keys ignored BY NAME rather than swallowed into
 * a neighbour's value, and a token that is not `key=value` refused by name
 * rather than guessed at.
 */
const MARKER = /\[omp\s+([^\]]*)\]/i;

/** One `key=value`. Split on the FIRST `=`, so a value may contain one. */
const PAIR = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/;

/**
 * What one `[omp …]` bracket turned out to be.
 *
 * Discriminated rather than "a map, empty on failure", because the three ways a
 * marker can carry no usable key are three different facts: nobody wrote one,
 * someone wrote one and left it blank, someone wrote one and fumbled a token.
 * Collapsing them is how `role=`-only used to look exactly like no marker.
 */
export type MarkerParse =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'malformed'; token: string }
  | { kind: 'keys'; keys: ReadonlyMap<string, string> };

/**
 * Parse the marker once, for every consumer.
 *
 * `model=` and `role=` are two keys of the SAME bracket. A second parser beside
 * this one would be a second way for them to disagree — which is precisely how
 * a `role=` key came to silently change the model before the grammar became one
 * bag.
 */
export function parseMarker(spec: string): MarkerParse {
  const found = MARKER.exec(spec);
  if (found === null) return { kind: 'absent' };
  const raw = (found[1] ?? '').trim();
  if (raw === '') return { kind: 'empty' };
  const keys = new Map<string, string>();
  for (const token of raw.split(/\s+/)) {
    const pair = PAIR.exec(token);
    if (pair === null) return { kind: 'malformed', token };
    keys.set((pair[1] ?? '').toLowerCase(), pair[2] ?? '');
  }
  return { kind: 'keys', keys };
}

/**
 * What a supervised session serves when its parent wrote no marker.
 *
 * NOT the harness default. The failure this exists to kill is precisely a
 * dispatched worker silently serving the interactive default — the most
 * expensive model in the fleet — because nobody decided. A forgotten marker
 * should cost the bulk model, never the premium one.
 */
export const SUPERVISED_DEFAULT = '@task';

export interface ModelIntent {
  /** Alias or concrete id to hand to `models.resolve()`. */
  spec: string;
  /** Thinking level the parent asked for explicitly, or `null` to leave it alone. */
  thinking: string | null;
  /** How this intent was arrived at — journaled, never swallowed. */
  source: 'marker' | 'supervised-default';
  /** Present when a marker existed but could not be used. */
  reason?: string;
}

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Split OMP's own `model:thinking` convention rather than inventing a second
 * one. `@task:high` is already what `--model` and `modelRoles` accept, so the
 * marker stays learnable from the docs the operator already has.
 *
 * A `provider/id` may itself contain no colon, but a bare id could
 * (`gpt-5.2:medium`), so the suffix is only split off when it names a real
 * thinking level. Anything else stays part of the model spec — guessing would
 * silently truncate a legitimate id.
 */
export function splitThinking(value: string): { spec: string; thinking: string | null } {
  const cut = value.lastIndexOf(':');
  if (cut <= 0) return { spec: value, thinking: null };
  const tail = value.slice(cut + 1).toLowerCase();
  if (!THINKING_LEVELS.has(tail)) return { spec: value, thinking: null };
  return { spec: value.slice(0, cut), thinking: tail };
}

/**
 * The role name behind an `@alias`, or `null` for a concrete model id.
 *
 * `@smol` → `smol`, which is the key `modelRoles` uses. A concrete id names no
 * role, so it has no configured effort to inherit and nothing to look up.
 */
export function modelRoleOf(spec: string): string | null {
  return spec.startsWith('@') && spec.length > 1 ? spec.slice(1) : null;
}

/**
 * Read the parent's intent out of a Task spec.
 *
 * `spec === null` means the lookup could not read it — indistinguishable here
 * from "no marker", and treated the same on purpose: both mean nobody decided,
 * and both must land on the supervised default rather than the harness one.
 */
export function readModelIntent(spec: string | null): ModelIntent {
  if (spec === null) {
    return {
      spec: SUPERVISED_DEFAULT,
      thinking: null,
      source: 'supervised-default',
      reason: 'Task spec unreadable',
    };
  }

  const parsed = parseMarker(spec);
  if (parsed.kind === 'absent') {
    return { spec: SUPERVISED_DEFAULT, thinking: null, source: 'supervised-default' };
  }
  if (parsed.kind === 'empty') {
    return {
      spec: SUPERVISED_DEFAULT,
      thinking: null,
      source: 'supervised-default',
      reason: 'marker present but empty',
    };
  }
  if (parsed.kind === 'malformed') {
    // Taking the first usable token would be a guess, and a guessed model is
    // the failure this file exists to remove.
    return {
      spec: SUPERVISED_DEFAULT,
      thinking: null,
      source: 'supervised-default',
      reason: `marker holds a token that is not key=value (${parsed.token})`,
    };
  }

  const model = parsed.keys.get('model');
  if (model === undefined) {
    // A well-formed marker that names no model. NOT silent: the parent wrote a
    // marker, so it decided something, and taking the supervised default
    // without naming the keys it did write is how a `role=`-only marker used to
    // look exactly like no marker at all.
    const seen = [...parsed.keys.keys()].sort().join(', ');
    return {
      spec: SUPERVISED_DEFAULT,
      thinking: null,
      source: 'supervised-default',
      reason: `marker names no model (keys: ${seen})`,
    };
  }
  if (model === '') {
    return {
      spec: SUPERVISED_DEFAULT,
      thinking: null,
      source: 'supervised-default',
      reason: 'marker present but empty',
    };
  }

  const { spec: id, thinking } = splitThinking(model);
  const extra = [...parsed.keys.keys()].filter((key) => key !== 'model').sort();
  return {
    spec: id,
    thinking,
    source: 'marker',
    // Named rather than swallowed, so a typo'd key is visible in the log
    // instead of corrupting the model it sits next to.
    ...(extra.length > 0 ? { reason: `ignored marker keys: ${extra.join(', ')}` } : {}),
  };
}
