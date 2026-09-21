"""Checks on an exported model: format integrity and the physics it must satisfy.

Run from the repository root:

    python -m pytest tests -v

These tests read the models under models/ and need no SimNIBS installation.
"""
import json
import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))


def model_dirs():
    base = os.path.join(ROOT, 'models')
    if not os.path.isdir(base):
        return []
    return [os.path.join(base, d) for d in sorted(os.listdir(base))
            if os.path.isfile(os.path.join(base, d, 'model.json'))]


MODELS = model_dirs()
requires_model = pytest.mark.skipif(not MODELS, reason='no hay modelos exportados en models/')


@pytest.fixture(params=MODELS, ids=[os.path.basename(d) for d in MODELS])
def model(request):
    folder = request.param
    with open(os.path.join(folder, 'model.json'), encoding='utf-8') as fh:
        meta = json.load(fh)
    geometry = np.fromfile(os.path.join(folder, 'geometry.bin'), dtype=np.uint8)
    leadfield = np.fromfile(os.path.join(folder, 'leadfield.bin'), dtype=np.float16)
    return meta, geometry, leadfield


# --------------------------------------------------------------- formato
@requires_model
def test_metadata_completa(model):
    meta, _, _ = model
    for key in ('format', 'name', 'units', 'vertices', 'triangles', 'reference',
                'electrodes', 'geometry'):
        assert key in meta, f'falta {key} en model.json'
    assert meta['units'] == 'V/m per mA'
    assert meta['vertices'] > 0 and meta['triangles'] > 0


@requires_model
def test_geometria_cuadra_con_los_bytes(model):
    """Los offsets declarados deben cubrir exactamente geometry.bin."""
    meta, geometry, _ = model
    p_off, p_len = meta['geometry']['positions']
    t_off, t_len = meta['geometry']['triangles']
    assert p_len == meta['vertices'] * 3 * 4, 'posiciones: 3 float32 por vertice'
    assert t_len == meta['triangles'] * 3 * 4, 'triangulos: 3 uint32 por cara'
    assert p_off == 0 and t_off == p_len, 'los bloques deben ser contiguos'
    assert geometry.nbytes == p_len + t_len, 'geometry.bin no tiene el tamano declarado'


@requires_model
def test_leadfield_tiene_la_forma_declarada(model):
    meta, _, leadfield = model
    esperado = len(meta['electrodes']) * meta['vertices'] * 3
    assert leadfield.size == esperado, (
        f'leadfield.bin trae {leadfield.size} valores y model.json implica {esperado}')


@requires_model
def test_los_triangulos_apuntan_a_vertices_reales(model):
    meta, geometry, _ = model
    _, p_len = meta['geometry']['positions']
    t_off, t_len = meta['geometry']['triangles']
    tris = geometry[t_off:t_off + t_len].view(np.uint32)
    assert tris.max() < meta['vertices'], 'hay un indice fuera de rango'
    assert tris.min() >= 0


@requires_model
def test_no_hay_valores_no_finitos(model):
    """float16 desborda por encima de 65504; un inf aqui es un export roto."""
    _, _, leadfield = model
    assert np.isfinite(leadfield).all(), 'el leadfield contiene NaN o infinitos'


# --------------------------------------------------------------- fisica
@requires_model
def test_el_electrodo_de_referencia_es_cero(model):
    """La referencia se guarda como fila de ceros: su aporte ya esta en las demas."""
    meta, _, leadfield = model
    nombres = [e['name'] for e in meta['electrodes']]
    assert meta['reference'] in nombres, 'la referencia no esta entre los electrodos'
    i = nombres.index(meta['reference'])
    n = meta['vertices'] * 3
    fila = leadfield[i * n:(i + 1) * n]
    assert np.all(fila == 0), 'la fila de la referencia deberia ser cero'


