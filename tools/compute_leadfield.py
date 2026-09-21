import argparse
import glob
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description='Calcula el leadfield de tES para un modelo de cabeza de SimNIBS.')
    parser.add_argument('head', help='Ruta al .msh del modelo (por ejemplo m2m_MNI152/MNI152.msh)')
    parser.add_argument('-o', '--out', default='leadfield', help='Carpeta de salida')
    parser.add_argument('--cap', default=None, help='Archivo .csv del gorro EEG (por defecto 10-10)')
    parser.add_argument('--forma', choices=['ellipse', 'rect'], default='ellipse',
                        help='Forma del electrodo: ellipse (redondo, por defecto) o rect (rectangular, tipo esponja)')
    parser.add_argument('--radius', type=float, default=10.0,
                        help='Radio del electrodo redondo en mm (solo con --forma ellipse)')
    parser.add_argument('--ancho', type=float, default=50.0,
                        help='Ancho del electrodo rectangular en mm (solo con --forma rect)')
    parser.add_argument('--alto', type=float, default=None,
                        help='Alto del electrodo rectangular en mm (por defecto, igual que --ancho)')
    parser.add_argument('--thickness', type=float, default=4.0, help='Grosor del electrodo en mm')
    parser.add_argument('--rapido', action='store_true',
                        help='Inyecta la corriente en puntos en vez de mallar electrodos reales. '
                             'Evita el preproceso largo a costa de precision cerca del cuero cabelludo.')
    args = parser.parse_args()

    if not os.path.isfile(args.head):
        sys.exit(f'No existe el modelo: {args.head}')

    from simnibs import sim_struct, run_simnibs

    lf = sim_struct.TDCSLEADFIELD()
    lf.fnamehead = args.head
    lf.pathfem = args.out
    lf.field = 'E'
    lf.interpolation = 'middle gm'
    if args.cap:
        lf.eeg_cap = args.cap

    if args.rapido:
        lf.electrode = None
        electrode = {
            'shape': 'point',
            'label': 'point sources at the 10-10 positions',
        }
        print('Modo rapido: electrodos puntuales, sin mallado.')
    elif args.forma == 'rect':
        alto = args.alto if args.alto else args.ancho
        lf.electrode.shape = 'rect'
        lf.electrode.dimensions = [args.ancho, alto]
        lf.electrode.thickness = [args.thickness]
        electrode = {
            'shape': 'rect',
            'width_mm': round(args.ancho, 2),
            'height_mm': round(alto, 2),
            'thickness_mm': round(args.thickness, 2),
            'area_mm2': round(args.ancho * alto, 1),
            'label': f'rectangular, {args.ancho:.0f} x {alto:.0f} mm, {args.thickness:.0f} mm contact layer',
        }
        print(f'Electrodos rectangulares de {args.ancho:.0f} x {alto:.0f} mm '
              f'({args.ancho * alto:.0f} mm2 de contacto). Colocarlos en la malla tarda '
              'media hora larga antes de empezar a resolver.')
    else:
        lf.electrode.shape = 'ellipse'
        lf.electrode.dimensions = [args.radius * 2, args.radius * 2]
        lf.electrode.thickness = [args.thickness]
        electrode = {
            'shape': 'ellipse',
            'diameter_mm': round(args.radius * 2, 2),
            'thickness_mm': round(args.thickness, 2),
            'area_mm2': round(3.141592653589793 * args.radius ** 2, 1),
            'label': f'round, {args.radius * 2:.0f} mm diameter, {args.thickness:.0f} mm gel',
        }
        print(f'Electrodos de {args.radius * 2:.0f} mm de diametro. Colocarlos en la malla tarda '
              'media hora larga antes de empezar a resolver.')
    print()

    leftovers = glob.glob(os.path.join(args.out, 'simnibs_simulation*.mat'))
    leftovers += glob.glob(os.path.join(args.out, 'simnibs_simulation*.log'))
    leftovers += glob.glob(os.path.join(args.out, '*_leadfield_*.hdf5'))
    leftovers += glob.glob(os.path.join(args.out, '*_electrodes_*.msh'))
    if leftovers:
        print(f'Se encontraron {len(leftovers)} archivos de un intento anterior en {args.out}. Se eliminan:')
        for f in leftovers:
            print(f'  {os.path.basename(f)}')
            os.remove(f)
        print()

    run_simnibs(lf)

    produced = [f for f in os.listdir(args.out) if f.endswith('.hdf5')]
    if not produced:
        sys.exit('SimNIBS terminó pero no se encontró ningún .hdf5 en la carpeta de salida.')

    sidecar = os.path.join(args.out, 'electrode.json')
    with open(sidecar, 'w', encoding='utf-8') as fh:
        json.dump(electrode, fh, indent=1)
    print(f'Geometria de los electrodos anotada en {sidecar}: {electrode["label"]}')

    for f in produced:
        print(os.path.join(args.out, f))


if __name__ == '__main__':
    main()
