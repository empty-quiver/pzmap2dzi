import os
import struct
import tempfile
import unittest
from unittest import mock

from PIL import Image

from pzmap2dzi import erosion_trees, plants, worldgen_trees


class JavaCompatibilityTest(unittest.TestCase):
    def test_java_string_hashcode_matches_build_42_seed_input(self):
        value = 'fanmap42-b42.20-steam24574865-treeblend1'
        self.assertEqual(-700840785, worldgen_trees.java_string_hashcode(value))

    def test_java_string_hashcode_uses_utf16_surrogate_pairs(self):
        # Java hashes the two UTF-16 surrogates, not Python's one code point.
        self.assertEqual(56896350,
                         worldgen_trees.java_string_hashcode('A\U0001F600B'))

    def test_java_random_vectors(self):
        random = worldgen_trees.JavaRandom(0)
        self.assertEqual(-4962768465676381896, random.next_long())
        random = worldgen_trees.JavaRandom(0)
        self.assertAlmostEqual(0.73096776, random.next_float(), places=7)

    def test_worldgen_coordinate_rng_vector(self):
        seed = worldgen_trees.java_string_hashcode(
            'fanmap42-b42.20-steam24574865-treeblend1')
        random = worldgen_trees.JavaRandom(seed)
        self.assertEqual(-8219603612936173076, random.next_long())
        self.assertEqual(-4741393835705766009, random.next_long())

    def test_java_next_int_consumes_bits_even_for_one_group(self):
        random = worldgen_trees.JavaRandom(0)
        self.assertEqual(0, random.next_int(1))
        self.assertEqual(-3109364765729502342, random.next_long())


class ErosionTreeCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.selector = erosion_trees.ErosionTreeSelector({
            'erosion_tree_compat': True,
            'worldgen_seed': '',
        })

    def test_vectors_match_shipped_noise2d_randlocation_and_naturetrees(self):
        # Independently captured from the Build 42.20 classes using Noise2D,
        # RandLocation, WorldGenParams, and NatureTrees' shipped tables.
        vectors = (
            (3319, 7428, 2, 1, 2, 4, 0.305457324),
            (2618, 9398, 4, 6, 3, 5, 0.593115509),
            (2669, 9443, 7, 1, 3, 5, 0.577254355),
            (3200, 7296, 8, 7, 3, 5, 0.606064677),
            (6835, 11672, 1, 3, 2, 4, 0.378341913),
        )
        for x, y, soil, species, normal_stage, jumbo_stage, noise in vectors:
            normal = self.selector.select(x, y, jumbo=False)
            jumbo = self.selector.select(x, y, jumbo=True)
            self.assertEqual(soil, normal.soil)
            self.assertEqual(species, normal.species)
            self.assertEqual(normal_stage, normal.stage)
            self.assertEqual(jumbo_stage, jumbo.stage)
            self.assertAlmostEqual(noise, normal.noise_main, places=8)

    def test_legacy_jumbo_uses_species_and_variant_selected_by_game(self):
        low_noise = self.selector.select(3319, 7428, jumbo=True)
        high_noise = self.selector.select(2618, 9398, jumbo=True)
        self.assertEqual('e_canadianhemlockJUMBO_1_0', low_noise.sprite)
        self.assertEqual('e_carolinasilverbellJUMBO_1_1', high_noise.sprite)

    def test_legacy_normal_marker_uses_runtime_growth_stage(self):
        self.assertEqual(
            'e_canadianhemlock_1_2',
            self.selector.select(3319, 7428, jumbo=False).sprite)
        self.assertEqual(
            'e_carolinasilverbell_1_3',
            self.selector.select(2618, 9398, jumbo=False).sprite)

    def test_disabled_selector_preserves_legacy_renderer_path(self):
        selector = erosion_trees.ErosionTreeSelector({})
        self.assertIsNone(selector.select(3319, 7428, jumbo=True))

    def test_unify_tree_type_remains_an_explicit_renderer_override(self):
        selector = erosion_trees.ErosionTreeSelector({
            'erosion_tree_compat': True,
            'unify_tree_type': 9,
        })
        self.assertEqual(
            'e_redmapleJUMBO_1_0',
            selector.select(3319, 7428, jumbo=True).sprite)


