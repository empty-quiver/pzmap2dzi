const SCHEMA = 'fanmap42.tile-existence.v1';
const ASSET_SCHEMA = 'fanmap42.map-asset-existence.v1';
const ROUTING_SCHEMA = 'fanmap42.tile-routing.v1';
const CUMULATIVE_SCHEMA = 'fanmap42.cumulative-floors.v1';

let manifest = null;
let hotManifest = null;
let routingIndex = null;
let optionalAssetManifest = null;
let cumulativeManifest = null;
let originalTileExists = null;
let originalGetTileUrl = null;
let originalDownloadTileStart = null;
let hotTileOrigin = null;
let directTileOrigin = null;
let browserTileCacheVariant = null;
let suppressionLogged = false;
const stats = {
    status: 'idle',
    lookups: 0,
    allowed: 0,
    suppressed: 0,
    unknownPassedThrough: 0,
    originalRejected: 0,
    hotTileRouted: 0,
    hotFallbackAttempts: 0,
    hotFallbackSucceeded: 0,
    hotFallbackFailed: 0,
    overrideTileRouted: 0,
    descriptorSuppressed: 0,
    optionalAssetSuppressed: 0,
    viewportLookups: 0,
    viewportRelevant: 0,
    viewportSuppressed: 0,
    hotManifestStatus: 'idle',
    routingIndexStatus: 'idle',
    cumulativeManifestStatus: 'idle',
    cumulativeLookups: 0,
    cumulativeHits: 0,
};

function reportState(state) {
    Object.assign(stats, state);
    if (typeof window !== 'undefined') {
        window.fanmapTileManifestStats = stats;
    }
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.fanmapTileManifest = JSON.stringify(stats);
    }
}

