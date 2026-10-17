/**
 * Feature flags for the v2 rebuild (tech plan §7.7) — pure, unit-testable
 * parsing/merging. The React wiring lives in `./FlagsProvider`.
 *
 * Resolution order:
 *   build-time env (VITE_FF_<NAME>) → route-forced values → ?ff= URL override
 * URL overrides are honored only in dev builds, when VITE_ALLOW_FF_OVERRIDE=1,
 * or on the /new preview prefix.
 */

export const FLAG_NAMES = [
  'ui_v2',
  'legacy_mentor',
  'legacy_tabs',
  'legacy_next_actions',
  'fakedoor_v2',
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Record<FlagName, boolean>;

/**
 * Product defaults (env unset): the v2 UI owns `/` (cutover done); the legacy
 * app lives under `/legacy`. The v2 fake-door card ships ON for the MVP (the
 * legacy app has its own CTA and is unaffected). Rollback levers: build env
 * VITE_FF_UI_V2=0 puts the legacy app back on `/`; VITE_FF_FAKEDOOR_V2=0 (or
 * `?ff=-fakedoor_v2` on the /new preview) hides the fake-door card.
 */
export const DEFAULT_FLAGS: Flags = {
  ui_v2: true,
  legacy_mentor: true,
  legacy_tabs: true,
  legacy_next_actions: true,
  fakedoor_v2: true,
};

const ENV_PREFIX = 'VITE_FF_';

function parseBool(value: string | undefined): boolean | null {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

function isFlagName(name: string): name is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(name);
}

/** Parse `name:1,other:0` / `name` (on) / `-name` (off). Unknown names ignored. */
export function parseFfOverride(raw: string | null): Partial<Flags> {
  const out: Partial<Flags> = {};
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('-')) {
      const name = trimmed.slice(1);
      if (isFlagName(name)) out[name] = false;
      continue;
    }
    const [name, value] = trimmed.split(':', 2);
    if (!isFlagName(name)) continue;
    if (value === undefined) {
      out[name] = true;
    } else {
      const parsed = parseBool(value);
      if (parsed !== null) out[name] = parsed;
    }
  }
  return out;
}

export interface ResolveFlagsInput {
  /** Build-time env, e.g. import.meta.env. */
  env: Record<string, string | undefined>;
  pathname: string;
  /** Raw query string, with or without the leading '?'. */
  search: string;
  /** True in dev or when VITE_ALLOW_FF_OVERRIDE==='1'. */
  allowOverride?: boolean;
}

export function resolveFlags({ env, pathname, search, allowOverride = false }: ResolveFlagsInput): Flags {
  const flags: Flags = { ...DEFAULT_FLAGS };
  for (const name of FLAG_NAMES) {
    const parsed = parseBool(env[`${ENV_PREFIX}${name.toUpperCase()}`]);
    if (parsed !== null) flags[name] = parsed;
  }

  // Route-forced values beat env defaults.
  const onNew = pathname === '/new' || pathname.startsWith('/new/');
  const onMatch = pathname === '/m' || pathname.startsWith('/m/');
  const onLegacy = pathname === '/legacy' || pathname.startsWith('/legacy/');
  if (onNew || onMatch) {
    flags.ui_v2 = true;
    flags.legacy_mentor = false;
    flags.legacy_tabs = false;
    flags.legacy_next_actions = false;
  } else if (onLegacy) {
    flags.ui_v2 = false;
    flags.legacy_mentor = true;
    flags.legacy_tabs = true;
    flags.legacy_next_actions = true;
  }

  // URL override last, and only where allowed (the /new preview always allows).
  if (allowOverride || onNew) {
    const raw = new URLSearchParams(search.replace(/^\?/, '')).get('ff');
    Object.assign(flags, parseFfOverride(raw));
  }
  return flags;
}
