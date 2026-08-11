import assert from 'node:assert/strict';
import test from 'node:test';

import {installWebGLFallback, selectViewerRenderer} from '../html/pzmap/rendering.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function fakeDocument({renderer = 'ANGLE (Apple, Apple M3, OpenGL 4.1)', textureSize = 16384} = {}) {
    const gl = {
        MAX_TEXTURE_SIZE: 1,
        MAX_RENDERBUFFER_SIZE: 2,
        isContextLost: () => false,
        getExtension(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return {UNMASKED_RENDERER_WEBGL: 3};
            }
            if (name === 'WEBGL_lose_context') {
                return {loseContext() {}};
            }
            return null;
        },
        getParameter(name) {
            if (name === 1 || name === 2) return textureSize;
            if (name === 3) return renderer;
            return null;
        },
    };
    return {
        createElement() {
            return {getContext: () => gl};
        },
    };
}

function environment(navigator, document = fakeDocument()) {
    return {navigator, document};
}

function webglConfig(approved = ['Apple M3']) {
    return {
        performance: {
            renderer: 'conservative-webgl',
            webgl_renderer_allowlist: approved,
        },
    };
}

test('qualifies only a capable desktop Chromium WebGL implementation', () => {
    const result = selectViewerRenderer(webglConfig(), environment({
        userAgent: CHROME,
        deviceMemory: 8,
        hardwareConcurrency: 10,
        userAgentData: {mobile: false},
    }));
    assert.equal(result.drawer, 'webgl');
    assert.equal(result.qualified, true);
    assert.equal(result.reason, 'qualified');
    assert.equal(result.maximumTextureSize, 16384);
});

test('keeps Canvas on Safari and every mobile Apple presentation', () => {
    const desktopSafari = selectViewerRenderer(webglConfig(), environment({
        userAgent: SAFARI,
        deviceMemory: 8,
        hardwareConcurrency: 10,
    }));
    assert.equal(desktopSafari.drawer, 'canvas');
    assert.equal(desktopSafari.reason, 'safari');

    const mobileSafari = selectViewerRenderer(webglConfig(), environment({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1',
        deviceMemory: 8,
        hardwareConcurrency: 10,
        userAgentData: {mobile: true},
    }));
    assert.equal(mobileSafari.drawer, 'canvas');
    assert.equal(mobileSafari.reason, 'mobile-browser');

    const desktopModeIPad = selectViewerRenderer(webglConfig(), environment({
        userAgent: SAFARI,
        platform: 'MacIntel',
        maxTouchPoints: 5,
        deviceMemory: 8,
        hardwareConcurrency: 10,
    }));
    assert.equal(desktopModeIPad.drawer, 'canvas');
    assert.equal(desktopModeIPad.reason, 'mobile-browser');
});

test('keeps Canvas when browser or hardware confidence is insufficient', () => {
    const firefox = selectViewerRenderer(webglConfig(), environment({
        userAgent: 'Mozilla/5.0 Firefox/141.0',
        deviceMemory: 8,
        hardwareConcurrency: 10,
    }));
    assert.equal(firefox.reason, 'browser-not-allowlisted');

    const unknownMemory = selectViewerRenderer(webglConfig(), environment({
        userAgent: CHROME,
        hardwareConcurrency: 10,
    }));
    assert.equal(unknownMemory.reason, 'insufficient-or-unknown-memory');

    const smallTexture = selectViewerRenderer(webglConfig(), environment({
        userAgent: CHROME,
        deviceMemory: 8,
        hardwareConcurrency: 10,
    }, fakeDocument({textureSize: 4096})));
    assert.equal(smallTexture.reason, 'texture-size');

    const software = selectViewerRenderer(webglConfig(['SwiftShader']), environment({
        userAgent: CHROME,
        deviceMemory: 8,
        hardwareConcurrency: 10,
    }, fakeDocument({renderer: 'ANGLE (Google, Vulkan SwiftShader)'})));
    assert.equal(software.reason, 'software-renderer');
});

test('defaults to Canvas and requires a measured renderer allowlist', () => {
    const navigator = {
        userAgent: CHROME,
        deviceMemory: 8,
        hardwareConcurrency: 10,
    };
    const defaultResult = selectViewerRenderer({}, environment(navigator));
    assert.equal(defaultResult.drawer, 'canvas');
    assert.equal(defaultResult.reason, 'canvas-configured');

    const unmeasured = selectViewerRenderer(webglConfig([]), environment(navigator));
    assert.equal(unmeasured.drawer, 'canvas');
    assert.equal(unmeasured.reason, 'renderer-not-approved');
});

test('honors explicit Canvas configuration without probing WebGL', () => {
    const result = selectViewerRenderer({performance: {renderer: 'canvas'}}, {
        navigator: {
            userAgent: CHROME,
            deviceMemory: 8,
            hardwareConcurrency: 10,
        },
        document: {
            createElement() {
                throw new Error('WebGL should not be probed');
            },
        },
    });
    assert.equal(result.drawer, 'canvas');
    assert.equal(result.reason, 'canvas-configured');
});

test('falls back to Canvas after a WebGL drawer error', async () => {
    const handlers = new Map();
    let requested = null;
    const viewer = {
        drawer: {_renderingCanvas: {addEventListener() {}, removeEventListener() {}}},
        addHandler(name, handler) { handlers.set(name, handler); },
        removeHandler(name) { handlers.delete(name); },
        requestDrawer(name) {
            requested = name;
            return {};
        },
    };
    const assessment = {drawer: 'webgl', qualified: true};
    const cleanup = installWebGLFallback(viewer, assessment);
    handlers.get('drawer-error')({error: 'tainted tile'});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requested, 'canvas');
    assert.equal(assessment.drawer, 'canvas');
    assert.equal(assessment.qualified, false);
    assert.equal(assessment.fallbackReason, 'tainted tile');
    cleanup();
});
