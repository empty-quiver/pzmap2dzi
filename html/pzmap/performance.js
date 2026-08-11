const DEFAULT_OPTIONS = Object.freeze({
    settleDelayMs: 140,
    fastVelocityPxPerMs: 0.24,
    fastZoomOctavesPerSecond: 0.8,
    predictionMs: 180,
    cancellationMargin: 0.35,
    governorIntervalMs: 500,
    governorCooldownMs: 1500,
    governorPressureSamples: 2,
    governorHeadroomSamples: 3,
    targetFrameMs: 16.7,
    slowFrameMs: 25,
    initialConcurrency: 6,
    minConcurrency: 4,
    maxConcurrency: 8,
    initialMaxTilesPerFrame: 2,
    maxTilesPerFrame: 4,
    transientRetries: 1,
    transientRetryDelayMs: 180,
    transientCooldownDelayMs: 1200,
    transientCooldownMaxDelayMs: 5000,
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
        this.options = {...DEFAULT_OPTIONS, ...options};
        this.timeout = options.timeout ?? 30000;
        this.concurrency = options.concurrency ?? DEFAULT_OPTIONS.initialConcurrency;
        this.queue = [];
        this.inFlight = new Map();
        this.retryTimers = new Map();
        this.sequence = 0;
        this.stats = {
            enqueued: 0,
            started: 0,
            completed: 0,
            cancelledQueued: 0,
            abortedInFlight: 0,
            retried: 0,
            transientDeferred: 0,
            transientReleased: 0,
            permanentFailures: 0,
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
            attempts: 0,
            cooldownCycles: 0,
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
            this.inFlight.delete(entry.id);
            if (job.data !== null && job.data !== undefined) {
                this._finish(entry, job, 'success');
            } else if (this._isPermanentFailure(job)) {
                this.stats.permanentFailures += 1;
                this._finish(entry, job, 'permanent-failure');
            } else if (entry.attempts <= this.options.transientRetries) {
                this._retry(entry, job);
            } else {
                this._deferTransient(entry, job);
            }
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
        entry.firstStartedAt ??= entry.startedAt;
        entry.attempts += 1;
        this.inFlight.set(entry.id, entry);
        this.stats.started += 1;
        this.controller?.onTileJobStart?.(entry);
        entry.job.start();
    }

    _isPermanentFailure(job) {
        const status = Number(job.request?.status);
        return status === 404 || status === 410;
    }

    _finish(entry, job, outcome) {
        entry.state = 'complete';
        entry.completedAt = now();
        this.stats.completed += 1;
        if (outcome !== 'success') {
            this.stats.failed += 1;
        }
        this.controller?.onTileJobComplete?.(entry, job, outcome);
        entry.options.callback?.(job.data, job.errorMsg, job.request, job.dataType, job.tries);
    }

    _retry(entry, job) {
        entry.state = 'retry-wait';
        entry.job = null;
        this.stats.retried += 1;
        this.controller?.onTileJobRetry?.(entry, job);
        const timer = setTimeout(() => {
            this.retryTimers.delete(entry.id);
            if (entry.state !== 'retry-wait') {
                return;
            }
            if (this.controller?.isTileJobObsolete(entry, false)) {
                this._releaseTransient(entry, job);
                return;
            }
            entry.state = 'queued';
            entry.enqueuedAt = now();
            this.queue.push(entry);
            this._sort();
            this._pump();
        }, this.options.transientRetryDelayMs);
        this.retryTimers.set(entry.id, {timer, entry, job});
    }

    _releaseTransient(entry, job) {
        entry.state = 'released';
        entry.completedAt = now();
        entry.job = null;
        this.stats.completed += 1;
        this.stats.failed += 1;
        this.stats.transientReleased += 1;
        this.controller?.onTileJobComplete?.(entry, job, 'transient-release');
        // OpenSeadragon's abort hook clears tile.loading without setting
        // tile.exists=false. A future visible update can therefore retry it.
        entry.options.abort?.();
    }

    _deferTransient(entry, job) {
        entry.state = 'cooldown-wait';
        entry.job = null;
        entry.cooldownCycles += 1;
        this.stats.transientDeferred += 1;
        this.controller?.onTileJobRetry?.(entry, job, 'cooldown');
        const delay = Math.min(
            this.options.transientCooldownMaxDelayMs,
            this.options.transientCooldownDelayMs * (2 ** (entry.cooldownCycles - 1)),
        );
        const timer = setTimeout(() => {
            this.retryTimers.delete(entry.id);
            if (entry.state !== 'cooldown-wait') {
                return;
            }
            if (this.controller?.isTileJobObsolete(entry, false)) {
                this._releaseTransient(entry, job);
                return;
            }
            entry.attempts = 0;
            entry.state = 'queued';
            entry.enqueuedAt = now();
            this.queue.push(entry);
            this._sort();
            this._pump();
        }, delay);
        this.retryTimers.set(entry.id, {timer, entry, job});
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
            this.stats.abortedInFlight += 1;
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
        for (const [id, retry] of this.retryTimers) {
            if (!this.controller?.isTileJobObsolete(retry.entry, false)) {
                continue;
            }
            clearTimeout(retry.timer);
            this.retryTimers.delete(id);
            this._releaseTransient(retry.entry, retry.job);
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
        for (const [id, retry] of this.retryTimers) {
            clearTimeout(retry.timer);
            retry.entry.state = 'cancelled';
            retry.entry.options.abort?.();
            this.retryTimers.delete(id);
        }
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
            retrying: this.retryTimers.size,
        };
    }
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
        this.governorPressureStreak = 0;
        this.governorHeadroomStreak = 0;
        this.lastGovernorAdjustmentAt = -Infinity;
        this.readinessSample = null;
        this.lastGovernorAt = now();
        this.currentConcurrency = this.options.initialConcurrency;
        this.currentMaxTilesPerFrame = this.options.initialMaxTilesPerFrame;
        this.loader = null;
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
            ...this.options,
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
        // This event is emitted by both OpenSeadragon's Canvas and WebGL
        // drawers; tile-drawn is Canvas-only.
        this.viewer.addHandler('tiled-image-drawn', (event) => {
            this._noteCoverage(event.tiles?.[0]);
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

    isTileJobObsolete(entry) {
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

    onTileJobComplete(entry, _job, outcome = 'success') {
        this.events.push({
            type: outcome === 'success' ? 'tile-job-complete' : `tile-job-${outcome}`,
            time: now(),
            tile: tileKey(entry.tile),
            duration: now() - entry.firstStartedAt,
            attempts: entry.attempts,
        });
        this._trimEvents();
    }

    onTileJobRetry(entry) {
        this.events.push({
            type: 'tile-job-retry',
            time: now(),
            tile: tileKey(entry.tile),
            attempt: entry.attempts,
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
        const pressure = frames.p95 !== null &&
            (frames.p95 > this.options.slowFrameMs || frames.slowFrameRatio > 0.08);
        const headroom = frames.p95 !== null &&
            frames.p95 < this.options.targetFrameMs * 1.08 && hasDemand;
        this.governorPressureStreak = pressure ? this.governorPressureStreak + 1 : 0;
        this.governorHeadroomStreak = headroom ? this.governorHeadroomStreak + 1 : 0;
        const cooldownElapsed = timestamp - this.lastGovernorAdjustmentAt >= this.options.governorCooldownMs;
        let reason = 'hold';
        if (cooldownElapsed && this.governorPressureStreak >= this.options.governorPressureSamples) {
            concurrency = Math.max(this.options.minConcurrency, concurrency - 1);
            tilesPerFrame = Math.max(1, tilesPerFrame - 1);
            reason = 'frame-pressure';
        } else if (cooldownElapsed && this.governorHeadroomStreak >= this.options.governorHeadroomSamples) {
            concurrency = Math.min(this.options.maxConcurrency, concurrency + 1);
            if (queue.queued > concurrency * 2 || recentDrops > concurrency * 2) {
                tilesPerFrame = Math.min(this.options.maxTilesPerFrame, tilesPerFrame + 1);
            }
            reason = 'headroom';
        }
        if (reason !== 'hold') {
            this.lastGovernorAdjustmentAt = timestamp;
            this.governorPressureStreak = 0;
            this.governorHeadroomStreak = 0;
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
            drawer: this.viewer.drawer?.getType?.() ?? null,
            rendererAssessment: globalThis.window?.fanmapRendering ?
                {...globalThis.window.fanmapRendering} : null,
            generation: this.generation,
            fastMotion: this.fastMotion,
            velocity: {...this.velocity},
            frames: this.frameTelemetry.snapshot(),
            coverage: summarize(coverage),
            sharpness: summarize(sharpness),
            interactions: this.interactions.map((interaction) => ({...interaction})),
            overlays: {...this.overlayStats},
            loader: this.loader?.snapshot() ?? null,
            encodedCache: null,
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
        this.governorPressureStreak = 0;
        this.governorHeadroomStreak = 0;
        this.overlayStats = {redraws: 0, deferred: 0, settleRedraws: 0, durationMs: 0};
        if (this.loader) {
            for (const key of Object.keys(this.loader.stats)) {
                this.loader.stats[key] = 0;
            }
        }
        this.lastGovernorLoaderStats = {enqueued: 0, started: 0, cancelledQueued: 0};
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
