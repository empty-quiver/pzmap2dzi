from PIL import ImageDraw
from .. import cell, erosion_trees, plants, texture, worldgen_trees
import re

try:
    from functools import lru_cache
except ImportError:
    from backports.functools_lru_cache import lru_cache


_GENERIC_TREE_PATTERN = re.compile(r'^vegetation_trees_01_(\d+)$')
_LEGACY_JUMBO_PATTERN = re.compile(r'^jumbo_tree_01_\d+$')

@lru_cache(maxsize=16)
def load_cell_cached(path, cx, cy):
    return cell.load_cell(path, cx, cy)

class TextureRender(object):
    def __init__(self, **options):
        texture_path = options.get('texture')
        cache_name = None
        if options.get('enable_cache'):
            cahce_name = options.get('cache_name')
        plants_conf = options.get('plants_conf', {})

        self.tl = texture.TextureLibrary(texture_path, cache_name)
        self.tl.config_plants(plants_conf)
        self.plants_conf = plants_conf


class BaseRender(TextureRender):
    def __init__(self, **options):
        self.input = options.get('input')
        TextureRender.__init__(self, **options)
        self.tree_selector = worldgen_trees.WorldGenTreeSelector(
            self.input, self.plants_conf)
        self.tree_planner = worldgen_trees.WorldGenTreePlanner(
            self.input, self.plants_conf)
        self.erosion_tree_selector = erosion_trees.ErosionTreeSelector(
            self.plants_conf)

    def update_options(self, options):
        """Expose plant sprite sizing to the DZI neighbour scheduler.

        TextureLibrary has always read jumbo_tree_size from plants_conf, while
        IsoDZI historically looked for it at the top level.  Build 42.20's
        direct XL/XXL tree sprites make that mismatch visible at tile edges.
        Copy only the sizing hint; keep the full plant configuration nested.
        """
        plants_conf = options.get('plants_conf', {})
        if 'jumbo_tree_size' not in options:
            options['jumbo_tree_size'] = plants_conf.get(
                'jumbo_tree_size', 3)
        return options

    def square(self, im_getter, dzi, ox, oy, sx, sy, layer):
        oy += dzi.sqr_height >> 1  # center -> bottom center
        cx, subx = divmod(sx, dzi.cell_size)
        cy, suby = divmod(sy, dzi.cell_size)
        c = load_cell_cached(self.input, cx, cy)
        if not c:
            return
        tiles = c.get_square(subx, suby, layer)
        if not tiles:
            return
        plan_action = None
        if layer == 0 and self.tree_planner.enabled:
            plan_action = self.tree_planner.action(
                sx, sy, dzi.cell_size, source_cell=c)
        for t in tiles:
            match = _GENERIC_TREE_PATTERN.match(t)
            source_tree = worldgen_trees.is_worldgen_tree_tile(t)
            if (plan_action and plan_action.suppress_ores and
                    worldgen_trees.is_worldgen_ore_tile(t)):
                continue
            if (plan_action and plan_action.suppress_competing and
                    (source_tree or
                     worldgen_trees.is_worldgen_bush_tile(t) or
                     worldgen_trees.is_worldgen_grass_like_tile(t))):
                continue
            if source_tree and plan_action and plan_action.suppress:
                continue
            if (match and self.tree_selector.enabled and
                    not self.tree_planner.enabled):
                legacy_index = (int(match.group(1)) %
                                worldgen_trees.TREE_TYPE_COUNT)
                tree_index = self.tree_selector.select(
                    sx, sy, dzi.cell_size, legacy_index)
                tex = self.tl.get_plant_tree(tree_index)
                if tex:
                    tex.render(im_getter.get(), ox, oy)
                else:
                    print('missing tile: {}'.format(t))
                continue
            if self.erosion_tree_selector.enabled:
                erosion_tree = None
                if match:
                    erosion_tree = self.erosion_tree_selector.select(
                        sx, sy, jumbo=False)
                elif _LEGACY_JUMBO_PATTERN.match(t):
                    erosion_tree = self.erosion_tree_selector.select(
                        sx, sy, jumbo=True)
                if erosion_tree is not None:
                    sprites = plants.get_worldgen_tree(
                        erosion_tree.sprite,
                        self.plants_conf.get('season', 'summer2'),
                        self.plants_conf.get('snow', False))
                    for sprite in sprites:
                        tex = self.tl.get_by_name(sprite)
                        if tex:
                            tex.render(im_getter.get(), ox, oy)
                        else:
                            print('missing erosion tile: {}'.format(sprite))
                    continue

            sprites = plants.get_worldgen_tree(
                t,
                self.plants_conf.get('season', 'summer2'),
                self.plants_conf.get('snow', False))
            for sprite in sprites:
                tex = self.tl.get_by_name(sprite)
                if tex:
                    tex.render(im_getter.get(), ox, oy)
                else:
                    print('missing tile: {}'.format(sprite))
        if plan_action and plan_action.sprite:
            sprites = plants.get_worldgen_tree(
                plan_action.sprite,
                self.plants_conf.get('season', 'summer2'),
                self.plants_conf.get('snow', False))
            for sprite in sprites:
                tex = self.tl.get_by_name(sprite)
                if tex:
                    tex.render(im_getter.get(), ox, oy)
                else:
                    print('missing worldgen tile: {}'.format(sprite))


