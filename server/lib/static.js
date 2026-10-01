/**
 * Minimal static file server for the `public/` directory.
 *
 * Deliberately tiny: the client is plain HTML/CSS/JS with no build step, so
 * there is nothing to bundle and no need for a framework here.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function serve(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    // Single-page client: every unknown path renders index.html so that
    // /?room=ABCD style links (and any future routes) still load.
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let filePath = path.resolve(root, rel);

    // Containment check: never serve anything outside public/.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info?.isFile()) {
      filePath = path.join(root, 'index.html');
      info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // index.html must never be cached or players get a stale client after a
      // deploy; fingerprint-free assets get a short cache instead.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(filePath).pipe(res);
  };
}
