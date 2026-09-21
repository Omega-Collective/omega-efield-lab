import argparse
import glob
import json
import os
import re
import sys

import numpy as np
import h5py
from scipy.spatial import cKDTree

FORMAT_VERSION = 1


def read_surface(path):
    try:
        from simnibs import mesh_io
        mesh = mesh_io.Msh.read_hdf5(path, 'mesh_leadfield')
        tris = mesh.elm.node_number_list[mesh.elm.elm_type == 2][:, :3] - 1
        return mesh.nodes.node_coord.astype(np.float64), tris.astype(np.int64)
    except Exception:
        pass
    with h5py.File(path, 'r') as f:
        g = f['mesh_leadfield']
        nodes = g['nodes/node_coord'][:].astype(np.float64)
        elms = g['elm/node_number_list'][:]
        types = g['elm/elm_type'][:]
    tris = elms[types == 2][:, :3] - 1
    return nodes, tris.astype(np.int64)


def read_cap(path):
    names, pos = [], []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            parts = [p.strip() for p in line.split(',')]
            if len(parts) >= 5 and parts[0] in ('Electrode', 'ReferenceElectrode'):
                names.append(parts[4])
                pos.append([float(v) for v in parts[1:4]])
    return names, np.array(pos)


def find_cap(hdf5_path, explicit, attrs):
    if explicit:
        return explicit
    stored = attrs.get('electrode_cap')
    if isinstance(stored, list):
        stored = stored[0] if stored else None
    if stored and os.path.isfile(stored):
        return stored
    here = os.path.dirname(os.path.abspath(hdf5_path))
    for base in (here, os.path.dirname(here), os.path.dirname(os.path.dirname(here))):
        for pattern in (('m2m_*', 'eeg_positions', '*10-10*.csv'), ('*', 'm2m_*', 'eeg_positions', '*10-10*.csv')):
            hits = glob.glob(os.path.join(base, *pattern))
            if hits:
                return hits[0]
    return None


def positions_from_attrs(attrs, names):
    raw = attrs.get('electrode_pos')
    if raw is None:
        return None
    try:
        pos = np.asarray(raw, dtype=float)
    except (TypeError, ValueError):
        return None
    if pos.shape != (len(names), 3):
        return None
    return {n: pos[i] for i, n in enumerate(names)}


def keep_main_components(nodes, tris, min_fraction=0.05):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    edges = np.r_[tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]]
    graph = coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(len(nodes),) * 2)
    count, labels = connected_components(graph, directed=False)
    if count == 1:
        return nodes, tris, np.arange(len(nodes)), []

    sizes = np.bincount(labels, minlength=count)
    keep = np.flatnonzero(sizes >= min_fraction * len(nodes))
    dropped = [(int(sizes[i]), np.round(nodes[labels == i].mean(0), 0).tolist())
               for i in np.flatnonzero(sizes < min_fraction * len(nodes))]

    mask = np.isin(labels, keep)
    remap = -np.ones(len(nodes), np.int64)
    remap[mask] = np.arange(mask.sum())
    faces = remap[tris]
    faces = faces[(faces >= 0).all(1)]
    return nodes[mask], faces, np.flatnonzero(mask), dropped


def decimate(nodes, tris, target):
    if len(nodes) <= target:
        return nodes, tris
    try:
        import fast_simplification
        ratio = 1.0 - target / len(nodes)
        pts, faces = fast_simplification.simplify(nodes.astype(np.float32), tris.astype(np.int32), target_reduction=ratio)
        return pts.astype(np.float64), faces.astype(np.int64)
    except ImportError:
        pass
    span = nodes.max(0) - nodes.min(0)
    cell = (np.prod(span) / target) ** (1 / 3)
    for _ in range(12):
        keys = np.floor((nodes - nodes.min(0)) / cell).astype(np.int64)
        _, cluster, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
        if abs(len(counts) - target) / target < 0.15:
            break
        cell *= (len(counts) / target) ** (1 / 3)
    cluster = cluster.ravel()
    pts = np.zeros((len(counts), 3))
    np.add.at(pts, cluster, nodes)
    pts /= counts[:, None]
    faces = cluster[tris]
    keep = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    faces = np.unique(np.sort(faces[keep], axis=1), axis=0)
    return pts, faces


def resampler(src, dst, k=4):
    dist, idx = cKDTree(src).query(dst, k=k)
    w = 1.0 / np.maximum(dist, 1e-6)
    w /= w.sum(1, keepdims=True)
    w = w.astype(np.float32)

    def apply(row):
        return np.einsum('vk,vkc->vc', w, row[idx])

    return apply


