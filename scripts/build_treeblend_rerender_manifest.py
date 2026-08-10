#!/usr/bin/env python3

"""Build a conservative selective-render manifest for WorldGen tree blending.

The footprint renderer can replace every IsoTree source in a supported BIOME and
can occupy up to a 5x5 source-square footprint.  This scanner finds those
anchors in parallel, projects the complete footprint through the renderer's
neighbour margin, and expands the affected bottom tiles to every DZI ancestor.
"""

import argparse
import json
import multiprocessing
import os
import re
import sys
import time

from PIL import Image


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pzmap2dzi import cell, lotheader, worldgen_trees
from scripts.build_oversized_sprite_rerender_manifest import (
    build_level_tiles,
    read_dzi_geometry,
)


GRID_WIDTH = 64
GRID_HEIGHT = 32
DEFAULT_PATTERN = (
    # Include both WorldGen TREE anchors and the legacy placeholders replaced
    # by NatureTrees/Erosion on first load.  Omitting jumbo_tree_01 produced a
    # visually mixed selective build: WorldGen areas were refreshed while
    # authored Erosion-marker diamonds retained the old uniform rendering.
    r'^(?:vegetation_trees_01_\d+|jumbo_tree_01_\d+|'
    r'e_(?:americanholly|canadianhemlock|virginiapine|riverbirch|'
    r'cockspurhawthorn|dogwood|carolinasilverbell|yellowwood|'
    r'easternredbud|redmaple|americanlinden)'
    r'(?:_\d+_\d+|JUMBO(?:XL|XXL)?_\d+_\d+))$')

_worker_options = None


