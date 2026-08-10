import json
import os
import sys
import tempfile
import types
import unittest

from PIL import Image, ImageDraw


# geometry.py only needs pyclipper when its geometry helpers are invoked. The
# margin tests do not use them, so keep this test runnable in a minimal checkout.
sys.modules.setdefault('pyclipper', types.ModuleType('pyclipper'))

from pzmap2dzi.pzdzi import DZI, IsoDZI
from pzmap2dzi.render_impl.base import BaseRender
from scripts.build_oversized_sprite_rerender_manifest import build_level_tiles


class CompatMarginTest(unittest.TestCase):
    def make_dzi(self, use_jumbo=True):
        dzi = IsoDZI.__new__(IsoDZI)
        dzi.use_jumbo_tree = use_jumbo
        dzi.max_render_texture_width = IsoDZI.MAX_RENDER_TEXTURE_WIDTH
        dzi.max_render_texture_height = IsoDZI.MAX_RENDER_TEXTURE_HEIGHT
        dzi.maxlayer = 30
        dzi.minlayer = -17
        return dzi

    def test_output_geometry_keeps_legacy_jumbo_envelope(self):
        dzi = self.make_dzi()
        self.assertEqual((-3, -195, 3, 103), dzi.get_output_margin(True))

    def test_build_42_xxl_envelope_expands_render_and_cell_margins(self):
        dzi = self.make_dzi()
        self.assertEqual((-7, -211, 7, 103), dzi.get_cell_margin())
        self.assertEqual((-6, 0, 6, 30), dzi.get_default_render_margin())

    def test_non_jumbo_render_retains_normal_margin(self):
        dzi = self.make_dzi(False)
        self.assertEqual((-1, -187, 1, 103), dzi.get_cell_margin())
        self.assertEqual((0, 0, 0, 6), dzi.get_default_render_margin())

    def test_xxl_anchor_outside_legacy_margin_renders_into_neighbour_tile(self):
        class Getter(object):
            def __init__(self):
                self.im = None

            def get(self):
                if self.im is None:
                    self.im = Image.new('RGBA', (1024, 1024))
                return self.im

        class OversizedSpriteRender(object):
            def square(self, im_getter, dzi, ox, oy, sx, sy, layer):
                # gx=0, gy=48 maps to sx=24, sy=24. Its 1024-pixel-high
                # sprite reaches upward into tile (0, 0), but its anchor is
                # beyond the published bottom edge plus margin (gy=38).
                if (sx, sy, layer) == (24, 24, 0):
                    draw = ImageDraw.Draw(im_getter.get())
                    draw.rectangle((0, oy + 32 - 1024, 96, oy + 31),
                                   fill=(0, 255, 0, 255))

        dzi = self.make_dzi()
        dzi.sqr_height = IsoDZI.SQUARE_HEIGHT
        dzi.sqr_width = IsoDZI.SQUARE_WIDTH
        dzi.tile_size = 1024
        dzi.grid_per_tilex = 16
        dzi.grid_per_tiley = 32
        dzi.gxo = 0
        dzi.gyo = 0
        dzi.render = OversizedSpriteRender()
        dzi.render_below = lambda *args: None

        old = Getter()
        dzi.render_margin = (0, 0, 0, 6)
        dzi.render_tile(old, 0, 0, 0, [])
        self.assertIsNone(old.im)

        new = Getter()
        dzi.render_margin = dzi.get_default_render_margin()
        dzi.render_tile(new, 0, 0, 0, [])
        self.assertIsNotNone(new.im)
        self.assertIsNotNone(new.im.getbbox())


class RerenderManifestTest(unittest.TestCase):
    def test_base_tiles_expand_to_every_pyramid_ancestor(self):
        levels = build_level_tiles({(4, 5), (5, 5)}, 3)
        self.assertEqual({(4, 5), (5, 5)}, levels[3])
        self.assertEqual({(2, 2)}, levels[2])
        self.assertEqual({(1, 1)}, levels[1])
        self.assertEqual({(0, 0)}, levels[0])

    def test_manifest_tiles_are_removed_from_done_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            level = os.path.join(tmp, 'layer0_files', '2')
            os.makedirs(level)
            for name in ('1_1.jpg', '2_2.jpg', '3_3.jpg'):
                open(os.path.join(level, name), 'w').close()
            manifest_path = os.path.join(tmp, 'rerender.json')
            with open(manifest_path, 'w') as f:
                json.dump({'levels': {'2': [[2, 2]]}}, f)

            dzi = DZI.__new__(DZI)
            dzi.path = tmp
            dzi.ext0 = 'jpg'
            dzi.done_pattern = __import__('re').compile(
                r'(\d+)_(\d+)\.(?:empty|jpg)$')
            dzi.levels = 3
            dzi.rerender_tiles = dzi.load_rerender_tiles(manifest_path)

            self.assertEqual({(1, 1), (3, 3)}, dzi.get_done_tasks(2))

    def test_manifest_rejects_wrong_published_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = os.path.join(tmp, 'rerender.json')
            with open(manifest_path, 'w') as f:
                json.dump({
                    'geometry': {
                        'base_level': 2,
                        'height': 1024,
                        'tile_size': 1024,
                        'width': 999,
                    },
                    'levels': {'2': [[0, 0]]},
                }, f)

            dzi = DZI.__new__(DZI)
            dzi.h = 1024
            dzi.levels = 3
            dzi.tile_size = 1024
            dzi.w = 1024
            with self.assertRaisesRegex(ValueError, 'width'):
                dzi.load_rerender_tiles(manifest_path)

    def test_manifest_only_bottom_schedule_is_exact(self):
        dzi = DZI.__new__(DZI)
        dzi.levels = 3
        dzi.rerender_manifest_only = True
        dzi.rerender_tiles = {2: {(4, 5), (5, 5)}}
        tasks = dzi.get_bottom_task_depend(set(), set())
        self.assertEqual({(4, 5): 0, (5, 5): 0}, tasks)


class BaseRenderOptionsTest(unittest.TestCase):
    def test_nested_jumbo_tree_size_reaches_dzi_scheduler(self):
        renderer = BaseRender.__new__(BaseRender)
        options = {'plants_conf': {'jumbo_tree_size': 4}}
        self.assertIs(options, renderer.update_options(options))
        self.assertEqual(4, options['jumbo_tree_size'])

    def test_explicit_top_level_size_wins(self):
        renderer = BaseRender.__new__(BaseRender)
        options = {
            'jumbo_tree_size': 5,
            'plants_conf': {'jumbo_tree_size': 4},
        }
        renderer.update_options(options)
        self.assertEqual(5, options['jumbo_tree_size'])


if __name__ == '__main__':
    unittest.main()
