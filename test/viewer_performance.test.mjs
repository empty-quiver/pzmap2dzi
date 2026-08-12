import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';

import {viewerPerformanceOptions} from '../html/pzmap/globals.js';
import {g} from '../html/pzmap/globals.js';
import {
    configuredDziOptions,
    imageRectToTileRect,
    Map as PZMap,
    setManifestGate,
} from '../html/pzmap/map.js';


test('keeps a large OpenSeadragon cache on desktops', () => {
    assert.deepEqual(viewerPerformanceOptions({deviceMemory: 8}), {
        maxImageCacheCount: 400,
    });
    assert.deepEqual(viewerPerformanceOptions({}), {
        maxImageCacheCount: 400,
    });
});


test('reduces the OpenSeadragon cache on low-memory devices', () => {
    assert.deepEqual(viewerPerformanceOptions({deviceMemory: 1}), {
        maxImageCacheCount: 32,
    });
    assert.deepEqual(viewerPerformanceOptions({deviceMemory: 2}), {
        maxImageCacheCount: 32,
    });
    assert.deepEqual(viewerPerformanceOptions({deviceMemory: 4}), {
        maxImageCacheCount: 64,
    });
    assert.deepEqual(viewerPerformanceOptions({
        deviceMemory: 8,
        userAgentData: {mobile: true},
    }), {
        maxImageCacheCount: 64,
    });
    assert.deepEqual(viewerPerformanceOptions({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
    }), {
        maxImageCacheCount: 64,
    });
});


test('creates a DZI tile source from release config', () => {
    const config = {
        dzi_sources: {
            'base/layer0': {
                width: 2314432,
                height: 1019072,
                tile_size: 1024,
                tile_overlap: 0,
                file_format: 'jpg',
            },
        },
    };
    assert.deepEqual(
        configuredDziOptions(config, 'https://tiles.example/map_data/', 'base', '', 0),
        {
            width: 2314432,
            height: 1019072,
            tileSize: 1024,
            tileOverlap: 0,
            tilesUrl: 'https://tiles.example/map_data/base/layer0_files/',
            fileFormat: 'jpg',
        },
    );
    assert.equal(configuredDziOptions({}, '/map_data/', 'base', '', 0), null);
});


test('declares cumulative WebP alpha and uses the regular map geometry', () => {
    const previousWindow = globalThis.window;
    const previousViewer = g.viewer;
    const previousConf = g.conf;
    const additions = [];
    globalThis.window = {
        OpenSeadragon: {
            DziTileSource: class {
                constructor(options) {
                    Object.assign(this, options);
                }
            },
        },
    };
    g.conf = {
        cumulative_floor_root: 'https://cumulative.example/map_data/',
    };
    g.viewer = {
        addTiledImage: (options) => additions.push(options),
    };
    setManifestGate({
        cumulativeAvailable: () => true,
        resolveCumulativeTileUrl: () =>
            'https://cumulative.example/map_data/base_cumulative/layer3_files/20/1_2.webp',
        cumulativeTileUrl: () =>
            'https://cumulative.example/map_data/base_cumulative/layer3_files/20/1_2.webp',
    });
    try {
        const map = new PZMap('https://tiles.example/map_data/', 'iso', 'map');
        map.base_map = map;
        map.suffix = '';
        map.w = 2314432;
        map.h = 1019072;
        map.getRelativePositionAndWidth = () => [{x: 0.125, y: -0.25}, 0.75];

        const source = map._cumulativeTileSource(3);
        assert.equal(source.fileFormat, 'webp');
        assert.equal(source.hasTransparency(20, source.getTileUrl(20, 1, 2)), true);

        map._loadCumulativeTile(3);
        assert.equal(additions.length, 1);
        assert.equal(additions[0].x, 0.125);
        assert.equal(additions[0].y, -0.25);
        assert.equal(additions[0].width, 0.75);
        assert.equal(additions[0].tileSource.hasTransparency(), true);
    } finally {
        setManifestGate(null);
        g.viewer = previousViewer;
        g.conf = previousConf;
        globalThis.window = previousWindow;
    }
});


test('converts an expanded image viewport into a detailed occupancy query', () => {
    assert.deepEqual(
        imageRectToTileRect(
            {x: 16384, y: 8192, width: 8192, height: 4096},
            2314432,
            1019072,
            1024,
            2,
        ),
        {level: 20, minX: 4, minY: 2, maxX: 5, maxY: 2},
    );
    assert.equal(
        imageRectToTileRect({x: -100, y: -100, width: 50, height: 50}, 1000, 1000, 256),
        null,
    );
});


test('materializes viewport floors while preserving the explicitly selected floor', () => {
    const previousViewer = g.viewer;
    const previousRoofOpacity = g.roof_opacity;
    const map = new PZMap('https://tiles.example/map_data/', 'iso', 'map');
    map.base_map = map;
    map.suffix = '';
    map.minlayer = 0;
    map.maxlayer = 4;
    map.w = 2314432;
    map.h = 1019072;
    map.tiles = Array(4).fill(0);
    map.setTile(0, {
        source: {tileSize: 1024},
        viewportToImageRectangle: () => ({x: 16384, y: 8192, width: 8192, height: 4096}),
    });
    const loaded = [];
    const unloaded = [];
    map._load_tile = (layer) => loaded.push(layer);
    map._unload_tile = (layer) => unloaded.push(layer);
    g.viewer = {viewport: {getBounds: () => ({})}};
    g.roof_opacity = 0;
    setManifestGate({
        sourceIntersectsTileRect: (url) => url.endsWith('/layer2.dzi'),
    });
    try {
        map.setBaseLayer(3);
        assert.deepEqual(loaded, [0, 2, 3]);
        assert.deepEqual(unloaded, [1]);
    } finally {
        clearTimeout(map.viewport_layer_expiry_timer);
        clearTimeout(map.viewport_layer_refresh_timer);
        setManifestGate(null);
        g.viewer = previousViewer;
        g.roof_opacity = previousRoofOpacity;
    }
});


