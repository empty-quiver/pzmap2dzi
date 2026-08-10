import os
import tempfile
import unittest

from scripts.build_oversized_sprite_rerender_manifest import build_level_tiles
from scripts.build_treeblend_rerender_manifest import (
    DEFAULT_PATTERN,
    affected_tiles_for_anchor,
)
import re
from scripts.seed_selective_rerender_output import seed_dependencies


class TreeBlendManifestTest(unittest.TestCase):
    def setUp(self):
        self.geometry = {
            'base_level': 3,
            'gxo': 0,
            'gyo': 0,
            'height': 8192,
            'tile_size': 1024,
            'width': 8192,
        }
        self.margin = (-6, 0, 6, 30)

    def anchor_is_rendered_by_tile(self, sx, sy, tx, ty):
        gx, gy = sx - sy, sx + sy
        tile_gx, tile_gy = 16 * tx, 32 * ty
        left, top, right, bottom = self.margin
        return (tile_gx + left <= gx <= tile_gx + 16 + right and
                tile_gy + top <= gy <= tile_gy + 32 + bottom)

    def test_fast_envelope_contains_every_square_in_five_by_five_footprint(self):
        sx, sy = 55, 23
        envelope = affected_tiles_for_anchor(
            sx, sy, self.geometry, self.margin, 5)
        brute_force = set()
        for dx in range(5):
            for dy in range(5):
                for tx in range(8):
                    for ty in range(8):
                        if self.anchor_is_rendered_by_tile(
                                sx + dx, sy + dy, tx, ty):
                            brute_force.add((tx, ty))
        self.assertTrue(brute_force)
        self.assertTrue(brute_force.issubset(envelope))

    def test_envelope_clips_to_published_geometry(self):
        self.assertEqual(
            {(0, 0)},
            affected_tiles_for_anchor(
                0, 0, self.geometry, self.margin, 5))

    def test_bottom_tiles_expand_to_all_ancestors(self):
        bottom = {(4, 5), (5, 5)}
        levels = build_level_tiles(bottom, 3)
        self.assertEqual(bottom, levels[3])
        self.assertEqual({(2, 2)}, levels[2])
        self.assertEqual({(1, 1)}, levels[1])
        self.assertEqual({(0, 0)}, levels[0])

    def test_full_pattern_includes_worldgen_and_erosion_tree_inputs(self):
        pattern = re.compile(DEFAULT_PATTERN)
        for sprite in (
                'vegetation_trees_01_0',
                'vegetation_trees_01_32',
                'jumbo_tree_01_0',
                'jumbo_tree_01_7',
                'e_redmapleJUMBOXXL_1_0'):
            self.assertRegex(sprite, pattern)
        for sprite in ('vegetation_foliage_01_0', 'jumbo_bush_01_0'):
            self.assertNotRegex(sprite, pattern)


class SelectiveSeedTest(unittest.TestCase):
    def test_multiple_sources_use_highest_precedence_dependency(self):
        with tempfile.TemporaryDirectory() as tmp:
            high = os.path.join(tmp, 'high')
            low = os.path.join(tmp, 'low')
            target = os.path.join(tmp, 'target')
            relative = os.path.join('layer0_files', '1', '2_2.jpg')
            for root, data in ((high, b'high'), (low, b'low')):
                path = os.path.join(root, relative)
                os.makedirs(os.path.dirname(path))
                with open(path, 'wb') as stream:
                    stream.write(data)

            stats = seed_dependencies(
                [high, low], target, {0: {(1, 1)}, 1: set()})

            with open(os.path.join(target, relative), 'rb') as stream:
                self.assertEqual(b'high', stream.read())
            self.assertEqual(1, stats['copied_dependencies'])
            self.assertEqual(3, stats['absent_empty_dependencies'])


if __name__ == '__main__':
    unittest.main()
