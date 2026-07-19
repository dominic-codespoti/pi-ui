/**
 * Server-side logger with systemd/journald awareness.
 *
 * When the process runs under systemd (JOURNAL_STREAM env var is set on
 * stdout/stderr-connected services), lines are prefixed with sd-daemon
 * priority tags (`<3>` err, `<4>` warning, `<6>` info, `<7>` debug) so
 * `journalctl -p warning` filtering works, and timestamps are omitted —
 * the journal records its own.
 *
 * Outside systemd, lines get an ISO timestamp + level tag for plain-file or
 * terminal logging.
 *
 * Errors/warnings go to stderr, info/debug to stdout. Error objects are
 * expanded with their stack traces.
 */

const underSystemd: boolean =
  typeof Bun !== 'undefined'
    ? Boolean(Bun.env.JOURNAL_STREAM)
    : Boolean(process.env.JOURNAL_STREAM);

type Level = 'debug' | 'info' | 'warn' | 'error';

/** sd-daemon(3) syslog priority prefixes. */
const SD_PREFIX: Record<Level, string> = {
  debug: '<7>',
  info: '<6>',
  warn: '<4>',
  error: '<3>',
};

const LEVEL_TAG: Record<Level, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return Bun.inspect(arg);
  } catch {
    return String(arg);
  }
}

function emit(level: Level, args: unknown[]): void {
  const body = args.map(formatArg).join(' ');
  // Journald splits multi-line messages; keep the priority prefix on every line
  // so continuation lines don't fall back to the default priority.
  const line = underSystemd
    ? body
        .split('\n')
        .map((l) => `${SD_PREFIX[level]}${l}`)
        .join('\n')
    : `${new Date().toISOString()} ${LEVEL_TAG[level]} ${body}`;
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug(...args: unknown[]): void {
    emit('debug', args);
  },
  info(...args: unknown[]): void {
    emit('info', args);
  },
  warn(...args: unknown[]): void {
    emit('warn', args);
  },
  error(...args: unknown[]): void {
    emit('error', args);
  },
};
