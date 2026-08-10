"""Build 42 biome-aware tree selection for static map renders.

Project Zomboid 42 replaces generic ``vegetation_trees_01_*`` placeholders
through WorldGen when a map square is loaded.  The stock pzmap renderer instead
maps each placeholder suffix to one fixed species.  Map-editor fill operations
restart their placeholder patterns at cell boundaries, which makes that static
mapping expose a forest grid that is not representative of the game.

This module implements two levels of the game's replacement path:

* read the BIOME (red) channel from ``maps/biomemap_CX_CY.png``;
* use the tree-species weights from the corresponding Build 42 map biome; and
* seed a Java-compatible RNG from global square coordinates; and
* optionally pack the game's 2x2 JUMBO, 3x3 XL, and 5x5 XXL footprints into
  the same globally aligned 16x16 blocks used by ``IsoChunk.loadBrandNew``.

The footprint planner follows the TREE replacement path, including the bush,
grass, and boulder features that occur in TREE probability tables.  It also
resolves ``$subbiome`` reservations against the shipped TREE-to-TREE subbiome
tables.  It does not run independent BUSH, PLANT, or ORE passes on squares that
were not reached through TREE replacement.
"""

import os
import re
import struct
from collections import OrderedDict, namedtuple

from PIL import Image

from . import cell as cell_module

try:
    from functools import lru_cache
except ImportError:
    from backports.functools_lru_cache import lru_cache


# Indices match plants._TREE_DEF.  Weights are the sums of the JUMBO, JUMBOXL,
# and JUMBOXXL variants for each species, conditional on WorldGen selecting a
# tree feature.  Sources in the Build 42 install:
#   media/lua/server/metazones/BiomeMapConfig.lua
#   media/lua/server/WorldGen/biomes/map/*.lua
_BIOME_TREE_WEIGHTS = {
    # farmmix_forest: pixels 128 (Farm), 141 (FarmLand), 192 (FarmMixForest)
    128: ((7, 0.18), (9, 0.35), (6, 0.15), (5, 0.22), (10, 0.15)),
    141: ((7, 0.18), (9, 0.35), (6, 0.15), (5, 0.22), (10, 0.15)),
    192: ((7, 0.18), (9, 0.35), (6, 0.15), (5, 0.22), (10, 0.15)),
    # ph_forest (acidic/pine-heavy forest)
    153: ((2, 0.70),),
    # pr_forest
    179: ((8, 0.30), (4, 0.30), (6, 0.30)),
    # farm_forest
    204: ((7, 0.35), (9, 0.35), (6, 0.30)),
    # birch_forest
    217: ((3, 0.80),),
    # birchmix_forest
    230: ((3, 0.40), (5, 0.17), (9, 0.18), (10, 0.15)),
    # organic_forest
    243: ((5, 0.35), (9, 0.35), (10, 0.30)),
    # primary_forest
    255: ((1, 0.35), (0, 0.35), (9, 0.10), (5, 0.10), (10, 0.05)),
}

TREE_TYPE_COUNT = 11
WORLDGEN_BLOCK_SIZE = 16

_GENERIC_TREE_PATTERN = re.compile(r'^vegetation_trees_01_(\d+)$')
_DIRECT_TREE_PATTERN = re.compile(
    r'^e_(?:americanholly|canadianhemlock|'
    r'virginiapine|riverbirch|cockspurhawthorn|dogwood|'
    r'carolinasilverbell|yellowwood|easternredbud|redmaple|'
    r'americanlinden)(?:_\d+_\d+|JUMBO(?:XL|XXL)?_\d+_\d+)$')
_GENERIC_ISO_TREE_INDICES = frozenset(
    (8, 9, 10, 11, 12, 13, 14, 15, 17, 24, 25))
_GRASS_LIKE_PATTERN = re.compile(
    r'^(?:e_newgrass_|blends_grassoverlays_|d_plants_|d_generic_1_|'
    r'd_floorleaves_|vegetation_groundcover_)')
_ORE_PATTERN = re.compile(r'^(?:boulders_|crafting_ore_)')
_BUSH_PROPERTY_PATTERNS = (
    re.compile(r'^f_bushes_1_\d+$'),
    re.compile(r'^f_bushes_2_(?:[0-9]|1[0-9])$'),
    re.compile(r'^vegetation_farm_01_(?:0|1|3[2-9]|4[0-7])$'),
    re.compile(r'^vegetation_ornamental_01_(?:[0-9]|1[0-3])$'),
)


TreeFeature = namedtuple(
    'TreeFeature',
    'species size probability sprite_prefix tile_groups feature_name')
TreePlanAction = namedtuple(
    'TreePlanAction', 'suppress sprite suppress_competing suppress_ores')


def _tree(species, size, probability, sprite_prefix=None):
    return TreeFeature(
        species, size, probability, sprite_prefix, None, 'tree')