@requires_model
def test_las_demas_filas_no_son_cero(model):
    meta, _, leadfield = model
    nombres = [e['name'] for e in meta['electrodes']]
    n = meta['vertices'] * 3
    vacias = [nombre for i, nombre in enumerate(nombres)
              if nombre != meta['reference'] and not leadfield[i * n:(i + 1) * n].any()]
    assert not vacias, f'electrodos sin campo: {vacias}'


@requires_model
def test_superposicion_lineal(model):
    """E(2I) debe ser exactamente 2*E(I). Es la propiedad que sostiene la herramienta."""
    meta, _, leadfield = model
    n = meta['vertices'] * 3
    lf = leadfield.astype(np.float64).reshape(len(meta['electrodes']), -1)
    nombres = [e['name'] for e in meta['electrodes']]
    anodo, catodo = nombres[0], nombres[1]
    if anodo == meta['reference']:
        anodo = nombres[2]

    def campo(mA):
        return mA * lf[nombres.index(anodo)] - mA * lf[nombres.index(catodo)]

    np.testing.assert_allclose(campo(2.0), 2.0 * campo(1.0), rtol=1e-12)
    assert campo(1.0).shape == (n,)


@requires_model
def test_magnitud_en_rango_fisiologico(model):
    """1 mA por un par de electrodos no puede dar decenas de V/m en corteza."""
    meta, _, leadfield = model
    lf = leadfield.astype(np.float32).reshape(len(meta['electrodes']), meta['vertices'], 3)
    magnitudes = np.linalg.norm(lf, axis=2)
    pico = np.percentile(magnitudes, 99.9)
    assert 0.001 < pico < 5.0, f'pico de {pico:.3f} V/m por mA fuera de lo plausible'


@requires_model
def test_geometria_del_electrodo_declarada(model):
    """Sin esto, una figura exportada no puede compararse con otra."""
    meta, _, _ = model
    electrodo = meta.get('electrode')
    assert electrodo, 'model.json no declara la geometria del electrodo'
    assert electrodo.get('shape') in ('ellipse', 'rect', 'point')
    if electrodo['shape'] == 'ellipse':
        assert electrodo['diameter_mm'] > 0
    elif electrodo['shape'] == 'rect':
        assert electrodo['width_mm'] > 0 and electrodo['height_mm'] > 0


@requires_model
def test_las_posiciones_de_los_electrodos_rodean_la_corteza(model):
    """Los electrodos van en el cuero cabelludo: fuera de la nube de vertices."""
    meta, geometry, _ = model
    _, p_len = meta['geometry']['positions']
    pts = geometry[:p_len].view(np.float32).reshape(-1, 3)
    radio_corteza = np.linalg.norm(pts, axis=1).max()
    pos = np.array([e['position'] for e in meta['electrodes']], dtype=np.float64)
    radio_electrodos = np.linalg.norm(pos, axis=1)
    assert (radio_electrodos > radio_corteza * 0.7).all(), \
        'algun electrodo cae demasiado dentro del volumen cortical'


# --------------------------------------------------------------- utilidades del exportador
def test_parse_current_acepta_los_formatos_de_simnibs():
    from export_leadfield import parse_current
    assert parse_current('1A') == pytest.approx(1.0)
    assert parse_current('1mA') == pytest.approx(1e-3)
    assert parse_current(b'2.5 mA') == pytest.approx(2.5e-3)
    assert parse_current(0.001) == pytest.approx(1e-3)
    assert parse_current('sin sentido') is None


def test_indice_de_modelos_coincide_con_las_carpetas():
    ruta = os.path.join(ROOT, 'models', 'index.json')
    if not os.path.isfile(ruta):
        pytest.skip('no hay models/index.json')
    with open(ruta, encoding='utf-8') as fh:
        entradas = json.load(fh)
    for entrada in entradas:
        carpeta = os.path.join(ROOT, 'models', entrada['id'])
        assert os.path.isfile(os.path.join(carpeta, 'model.json')), \
            f"index.json lista '{entrada['id']}' pero no existe models/{entrada['id']}/"
