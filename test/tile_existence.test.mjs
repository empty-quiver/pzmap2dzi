import assert from 'node:assert/strict';
import test from 'node:test';

import {
    hotTileFallbackUrl,
    manifestHasSource,
    manifestHasTile,
    releaseFromTileRoute,
    rewriteTileRelease,
    routingGenerationForTile,
    withBrowserCacheVariant,
} from '../html/pzmap/tile-existence.js';


const route = 'https://tiles.example/releases/map-r2/map_data/';
const tileSource = `${route}base/layer0_files`;


test('extracts the release from a versioned tile route', () => {
    assert.equal(releaseFromTileRoute(route), 'map-r2');
    assert.equal(releaseFromTileRoute('/map_data/'), null);
});


test('checks compact tile ranges and descriptors', () => {
    const manifest = {
        schema: 'fanmap42.tile-existence.v1',
        sources: {
            'base/layer0': {
                3: [[5, 10, 12, 20, 21]],
            },
        },
    };
    assert.equal(manifestHasTile(manifest, tileSource, 3, 11, 5), true);
    assert.equal(manifestHasTile(manifest, tileSource, 3, 13, 5), false);
    assert.equal(manifestHasTile(manifest, tileSource, 2, 11, 5), false);
    assert.equal(manifestHasSource(manifest, `${route}base/layer0.dzi`), true);
    assert.equal(manifestHasSource(manifest, `${route}base/layer1.dzi`), false);
});


test('routes override tiles to the selected generation', () => {
    const routing = {
        schema: 'fanmap42.tile-routing.v1',
        generations: [{id: 'treeblend', release: 'map-r3'}],
        sources: {
            'base/layer0': {
                3: [[5, 10, 12, 0]],
            },
        },
    };
    assert.deepEqual(
        routingGenerationForTile(routing, tileSource, 3, 11, 5),
        routing.generations[0],
    );
    assert.equal(routingGenerationForTile(routing, tileSource, 3, 13, 5), null);
    assert.equal(
        rewriteTileRelease(`${tileSource}/3/11_5.jpg`, 'map-r2', 'map-r3'),
        'https://tiles.example/releases/map-r3/map_data/base/layer0_files/3/11_5.jpg',
    );
});


test('falls back from hottiles to the direct origin without changing paths', () => {
    const hot = 'https://hottiles.example/releases/map-r2/map_data/base/layer0_files/3/11_5.jpg';
    assert.equal(
        hotTileFallbackUrl(hot, 'https://hottiles.example', 'https://tiles.example'),
        'https://tiles.example/releases/map-r2/map_data/base/layer0_files/3/11_5.jpg',
    );
});


test('isolates browser image caches by renderer without changing the tile path', () => {
    const tile = 'https://tiles.example/releases/map-r2/map_data/base/layer0_files/3/11_5.jpg';
    assert.equal(
        withBrowserCacheVariant(tile, 'webgl-osd6-premult-v1'),
        `${tile}?fanmap_renderer=webgl-osd6-premult-v1`,
    );
    assert.equal(
        withBrowserCacheVariant(`${tile}?existing=1`, 'webgl-osd6-premult-v1'),
        `${tile}?existing=1&fanmap_renderer=webgl-osd6-premult-v1`,
    );
    assert.equal(withBrowserCacheVariant(tile, null), tile);
});
