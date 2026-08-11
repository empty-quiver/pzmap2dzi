import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';

import {viewerPerformanceOptions} from '../html/pzmap/globals.js';
import {configuredDziOptions, Map as PZMap} from '../html/pzmap/map.js';


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
    assert.match(
        html,
        /rel="modulepreload" href="\/_client\/client-r9\/pzmap\/globals\.js"/,
    );
    assert.match(
        html,
        /tile-existence-v1\.json\?release=map-r2" as="fetch" crossorigin fetchpriority="high"/,
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
