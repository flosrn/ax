// @ts-nocheck - runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * The host's TUI kit, for `view.ts` to draw with — or nothing.
 *
 * `@oh-my-pi/pi-tui` is not a dependency of this package and must not become
 * one: OMP's extension loader resolves `@oh-my-pi/*` to the copy bundled with
 * the running host, which is the only copy whose markdown renderer, width
 * table and theme agree with the screen being drawn. Under this repository's
 * own `bun test` the specifier resolves to nothing, and `hostKit()` answers
 * null: the peer view then registers no renderer and OMP draws the message
 * text as it always did. Nothing the model reads depends on this module.
 */
import type { Kit } from './view.ts';

let host = null;
try {
  // Dynamic on purpose: the module exists only inside the OMP host, and a
  // static import would fail this package's own test suite at load.
  host = await import('@oh-my-pi/pi-tui');
} catch {
  host = null;
}

export function hostKit(): Kit | null {
  if (!host?.Markdown || !host?.getMarkdownTheme || !host?.visibleWidth || !host?.truncateToWidth) return null;
  const { Markdown, getMarkdownTheme, visibleWidth, truncateToWidth } = host;
  return {
    markdown: (text, width) => new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(10, width)),
    width: (text) => visibleWidth(text),
    truncate: (text, width) => truncateToWidth(text, width),
  };
}
