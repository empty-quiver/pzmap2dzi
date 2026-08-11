import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {deflateSync} from 'node:zlib';

const MIME = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8',
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({length: 256}, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) {
        value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
}

function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function syntheticTile(pathname, size = 256) {
    const seed = hashString(pathname);
    const rowBytes = 1 + size * 4;
    const raw = Buffer.alloc(rowBytes * size);
    const red = 38 + seed % 96;
    const green = 68 + (seed >>> 8) % 96;
    const blue = 42 + (seed >>> 16) % 96;
    for (let y = 0; y < size; y += 1) {
        const row = y * rowBytes;
        raw[row] = 0;
        for (let x = 0; x < size; x += 1) {
            const pixel = row + 1 + x * 4;
            const grid = x % 64 < 3 || y % 64 < 3;
            const diagonal = (x + y + (seed & 63)) % 97 < 4;
            raw[pixel] = grid ? 230 : diagonal ? 180 : red;
            raw[pixel + 1] = grid ? 230 : diagonal ? 190 : green;
            raw[pixel + 2] = grid ? 230 : diagonal ? 80 : blue;
            raw[pixel + 3] = 255;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const compressed = deflateSync(raw, {level: 6});
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', header),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function mapInfo() {
    return {
        pz_version: 'performance-fixture',
        pzmap2dzi_version: 'performance-fixture',
        git_branch: 'local',
        git_commit: 'deterministic',
        w: 16384,
        h: 8192,
        scale: 1,
        x0: 8192,
        y0: 0,
        sqr: 1,
        cell_rects: [[0, 0, 256, 128]],
        cell_size: 64,
        block_size: 16,
        minlayer: 0,
        maxlayer: 1,
    };
}

function fixturePois(count = 2200) {
    const pois = [];
    for (let index = 0; index < count; index += 1) {
        const column = index % 55;
        const row = Math.floor(index / 55);
        pois.push({
            ID: `perf-${index}`,
            name: `Fixture marker ${index}`,
            description: 'Deterministic performance fixture',
            x: 900 + column * 120 + index % 7,
            y: 800 + row * 120 + index % 11,
            location: 'fixture',
            tags: ['performance'],
        });
    }
    return pois;
}

function json(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`);
}

function safeStaticPath(root, pathname) {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    const candidate = join(root, relative || 'pzmap.html');
    return candidate.startsWith(root) ? candidate : null;
}

export async function startFixtureServer(options) {
    const webRoot = normalize(options.webRoot);
    const latencyMs = Number(options.latencyMs ?? 28);
    const jitterMs = Number(options.jitterMs ?? 9);
    const tileCache = new Map();
    const stats = {
        requests: 0,
        tileRequests: 0,
        tileBytes: 0,
        abortedResponses: 0,
        paths: new Map(),
    };
    const pois = json(fixturePois(options.poiCount));
    const baseInfo = json(mapInfo());
    const emptyInfo = json({skip: 0});
    const emptyMarks = json([]);

    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const pathname = url.pathname === '/' ? '/pzmap.html' : url.pathname;
        stats.requests += 1;
        stats.paths.set(pathname, (stats.paths.get(pathname) || 0) + 1);
        response.setHeader('Access-Control-Allow-Origin', '*');

        if (/^\/fixture\/map_data\/base\/layer0_files\/\d+\/\d+_\d+\.png$/.test(pathname)) {
            stats.tileRequests += 1;
            let body = tileCache.get(pathname);
            if (!body) {
                body = syntheticTile(pathname);
                tileCache.set(pathname, body);
            }
            const delay = latencyMs + (jitterMs > 0 ? hashString(pathname) % (jitterMs + 1) : 0);
            const timer = setTimeout(() => {
                if (response.destroyed) {
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': body.length,
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    ETag: `"fixture-${hashString(pathname).toString(16)}"`,
                });
                response.end(body);
                stats.tileBytes += body.length;
            }, delay);
            request.once('aborted', () => {
                clearTimeout(timer);
                stats.abortedResponses += 1;
            });
            return;
        }

        if (pathname === '/fixture/map_data/base/layer0.dzi') {
            const descriptor = '<?xml version="1.0" encoding="UTF-8"?>' +
                '<Image TileSize="256" Overlap="0" Format="png" ' +
                'xmlns="http://schemas.microsoft.com/deepzoom/2008">' +
                '<Size Width="16384" Height="8192"/></Image>\n';
            response.writeHead(200, {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            response.end(descriptor);
            return;
        }

        if (pathname === '/fixture/map_data/base/map_info.json') {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end(baseInfo);
            return;
        }
        if (pathname === '/fixture/map_data/base_top/map_info.json') {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end(baseInfo);
            return;
        }
        if (/^\/fixture\/map_data\/(zombie|foraging|rooms|objects)\/map_info\.json$/.test(pathname)) {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end(emptyInfo);
            return;
        }
        if (/^\/fixture\/map_data\/(base|zombie|foraging|rooms|objects|streets)\/marks\.json$/.test(pathname)) {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end(emptyMarks);
            return;
        }
        if (pathname === '/poi.json') {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end(pois);
            return;
        }
        if (pathname === '/sprite_lookup.json') {
            response.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'});
            response.end('{}\n');
            return;
        }

        const filename = safeStaticPath(webRoot, pathname);
        if (!filename) {
            response.writeHead(403);
            response.end('Forbidden');
            return;
        }
        try {
            const metadata = await stat(filename);
            if (!metadata.isFile()) {
                throw new Error('not a file');
            }
            const body = await readFile(filename);
            response.writeHead(200, {
                'Content-Type': MIME[extname(filename)] || 'application/octet-stream',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
            });
            response.end(body);
        } catch {
            response.writeHead(404, {'Content-Type': MIME['.txt']});
            response.end('Not found');
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        origin: `http://127.0.0.1:${address.port}`,
        stats,
        snapshot() {
            return {
                ...stats,
                paths: Object.fromEntries([...stats.paths.entries()].sort()),
            };
        },
        reset() {
            stats.requests = 0;
            stats.tileRequests = 0;
            stats.tileBytes = 0;
            stats.abortedResponses = 0;
            stats.paths.clear();
        },
        async close() {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
