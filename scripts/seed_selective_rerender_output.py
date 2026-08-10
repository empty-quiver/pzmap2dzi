#!/usr/bin/env python3

import argparse
import json
import os
import shutil


def load_levels(path):
    with open(path, 'r') as f:
        manifest = json.load(f)
    return dict((int(level), set((int(x), int(y)) for x, y in tiles))
                for level, tiles in manifest['levels'].items())


def find_source_file(sources, relative_path):
    for source in sources:
        candidate = os.path.join(source, relative_path)
        if os.path.isfile(candidate):
            return candidate
    return None


def seed_dependencies(sources, target, levels):
    copied = 0
    copied_bytes = 0
    absent = 0
    for level, parents in sorted(levels.items()):
        child_level = level + 1
        if child_level not in levels:
            continue
        forced_children = levels[child_level]
        output_dir = os.path.join(
            target, 'layer0_files', str(child_level))
        os.makedirs(output_dir, exist_ok=True)
        for parent_x, parent_y in parents:
            for offset_x in (0, 1):
                for offset_y in (0, 1):
                    child = (
                        2 * parent_x + offset_x,
                        2 * parent_y + offset_y,
                    )
                    if child in forced_children:
                        continue
                    basename = '{}_{}'.format(*child)
                    found = False
                    for extension in ('jpg', 'empty'):
                        relative_path = os.path.join(
                            'layer0_files', str(child_level),
                            '{}.{}'.format(basename, extension))
                        source_path = find_source_file(
                            sources, relative_path)
                        if source_path is None:
                            continue
                        target_path = os.path.join(
                            output_dir,
                            '{}.{}'.format(basename, extension))
                        if not os.path.exists(target_path):
                            shutil.copy2(source_path, target_path)
                            copied += 1
                            copied_bytes += os.path.getsize(source_path)
                        found = True
                        break
                    if not found:
                        absent += 1
    return {
        'absent_empty_dependencies': absent,
        'copied_dependencies': copied,
        'copied_dependency_bytes': copied_bytes,
    }


def main():
    parser = argparse.ArgumentParser(
        description='Seed unchanged pyramid dependencies for an isolated rerender')
    parser.add_argument(
        '--source', action='append', required=True,
        help='Effective source root, highest-precedence first; repeatable')
    parser.add_argument('--target', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()

    sources = [os.path.abspath(source) for source in args.source]
    target = os.path.abspath(args.target)
    for source in sources:
        if source == target or target.startswith(source + os.sep):
            raise ValueError('Target must be isolated from the published DZI')

    os.makedirs(target, exist_ok=True)
    for name in ('layer0.dzi', 'map_info.json'):
        source_path = find_source_file(sources, name)
        if source_path is None:
            raise FileNotFoundError(
                'Missing {} in effective source roots'.format(name))
        shutil.copy2(source_path, os.path.join(target, name))
    levels = load_levels(args.manifest)
    stats = seed_dependencies(sources, target, levels)
    stats['forced_tiles'] = sum(len(tiles) for tiles in levels.values())
    print(json.dumps(stats, sort_keys=True))


if __name__ == '__main__':
    main()
