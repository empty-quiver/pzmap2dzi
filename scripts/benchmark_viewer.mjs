#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {chromium} from 'playwright-core';

import {startFixtureServer} from '../test/performance/fixture_server.mjs';
import {runScriptedPath} from '../test/performance/scripted_path.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function usage() {
    return [
        'Usage: npm run perf:viewer -- [options]',
        '',
        'Options:',
        '  --iterations N       Paired baseline/adaptive repetitions (default: 5)',
        '  --latency-ms N       Deterministic tile latency (default: 28)',
        '  --jitter-ms N        URL-derived deterministic jitter (default: 9)',
        '  --transient-failures N  Fail this many first adaptive tile requests (default: 0)',
        '  --chrome PATH        Chrome executable',
        '  --profile NAME       Interaction path: standard or fling (default: standard)',
        '  --outdir DIR         Result directory (default: performance-results/TIMESTAMP)',
        '  --headed             Show Chrome',
        '  --trace              Capture one diagnostic Chrome trace per mode',
        '  --keep-build         Preserve the temporary built viewer',
    ].join('\n');
}

function parseArgs(argv) {
    const options = {
        iterations: 5,
        latencyMs: 28,
        jitterMs: 9,
        transientFailures: 0,
        chrome: defaultChrome,
        headed: false,
        trace: false,
        keepBuild: false,
        profile: 'standard',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        }
        if (arg === '--headed') {
            options.headed = true;
            continue;
        }
        if (arg === '--trace') {
            options.trace = true;
            continue;
        }
        if (arg === '--keep-build') {
            options.keepBuild = true;
            continue;
        }
        const value = argv[++index];
        if (value === undefined) {
            throw new Error(`Missing value for ${arg}`);
        }
        if (arg === '--iterations') {
            options.iterations = Number(value);
        } else if (arg === '--latency-ms') {
            options.latencyMs = Number(value);
        } else if (arg === '--jitter-ms') {
            options.jitterMs = Number(value);
        } else if (arg === '--transient-failures') {
            options.transientFailures = Number(value);
        } else if (arg === '--chrome') {
            options.chrome = resolve(value);
        } else if (arg === '--profile') {
            options.profile = value;
        } else if (arg === '--outdir') {
            options.outdir = resolve(value);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 50) {
        throw new Error('--iterations must be an integer from 1 to 50');
    }
    for (const key of ['latencyMs', 'jitterMs', 'transientFailures']) {
        if (!Number.isFinite(options[key]) || options[key] < 0) {
            throw new Error(`--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} must be non-negative`);
        }
    }
    if (!['standard', 'fling'].includes(options.profile)) {
        throw new Error('--profile must be standard or fling');
    }
    const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    options.outdir ||= join(projectRoot, 'performance-results', timestamp);
    return options;
}

function run(command, args, cwd = projectRoot) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {cwd, stdio: 'pipe'});
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) {
                resolvePromise({stdout, stderr});
            } else {
                reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
            }
        });
    });
}

function median(values) {
    if (!values.length) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) {
        return {count: 0, median: null, mad: null, min: null, max: null};
    }
    const center = median(finite);
    return {
        count: finite.length,
        median: center,
        mad: median(finite.map((value) => Math.abs(value - center))),
        min: Math.min(...finite),
        max: Math.max(...finite),
    };
}

function seededRandom(seed = 0x42f00d) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function pairedBootstrap(baseline, adaptive, samples = 2000) {
    const pairs = baseline.map((value, index) => [value, adaptive[index]])
        .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
    if (!pairs.length) {
        return {pairs: 0, medianDelta: null, ci95: [null, null]};
    }
    const random = seededRandom();
    const deltas = [];
    for (let sample = 0; sample < samples; sample += 1) {
        const selected = [];
        for (let index = 0; index < pairs.length; index += 1) {
            const pair = pairs[Math.floor(random() * pairs.length)];
            selected.push(pair[1] - pair[0]);
        }
        deltas.push(median(selected));
    }
    deltas.sort((a, b) => a - b);
    return {
        pairs: pairs.length,
        medianDelta: median(pairs.map(([left, right]) => right - left)),
        ci95: [
            deltas[Math.floor(deltas.length * 0.025)],
            deltas[Math.floor(deltas.length * 0.975)],
        ],
    };
}

