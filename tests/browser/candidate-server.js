import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApp } from '../../server.js';

const directory = process.env.ENGLISH_UI_CANDIDATE_DIR;
if (!directory || process.env.APP_MODE !== 'mock') throw new Error('Candidate browser server requires offline mock mode and an explicit candidate directory');
const names = new Set(['index.html', 'app.js', 'voice.js', 'voice-options.js', 'voice-options.css', 'style.css', 'ni-airlines-logo.png',
  'waiting.js', 'agent-status.js', 'speech-input.js', 'audio-worklet.js', 'i18n.js']);
const index = await readFile(path.join(directory, 'index.html'), 'utf8');
const theme = index.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
const themeHash = createHash('sha256').update(theme).digest('base64');
const server = createApp({ ...process.env, APP_MODE: 'mock' });
const handler = server.listeners('request')[0];
server.removeListener('request', handler);
server.on('request', async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (request.method !== 'GET' || !names.has(name)) return handler(request, response);
  try {
    const body = await readFile(path.join(directory, name));
    response.writeHead(200, {
      'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' :
        name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'sha256-${themeHash}'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    });
    response.end(body);
  } catch (error) {
    console.error(`Candidate asset failed: ${name}: ${error.code ?? error.name}`);
    response.writeHead(500); response.end('Candidate asset unavailable');
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