def parse_current(value):
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode(errors='ignore')
    if isinstance(value, (int, float, np.floating, np.integer)):
        return float(value)
    m = re.match(r'\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([mun]?)A?\s*$', str(value))
    if not m:
        return None
    scale = {'m': 1e-3, 'u': 1e-6, 'n': 1e-9, '': 1.0}[m.group(2)]
    return float(m.group(1)) * scale


def read_electrode(hdf5_path, args):
    if args.electrodos_puntuales:
        return {'shape': 'point', 'label': 'point sources at the 10-10 positions'}
    if args.ancho:
        alto = args.alto if args.alto else args.ancho
        return {
            'shape': 'rect',
            'width_mm': round(args.ancho, 2),
            'height_mm': round(alto, 2),
            'thickness_mm': round(args.grosor, 2),
            'area_mm2': round(args.ancho * alto, 1),
            'label': f'rectangular, {args.ancho:.0f} x {alto:.0f} mm, {args.grosor:.0f} mm contact layer',
        }
    if args.diametro:
        radius = args.diametro / 2.0
        return {
            'shape': 'ellipse',
            'diameter_mm': round(args.diametro, 2),
            'thickness_mm': round(args.grosor, 2),
            'area_mm2': round(np.pi * radius ** 2, 1),
            'label': f'round, {args.diametro:.0f} mm diameter, {args.grosor:.0f} mm gel',
        }
    here = os.path.dirname(os.path.abspath(hdf5_path))
    for folder in (here, os.path.dirname(here)):
        path = os.path.join(folder, 'electrode.json')
        if os.path.isfile(path):
            with open(path, encoding='utf-8') as fh:
                return json.load(fh)
    return None