function metricMap(metrics) {
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

function deltaMetrics(before, after) {
    const result = {};
    for (const name of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) {
        result[`${name}Ms`] = ((after[name] || 0) - (before[name] || 0)) * 1000;
    }
    result.JSHeapUsedSizeDelta = (after.JSHeapUsedSize || 0) - (before.JSHeapUsedSize || 0);
    return result;
}

function extractRunMetrics(run) {
    const sharpnessTails = run.viewer.interactions
        .map((interaction) => interaction.sharpnessAfterMotionMs)
        .filter(Number.isFinite);
    return {
        frameP95Ms: run.viewer.frames.p95,
        frameP99Ms: run.viewer.frames.p99,
        slowFrameRatio: run.viewer.frames.slowFrameRatio,
        coverageP95Ms: run.viewer.coverage.p95,
        sharpnessP95Ms: run.viewer.sharpness.p95,
        sharpnessTailP95Ms: sharpnessTails.length ? Math.max(...sharpnessTails) : null,
        overlayRedraws: run.viewer.overlays.redraws,
        overlayDeferred: run.viewer.overlays.deferred,
        overlayDurationMs: run.viewer.overlays.durationMs,
        tileRequests: run.origin.tileRequests,
        tileBytes: run.origin.tileBytes,
        abortedResponses: run.origin.abortedResponses,
        taskDurationMs: run.chrome.TaskDurationMs,
        scriptDurationMs: run.chrome.ScriptDurationMs,
        pathDurationMs: run.path.durationMs,
    };
}

function aggregate(runs) {
    const modes = {baseline: {}, adaptive: {}};
    const names = Object.keys(extractRunMetrics(runs[0]));
    for (const mode of Object.keys(modes)) {
        const selected = runs.filter((run) => run.mode === mode).map(extractRunMetrics);
        for (const name of names) {
            modes[mode][name] = summarize(selected.map((run) => run[name]));
        }
    }
    const comparisons = {};
    for (const name of names) {
        const baseline = runs.filter((run) => run.mode === 'baseline')
            .sort((a, b) => a.iteration - b.iteration).map((run) => extractRunMetrics(run)[name]);
        const adaptive = runs.filter((run) => run.mode === 'adaptive')
            .sort((a, b) => a.iteration - b.iteration).map((run) => extractRunMetrics(run)[name]);
        comparisons[name] = pairedBootstrap(baseline, adaptive);
        const baselineMedian = modes.baseline[name].median;
        const adaptiveMedian = modes.adaptive[name].median;
        comparisons[name].percentChange = Number.isFinite(baselineMedian) && baselineMedian !== 0 &&
            Number.isFinite(adaptiveMedian) ? (adaptiveMedian - baselineMedian) / baselineMedian * 100 : null;
    }
    return {modes, comparisons};
}

function formatNumber(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function comparisonMarkdown(summary) {
    const preferredLower = [
        'frameP95Ms', 'frameP99Ms', 'slowFrameRatio', 'coverageP95Ms', 'sharpnessP95Ms',
        'sharpnessTailP95Ms', 'overlayRedraws', 'overlayDurationMs',
        'tileRequests', 'tileBytes', 'abortedResponses', 'taskDurationMs', 'scriptDurationMs',
        'pathDurationMs',
    ];
    const lines = [
        '# Viewer performance comparison',
        '',
        'The baseline and adaptive modes used the same built viewer, Chrome binary, viewport,',
        'deterministic local tile origin, and scripted pointer/wheel path. Run order alternated',
        'per pair. Values are medians; MAD is median absolute deviation. Negative change is',
        'better for every metric in this table.',
        '',
        '| metric | baseline median | adaptive median | change | paired delta 95% bootstrap CI |',
        '| --- | ---: | ---: | ---: | ---: |',
    ];
    for (const name of preferredLower) {
        const baseline = summary.aggregate.modes.baseline[name];
        const adaptive = summary.aggregate.modes.adaptive[name];
        const comparison = summary.aggregate.comparisons[name];
        lines.push(`| ${name} | ${formatNumber(baseline.median)} ± ${formatNumber(baseline.mad)} | ` +
            `${formatNumber(adaptive.median)} ± ${formatNumber(adaptive.mad)} | ` +
            `${formatNumber(comparison.percentChange)}% | ` +
            `[${formatNumber(comparison.ci95[0])}, ${formatNumber(comparison.ci95[1])}] |`);
    }
    lines.push('', 'Treat one-run results as smoke tests. Five or more pairs are intended for comparisons.', '');
    return lines.join('\n');
}

async function waitForViewer(page) {
    await page.waitForFunction(() => window.fanmapPerformance && window.g?.viewer?.world?.getItemCount() > 0, null, {
        timeout: 20000,
    });
    await page.waitForFunction(() => {
        const world = window.g?.viewer?.world;
        if (!world || world.getItemCount() === 0) {
            return false;
        }
        for (let index = 0; index < world.getItemCount(); index += 1) {
            if (!world.getItemAt(index).getFullyLoaded()) {
                return false;
            }
        }
        return true;
    }, null, {timeout: 20000});
}

async function moveToBenchmarkStart(page) {
    await page.evaluate(() => {
        const viewport = window.g.viewer.viewport;
        const maximum = viewport.getMaxZoom();
        const minimum = viewport.getMinZoom();
        viewport.panTo(window.g.viewer.world.getHomeBounds().getCenter(), true);
        viewport.zoomTo(minimum + (maximum - minimum) * 0.38, null, true);
        viewport.applyConstraints(true);
    });
    await page.waitForFunction(() => {
        const world = window.g?.viewer?.world;
        if (!world || world.getItemCount() === 0) {
            return false;
        }
        for (let index = 0; index < world.getItemCount(); index += 1) {
            const item = world.getItemAt(index);
            if (item.getOpacity() > 0 && !item.getFullyLoaded()) {
                return false;
            }
        }
        return true;
    }, null, {timeout: 20000});
}

async function runOne(browser, fixture, options, mode, iteration, traceThisRun) {
    const context = await browser.newContext({
        viewport: {width: 1440, height: 900},
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        serviceWorkers: 'allow',
    });
    await context.addInitScript((selectedMode) => {
        window.FANMAP42_PERFORMANCE_MODE = selectedMode;
    }, mode);
    const page = await context.newPage();
    if (mode === 'adaptive' && options.transientFailures > 0) {
        fixture.armTransientFailures(options.transientFailures);
    }
    const consoleErrors = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(fixture.origin, {waitUntil: 'domcontentloaded', timeout: 20000});
    try {
        await waitForViewer(page);
    } catch (error) {
        const state = await page.evaluate(() => ({
            mode: window.fanmapPerformance?.snapshot?.(),
            worldItems: window.g?.viewer?.world?.getItemCount?.() ?? null,
            fullyLoaded: window.g?.viewer?.world ? Array.from(
                {length: window.g.viewer.world.getItemCount()},
                (_, index) => window.g.viewer.world.getItemAt(index).getFullyLoaded(),
            ) : [],
            output: document.getElementById('main_output')?.textContent || '',
        })).catch(() => null);
        await page.screenshot({
            path: join(options.outdir, `startup-failure-${mode}.png`),
            fullPage: true,
        }).catch(() => {});
        throw new Error(`${error.message}\nStartup state: ${JSON.stringify(state)}\n` +
            `Origin: ${JSON.stringify(fixture.snapshot())}\nConsole: ${JSON.stringify(consoleErrors)}`);
    }
    const dismiss = page.locator('.banner-dismiss');
    if (await dismiss.isVisible()) {
        await dismiss.click();
    }
    await page.waitForFunction(() => Array.isArray(window.g?.poiMarkers) && window.g.poiMarkers.length > 1000, null, {
        timeout: 10000,
    });
    await moveToBenchmarkStart(page);
    await page.waitForFunction(() => {
        const loader = window.fanmapPerformance.snapshot().loader;
        return !loader || loader.inFlight === 0 && loader.queued === 0;
    }, null, {timeout: 10000});
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
        const loader = window.fanmapPerformance.snapshot().loader;
        return !loader || loader.inFlight === 0 && loader.queued === 0;
    }, null, {timeout: 10000});
    const failureProbe = fixture.snapshot();
    if (mode === 'adaptive' && options.transientFailures > 0 &&
        (failureProbe.transientFailures !== options.transientFailures ||
            failureProbe.recoveredTransientTiles !== options.transientFailures)) {
        throw new Error(`Transient failure recovery incomplete: ${JSON.stringify(failureProbe)}`);
    }
    await page.evaluate(() => window.fanmapPerformance.controller.resetMeasurements());
    fixture.reset();
    const before = metricMap((await cdp.send('Performance.getMetrics')).metrics);
    let tracePath = null;
    if (traceThisRun) {
        tracePath = join(options.outdir, `chrome-${mode}.json`);
        await browser.startTracing(page, {
            path: tracePath,
            screenshots: false,
            categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing'],
        });
    }
    const path = await runScriptedPath(page, {profile: options.profile});
    await page.waitForFunction(() => !window.fanmapPerformance.snapshot().fastMotion, null, {timeout: 5000});
    await page.waitForFunction(() => {
        const interactions = window.fanmapPerformance.snapshot().interactions;
        return interactions.length > 0 && interactions.at(-1).sharpnessMs !== null;
    }, null, {timeout: 5500}).catch(() => {});
    const after = metricMap((await cdp.send('Performance.getMetrics')).metrics);
    if (traceThisRun) {
        await browser.stopTracing();
    }
    const viewer = await page.evaluate(() => window.fanmapPerformance.exportTrace());
    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('_files/'))
        .map((entry) => ({
            name: entry.name,
            duration: entry.duration,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
        })));
    const origin = fixture.snapshot();
    const result = {
        mode,
        iteration,
        path,
        viewer,
        chrome: deltaMetrics(before, after),
        origin,
        failureProbe,
        resources,
        consoleErrors,
        tracePath,
    };
    await context.close();
    return result;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await mkdir(options.outdir, {recursive: true});
    const scratch = await mkdtemp(join(tmpdir(), 'fanmap42-viewer-perf-'));
    const configFile = join(scratch, 'config.json');
    const webRoot = join(scratch, 'viewer');
    const config = {
        route: {default: '/fixture/map_data/'},
        dzi_sources: {
            'base/layer0': {
                width: 16384,
                height: 8192,
                tile_size: 256,
                tile_overlap: 0,
                file_format: 'png',
            },
        },
        features: {marker: true, grid: true, trimmer: false},
        performance: {
            mode: 'baseline',
            initialConcurrency: 6,
            minConcurrency: 4,
            maxConcurrency: 8,
            initialMaxTilesPerFrame: 2,
            maxTilesPerFrame: 4,
        },
    };
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await run(process.execPath, [
        'scripts/build_viewer.mjs',
        '--outdir', webRoot,
        '--config', configFile,
    ]);
    const fixture = await startFixtureServer({
        webRoot,
        latencyMs: options.latencyMs,
        jitterMs: options.jitterMs,
    });
    let browser;
    try {
        browser = await chromium.launch({
            executablePath: options.chrome,
            headless: !options.headed,
            args: [
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--force-device-scale-factor=1',
            ],
        });
        const runs = [];
        for (let iteration = 0; iteration < options.iterations; iteration += 1) {
            const order = iteration % 2 === 0 ? ['baseline', 'adaptive'] : ['adaptive', 'baseline'];
            for (const mode of order) {
                process.stdout.write(`Running pair ${iteration + 1}/${options.iterations}: ${mode}\n`);
                const traceThisRun = options.trace && !runs.some((run) => run.mode === mode && run.tracePath);
                const result = await runOne(browser, fixture, options, mode, iteration, traceThisRun);
                runs.push(result);
                await writeFile(
                    join(options.outdir, `run-${String(iteration + 1).padStart(2, '0')}-${mode}.json`),
                    `${JSON.stringify(result, null, 2)}\n`,
                );
            }
        }
        const summary = {
            schema: 'fanmap42.viewer-benchmark.v1',
            generatedAt: new Date().toISOString(),
            chrome: options.chrome,
            iterations: options.iterations,
            fixture: {
                latencyMs: options.latencyMs,
                jitterMs: options.jitterMs,
                transientFailures: options.transientFailures,
                viewport: [1440, 900],
                profile: options.profile,
            },
            aggregate: aggregate(runs),
            runs: runs.map((run) => ({
                mode: run.mode,
                iteration: run.iteration,
                metrics: extractRunMetrics(run),
                loader: run.viewer.loader,
                consoleErrors: run.consoleErrors,
            })),
        };
        await writeFile(join(options.outdir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        const markdown = comparisonMarkdown(summary);
        await writeFile(join(options.outdir, 'comparison.md'), markdown);
        process.stdout.write(`\n${markdown}\nResults: ${options.outdir}\n`);
    } finally {
        await browser?.close();
        await fixture.close();
        if (options.keepBuild) {
            const retained = join(options.outdir, 'viewer-build-path.txt');
            await writeFile(retained, `${webRoot}\n`);
        } else {
            await rm(scratch, {recursive: true, force: true});
        }
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
