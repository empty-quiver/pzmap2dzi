# Viewer performance experiments

The adaptive viewer prototype is disabled by default. It adds frame, coverage,
and sharpness telemetry; freezes marker and label reconstruction during fast
movement; prioritizes tiles in the direction of travel; cancels obsolete work;
and adjusts loader concurrency and `maxTilesPerFrame` from recent frame time and
queue pressure. Only queued obsolete work is discarded. In-flight requests
finish, and transient failures are retried without marking a tile permanently
missing. Immutable responses use the browser's HTTP cache while OpenSeadragon
retains its decoded-image cache.

The viewer defaults to Canvas rendering. A release may set
`performance.renderer` to `conservative-webgl`, but WebGL is selected only on
a desktop Chromium browser that reports at least 4 GiB of device memory, four
hardware threads, sufficiently large texture limits, a non-software WebGL
implementation, and a renderer named in `performance.webgl_renderer_allowlist`.
Safari, iOS/iPadOS, mobile browsers, unknown capability profiles, and
unmeasured renderers remain on Canvas. A WebGL drawer error or context loss
switches the running viewer back to Canvas.

Set `window.FANMAP42_PERFORMANCE_MODE = 'adaptive'` before the viewer starts to
enable it. A release can instead set `performance.mode` to `adaptive` in
`pzmap_config.json`.

## Benchmark

The benchmark builds the real viewer once, starts a deterministic local tile
origin, and drives an installed Chrome with real pointer and wheel input. Each
pair uses the same viewport, tile bytes, latency, and scripted path. Baseline and
adaptive order alternates between pairs to limit warm-up bias.

```sh
npm install
npm test
npm run perf:viewer -- --iterations 7
```

Use `--renderer canvas` to force the Canvas control or `--renderer webgl` for a
test-only WebGL run that still applies all hardware checks except the production
renderer allowlist. The default `auto` value exercises the release config.

Use the high-latency fling profile to exercise queue cancellation and
back-pressure:

```sh
npm run perf:viewer -- \
  --iterations 7 --profile fling --latency-ms 500 --jitter-ms 20 \
  --transient-failures 4
```

Results go to `performance-results/` and include every raw run, an aggregate
JSON file, and a Markdown comparison. Add `--trace` for one Chrome trace per
mode or `--headed` to watch the path.

The local origin makes A/B runs reproducible; it does not model Cloudflare
network variance or a particular user's GPU. Treat one pair as a smoke test.
Use at least five pairs for comparisons and inspect the paired bootstrap
confidence intervals before calling a result an improvement.
