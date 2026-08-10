"""Build 42 erosion replacement for legacy map-tree placeholders.

The shipped map still contains ``jumbo_tree_01`` and
``vegetation_trees_01`` marker sprites.  They are not species.  On first
load, ``NatureTrees.replaceExistingObject`` chooses a species from the
chunk's erosion soil, chooses a growth stage from per-square erosion noise,
and then lets ``ErosionObj`` display the appropriate seasonal sprite.

Historically pzmap mapped every jumbo marker to one configured species.  A
large marker fill therefore became a conspicuous single-species rectangle.
This module mirrors the deterministic, new-single-player replacement path so
the static render follows the game instead of the marker sheet.
"""

import math
import struct
from collections import namedtuple

from .worldgen_trees import JavaRandom, java_string_hashcode


_PERM = (
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7,
    225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6,
    148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35,
    11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171,
    168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158,
    231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55,
    46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73,
    209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116,
    188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226,
    250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207,
    206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170,
    213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167,
    43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224,
    232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193,
    238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249,
    14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204,
    176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222,
    114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156,
    180,
)

_SOIL_TABLE = (
    (1, 1, 1, 1, 1, 4, 4, 4, 4, 4),
    (1, 1, 1, 1, 2, 5, 4, 4, 4, 4),
    (1, 1, 1, 2, 2, 5, 5, 4, 4, 4),
    (1, 1, 2, 2, 3, 6, 5, 5, 4, 4),
    (1, 2, 2, 3, 3, 6, 6, 5, 5, 4),
    (7, 8, 8, 9, 9, 12, 12, 11, 11, 10),
    (7, 7, 8, 8, 9, 12, 11, 11, 10, 10),
    (7, 7, 7, 8, 8, 11, 11, 10, 10, 10),
    (7, 7, 7, 7, 8, 11, 10, 10, 10, 10),
    (7, 7, 7, 7, 7, 10, 10, 10, 10, 10),
)

# NatureTrees.soilRef.  Values are one-based ErosionObj indices in the game.
_SOIL_SPECIES = (
    (2, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5),
    (1, 1, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5),
    (2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 3, 3, 4, 4, 4, 5),
    (1, 7, 7, 7, 9, 9, 9, 9, 9, 9, 9),
    (2, 2, 1, 1, 1, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9, 9, 9),
    (1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 7, 7, 7, 9),
    (1, 2, 8, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6),
    (1, 1, 2, 2, 3, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6, 6, 6, 6, 6),
    (1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 8, 8, 8, 6),
    (3, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11),
    (1, 1, 3, 3, 3, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11),
    (1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 10, 10, 10, 11),
)

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

ErosionTree = namedtuple(
    'ErosionTree', 'species stage soil noise_main sprite')


def _float32(value):
    return struct.unpack('>f', struct.pack('>f', value))[0]


def _add(a, b):
    return _float32(_float32(a) + _float32(b))


def _sub(a, b):
    return _float32(_float32(a) - _float32(b))


def _mul(a, b):
    return _float32(_float32(a) * _float32(b))


def _div(a, b):
    return _float32(_float32(a) / _float32(b))


class _Noise2D(object):
    """Float32-compatible port of ``zombie.erosion.utils.Noise2D``."""

    def __init__(self, layers):
        self.layers = []
        for seed, frequency, amplitude in layers:
            seed %= 256
            permutation = [0] * 512
            for index in range(256):
                shifted = (seed + index) % 256
                permutation[shifted] = _PERM[index]
                permutation[256 + shifted] = permutation[shifted]
            self.layers.append(
                (_float32(frequency), _float32(amplitude), permutation))

    @staticmethod
    def _fade(value):
        value = _float32(value)
        value2 = _mul(value, value)
        value3 = _mul(value2, value)
        inner = _sub(_mul(value, 6.0), 15.0)
        inner = _add(_mul(value, inner), 10.0)
        return _mul(value3, inner)

    @staticmethod
    def _lerp(value, start, end):
        return _add(start, _mul(value, _sub(end, start)))

    def _noise(self, original_x, original_y, permutation):
        original_x = _float32(original_x)
        original_y = _float32(original_y)
        x_wraps = math.floor(_div(original_x, 255.0))
        y_wraps = math.floor(_div(original_y, 255.0))
        x = math.floor(_sub(original_x, _mul(x_wraps, 255.0)))
        y = math.floor(_sub(original_y, _mul(y_wraps, 255.0)))
        floor_x = math.floor(original_x)
        floor_y = math.floor(original_y)
        fade_x = self._fade(_sub(original_x, floor_x))
        fade_y = self._fade(_sub(original_y, floor_y))
        aa = permutation[x] + y
        ab = permutation[x] + y + 1
        ba = permutation[x + 1] + y
        bb = permutation[x + 1] + y + 1
        low = self._lerp(
            fade_x, _PERM[permutation[aa]], _PERM[permutation[ba]])
        high = self._lerp(
            fade_x, _PERM[permutation[ab]], _PERM[permutation[bb]])
        return self._lerp(fade_y, low, high)

    def layered_noise(self, x, y):
        total = _float32(0.0)
        maximum = _float32(0.0)
        for frequency, amplitude, permutation in self.layers:
            maximum = _add(maximum, amplitude)
            sample = self._noise(
                _mul(x, frequency), _mul(y, frequency), permutation)
            total = _add(total, _mul(sample, amplitude))
        return _div(_div(total, maximum), 255.0)