def color_from_sums(color_sums):
    if color_sums:
        r, g, b, n = map(sum, zip(*color_sums))
        color = (r // n, g // n, b // n, 255)
        return color
    return None


def rc_base(tl, tiles, layer):
    base = next(iter(tiles), None)
    if base:
        tx = tl.get_by_name(base)
        if tx:
            return color_from_sums([tx.get_color_sum()])
    return None


_half_water = set([
    'blends_natural_02_1',
    'blends_natural_02_2',
    'blends_natural_02_3',
    'blends_natural_02_4',
])
def rc_base_water(tl, tiles, layer):
    color_sums = []
    for i, tile in enumerate(tiles):
        if i == 0 or tile in _half_water:
            tx = tl.get_by_name(tile)
            if tx:
                color_sum = tx.get_color_sum()
                if color_sum:
                    color_sums.append(color_sum)
            if i > 0:
                break
    return color_from_sums(color_sums)


def rc_avg(tl, tiles, layer):
    color_sums = []
    for tile in tiles:
        tx = tl.get_by_name(tile)
        if tx:
            color_sum = tx.get_color_sum()
            if color_sum:
                color_sums.append(color_sum)
    return color_from_sums(color_sums)


# carto-zed rule for layer 0
# begin position, end position, color, rule name, regex pattern
_cz_rules0 = [
    [0,    5, (218, 165,  32, 255),      'corn', re.compile('vegetation_farm')],
    [1, None, ( 38,  53,  22, 255),      'tree', re.compile('(_trees|jumbo)')],
    [0,    1, (132,  81,  76, 255),  'tilesand', re.compile('(floors_exterior_tilesandstone|floors_interior_carpet|floors_interior_tilesandwood)')],
    [1, None, ( 73,  58,  43, 255),     'rails', re.compile('_railroad')],
    [1, None, ( 48,  73,  32, 255), 'vegetaion', re.compile('^vegetation')],
    [1,  100, ( 93,  44,  39, 255),     'walls', re.compile('^walls')],
    [0,    1, (108, 127, 131, 255),     'water', re.compile('_natural_(.*_)*0*2_\\d+$')],
    [0,    1, (128, 128, 128, 255),    'street', re.compile('_street_')],
    [0,    1, (217, 207, 183, 255),      'sand', re.compile('_natural_(.*_)*0*1_0*([0-9]|1[0-5])$')],
    [0,    1, ( 75,  88,  27, 255), 'darkgrass', re.compile('_natural_(.*_)*0*1_0*(1[6-9]|2[0-9]|3[0-1])$')],
    [0,    1, ( 97, 103,  36, 255),  'medgrass', re.compile('_natural_(.*_)*0*1_0*(3[2-9]|4[0-7])$')],
    [0,    1, (127, 120,  45, 255), 'litegrass', re.compile('_natural_(.*_)*0*1_0*(4[8-9]|5[0-9]|6[0-3])$')],
    [0,    1, ( 91,  63,  21, 255),      'dirt', re.compile('_natural_(.*_)*0*1_0*(6[4-9]|7[0-9])$')],
    [0,    8, (132,  81,  76, 255),  'tilesand', re.compile('location_')],
]
# carto-zed rule for non layer 0
# begin position, end position, color, rule name, regex pattern
_cz_rules1 = [
    [1,  100, ( 93,  44,  39, 255),     'walls', re.compile('^walls')],
]
def rc_cartozed(tl, tiles, layer):
    tiles = list(tiles)
    rules = _cz_rules0 if layer == 0 else _cz_rules1
    for begin, end, color, rname, pattern in rules:
        if end is None or end > len(tiles):
            end = len(tiles)
        for i in range(begin, end):
            if pattern.search(tiles[i]):
                return color
    return None


class BaseTopRender(TextureRender):
    COLOR_FUNC = {
        'base': rc_base,
        'base+water': rc_base_water,
        'avg': rc_avg,
        'carto-zed': rc_cartozed,
    }

    def __init__(self, **options):
        mode = options.get('top_view_color_mode', 'base+water')
        self.color = BaseTopRender.COLOR_FUNC[mode]
        self.input = options.get('input')
        TextureRender.__init__(self, **options)

    def tile(self, im_getter, dzi, cx, cy, layer):
        c = cell.load_cell(self.input, cx, cy)
        if not c:
            return
        im = im_getter.get()
        draw = ImageDraw.Draw(im)
        box_size = dzi.square_size - 1
        for x in range(dzi.cell_size):
            for y in range(dzi.cell_size):
                tiles = c.get_square(x, y, layer)
                if not tiles:
                    continue
                color = self.color(self.tl, tiles, layer)
                px = x*dzi.square_size
                py = y*dzi.square_size
                box = [px, py, px + box_size, py + box_size]
                draw.rectangle(box, fill=color)
