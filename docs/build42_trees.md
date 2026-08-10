# Build 42 tree rendering

Build 42 resolves many map tree markers at runtime. A static renderer that
maps each marker directly to one species exposes cell-shaped forest patterns
and can clip the new XL and XXL sprites at tile boundaries.

This fork implements the corresponding static-render path for Build 42.20:

- biome-aware species selection from each cell's `biomemap` image;
- deterministic coordinate seeding compatible with Java's random generator;
- 2x2, 3x3, and 5x5 tree footprints;
- authored bush, grass, and boulder replacements used by tree biomes;
- erosion-based replacement of legacy normal and jumbo markers; and
- seasonal foliage for direct normal, JUMBO, XL, and XXL tree sprites.

## Configuration

The options live under `render_conf.plants_conf`:

```yaml
season: summer
jumbo_tree_size: 5
worldgen_tree_palette: true
worldgen_tree_footprints: true
erosion_tree_compat: true
worldgen_seed: ''
```

An empty seed matches a new single-player world. Set `worldgen_seed` when the
target world uses a specific seed. `unify_tree_type` remains an explicit
one-based override; zero leaves species selection enabled.

`worldgen_tree_palette` changes species while keeping one rendered tree per
source marker. `worldgen_tree_footprints` enables the full replacement planner
and supersedes palette-only rendering. `erosion_tree_compat` handles legacy
markers that use erosion rather than WorldGen biome replacement.

## Output compatibility

The renderer scans far enough outside each tile to include Build 42's largest
sprites, but keeps the legacy large-tree envelope for DZI origin and image
dimensions. Existing tile coordinates therefore remain stable.

The implementation reads the user's local Project Zomboid installation. No
game textures, maps, bytecode, or rendered tiles are distributed here.

Run the focused tests with:

```shell
python -m unittest test.test_compat_margins test.test_worldgen_trees
```
