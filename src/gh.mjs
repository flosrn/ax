// Facts `gh` answers about a checkout. The runner is injected at every call
// site, so each consumer's suite stays offline — same discipline as exec.mjs.

const firstLine = text => String(text ?? '').split('\n')[0].trim();

/**
 * The repository this checkout pushes to, as `gh` names it — with the failure
 * detail when it cannot say. Most callers refuse on an empty slug and move on;
 * worker/release NAMES the inability in its refusal ("no landing can be
 * proven: <detail>"), which is why the detail is part of this contract instead
 * of an eighth independent parser at that site.
 */
export function repoView(gh) {
  const out = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const slug = out.error || out.status !== 0 ? '' : String(out.stdout ?? '').trim().split('\n')[0] ?? '';
  if (slug !== '') return { slug, detail: '' };
  const detail = out.error ? String(out.error.message ?? out.error) : firstLine(out.stderr) || `exit ${out.status}`;
  return { slug: '', detail };
}

/** The slug alone, for the callers whose refusal does not restate gh's reason. */
export const repoSlug = gh => repoView(gh).slug;
