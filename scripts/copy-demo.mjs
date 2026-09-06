import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const path of ['demo.html', 'css', 'js', 'img', 'webfonts']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
