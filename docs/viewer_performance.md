# Viewer performance experiments

The adaptive viewer prototype is disabled by default. It adds frame, coverage,
and sharpness telemetry; freezes marker and label reconstruction during fast
movement; prioritizes tiles in the direction of travel; cancels obsolete work;
and adjusts loader concurrency and `maxTilesPerFrame` from recent frame time and
queue pressure. Compressed tile responses use Cache Storage while OpenSeadragon
retains its decoded-image cache.

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

Use the high-latency fling profile to exercise cancellation and back-pressure:

```sh
npm run perf:viewer -- \
  --iterations 7 --profile fling --latency-ms 500 --jitter-ms 20
```

Results go to `performance-results/` and include every raw run, an aggregate
JSON file, and a Markdown comparison. Add `--trace` for one Chrome trace per
mode or `--headed` to watch the path. The adaptive run also reloads the page
after the measured path to prove that encoded responses survive after the
decoded OpenSeadragon cache is gone.

The local origin makes A/B runs reproducible; it does not model Cloudflare
network variance or a particular user's GPU. Treat one pair as a smoke test.
Use at least five pairs for comparisons and inspect the paired bootstrap
confidence intervals before calling a result an improvement.