def _tile_group(rows):
    """Build a row-major TileGroup equivalent from a rectangular matrix."""
    rows = tuple(tuple(row) for row in rows)
    if not rows or not rows[0]:
        raise ValueError('empty worldgen tile group')
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise ValueError('ragged worldgen tile group')
    return width, len(rows), tuple(
        sprite for row in rows for sprite in row)


def _single_tile_groups(sprites):
    return tuple(_tile_group(((sprite,),)) for sprite in sprites)


def _decoration(name, probability, tile_groups):
    # WorldGenReader computes Feature.minSize as the minimum of every tile
    # group's width and height.  This is 1 for all shipped decorations here,
    # including boulders_primaryforest's mixture of 2x2, 1x2, and 2x1 groups.
    min_size = min(
        min(width, height) for width, height, _tiles in tile_groups)
    return TreeFeature(
        None, min_size, probability, None, tuple(tile_groups), name)


_BUSH_REGULAR_GROUPS = _single_tile_groups(
    'f_bushes_1_{}'.format(index) for index in (
        67, 69, 70, 72, 73, 75, 76, 79,
        99, 101, 102, 104, 105, 107, 108, 111))

# bush_phforest.lua and bush_dry.lua intentionally contain repeated entries;
# keeping them repeated preserves their authored per-sprite weighting.
_BUSH_DRY_GROUPS = _single_tile_groups(
    'f_bushes_1_{}'.format(index) for index in (
        64, 96, 100, 68, 106, 99, 67, 103, 71,
        100, 68, 106, 99, 67, 103, 71,
        100, 68, 106, 99, 67, 103, 71,
        100, 68, 106, 99, 67, 103, 71, 74))

_GRASS_HIGH_GROUPS = _single_tile_groups(
    'e_newgrass_1_{}'.format(index) for index in range(6))

_BOULDERS_LOW_GROUPS = _single_tile_groups(
    'boulders_{}'.format(index) for index in range(40, 56))

_BOULDERS_PRIMARY_GROUPS = tuple(_tile_group(rows) for rows in (
    (('boulders_19', 'boulders_18'),
     ('boulders_16', 'boulders_17')),
    (('boulders_23', 'boulders_22'),
     ('boulders_20', 'boulders_21')),
    (('boulders_27', 'boulders_26'),
     ('boulders_24', 'boulders_25')),
    (('boulders_31', 'boulders_30'),
     ('boulders_28', 'boulders_29')),
    (('boulders_33',), ('boulders_32',)),
    (('boulders_34', 'boulders_35'),),
))


def _bush_regular(probability):
    return _decoration('bush_regular', probability, _BUSH_REGULAR_GROUPS)


def _bush_dry(probability):
    return _decoration('bush_dry', probability, _BUSH_DRY_GROUPS)


def _bush_phforest(probability):
    return _decoration('bush_phforest', probability, _BUSH_DRY_GROUPS)


def _grass_high(probability):
    return _decoration('grass_high', probability, _GRASS_HIGH_GROUPS)


def _boulders_low(probability):
    return _decoration(
        'boulderslow_prim', probability, _BOULDERS_LOW_GROUPS)


def _boulders_primary(probability):
    return _decoration(
        'boulders_primaryforest', probability,
        _BOULDERS_PRIMARY_GROUPS)


