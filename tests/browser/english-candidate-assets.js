import path from 'node:path';

export async function englishCandidateAssets(page, baseURL = 'http://127.0.0.1:3101') {
  const directory = process.env.ENGLISH_UI_CANDIDATE_DIR;
  if (!directory) throw new Error('ENGLISH_UI_CANDIDATE_DIR is required for English candidate assets');
  const assets = new Set(['index.html', 'app.js', 'voice.js', 'voice-options.js', 'voice-options.css', 'style.css', 'ni-airlines-logo.png',
    'waiting.js', 'agent-status.js', 'speech-input.js', 'audio-worklet.js', 'i18n.js']);
  const origin = new URL(baseURL);
  await page.route(url => url.origin === origin.origin && (url.pathname === '/' || assets.has(url.pathname.slice(1))), route => {
    const pathname = new URL(route.request().url()).pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    return route.fulfill({ path: path.join(directory, filename), contentType: filename.endsWith('.html') ?
      'text/html' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/javascript' });
  });
}
