import * as THREE from 'three';
import { TrackballControls } from '../vendor/TrackballControls.js';
import { FieldModel, colorize, colorbarStops } from './field.js';

const PRESETS = {
    'm1-so': { label: 'M1 – supraorbital (C3 / Fp2)', anodes: ['C3'], cathodes: ['Fp2'], current: 2 },
    'dlpfc': { label: 'DLPFC bilateral (F3 / F4)', anodes: ['F3'], cathodes: ['F4'], current: 2 },
    'hd-4x1': { label: 'HD 4×1 over C3', anodes: ['C3'], cathodes: ['FC3', 'CP3', 'C1', 'C5'], current: 2 },
    'occipital': { label: 'Occipital (Oz / Cz)', anodes: ['Oz'], cathodes: ['Cz'], current: 1.5 },
};

const state = {
    model: null,
    anodes: new Set(),
    cathodes: new Set(),
    current: 2,
    mode: 'magnitude',
    overlay: true,
    scale: null,
    autoScale: true,
    tool: 'anode',
};

const DEFAULT_MODEL = 'ernie';

const VIEWS = {
    left: { dir: [-1, 0, 0], up: [0, 0, 1], label: 'Left lateral' },
    right: { dir: [1, 0, 0], up: [0, 0, 1], label: 'Right lateral' },
    front: { dir: [0, 1, 0], up: [0, 0, 1], label: 'Anterior' },
    back: { dir: [0, -1, 0], up: [0, 0, 1], label: 'Posterior' },
    top: { dir: [0, 0, 1], up: [0, 1, 0], label: 'Superior' },
    bottom: { dir: [0, 0, -1], up: [0, -1, 0], label: 'Inferior' },
};

const el = id => document.getElementById(id);
const scene = new THREE.Scene();
let renderer, camera, controls, mesh, colors, electrodeGroup, raycaster, pointer, hovered = null;
let modelRadius = 100;
let settingView = false;
let dragStart = null;

async function init() {
    const params = new URLSearchParams(location.search);
    const modelName = params.get('model') || DEFAULT_MODEL;
    try {
        state.model = await FieldModel.load(new URL(`../models/${modelName}/`, import.meta.url).href);
    } catch (err) {
        el('loading').textContent = `Could not load the model "${modelName}". `
            + `Check that efield-lab/models/${modelName}/ exists and holds model.json, geometry.bin and leadfield.bin. `
            + `(${err.message})`;
        return;
    }
    buildScene();
    buildControls();
    buildHelp();
    buildModelPicker(modelName);
    readHash();
    recompute();
    el('loading').remove();
    animate();
}

function buildScene() {
    const model = state.model;
    const canvas = el('view');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    scene.background = new THREE.Color(0xf2f0eb);

    let maxR = 0;
    for (let i = 0; i < model.positions.length; i += 3) {
        const r = Math.hypot(model.positions[i], model.positions[i + 1], model.positions[i + 2]);
        if (r > maxR) maxR = r;
    }
    modelRadius = maxR;

    camera = new THREE.PerspectiveCamera(38, 1, 1, maxR * 20);
    controls = new TrackballControls(camera, canvas);
    controls.rotateSpeed = 3.2;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.7;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.15;
    controls.minDistance = maxR * 1.05;
    controls.maxDistance = maxR * 6;
    controls.addEventListener('change', () => {
        if (!settingView) markFreeView();
    });

    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(-1, 1, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(1, -0.5, -1);
    scene.add(fill);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3));
    colors = new Float32Array(model.vertexCount * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(model.triangles, 1));
    mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
    scene.add(mesh);

    electrodeGroup = new THREE.Group();
    const sphere = new THREE.SphereGeometry(3, 16, 12);
    for (const e of model.electrodes) {
        const dot = new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ color: 0xbdb8ad, transparent: true, opacity: 0.55 }));
        dot.position.fromArray(e.position);
        dot.userData.name = e.name;
        electrodeGroup.add(dot);
    }
    scene.add(electrodeGroup);

    setView('left');

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', event => {
        dragStart = { x: event.clientX, y: event.clientY, t: Date.now() };
    });
    canvas.addEventListener('pointerup', onClick);
    addEventListener('resize', resize);
    resize();
}

