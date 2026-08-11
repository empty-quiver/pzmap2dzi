#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {
    access,
    cp,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {transform} from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'html');
const startupModules = [
    'pzmap/globals.js',
    'pzmap/map.js',
    'pzmap/coordinates.js',
    'pzmap/marker.js',
    'pzmap/i18n.js',
    'pzmap/util.js',
    'pzmap/ui.js',
    'pzmap/mark/svg_draw.js',
    'pzmap/mark/osd_draw.js',
    'pzmap/search.js',
    'pzmap/tile-existence.js',
    'pzmap/performance.js',
    'pzmap/rendering.js',
];

function usage() {
    return [
        'Usage: npm run build:viewer -- --outdir DIR [--config FILE] [--asset-base URL_PATH]',
        '',
        'Builds the browser viewer from html/, extracts the patched OpenSeadragon',
        'distribution, minifies JavaScript and CSS, and injects release-specific',
        'startup hints when a config is supplied.',
    ].join('\n');
}

function parseArgs(argv) {
    const options = {assetBase: ''};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        }
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for ${arg}`);
        }
        if (arg === '--outdir') {
            options.outdir = resolve(value);
        } else if (arg === '--config') {
            options.config = resolve(value);
        } else if (arg === '--asset-base') {
            options.assetBase = value;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
        i += 1;
    }
    if (!options.outdir) {
        throw new Error('--outdir is required');
    }
    if (options.assetBase && !options.assetBase.endsWith('/')) {
        throw new Error('--asset-base must be empty or end with /');
    }
    return options;
}

function run(command, args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {stdio: 'inherit'});
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolvePromise();
                return;
            }
            reject(new Error(`${command} exited with ${code ?? signal}`));
        });
    });
}

async function filesBelow(root) {
    const files = [];
    async function visit(directory) {
        const entries = await readdir(directory, {withFileTypes: true});
        for (const entry of entries) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(file);
            } else if (entry.isFile()) {
                files.push(file);
            }
        }
    }
    await visit(root);
    return files;
}

function mapRelease(config) {
    const route = config?.route?.default;
    if (typeof route !== 'string') {
        return null;
    }
    const match = route.match(/\/releases\/([^/]+)\/map_data\/?(?:[?#]|$)/);
    return match ? decodeURIComponent(match[1]) : null;
}

function versionedManifestUrl(path, release) {
    if (typeof path !== 'string' || path.length === 0) {
        return null;
    }
    if (!release) {
        return path;
    }
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}release=${encodeURIComponent(release)}`;
}

function escapeAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function resourceHints(config, assetBase) {
    const origins = new Set();
    for (const candidate of [
        config?.route?.default,
        config?.hot_tile_origin,
        config?.cumulative_floor_root,
    ]) {
        if (typeof candidate !== 'string') {
            continue;
        }
        try {
            const url = new URL(candidate);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                origins.add(url.origin);
            }
        } catch {
            // Relative routes do not need a separate connection.
        }
    }
    const lines = [...origins].map((origin) =>
        `<link rel="preconnect" href="${escapeAttribute(origin)}" crossorigin>`,
    );
    for (const module of startupModules) {
        lines.push(
            `<link rel="modulepreload" href="${escapeAttribute(assetUrl(assetBase, module))}">`,
        );
    }
    const manifest = versionedManifestUrl(
        config?.tile_existence_manifest,
        mapRelease(config),
    );
    if (manifest) {
        lines.push(
            `<link rel="preload" href="${escapeAttribute(manifest)}" as="fetch" crossorigin fetchpriority="high">`,
        );
    }
    const cumulativeManifest = versionedManifestUrl(
        config?.cumulative_floor_manifest,
        mapRelease(config),
    );
    if (cumulativeManifest) {
        lines.push(
            `<link rel="preload" href="${escapeAttribute(cumulativeManifest)}" as="fetch" crossorigin fetchpriority="high">`,
        );
    }
    return lines.join('\n    ');
}

