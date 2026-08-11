export var g = {
    map_type: '',
    overlays: {},
    mapui: 0,
    gridui: 0,
    poisui: 1,
    poiMarkers: [],
    trimmerui: 0,
    markerui: 0,
    aboutui: 0,
    currentLayer: 0,
    zoomLevel: null,
    route: 'default',
    query_string: {},
    zoomInfo: {},
    conf: {}
};

function updateQueryString() {
    g.query_string = {};
    const params = location.search.slice(1).split('&');
    for (const kv of params) {
        const splitIndex = kv.indexOf('=');
        if (splitIndex > 0) {
            const k = kv.substring(0, splitIndex);
            const v = kv.substring(splitIndex + 1);
            g.query_string[k] = v;
        }
    }
    if (g.map_type === '') {
        // first time page load
        if (g.query_string.overlays) {
            const overlays = g.query_string.overlays.split(',');
            for (const type of overlays) {
                if (type === '') {
                    continue;
                }
                g.overlays[type] = 1;
            }
        }
    }
}

function loadConfig() {
    if (window.FANMAP42_CONFIG && typeof window.FANMAP42_CONFIG === 'object') {
        g.conf = window.FANMAP42_CONFIG;
        return Promise.resolve(g.conf);
    }
    const clientAssetBase = window.FANMAP42_CLIENT_ASSET_BASE || './';
    return window.fetch(`${clientAssetBase}pzmap_config.json`)
        .then((r) => r.json())
        .catch((e) => Promise.resolve({}))
        .then((data) => {
            g.conf = data;
            return Promise.resolve(data);
        });
}

export function viewerPerformanceOptions(navigatorObject = globalThis.navigator) {
    const deviceMemory = Number(navigatorObject?.deviceMemory);
    const mobile = navigatorObject?.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigatorObject?.userAgent || '');
    if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 2) {
        return {maxImageCacheCount: 32};
    }
    if (Number.isFinite(deviceMemory) && deviceMemory <= 4) {
        return {maxImageCacheCount: 64};
    }
    if (mobile) {
        return {maxImageCacheCount: 64};
    }
    return {maxImageCacheCount: 400};
}

export function reset() {
    g.viewer_performance?.destroy?.();
    g.viewer = 0;
    g.viewer_performance = 0;
    g.base_map = 0;
    g.mod_maps = [];
    g.roof_opacity = 0;
    g.minLayer = 0;
    g.maxLayer = 0;
    g.zoomLevel = null;
    g.grid = 0;
    g.sx = 0;
    g.sy = 0;
    g.zoomInfo = {};
    updateQueryString();
};

export function getRoot(name=null) {
    // Name is obtained in the following order of precedence:
    // 1. query string (online environment)
    // 2. g.route (offline environment, using selector)
    // 3. '' empty for default
    if (name === null) {
        name = g.query_string.map_name;
        if (!name) {
            name = g.route;
        }
        if (!name) {
            name = '';
        }
    }
    let path = name;
    const route = g.conf.route;
    if (route) {
        path = route[name];
    }
    if (!path) {
        path = name;
    }
    return path;
}

export function init() {
    return loadConfig();
}
