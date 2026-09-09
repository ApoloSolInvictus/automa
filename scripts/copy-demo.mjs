import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const path of ['demo.html', 'privacy.html', 'terms.html', 'css', 'js', 'img', 'webfonts']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
