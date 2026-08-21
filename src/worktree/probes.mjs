// Everything a plan needs to know about THIS machine, gathered in one place.
//
// The split is the point. `plan.mjs` decides, and cannot touch the machine;
// this file touches the machine, and decides nothing. A probe that started
// making decisions would recreate the two-derivations bug the plan exists to
// kill, so each function here answers one factual question and returns data.
//
// Every probe is also individually replaceable, which is what lets `doctor`
// re-derive a plan against recorded values without starting a container or
// binding a port.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readConfigured } from '../dotenv.mjs';
import { isMainCheckout } from '../git.mjs';
import { isPortBound } from './ports.mjs';
import { proxyAvailable, proxyEnabled, proxyName, proxyServedUrl, tailnetName } from './addressing.mjs';
import { touchesDatabase } from './supabase.mjs';
import { KEYS, RECORDED_KEYS, readRecorded } from './plan.mjs';

/** The env files a worktree records itself in, in Next.js precedence order. */
export const envFiles = config => [`${config.apps.web}/.env.local`, '.env.local'];

/**
 * Read what this worktree already wrote about itself.
 *
 * Precedence is Next.js's, not ours: an exported variable beats `.env.local`
 * beats the root file. That matters because a caller overriding a knob for one
 * run expects the override to be what the tooling sees too.
 *
 * The legacy names are read from the FILES only. A shell that once sourced the
 * old tooling still exports them, and honouring that would report a migration
 * in repositories that have nothing to migrate.
 */
export function readWorktreeRecord(worktreePath, config, env = process.env) {
  const files = envFiles(config);
  return readRecorded(
    RECORDED_KEYS,
    key => readConfigured(key, { cwd: worktreePath, files, env }),
    key => readConfigured(key, { cwd: worktreePath, files, env: {} }),
  );
}

/**
 * The proxy layer's state.
 *
 * The main checkout is excluded deliberately: it owns the plain port the whole
 * team's bookmarks and `apps/web/.env` already point at, and moving it behind a
 * proxy hostname would break every one of them. That decision needs git, which
 * is why it lives here and not in `addressing.mjs`.
 */
export function probeProxy({ worktreePath, config, recorded }) {
  if (isMainCheckout(worktreePath)) {
    return { enabled: false, reason: 'the main checkout keeps its plain port' };
  }

  const enabled = proxyEnabled({ recorded: recorded[KEYS.useProxy] });
  if (!enabled) return { enabled: false, reason: 'disabled in this worktree' };

  const available = proxyAvailable({});
  if (!available) return { enabled: true, available: false, installHint: 'no local proxy on PATH' };

  const name = proxyName({ recorded: recorded.PORTLESS_NAME, fallback: config.project.name });
  return { enabled: true, available: true, name, servedUrl: proxyServedUrl({ name }), port: config.ports.proxy };
}

/** This node's tailnet name, so a phone can reach the worktree at all. */
export const probeTailnet = () => ({ enabled: true, name: tailnetName({}) });

/**
 * Does this worktree need its own database, and can it have one?
 *
 * Two separate questions, answered together because the plan treats both as a
 * reason to keep sharing. Docker being down is not a failure here: a worktree
 * that shares is fully functional, and the guard in front of the Supabase CLI
 * promotes it later, the first time a command would actually write.
 */
export function probeDatabase({ worktreePath, config, force, docker = probeDocker }) {
  // The primary checkout is settled before anything else is asked: it owns the
  // shared stack, so neither a diff nor a daemon can make isolation correct
  // here.
  if (isMainCheckout(worktreePath)) return { primary: true, touches: false };

  const supabaseDir = join(config.apps.web, 'supabase');
  const touches = touchesDatabase({ cwd: worktreePath, supabaseDir, force });
  if (!touches) return { touches: false };

  const daemon = docker();
  return { touches: true, startable: daemon.usable, reason: daemon.reason };
}

/**
 * Is a container runtime actually answering?
 *
 * `docker info` rather than `command -v docker`, because the failure that costs
 * an hour is the one where the binary is installed and the daemon is not
 * running — an installed-but-dead daemon looks identical to a working one until
 * a container is asked for. The OrbStack socket is exported first: on a Mac
 * where OrbStack replaced Docker Desktop, DOCKER_HOST is otherwise unset and
 * every probe reports no daemon at all.
 */
export function probeDocker(env = process.env) {
  const socket = join(env.HOME ?? '', '.orbstack', 'run', 'docker.sock');
  if (!env.DOCKER_HOST && existsSync(socket)) env.DOCKER_HOST = `unix://${socket}`;

  const found = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (found.error) return { usable: false, reason: 'no container runtime installed; keeping the shared database' };
  if (found.status !== 0) {
    return { usable: false, reason: 'the container daemon is not answering (start OrbStack or Docker Desktop, then re-run setup)' };
  }
  return { usable: true };
}

/** Every probe a full plan needs, in one call. */
export function probeAll({ worktreePath, config, recorded, force }) {
  return {
    isBound: isPortBound,
    proxy: probeProxy({ worktreePath, config, recorded }),
    tailnet: probeTailnet(),
    database: probeDatabase({ worktreePath, config, force }),
  };
}
