const MIN_DEVICE_MEMORY_GIB = 4;
const MIN_HARDWARE_THREADS = 4;
const MIN_TEXTURE_SIZE = 8192;

function rendererMode(config, override = globalThis.window?.FANMAP42_RENDERER_MODE) {
    if (override === 'canvas') {
        return 'canvas';
    }
    if (override === 'webgl-test') {
        return 'webgl-test';
    }
    if (config?.performance?.webgl === false || config?.performance?.renderer === 'canvas') {
        return 'canvas';
    }
    return config?.performance?.renderer === 'conservative-webgl' ?
        'conservative-webgl' : 'canvas';
}

function mobileOrWebKitBrowser(navigatorObject) {
    const userAgent = String(navigatorObject?.userAgent || '');
    const mobile = navigatorObject?.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
        navigatorObject?.platform === 'MacIntel' && Number(navigatorObject?.maxTouchPoints) > 1;
    const safari = /Safari\//.test(userAgent) &&
        !/(?:Chrome|Chromium|CriOS|Edg|OPR)\//.test(userAgent);
    return {mobile, safari, userAgent};
}

function chromiumDesktop(userAgent) {
    return /(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent) &&
        !/(?:CriOS|EdgiOS|OPiOS)\//.test(userAgent);
}

function safeParameter(gl, name) {
    try {
        return gl.getParameter(name);
    } catch {
        return null;
    }
}

function inspectContext(documentObject) {
    const canvas = documentObject.createElement('canvas');
    let gl = null;
    try {
        gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            depth: false,
            failIfMajorPerformanceCaveat: true,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
            stencil: false,
        });
        if (!gl || gl.isContextLost?.()) {
            return {supported: false, reason: 'webgl-context-unavailable'};
        }
        const debug = gl.getExtension?.('WEBGL_debug_renderer_info');
        const renderer = debug ? safeParameter(gl, debug.UNMASKED_RENDERER_WEBGL) : null;
        const maximumTextureSize = Number(safeParameter(gl, gl.MAX_TEXTURE_SIZE));
        const maximumRenderbufferSize = Number(safeParameter(gl, gl.MAX_RENDERBUFFER_SIZE));
        const softwareRenderer = /SwiftShader|llvmpipe|software|Microsoft Basic Render/i.test(
            String(renderer || ''),
        );
        return {
            supported: !softwareRenderer && maximumTextureSize >= MIN_TEXTURE_SIZE &&
                maximumRenderbufferSize >= MIN_TEXTURE_SIZE,
            reason: softwareRenderer ? 'software-renderer' :
                maximumTextureSize < MIN_TEXTURE_SIZE ? 'texture-size' :
                maximumRenderbufferSize < MIN_TEXTURE_SIZE ? 'renderbuffer-size' : 'qualified',
            renderer: renderer || 'unavailable',
            maximumTextureSize,
            maximumRenderbufferSize,
        };
    } catch {
        return {supported: false, reason: 'webgl-probe-failed'};
    } finally {
        try {
            gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
        } catch {
            // The probe context is short-lived even when explicit release is unavailable.
        }
    }
}

export function selectViewerRenderer(config = {}, environment = {}) {
    const navigatorObject = environment.navigator ?? globalThis.navigator;
    const documentObject = environment.document ?? globalThis.document;
    const mode = rendererMode(config, environment.override);
    const result = {
        requestedMode: mode,
        drawer: 'canvas',
        qualified: false,
        reason: 'canvas-default',
    };
    if (mode === 'canvas') {
        result.reason = 'canvas-configured';
        return result;
    }
    const browser = mobileOrWebKitBrowser(navigatorObject);
    if (browser.mobile) {
        result.reason = 'mobile-browser';
        return result;
    }
    if (browser.safari) {
        result.reason = 'safari';
        return result;
    }
    if (!chromiumDesktop(browser.userAgent)) {
        result.reason = 'browser-not-allowlisted';
        return result;
    }
    const deviceMemory = Number(navigatorObject?.deviceMemory);
    const hardwareConcurrency = Number(navigatorObject?.hardwareConcurrency);
    result.deviceMemory = Number.isFinite(deviceMemory) ? deviceMemory : null;
    result.hardwareConcurrency = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : null;
    if (!Number.isFinite(deviceMemory) || deviceMemory < MIN_DEVICE_MEMORY_GIB) {
        result.reason = 'insufficient-or-unknown-memory';
        return result;
    }
    if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency < MIN_HARDWARE_THREADS) {
        result.reason = 'insufficient-or-unknown-cpu';
        return result;
    }
    if (!documentObject?.createElement) {
        result.reason = 'document-unavailable';
        return result;
    }
    const context = inspectContext(documentObject);
    Object.assign(result, context);
    if (!context.supported) {
        result.reason = context.reason;
        return result;
    }
    if (mode !== 'webgl-test') {
        const approvedRenderers = Array.isArray(config?.performance?.webgl_renderer_allowlist) ?
            config.performance.webgl_renderer_allowlist : [];
        const renderer = String(context.renderer || '');
        const approved = renderer !== 'unavailable' && approvedRenderers.some((candidate) =>
            typeof candidate === 'string' && candidate.length > 0 &&
            renderer.toLowerCase().includes(candidate.toLowerCase()),
        );
        if (!approved) {
            result.reason = 'renderer-not-approved';
            return result;
        }
    }
    result.drawer = 'webgl';
    result.qualified = true;
    result.reason = 'qualified';
    return result;
}

export function installWebGLFallback(viewer, assessment) {
    if (assessment.drawer !== 'webgl') {
        return () => {};
    }
    let fallbackPending = false;
    let destroyed = false;
    const switchToCanvas = (reason) => {
        if (destroyed || fallbackPending || assessment.drawer !== 'webgl') {
            return;
        }
        fallbackPending = true;
        setTimeout(() => {
            fallbackPending = false;
            if (destroyed || assessment.drawer !== 'webgl') {
                return;
            }
            const replacement = viewer.requestDrawer?.('canvas', {mainDrawer: true});
            if (replacement) {
                assessment.drawer = 'canvas';
                assessment.qualified = false;
                assessment.fallbackReason = reason;
            }
        }, 0);
    };
    const drawerError = (event) => switchToCanvas(event?.error || 'drawer-error');
    const contextLost = (event) => {
        event?.preventDefault?.();
        switchToCanvas('webgl-context-lost');
    };
    viewer.addHandler?.('drawer-error', drawerError);
    const renderingCanvas = viewer.drawer?._renderingCanvas;
    renderingCanvas?.addEventListener?.('webglcontextlost', contextLost);
    return () => {
        destroyed = true;
        viewer.removeHandler?.('drawer-error', drawerError);
        renderingCanvas?.removeEventListener?.('webglcontextlost', contextLost);
    };
}
