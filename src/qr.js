'use strict';
// Minimal QR Code encoder (ISO/IEC 18004), byte mode, versions 1-10.
// Enough for Telegram login links (~60 chars) and the 2FA page URL.
// Output: { size, rows } where rows[y] is a hex string, MSB first,
// i.e. module x of row y is bit (3 - x % 4) of hex digit floor(x / 4).
// That compact form is what the watch app draws.

const ECL = {
  L: { idx: 0, fmt: 1 },
  M: { idx: 1, fmt: 0 },
  Q: { idx: 2, fmt: 3 },
  H: { idx: 3, fmt: 2 },
};

// Per version (1..10), per level [L, M, Q, H]:
// [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsGroup1, blocksInGroup2, dataCodewordsGroup2]
const BLOCKS = [
  null,
  [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
  [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
  [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
  [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
  [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
  [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
  [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
  [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
  [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
];

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const MAX_VERSION = 10;

// ---- GF(256) arithmetic, primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d) ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial coefficients (highest degree first, leading 1 omitted).
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
    }
  }
  return rem;
}

function dataCapacity(version, level) {
  const [, b1, d1, b2, d2] = BLOCKS[version][ECL[level].idx];
  return b1 * d1 + b2 * d2;
}

function countBits(version) {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLen, level) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const bitsNeeded = 4 + countBits(v) + byteLen * 8;
    if (bitsNeeded <= dataCapacity(v, level) * 8) return v;
  }
  throw new Error(`QR payload too long (${byteLen} bytes)`);
}

function buildCodewords(bytes, version, level) {
  const capacity = dataCapacity(version, level);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capBits = capacity * 8;
  push(0, Math.min(4, capBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, compute EC, interleave.
  const [ecLen, b1, d1, b2, d2] = BLOCKS[version][ECL[level].idx];
  const blocks = [];
  let off = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const chunk = data.slice(off, off + len);
    off += len;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
  }
  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) out.push(blk.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) out.push(blk.ec[i]);
  }
  return out;
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = ALIGN[this.version];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
        if (!corner) this.alignment(pos[i], pos[j]);
      }
    }
    this.formatBits(0, 0); // reserve
    this.versionBits();
  }

  finder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, d !== 2 && d !== 4);
      }
    }
  }

  alignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  formatBits(levelFmt, mask) {
    const data = (levelFmt << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // dark module
  }

  versionBits() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const d = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, d);
      this.set(b, a, d);
    }
  }

  placeData(codewords) {
    let bitIndex = 0;
    const total = codewords.length * 8;
    const n = this.size;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.fixed[y][x]) continue;
          if (bitIndex < total) {
            this.dark[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (this.fixed[y][x]) continue;
        let flip;
        switch (mask) {
          case 0: flip = (x + y) % 2 === 0; break;
          case 1: flip = y % 2 === 0; break;
          case 2: flip = x % 3 === 0; break;
          case 3: flip = (x + y) % 3 === 0; break;
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (flip) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }

  penalty() {
    const n = this.size;
    const g = this.dark;
    let score = 0;
    const lineScore = (get) => {
      let s = 0;
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          if (get(a, b) === get(a, b - 1)) {
            run++;
          } else {
            if (run >= 5) s += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) s += 3 + (run - 5);
        // Finder-like 1:1:3:1:1 with 4 light modules on either side.
        for (let b = 0; b + 10 < n; b++) {
          const p = [];
          for (let k = 0; k < 11; k++) p.push(get(a, b + k) ? 1 : 0);
          const s1 = p.join('');
          if (s1 === '10111010000' || s1 === '00001011101') s += 40;
        }
      }
      return s;
    };
    score += lineScore((a, b) => g[a][b]);
    score += lineScore((a, b) => g[b][a]);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = g[y][x];
        if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) score += 3;
      }
    }
    let darkCount = 0;
    for (const row of g) for (const c of row) if (c) darkCount++;
    const pct = (darkCount * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  clone() {
    const m = new Matrix(this.version);
    m.dark = this.dark.map((r) => r.slice());
    m.fixed = this.fixed.map((r) => r.slice());
    return m;
  }
}

/**
 * Encode text into a QR matrix.
 * @param {string} text
 * @param {{level?: 'L'|'M'|'Q'|'H', minVersion?: number, mask?: number}} [opts]
 * @returns {{version:number, size:number, modules:boolean[][]}}
 */
function encode(text, opts = {}) {
  const level = opts.level || 'L';
  if (!ECL[level]) throw new Error('bad level');
  const bytes = Buffer.from(String(text), 'utf8');
  const version = Math.max(chooseVersion(bytes.length, level), opts.minVersion || 1);
  const codewords = buildCodewords(bytes, version, level);
  const base = new Matrix(version);
  base.drawFunctionPatterns();
  base.placeData(codewords);
  let best = null;
  let bestScore = Infinity;
  const masks = typeof opts.mask === 'number' ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const m = base.clone();
    m.applyMask(mask);
    m.formatBits(ECL[level].fmt, mask);
    const s = m.penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return { version, size: best.size, modules: best.dark };
}

/** Compact representation for the watch: { n, r: [hex rows] }. */
function toWatchFormat(qr) {
  const rows = qr.modules.map((row) => {
    let hex = '';
    for (let x = 0; x < row.length; x += 4) {
      let nib = 0;
      for (let k = 0; k < 4; k++) nib = (nib << 1) | (row[x + k] ? 1 : 0);
      hex += nib.toString(16);
    }
    return hex;
  });
  return { n: qr.size, r: rows };
}

function encodeForWatch(text, opts) {
  return toWatchFormat(encode(text, opts));
}

module.exports = { encode, encodeForWatch, toWatchFormat, dataCapacity, MAX_VERSION };
