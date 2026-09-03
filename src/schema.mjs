// A JSON Schema validator that covers exactly what ax.schema.json uses — and
// refuses any keyword it does not implement.
//
// The refusal is the point. A hand-written validator beside a schema drifts:
// the schema gains a rule, the code never learns it, and the config that
// violates it loads clean. Here the schema is the only source of truth, and a
// keyword nobody taught this file throws at validation time (loudly, in the
// tests) instead of being ignored (silently, in production).

const SUPPORTED = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'pattern',
  'minimum',
  'maximum',
  'items',
  'minItems',
  'maxItems',
  'const',
  'oneOf',
  'default',
]);

/**
 * Reserved JSON-Schema annotations, admitted wherever an object is — including
 * inside a keyed map, where `additionalProperties` would otherwise validate the
 * annotation as an entry of that map (`dispatch.hosts: expected object, got
 * string`).
 *
 * Structural, because the alternative was measured: admission was hand-listed
 * per object, so `prGate.$comment` loaded and the identical `dispatch.$comment`
 * was refused as an unknown key. A project annotates the SECTION whose reasoning
 * it is recording, and which sections those are is not something this file can
 * enumerate in advance.
 *
 * ax.schema.json still declares `$comment` under `prGate` and `prGate.tracker`,
 * and those declarations are now documentation only: they say what a comment
 * THERE is for, and they are what an editor validating ax.config.json against
 * the schema reads. Nothing here depends on them.
 *
 * An annotation that is not a string is refused by name rather than admitted:
 * `$comment: {...}` is a section someone meant to nest and did not.
 */
const ANNOTATIONS = new Set(['$comment', '$schema']);

const typeOf = value => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const matchesType = (value, expected) =>
  expected === 'integer' ? Number.isInteger(value) : typeOf(value) === expected || (expected === 'number' && typeof value === 'number');

function assertSupported(schema, at) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(`ax.schema.json uses unsupported keyword "${keyword}" at ${at || 'root'}`);
    }
  }
}

/**
 * Validate `value` against `schema`, collecting every violation instead of
 * stopping at the first: a config with three typos should be fixed in one pass.
 * Returns the list of human-readable errors, empty when valid.
 */
export function validate(value, schema, path = '') {
  assertSupported(schema, path);
  const errors = [];
  const where = path || 'root';

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${where}: must be ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (schema.oneOf) {
    const matched = schema.oneOf.some(branch => validate(value, branch, path).length === 0);
    if (!matched) {
      errors.push(`${where}: does not match any accepted shape`);
    }
    return errors;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${where}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }

  if (schema.type === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${where}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${where}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${where}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${where}: accepts at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validate(item, schema.items, `${where}[${index}]`)));
    }
  }

  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${where}: missing required key "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        errors.push(...validate(child, childSchema, path ? `${path}.${key}` : key));
        continue;
      }
      if (ANNOTATIONS.has(key)) {
        // Before `additionalProperties`, both readings of it: a closed object
        // must not refuse the annotation, and a keyed map must not validate it
        // as one of its entries.
        if (typeof child !== 'string') {
          errors.push(`${where}: "${key}" is an annotation, expected string, got ${typeOf(child)}`);
        }
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(child, schema.additionalProperties, path ? `${path}.${key}` : key));
        continue;
      }
      if (schema.additionalProperties === false) {
        // A typo'd key that merely gets ignored is worse than a hard error: the
        // setting appears written and never takes effect.
        errors.push(`${where}: unknown key "${key}"`);
      }
    }
  }

  return errors;
}

/** Fill in every `default` the schema declares, without touching set values. */
export function applyDefaults(value, schema) {
  if (!schema || schema.type !== 'object' || typeof value !== 'object' || value === null) return value;
  const filled = { ...value };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (child.default !== undefined && filled[key] === undefined) {
      filled[key] = structuredClone(child.default);
    } else if (child.type === 'object') {
      const nested = applyDefaults(filled[key] ?? {}, child);
      if (Object.keys(nested).length > 0 || filled[key] !== undefined) filled[key] = nested;
    }
  }
  return filled;
}
