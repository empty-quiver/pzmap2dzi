const INSTALL_KEY = Symbol.for('fanmap42.encoded-tile-cache');

const DEFAULT_OPTIONS = Object.freeze({
    settleDelayMs: 140,
    fastVelocityPxPerMs: 0.24,
    fastZoomOctavesPerSecond: 0.8,
    predictionMs: 180,
    cancellationGraceMs: 90,
    cancellationMargin: 0.35,
    governorIntervalMs: 500,
    targetFrameMs: 16.7,
    slowFrameMs: 25,
    initialConcurrency: 6,
    minConcurrency: 2,
    maxConcurrency: 12,
    initialMaxTilesPerFrame: 2,
    maxTilesPerFrame: 4,
    encodedCacheEntries: 1600,
});

function now() {
    return globalThis.performance?.now?.() ?? Date.now();
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

export function percentile(values, fraction) {
    if (!values.length) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = clamp(Math.ceil(fraction * sorted.length) - 1, 0, sorted.length - 1);
    return sorted[index];
}

function summarize(values) {
    if (!values.length) {
        return {count: 0, p50: null, p95: null, p99: null, max: null};
    }
    return {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: Math.max(...values),
    };
}

export function performanceMode(config, override = globalThis.window?.FANMAP42_PERFORMANCE_MODE) {
    const candidate = override ?? config?.performance?.mode ?? 'baseline';
    return candidate === 'adaptive' ? 'adaptive' : 'baseline';
}

export class FrameTelemetry {
    constructor(options = {}) {
        this.options = {...DEFAULT_OPTIONS, ...options};
        this.frames = [];
        this.longTasks = [];
        this.running = false;
        this.lastFrame = null;
        this.raf = null;
        this.observer = null;
    }

    start() {
        if (this.running || typeof requestAnimationFrame !== 'function') {
            return;
        }
        this.running = true;
        const sample = (timestamp) => {
            if (!this.running) {
                return;
            }
            if (this.lastFrame !== null && globalThis.document?.visibilityState !== 'hidden') {
                this.frames.push({time: timestamp, duration: timestamp - this.lastFrame});
                if (this.frames.length > 3600) {
                    this.frames.splice(0, this.frames.length - 3600);
                }
            }
            this.lastFrame = timestamp;
            this.raf = requestAnimationFrame(sample);
        };
        this.raf = requestAnimationFrame(sample);
        if (typeof PerformanceObserver === 'function') {
            try {
                this.observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        this.longTasks.push({time: entry.startTime, duration: entry.duration});
                    }
                    if (this.longTasks.length > 512) {
                        this.longTasks.splice(0, this.longTasks.length - 512);
                    }
                });
                this.observer.observe({type: 'longtask', buffered: true});
            } catch {
                this.observer = null;
            }
        }
    }

    stop() {
        this.running = false;
        if (this.raf !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.raf);
        }
        this.observer?.disconnect();
    }

    durations(since = -Infinity) {
        return this.frames.filter((frame) => frame.time >= since).map((frame) => frame.duration);
    }

    snapshot(since = -Infinity) {
        const durations = this.durations(since);
        const slowFrames = durations.filter((duration) => duration >= this.options.slowFrameMs).length;
        return {
            ...summarize(durations),
            slowFrames,
            slowFrameRatio: durations.length ? slowFrames / durations.length : 0,
            longTasks: this.longTasks.filter((task) => task.time >= since).length,
        };
    }
}

function tileKey(tile) {
    return `${tile?.level ?? '?'}:${tile?.x ?? '?'}:${tile?.y ?? '?'}`;
}

export class AdaptiveImageLoader {
    constructor(OpenSeadragon, controller, options = {}) {
        this.OpenSeadragon = OpenSeadragon;
        this.controller = controller;
        this.timeout = options.timeout ?? 30000;
        this.concurrency = options.concurrency ?? DEFAULT_OPTIONS.initialConcurrency;
        this.queue = [];
        this.inFlight = new Map();
        this.sequence = 0;
        this.stats = {
            enqueued: 0,
            started: 0,
            completed: 0,
            cancelledQueued: 0,
            cancelledInFlight: 0,
            failed: 0,
        };
    }