# Exact order and probabilities from media/lua/server/WorldGen/biomes/map.
# Species indices match plants._TREE_DEF.  ``yellowwood_jumbo_xl`` really does
# reference the Carolina Silverbell XL sprite in Build 42.20; retaining that
# apparent game-data typo is part of compatibility mode.
_BIOME_TREE_FEATURES = {
    128: (
        _tree(7, 2, .05), _tree(7, 3, .05,
                                'e_carolinasilverbell'),
        _tree(7, 5, .08),
        _tree(9, 2, .10), _tree(9, 3, .10), _tree(9, 5, .15),
        _tree(6, 2, .05), _tree(6, 3, .05), _tree(6, 5, .05),
        _tree(5, 2, .05), _tree(5, 3, .10), _tree(5, 5, .07),
        _tree(10, 2, .05), _tree(10, 3, .05), _tree(10, 5, .05),
    ),
    153: (
        _tree(2, 5, .20), _tree(2, 3, .40), _tree(2, 2, .10),
        _bush_phforest(.05), _boulders_low(.15), _grass_high(.05),
    ),
    179: (
        _tree(8, 3, .10), _tree(8, 5, .05), _tree(8, 2, .15),
        _tree(4, 2, .15), _tree(4, 5, .05), _tree(4, 3, .10),
        _tree(6, 2, .15), _tree(6, 3, .10), _tree(6, 5, .05),
        _grass_high(.10),
    ),
    204: (
        _tree(7, 2, .10), _tree(7, 3, .10), _tree(7, 5, .15),
        _tree(9, 2, .10), _tree(9, 3, .10), _tree(9, 5, .15),
        _tree(6, 2, .10), _tree(6, 3, .10), _tree(6, 5, .10),
    ),
    217: (
        _tree(3, 5, .30), _tree(3, 3, .40), _tree(3, 2, .10),
        _bush_regular(.10), _boulders_low(.10),
    ),
    230: (
        _tree(3, 5, .15), _tree(3, 3, .20), _tree(3, 2, .05),
        _bush_regular(.05), _boulders_low(.05),
        _tree(5, 2, .05), _tree(5, 3, .05), _tree(5, 5, .07),
        _tree(9, 2, .05), _tree(9, 3, .05), _tree(9, 5, .08),
        _tree(10, 2, .05), _tree(10, 3, .05), _tree(10, 5, .05),
    ),
    243: (
        _tree(5, 2, .10), _tree(5, 3, .10), _tree(5, 5, .15),
        _tree(9, 2, .10), _tree(9, 3, .10), _tree(9, 5, .15),
        _tree(10, 2, .10), _tree(10, 3, .10), _tree(10, 5, .10),
    ),
    255: (
        _tree(1, 5, .15), _tree(1, 3, .20),
        _tree(0, 5, .15), _tree(0, 3, .20),
        _tree(9, 5, .05), _tree(9, 3, .05),
        _tree(5, 5, .05), _tree(5, 3, .05),
        _tree(10, 5, .05), _boulders_primary(.05),
    ),
}

# Farm, FarmLand, and FarmMixForest share the same biome definition.
_BIOME_TREE_FEATURES[141] = _BIOME_TREE_FEATURES[128]
_BIOME_TREE_FEATURES[192] = _BIOME_TREE_FEATURES[128]

# TREE-to-TREE entries from each map biome's params.subbiomes table.  A
# pending $subbiome token only changes the replacement biome; the game then
# replaces an existing generic tree using a fresh coordinate-seeded Random.
_BIOME_TREE_SUBBIOMES = {
    128: _grass_high(1.0),
    141: _grass_high(1.0),
    153: _bush_dry(1.0),
    179: _bush_regular(1.0),
    192: _grass_high(1.0),
    204: _grass_high(1.0),
    217: _grass_high(1.0),
    230: _grass_high(1.0),
    243: _grass_high(1.0),
    255: _bush_regular(1.0),
}

_GENERIC_NATURAL_PLACEMENTS = (
    'blends_natural_01_*',
    '!blends_natural_01_0',
    '!blends_natural_01_5',
    '!blends_natural_01_6',
    '!blends_natural_01_7',
    '!blends_natural_01_64',
    '!blends_natural_01_69',
    '!blends_natural_01_70',
    '!blends_natural_01_71',
)

_FOREST_TREE_PLACEMENTS = (
    'blends_natural_01_64',
    'blends_natural_01_69',
    'blends_natural_01_70',
    'blends_natural_01_71',
)

# WorldGenReader.loadPlacements copies GENERIC into every FeatureType and then
# appends the feature-specific rules.  WorldGenUtils.canPlace evaluates the
# resulting list in order and lets the last matching rule win.  Keeping the
# ordered rules is important: farmmix/birchmix and all shipped TREE subbiomes
# re-enable 64/69/70/71 after GENERIC excludes them.
_BIOME_TREE_PLACEMENTS = {
    128: _GENERIC_NATURAL_PLACEMENTS + _FOREST_TREE_PLACEMENTS,
    141: _GENERIC_NATURAL_PLACEMENTS + _FOREST_TREE_PLACEMENTS,
    153: ('blends_natural_01_*',),
    179: _GENERIC_NATURAL_PLACEMENTS,
    192: _GENERIC_NATURAL_PLACEMENTS + _FOREST_TREE_PLACEMENTS,
    204: _GENERIC_NATURAL_PLACEMENTS,
    217: _GENERIC_NATURAL_PLACEMENTS,
    230: _GENERIC_NATURAL_PLACEMENTS + _FOREST_TREE_PLACEMENTS,
    243: _GENERIC_NATURAL_PLACEMENTS,
    255: _GENERIC_NATURAL_PLACEMENTS,
}

_SUBBIOME_TREE_PLACEMENTS = (
    _GENERIC_NATURAL_PLACEMENTS + _FOREST_TREE_PLACEMENTS)

_TREE_PREFIXES = (
    'e_americanholly',
    'e_canadianhemlock',
    'e_virginiapine',
    'e_riverbirch',
    'e_cockspurhawthorn',
    'e_dogwood',
    'e_carolinasilverbell',
    'e_yellowwood',
    'e_easternredbud',
    'e_redmaple',
    'e_americanlinden',
)


