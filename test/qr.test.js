'use strict';
// QR encoder checks. If Python with OpenCV is available, codes are also
// decoded to prove they scan.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const qr = require('../src/qr');

test('watch format: n rows of ceil(n/4) hex digits, finder pattern in the corner', () => {
  const w = qr.encodeForWatch('tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAh');
  assert.ok(w.n >= 21 && (w.n - 17) % 4 === 0);
  assert.strictEqual(w.r.length, w.n);
  for (const row of w.r) assert.strictEqual(row.length, Math.ceil(w.n / 4));
  // Top-left finder: first row starts with 7 dark modules.
  const bits = parseInt(w.r[0].slice(0, 2), 16).toString(2).padStart(8, '0');
  assert.strictEqual(bits.slice(0, 7), '1111111');
});

test('codes decode with OpenCV (skipped if unavailable)', (t) => {
  const probe = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python3 + opencv not installed');
    return;
  }
  const texts = [
    'tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAh',
    'https://tg.example.com/p/k3J9xQ2mZpLq',
    'x',
  ];
  const cases = texts.map((text) => ({ text, m: qr.encode(text).modules.map((r) => r.map((c) => (c ? 1 : 0)).join('')) }));
  const py = `
import json, sys, cv2, numpy as np
cases = json.load(sys.stdin)
det = cv2.QRCodeDetector()
out = []
for c in cases:
    m = c['m']; n = len(m); q = 4; s = 10
    img = np.full(((n+2*q)*s, (n+2*q)*s), 255, np.uint8)
    for y in range(n):
        for x in range(n):
            if m[y][x] == '1': img[(y+q)*s:(y+q+1)*s, (x+q)*s:(x+q+1)*s] = 0
    out.append(det.detectAndDecode(img)[0])
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', py], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), texts);
});