    addJob(options) {
        if (!options.source) {
            throw new Error('AdaptiveImageLoader requires an OpenSeadragon TileSource');
        }
        const entry = {
            id: ++this.sequence,
            options,
            tile: options.tile || {},
            enqueuedAt: now(),
            generation: this.controller?.generation ?? 0,
            state: 'queued',
            score: 0,
            job: null,
        };
        entry.score = this.controller?.scoreTileJob(entry) ?? entry.id;
        this.queue.push(entry);
        this.stats.enqueued += 1;
        this._sort();
        this._pump();
        return entry;
    }

    _sort() {
        for (const entry of this.queue) {
            entry.score = this.controller?.scoreTileJob(entry) ?? entry.id;
        }
        this.queue.sort((a, b) => a.score - b.score || a.id - b.id);
    }

    _pump() {
        while (this.inFlight.size < this.concurrency && this.queue.length) {
            this._start(this.queue.shift());
        }
    }

    _start(entry) {
        if (entry.state !== 'queued') {
            return;
        }
        const options = entry.options;
        const complete = (job) => {
            if (entry.state !== 'running') {
                return;
            }
            entry.state = 'complete';
            entry.completedAt = now();
            this.inFlight.delete(entry.id);
            this.stats.completed += 1;
            if (job.data === null || job.data === undefined) {
                this.stats.failed += 1;
            }
            this.controller?.onTileJobComplete?.(entry, job);
            options.callback?.(job.data, job.errorMsg, job.request);
            this._pump();
        };
        entry.job = new this.OpenSeadragon.ImageJob({
            src: options.src,
            tile: entry.tile,
            source: options.source,
            loadWithAjax: options.loadWithAjax,
            ajaxHeaders: options.loadWithAjax ? options.ajaxHeaders : null,
            crossOriginPolicy: options.crossOriginPolicy,
            ajaxWithCredentials: options.ajaxWithCredentials,
            postData: options.postData,
            callback: complete,
            abort: options.abort,
            timeout: this.timeout,
        });
        entry.state = 'running';
        entry.startedAt = now();
        this.inFlight.set(entry.id, entry);
        this.stats.started += 1;
        this.controller?.onTileJobStart?.(entry);
        entry.job.start();
    }

    _cancel(entry, inFlight) {
        if (!['queued', 'running'].includes(entry.state)) {
            return false;
        }
        entry.state = 'cancelled';
        entry.cancelledAt = now();
        try {
            entry.job?.abort?.();
            if (!entry.job) {
                entry.options.abort?.();
            }
        } catch {
            entry.options.abort?.();
        }
        if (inFlight) {
            this.inFlight.delete(entry.id);
            this.stats.cancelledInFlight += 1;
        } else {
            this.stats.cancelledQueued += 1;
        }
        this.controller?.onTileJobCancelled?.(entry, inFlight);
        return true;
    }

    reprioritize() {
        const retained = [];
        for (const entry of this.queue) {
            if (this.controller?.isTileJobObsolete(entry, false)) {
                this._cancel(entry, false);
            } else {
                retained.push(entry);
            }
        }
        this.queue = retained;
        for (const entry of [...this.inFlight.values()]) {
            if (this.controller?.isTileJobObsolete(entry, true)) {
                this._cancel(entry, true);
            }
        }
        this._sort();
        this._pump();
    }

    setConcurrency(value) {
        this.concurrency = Math.max(1, Math.floor(value));
        this._pump();
    }

    clear() {
        for (const entry of this.queue) {
            this._cancel(entry, false);
        }
        this.queue = [];
    }

    abortAll() {
        this.clear();
        for (const entry of [...this.inFlight.values()]) {
            this._cancel(entry, true);
        }
    }

    snapshot() {
        return {
            ...this.stats,
            concurrency: this.concurrency,
            queued: this.queue.length,
            inFlight: this.inFlight.size,
        };
    }
}

