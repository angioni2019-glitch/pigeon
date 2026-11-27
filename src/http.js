'use strict';
// Tiny HTTP helpers and router (no framework, so the bridge has only TDLib deps).

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Connect IQ is strict about content types: send exactly "application/json"
// (no charset parameter) so the phone app hands the body to the watch.
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function binary(res, buf) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function html(res, status, markup) {
  const body = Buffer.from(markup);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) reject(e);
    });
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Bad JSON');
  }
}

async function readForm(req, limit = 16 * 1024) {
  const buf = await readBody(req, limit);
  return new URLSearchParams(buf.toString('utf8'));
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return pathMatched ? { notAllowed: true } : null;
  }
}

/** Simple fixed-window rate limiter keyed by string (e.g. IP + route). */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.start > this.windowMs) {
      e = { start: now, n: 0 };
      this.hits.set(key, e);
    }
    e.n++;
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (now - v.start > this.windowMs) this.hits.delete(k);
    }
    return e.n <= this.max;
  }
}

module.exports = { HttpError, json, binary, html, readBody, readJson, readForm, Router, RateLimiter };
