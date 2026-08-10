#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pzmap2dzi import cell, lotheader


GRID_WIDTH = 64
GRID_HEIGHT = 32


def read_dzi_geometry(dzi_path):
    with open(os.path.join(dzi_path, 'map_info.json'), 'r') as f:
        info = json.load(f)
    descriptor = ET.parse(os.path.join(dzi_path, 'layer0.dzi')).getroot()
    tile_size = int(descriptor.attrib['TileSize'])
    level_path = os.path.join(dzi_path, 'layer0_files')
    base_level = max(int(name) for name in os.listdir(level_path)
                     if name.isdigit())
    gxo = -int(info['x0']) // GRID_WIDTH
    gyo = (-int(info['y0']) // GRID_HEIGHT) - 1
    return {
        'base_level': base_level,
        'gxo': gxo,
        'gyo': gyo,
        'height': int(info['h']),
        'tile_size': tile_size,
        'width': int(info['w']),
    }


def texture_bounds(name, texture_paths):
    for path in texture_paths:
        image_path = os.path.join(path, name + '.png')
        if os.path.isfile(image_path):
            with Image.open(image_path) as im:
                return (
                    int(im.info.get('ox', 0)),
                    int(im.info.get('oy', 0)),
                    im.width,
                    im.height,
                )
    raise FileNotFoundError('Missing materialized texture: {}'.format(name))


def find_placements(map_path, name_pattern):
    version = lotheader.get_version_info(map_path)
    placements = []
    relevant_cells = 0
    texture_names = set()
    for cx, cy in sorted(version['cells']):
        header = lotheader.load_lotheader(map_path, cx, cy)
        names = set(name for name in header['tiles']
                    if name_pattern.search(name))
        if not names:
            continue
        relevant_cells += 1
        texture_names.update(names)
        current = cell.load_cell(map_path, cx, cy)
        for block_index, block in enumerate(current.blocks):
            layer = block[0] if block else None
            if not layer:
                continue
            block_x, block_y = divmod(
                block_index, current.block_per_cell)
            for x, row in enumerate(layer):
                if not row:
                    continue
                for y, tiles in enumerate(row):
                    if not tiles:
                        continue
                    for tile_id in tiles:
                        name = current.header['tiles'][tile_id]
                        if name not in names:
                            continue
                        sx = (cx * current.cell_size +
                              block_x * current.block_size + x)
                        sy = (cy * current.cell_size +
                              block_y * current.block_size + y)
                        placements.append((sx, sy, name))
    return placements, texture_names, relevant_cells


def anchor_in_margin(gx, gy, tx, ty, geometry, margin):
    grid_per_tile_x = geometry['tile_size'] // GRID_WIDTH
    grid_per_tile_y = geometry['tile_size'] // GRID_HEIGHT
    tile_gx = geometry['gxo'] + grid_per_tile_x * tx
    tile_gy = geometry['gyo'] + grid_per_tile_y * ty
    left, top, right, bottom = margin
    return (tile_gx + left <= gx <= tile_gx + grid_per_tile_x + right and
            tile_gy + top <= gy <= tile_gy + grid_per_tile_y + bottom)


def build_level_tiles(base_tiles, base_level):
    levels = {base_level: set(base_tiles)}
    current = set(base_tiles)
    for level in reversed(range(base_level)):
        current = set((x >> 1, y >> 1) for x, y in current)
        levels[level] = current
    return levels


def build_manifest(map_path, texture_paths, dzi_path, pattern,
                   old_margin, new_margin):
    geometry = read_dzi_geometry(dzi_path)
    placements, texture_names, relevant_cells = find_placements(
        map_path, re.compile(pattern))
    bounds = dict((name, texture_bounds(name, texture_paths))
                  for name in texture_names)
    max_tx = (geometry['width'] - 1) // geometry['tile_size']
    max_ty = (geometry['height'] - 1) // geometry['tile_size']
    intersected = set()
    missing = set()
    uncovered = []

    for sx, sy, name in placements:
        ox, oy, width, height = bounds[name]
        gx = sx - sy
        gy = sx + sy
        anchor_x = (gx - geometry['gxo']) * GRID_WIDTH
        anchor_y = (gy - geometry['gyo']) * GRID_HEIGHT + GRID_HEIGHT
        x0 = anchor_x + ox
        y0 = anchor_y + oy
        x1 = x0 + width - 1
        y1 = y0 + height - 1
        tx0 = max(0, x0 // geometry['tile_size'])
        ty0 = max(0, y0 // geometry['tile_size'])
        tx1 = min(max_tx, x1 // geometry['tile_size'])
        ty1 = min(max_ty, y1 // geometry['tile_size'])
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                intersected.add((tx, ty))
                if anchor_in_margin(gx, gy, tx, ty, geometry, old_margin):
                    continue
                missing.add((tx, ty))
                if not anchor_in_margin(
                        gx, gy, tx, ty, geometry, new_margin):
                    uncovered.append((sx, sy, name, tx, ty))

    if uncovered:
        raise ValueError(
            'New render margin does not cover {} sprite/tile intersections; '
            'first: {}'.format(len(uncovered), uncovered[0]))

    levels = build_level_tiles(missing, geometry['base_level'])
    manifest = {
        'version': 1,
        'reason': 'Build 42.20 XL/XXL tree clipping compatibility repair',
        'geometry': geometry,
        'old_render_margin': list(old_margin),
        'new_render_margin': list(new_margin),
        'stats': {
            'base_tiles_intersected': len(intersected),
            'base_tiles_to_rerender': len(missing),
            'placements': len(placements),
            'relevant_cells': relevant_cells,
            'texture_names': len(texture_names),
            'tiles_all_levels': sum(len(tiles) for tiles in levels.values()),
        },
        'levels': dict((str(level), sorted([list(tile) for tile in tiles]))
                       for level, tiles in sorted(levels.items())),
    }
    return manifest


def main():
    parser = argparse.ArgumentParser(
        description='Build a selective DZI rerender manifest for oversized sprites')
    parser.add_argument('--map-path', required=True)
    parser.add_argument('--texture-path', action='append', required=True)
    parser.add_argument('--dzi-path', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--pattern', default=r'JUMBO(?:XL|XXL)')
    parser.add_argument('--old-margin', nargs=4, type=int,
                        default=(0, 0, 0, 6),
                        help='render margin used by the published renderer')
    parser.add_argument('--new-margin', nargs=4, type=int,
                        default=(-6, 0, 6, 30))
    args = parser.parse_args()

    manifest = build_manifest(
        args.map_path,
        args.texture_path,
        args.dzi_path,
        args.pattern,
        tuple(args.old_margin),
        tuple(args.new_margin),
    )
    output_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(output_dir, exist_ok=True)
    temp_path = args.output + '.tmp'
    with open(temp_path, 'w') as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(temp_path, args.output)
    print(json.dumps(manifest['stats'], sort_keys=True))


if __name__ == '__main__':
    main()