function buildHelp() {
    const tip = el('help-tip');
    for (const mark of document.querySelectorAll('.help')) {
        mark.addEventListener('mouseenter', () => {
            tip.textContent = mark.dataset.tip;
            tip.hidden = false;
            const box = mark.getBoundingClientRect();
            const size = tip.getBoundingClientRect();
            let left = box.left + box.width / 2 - size.width / 2;
            left = Math.max(12, Math.min(left, innerWidth - size.width - 12));
            let top = box.top - size.height - 10;
            if (top < 12) top = box.bottom + 10;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        });
        mark.addEventListener('mouseleave', () => { tip.hidden = true; });
    }
}

function buildControls() {
    const presets = el('preset');
    for (const [key, p] of Object.entries(PRESETS)) {
        presets.append(new Option(p.label, key));
    }
    presets.value = '';
    presets.addEventListener('change', () => {
        const p = PRESETS[presets.value];
        if (!p) return;
        state.anodes = new Set(p.anodes.filter(n => state.model.index.has(n)));
        state.cathodes = new Set(p.cathodes.filter(n => state.model.index.has(n)));
        state.current = p.current;
        el('current').value = p.current;
        recompute();
    });

    el('current').addEventListener('input', e => {
        const value = Number(e.target.value);
        if (!(value > 0)) return;
        state.current = clampCurrent(value);
        recompute();
    });
    el('current').addEventListener('change', e => {
        e.target.value = state.current;
    });
    for (const input of document.querySelectorAll('input[name="tool"]')) {
        input.addEventListener('change', () => { state.tool = input.value; });
    }
    for (const input of document.querySelectorAll('input[name="mode"]')) {
        input.addEventListener('change', () => {
            state.mode = input.value;
            recompute();
        });
    }
    el('autoscale').addEventListener('change', e => {
        state.autoScale = e.target.checked;
        el('scale').disabled = state.autoScale;
        recompute();
    });
    el('scale').addEventListener('input', e => {
        const value = Number(e.target.value);
        if (!(value > 0)) return;
        state.scale = value;
        recompute();
    });
    el('scale').addEventListener('change', e => {
        if (!(Number(e.target.value) > 0)) e.target.value = state.scale.toFixed(3);
    });
    for (const button of document.querySelectorAll('[data-view]')) {
        button.addEventListener('click', () => setView(button.dataset.view));
    }
    el('capture').addEventListener('click', capture);
    el('recentre').addEventListener('click', recentre);
    el('overlay').addEventListener('change', e => {
        state.overlay = e.target.checked;
        el('hud').hidden = !state.overlay;
    });
    el('clear').addEventListener('click', () => {
        state.anodes.clear();
        state.cathodes.clear();
        recompute();
    });
    el('reference').textContent = state.model.meta.reference;
    el('model-name').textContent = state.model.meta.name;
    el('electrode-spec').textContent = electrodeLabel();
    el('vertex-count').textContent = state.model.vertexCount.toLocaleString('en');
    if (state.model.meta.synthetic) el('synthetic-warning').hidden = false;
}

function electrodeLabel() {
    const e = state.model.meta.electrode;
    if (!e) return 'not recorded';
    if (e.label) return e.label;
    if (e.shape === 'point') return 'point sources';
    if (e.width_mm) return `rectangular, ${e.width_mm} × ${e.height_mm || e.width_mm} mm`;
    if (e.diameter_mm) {
        const gel = e.thickness_mm ? `, ${e.thickness_mm} mm gel` : '';
        return `round, ${e.diameter_mm} mm diameter${gel}`;
    }
    return e.shape || 'not recorded';
}