def main():
    ap = argparse.ArgumentParser(description='Convierte un leadfield de SimNIBS al formato del visor.')
    ap.add_argument('hdf5', help='Archivo .hdf5 producido por compute_leadfield.py')
    ap.add_argument('-o', '--out', default='model', help='Carpeta de salida')
    ap.add_argument('--name', default=None, help='Nombre del modelo')
    ap.add_argument('--cap', default=None, help='CSV del gorro EEG usado en el cálculo')
    ap.add_argument('--vertices', type=int, default=20000, help='Vértices de la superficie exportada')
    ap.add_argument('--diametro', type=float, default=None,
                    help='Diámetro del electrodo en mm, si no hay electrode.json junto al hdf5')
    ap.add_argument('--ancho', type=float, default=None,
                    help='Ancho del electrodo rectangular en mm, si no hay electrode.json junto al hdf5')
    ap.add_argument('--alto', type=float, default=None, help='Alto del electrodo rectangular en mm')
    ap.add_argument('--grosor', type=float, default=4.0, help='Grosor de la capa de contacto en mm')
    ap.add_argument('--electrodos-puntuales', action='store_true',
                    help='El leadfield se calculó con electrodos puntuales (--rapido)')
    args = ap.parse_args()

    handle = h5py.File(args.hdf5, 'r')
    ds = handle['mesh_leadfield/leadfields/tdcs_leadfield']
    shape = ds.shape
    attrs = {k: ds.attrs[k] for k in ds.attrs}

    def text(v):
        if isinstance(v, bytes):
            return v.decode()
        if isinstance(v, np.ndarray):
            return [text(x) for x in v.tolist()]
        return v

    attrs = {k: text(v) for k, v in attrs.items()}
    print('Atributos del leadfield:')
    for k, v in attrs.items():
        shown = v if not isinstance(v, list) or len(v) < 12 else f'[{len(v)} elementos]'
        print(f'  {k}: {shown}')
    print(f'Forma de la matriz: {shape} ({np.prod(shape) * 4 / 1e6:.0f} MB en disco)')

    names = list(attrs.get('electrode_names') or [])
    reference = attrs.get('reference_electrode')
    if not names or reference is None:
        sys.exit('El archivo no trae electrode_names o reference_electrode; revisa la versión de SimNIBS.')
    if isinstance(reference, list):
        reference = reference[0]

    active = [n for n in names if n != reference]
    if shape[0] != len(active):
        sys.exit(f'Filas del leadfield ({shape[0]}) no coinciden con electrodos activos ({len(active)}).')

    electrode = read_electrode(args.hdf5, args)
    if electrode:
        print(f'Geometria de los electrodos: {electrode.get("label", electrode)}')
    else:
        print('Aviso: no encontré electrode.json junto al hdf5 y no me pasaste --diametro. '
              'El modelo quedará sin anotar la geometría de los electrodos, y las figuras '
              'exportadas no podrán declararla.')

    current = parse_current(attrs.get('current'))
    if current:
        per_ma = 1e-3 / current
        print(f'Corriente de referencia: {current} A. Factor a V/m por mA: {per_ma:g}')
    else:
        per_ma = 1.0
        print(f'Aviso: no pude interpretar la corriente ({attrs.get("current")!r}); '
              'se asume que el leadfield ya está normalizado a 1 mA.')

    cap = None
    lookup = positions_from_attrs(attrs, names)
    if lookup:
        print('Posiciones de los electrodos: tomadas del propio archivo (electrode_pos)')
    else:
        cap = find_cap(args.hdf5, args.cap, attrs)
        if not cap:
            sys.exit('El archivo no trae electrode_pos y no encontré el CSV del gorro EEG. Pásalo con --cap.')
        print(f'Posiciones de los electrodos: {cap}')
        cap_names, cap_pos = read_cap(cap)
        lookup = {n: p for n, p in zip(cap_names, cap_pos)}
    missing = [n for n in names if n not in lookup]
    if missing:
        sys.exit(f'Electrodos sin posición: {missing}')

    nodes, tris = read_surface(args.hdf5)
    if shape[1] != len(nodes):
        sys.exit(f'La matriz tiene {shape[1]} nodos y la superficie {len(nodes)}.')

    print(f'Superficie original: {len(nodes)} nodos, {len(tris)} triangulos')
    full_nodes = nodes
    nodes, tris, kept, dropped = keep_main_components(nodes, tris)
    for size, centre in dropped:
        print(f'  descartada isla de {size} nodos centrada en {centre} (no es corteza)')
    if len(nodes) != len(full_nodes):
        print(f'Superficie sin islas: {len(nodes)} nodos, {len(tris)} triangulos')
    pts, faces = decimate(nodes, tris, args.vertices)
    print(f'Superficie exportada: {len(pts)} vertices, {len(faces)} triangulos')
    apply = resampler(nodes, pts)

    ordered = names
    full = np.zeros((len(ordered), len(pts), 3), dtype=np.float32)
    for i, n in enumerate(ordered):
        if n != reference:
            row = ds[active.index(n)].astype(np.float32)[kept]
            full[i] = apply(row) * per_ma
        if (i + 1) % 10 == 0 or i + 1 == len(ordered):
            print(f'  {i + 1}/{len(ordered)} electrodos')
    handle.close()

    center = pts.mean(0)
    os.makedirs(args.out, exist_ok=True)
    positions = (pts - center).astype(np.float32)
    triangles = faces.astype(np.uint32)
    with open(os.path.join(args.out, 'geometry.bin'), 'wb') as fh:
        fh.write(positions.tobytes())
        fh.write(triangles.tobytes())
    with open(os.path.join(args.out, 'leadfield.bin'), 'wb') as fh:
        fh.write(full.astype(np.float16).tobytes())

    meta = {
        'format': FORMAT_VERSION,
        'name': args.name or os.path.splitext(os.path.basename(args.hdf5))[0],
        'units': 'V/m per mA',
        'vertices': int(len(pts)),
        'triangles': int(len(faces)),
        'reference': reference,
        'electrode': electrode,
        'electrodes': [{'name': n, 'position': (lookup[n] - center).round(2).tolist()} for n in ordered],
        'geometry': {'positions': [0, int(positions.nbytes)], 'triangles': [int(positions.nbytes), int(triangles.nbytes)]},
        'source': {
            'file': os.path.basename(args.hdf5),
            'cap': os.path.basename(cap) if cap else 'electrode_pos',
            'nodes': int(len(nodes)),
        },
    }
    with open(os.path.join(args.out, 'model.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=1)

    size = sum(os.path.getsize(os.path.join(args.out, f)) for f in ('geometry.bin', 'leadfield.bin', 'model.json'))
    peak = np.linalg.norm(full, axis=2).max()
    print(f'Exportado: {len(pts)} vértices, {len(faces)} triángulos, {len(ordered)} electrodos, {size / 1e6:.1f} MB')
    print(f'Campo máximo de un solo electrodo contra {reference}: {peak:.3f} V/m por mA')


if __name__ == '__main__':
    main()