_JAVA_MULTIPLIER = 0x5DEECE66D
_JAVA_ADDEND = 0xB
_JAVA_MASK = (1 << 48) - 1
_LONG_MASK = (1 << 64) - 1


def _signed(value, bits):
    sign = 1 << (bits - 1)
    value &= (1 << bits) - 1
    return value - (1 << bits) if value & sign else value


def _float32(value):
    """Round a Python number after one JVM float operation."""
    return struct.unpack('>f', struct.pack('>f', value))[0]


def java_string_hashcode(value):
    """Return ``String.hashCode()`` over Java UTF-16 code units."""
    result = 0
    encoded = value.encode('utf-16-be', 'surrogatepass')
    for offset in range(0, len(encoded), 2):
        code_unit = (encoded[offset] << 8) | encoded[offset + 1]
        result = (31 * result + code_unit) & 0xFFFFFFFF
    return _signed(result, 32)


class JavaRandom(object):
    """Small java.util.Random implementation used by WorldGenParams."""

    def __init__(self, seed):
        self.set_seed(seed)

    def set_seed(self, seed):
        self.seed = (int(seed) ^ _JAVA_MULTIPLIER) & _JAVA_MASK

    def next(self, bits):
        self.seed = (self.seed * _JAVA_MULTIPLIER + _JAVA_ADDEND) & _JAVA_MASK
        value = self.seed >> (48 - bits)
        return _signed(value, 32) if bits == 32 else value

    def next_long(self):
        value = (self.next(32) << 32) + self.next(32)
        return _signed(value, 64)

    def next_float(self):
        return self.next(24) / float(1 << 24)

    def next_int(self, bound):
        """Return ``Random.nextInt(bound)`` with Java's bit consumption."""
        if bound <= 0:
            raise ValueError('bound must be positive')
        if bound & (bound - 1) == 0:
            return (bound * self.next(31)) >> 31
        while True:
            bits = self.next(31)
            value = bits % bound
            # Java evaluates this expression as a signed 32-bit int.
            if _signed(bits - value + (bound - 1), 32) >= 0:
                return value


def game_square_random(seed, sx, sy):
    """Create the coordinate RNG used by Build 42 WorldGenParams.

    ``genMapSquare`` passes the global square coordinate plus its 8-square
    chunk origin.  Keeping that slightly surprising formula matters because it
    is part of the shipped Build 42 bytecode.
    """
    random = JavaRandom(seed)
    x_multiplier = random.next_long()
    y_multiplier = random.next_long()
    # Java integer division truncates toward zero.  The official map is in
    # positive coordinates, but retaining this distinction makes diagnostic
    # and mod-map behavior exact on negative coordinates too.
    chunk_x = sx // 8 if sx >= 0 else -((-sx) // 8)
    chunk_y = sy // 8 if sy >= 0 else -((-sy) // 8)
    random_x = sx + chunk_x * 8
    random_y = sy + chunk_y * 8
    mixed = ((random_x * x_multiplier) & _LONG_MASK)
    mixed ^= ((random_y * y_multiplier) & _LONG_MASK)
    mixed ^= seed & _LONG_MASK
    random.set_seed(_signed(mixed, 64))
    return random


@lru_cache(maxsize=32)
def _load_biome_channel(map_path, cx, cy):
    path = os.path.join(map_path, 'maps',
                        'biomemap_{}_{}.png'.format(cx, cy))
    if not os.path.isfile(path):
        return None
    with Image.open(path) as image:
        # BiomeRaster.Type.BIOME is band zero.  Palette images must first be
        # expanded to RGB; converting directly to L would mix BIOME and ZONE.
        red = image.convert('RGB').getchannel('R')
        return red.size, red.tobytes()


def get_biome_pixel(map_path, sx, sy, cell_size):
    cx, subx = divmod(sx, cell_size)
    cy, suby = divmod(sy, cell_size)
    loaded = _load_biome_channel(map_path, cx, cy)
    if not loaded:
        return None
    (width, height), pixels = loaded
    if subx >= width or suby >= height:
        return None
    return pixels[subx + suby * width]


def choose_weighted(weights, value):
    total = sum(weight for _, weight in weights)
    target = value * total
    cumulative = 0.0
    for tree_index, weight in weights:
        cumulative += weight
        if target < cumulative:
            return tree_index
    return weights[-1][0]


