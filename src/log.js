'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function create(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const line = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${ts} ${lvl.toUpperCase()} ${line}\n`);
  };
  return {
    debug: (...a) => out('debug', a),
    info: (...a) => out('info', a),
    warn: (...a) => out('warn', a),
    error: (...a) => out('error', a),
  };
}

module.exports = { create };