class BiomeTreeSelectorTest(unittest.TestCase):
    def make_map(self, root, cx, cy, pixel):
        path = os.path.join(root, 'maps')
        if not os.path.isdir(path):
            os.makedirs(path)
        image = Image.new('RGB', (4, 4), (pixel, 115, 254))
        image.save(os.path.join(path, 'biomemap_{}_{}.png'.format(cx, cy)))

    def test_reads_red_biome_channel_not_zone_or_grayscale(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_map(root, 0, 0, 153)
            self.assertEqual(153,
                             worldgen_trees.get_biome_pixel(root, 1, 2, 4))

    def test_default_matches_new_single_player_world_seed(self):
        selector = worldgen_trees.WorldGenTreeSelector('/unused', {
            'worldgen_tree_palette': True,
        })
        self.assertEqual('', selector.seed_string)
        self.assertEqual(0, selector.seed)

    def test_pine_biome_ignores_cell_local_placeholder_suffix(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_map(root, 0, 0, 153)
            selector = worldgen_trees.WorldGenTreeSelector(root, {
                'worldgen_tree_palette': True,
            })
            self.assertEqual(2, selector.select(1, 2, 4, 0))
            self.assertEqual(2, selector.select(1, 2, 4, 10))

    def test_global_coordinates_continue_across_biome_cells(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_map(root, 0, 0, 255)
            self.make_map(root, 1, 0, 153)
            selector = worldgen_trees.WorldGenTreeSelector(root, {
                'worldgen_tree_palette': True,
            })
            self.assertIn(selector.select(3, 1, 4, 7), (0, 1, 5, 9, 10))
            self.assertEqual(2, selector.select(4, 1, 4, 7))

    def test_unhandled_biome_preserves_legacy_tree(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_map(root, 0, 0, 115)
            selector = worldgen_trees.WorldGenTreeSelector(root, {
                'worldgen_tree_palette': True,
            })
            self.assertEqual(7, selector.select(1, 1, 4, 7))

    def test_unify_tree_type_still_wins(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_map(root, 0, 0, 255)
            selector = worldgen_trees.WorldGenTreeSelector(root, {
                'worldgen_tree_palette': True,
                'unify_tree_type': 4,
            })
            self.assertEqual(4, selector.select(1, 1, 4, 7))

    def test_profiles_match_build_42_species_totals(self):
        profiles = worldgen_trees.biome_tree_weights()
        self.assertEqual(((2, 0.70),), profiles[153])
        self.assertEqual(
            ((1, 0.35), (0, 0.35), (9, 0.10), (5, 0.10), (10, 0.05)),
            profiles[255])


class WorldGenTreeFootprintTest(unittest.TestCase):
    def test_direct_deciduous_trees_get_game_seasonal_foliage(self):
        self.assertEqual(
            ['e_riverbirchJUMBOXL_1_0', 'e_riverbirchJUMBOXL_1_3'],
            plants.get_worldgen_tree(
                'e_riverbirchJUMBOXL_1_0', 'summer'))
        self.assertEqual(
            ['e_redmapleJUMBOXXL_1_0', 'e_redmapleJUMBOXXL_1_4'],
            plants.get_worldgen_tree(
                'e_redmapleJUMBOXXL_1_0', 'summer2'))
        self.assertEqual(
            ['e_dogwoodJUMBO_1_1', 'e_dogwoodJUMBO_1_7'],
            plants.get_worldgen_tree('e_dogwoodJUMBO_1_1', 'summer'))

    def test_direct_evergreens_keep_their_self_contained_sprite(self):
        self.assertEqual(
            ['e_virginiapineJUMBOXXL_1_0'],
            plants.get_worldgen_tree(
                'e_virginiapineJUMBOXXL_1_0', 'summer'))

    def test_direct_tree_snow_replaces_base_like_the_game(self):
        self.assertEqual(
            ['e_riverbirchJUMBOXL_1_1'],
            plants.get_worldgen_tree(
                'e_riverbirchJUMBOXL_1_0', 'summer', snow=True))

    def test_build42_layout_sizes_and_visible_anchors(self):
        features = worldgen_trees.biome_tree_features()[153]
        jumbo = next(feature for feature in features if feature.size == 2)
        xl = next(feature for feature in features if feature.size == 3)
        xxl = next(feature for feature in features if feature.size == 5)

        layout = worldgen_trees._feature_layout(jumbo, 1)
        self.assertEqual(4, len(layout))
        self.assertEqual('e_virginiapineJUMBO_1_1', layout[(0, 0)])

        layout = worldgen_trees._feature_layout(xl)
        self.assertEqual(9, len(layout))
        self.assertEqual('e_virginiapineJUMBOXL_1_0', layout[(1, 1)])

        layout = worldgen_trees._feature_layout(xxl)
        self.assertEqual(25, len(layout))
        self.assertEqual('e_virginiapineJUMBOXXL_1_0', layout[(2, 2)])
        self.assertEqual('$any', layout[(0, 0)])
        self.assertEqual('$any', layout[(4, 4)])

    def test_primary_forest_boulder_groups_match_shipped_layouts(self):
        feature = next(
            feature for feature in
            worldgen_trees.biome_tree_features()[255]
            if feature.feature_name == 'boulders_primaryforest')

        groups = worldgen_trees._feature_tile_groups(feature)
        self.assertEqual(
            ((2, 2), (2, 2), (2, 2), (2, 2), (1, 2), (2, 1)),
            tuple(group[:2] for group in groups))
        self.assertEqual({
            (0, 0): 'boulders_19',
            (1, 0): 'boulders_18',
            (0, 1): 'boulders_16',
            (1, 1): 'boulders_17',
        }, worldgen_trees._feature_layout(feature, 0))
        self.assertEqual({
            (0, 0): 'boulders_34',
            (1, 0): 'boulders_35',
        }, worldgen_trees._feature_layout(feature, 5))

    def test_subbiome_reservations_use_fresh_coordinate_rng(self):
        self.assertEqual(
            'f_bushes_1_100',
            worldgen_trees._resolve_subbiome_action(
                153, 0, 0, 0, 'blends_natural_01_64').sprite)
        self.assertEqual(
            'f_bushes_1_107',
            worldgen_trees._resolve_subbiome_action(
                255, 0, 0, 0, 'blends_natural_01_69').sprite)
        self.assertEqual(
            'e_newgrass_1_4',
            worldgen_trees._resolve_subbiome_action(
                217, 0, 0, 0, 'blends_natural_01_70').sprite)
        self.assertEqual(
            'e_newgrass_1_4',
            worldgen_trees._resolve_subbiome_action(
                217, 0, 0, 0, 'blends_natural_01_16').sprite)
        self.assertIsNone(
            worldgen_trees._resolve_subbiome_action(
                217, 0, 0, 0, 'blends_natural_01_0').sprite)

    def test_generic_and_tree_placement_rules_use_last_match(self):
        farmmix = worldgen_trees._BIOME_TREE_PLACEMENTS[192]
        self.assertTrue(worldgen_trees._can_place(
            farmmix, 'blends_natural_01_23'))
        self.assertFalse(worldgen_trees._can_place(
            farmmix, 'blends_natural_01_0'))
        self.assertTrue(worldgen_trees._can_place(
            farmmix, 'blends_natural_01_64'))

        organic = worldgen_trees._BIOME_TREE_PLACEMENTS[243]
        self.assertTrue(worldgen_trees._can_place(
            organic, 'blends_natural_01_23'))
        self.assertFalse(worldgen_trees._can_place(
            organic, 'blends_natural_01_64'))

        pine = worldgen_trees._BIOME_TREE_PLACEMENTS[153]
        self.assertTrue(worldgen_trees._can_place(
            pine, 'blends_natural_01_0'))
        self.assertTrue(worldgen_trees._can_place(
            pine, 'blends_natural_01_64'))

    def test_future_square_structure_rule_matches_game_object_counts(self):
        placements = worldgen_trees._BIOME_TREE_PLACEMENTS[192]
        floor = 'blends_natural_01_23'

        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor,), placements))
        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor, 'vegetation_groundcover_01_2', 'f_bushes_1_4',
             'boulders_19'), placements))
        # CellLoader attaches this sprite to the floor, so it is absent from
        # IsoGridSquare.getObjects() and cannot make a human structure.
        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor, 'vegetation_foliage_01_2'), placements,
            frozenset(('vegetation_foliage_01_2',))))
        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor, 'vegetation_ornamental_01_7'), placements))
        self.assertFalse(worldgen_trees._future_square_is_eligible(
            (floor, 'location_shop_accessories_01_0'), placements))

        # WorldGenTile.isHumanStructure explicitly exempts any square with an
        # IsoTree, even if another non-vegetation object is also present.
        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor, 'location_shop_accessories_01_0',
             'vegetation_trees_01_11'), placements))
        self.assertTrue(worldgen_trees._future_square_is_eligible(
            (floor, 'location_shop_accessories_01_0',
             'e_virginiapineJUMBO_1_0'), placements))

    def test_source_tree_classification_uses_tile_definition_properties(self):
        self.assertFalse(worldgen_trees.is_worldgen_tree_tile(
            'vegetation_trees_01_0'))
        self.assertTrue(worldgen_trees.is_worldgen_tree_tile(
            'vegetation_trees_01_11'))
        self.assertTrue(worldgen_trees.is_worldgen_tree_tile(
            'e_virginiapine_1_2'))
        self.assertTrue(worldgen_trees.is_worldgen_tree_tile(
            'e_redmapleJUMBOXXL_1_0'))
        self.assertFalse(worldgen_trees.is_worldgen_tree_tile(
            'e_redmapleJUMBOXXL_invalid'))
        self.assertFalse(worldgen_trees.is_worldgen_tree_tile(
            'jumbo_tree_01_0'))
        self.assertFalse(worldgen_trees.is_worldgen_bush_tile(
            'vegetation_foliage_01_2'))
        self.assertTrue(worldgen_trees.is_worldgen_bush_tile(
            'f_bushes_1_64'))
        self.assertTrue(worldgen_trees.is_worldgen_bush_tile(
            'vegetation_farm_01_32'))

    def test_direct_source_trees_enter_the_worldgen_replacement_pass(self):
        source = ('blends_natural_01_23', 'e_redmaple_1_2')
        with mock.patch.object(worldgen_trees, '_source_tiles',
                               return_value=source), \
                mock.patch.object(worldgen_trees, 'get_biome_pixel',
                                  return_value=192):
            planner = worldgen_trees.WorldGenTreePlanner('/fake', {
                'worldgen_tree_footprints': True,
            })
            plan = planner._build_block(0, 0, 256)

        self.assertTrue(plan)
        self.assertTrue(any(action.sprite for action in plan.values()))

    def test_planner_reuses_the_renderer_source_cell(self):
        source = ('blends_natural_01_23', 'vegetation_trees_01_11')

        class SourceCell(object):
            x = 0
            y = 0
            cell_size = 256

            @staticmethod
            def get_square(_x, _y, _layer):
                return iter(source)

        with mock.patch.object(
                worldgen_trees, '_source_tiles',
                side_effect=AssertionError('source cell was loaded twice')), \
                mock.patch.object(worldgen_trees, 'get_biome_pixel',
                                  return_value=192):
            planner = worldgen_trees.WorldGenTreePlanner('/fake', {
                'worldgen_tree_footprints': True,
            })
            action = planner.action(
                0, 0, 256, source_cell=SourceCell())

        self.assertIsNotNone(action)

    def test_farmmix_generic_floor_produces_worldgen_replacements(self):
        source = ('blends_natural_01_23', 'vegetation_trees_01_11')
        with mock.patch.object(worldgen_trees, '_source_tiles',
                               return_value=source), \
                mock.patch.object(worldgen_trees, 'get_biome_pixel',
                                  return_value=192):
            planner = worldgen_trees.WorldGenTreePlanner('/fake', {
                'worldgen_tree_footprints': True,
            })
            plan = planner._build_block(0, 0, 256)

        self.assertTrue(any(action.sprite for action in plan.values()))
        self.assertFalse(all(
            action.suppress and action.sprite is None
            for action in plan.values()))

    def test_yellowwood_xl_matches_shipped_game_data_reference(self):
        feature = next(feature for feature in
                       worldgen_trees.biome_tree_features()[128]
                       if feature.species == 7 and feature.size == 3)
        self.assertEqual('e_carolinasilverbellJUMBOXL_1_0',
                         worldgen_trees._feature_sprite(feature))

    def test_dense_forest_plan_packs_large_footprints(self):
        source = ('blends_natural_01_16', 'vegetation_trees_01_11')
        with mock.patch.object(worldgen_trees, '_source_tiles',
                               return_value=source), \
                mock.patch.object(worldgen_trees, 'get_biome_pixel',
                                  return_value=153):
            planner = worldgen_trees.WorldGenTreePlanner('/fake', {
                'worldgen_tree_footprints': True,
            })
            plan = planner._build_block(0, 0, 256)

        sprites = [action.sprite for action in plan.values()
                   if action.sprite]
        # On a synthetic tree on every square, later origin footprints can
        # overwrite pending XXL centers before traversal reaches them.  That
        # is the game's x-major pending-array behavior, not a guarantee that
        # every authored size survives a maximally dense input.
        self.assertTrue(any('JUMBOXL' in sprite for sprite in sprites))
        self.assertTrue(any('JUMBO_1_' in sprite for sprite in sprites))
        self.assertGreater(sum(action.suppress for action in plan.values()),
                           len(sprites))

    def test_tile_definition_parser_finds_attached_floor_sprites(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'newtiledefinitions.tiles')
            with open(path, 'wb') as stream:
                stream.write(b'tdef')
                stream.write(struct.pack('<II', 1, 1))
                stream.write(b'vegetation_foliage_01\n')
                stream.write(b'vegetation_foliage_01.png\n')
                stream.write(struct.pack('<IIII', 1, 2, 0, 2))
                stream.write(struct.pack('<I', 1))
                stream.write(b'attachedFloor\n\n')
                stream.write(struct.pack('<I', 0))
            self.assertEqual(
                frozenset(('vegetation_foliage_01_0',)),
                worldgen_trees._load_attached_floor_tiles(path))

    def test_tile_definition_parser_matches_replace_then_patch_loading(self):
        def write_definition(path, properties):
            with open(path, 'wb') as stream:
                stream.write(b'tdef')
                stream.write(struct.pack('<II', 1, 1))
                stream.write(b'duplicate_sheet\n')
                stream.write(b'duplicate_sheet.png\n')
                stream.write(struct.pack('<IIII', 1, 1, 0, 1))
                stream.write(struct.pack('<I', len(properties)))
                for key, value in properties:
                    stream.write(key.encode('utf-8') + b'\n')
                    stream.write(value.encode('utf-8') + b'\n')

        with tempfile.TemporaryDirectory() as root:
            base = os.path.join(root, 'newtiledefinitions.tiles')
            replacement = os.path.join(root, 'tiledefinitions_erosion.tiles')
            patch = os.path.join(root, 'fix.patch.tiles')
            write_definition(base, [('attachedFloor', 'true')])
            write_definition(replacement, [])
            write_definition(patch, [('attachedFloor', 'true')])

            self.assertNotIn(
                'duplicate_sheet_0',
                worldgen_trees._load_attached_floor_tiles(
                    (base, replacement)))
            self.assertIn(
                'duplicate_sheet_0',
                worldgen_trees._load_attached_floor_tiles(
                    (base, replacement, patch)))

    def test_tile_definition_parser_applies_implicit_attached_floor_rules(self):
        def write_empty_sheet(path, name, tile_count):
            with open(path, 'wb') as stream:
                stream.write(b'tdef')
                stream.write(struct.pack('<II', 1, 1))
                stream.write(name.encode('utf-8') + b'\n')
                stream.write(name.encode('utf-8') + b'.png\n')
                stream.write(struct.pack('<IIII', 1, tile_count, 0,
                                         tile_count))
                for _ in range(tile_count):
                    stream.write(struct.pack('<I', 0))

        with tempfile.TemporaryDirectory() as root:
            bushes = os.path.join(root, 'newtiledefinitions.tiles')
            write_empty_sheet(bushes, 'f_bushes_1', 33)
            attached = worldgen_trees._load_attached_floor_tiles(bushes)
            self.assertIn('f_bushes_1_31', attached)
            self.assertNotIn('f_bushes_1_32', attached)

    def test_pine_plan_renders_direct_and_subbiome_decorations(self):
        source = ('blends_natural_01_64', 'vegetation_trees_01_11')
        with mock.patch.object(worldgen_trees, '_source_tiles',
                               return_value=source), \
                mock.patch.object(worldgen_trees, 'get_biome_pixel',
                                  return_value=153):
            planner = worldgen_trees.WorldGenTreePlanner('/fake', {
                'worldgen_tree_footprints': True,
            })
            plan = planner._build_block(0, 0, 256)

        sprites = tuple(action.sprite for action in plan.values()
                        if action.sprite)
        self.assertTrue(any(sprite.startswith('f_bushes_1_')
                            for sprite in sprites))
        self.assertTrue(any(sprite.startswith('e_newgrass_1_')
                            for sprite in sprites))
        self.assertTrue(any(sprite.startswith('boulders_')
                            for sprite in sprites))
        self.assertGreater(sum(sprite.startswith('f_bushes_1_')
                               for sprite in sprites), 50)
        self.assertTrue(all(action.suppress_competing
                            for action in plan.values()))

    def test_action_uses_even_chunk_aligned_sixteen_square_blocks(self):
        planner = worldgen_trees.WorldGenTreePlanner('/fake', {
            'worldgen_tree_footprints': True,
        })
        calls = []

        def fake_build(x, y, cell_size):
            calls.append((x, y, cell_size))
            return {}

        planner._build_block = fake_build
        planner.action(31, 47, 256)
        self.assertEqual([(16, 32, 256)], calls)


if __name__ == '__main__':
    unittest.main()