function inlineConfig(config) {
    if (!config) {
        return '';
    }
    const encoded = JSON.stringify(config).replaceAll('<', '\\u003c');
    return `<script>window.FANMAP42_CONFIG=${encoded};</script>`;
}

function assetUrl(assetBase, path) {
    return assetBase ? `${assetBase}${path}` : path;
}

async function rewriteHtml(directory, config, assetBase) {
    const filename = join(directory, 'pzmap.html');
    let html = await readFile(filename, 'utf8');
    const hints = resourceHints(config, assetBase);
    html = html.replace(
        '<!-- fanmap42-build:resource-hints -->',
        hints || '<!-- fanmap42-build:resource-hints -->',
    );
    const bootstrap = inlineConfig(config);
    html = html.replace(
        '<!-- fanmap42-build:bootstrap-config -->',
        bootstrap || '<!-- fanmap42-build:bootstrap-config -->',
    );
    html = html.replace(
        'window.FANMAP42_CLIENT_ASSET_BASE = "";',
        `window.FANMAP42_CLIENT_ASSET_BASE = ${JSON.stringify(assetBase)};`,
    );
    const assets = [
        'map.png',
        'pzmap.css',
        'pzmap.js',
        'openseadragon/openseadragon.js',
    ];
    for (const asset of assets) {
        html = html.replaceAll(`"${asset}"`, `"${assetUrl(assetBase, asset)}"`);
    }
    await writeFile(filename, html);
}

async function minifyAssets(directory) {
    const files = await filesBelow(directory);
    for (const filename of files) {
        const extension = filename.endsWith('.js') ? 'js' :
            filename.endsWith('.css') ? 'css' : null;
        if (!extension) {
            continue;
        }
        const source = await readFile(filename, 'utf8');
        const result = await transform(source, {
            charset: 'utf8',
            legalComments: 'inline',
            loader: extension,
            minify: true,
            target: 'es2020',
        });
        await writeFile(filename, result.code);
    }
}

async function exists(pathname) {
    try {
        await access(pathname);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!isAbsolute(options.outdir) || options.outdir === projectRoot ||
        options.outdir === sourceDir) {
        throw new Error('Refusing unsafe output directory');
    }
    if (await exists(options.outdir)) {
        throw new Error(`Output directory already exists: ${options.outdir}`);
    }
    if (options.config) {
        const configStat = await stat(options.config);
        if (!configStat.isFile()) {
            throw new Error(`Config is not a file: ${options.config}`);
        }
    }

    await mkdir(dirname(options.outdir), {recursive: true});
    const scratch = await mkdtemp(join(tmpdir(), `${basename(options.outdir)}-`));
    try {
        await cp(sourceDir, scratch, {recursive: true});
        await run('unzip', [
            '-q',
            '-o',
            join(sourceDir, 'openseadragon', 'openseadragon.zip'),
            '-d',
            join(scratch, 'openseadragon'),
        ]);
        const i18nTool = join(projectRoot, 'pzmap2dzi', 'i18n_util.py');
        const i18nDirectory = join(scratch, 'pzmap', 'i18n');
        await run('python3', [i18nTool, join(i18nDirectory, 'i18n.yaml')]);
        await run('python3', [i18nTool, join(i18nDirectory, 'marks.yaml')]);
        let config = null;
        if (options.config) {
            config = JSON.parse(await readFile(options.config, 'utf8'));
            await writeFile(
                join(scratch, 'pzmap_config.json'),
                `${JSON.stringify(config, null, 2)}\n`,
            );
        }
        await minifyAssets(scratch);
        await rewriteHtml(scratch, config, options.assetBase);
        await rename(scratch, options.outdir);
    } catch (error) {
        await rm(scratch, {recursive: true, force: true});
        throw error;
    }
    process.stdout.write(`Built viewer: ${options.outdir}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