export class EncodedTileCache {
    constructor(options = {}) {
        this.name = options.name || 'fanmap42-encoded-tiles-v1';
        this.maxEntries = options.maxEntries ?? DEFAULT_OPTIONS.encodedCacheEntries;
        this.enabled = options.enabled !== false && typeof globalThis.caches !== 'undefined';
        this.cachePromise = null;
        this.writeCount = 0;
        this.stats = {hits: 0, misses: 0, writes: 0, evictions: 0, errors: 0};
    }

    async _cache() {
        if (!this.enabled) {
            return null;
        }
        if (!this.cachePromise) {
            this.cachePromise = globalThis.caches.open(this.name).catch((error) => {
                this.enabled = false;
                this.stats.errors += 1;
                throw error;
            });
        }
        return this.cachePromise;
    }

    async match(url) {
        if (!this.enabled) {
            this.stats.misses += 1;
            return null;
        }
        try {
            const response = await (await this._cache()).match(url);
            if (response) {
                this.stats.hits += 1;
                return response;
            }
        } catch {
            this.stats.errors += 1;
        }
        this.stats.misses += 1;
        return null;
    }

    async put(url, bytes, contentType = 'application/octet-stream') {
        if (!this.enabled || !bytes) {
            return;
        }
        try {
            const response = new Response(bytes, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'X-FanMap42-Cached-At': String(Date.now()),
                },
            });
            const cache = await this._cache();
            await cache.put(url, response);
            this.stats.writes += 1;
            this.writeCount += 1;
            if (this.writeCount % 64 === 0) {
                await this.prune();
            }
        } catch {
            this.stats.errors += 1;
        }
    }

    async prune() {
        if (!this.enabled) {
            return;
        }
        try {
            const cache = await this._cache();
            const keys = await cache.keys();
            const excess = keys.length - this.maxEntries;
            if (excess <= 0) {
                return;
            }
            for (const key of keys.slice(0, excess)) {
                if (await cache.delete(key)) {
                    this.stats.evictions += 1;
                }
            }
        } catch {
            this.stats.errors += 1;
        }
    }

    snapshot() {
        return {...this.stats, enabled: this.enabled, maxEntries: this.maxEntries};
    }

    resetStats() {
        for (const key of Object.keys(this.stats)) {
            this.stats[key] = 0;
        }
        return this.snapshot();
    }
}