export function releaseFromTileRoute(route) {
    if (typeof route !== 'string') {
        return null;
    }
    const match = route.match(/\/releases\/([^/]+)\/map_data\/?(?:[?#].*)?$/);
    return match ? decodeURIComponent(match[1]) : null;
}

export function versionedManifestUrl(url, release) {
    if (typeof url !== 'string' || url === '') {
        return url;
    }
    if (typeof release !== 'string' || release === '') {
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}release=${encodeURIComponent(release)}`;
}

export function rewriteTileUrl(url, origin, eligible) {
    if (typeof url !== 'string' || typeof origin !== 'string' || origin === '' || eligible !== true) {
        return url;
    }
    try {
        const base = typeof location === 'undefined' ? 'https://fanmap42.com/' : location.href;
        const rewritten = new URL(url, base);
        const replacement = new URL(origin);
        rewritten.protocol = replacement.protocol;
        rewritten.host = replacement.host;
        return rewritten.href;
    } catch {
        return url;
    }
}

export function withBrowserCacheVariant(url, variant) {
    if (typeof url !== 'string' || typeof variant !== 'string' || variant === '') {
        return url;
    }
    try {
        const base = typeof location === 'undefined' ? 'https://fanmap42.com/' : location.href;
        const rewritten = new URL(url, base);
        rewritten.searchParams.set('fanmap_renderer', variant);
        return rewritten.href;
    } catch {
        return url;
    }
}

export function setBrowserTileCacheVariant(variant) {
    browserTileCacheVariant = typeof variant === 'string' && variant !== '' ? variant : null;
    reportState({browserTileCacheVariant});
}

export function hotTileFallbackUrl(url, hotOrigin, directOrigin) {
    if (typeof url !== 'string' || typeof hotOrigin !== 'string' || hotOrigin === '' ||
        typeof directOrigin !== 'string' || directOrigin === '') {
        return null;
    }
    try {
        const base = typeof location === 'undefined' ? 'https://fanmap42.com/' : location.href;
        const candidate = new URL(url, base);
        const hot = new URL(hotOrigin, base);
        const direct = new URL(directOrigin, base);
        if (candidate.origin !== hot.origin || !['http:', 'https:'].includes(direct.protocol)) {
            return null;
        }
        candidate.protocol = direct.protocol;
        candidate.host = direct.host;
        return candidate.href;
    } catch {
        return null;
    }
}

export function rewriteTileRelease(url, baseRelease, targetRelease) {
    if (typeof url !== 'string' || typeof baseRelease !== 'string' ||
        typeof targetRelease !== 'string' || baseRelease === '' || targetRelease === '') {
        return url;
    }
    try {
        const base = typeof location === 'undefined' ? 'https://fanmap42.com/' : location.href;
        const rewritten = new URL(url, base);
        const source = `/releases/${baseRelease}/map_data/`;
        const target = `/releases/${targetRelease}/map_data/`;
        if (!rewritten.pathname.startsWith(source)) {
            return url;
        }
        rewritten.pathname = `${target}${rewritten.pathname.slice(source.length)}`;
        return rewritten.href;
    } catch {
        return url;
    }
}

function pathAfterMapData(url) {
    if (typeof url !== 'string') {
        return null;
    }
    const withoutQuery = url.split(/[?#]/, 1)[0].replace(/\/+$/, '');
    const match = withoutQuery.match(/(?:^|\/)map_data\/(.+)$/);
    return match ? match[1] : null;
}

function sourceKey(tilesUrl) {
    const mapPath = pathAfterMapData(tilesUrl);
    if (!mapPath) {
        return null;
    }
    const match = mapPath.match(/^(.+\/layer-?\d+)_files$/);
    if (!match) {
        return null;
    }
    return match[1];
}

function descriptorSourceKey(url) {
    const mapPath = pathAfterMapData(url);
    const match = mapPath?.match(/^(.+\/layer-?\d+)\.dzi$/);
    return match ? match[1] : null;
}

function findRow(rows, y) {
    let low = 0;
    let high = rows.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const rowY = rows[middle][0];
        if (rowY === y) {
            return rows[middle];
        }
        if (rowY < y) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return null;
}

function lowerBoundRow(rows, y) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (rows[middle][0] < y) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function rowHasX(row, x) {
    if (!row) {
        return false;
    }
    for (let index = 1; index < row.length; index += 2) {
        if (x < row[index]) {
            return false;
        }
        if (x <= row[index + 1]) {
            return true;
        }
    }
    return false;
}

function coverageAt(rows, x, y) {
    const row = rows ? findRow(rows, y) : null;
    if (!row) {
        return 0;
    }
    for (let index = 1; index < row.length; index += 2) {
        if (row[index] === x) {
            return row[index + 1];
        }
        if (row[index] > x) {
            break;
        }
    }
    return 0;
}

function intervalsIntersect(rows, minX, minY, maxX, maxY) {
    if (!rows) {
        return false;
    }
    for (let rowIndex = lowerBoundRow(rows, minY);
        rowIndex < rows.length && rows[rowIndex][0] <= maxY;
        rowIndex += 1) {
        const row = rows[rowIndex];
        for (let intervalIndex = 1; intervalIndex < row.length; intervalIndex += 2) {
            if (row[intervalIndex] > maxX) {
                break;
            }
            if (row[intervalIndex + 1] >= minX) {
                return true;
            }
        }
    }
    return false;
}

function sumCoverage(rows, minX, minY, maxX, maxY) {
    if (!rows) {
        return 0;
    }
    let total = 0;
    for (let rowIndex = lowerBoundRow(rows, minY);
        rowIndex < rows.length && rows[rowIndex][0] <= maxY;
        rowIndex += 1) {
        const row = rows[rowIndex];
        for (let index = 1; index < row.length; index += 2) {
            const x = row[index];
            if (x > maxX) {
                break;
            }
            if (x >= minX) {
                total += row[index + 1];
            }
        }
    }
    return total;
}

function cumulativeFamily(tileManifest, family) {
    if (!tileManifest || tileManifest.schema !== CUMULATIVE_SCHEMA ||
        !tileManifest.families || typeof family !== 'string') {
        return null;
    }
    return tileManifest.families[family] ?? null;
}

export function cumulativeTileFloor(tileManifest, family, viewFloor, level, x, y) {
    const entry = cumulativeFamily(tileManifest, family);
    if (!entry || ![viewFloor, level, x, y].every(Number.isInteger) || viewFloor < 1) {
        return null;
    }
    const maximum = Math.min(viewFloor, Number(entry.max_floor) || viewFloor);
    for (let floor = maximum; floor >= (Number(entry.min_floor) || 1); floor -= 1) {
        const rows = entry.changes?.[String(floor)]?.[String(level)];
        if (rowHasX(rows ? findRow(rows, y) : null, x)) {
            return floor;
        }
    }
    return null;
}

export function cumulativeTileCoverage(tileManifest, family, floor, level, x, y) {
    const entry = cumulativeFamily(tileManifest, family);
    if (!entry || ![floor, level, x, y].every(Number.isInteger)) {
        return null;
    }
    return coverageAt(entry.coverage?.[String(floor)]?.[String(level)], x, y);
}

export function cumulativeTileObjectUrl(tileManifest, root, family, viewFloor, level, x, y) {
    const entry = cumulativeFamily(tileManifest, family);
    const floor = cumulativeTileFloor(tileManifest, family, viewFloor, level, x, y);
    if (!entry || floor === null || typeof root !== 'string' || root === '') {
        return null;
    }
    const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
    return `${normalizedRoot}${entry.output_source}/layer${floor}_files/${level}/${x}_${y}.webp`;
}

export function cumulativeManifestIntersectsTileRect(
    tileManifest,
    family,
    viewFloor,
    level,
    minX,
    minY,
    maxX,
    maxY,
) {
    const entry = cumulativeFamily(tileManifest, family);
    if (!entry || ![viewFloor, level, minX, minY, maxX, maxY].every(Number.isInteger) ||
        viewFloor < 1 || maxX < minX || maxY < minY) {
        return null;
    }
    const maximum = Math.min(viewFloor, Number(entry.max_floor) || viewFloor);
    for (let floor = Number(entry.min_floor) || 1; floor <= maximum; floor += 1) {
        if (intervalsIntersect(
            entry.changes?.[String(floor)]?.[String(level)],
            minX,
            minY,
            maxX,
            maxY,
        )) {
            return true;
        }
    }
    return false;
}

export function cumulativeDeltaCoverageInTileRect(
    tileManifest,
    family,
    floor,
    level,
    minX,
    minY,
    maxX,
    maxY,
) {
    const entry = cumulativeFamily(tileManifest, family);
    if (!entry || ![floor, level, minX, minY, maxX, maxY].every(Number.isInteger) ||
        maxX < minX || maxY < minY) {
        return null;
    }
    return sumCoverage(
        entry.delta_coverage?.[String(floor)]?.[String(level)],
        minX,
        minY,
        maxX,
        maxY,
    );
}

function manifestSourceKey(url) {
    return sourceKey(url) || descriptorSourceKey(url);
}

export function manifestIntersectsTileRect(
    tileManifest,
    sourceUrl,
    level,
    minX,
    minY,
    maxX,
    maxY,
) {
    if (!tileManifest || tileManifest.schema !== SCHEMA || !tileManifest.sources) {
        return null;
    }
    const key = manifestSourceKey(sourceUrl);
    if (!key || !Object.prototype.hasOwnProperty.call(tileManifest.sources, key)) {
        return null;
    }
    if (![level, minX, minY, maxX, maxY].every(Number.isInteger) ||
        level < 0 || minX < 0 || minY < 0 || maxX < minX || maxY < minY) {
        return null;
    }
    const rows = tileManifest.sources[key][String(level)];
    if (!rows) {
        return false;
    }
    for (let rowIndex = lowerBoundRow(rows, minY);
        rowIndex < rows.length && rows[rowIndex][0] <= maxY;
        rowIndex += 1) {
        const row = rows[rowIndex];
        for (let intervalIndex = 1; intervalIndex < row.length; intervalIndex += 2) {
            const start = row[intervalIndex];
            const end = row[intervalIndex + 1];
            if (start > maxX) {
                break;
            }
            if (end >= minX) {
                return true;
            }
        }
    }
    return false;
}

export function manifestHasTile(tileManifest, tilesUrl, level, x, y) {
    if (!tileManifest || tileManifest.schema !== SCHEMA || !tileManifest.sources) {
        return null;
    }
    const key = sourceKey(tilesUrl);
    if (!key || !Object.prototype.hasOwnProperty.call(tileManifest.sources, key)) {
        return null;
    }
    const rows = tileManifest.sources[key][String(level)];
    if (!rows) {
        return false;
    }
    const row = findRow(rows, y);
    if (!row) {
        return false;
    }
    for (let i = 1; i < row.length; i += 2) {
        if (x < row[i]) {
            return false;
        }
        if (x <= row[i + 1]) {
            return true;
        }
    }
    return false;
}

export function routingGenerationForTile(tileRoutingIndex, tilesUrl, level, x, y) {
    if (!tileRoutingIndex || tileRoutingIndex.schema !== ROUTING_SCHEMA ||
        !Array.isArray(tileRoutingIndex.generations) || !tileRoutingIndex.sources) {
        return null;
    }
    const key = sourceKey(tilesUrl);
    const rows = key ? tileRoutingIndex.sources[key]?.[String(level)] : null;
    if (!rows) {
        return null;
    }
    const row = findRow(rows, y);
    if (!row) {
        return null;
    }
    for (let i = 1; i < row.length; i += 3) {
        if (x < row[i]) {
            return null;
        }
        if (x <= row[i + 1]) {
            const generation = tileRoutingIndex.generations[row[i + 2]];
            return generation && typeof generation.release === 'string' ? generation : null;
        }
    }
    return null;
}

export function manifestHasSource(tileManifest, descriptorUrl) {
    if (!tileManifest || tileManifest.schema !== SCHEMA || !tileManifest.sources) {
        return null;
    }
    const key = descriptorSourceKey(descriptorUrl);
    if (!key) {
        return null;
    }
    return Object.prototype.hasOwnProperty.call(tileManifest.sources, key);
}

export function manifestHasOptionalAsset(tileManifest, assetUrl) {
    if (!tileManifest || ![SCHEMA, ASSET_SCHEMA].includes(tileManifest.schema) ||
        !tileManifest.asset_groups) {
        return null;
    }
    const mapPath = pathAfterMapData(assetUrl);
    const match = mapPath?.match(/^([^/]+)\/marks\.json$/);
    const markTypes = tileManifest.asset_groups.marks;
    if (!match || !Array.isArray(markTypes)) {
        return null;
    }
    return markTypes.includes(match[1]);
}

function suppressKnownMissing(kind, url) {
    const counter = kind === 'descriptor' ? 'descriptorSuppressed' : 'optionalAssetSuppressed';
    stats[counter] += 1;
    reportState({status: 'suppressing', suppressedKind: kind, suppressedUrl: url});
}

export function sourceAvailable(descriptorUrl) {
    const exists = manifestHasSource(manifest, descriptorUrl);
    if (exists === false) {
        suppressKnownMissing('descriptor', descriptorUrl);
    }
    return exists === null ? true : exists;
}

export function sourceIntersectsTileRect(descriptorUrl, tileRect) {
    stats.viewportLookups += 1;
    const intersects = manifestIntersectsTileRect(
        manifest,
        descriptorUrl,
        tileRect?.level,
        tileRect?.minX,
        tileRect?.minY,
        tileRect?.maxX,
        tileRect?.maxY,
    );
    if (intersects === true) {
        stats.viewportRelevant += 1;
    } else if (intersects === false) {
        stats.viewportSuppressed += 1;
    }
    return intersects;
}

function descriptorFamilyAndFloor(descriptorUrl) {
    const key = descriptorSourceKey(descriptorUrl);
    const match = key?.match(/^(base(?:_top)?)\/layer(\d+)$/);
    return match ? {family: match[1], floor: Number(match[2])} : null;
}

export function cumulativeAvailable(family) {
    return cumulativeFamily(cumulativeManifest, family) !== null;
}

export function cumulativeTileExists(family, viewFloor, level, x, y) {
    stats.cumulativeLookups += 1;
    const exists = cumulativeTileFloor(cumulativeManifest, family, viewFloor, level, x, y) !== null;
    if (exists) {
        stats.cumulativeHits += 1;
    }
    return exists;
}

export function cumulativeTileUrl(root, family, viewFloor, level, x, y) {
    return withBrowserCacheVariant(
        cumulativeTileObjectUrl(cumulativeManifest, root, family, viewFloor, level, x, y),
        browserTileCacheVariant,
    );
}

export function cumulativeSourceIntersectsTileRect(family, viewFloor, tileRect) {
    return cumulativeManifestIntersectsTileRect(
        cumulativeManifest,
        family,
        viewFloor,
        tileRect?.level,
        tileRect?.minX,
        tileRect?.minY,
        tileRect?.maxX,
        tileRect?.maxY,
    );
}

export function sourceCoverageInTileRect(descriptorUrl, tileRect) {
    const source = descriptorFamilyAndFloor(descriptorUrl);
    if (!source) {
        return null;
    }
    return cumulativeDeltaCoverageInTileRect(
        cumulativeManifest,
        source.family,
        source.floor,
        tileRect?.level,
        tileRect?.minX,
        tileRect?.minY,
        tileRect?.maxX,
        tileRect?.maxY,
    );
}

export function optionalAssetAvailable(assetUrl) {
    const exists = manifestHasOptionalAsset(optionalAssetManifest ?? manifest, assetUrl);
    if (exists === false) {
        suppressKnownMissing('optional_asset', assetUrl);
    }
    return exists === null ? true : exists;
}

function install(OpenSeadragon) {
    if (originalTileExists || !OpenSeadragon || !OpenSeadragon.DziTileSource) {
        return;
    }
    const prototype = OpenSeadragon.DziTileSource.prototype;
    originalTileExists = prototype.tileExists;
    if (typeof prototype.getTileUrl === 'function') {
        originalGetTileUrl = prototype.getTileUrl;
        prototype.getTileUrl = function(level, x, y) {
            const original = originalGetTileUrl.call(this, level, x, y);
            const generation = routingGenerationForTile(routingIndex, this.tilesUrl, level, x, y);
            const releaseRouted = generation
                ? rewriteTileRelease(original, routingIndex.base_release, generation.release)
                : original;
            if (releaseRouted !== original) {
                stats.overrideTileRouted += 1;
            }
            const eligible = manifestHasTile(hotManifest, this.tilesUrl, level, x, y) === true;
            const rewritten = rewriteTileUrl(releaseRouted, hotTileOrigin, eligible);
            if (rewritten !== releaseRouted) {
                stats.hotTileRouted += 1;
            }
            return withBrowserCacheVariant(rewritten, browserTileCacheVariant);
        };
    }
    if (typeof prototype.downloadTileStart === 'function') {
        originalDownloadTileStart = prototype.downloadTileStart;
        prototype.downloadTileStart = function(context) {
            const fallbackUrl = hotTileFallbackUrl(context?.src, hotTileOrigin, directTileOrigin);
            if (!fallbackUrl || (context.postData !== null && context.postData !== undefined) ||
                typeof context.finish !== 'function') {
                return originalDownloadTileStart.call(this, context);
            }

            const source = this;
            const finalFinish = context.finish.bind(context);
            let fallbackAttempted = false;
            context.finish = function(data, request, errorMessage) {
                const timedOut = typeof errorMessage === 'string' &&
                    errorMessage.startsWith('Image load exceeded timeout');
                if (data || fallbackAttempted || timedOut) {
                    context.finish = finalFinish;
                    if (fallbackAttempted) {
                        if (data) {
                            stats.hotFallbackSucceeded += 1;
                        } else {
                            stats.hotFallbackFailed += 1;
                        }
                        reportState({status: data ? 'hot_fallback_succeeded' : 'hot_fallback_failed'});
                    }
                    return finalFinish(data, request, errorMessage);
                }

                fallbackAttempted = true;
                stats.hotFallbackAttempts += 1;
                reportState({
                    status: 'hot_fallback_attempted',
                    hotFallbackSource: context.src,
                    hotFallbackTarget: fallbackUrl,
                });
                context.src = fallbackUrl;
                context.userData = {};
                return originalDownloadTileStart.call(source, context);
            };
            return originalDownloadTileStart.call(source, context);
        };
    }
    prototype.tileExists = function(level, x, y) {
        stats.lookups += 1;
        if (!originalTileExists.call(this, level, x, y)) {
            stats.originalRejected += 1;
            return false;
        }
        const exists = manifestHasTile(manifest, this.tilesUrl, level, x, y);
        if (exists === false) {
            stats.suppressed += 1;
        } else if (exists === null) {
            stats.unknownPassedThrough += 1;
        } else {
            stats.allowed += 1;
        }
        if (exists === false && !suppressionLogged) {
            suppressionLogged = true;
            const detail = {
                source: sourceKey(this.tilesUrl),
                level,
                x,
                y,
            };
            reportState({status: 'suppressing', ...detail});
            console.log('Tile-existence manifest suppressed a missing tile request.', detail);
        }
        return exists === null ? true : exists;
    };
}

export async function init(options = {}) {
    const OpenSeadragon = options.OpenSeadragon || window.OpenSeadragon;
    hotTileOrigin = typeof options.hotTileOrigin === 'string' ? options.hotTileOrigin : null;
    directTileOrigin = typeof options.directTileOrigin === 'string' ? options.directTileOrigin : null;
    install(OpenSeadragon);
    if (!options.url) {
        reportState({status: 'disabled', reason: 'no_manifest_url'});
        return {enabled: false, reason: 'no_manifest_url'};
    }
    const expectedRelease = options.expectedRelease || null;
    reportState({
        status: 'loading',
        expectedRelease,
        hotManifestStatus: 'loading',
        routingIndexStatus: 'loading',
        cumulativeManifestStatus: options.cumulativeManifestUrl ? 'loading' : 'disabled',
    });

    async function loadManifest(url, label) {
        const response = await fetch(versionedManifestUrl(url, expectedRelease), {
            cache: 'force-cache',
            credentials: 'same-origin',
        });
        if (!response.ok) {
            throw new Error(`${label} HTTP ${response.status}`);
        }
        const candidate = await response.json();
        if (candidate.schema !== SCHEMA || !candidate.sources) {
            throw new Error(`unsupported ${label} schema`);
        }
        if (expectedRelease && candidate.release !== expectedRelease) {
            throw new Error(
                `${label} release ${candidate.release} does not match ${expectedRelease}`,
            );
        }
        return candidate;
    }

    const hotPromise = options.hotManifestUrl
        ? loadManifest(options.hotManifestUrl, 'hot-tile manifest')
        : Promise.resolve(null);
    const routingPromise = options.routingIndexUrl
        ? (async () => {
            const response = await fetch(versionedManifestUrl(options.routingIndexUrl, expectedRelease), {
                cache: 'force-cache',
                credentials: 'same-origin',
            });
            if (!response.ok) {
                throw new Error(`tile-routing index HTTP ${response.status}`);
            }
            const candidate = await response.json();
            if (candidate.schema !== ROUTING_SCHEMA || !candidate.sources ||
                !Array.isArray(candidate.generations)) {
                throw new Error('unsupported tile-routing index schema');
            }
            if (expectedRelease && candidate.base_release !== expectedRelease) {
                throw new Error(
                    `tile-routing base release ${candidate.base_release} does not match ${expectedRelease}`,
                );
            }
            for (const generation of candidate.generations) {
                if (!generation || typeof generation.id !== 'string' ||
                    typeof generation.release !== 'string' ||
                    !/^[a-z0-9][a-z0-9._-]+$/.test(generation.release)) {
                    throw new Error('tile-routing index contains an invalid generation');
                }
            }
            return candidate;
        })()
        : Promise.resolve(null);
    const assetPromise = options.assetManifestUrl
        ? (async () => {
            const response = await fetch(versionedManifestUrl(options.assetManifestUrl, expectedRelease), {
                cache: 'force-cache',
                credentials: 'same-origin',
            });
            if (!response.ok) {
                throw new Error(`map-asset manifest HTTP ${response.status}`);
            }
            const candidate = await response.json();
            if (candidate.schema !== ASSET_SCHEMA || !candidate.asset_groups) {
                throw new Error('unsupported map-asset manifest schema');
            }
            if (expectedRelease && candidate.release !== expectedRelease) {
                throw new Error(
                    `map-asset manifest release ${candidate.release} does not match ${expectedRelease}`,
                );
            }
            return candidate;
        })()
        : Promise.resolve(null);
    const cumulativePromise = options.cumulativeManifestUrl
        ? (async () => {
            const response = await fetch(
                versionedManifestUrl(options.cumulativeManifestUrl, expectedRelease),
                {cache: 'force-cache', credentials: 'same-origin'},
            );
            if (!response.ok) {
                throw new Error(`cumulative-floor manifest HTTP ${response.status}`);
            }
            const candidate = await response.json();
            if (candidate.schema !== CUMULATIVE_SCHEMA || !candidate.families) {
                throw new Error('unsupported cumulative-floor manifest schema');
            }
            if (expectedRelease && candidate.base_release !== expectedRelease) {
                throw new Error(
                    `cumulative-floor base release ${candidate.base_release} does not match ${expectedRelease}`,
                );
            }
            return candidate;
        })()
        : Promise.resolve(null);

    let mainError = null;
    try {
        manifest = await loadManifest(options.url, 'tile manifest');
    } catch (error) {
        mainError = error;
        manifest = null;
    }

    let hotError = null;
    try {
        hotManifest = await hotPromise;
    } catch (error) {
        hotError = error;
        hotManifest = null;
        console.warn('Hot-tile manifest unavailable; keeping tiles on the direct CDN.', error);
    }

    let routingError = null;
    try {
        routingIndex = await routingPromise;
    } catch (error) {
        routingError = error;
        routingIndex = null;
        console.warn('Tile-routing index unavailable; keeping tiles on the base release.', error);
    }

    let assetError = null;
    try {
        optionalAssetManifest = await assetPromise;
    } catch (error) {
        assetError = error;
        optionalAssetManifest = null;
        console.warn('Map-asset manifest unavailable; keeping optional metadata requests.', error);
    }

    let cumulativeError = null;
    try {
        cumulativeManifest = await cumulativePromise;
    } catch (error) {
        cumulativeError = error;
        cumulativeManifest = null;
        console.warn(
            'Cumulative-floor manifest unavailable; keeping the existing per-floor sources.',
            error,
        );
    }

    if (mainError === null) {
        const candidate = manifest;
        const state = {
            status: 'loaded',
            release: candidate.release,
            expectedRelease,
            tileCount: candidate.tile_count,
            sourceCount: candidate.source_count,
            markTypes: candidate.asset_groups?.marks ?? null,
            assetManifestStatus: optionalAssetManifest
                ? 'loaded'
                : (assetError ? 'unavailable' : 'disabled'),
            assetMarkTypes: optionalAssetManifest?.asset_groups?.marks ?? null,
            hotManifestStatus: hotManifest ? 'loaded' : (hotError ? 'unavailable' : 'disabled'),
            hotTileCount: hotManifest?.tile_count ?? 0,
            routingIndexStatus: routingIndex
                ? 'loaded'
                : (routingError ? 'unavailable' : 'disabled'),
            overrideTileCount: routingIndex?.override_count ?? 0,
            overrideGenerationCount: routingIndex?.generations?.length ?? 0,
            cumulativeManifestStatus: cumulativeManifest
                ? 'loaded'
                : (cumulativeError ? 'unavailable' : 'disabled'),
            cumulativeRelease: cumulativeManifest?.release ?? null,
            cumulativeTileCount: cumulativeManifest?.tile_count ?? 0,
        };
        reportState(state);
        console.log('Tile-existence manifest loaded.', state);
        return {
            enabled: true,
            release: candidate.release,
            tileCount: candidate.tile_count,
            sourceCount: candidate.source_count,
            hotRoutingEnabled: hotManifest !== null,
            hotFallbackEnabled: hotManifest !== null && directTileOrigin !== null,
            hotTileCount: hotManifest?.tile_count ?? 0,
            overrideRoutingEnabled: routingIndex !== null,
            overrideTileCount: routingIndex?.override_count ?? 0,
            cumulativeFloorsEnabled: cumulativeManifest !== null,
            cumulativeTileCount: cumulativeManifest?.tile_count ?? 0,
        };
    } else {
        console.warn('Tile-existence manifest unavailable; using normal tile requests.', mainError);
        reportState({
            status: 'unavailable',
            expectedRelease,
            reason: mainError instanceof Error ? mainError.message : String(mainError),
            hotManifestStatus: hotManifest ? 'loaded' : (hotError ? 'unavailable' : 'disabled'),
            hotTileCount: hotManifest?.tile_count ?? 0,
            routingIndexStatus: routingIndex
                ? 'loaded'
                : (routingError ? 'unavailable' : 'disabled'),
            overrideTileCount: routingIndex?.override_count ?? 0,
            assetManifestStatus: optionalAssetManifest
                ? 'loaded'
                : (assetError ? 'unavailable' : 'disabled'),
            cumulativeManifestStatus: cumulativeManifest
                ? 'loaded'
                : (cumulativeError ? 'unavailable' : 'disabled'),
            cumulativeTileCount: cumulativeManifest?.tile_count ?? 0,
        });
        return {
            enabled: false,
            reason: 'manifest_unavailable',
            hotRoutingEnabled: hotManifest !== null,
            hotFallbackEnabled: hotManifest !== null && directTileOrigin !== null,
            hotTileCount: hotManifest?.tile_count ?? 0,
            overrideRoutingEnabled: routingIndex !== null,
            overrideTileCount: routingIndex?.override_count ?? 0,
            cumulativeFloorsEnabled: cumulativeManifest !== null,
            cumulativeTileCount: cumulativeManifest?.tile_count ?? 0,
        };
    }
}
