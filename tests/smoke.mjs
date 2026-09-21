// Prueba de humo: sirve el repositorio, abre la pagina en un navegador real,
// aplica un montaje y comprueba que salen numeros creibles.
//
//     node tests/smoke.mjs
//
// Necesita playwright. Es el unico test que requiere navegador; los demas
// corren sin el.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream',
    '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, rel);
    if (rel === '/' || rel === '\\' || !extname(file)) file = join(ROOT, 'index.html');
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
});

const fail = m => { console.error('FALLO:', m); process.exitCode = 1; };

await new Promise(r => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
    // CHROMIUM_PATH permite usar un navegador ya instalado en el sistema
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const errors = [];
page.on('pageerror', e => errors.push('JS: ' + e.message));
page.on('response', r => {
    if (r.status() >= 400 && !r.url().includes('fonts.')) errors.push(`${r.status()} ${r.url()}`);
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 30000 })
    .catch(() => fail('el modelo no termino de cargar'));

// metadatos en la barra lateral
const meta = await page.evaluate(() => ({
    model: document.getElementById('model-name')?.textContent,
    reference: document.getElementById('reference')?.textContent,
    electrode: document.getElementById('electrode-spec')?.textContent,
    vertices: document.getElementById('vertex-count')?.textContent,
}));
if (!meta.model) fail('no se muestra el nombre del modelo');
if (!meta.reference) fail('no se muestra el electrodo de referencia');
if (!meta.electrode || meta.electrode === 'not recorded') fail('no se declara la geometria del electrodo');

// un montaje conocido debe dar un pico plausible
await page.selectOption('#preset', 'dlpfc');
await page.waitForTimeout(500);
const r = await page.evaluate(() => ({
    peak: parseFloat(document.getElementById('peak').textContent),
    median: parseFloat(document.getElementById('median').textContent),
    focality: parseFloat(document.getElementById('focality').textContent),
    montage: document.getElementById('montage').textContent,
}));
if (!(r.peak > 0.01 && r.peak < 5)) fail(`pico fuera de rango: ${r.peak} V/m`);
if (!(r.median >= 0 && r.median <= r.peak)) fail(`mediana incoherente: ${r.median}`);
if (!(r.focality > 0 && r.focality <= 100)) fail(`focalidad incoherente: ${r.focality}`);
if (!r.montage.includes('F3')) fail(`montaje inesperado: ${r.montage}`);

// HD 4x1 debe ser mas focal que un montaje de dos electrodos
await page.selectOption('#preset', 'hd-4x1');
await page.waitForTimeout(500);
const hd = await page.evaluate(() => parseFloat(document.getElementById('focality').textContent));
if (!(hd < r.focality)) fail(`HD 4x1 (${hd}%) deberia ser mas focal que F3/F4 (${r.focality}%)`);

if (errors.length) fail('errores en la pagina: ' + errors.join(' | '));

console.log(`modelo      ${meta.model}, ${meta.vertices} vertices, referencia ${meta.reference}`);
console.log(`electrodos  ${meta.electrode}`);
console.log(`F3/F4       pico ${r.peak} V/m, mediana ${r.median} V/m, focalidad ${r.focality} %`);
console.log(`HD 4x1      focalidad ${hd} %`);
console.log(process.exitCode ? '\nprueba de humo FALLIDA' : '\nprueba de humo correcta');

await browser.close();
server.close();
