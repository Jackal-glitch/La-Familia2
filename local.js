#!/usr/bin/env node
'use strict';
/* Essai sur un ordinateur (facultatif) : node local.js  puis  http://localhost:3000
   Utilise un fichier SQLite local (dossier data). La mise en ligne sur Vercel n'en a pas besoin. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const handle = require('./api/[...slug].js');
const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://local').pathname;
  if (p.startsWith('/api/')) return handle(req, res);
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(INDEX));
  }
  if (req.method === 'GET' && p === '/lending.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'lending.js')));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Introuvable');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\n  La Familia (essai local)\n  Ouvrez http://localhost:${PORT}\n  Données : ${path.resolve(process.env.DATA_DIR || 'data')}\n`);
});