test('parks and reuses recent floor sources with a bounded LRU', () => {
    const previousViewer = g.viewer;
    const previousConf = g.conf;
    const map = new PZMap('https://tiles.example/map_data/', 'iso', 'map');
    map.base_map = map;
    map.suffix = '';
    map.minlayer = 0;
    map.maxlayer = 4;
    map.tiles = Array(4).fill(0);
    map.getRelativePositionAndWidth = () => [{x: 0, y: 0}, 1];
    const events = [];
    const item = (name) => ({
        setOpacity: (opacity) => events.push([name, 'opacity', opacity]),
        setPreload: (preload) => events.push([name, 'preload', preload]),
    });
    const floor1 = item('floor1');
    const floor2 = item('floor2');
    map.setTile(1, floor1);
    map.setTile(2, floor2);
    let additions = 0;
    g.viewer = {
        addTiledImage: () => { additions += 1; },
        world: {removeItem: (tile) => events.push(['removed', tile])},
    };
    g.conf = {performance: {floor_source_cache: 1}};
    try {
        map._unload_tile(1, true);
        map._unload_tile(2, true);
        assert.equal(map.getTile(1), 0);
        assert.equal(map.getTile(2), floor2);
        map._load_tile(2);
        assert.equal(additions, 0);
        assert.ok(events.some((event) =>
            event[0] === 'floor2' && event[1] === 'preload' && event[2] === true));
        assert.ok(events.some((event) =>
            event[0] === 'floor2' && event[1] === 'opacity' && event[2] === 1));
    } finally {
        g.viewer = previousViewer;
        g.conf = previousConf;
    }
});


test('reuses map metadata requests during availability and initialization', async () => {
    const previousWindow = globalThis.window;
    let requests = 0;
    globalThis.window = {
        fetch: async () => {
            requests += 1;
            return {
                ok: true,
                json: async () => ({w: 10, h: 20}),
            };
        },
    };
    try {
        const map = new PZMap('https://tiles.example/map_data/', 'iso', 'map');
        const [available, info] = await Promise.all([
            map.isTypeAvailable('iso'),
            map.getMapInfo('base', ''),
        ]);
        assert.equal(available, 'iso');
        assert.deepEqual(info, {w: 10, h: 20});
        assert.equal(requests, 1);
    } finally {
        globalThis.window = previousWindow;
    }
});


function runNode(args, cwd) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, args, {cwd, stdio: 'pipe'});
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) {
                resolvePromise();
            } else {
                reject(new Error(stderr || `build exited ${code}`));
            }
        });
    });
}


test('release build injects exact hints and emits minified assets', async () => {
    const repo = resolve(import.meta.dirname, '..');
    const temporary = await mkdtemp(join(tmpdir(), 'pzmap-viewer-test-'));
    const configFile = join(temporary, 'config.json');
    const output = join(temporary, 'viewer');
    const config = {
        route: {
            default: 'https://tiles.example/releases/map-r2/map_data/',
        },
        tile_existence_manifest: '/_client/client-r9/tile-existence-v1.json',
        cumulative_floor_manifest: '/_client/client-r9/cumulative-floor-v1.json',
        cumulative_floor_root: 'https://cumulative.example/releases/cumulative/map_data/',
        hot_tile_origin: 'https://hottiles.example',
    };
    await writeFile(configFile, `${JSON.stringify(config)}\n`);
    await runNode([
        'scripts/build_viewer.mjs',
        '--outdir', output,
        '--config', configFile,
        '--asset-base', '/_client/client-r9/',
    ], repo);

    const html = await readFile(join(output, 'pzmap.html'), 'utf8');
    assert.match(html, /rel="preconnect" href="https:\/\/tiles\.example"/);
    assert.match(html, /rel="preconnect" href="https:\/\/hottiles\.example"/);
    assert.match(html, /rel="preconnect" href="https:\/\/cumulative\.example"/);
    assert.match(
        html,
        /rel="modulepreload" href="\/_client\/client-r9\/pzmap\/globals\.js"/,
    );
    assert.match(
        html,
        /tile-existence-v1\.json\?release=map-r2" as="fetch" crossorigin fetchpriority="high"/,
    );
    assert.match(
        html,
        /cumulative-floor-v1\.json\?release=map-r2" as="fetch" crossorigin fetchpriority="high"/,
    );
    assert.match(html, /window\.FANMAP42_CONFIG=/);
    assert.match(html, /defer[^>]+\/_client\/client-r9\/pzmap\.js/);

    const osd = await stat(join(output, 'openseadragon', 'openseadragon.js'));
    const osdSource = await readFile(join(output, 'openseadragon', 'openseadragon.js'), 'utf8');
    const viewer = await stat(join(output, 'pzmap.js'));
    await stat(join(output, 'pzmap', 'i18n', 'en.json'));
    await stat(join(output, 'pzmap', 'i18n', 'mapping.json'));
    await stat(join(output, 'pzmap', 'i18n', 'marks_en.json'));
    assert.ok(osd.size < 350000, `OpenSeadragon remained ${osd.size} bytes`);
    assert.match(osdSource, /^\/\/! openseadragon 6\.0\.2/m);
    assert.match(osdSource, /unpackWithPremultipliedAlpha/);
    assert.ok(viewer.size < 50000, `pzmap.js remained ${viewer.size} bytes`);
});
