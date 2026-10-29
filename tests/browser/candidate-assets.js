import path from 'node:path';

export async function candidateAssets(page) {
  const directory = process.env.VOICE_UI_CANDIDATE_DIR;
  if (!directory) return;
  for (const name of ['voice.js', 'voice-options.js', 'voice-options.css']) {
    await page.route(url => url.pathname === `/${name}`, route => route.fulfill({
      path: path.join(directory, name), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript'
    }));
  }
}