class WorldGenTreeSelector(object):
    """Choose a game-authored species for a generic map tree placeholder."""

    # A new single-player world leaves WorldGenParams at its constructor
    # default: the empty string and integer seed zero.  Dedicated servers use
    # their configured/generated Seed value instead.
    DEFAULT_SEED = ''

    def __init__(self, map_path, conf=None):
        conf = conf or {}
        self.map_path = map_path
        self.enabled = bool(conf.get('worldgen_tree_palette', False))
        self.seed_string = conf.get('worldgen_seed', self.DEFAULT_SEED) or ''
        self.seed = java_string_hashcode(self.seed_string)
        self.unify_tree = int(conf.get('unify_tree_type', -1))

    def select(self, sx, sy, cell_size, legacy_index):
        if not self.enabled:
            return legacy_index
        if self.unify_tree >= 0:
            return self.unify_tree
        pixel = get_biome_pixel(self.map_path, sx, sy, cell_size)
        weights = _BIOME_TREE_WEIGHTS.get(pixel)
        if not weights:
            return legacy_index
        value = game_square_random(self.seed, sx, sy).next_float()
        return choose_weighted(weights, value)


def _feature_sprite(feature, variant=0):
    if feature.species is None:
        raise ValueError('decoration feature has no tree sprite')
    prefix = feature.sprite_prefix or _TREE_PREFIXES[feature.species]
    if feature.size == 2:
        return '{}JUMBO_1_{}'.format(prefix, variant)
    if feature.size == 3:
        return '{}JUMBOXL_1_0'.format(prefix)
    if feature.size == 5:
        return '{}JUMBOXXL_1_0'.format(prefix)
    raise ValueError('unsupported tree footprint {}'.format(feature.size))


def _feature_tile_groups(feature, max_size=None):
    """Return TileGroups eligible for the current setTiles size retry."""
    if feature.tile_groups is not None:
        groups = feature.tile_groups
    else:
        size = feature.size
        if size == 2:
            groups = tuple(_tile_group((
                (_feature_sprite(feature, variant), '$subbiome'),
                ('$subbiome', '$subbiome'),
            )) for variant in range(2))
        else:
            center = size // 2
            rows = []
            for y in range(size):
                row = []
                for x in range(size):
                    if size == 5 and x in (0, 4) and y in (0, 4):
                        row.append('$any')
                    elif x == center and y == center:
                        row.append(_feature_sprite(feature))
                    else:
                        row.append('$subbiome')
                rows.append(tuple(row))
            groups = (_tile_group(tuple(rows)),)

    if max_size is None:
        return groups
    return tuple(group for group in groups
                 if group[0] <= max_size and group[1] <= max_size)


def _tile_group_layout(group):
    width, height, tiles = group
    return {(x, y): tiles[x + y * width]
            for y in range(height) for x in range(width)}


def _feature_layout(feature, variant=0):
    """Return a shipped tile group as x/y-addressed pending tokens."""
    groups = _feature_tile_groups(feature)
    return _tile_group_layout(groups[variant])


@lru_cache(maxsize=256)
def _placement_regex(pattern):
    """Compile the wildcard syntax used by WorldGenUtils.canPlace."""
    pattern = pattern.replace('.', r'\.')
    pattern = pattern.replace('*', '.*')
    pattern = pattern.replace('?', '.?')
    return re.compile('^{}$'.format(pattern))


def _can_place(placements, floor):
    """Mirror WorldGenUtils.canPlace's ordered, last-match-wins rules."""
    allowed = False
    if placements is None:
        return allowed
    for authored_pattern in placements:
        positive = not authored_pattern.startswith('!')
        pattern = (authored_pattern if positive else authored_pattern[1:])
        if floor is not None and _placement_regex(pattern).match(floor):
            allowed = positive
    return allowed


@lru_cache(maxsize=64)
def _load_source_cell(map_path, cx, cy):
    return cell_module.load_cell(map_path, cx, cy)


def _source_tiles(map_path, sx, sy, cell_size):
    cx, subx = divmod(sx, cell_size)
    cy, suby = divmod(sy, cell_size)
    loaded = _load_source_cell(map_path, cx, cy)
    if not loaded:
        return ()
    return tuple(loaded.get_square(subx, suby, 0) or ())


def _tile_definition_paths(map_path):
    """Locate shipped tile-property databases in the game's load order."""
    media_path = os.path.dirname(os.path.dirname(os.path.abspath(map_path)))
    if not os.path.isdir(media_path):
        return ()
    names = (
        'newtiledefinitions.tiles',
        'tiledefinitions_erosion.tiles',
        'tiledefinitions_overlays.tiles',
        'tiledefinitions_b42chunkcaching.tiles',
        'tiledefinitions_noiseworks.patch.tiles',
        'jumbo_trees_big.tiles',
        'jumbo_trees.tiles',
    )
    return tuple(
        os.path.join(media_path, name) for name in names
        if os.path.isfile(os.path.join(media_path, name)))


