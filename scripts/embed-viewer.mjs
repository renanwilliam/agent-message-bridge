import { readFile, writeFile } from 'node:fs/promises';
const js = await readFile('dist/viewer/viewer.js', 'utf8');
const css = await readFile('dist/viewer/viewer.css', 'utf8');
// O bundle é incorporado à resposta existente: sem CDN, nova origem ou rota de assets.
const escape = (value) =>
  value.replace(/<\/script/gi, '<\\/script').replace(/<\/style/gi, '<\\/style');
await writeFile(
  'src/viewer-assets.ts',
  `// Gerado por npm run build:viewer.\nexport const viewerJs = ${JSON.stringify(escape(js))};\nexport const viewerCss = ${JSON.stringify(escape(css))};\n`,
);
