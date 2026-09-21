export function decodeHalf(u16, out) {
    const n = u16.length;
    const result = out || new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const h = u16[i];
        const sign = h & 0x8000 ? -1 : 1;
        const exp = (h >> 10) & 0x1f;
        const frac = h & 0x3ff;
        if (exp === 0) result[i] = sign * frac * 5.9604644775390625e-8;
        else if (exp === 31) result[i] = frac ? NaN : sign * Infinity;
        else result[i] = sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
    }
    return result;
}

export class FieldModel {
    constructor(meta, positions, triangles, leadfield) {
        this.meta = meta;
        this.positions = positions;
        this.triangles = triangles;
        this.leadfield = leadfield;
        this.vertexCount = meta.vertices;
        this.electrodes = meta.electrodes;
        this.index = new Map(meta.electrodes.map((e, i) => [e.name, i]));
        this.field = new Float32Array(this.vertexCount * 3);
        this.magnitude = new Float32Array(this.vertexCount);
        this.normalComponent = new Float32Array(this.vertexCount);
        this.normals = computeNormals(positions, triangles);
    }

    static async load(base) {
        const meta = await (await fetch(new URL('model.json', base))).json();
        const geo = await (await fetch(new URL('geometry.bin', base))).arrayBuffer();
        const lf = await (await fetch(new URL('leadfield.bin', base))).arrayBuffer();
        const [pOff, pLen] = meta.geometry.positions;
        const [tOff, tLen] = meta.geometry.triangles;
        const positions = new Float32Array(geo, pOff, pLen / 4);
        const triangles = new Uint32Array(geo, tOff, tLen / 4);
        const expected = meta.electrodes.length * meta.vertices * 3;
        const raw = new Uint16Array(lf);
        if (raw.length !== expected) {
            throw new Error(`leadfield.bin holds ${raw.length} values, expected ${expected}`);
        }
        return new FieldModel(meta, positions, triangles, decodeHalf(raw));
    }

    apply(currents) {
        const n = this.vertexCount;
        const field = this.field;
        field.fill(0);
        let balance = 0;
        for (const [name, mA] of Object.entries(currents)) {
            balance += mA;
            const e = this.index.get(name);
            if (e === undefined || !mA) continue;
            const offset = e * n * 3;
            for (let i = 0; i < n * 3; i++) field[i] += mA * this.leadfield[offset + i];
        }
        const mag = this.magnitude;
        const normal = this.normalComponent;
        const normals = this.normals;
        let peak = 0;
        for (let v = 0; v < n; v++) {
            const x = field[v * 3];
            const y = field[v * 3 + 1];
            const z = field[v * 3 + 2];
            const m = Math.sqrt(x * x + y * y + z * z);
            mag[v] = m;
            normal[v] = -(x * normals[v * 3] + y * normals[v * 3 + 1] + z * normals[v * 3 + 2]);
            if (m > peak) peak = m;
        }
        return { balance, peak, stats: this.stats(peak) };
    }

    stats(peak) {
        const sorted = Float32Array.from(this.magnitude).sort();
        const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
        const robustPeak = q(0.99);
        const half = robustPeak / 2;
        let above = 0;
        for (let i = 0; i < this.magnitude.length; i++) if (this.magnitude[i] >= half) above++;
        return {
            peak,
            robustPeak,
            median: q(0.5),
            focality: above / this.magnitude.length,
        };
    }
}

export function computeNormals(positions, triangles) {
    const n = positions.length / 3;
    const normals = new Float32Array(positions.length);
    for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t] * 3;
        const b = triangles[t + 1] * 3;
        const c = triangles[t + 2] * 3;
        const ux = positions[b] - positions[a];
        const uy = positions[b + 1] - positions[a + 1];
        const uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a];
        const vy = positions[c + 1] - positions[a + 1];
        const vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const i of [a, b, c]) {
            normals[i] += nx;
            normals[i + 1] += ny;
            normals[i + 2] += nz;
        }
    }
    let outward = 0;
    for (let v = 0; v < n; v++) {
        const len = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]) || 1;
        normals[v * 3] /= len;
        normals[v * 3 + 1] /= len;
        normals[v * 3 + 2] /= len;
        outward += normals[v * 3] * positions[v * 3] + normals[v * 3 + 1] * positions[v * 3 + 1] + normals[v * 3 + 2] * positions[v * 3 + 2];
    }
    if (outward < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
    return normals;
}

const SEQUENTIAL = [
    [0.03, 0.05, 0.12], [0.24, 0.10, 0.42], [0.52, 0.15, 0.51],
    [0.78, 0.27, 0.41], [0.95, 0.48, 0.23], [0.99, 0.76, 0.28], [0.99, 0.99, 0.75],
];

const DIVERGING = [
    [0.13, 0.30, 0.55], [0.40, 0.62, 0.78], [0.78, 0.86, 0.90],
    [0.96, 0.96, 0.94], [0.93, 0.76, 0.62], [0.82, 0.45, 0.32], [0.60, 0.13, 0.15],
];

function sample(stops, t) {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function colorize(values, colors, scale, diverging) {
    const stops = diverging ? DIVERGING : SEQUENTIAL;
    for (let v = 0; v < values.length; v++) {
        const t = diverging ? 0.5 + values[v] / (2 * scale) : values[v] / scale;
        const c = sample(stops, t);
        colors[v * 3] = c[0] ** 2.2;
        colors[v * 3 + 1] = c[1] ** 2.2;
        colors[v * 3 + 2] = c[2] ** 2.2;
    }
}

export function colorbarStops(diverging, steps = 24) {
    const stops = diverging ? DIVERGING : SEQUENTIAL;
    return Array.from({ length: steps }, (_, i) => {
        const c = sample(stops, i / (steps - 1));
        return `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
    });
}