async function buildModelPicker(current) {
    const picker = el('model');
    let list;
    try {
        const url = new URL('../models/index.json', import.meta.url).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        list = await res.json();
    } catch (err) {
        return;
    }
    if (!Array.isArray(list) || list.length < 2) return;
    for (const entry of list) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.label || entry.id;
        if (entry.id === current) option.selected = true;
        picker.appendChild(option);
    }
    picker.addEventListener('change', () => {
        location.href = `${location.pathname}?model=${encodeURIComponent(picker.value)}${location.hash}`;
    });
    el('model-group').hidden = false;
}

function clampCurrent(value) {
    const input = el('current');
    return Math.min(Number(input.max), Math.max(Number(input.min), value));
}

function currents() {
    const out = {};
    const a = state.anodes.size;
    const c = state.cathodes.size;
    if (!a || !c) return out;
    for (const n of state.anodes) out[n] = state.current / a;
    for (const n of state.cathodes) out[n] = -state.current / c;
    return out;
}

function recompute() {
    const model = state.model;
    const result = model.apply(currents());
    const values = state.mode === 'normal' ? model.normalComponent : model.magnitude;
    let scale = state.scale;
    if (state.autoScale || !scale) {
        scale = state.mode === 'normal'
            ? Math.max(1e-6, percentile(values, 0.995, true))
            : Math.max(1e-6, result.stats.robustPeak);
        state.scale = scale;
        el('scale').value = scale.toFixed(3);
    }
    colorize(values, colors, scale, state.mode === 'normal');
    if (mesh) mesh.geometry.attributes.color.needsUpdate = true;
    paintElectrodes();
    updateReadout(result, scale);
    writeHash();
}

function percentile(values, p, absolute) {
    const copy = Float32Array.from(values);
    if (absolute) for (let i = 0; i < copy.length; i++) copy[i] = Math.abs(copy[i]);
    copy.sort();
    return copy[Math.min(copy.length - 1, Math.floor(p * copy.length))];
}

function paintElectrodes() {
    for (const dot of electrodeGroup.children) {
        const name = dot.userData.name;
        const active = state.anodes.has(name) ? 0xB4472F : state.cathodes.has(name) ? 0x2D5A8B : 0xbdb8ad;
        const on = state.anodes.has(name) || state.cathodes.has(name);
        dot.material.color.setHex(active);
        dot.material.opacity = on ? 1 : 0.5;
        dot.scale.setScalar(on ? 1.7 : 1);
    }
}

function updateReadout(result, scale) {
    const active = state.anodes.size && state.cathodes.size;
    const mode = state.mode === 'normal' ? 'Normal component' : 'Magnitude';
    const montage = active
        ? `${[...state.anodes].join(' + ')} \u2192 ${[...state.cathodes].join(' + ')}`
        : 'Select at least one anode and one cathode';

    el('peak').textContent = active ? `${result.stats.robustPeak.toFixed(3)} V/m` : '\u2014';
    el('median').textContent = active ? `${result.stats.median.toFixed(3)} V/m` : '\u2014';
    el('focality').textContent = active ? `${(result.stats.focality * 100).toFixed(1)} %` : '\u2014';
    el('montage').textContent = montage;

    const stops = colorbarStops(state.mode === 'normal');
    const gradient = `linear-gradient(to right, ${stops.join(',')})`;
    const minLabel = state.mode === 'normal' ? `\u2212${scale.toFixed(2)}` : '0';
    el('scale-max').textContent = `${scale.toFixed(2)} V/m`;
    el('scale-min').textContent = minLabel;
    el('colorbar').style.background = gradient;

    el('hud-montage').textContent = active ? `${montage}  \u00b7  ${state.current} mA` : montage;
    el('hud-sub').textContent = `${mode}  \u00b7  ${state.model.meta.name}  \u00b7  reference ${state.model.meta.reference}`
        + `  \u00b7  electrodes ${electrodeLabel()}`;
    el('hud-metrics').textContent = active
        ? `peak ${result.stats.robustPeak.toFixed(3)} V/m   median ${result.stats.median.toFixed(3)} V/m   `
          + `above half ${(result.stats.focality * 100).toFixed(1)} %`
        : '';
    el('hud-min').textContent = minLabel;
    el('hud-max').textContent = `${scale.toFixed(2)} V/m`;
    el('hud-bar').style.background = gradient;
}

function onPointerMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    pointer.x = (x / rect.width) * 2 - 1;
    pointer.y = -(y / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const chip = el('cursor-chip');
    const place = text => {
        chip.hidden = false;
        chip.textContent = text;
        const box = chip.getBoundingClientRect();
        const left = Math.min(x + 14, rect.width - box.width - 8);
        const top = Math.min(Math.max(y + 14, 8), rect.height - box.height - 8);
        chip.style.left = `${left}px`;
        chip.style.top = `${top}px`;
    };

    const hits = raycaster.intersectObjects(electrodeGroup.children, false);
    hovered = hits.length ? hits[0].object.userData.name : null;
    if (hovered) {
        const role = state.anodes.has(hovered) ? 'anode' : state.cathodes.has(hovered) ? 'cathode' : 'not used';
        place(`${hovered}\n${role}`);
        renderer.domElement.style.cursor = 'pointer';
        return;
    }
    renderer.domElement.style.cursor = 'grab';

    const surface = raycaster.intersectObject(mesh, false);
    if (!surface.length) {
        chip.hidden = true;
        el('hover-value').textContent = '\u2014';
        return;
    }
    const face = surface[0].face;
    const mean = values => (values[face.a] + values[face.b] + values[face.c]) / 3;
    const magnitude = mean(state.model.magnitude);
    const normal = mean(state.model.normalComponent);
    const shown = state.mode === 'normal' ? normal : magnitude;
    el('hover-value').textContent = `${shown.toFixed(3)} V/m`;
    place(`|E|  ${magnitude.toFixed(3)} V/m\nE\u22a5  ${normal >= 0 ? '+' : '\u2212'}${Math.abs(normal).toFixed(3)} V/m`);
}

function onClick(event) {
    const moved = dragStart
        ? Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y)
        : 0;
    const held = dragStart ? Date.now() - dragStart.t : 0;
    dragStart = null;
    if (moved > 5 || held > 500) return;
    if (!hovered) return;
    const target = state.tool === 'anode' ? state.anodes : state.cathodes;
    const other = state.tool === 'anode' ? state.cathodes : state.anodes;
    other.delete(hovered);
    if (target.has(hovered)) target.delete(hovered);
    else target.add(hovered);
    el('preset').value = '';
    recompute();
}

function writeHash() {
    const parts = [];
    if (state.anodes.size) parts.push(`a=${[...state.anodes].join('.')}`);
    if (state.cathodes.size) parts.push(`c=${[...state.cathodes].join('.')}`);
    parts.push(`i=${state.current}`);
    if (state.mode !== 'magnitude') parts.push(`v=${state.mode}`);
    history.replaceState(null, '', `#${parts.join('&')}`);
}

function readHash() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const known = name => state.model.index.has(name);
    if (hash.get('a')) state.anodes = new Set(hash.get('a').split('.').filter(known));
    if (hash.get('c')) state.cathodes = new Set(hash.get('c').split('.').filter(known));
    const current = Number(hash.get('i'));
    if (current > 0) state.current = clampCurrent(current);
    if (hash.get('v') === 'normal') state.mode = 'normal';
    el('current').value = state.current;
    for (const input of document.querySelectorAll('input[name="mode"]')) {
        input.checked = input.value === state.mode;
    }
    if (!state.anodes.size && !state.cathodes.size) {
        const preset = PRESETS['m1-so'];
        state.anodes = new Set(preset.anodes.filter(known));
        state.cathodes = new Set(preset.cathodes.filter(known));
        el('preset').value = 'm1-so';
    }
}