def ceil_div(value, divisor):
    return -((-value) // divisor)


def affected_tiles_for_anchor(sx, sy, geometry, margin, footprint_size=5):
    """Return a safe bottom-level tile envelope for one source tree.

    WorldGen footprints grow in positive source x/y from their selected anchor.
    A square footprint of side ``n`` projects to ``gx +/- (n - 1)`` and
    ``gy .. gy + 2 * (n - 1)``.  Intersect that envelope with the square-anchor
    range rendered by each DZI tile.  The rectangle very slightly over-covers
    the projected diamond, which is intentional for a repair manifest.
    """
    tile_size = geometry['tile_size']
    grid_per_tile_x = tile_size // GRID_WIDTH
    grid_per_tile_y = tile_size // GRID_HEIGHT
    max_tx = (geometry['width'] - 1) // tile_size
    max_ty = (geometry['height'] - 1) // tile_size
    left, top, right, bottom = margin

    radius = footprint_size - 1
    gx = sx - sy
    gy = sx + sy
    gx_min, gx_max = gx - radius, gx + radius
    gy_min, gy_max = gy, gy + 2 * radius

    tx0 = max(0, ceil_div(
        gx_min - grid_per_tile_x - right - geometry['gxo'],
        grid_per_tile_x))
    tx1 = min(max_tx, (
        gx_max - left - geometry['gxo']) // grid_per_tile_x)
    ty0 = max(0, ceil_div(
        gy_min - grid_per_tile_y - bottom - geometry['gyo'],
        grid_per_tile_y))
    ty1 = min(max_ty, (
        gy_max - top - geometry['gyo']) // grid_per_tile_y)

    if tx0 > tx1 or ty0 > ty1:
        return set()
    return set((tx, ty)
               for tx in range(tx0, tx1 + 1)
               for ty in range(ty0, ty1 + 1))


def _init_worker(options):
    global _worker_options
    _worker_options = options


def _scan_cell(coord):
    options = _worker_options
    map_path = options['map_path']
    cx, cy = coord
    header = lotheader.load_lotheader(map_path, cx, cy)
    tree_ids = set(
        index for index, name in enumerate(header['tiles'])
        if options['pattern'].match(name))
    if not tree_ids:
        return 0, 0, ()

    biome_path = os.path.join(
        map_path, 'maps', 'biomemap_{}_{}.png'.format(cx, cy))
    if not os.path.isfile(biome_path):
        return 0, 0, ()
    with Image.open(biome_path) as image:
        red = image.convert('RGB').getchannel('R')
        biome_width, biome_height = red.size
        biome_pixels = red.tobytes()

    current = cell.load_cell(map_path, cx, cy)
    anchors = 0
    affected = set()
    for block_index, block in enumerate(current.blocks):
        layer = block[0] if block else None
        if not layer:
            continue
        block_x, block_y = divmod(
            block_index, current.block_per_cell)
        for x, row in enumerate(layer):
            if not row:
                continue
            subx = block_x * current.block_size + x
            for y, tiles in enumerate(row):
                if not tiles or not any(tile in tree_ids for tile in tiles):
                    continue
                suby = block_y * current.block_size + y
                if subx >= biome_width or suby >= biome_height:
                    continue
                biome = biome_pixels[subx + suby * biome_width]
                if biome not in options['tree_biomes']:
                    continue
                anchors += 1
                sx = cx * current.cell_size + subx
                sy = cy * current.cell_size + suby
                affected.update(affected_tiles_for_anchor(
                    sx, sy, options['geometry'], options['margin'],
                    options['footprint_size']))
    return (1 if anchors else 0), anchors, tuple(affected)


def build_manifest(map_path, dzi_path, workers, pattern=DEFAULT_PATTERN,
                   margin=(-6, 0, 6, 30), footprint_size=5,
                   progress=None):
    geometry = read_dzi_geometry(dzi_path)
    cells = sorted(lotheader.get_version_info(map_path)['cells'])
    options = {
        'footprint_size': footprint_size,
        'geometry': geometry,
        'map_path': map_path,
        'margin': tuple(margin),
        'pattern': re.compile(pattern),
        'tree_biomes': frozenset(worldgen_trees.biome_tree_features()),
    }
    relevant_cells = 0
    anchors = 0
    bottom_tiles = set()
    started = time.time()
    worker_count = max(1, min(int(workers), len(cells)))

    if worker_count == 1:
        _init_worker(options)
        results = map(_scan_cell, cells)
        pool = None
    else:
        context = multiprocessing.get_context('fork')
        pool = context.Pool(
            worker_count, initializer=_init_worker,
            initargs=(options,), maxtasksperchild=32)
        results = pool.imap_unordered(_scan_cell, cells, chunksize=1)

    try:
        for done, (has_tree, count, tiles) in enumerate(results, 1):
            relevant_cells += has_tree
            anchors += count
            bottom_tiles.update(tiles)
            if progress and (done % 100 == 0 or done == len(cells)):
                progress({
                    'anchors': anchors,
                    'bottom_tiles': len(bottom_tiles),
                    'cells_done': done,
                    'cells_total': len(cells),
                    'elapsed_seconds': round(time.time() - started, 1),
                    'relevant_cells': relevant_cells,
                })
    finally:
        if pool is not None:
            pool.close()
            pool.join()

    levels = build_level_tiles(bottom_tiles, geometry['base_level'])
    stats = {
        'source_tree_anchors': anchors,
        'map_cells': len(cells),
        'relevant_cells': relevant_cells,
        'tiles_all_levels': sum(len(tiles) for tiles in levels.values()),
        'tiles_bottom_level': len(bottom_tiles),
        'worker_count': worker_count,
    }
    return {
        'version': 1,
        'reason': ('Build 42 WorldGen tree palette, footprints, decorations, '
                   'and Erosion legacy-tree replacement'),
        'geometry': geometry,
        'source_tree_pattern': pattern,
        'render_margin': list(margin),
        'maximum_footprint': [footprint_size, footprint_size],
        'tree_biomes': sorted(options['tree_biomes']),
        'stats': stats,
        'levels': dict(
            (str(level), sorted([list(tile) for tile in tiles]))
            for level, tiles in sorted(levels.items())),
    }


def main():
    parser = argparse.ArgumentParser(
        description='Build a parallel full-map WorldGen tree rerender manifest')
    parser.add_argument('--map-path', required=True)
    parser.add_argument('--dzi-path', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--workers', type=int,
                        default=multiprocessing.cpu_count())
    parser.add_argument('--pattern', default=DEFAULT_PATTERN)
    parser.add_argument('--margin', nargs=4, type=int,
                        default=(-6, 0, 6, 30),
                        metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'))
    parser.add_argument('--footprint-size', type=int, default=5)
    args = parser.parse_args()

    def print_progress(update):
        print(json.dumps(update, sort_keys=True), flush=True)

    manifest = build_manifest(
        os.path.abspath(args.map_path),
        os.path.abspath(args.dzi_path),
        args.workers,
        pattern=args.pattern,
        margin=tuple(args.margin),
        footprint_size=args.footprint_size,
        progress=print_progress)
    output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = output + '.tmp'
    with open(temporary, 'w') as stream:
        json.dump(manifest, stream, indent=2, sort_keys=True)
        stream.write('\n')
    os.replace(temporary, output)
    print(json.dumps(manifest['stats'], sort_keys=True))


if __name__ == '__main__':
    main()