function decodeResponseImage(response, context) {
    return response.blob().then((blob) => new Promise((resolve, reject) => {
        if (context.userData.fanmapEncodedCancelled) {
            reject(new DOMException('Tile load cancelled', 'AbortError'));
            return;
        }
        const image = new Image();
        const objectUrl = URL.createObjectURL(blob);
        context.userData.fanmapEncodedImage = image;
        image.onload = () => {
            image.onload = image.onerror = image.onabort = null;
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = image.onabort = () => {
            image.onload = image.onerror = image.onabort = null;
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Cached tile decode failed'));
        };
        image.src = objectUrl;
    }));
}

export function installEncodedTileCache(OpenSeadragon, cache) {
    const prototype = OpenSeadragon?.DziTileSource?.prototype;
    if (!prototype || !cache || prototype[INSTALL_KEY]) {
        return;
    }
    const originalStart = prototype.downloadTileStart;
    const originalAbort = prototype.downloadTileAbort;
    prototype.downloadTileStart = function(context) {
        if (!context || context.postData !== null && context.postData !== undefined ||
            !/_files\/\d+\/\d+_\d+\.[a-z0-9]+(?:[?#].*)?$/i.test(context.src || '')) {
            return originalStart.call(this, context);
        }
        const source = this;
        const url = context.src;
        context.userData.fanmapEncodedPending = true;
        cache.match(url).then((response) => {
            if (context.userData.fanmapEncodedCancelled) {
                return;
            }
            if (response) {
                return decodeResponseImage(response, context).then((image) => {
                    context.userData.fanmapEncodedPending = false;
                    context.finish(image, null, null);
                });
            }
            context.userData.fanmapEncodedPending = false;
            const finalFinish = context.finish.bind(context);
            context.finish = function(data, request, errorMessage) {
                context.finish = finalFinish;
                if (data && request?.response) {
                    const contentType = request.getResponseHeader?.('content-type') ||
                        (url.endsWith('.png') ? 'image/png' : 'image/jpeg');
                    cache.put(url, request.response, contentType);
                }
                return finalFinish(data, request, errorMessage);
            };
            context.loadWithAjax = true;
            return originalStart.call(source, context);
        }).catch(() => {
            if (!context.userData.fanmapEncodedCancelled) {
                context.userData.fanmapEncodedPending = false;
                originalStart.call(source, context);
            }
        });
    };
    prototype.downloadTileAbort = function(context) {
        context.userData.fanmapEncodedCancelled = true;
        const image = context.userData.fanmapEncodedImage;
        if (image) {
            image.onload = image.onerror = image.onabort = null;
        }
        if (!context.userData.fanmapEncodedPending) {
            return originalAbort.call(this, context);
        }
    };
    prototype[INSTALL_KEY] = {cache, originalStart, originalAbort};
}

function expandedRectangle(rectangle, fraction) {
    const dx = rectangle.width * fraction;
    const dy = rectangle.height * fraction;
    return {
        x: rectangle.x - dx,
        y: rectangle.y - dy,
        width: rectangle.width + dx * 2,
        height: rectangle.height + dy * 2,
    };
}

function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

export class ViewerPerformanceController {
    constructor(viewer, OpenSeadragon, options = {}) {
        this.viewer = viewer;
        this.OpenSeadragon = OpenSeadragon;
        this.options = {...DEFAULT_OPTIONS, ...options};
        this.mode = options.mode === 'adaptive' ? 'adaptive' : 'baseline';
        this.frameTelemetry = new FrameTelemetry(this.options);
        this.generation = 0;
        this.fastMotion = false;
        this.pointerActive = false;
        this.lastViewport = null;
        this.velocity = {x: 0, y: 0, zoom: 0};
        this.settleTimer = null;
        this.overlayRedraw = null;
        this.overlayStats = {redraws: 0, deferred: 0, settleRedraws: 0, durationMs: 0};
        this.interaction = null;
        this.interactions = [];
        this.events = [];
        this.governorDecisions = [];
        this.readinessSample = null;
        this.lastGovernorAt = now();
        this.currentConcurrency = this.options.initialConcurrency;
        this.currentMaxTilesPerFrame = this.options.initialMaxTilesPerFrame;
        this.loader = null;
        this.encodedCache = options.encodedCache || null;
        this.lastGovernorLoaderStats = {enqueued: 0, started: 0, cancelledQueued: 0};
        this._bindViewerEvents();
        this.frameTelemetry.start();
        if (this.mode === 'adaptive') {
            this._installLoader();
            this._setMaxTilesPerFrame(this.currentMaxTilesPerFrame);
        }
        this.governorTimer = globalThis.setInterval?.(
            () => this._govern(),
            this.options.governorIntervalMs,
        );
    }

    _installLoader() {
        const previous = this.viewer.imageLoader;
        this.loader = new AdaptiveImageLoader(this.OpenSeadragon, this, {
            timeout: previous?.timeout,
            concurrency: this.currentConcurrency,
        });
        this.viewer.imageLoader = this.loader;
        for (let index = 0; index < this.viewer.world.getItemCount(); index += 1) {
            this.viewer.world.getItemAt(index)._imageLoader = this.loader;
        }
    }

    _bindViewerEvents() {
        this.viewer.addHandler('add-item', (event) => {
            if (this.loader) {
                event.item._imageLoader = this.loader;
            }
            this._observeTiledImage(event.item);
        });
        this.viewer.addHandler('tile-drawn', (event) => {
            this._noteCoverage(event.tile);
        });
        this.viewer.addHandler('tile-loaded', (event) => {
            this.events.push({type: 'tile-loaded', time: now(), tile: tileKey(event.tile)});
            this._trimEvents();
        });
        this.viewer.addHandler('tile-load-failed', (event) => {
            if (!String(event.message || '').includes('adaptive scheduler')) {
                this.events.push({type: 'tile-load-failed', time: now(), tile: tileKey(event.tile)});
                this._trimEvents();
            }
        });
        this.viewer.addHandler('open', () => {
            for (let index = 0; index < this.viewer.world.getItemCount(); index += 1) {
                const item = this.viewer.world.getItemAt(index);
                if (this.loader) {
                    item._imageLoader = this.loader;
                }
                this._observeTiledImage(item);
            }
        });
    }

    _observeTiledImage(item) {
        if (!item || item.__fanmapPerformanceObserved) {
            return;
        }
        item.__fanmapPerformanceObserved = true;
        item.addHandler('fully-loaded-change', (event) => {
            if (event.fullyLoaded) {
                this._noteSharpness();
            }
        });
    }

    _trimEvents() {
        if (this.events.length > 2000) {
            this.events.splice(0, this.events.length - 2000);
        }
    }

    onViewportUpdate() {
        const timestamp = now();
        const viewport = this.viewer.viewport;
        if (!viewport) {
            return {fast: false};
        }
        const center = viewport.getCenter(true);
        const zoom = viewport.getZoom(true);
        const previous = this.lastViewport;
        let fast = this.pointerActive;
        let viewportChanged = previous === null;
        if (previous) {
            const elapsed = Math.max(1, timestamp - previous.time);
            const width = viewport.containerSize?.x || this.viewer.container?.clientWidth || 1;
            this.velocity.x = (center.x - previous.center.x) * zoom * width / elapsed;
            this.velocity.y = (center.y - previous.center.y) * zoom * width / elapsed;
            this.velocity.zoom = Math.log2(Math.max(zoom, 1e-9) / Math.max(previous.zoom, 1e-9)) * 1000 / elapsed;
            const speed = Math.hypot(this.velocity.x, this.velocity.y);
            const movedPixels = Math.hypot(center.x - previous.center.x, center.y - previous.center.y) *
                zoom * width;
            const zoomDelta = Math.abs(Math.log2(Math.max(zoom, 1e-9) / Math.max(previous.zoom, 1e-9)));
            viewportChanged = movedPixels > 0.001 || zoomDelta > 1e-7;
            const moved = speed > 0.01 || Math.abs(this.velocity.zoom) > 0.02;
            if (moved) {
                this.generation += 1;
                this._beginInteraction(timestamp);
                fast = fast || speed >= this.options.fastVelocityPxPerMs ||
                    Math.abs(this.velocity.zoom) >= this.options.fastZoomOctavesPerSecond;
            }
        }
        this.lastViewport = {time: timestamp, center, zoom};
        this.fastMotion = this.mode === 'adaptive' && fast;
        globalThis.document?.documentElement?.toggleAttribute('data-fanmap-fast-motion', this.fastMotion);
        this.loader?.reprioritize();
        this._scheduleReadinessSample();
        this._scheduleSettle();
        return {fast: this.fastMotion, viewportChanged, velocity: {...this.velocity}};
    }

    onCanvasPress() {
        this.pointerActive = true;
        this._beginInteraction(now());
    }

    onCanvasDrag() {
        this.fastMotion = this.mode === 'adaptive';
        this._scheduleSettle();
    }

    onCanvasRelease() {
        this.pointerActive = false;
        this._scheduleSettle(0);
    }

    _beginInteraction(timestamp) {
        if (this.interaction) {
            return;
        }
        this.interaction = {
            id: this.interactions.length + 1,
            startTime: timestamp,
            coverageMs: null,
            sharpnessMs: null,
            motionEndTime: null,
            frameStartTime: timestamp,
            generationStart: this.generation,
        };
        this.interactions.push(this.interaction);
        if (this.interactions.length > 100) {
            this.interactions.shift();
        }
    }

    _scheduleSettle(extraDelay = 0) {
        if (this.settleTimer !== null) {
            clearTimeout(this.settleTimer);
        }
        this.settleTimer = setTimeout(() => {
            if (this.pointerActive) {
                this._scheduleSettle();
                return;
            }
            this.fastMotion = false;
            globalThis.document?.documentElement?.removeAttribute('data-fanmap-fast-motion');
            if (this.overlayRedraw) {
                const overlayRedraw = this.overlayRedraw;
                this.overlayRedraw = null;
                this.recordOverlayRedraw(overlayRedraw, true);
            }
            if (this.interaction) {
                const settledInteraction = this.interaction;
                settledInteraction.motionEndTime = now();
                settledInteraction.frames = this.frameTelemetry.snapshot(settledInteraction.startTime);
                this.interaction = null;
                this._waitForSharpness(settledInteraction);
            }
        }, this.options.settleDelayMs + extraDelay);
    }

    requestOverlayRedraw(callback) {
        this.overlayRedraw = callback;
        this.overlayStats.deferred += 1;
    }

    recordOverlayRedraw(callback, settled = false) {
        const start = now();
        callback();
        this.overlayStats.redraws += 1;
        this.overlayStats.durationMs += now() - start;
        if (settled) {
            this.overlayStats.settleRedraws += 1;
        }
    }

    shouldFreezeOverlays() {
        return this.mode === 'adaptive' && this.fastMotion;
    }

    shouldRedrawOverlays(viewportChanged) {
        return this.mode !== 'adaptive' || viewportChanged;
    }

    _noteCoverage(tile) {
        if (!this.interaction || this.interaction.coverageMs !== null) {
            return;
        }
        this.interaction.coverageMs = now() - this.interaction.startTime;
        this.interaction.coverageTile = tileKey(tile);
    }

    _scheduleReadinessSample() {
        if (!this.interaction || this.interaction.coverageMs !== null ||
            this.readinessSample !== null || typeof requestAnimationFrame !== 'function') {
            return;
        }
        this.readinessSample = requestAnimationFrame(() => {
            this.readinessSample = null;
            if (!this.interaction || this.interaction.coverageMs !== null) {
                return;
            }
            for (let index = 0; index < this.viewer.world.getItemCount(); index += 1) {
                const item = this.viewer.world.getItemAt(index);
                if (item.getOpacity?.() === 0 || !item.coverage || !item._providesCoverage) {
                    continue;
                }
                const covered = Object.keys(item.coverage).some((level) =>
                    item._providesCoverage(item.coverage, Number(level)),
                );
                if (covered) {
                    this.interaction.coverageMs = now() - this.interaction.startTime;
                    this.interaction.coverageLevel = Math.max(...Object.keys(item.coverage).map(Number));
                    break;
                }
            }
        });
    }

    _noteSharpness() {
        const target = this.interaction || this.interactions.at(-1);
        if (target && target.sharpnessMs === null) {
            const timestamp = now();
            target.sharpnessMs = timestamp - target.startTime;
            target.sharpnessAfterMotionMs = target.motionEndTime === null ? null :
                timestamp - target.motionEndTime;
        }
    }

    _waitForSharpness(interaction) {
        if (Number.isFinite(interaction.sharpnessAfterMotionMs) || typeof requestAnimationFrame !== 'function') {
            return;
        }
        const deadline = now() + 5000;
        const sample = () => {
            let visibleItems = 0;
            let fullyLoaded = true;
            for (let index = 0; index < this.viewer.world.getItemCount(); index += 1) {
                const item = this.viewer.world.getItemAt(index);
                if (item.getOpacity?.() === 0) {
                    continue;
                }
                visibleItems += 1;
                fullyLoaded = fullyLoaded && item.getFullyLoaded();
            }
            if (visibleItems > 0 && fullyLoaded) {
                const timestamp = now();
                interaction.sharpnessMs = timestamp - interaction.startTime;
                interaction.sharpnessAfterMotionMs = interaction.motionEndTime === null ? null :
                    timestamp - interaction.motionEndTime;
                return;
            }
            if (now() < deadline) {
                requestAnimationFrame(sample);
            }
        };
        requestAnimationFrame(sample);
    }

    scoreTileJob(entry) {
        const tile = entry.tile;
        const canvasWidth = this.viewer.container?.clientWidth || 1;
        const canvasHeight = this.viewer.container?.clientHeight || 1;
        const speed = Math.hypot(this.velocity.x, this.velocity.y);
        const leadScale = speed > 0 ? Math.min(1, speed / this.options.fastVelocityPxPerMs) : 0;
        const leadX = this.velocity.x / Math.max(speed, 1e-9) * canvasWidth * 0.28 * leadScale;
        const leadY = this.velocity.y / Math.max(speed, 1e-9) * canvasHeight * 0.28 * leadScale;
        const focusX = canvasWidth / 2 + leadX;
        const focusY = canvasHeight / 2 + leadY;
        const tileX = (tile.position?.x ?? canvasWidth / 2) + (tile.size?.x ?? 0) / 2;
        const tileY = (tile.position?.y ?? canvasHeight / 2) + (tile.size?.y ?? 0) / 2;
        const distance = Math.hypot(tileX - focusX, tileY - focusY) /
            Math.max(1, Math.hypot(canvasWidth, canvasHeight));
        const visibility = Number.isFinite(tile.visibility) ? tile.visibility : 0;
        const ageBonus = Math.min(0.3, (now() - entry.enqueuedAt) / 4000);
        return distance - visibility * 0.35 - ageBonus - (tile.level || 0) * 0.0001;
    }

    isTileJobObsolete(entry, inFlight) {
        const age = now() - (entry.startedAt ?? entry.enqueuedAt);
        if (inFlight && age < this.options.cancellationGraceMs) {
            return false;
        }
        if (entry.generation >= this.generation - 1) {
            return false;
        }
        const tileBounds = entry.tile?.bounds;
        if (!tileBounds || !this.viewer.viewport) {
            return false;
        }
        const visibleBounds = this.viewer.viewport.getBounds(true);
        const viewportBounds = expandedRectangle(visibleBounds, this.options.cancellationMargin);
        return !intersects(tileBounds, viewportBounds);
    }

    onTileJobStart(entry) {
        this.events.push({type: 'tile-job-start', time: now(), tile: tileKey(entry.tile)});
        this._trimEvents();
    }

    onTileJobComplete(entry) {
        this.events.push({
            type: 'tile-job-complete',
            time: now(),
            tile: tileKey(entry.tile),
            duration: now() - entry.startedAt,
        });
        this._trimEvents();
    }

    onTileJobCancelled(entry, inFlight) {
        this.events.push({
            type: inFlight ? 'tile-job-abort' : 'tile-job-drop',
            time: now(),
            tile: tileKey(entry.tile),
        });
        this._trimEvents();
    }

    _setMaxTilesPerFrame(value) {
        this.currentMaxTilesPerFrame = value;
        this.viewer.maxTilesPerFrame = value;
        for (let index = 0; index < this.viewer.world.getItemCount(); index += 1) {
            this.viewer.world.getItemAt(index).maxTilesPerFrame = value;
        }
    }

    _govern() {
        if (this.mode !== 'adaptive' || !this.loader) {
            return;
        }
        const timestamp = now();
        const frames = this.frameTelemetry.snapshot(this.lastGovernorAt);
        const queue = this.loader.snapshot();
        const previousLoader = this.lastGovernorLoaderStats;
        const recentDemand = Math.max(0, queue.enqueued - previousLoader.enqueued);
        const recentStarts = Math.max(0, queue.started - previousLoader.started);
        const recentDrops = Math.max(0, queue.cancelledQueued - previousLoader.cancelledQueued);
        let concurrency = this.currentConcurrency;
        let tilesPerFrame = this.currentMaxTilesPerFrame;
        const hasDemand = queue.queued > concurrency || recentDemand > recentStarts || recentDrops > concurrency;
        let reason = 'hold';
        if (frames.p95 !== null && (frames.p95 > this.options.slowFrameMs || frames.slowFrameRatio > 0.08)) {
            concurrency = Math.max(this.options.minConcurrency, concurrency - 1);
            tilesPerFrame = Math.max(1, tilesPerFrame - 1);
            reason = 'frame-pressure';
        } else if (frames.p95 !== null && frames.p95 < this.options.targetFrameMs * 1.08 && hasDemand) {
            concurrency = Math.min(this.options.maxConcurrency, concurrency + 1);
            if (queue.queued > concurrency * 2 || recentDrops > concurrency * 2) {
                tilesPerFrame = Math.min(this.options.maxTilesPerFrame, tilesPerFrame + 1);
            }
            reason = 'headroom';
        }
        this.currentConcurrency = concurrency;
        this.loader.setConcurrency(concurrency);
        this._setMaxTilesPerFrame(tilesPerFrame);
        this.governorDecisions.push({
            time: timestamp,
            reason,
            concurrency,
            maxTilesPerFrame: tilesPerFrame,
            frameP95: frames.p95,
            slowFrameRatio: frames.slowFrameRatio,
            queued: queue.queued,
            inFlight: queue.inFlight,
            recentDemand,
            recentStarts,
            recentDrops,
        });
        if (this.governorDecisions.length > 512) {
            this.governorDecisions.shift();
        }
        this.lastGovernorAt = timestamp;
        this.lastGovernorLoaderStats = {
            enqueued: queue.enqueued,
            started: queue.started,
            cancelledQueued: queue.cancelledQueued,
        };
    }

    snapshot() {
        const coverage = this.interactions.map((value) => value.coverageMs).filter(Number.isFinite);
        const sharpness = this.interactions.map((value) => value.sharpnessMs).filter(Number.isFinite);
        return {
            schema: 'fanmap42.viewer-performance.v1',
            mode: this.mode,
            generation: this.generation,
            fastMotion: this.fastMotion,
            velocity: {...this.velocity},
            frames: this.frameTelemetry.snapshot(),
            coverage: summarize(coverage),
            sharpness: summarize(sharpness),
            interactions: this.interactions.map((interaction) => ({...interaction})),
            overlays: {...this.overlayStats},
            loader: this.loader?.snapshot() ?? null,
            encodedCache: this.encodedCache?.snapshot() ?? null,
            governor: {
                concurrency: this.currentConcurrency,
                maxTilesPerFrame: this.currentMaxTilesPerFrame,
                decisions: [...this.governorDecisions],
            },
        };
    }

    exportTrace() {
        return {...this.snapshot(), events: [...this.events]};
    }

    resetMeasurements() {
        this.frameTelemetry.frames = [];
        this.frameTelemetry.longTasks = [];
        this.frameTelemetry.lastFrame = null;
        this.interaction = null;
        this.interactions = [];
        this.events = [];
        this.governorDecisions = [];
        this.overlayStats = {redraws: 0, deferred: 0, settleRedraws: 0, durationMs: 0};
        if (this.loader) {
            for (const key of Object.keys(this.loader.stats)) {
                this.loader.stats[key] = 0;
            }
        }
        this.lastGovernorLoaderStats = {enqueued: 0, started: 0, cancelledQueued: 0};
        this.encodedCache?.resetStats?.();
        return this.snapshot();
    }

    destroy() {
        this.frameTelemetry.stop();
        this.loader?.abortAll();
        if (this.governorTimer !== undefined) {
            clearInterval(this.governorTimer);
        }
        if (this.settleTimer !== null) {
            clearTimeout(this.settleTimer);
        }
        if (this.readinessSample !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.readinessSample);
        }
    }
}

export function prepareOpenSeadragon(OpenSeadragon, config, options = {}) {
    const mode = performanceMode(config, options.mode);
    if (mode !== 'adaptive' || config?.performance?.encoded_cache === false) {
        return null;
    }
    const release = config?.route?.default?.match?.(/\/releases\/([^/]+)\//)?.[1] || 'local';
    const cache = new EncodedTileCache({
        name: `fanmap42-encoded-tiles-${release}`,
        maxEntries: config?.performance?.encoded_cache_entries,
    });
    installEncodedTileCache(OpenSeadragon, cache);
    return cache;
}

export function attachViewerPerformance(viewer, OpenSeadragon, config, options = {}) {
    const controller = new ViewerPerformanceController(viewer, OpenSeadragon, {
        ...config?.performance,
        ...options,
        mode: performanceMode(config, options.mode),
    });
    if (typeof window !== 'undefined') {
        window.fanmapPerformance = {
            snapshot: () => controller.snapshot(),
            exportTrace: () => controller.exportTrace(),
            controller,
        };
    }
    return controller;
}
