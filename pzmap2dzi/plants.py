
import re


_TREE_DEF = [
    # tree name, prefix, evergreen
    ('American Holly', 'e_americanholly', True),
    ('Canadian Hemlock', 'e_canadianhemlock', True),
    ('Virginia Pine', 'e_virginiapine', True),
    ('Riverbirch', 'e_riverbirch', False),
    ('Cockspur Hawthorn', 'e_cockspurhawthorn', False),
    ('Dogwood', 'e_dogwood', False),
    ('Carolina Silverbell', 'e_carolinasilverbell', False),
    ('Yellowwood', 'e_yellowwood', False),
    ('Eastern Redbud', 'e_easternredbud', False),
    ('Redmaple', 'e_redmaple', False),
    ('American Linden', 'e_americanlinden', False),
]

_TREE_EVERGREEN = dict((prefix, evergreen)
                       for _, prefix, evergreen in _TREE_DEF)
_DIRECT_TREE_PATTERN = re.compile(
    r'^(?P<prefix>e_[a-z0-9]+)'
    r'(?P<size>JUMBO(?:XL|XXL)?)_1_(?P<index>\d+)$')


def get_tree(prefix, season, snow, size, evergreen):
    is_jumbo = size >= 4
    idx = size % 4
    prefix += 'JUMBO_1_' if is_jumbo else '_1_'
    step = 2 if is_jumbo else 4
    if snow:
        textures = [prefix + str(idx + step)]
    else:
        textures = [prefix + str(idx)]
        if not evergreen:
            if season == 'spring':
                textures.append(prefix + str(idx + step * 2))
            if season == 'summer':
                textures.append(prefix + str(idx + step * 3))
            if season == 'summer2':
                textures.append(prefix + str(idx + step * 4))
            if season == 'autumn':
                textures.append(prefix + str(idx + step * 5))
    return textures


def get_worldgen_tree(sprite, season, snow=False):
    """Return the game-style composite for a direct JUMBO/XL/XXL tree.

    Build 42 stores a deciduous tree's trunk/bare crown in its base sprite and
    attaches a second sprite for the seasonal foliage.  WorldGen places the
    base name directly, so it bypasses ``PlantsInfo.mapping`` and must be
    expanded here.  XL and XXL sheets advance one index per season, while the
    older two-tile JUMBO sheet advances two (one for each base variant).
    """
    match = _DIRECT_TREE_PATTERN.match(sprite)
    if not match:
        return [sprite]

    prefix = match.group('prefix')
    evergreen = _TREE_EVERGREEN.get(prefix)
    if evergreen is None:
        return [sprite]

    size = match.group('size')
    index = int(match.group('index'))
    step = 2 if size == 'JUMBO' else 1
    if index not in ((0, 1) if size == 'JUMBO' else (0,)):
        return [sprite]

    sprite_prefix = '{}{}_1_'.format(prefix, size)
    if snow:
        return [sprite_prefix + str(index + step)]
    if evergreen:
        return [sprite]

    season_steps = {
        'spring': 2,
        'summer': 3,
        'summer2': 4,
        'autumn': 5,
    }
    season_step = season_steps.get(season)
    if season_step is None:
        return [sprite]
    return [sprite, sprite_prefix + str(index + step * season_step)]


class PlantsInfo(object):
    def __init__(self, conf):
        '''
            supported conf:

            season: one of ['spring', 'summer', 'summer2', 'autumn', 'winter']
            snow, flower, large_bush: True or False
            tree_size: one of [0, 1, 2, 3]
            jumbo_size: one of [0, 1, 2, 3, 4, 5]
            jumbo_type: index of tree (in _TREE_DEF) which is used to render jumbo tree

        '''

        # conf
        season     = conf.get(         'season', 'summer2')
        snow       = conf.get(           'snow', False)
        flower     = conf.get(         'flower', False)
        large_bush = conf.get(     'large_bush', False)
        tree_size  = conf.get(      'tree_size', 2)
        jumbo_size = conf.get('jumbo_tree_size', 3)
        jumbo_type = conf.get('jumbo_tree_type', 3)
        no_grass   = conf.get('no_ground_cover', False)
        unify_tree = conf.get('unify_tree_type', -1)

        self.mapping = {}
        # bushes
        _bush = 'f_bushes_1_{}'
        bush = []
        for i in range(16):
            textures = []
            trunk = i % 8
            offset1 = 0
            offset2 = 0
            if large_bush:
                offset1 = 8
                offset2 = 32
            if snow:
                textures = [_bush.format(trunk + offset1 + 16)]
            else:
                textures = [_bush.format(trunk + offset1)]
                if season == 'spring':
                    textures.append(_bush.format(trunk + offset1 + 32))
                if season in ['summer', 'summer2']:
                    textures.append(_bush.format(i + offset2 + 64))
                if season == 'autumn':
                    textures.append(_bush.format(trunk + offset1 + 48))
                if flower:
                    textures.append(_bush.format(i + offset2 + 80))
            bush.append(textures)

        for i in range(16):
            textures = [] if no_grass else bush[i]
            self.mapping['vegetation_foliage_01_{}'.format(i)] = textures

        # grass
        _grass = 'd_plants_1_{}'
        grass = []
        for i in range(24):
            textures = []
            offset = (i // 8) * 16 + 16
            imod8 = i % 8
            if season == 'spring':
                textures.append(_grass.format(imod8))
            if season in ['summer', 'summer2']:
                textures.append(_grass.format(offset + imod8))
            if season == 'autumn':
                textures.append(_grass.format(8 + imod8))
            if flower:
                textures.append(_grass.format(offset + 8 + imod8))
            grass.append(textures)

        # randomize map vegetation_groundcover_01_0 ~ _47
        for i in range(48):
            textures = [] if no_grass else grass[i % 24]
            self.mapping['vegetation_groundcover_01_{}'.format(i)] = textures

        # small tree
        tree = []
        tree_size = max(0, min(3, int(tree_size)))
        for _, prefix, evergreen in _TREE_DEF:
            tree.append(get_tree(prefix, season, snow, tree_size, evergreen))

        # Keep the per-species composites available to coordinate-aware
        # renderers.  The legacy mapping below is retained for configurations
        # that do not opt into Build 42's biome-aware palette.
        self.tree_types = tree

        # randomize map vegetation_trees_01_0 ~ _32
        for i in range(33):
            textures = tree[i % len(_TREE_DEF)]
            if unify_tree >= 0:
                textures = tree[unify_tree]
            self.mapping['vegetation_trees_01_{}'.format(i)] = textures

        # jumbo tree
        jumbo_size = max(tree_size, min(5, int(jumbo_size)))
        _, prefix, evergreen = _TREE_DEF[jumbo_type]
        if unify_tree >= 0:
            _, prefix, evergreen = _TREE_DEF[unify_tree]
        jumbo = get_tree(prefix, season, snow, jumbo_size, evergreen)
        self.mapping['jumbo_tree_01_0'] = jumbo
