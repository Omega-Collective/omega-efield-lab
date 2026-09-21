// Comprobaciones del motor del visor, sin navegador.
//
//     node --test tests/
//
// Se construye un FieldModel a mano, de modo que no hace falta ni red ni WebGL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeHalf, FieldModel, computeNormals, colorbarStops } from '../js/field.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- half float
test('decodeHalf reproduce los valores conocidos de float16', () => {
    const casos = [
        [0x0000, 0], [0x8000, -0], [0x3c00, 1], [0xbc00, -1],
        [0x4000, 2], [0x3800, 0.5], [0x7bff, 65504],
    ];
    const entrada = Uint16Array.from(casos.map(c => c[0]));
    const salida = decodeHalf(entrada);
    casos.forEach(([, esperado], i) => assert.equal(salida[i], esperado));
});

test('decodeHalf marca infinitos y NaN en vez de devolver basura', () => {
    const out = decodeHalf(Uint16Array.from([0x7c00, 0xfc00, 0x7e00]));
    assert.equal(out[0], Infinity);
    assert.equal(out[1], -Infinity);
    assert.ok(Number.isNaN(out[2]));
});

test('decodeHalf maneja los subnormales cerca de cero', () => {
    const out = decodeHalf(Uint16Array.from([0x0001]));
    assert.ok(out[0] > 0 && out[0] < 1e-7, `subnormal inesperado: ${out[0]}`);
});

// --------------------------------------------------------------- modelo de juguete
// Un tetraedro con tres electrodos: suficiente para ejercitar la aritmetica.
function modeloDePrueba() {
    const positions = Float32Array.from([
        0, 0, 10, 10, 0, -5, -5, 8, -5, -5, -8, -5,
    ]);
    const triangles = Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
    const meta = {
        format: 1, name: 'prueba', units: 'V/m per mA',
        vertices: 4, triangles: 4, reference: 'REF',
        electrode: { shape: 'ellipse', diameter_mm: 20, thickness_mm: 4 },
        electrodes: [
            { name: 'A', position: [0, 0, 40] },
            { name: 'B', position: [40, 0, 0] },
            { name: 'REF', position: [0, 40, 0] },
        ],
        geometry: { positions: [0, 48], triangles: [48, 48] },
    };
    const leadfield = new Float32Array(3 * 4 * 3);
    for (let v = 0; v < 4; v++) leadfield[v * 3] = 0.1 * (v + 1);          // A: en x
    for (let v = 0; v < 4; v++) leadfield[12 + v * 3 + 1] = 0.2 * (v + 1); // B: en y
    // la fila de REF queda en cero, como en un export real
    return new FieldModel(meta, positions, triangles, leadfield);
}

test('apply suma las contribuciones ponderadas por la corriente', () => {
    const m = modeloDePrueba();
    m.apply({ A: 1, REF: -1 });
    assert.ok(Math.abs(m.field[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(m.magnitude[0] - 0.1) < 1e-6);
});

test('duplicar la corriente duplica el campo', () => {
    const m = modeloDePrueba();
    m.apply({ A: 1, REF: -1 });
    const uno = Array.from(m.magnitude);
    m.apply({ A: 2, REF: -2 });
    uno.forEach((v, i) => assert.ok(Math.abs(m.magnitude[i] - 2 * v) < 1e-6,
        `vertice ${i}: ${m.magnitude[i]} no es el doble de ${v}`));
});

test('la superposicion de dos montajes equivale al montaje combinado', () => {
    const m = modeloDePrueba();
    m.apply({ A: 1, REF: -1 });
    const soloA = Array.from(m.field);
    m.apply({ B: 1, REF: -1 });
    const soloB = Array.from(m.field);
    m.apply({ A: 1, B: 1, REF: -2 });
    soloA.forEach((v, i) => assert.ok(Math.abs(m.field[i] - (v + soloB[i])) < 1e-6,
        `componente ${i} rompe la linealidad`));
});

test('apply informa del balance de corriente', () => {
    const m = modeloDePrueba();
    assert.equal(m.apply({ A: 1, REF: -1 }).balance, 0);
    assert.equal(m.apply({ A: 2, REF: -1 }).balance, 1, 'un montaje desbalanceado debe notarse');
});

test('un electrodo inexistente no rompe el calculo', () => {
    const m = modeloDePrueba();
    assert.doesNotThrow(() => m.apply({ NOEXISTE: 1, REF: -1 }));
});

test('sin corriente el campo es exactamente cero', () => {
    const m = modeloDePrueba();
    m.apply({ A: 1, REF: -1 });
    m.apply({});
    assert.ok(m.magnitude.every(v => v === 0));
});

test('las estadisticas son coherentes entre si', () => {
    const m = modeloDePrueba();
    const { stats } = m.apply({ A: 1, REF: -1 });
    assert.ok(stats.robustPeak <= stats.peak, 'el percentil 99 no puede superar el maximo');
    assert.ok(stats.median <= stats.robustPeak);
    assert.ok(stats.focality > 0 && stats.focality <= 1);
});

// --------------------------------------------------------------- normales
test('computeNormals devuelve vectores unitarios', () => {
    const m = modeloDePrueba();
    for (let v = 0; v < 4; v++) {
        const len = Math.hypot(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]);
        assert.ok(Math.abs(len - 1) < 1e-5, `normal ${v} mide ${len}`);
    }
});

test('las normales apuntan hacia afuera', () => {
    const m = modeloDePrueba();
    let fuera = 0;
    for (let v = 0; v < 4; v++) {
        fuera += m.normals[v * 3] * m.positions[v * 3]
            + m.normals[v * 3 + 1] * m.positions[v * 3 + 1]
            + m.normals[v * 3 + 2] * m.positions[v * 3 + 2];
    }
    assert.ok(fuera > 0, 'la superficie quedo del reves');
});

// --------------------------------------------------------------- escalas de color
test('colorbarStops entrega una rampa utilizable', () => {
    for (const diverging of [false, true]) {
        const stops = colorbarStops(diverging);
        assert.ok(stops.length >= 2);
        stops.forEach(s => assert.match(s, /^rgb/, `parada invalida: ${s}`));
    }
});

// --------------------------------------------------------------- modelos reales
test('los modelos publicados declaran su geometria de electrodo', () => {
    const indice = join(ROOT, 'models', 'index.json');
    if (!existsSync(indice)) return;
    for (const entrada of JSON.parse(readFileSync(indice, 'utf8'))) {
        const ruta = join(ROOT, 'models', entrada.id, 'model.json');
        assert.ok(existsSync(ruta), `falta models/${entrada.id}/model.json`);
        const meta = JSON.parse(readFileSync(ruta, 'utf8'));
        assert.ok(meta.electrode, `${entrada.id} no declara electrode`);
        assert.equal(meta.units, 'V/m per mA');
        assert.ok(meta.electrodes.some(e => e.name === meta.reference),
            `${entrada.id}: la referencia no esta en la lista de electrodos`);
    }
});
