# ax

Agent-experience tooling for MakerKit turbo projects: worktrees, `debug-as`, vendor ownership.

## Use it in a project

```bash
pnpm add -Dw github:flosrn/ax#v0.1.3
pnpm ax init          # writes ax.config.json, bin/ax and the managed blocks
pnpm ax doctor        # exit 0 when the checkout is coherent
```

`ax init` is safe to re-run. It rewrites only what it owns: `ax.config.json`, `bin/ax`, the
`BEGIN:ax` block in `.gitignore` and `AGENTS.md`, and two named keys in `package.json`
(`scripts.ax`, the version pin). After a merge that took the vendor's side of any of those
files, re-run it.

## Configure it

Every value a project needs lives in `ax.config.json` at the repository root. `ax.schema.json`
documents each key; point your editor at it with `"$schema"`.

```json
{
  "$schema": "./node_modules/@flosrn/ax/ax.schema.json",
  "project": { "name": "ofmchat", "display": "OFMChat" },
  "ports": { "dev": [3100, 3999], "proxy": 1355 },
  "apps": { "web": "apps/web", "e2e": "apps/e2e", "caches": ["apps/dev-tool"] },
  "vendor": {
    "repo": "makerkit/next-supabase-saas-kit-turbo",
    "guarded": {
      "docs": { "ours": ["adr", "agents", "specs"], "vendor": ["billing", "installation"] },
      ".agents": "vendor"
    }
  }
}
```

Unset keys take the schema's defaults. An unknown key is an error, not a no-op — a typo'd
setting must never look applied.

`vendor.repo` is matched against remote **URLs**, never against a remote name: projects call
that remote `makerkit`, `upstream` or `kit`, and a clone calls it whatever it likes.

A guarded tree needs both lists. Anything under it that appears in neither is what `ax doctor`
flags — that unclaimed path is how vendor content starts drifting.

## Work on ax

```bash
pnpm test             # node:test, no dependencies
node bin/ax.mjs doctor --help
```

To try a change against a real project without publishing, point that project's pin at your
checkout: `"@flosrn/ax": "link:../../flosrn/ax"`.

Adding a subcommand: one file under `src/`, one case in `bin/ax.mjs`, one test file. Report
findings through `src/log.mjs` — every failing check names the command that repairs it, or it
gets ignored.