@lru_cache(maxsize=8)
def _load_attached_floor_tiles(path):
    """Mirror IsoWorld's ordered attached-floor tile-definition loading.

    A normal tile-definition file creates a replacement IsoSprite even when
    its name already exists.  A ``.patch.tiles`` file instead updates the
    existing sprite.  CellLoader also marks damaged/trash sprites and the
    first f_bushes sheet entries as attached without a serialized property.
    """
    if not path:
        return frozenset()
    paths = (path,) if isinstance(path, str) else tuple(path)
    attached_by_name = {}
    for definition_path in paths:
        is_patch = definition_path.endswith('.patch.tiles')
        with open(definition_path, 'rb') as stream:
            if stream.read(4) != b'tdef':
                raise ValueError(
                    'invalid tile definitions: {}'.format(definition_path))
            _version, tileset_count = struct.unpack('<II', stream.read(8))

            def read_line():
                value = stream.readline()
                if not value:
                    raise EOFError(
                        'truncated tile definitions: {}'.format(
                            definition_path))
                return value.rstrip(b'\n').decode('utf-8')

            for _tileset_index in range(tileset_count):
                tileset = read_line()
                read_line()  # image path
                _columns, _rows, _sheet_id, tile_count = struct.unpack(
                    '<IIII', stream.read(16))
                for tile_index in range(tile_count):
                    tile_name = '{}_{}'.format(tileset, tile_index)
                    property_count, = struct.unpack('<I', stream.read(4))
                    is_attached_floor = (
                        'damaged' in tile_name or
                        'trash_' in tile_name or
                        (tile_name.startswith('f_bushes') and
                         tile_index <= 31))
                    for _property_index in range(property_count):
                        key, _value = read_line(), read_line()
                        if key == 'attachedFloor':
                            is_attached_floor = True
                    if is_patch:
                        if (tile_name in attached_by_name and
                                is_attached_floor):
                            attached_by_name[tile_name] = True
                    else:
                        attached_by_name[tile_name] = is_attached_floor
    return frozenset(name for name, is_attached in
                     attached_by_name.items() if is_attached)


@lru_cache(maxsize=8192)
def is_worldgen_tree_tile(tile):
    """Return whether CellLoader constructs this sprite as an IsoTree.

    The generic tileset contains several attached-floor placeholders that do
    not carry the ``tree`` property.  Only the indices listed here become
    IsoTree instances and enter WorldGenChunk's TREE replacement pass.  All
    shipped direct species families do carry that property.
    """
    match = _GENERIC_TREE_PATTERN.match(tile)
    if match:
        return int(match.group(1)) in _GENERIC_ISO_TREE_INDICES
    return _DIRECT_TREE_PATTERN.match(tile) is not None


@lru_cache(maxsize=8192)
def is_worldgen_bush_tile(tile):
    """Mirror IsoObject.isBush for shipped sprite definitions."""
    return any(pattern.match(tile) for pattern in _BUSH_PROPERTY_PATTERNS)


@lru_cache(maxsize=8192)
def is_worldgen_grass_like_tile(tile):
    """Mirror IsoObject.isGrassLike's shipped name-prefix checks."""
    return _GRASS_LIKE_PATTERN.match(tile) is not None


@lru_cache(maxsize=8192)
def is_worldgen_ore_tile(tile):
    """Mirror IsoObject.isOres's shipped name-prefix checks."""
    return _ORE_PATTERN.match(tile) is not None


def _has_source_tree(tiles):
    return any(is_worldgen_tree_tile(tile) for tile in tiles)


def _future_square_is_eligible(tiles, placements=None,
                               attached_floor_tiles=frozenset()):
    """Mirror WorldGenTile.checkFutureSquares/isHumanStructure.

    Lotpack layer-zero entries correspond to the square's IsoObjects, with the
    floor first.  Build 42 considers a square human-made when it has more than
    one object after grass-like, bush, and ore objects are subtracted, unless
    it contains a tree.  The shipped source-map vegetation uses the explicit
    sprite families below, so the same object-count rule can be evaluated
    without constructing live IsoObject instances.
    """
    if not tiles:
        return False
    if placements is not None and not _can_place(placements, tiles[0]):
        return False
    if _has_source_tree(tiles):
        return True
    object_tiles = tuple(tile for tile in tiles
                         if tile not in attached_floor_tiles)
    vegetation_count = sum(
        1 for tile in object_tiles
        if (is_worldgen_bush_tile(tile) or
            is_worldgen_grass_like_tile(tile) or
            is_worldgen_ore_tile(tile)))
    return len(object_tiles) - vegetation_count <= 1


def _find_feature(all_features, eligible, random):
    """Mirror WorldGenTile.findFeature's float32 weight rescaling."""
    if not all_features:
        return None
    all_total = 0.0
    for feature in all_features:
        all_total = _float32(all_total + _float32(feature.probability))
    eligible_total = 0.0
    for feature in eligible:
        eligible_total = _float32(
            eligible_total + _float32(feature.probability))
    if eligible_total <= 0:
        return None
    value = random.next_float()
    cumulative = 0.0
    for feature in eligible:
        scaled = _float32(
            _float32(_float32(feature.probability) / eligible_total) *
            all_total)
        cumulative = _float32(cumulative + scaled)
        if value < cumulative:
            return feature
    return None