function setView(name) {
    const view = VIEWS[name];
    if (!view || !camera) return;
    settingView = true;
    const distance = modelRadius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    camera.up.set(...view.up);
    camera.position.set(...view.dir.map(v => v * distance));
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
    settingView = false;
    el('hud-view').textContent = view.label;
    for (const button of document.querySelectorAll('[data-view]')) {
        button.classList.toggle('active', button.dataset.view === name);
    }
}

function markFreeView() {
    el('hud-view').textContent = 'Free view';
    for (const button of document.querySelectorAll('[data-view]')) {
        button.classList.remove('active');
    }
}

function recentre() {
    if (!camera) return;
    settingView = true;
    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(0, 0, 0);
    camera.position.copy(offset);
    camera.lookAt(controls.target);
    controls.update();
    settingView = false;
}

function capture() {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = 3;

    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    renderer.render(scene, camera);

    const shot = new Image();
    shot.onload = () => {
        const out = document.createElement('canvas');
        out.width = shot.width;
        out.height = shot.height;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#F2F0EB';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(shot, 0, 0);
        if (state.overlay) drawOverlay(ctx, out.width, out.height, scale);

        const link = document.createElement('a');
        const slug = el('montage').textContent.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'montage';
        link.download = `efield-${state.model.meta.name}-${slug}.png`;
        link.href = out.toDataURL('image/png');
        link.click();

        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        resize();
    };
    shot.src = canvas.toDataURL('image/png');
}

function drawOverlay(ctx, width, height, scale) {
    const pad = 20 * scale;
    const band = 104 * scale;
    const top = height - band;

    const fade = ctx.createLinearGradient(0, top, 0, height);
    fade.addColorStop(0, 'rgba(250, 250, 248, 0)');
    fade.addColorStop(0.3, 'rgba(250, 250, 248, 0.85)');
    fade.addColorStop(1, 'rgba(250, 250, 248, 0.97)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, top, width, band);

    const baseline = height - pad;
    const barW = 190 * scale;
    const barH = 9 * scale;
    const barX = width - pad - barW;
    const barY = baseline - 52 * scale;
    const textWidth = Math.max(120 * scale, barX - pad - 24 * scale);

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#1A1A1A';
    ctx.font = `${15 * scale}px 'JetBrains Mono', monospace`;
    ctx.fillText(el('hud-montage').textContent, pad, baseline - 44 * scale, textWidth);
    ctx.fillStyle = '#5A5A52';
    ctx.font = `${12 * scale}px Inter, sans-serif`;
    ctx.fillText(el('hud-sub').textContent, pad, baseline - 24 * scale, textWidth);
    ctx.fillText(el('hud-metrics').textContent, pad, baseline - 5 * scale, textWidth);

    const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    const stops = colorbarStops(state.mode === 'normal');
    stops.forEach((c, i) => gradient.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = gradient;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = '#D4CFC4';
    ctx.lineWidth = scale;
    ctx.strokeRect(barX, barY, barW, barH);

    ctx.fillStyle = '#5A5A52';
    ctx.font = `${11 * scale}px 'JetBrains Mono', monospace`;
    const minLabel = el('hud-min').textContent;
    const maxLabel = el('hud-max').textContent;
    ctx.fillText(minLabel, barX, barY + barH + 20 * scale);
    ctx.fillText(maxLabel, barX + barW - ctx.measureText(maxLabel).width, barY + barH + 20 * scale);
    const viewLabel = el('hud-view').textContent;
    ctx.font = `${12 * scale}px Inter, sans-serif`;
    ctx.fillText(viewLabel, width - pad - ctx.measureText(viewLabel).width, baseline);
}

function resize() {
    const box = renderer.domElement.parentElement.getBoundingClientRect();
    renderer.setSize(box.width, box.height, false);
    camera.aspect = box.width / box.height;
    camera.updateProjectionMatrix();
    if (controls) controls.handleResize();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

init();