_NOISE_MAIN = _Noise2D(((16, 0.5, 3.0), (32, 2.0, 5.0),
                        (64, 5.0, 8.0)))
_NOISE_MOISTURE = _Noise2D(((96, 2.0, 3.0), (128, 1.6, 5.0),
                            (144, 0.6, 8.0)))
_NOISE_MINERALS = _Noise2D(((196, 2.0, 3.0), (255, 1.6, 5.0),
                            (0, 0.6, 8.0)))


def _location_random(seed, sx, sy):
    """Mirror ``WorldGenParams.getRandom(x, y)`` used by RandLocation."""
    random = JavaRandom(seed)
    x_multiplier = random.next_long()
    y_multiplier = random.next_long()
    mixed = ((int(sx) * x_multiplier) ^
             (int(sy) * y_multiplier) ^ int(seed))
    random.set_seed(mixed)
    return random


def _erosion_inputs(sx, sy):
    noise_main = _NOISE_MAIN.layered_noise(
        _div(_float32(sx), 10.0), _div(_float32(sy), 10.0))
    chunk_x, chunk_y = int(sx) // 10, int(sy) // 10
    noise_x = _div(_float32(chunk_x), 5.0)
    noise_y = _div(_float32(chunk_y), 5.0)
    moisture = _NOISE_MOISTURE.layered_noise(noise_x, noise_y)
    minerals = _NOISE_MINERALS.layered_noise(noise_x, noise_y)
    moisture_index = math.floor(_mul(moisture, 10.0)) if moisture < 1 else 9
    mineral_index = math.floor(_mul(minerals, 10.0)) if minerals < 1 else 9
    moisture_index = max(0, min(9, moisture_index))
    mineral_index = max(0, min(9, mineral_index))
    soil = _SOIL_TABLE[moisture_index][mineral_index] - 1
    return noise_main, soil


class ErosionTreeSelector(object):
    """Resolve legacy normal/JUMBO markers as Build 42 does on first load."""

    DEFAULT_SEED = ''

    def __init__(self, conf=None):
        conf = conf or {}
        self.enabled = bool(conf.get('erosion_tree_compat', False))
        seed_string = conf.get('worldgen_seed', self.DEFAULT_SEED) or ''
        self.seed = java_string_hashcode(seed_string)
        self.unify_tree = int(conf.get('unify_tree_type', -1))

    def select(self, sx, sy, jumbo=False):
        if not self.enabled:
            return None
        noise_main, soil = _erosion_inputs(sx, sy)
        random = _location_random(self.seed, sx, sy)
        random.next_int(100)  # ErosionMain.initGridSquare's magicNum.
        species_choices = _SOIL_SPECIES[soil]
        species = species_choices[random.next_int(len(species_choices))] - 1
        if self.unify_tree >= 0:
            species = self.unify_tree
        noise_main_int = math.floor(_mul(noise_main, 100.0))
        stage = ((4 if jumbo else 2) +
                 math.floor(_float32(noise_main_int) / _float32(51.0)))
        prefix = _TREE_PREFIXES[species]
        if jumbo:
            sprite = '{}JUMBO_1_{}'.format(prefix, stage - 4)
        else:
            sprite = '{}_1_{}'.format(prefix, stage)
        return ErosionTree(species, stage, soil, noise_main, sprite)