def _resolve_subbiome_action(pixel, sx, sy, seed, floor):
    """Resolve a future-square TREE $subbiome reservation.

    The square's primary coordinate RNG has not been consumed when doPending
    establishes the subbiome, so a fresh coordinate RNG is exact here.  An
    origin-square $subbiome is handled inside the planner because it must
    continue the already-consumed RNG instead.
    """
    feature = _BIOME_TREE_SUBBIOMES.get(pixel)
    if feature is None:
        return None
    if not _can_place(_SUBBIOME_TREE_PLACEMENTS, floor):
        return TreePlanAction(True, None, False, False)
    random = game_square_random(seed, sx, sy)
    selected = _find_feature((feature,), (feature,), random)
    if selected is None:
        return TreePlanAction(True, None, True, True)
    groups = _feature_tile_groups(selected, 8)
    if not groups:
        return None
    group = groups[random.next_int(len(groups))]
    token = _tile_group_layout(group)[(0, 0)]
    return TreePlanAction(True, token, True, False)


class WorldGenTreePlanner(object):
    """Pack Build 42 TREE features into fixed, global 16-square blocks."""

    DEFAULT_SEED = WorldGenTreeSelector.DEFAULT_SEED

    def __init__(self, map_path, conf=None):
        conf = conf or {}
        self.map_path = map_path
        self.enabled = bool(conf.get('worldgen_tree_footprints', False))
        seed_string = conf.get('worldgen_seed', self.DEFAULT_SEED) or ''
        self.seed = java_string_hashcode(seed_string)
        self.cache_limit = max(1, int(conf.get(
            'worldgen_tree_plan_cache_blocks', 256)))
        self._plans = OrderedDict()
        self._attached_floor_tiles = None

    def action(self, sx, sy, cell_size, source_cell=None):
        if not self.enabled:
            return None
        block_x = (sx // WORLDGEN_BLOCK_SIZE) * WORLDGEN_BLOCK_SIZE
        block_y = (sy // WORLDGEN_BLOCK_SIZE) * WORLDGEN_BLOCK_SIZE
        key = (block_x, block_y, cell_size)
        plan = self._plans.pop(key, None)
        if plan is None:
            if source_cell is None:
                plan = self._build_block(block_x, block_y, cell_size)
            else:
                plan = self._build_block(
                    block_x, block_y, cell_size, source_cell=source_cell)
        self._plans[key] = plan
        while len(self._plans) > self.cache_limit:
            self._plans.popitem(last=False)
        return plan.get((sx, sy))

    def _build_block(self, block_x, block_y, cell_size, source_cell=None):
        source = {}
        direct_cell = (
            source_cell is not None and
            source_cell.cell_size == cell_size and
            source_cell.x == block_x // cell_size and
            source_cell.y == block_y // cell_size and
            (block_x + WORLDGEN_BLOCK_SIZE - 1) // cell_size ==
            source_cell.x and
            (block_y + WORLDGEN_BLOCK_SIZE - 1) // cell_size ==
            source_cell.y)
        for x in range(WORLDGEN_BLOCK_SIZE):
            for y in range(WORLDGEN_BLOCK_SIZE):
                sx, sy = block_x + x, block_y + y
                if direct_cell:
                    tiles = source_cell.get_square(
                        sx - source_cell.x * cell_size,
                        sy - source_cell.y * cell_size, 0)
                    source[(sx, sy)] = tuple(tiles or ())
                else:
                    source[(sx, sy)] = _source_tiles(
                        self.map_path, sx, sy, cell_size)

        pending = {}
        actions = {}
        if self._attached_floor_tiles is None:
            self._attached_floor_tiles = _load_attached_floor_tiles(
                _tile_definition_paths(self.map_path))
        attached_floor_tiles = self._attached_floor_tiles

        def select_at(sx, sy, override_features=None,
                      override_placements=None, allow_reapply=True):
            pixel = get_biome_pixel(
                self.map_path, sx, sy, cell_size)
            all_features = (override_features if override_features is not None
                            else _BIOME_TREE_FEATURES.get(pixel))
            if not all_features:
                return False
            placements = (override_placements
                          if override_placements is not None
                          else _BIOME_TREE_PLACEMENTS.get(pixel))
            floor = source[(sx, sy)][0] if source[(sx, sy)] else None
            if placements is not None and not _can_place(placements, floor):
                actions[(sx, sy)] = TreePlanAction(
                    True, None, False, False)
                return True
            random = game_square_random(self.seed, sx, sy)

            # getBiomeTile may recurse once when a selected TileGroup has
            # $any at its origin.  The recursion retains the current max-size
            # retry and RNG state; setTiles itself retries at 8, 4, 2, and 1.
            def lookup(max_size, current_depth=0):
                token = pending.get((sx, sy))
                if token and token not in ('$any', '$subbiome'):
                    return 'success', token

                eligible = tuple(feature for feature in all_features
                                 if feature.size <= max_size)
                feature = _find_feature(
                    all_features, eligible, random)
                if feature is None:
                    return 'delete', None

                # Feature eligibility uses Feature.minSize, then the game
                # filters TileGroups by both width and height.  It only
                # consumes nextInt after finding at least one group.
                groups = _feature_tile_groups(feature, max_size)
                if not groups:
                    return 'retry', None
                group = groups[random.next_int(len(groups))]
                width, height, _tiles = group
                local_x, local_y = sx - block_x, sy - block_y
                if (local_x + width - 1 >= WORLDGEN_BLOCK_SIZE or
                        local_y + height - 1 >= WORLDGEN_BLOCK_SIZE):
                    return 'retry', None
                if width > 1 or height > 1:
                    for dx in range(width):
                        for dy in range(height):
                            if dx == 0 and dy == 0:
                                continue
                            if not _future_square_is_eligible(
                                    source.get((sx + dx, sy + dy), ()),
                                    placements, attached_floor_tiles):
                                return 'retry', None

                layout = _tile_group_layout(group)
                for (dx, dy), placed_token in layout.items():
                    pending[(sx + dx, sy + dy)] = placed_token

                token = pending.get((sx, sy))
                if token == '$any':
                    pending.pop((sx, sy), None)
                    if current_depth < 1:
                        return lookup(max_size, current_depth + 1)
                if token in ('$any', '$subbiome'):
                    return 'pending', token
                return 'success', token

            def set_tiles():
                for max_size in (8, 4, 2, 1):
                    result, token = lookup(max_size)
                    if result != 'retry':
                        return result, token
                return 'failure', None

            result, token = set_tiles()
            if result == 'pending' and allow_reapply:
                # genMapSquare immediately calls doPending and invokes
                # applyBiome one more time.  $any is cleared and retries the
                # map biome; $subbiome switches the TREE feature table while
                # continuing the already-consumed coordinate RNG.
                if token == '$any':
                    pending.pop((sx, sy), None)
                    result, token = set_tiles()
                elif token == '$subbiome':
                    subbiome = _BIOME_TREE_SUBBIOMES.get(pixel)
                    if subbiome is not None:
                        saved_features, saved_placements = (
                            all_features, placements)
                        all_features = (subbiome,)
                        placements = _SUBBIOME_TREE_PLACEMENTS
                        result, token = set_tiles()
                        all_features, placements = (
                            saved_features, saved_placements)

            if result == 'success':
                actions[(sx, sy)] = TreePlanAction(
                    True, token, True, False)
            elif result == 'delete':
                actions[(sx, sy)] = TreePlanAction(
                    True, None, True, True)
            # FAILURE or a second PENDING leaves the source object intact,
            # exactly as genMapSquare's result handling does.
            return result != 'failure'

        # generateChunks walks x first and y second over its 16x16 cache.
        for x in range(WORLDGEN_BLOCK_SIZE):
            for y in range(WORLDGEN_BLOCK_SIZE):
                sx, sy = block_x + x, block_y + y
                token = pending.get((sx, sy))
                if token and token not in ('$any',):
                    if token == '$subbiome':
                        if _has_source_tree(source[(sx, sy)]):
                            pixel = get_biome_pixel(
                                self.map_path, sx, sy, cell_size)
                            subbiome = _BIOME_TREE_SUBBIOMES.get(pixel)
                            if subbiome is not None:
                                select_at(
                                    sx, sy, (subbiome,),
                                    _SUBBIOME_TREE_PLACEMENTS,
                                    allow_reapply=False)
                    else:
                        actions[(sx, sy)] = TreePlanAction(
                            True, token, True, False)
                    continue

                if not _has_source_tree(source[(sx, sy)]):
                    continue
                # If all footprint sizes fail, setTiles returns FAILURE and
                # the source tree remains available to the palette renderer.
                select_at(sx, sy)

                token = pending.get((sx, sy))
                if (token and token not in ('$any', '$subbiome') and
                        (sx, sy) not in actions):
                    actions[(sx, sy)] = TreePlanAction(
                        True, token, True, False)

        return actions


def biome_tree_weights():
    """Return a copy for diagnostics and tests without exposing internals."""
    return dict(_BIOME_TREE_WEIGHTS)


def biome_tree_features():
    """Return immutable feature profiles for diagnostics and tests."""
    return dict(_BIOME_TREE_FEATURES)
