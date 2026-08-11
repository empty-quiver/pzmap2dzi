import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AdaptiveImageLoader,
    performanceMode,
    percentile,
    ViewerPerformanceController,
} from '../html/pzmap/performance.js';


test('selects an explicit adaptive mode and defaults safely to baseline', () => {
    assert.equal(performanceMode({}), 'baseline');
    assert.equal(performanceMode({performance: {mode: 'adaptive'}}, null), 'adaptive');
    assert.equal(performanceMode({performance: {mode: 'unknown'}}, null), 'baseline');
});


test('computes deterministic nearest-rank percentiles', () => {
    assert.equal(percentile([], 0.95), null);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
    assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});


class FakeImageJob {
    constructor(options) {
        Object.assign(this, options);
        this.userData = {};
        this.data = null;
        this.errorMsg = null;
        this.request = null;
    }

    start() {
        const originalAbort = this.abort;
        this.abort = () => {
            this.source.downloadTileAbort(this);
            originalAbort?.();
        };
        this.source.downloadTileStart(this);
    }

    finish(data, request = null, errorMsg = null) {
        this.data = data;
        this.request = request;
        this.errorMsg = errorMsg;
        this.callback(this);
    }
}


function fakeSource(starts, aborts) {
    return {
        downloadTileStart(job) {
            starts.push(job);
        },
        downloadTileAbort(job) {
            aborts.push(job);
        },
    };
}


test('adaptive loader reprioritizes queued jobs and obeys concurrency', () => {
    const starts = [];
    const aborts = [];
    const completions = [];
    const controller = {
        generation: 1,
        scoreTileJob: (entry) => entry.tile.x,
        isTileJobObsolete: () => false,
    };
    const loader = new AdaptiveImageLoader({ImageJob: FakeImageJob}, controller, {
        concurrency: 1,
    });
    const source = fakeSource(starts, aborts);
    for (const x of [5, 9, 1]) {
        loader.addJob({
            src: `/tile/${x}`,
            source,
            tile: {level: 1, x, y: 0},
            callback: () => completions.push(x),
        });
    }
    assert.deepEqual(starts.map((job) => job.tile.x), [5]);
    starts[0].finish({});
    assert.deepEqual(starts.map((job) => job.tile.x), [5, 1]);
    starts[1].finish({});
    assert.deepEqual(starts.map((job) => job.tile.x), [5, 1, 9]);
    starts[2].finish({});
    assert.deepEqual(completions, [5, 1, 9]);
    assert.equal(loader.snapshot().inFlight, 0);
    assert.equal(aborts.length, 0);
});


test('adaptive loader cancels obsolete queued and in-flight jobs without failure callbacks', () => {
    const starts = [];
    const aborts = [];
    const tileAborts = [];
    const completions = [];
    const controller = {
        generation: 3,
        scoreTileJob: (entry) => entry.id,
        isTileJobObsolete: () => true,
    };
    const loader = new AdaptiveImageLoader({ImageJob: FakeImageJob}, controller, {
        concurrency: 1,
    });
    const source = fakeSource(starts, aborts);
    for (const x of [1, 2]) {
        loader.addJob({
            src: `/tile/${x}`,
            source,
            tile: {level: 1, x, y: 0},
            abort: () => tileAborts.push(x),
            callback: () => completions.push(x),
        });
    }
    loader.reprioritize();
    assert.deepEqual(aborts.map((job) => job.tile.x), [1]);
    assert.deepEqual(tileAborts.sort(), [1, 2]);
    assert.deepEqual(completions, []);
    assert.equal(loader.snapshot().cancelledInFlight, 1);
    assert.equal(loader.snapshot().cancelledQueued, 1);
});


test('loader clear matches OpenSeadragon by dropping queued work without aborting active work', () => {
    const starts = [];
    const aborts = [];
    const completions = [];
    const controller = {
        generation: 1,
        scoreTileJob: (entry) => entry.id,
        isTileJobObsolete: () => false,
    };
    const loader = new AdaptiveImageLoader({ImageJob: FakeImageJob}, controller, {
        concurrency: 1,
    });
    const source = fakeSource(starts, aborts);
    for (const x of [1, 2]) {
        loader.addJob({
            src: `/tile/${x}`,
            source,
            tile: {level: 1, x, y: 0},
            callback: () => completions.push(x),
        });
    }
    loader.clear();
    assert.equal(loader.snapshot().inFlight, 1);
    assert.equal(loader.snapshot().queued, 0);
    assert.equal(loader.snapshot().cancelledQueued, 1);
    assert.equal(loader.snapshot().cancelledInFlight, 0);
    assert.equal(aborts.length, 0);
    starts[0].finish({});
    assert.deepEqual(completions, [1]);
});


test('obsolete detection compares tile and visible bounds in viewport coordinates', () => {
    const controller = {
        generation: 5,
        options: {cancellationGraceMs: 90, cancellationMargin: 0.35},
        viewer: {
            viewport: {
                getBounds: () => ({x: 10, y: 10, width: 1, height: 1}),
            },
        },
    };
    const obsolete = ViewerPerformanceController.prototype.isTileJobObsolete.call(
        controller,
        {
            generation: 1,
            startedAt: -1000,
            tile: {bounds: {x: 0, y: 0, width: 0.25, height: 0.25}},
        },
        true,
    );
    assert.equal(obsolete, true);
});
