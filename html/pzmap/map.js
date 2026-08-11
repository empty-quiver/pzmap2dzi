import { g } from "./globals.js";
import { MarkManager } from "./marker.js";

let manifestGate = null;

export function setManifestGate(gate) {
    manifestGate = gate;
}

export function configuredDziOptions(conf, root, type, suffix, layer) {
    const source = `${type}${suffix}/layer${layer}`;
    const configured = conf?.dzi_sources?.[source];
    if (!configured || !Number.isInteger(configured.width) || configured.width <= 0 ||
        !Number.isInteger(configured.height) || configured.height <= 0 ||
        !Number.isInteger(configured.tile_size) || configured.tile_size <= 0 ||
        !Number.isInteger(configured.tile_overlap) || configured.tile_overlap < 0 ||
        typeof configured.file_format !== 'string' ||
        !/^[a-z0-9]+$/i.test(configured.file_format)) {
        return null;
    }
    return {
        width: configured.width,
        height: configured.height,
        tileSize: configured.tile_size,
        tileOverlap: configured.tile_overlap,
        tilesUrl: `${root}${source}_files/`,
        fileFormat: configured.file_format,
    };
}

function sourceAvailable(url) {
    return manifestGate?.sourceAvailable?.(url) !== false;
}

function optionalAssetAvailable(url) {
    return manifestGate?.optionalAssetAvailable?.(url) !== false;
}

const FLOOR_VIEWPORT_MARGIN = 0.4;
const FLOOR_VIEWPORT_THROTTLE_MS = 100;
const FLOOR_VIEWPORT_GRACE_MS = 1500;
const FLOOR_OCCUPANCY_LEVEL_OFFSET = 2;

export function imageRectToTileRect(rectangle, width, height, tileSize, levelOffset = 2) {
    if (!rectangle || ![width, height, tileSize].every(Number.isFinite) ||
        width <= 0 || height <= 0 || tileSize <= 0) {
        return null;
    }
    const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
    const level = Math.max(0, maxLevel - Math.max(0, Math.floor(levelOffset)));
    const scale = 2 ** (level - maxLevel);
    const left = Math.max(0, rectangle.x);
    const top = Math.max(0, rectangle.y);
    const right = Math.min(width, rectangle.x + rectangle.width);
    const bottom = Math.min(height, rectangle.y + rectangle.height);
    if (right <= left || bottom <= top) {
        return null;
    }
    return {
        level,
        minX: Math.floor(left * scale / tileSize),
        minY: Math.floor(top * scale / tileSize),
        maxX: Math.floor(Math.max(left, right - 1) * scale / tileSize),
        maxY: Math.floor(Math.max(top, bottom - 1) * scale / tileSize),
    };
}

export class Map {
    constructor(root, map_type, name, base_map=null) {
        this.layers = 0;
        this.tiles = [];
        this.overlays = {};
        this.marks = {};
        this.overlay_layer = 0;
        this.cell_rects = [];
        this.clip_list = [];
        this.info = {};
        this.map_info_promises = new globalThis.Map();
        this.available_types = [];
        this.selected_base_layer = 0;
        this.layer_last_relevant = new globalThis.Map();
        this.viewport_layer_refresh_timer = 0;
        this.viewport_layer_expiry_timer = 0;
        this.last_viewport_layer_refresh = 0;
        this.root = root;
        this.name = name;
        this.type = map_type;
        this.base_map = base_map;
        if (!this.base_map) {
            this.base_map = this;
        }
    }

    cell2pixel(cx, cy) {
        let x = this.x0;
        let y = this.y0;
        if (this.type == 'iso') {
            x += (cx - cy) * this.sqr * this.cell_size / 2;
            y += (cx + cy) * this.sqr * this.cell_size / 4;
        } else {
            x += cx * this.sqr * this.cell_size;
            y += cy * this.sqr * this.cell_size;
        }
        return {x: x, y: y};
    }

    getClipPoints(rects, remove=true) {
        let points = [];
        if (remove) {
            points.push({x: 0, y: 0});
            points.push({x: 0, y: this.h});
            points.push({x: this.w, y: this.h});
            points.push({x: this.w, y: 0});
        }
        points.push({x: 0, y: 0});
        for (let [x, y, w, h] of rects) {
            points.push(this.cell2pixel(x, y));
            points.push(this.cell2pixel(x + w, y));
            points.push(this.cell2pixel(x + w, y + h));
            points.push(this.cell2pixel(x, y + h));
            points.push(this.cell2pixel(x, y));
            points.push({x: 0, y: 0});
        }
        return points;
    }

    setClipByOtherMaps(maps, layer) {
        this.clip_list = [this.getClipPoints(this.cell_rects, false)];
        for (let i = maps.length - 1; i >= 0; i--) {
            let rlist = [];
            for (let r of maps[i].cell_rects) {
                for (let b of this.cell_rects) {
                    if (rectIntersect(b, r)) {
                        rlist.push(r);
                        break;
                    }
                }
            }
            if (rlist.length > 0) {
                this.clip_list.push(this.getClipPoints(rlist));
            }
        }
        
        for (let type of ['zombie', 'foraging']) {
            if (![undefined, 0, 'loading', 'delete'].includes(this.overlays[type])) {
                let clip_list = this.getClipList(this.info[type].scale, 0);
                this.overlays[type].setCroppingPolygons(clip_list);
            }
        }
        for (let type of ['rooms', 'objects']) {
            if (![undefined, 0, 'loading', 'delete'].includes(this.overlays[type])) {
                let clip_list = this.getClipList(this.info[type].scale, layer);
                this.overlays[type].setCroppingPolygons(clip_list);
            }
        }
    }

    getClipList(scale, layer) {
    let clip_list = [];
    let yshift = (this.type == 'top' ? 0 : 1.5 * this.base_map.sqr * layer);
    for (let clip of this.clip_list) {
        let points = [];
        for (let p of clip) {
            points.push({x: p.x / scale, y: (p.y - yshift) / scale})
        }
        clip_list.push(points);
    }
    return clip_list;
}

    getMapRoot() {
        return this.root;
        let prefix = 'maps/'+g.get['map_name']+'_';
			if (undefined == g.prefix){
				g.prefix = prefix;
			}
        if (this.base_map === this) {
            return prefix;
        }
        return prefix+'/mod_maps/' + this.name + '/'; 
    }

    getRelativePositionAndWidth(other_map) {
        let x = (this.x0 - other_map.x0) / this.scale;
        let y = (this.y0 - other_map.y0) / this.scale;
        let p = g.viewer.world.getItemAt(0).imageToViewportCoordinates(x, y);
        let width = other_map.w / this.w;
        return [p, width];
    }

    _load_tile(layer, opacity=1) {
        if (g.viewer) {
            let [p, width] = this.base_map.getRelativePositionAndWidth(this);
            if (layer < this.maxlayer && layer >= this.minlayer) {
                if (this.getTile(layer) == 0) {
                    const tileSource = this.root + 'base' + this.suffix + '/layer' + layer + '.dzi';
                    if (!sourceAvailable(tileSource)) {
                        return;
                    }
                    this.setTile(layer, 'loading');
                    g.viewer.addTiledImage({
                        tileSource: tileSource,
                        opacity: 1,
                        x: p.x,
                        y: p.y,
                        width: width,
                        success: (function (obj) {
                            if ([0, 'loading'].includes(this.getTile(layer))) {
                                this.setTile(layer, obj.item);
                                positionItem(obj.item, this.name, layer);
                                obj.item.setOpacity(opacity);
                            } else {
                                g.viewer.world.removeItem(obj.item);
                                if (this.getTile(layer) == 'delete') {
                                    this.setTile(layer, 0);
                                }
                            }
                        }).bind(this),
                        error: (function (e) {
                            if (['delete', 0, 'loading'].includes(this.getTile(layer))) {
                                this.setTile(layer, 0);
                            }
                        }).bind(this),
                    });
                } else {
                    if (!['delete', 'loading'].includes(this.getTile(layer))) {
                        this.getTile(layer).setOpacity(opacity);
                    }
                }
            }
        }
    }

    _load_overlay(type, layer) {
        if (g.viewer && layer < this.maxlayer && layer >= this.minlayer) {
            let [p, width] = this.base_map.getRelativePositionAndWidth(this);
            let shift = true;
            if (type == 'zombie' || type == 'foraging') {
                layer = 0;
                shift = false;
            }
            if (this.overlays[type] == 0) {
                const tileSource = this.root + type + this.suffix + '/layer' + layer + '.dzi';
                if (!sourceAvailable(tileSource)) {
                    return;
                }
                this.overlays[type] = 'loading';
                g.viewer.addTiledImage({
                    tileSource: tileSource,
                    opacity: 1,
                    x: p.x,
                    y: p.y,
                    width: width,
                    success: (function (obj) {
                        if ([0, 'loading'].includes(this.overlays[type])) {
                            this.overlays[type] = obj.item;
                            if (shift) {
                                let clip_list = this.getClipList(this.info[type].scale, layer);
                                this.overlays[type].setCroppingPolygons(clip_list);
                            } else {
                                let clip_list = this.getClipList(this.info[type].scale, 0);
                                this.overlays[type].setCroppingPolygons(clip_list);
                            }
                        } else {
                            g.viewer.world.removeItem(obj.item);
                            if (this.overlays[type] == 'delete') {
                                this.overlays[type] = 0;
                            }
                        }
                    }).bind(this),
                    error: (function (e) {
                        if (['delete', 0, 'loading'].includes(this.overlays[type])) {
                            this.overlays[type] = 0;
                        }
                    }).bind(this),
                });
            }
        }
    }

    _unload_tile(layer) {
        if (layer < this.maxlayer && layer >= this.minlayer && this.getTile(layer) != 0) {
            if (['loading', 'delete'].includes(this.getTile(layer))) {
                this.setTile(layer, 'delete');
            } else {
                g.viewer.world.removeItem(this.getTile(layer));
                this.setTile(layer, 0);
            }
        }
        return
    }

    _unload_overlay(type) {
        if (this.overlays[type]) {
            if (['loading', 'delete'].includes(this.overlays[type])) {
                this.overlays[type] = 'delete';
            } else {
                g.viewer.world.removeItem(this.overlays[type]);
                this.overlays[type] = 0;
            }
        }
    }

    _viewportTileRect() {
        if (this.base_map !== this || !g.viewer?.viewport || !this.w || !this.h) {
            return null;
        }
        const baseItem = this.getTile(0);
        if (!baseItem || ['loading', 'delete'].includes(baseItem) ||
            typeof baseItem.viewportToImageRectangle !== 'function') {
            return null;
        }
        const viewportBounds = g.viewer.viewport.getBounds?.(true);
        if (!viewportBounds) {
            return null;
        }
        const imageBounds = baseItem.viewportToImageRectangle(viewportBounds);
        if (!imageBounds || ![imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height]
            .every(Number.isFinite)) {
            return null;
        }
        const marginX = imageBounds.width * FLOOR_VIEWPORT_MARGIN;
        const marginY = imageBounds.height * FLOOR_VIEWPORT_MARGIN;
        const expanded = {
            x: imageBounds.x - marginX,
            y: imageBounds.y - marginY,
            width: imageBounds.width + marginX * 2,
            height: imageBounds.height + marginY * 2,
        };
        const tileSize = Number(baseItem.source?.tileSize) ||
            Number(baseItem.source?.getTileWidth?.(0)) || 1024;
        return imageRectToTileRect(
            expanded,
            this.w,
            this.h,
            tileSize,
            FLOOR_OCCUPANCY_LEVEL_OFFSET,
        );
    }

    _sourceIntersectsViewport(layer, tileRect) {
        if (!tileRect || typeof manifestGate?.sourceIntersectsTileRect !== 'function') {
            return null;
        }
        const descriptor = `${this.root}base${this.suffix}/layer${layer}.dzi`;
        return manifestGate.sourceIntersectsTileRect(descriptor, tileRect);
    }

    _applyBaseLayerVisibility(layer, respectGrace) {
        const now = globalThis.performance?.now?.() ?? Date.now();
        const tileRect = this._viewportTileRect();
        let nextExpiry = Infinity;
        let start = this.minlayer;
        if (layer >= 0) {
            start = 0;
        }
        for (let i = start; i < this.maxlayer; i++) {
            const isRoof = i === layer + 1 && g.roof_opacity > 0;
            if (i > layer && !isRoof) {
                this._unload_tile(i);
                this.layer_last_relevant.delete(i);
                continue;
            }

            // Layer zero anchors all map coordinate transforms and is never virtualized.
            let relevant = i === 0 ? true : this._sourceIntersectsViewport(i, tileRect);
            if (relevant !== false) {
                this.layer_last_relevant.set(i, now);
            } else if (respectGrace) {
                const lastRelevant = this.layer_last_relevant.get(i);
                const expiresAt = Number.isFinite(lastRelevant)
                    ? lastRelevant + FLOOR_VIEWPORT_GRACE_MS
                    : 0;
                if (expiresAt > now) {
                    relevant = true;
                    nextExpiry = Math.min(nextExpiry, expiresAt);
                }
            }

            if (relevant === false) {
                this._unload_tile(i);
            } else {
                this._load_tile(i, isRoof ? g.roof_opacity / 100 : 1);
            }
        }
        if (layer >= 0) {
            for (let i = this.minlayer; i < 0; i++) {
                this._unload_tile(i);
                this.layer_last_relevant.delete(i);
            }
        }

        clearTimeout(this.viewport_layer_expiry_timer);
        this.viewport_layer_expiry_timer = 0;
        if (Number.isFinite(nextExpiry)) {
            this.viewport_layer_expiry_timer = setTimeout(() => {
                this.viewport_layer_expiry_timer = 0;
                this.refreshBaseLayerVisibility();
            }, Math.max(0, nextExpiry - now + 1));
        }
        this.last_viewport_layer_refresh = now;
    }

    scheduleViewportLayerRefresh() {
        if (this.base_map !== this || this.viewport_layer_refresh_timer) {
            return;
        }
        const now = globalThis.performance?.now?.() ?? Date.now();
        const delay = Math.max(
            0,
            FLOOR_VIEWPORT_THROTTLE_MS - (now - this.last_viewport_layer_refresh),
        );
        this.viewport_layer_refresh_timer = setTimeout(() => {
            this.viewport_layer_refresh_timer = 0;
            this.refreshBaseLayerVisibility();
        }, delay);
    }

    refreshBaseLayerVisibility() {
        if (this.base_map === this) {
            this._applyBaseLayerVisibility(this.selected_base_layer, true);
        }
    }

    setTile(layer, tile) {
        this.tiles[layer - this.minlayer] = tile;
    }

    getTile(layer) {
        return this.tiles[layer - this.minlayer];
    }

    setBaseLayer(layer) {
        this.selected_base_layer = layer;
        if (this.base_map === this) {
            this._applyBaseLayerVisibility(layer, false);
            return;
        }
        let start = layer >= 0 ? 0 : this.minlayer;
        for (let i = start; i < this.maxlayer; i++) {
            const isRoof = i === layer + 1 && g.roof_opacity > 0;
            if (i > layer && !isRoof) {
                this._unload_tile(i);
            } else {
                this._load_tile(i, isRoof ? g.roof_opacity / 100 : 1);
            }
        }
    }

    setOverlayLayer(overlay, layer) {
        for (let type of ['zombie', 'foraging', 'rooms', 'objects']) {
            if (overlay[type]) {
                if (!['zombie', 'foraging'].includes(type)) {
                    if (layer != this.overlay_layer) {
                        this._unload_overlay(type);
                    }
                }
                this._load_overlay(type, layer);
            } else {
                this._unload_overlay(type);
            }
        }
        this.overlay_layer = layer;
        this.redrawMarks(overlay);
    }

    redrawMarks(overlay) {
        for (const type of ['base', 'zombie', 'foraging', 'rooms', 'objects', 'streets']) {
            if (this.marks[type]) {
                if (type === 'base' || overlay[type]) {
                    this.marks[type].enable();
                    this.marks[type].redrawAll();
                } else {
                    this.marks[type].disable();
                }
            }
        }
    }

    destroy() {
        clearTimeout(this.viewport_layer_refresh_timer);
        clearTimeout(this.viewport_layer_expiry_timer);
        this.setOverlayLayer({}, 0);
        for (let i = this.minlayer; i < this.maxlayer ; i++) {
            this._unload_tile(i);
        } 
    }

    getLayerRange() {
        let i = -1, j = 0;
        let root = this.root;
        let suffix = this.suffix;
        function getmax(r) {
            if (r.ok) {
                i += 1;
                return window.fetch(root + 'base' + suffix + '/layer' + i + '.dzi').then(getmax, getmax);
            } else {
                return Promise.resolve(i);
            }
        };
        function getmin(r) {
            if (r.ok) {
                j -= 1;
                return window.fetch(root + 'base' + suffix + '/layer' + j + '.dzi').then(getmin, getmin);
            } else {
                return Promise.resolve(j+1);
            }
        };

        let setrange = (function (r) {
            [this.minlayer, this.maxlayer] = r;
            return Promise.resolve(r);
        }).bind(this)
 
        return Promise.all([getmin({ok: 1}), getmax({ok: 1})]).then(setrange);
    }

    typeToSuffix(type) {
        return (type == 'top') ? '_top' : '';
    }

    getMapInfo(type, suffix) {
        const url = this.root + type + suffix + '/map_info.json';
        if (!this.map_info_promises.has(url)) {
            this.map_info_promises.set(url, window.fetch(url).then((response) => {
                if (!response.ok) {
                    throw new Error(`Map metadata HTTP ${response.status}: ${url}`);
                }
                return response.json();
            }));
        }
        return this.map_info_promises.get(url);
    }

    isTypeAvailable(type) {
        let suffix = this.typeToSuffix(type);
        return this.getMapInfo('base', suffix)
            .then((j) => Promise.resolve(type))
            .catch((e) => Promise.resolve(null));
    }

    availableTypes() {
        let t = [];
        for (let type of ['iso', 'top']) {
            t.push(this.isTypeAvailable(type));
        }
        return Promise.all(t).then((r) => {
            let types = [];
            for (let type of r) {
                if (type) {
                    types.push(type);
                }
            }
            this.available_types = types;
            return Promise.resolve(types);
        });
    }

    init() {
        return this.availableTypes().then((types) => {
            if (!this.type) {
                if (types.length) {
                    this.type = types[0];
                } else {
                    this.type = 'iso';
                }
            }
            return this.initMap();
        });
    }

    initMap() {
        this.suffix = this.typeToSuffix(this.type);

        const types = ['base', 'zombie', 'foraging'];
        if (this.type !== 'top') types.push('rooms', 'objects');
        const getinfo = (type) => {
            return this.getMapInfo(type, this.suffix)
                .catch((e) => Promise.resolve({}));
        };

        const setlayer = (r) => {
            this.minlayer = this.minlayer > 0 ? 0: this.minlayer;
            this.maxlayer = this.maxlayer < 1 ? 1: this.maxlayer;
            this.layers = this.maxlayer - this.minlayer;
            this.tiles = Array(this.layers).fill(0);
            return Promise.resolve(this);
        };

        const setinfo = (r) => {
            for (let i in types) {
                let type = types[i];
                this.info[type] = r[i];
                this.info[type].scale = 1;
                if ('skip' in r[i]) {
                    this.info[type].scale <<= r[i].skip;
                }
                if (type !== 'base') {
                    this.overlays[type] = 0;
                }
            }

            if (this.info.base.pz_version) {
                this.w = this.info.base.w * this.info.base.scale;
                this.h = this.info.base.h * this.info.base.scale;
                this.scale = this.info.base.scale;
                this.x0 = this.info.base.x0;
                this.y0 = this.info.base.y0;
                this.sqr = this.info.base.sqr;
                this.cell_rects = this.info.base.cell_rects;
                this.cell_size = this.info.base.cell_size;
                this.block_size = this.info.base.block_size;
                this.cell_in_block = this.cell_size / this.block_size;
                this.pz_version = this.info.base.pz_version;
                this.render_version = this.info.base.pzmap2dzi_version;
                this.branch = this.info.base.git_branch;
                this.commit = this.info.base.git_commit;
                this.minlayer = this.info.base.minlayer;
                this.maxlayer = this.info.base.maxlayer;
            }

            if (this.minlayer === undefined || this.maxlayer === undefined) {
                return this.getLayerRange();
            } else {
                return Promise.resolve([this.minlayer, this.maxlayer]);
            }
        };

        const markTypes = ['base', 'zombie', 'foraging', 'rooms', 'objects', 'streets'];
        const getmarks = (type) => {
            const marksUrl = this.root + type + '/marks.json'; // always use marks in folder without suffix
            if (!optionalAssetAvailable(marksUrl)) {
                return Promise.resolve(null);
            }
            return window.fetch(marksUrl)
                .then((r) => r.json()).catch((e) => Promise.resolve(null));
        };

        const setmarks = (r) => {
            const options = markTypes.map((t) => {
                const option = {
                    type: t,
                    mode: this.type,
                    onScreenLimit: g.query_string.mark_limit || 256,
                    indexType: 'rtree',
                    onlyCurrentLayer: true,
                    defaultValue: {
                        text_position: 'top',
                        background: 'transparent',
                        visible_zoom_level: 2,
                    },
                    renderOptions: { renderMethod: 'svg' },
                };
                if (t === 'streets') {
                    option.onlyCurrentLayer = false;
                    option.onScreenLimit = 0;
                    option.defaultValue.text_position = 'dynamic';
                    option.defaultValue.layer = 0;
                    option.renderOptions.formatterOptions = { hide_text_level: 1 };
                }
                return option;
            });
            const buildIndexOptions = options.map((o) => {
                const { onlyCurrentLayer, indexType, mode } = o;
                return { onlyCurrentLayer, indexType, mode, defaultValue: {
                    layer: o.defaultValue.layer || 0,
                    visible_zoom_level: o.defaultValue.visible_zoom_level || 0,
                } };
            });
            const worker = new Worker(new URL('./mark/loader.js', import.meta.url), {
                type: "module",
            });
            worker.postMessage([r, buildIndexOptions]);
            worker.onmessage = (e) => {
                const [r, indexes] = e.data;
                for (const i in markTypes) {
                    const type = markTypes[i];
                    if (!r[i] || !Array.isArray(r[i])) continue;
                    this.marks[type] = new MarkManager(options[i]);
                    this.marks[type].disable();
                    this.marks[type].load(r[i], indexes[i]);
                    console.log(`${this.root}${type} loaded (${r[i].length} marks)`);
                }
                this.redrawMarks(g.overlays);
                worker.terminate();
            };
            return Promise.resolve(this);
        };

        const getmarksAsync = (r) => {
            const pmarks = [];
            for (const type of markTypes) {
                pmarks.push(getmarks(type));
            }
            Promise.all(pmarks).then(setmarks);

            return Promise.resolve(r);
        }

        const ptypes = [];
        for (const type of types) {
            ptypes.push(getinfo(type));
        }
        return Promise.all(ptypes).then(setinfo).then(setlayer).then(getmarksAsync);
    }
};

// order layered maps
function positionItem(item, name, layer) {
    let pos = 1;
    for (let i = g.minLayer; i < g.maxLayer; i++) {
        if (name == '' && layer == i) {
            g.viewer.world.setItemIndex(item, pos);
            return;
        }
        if (![undefined, 0, 'loading', 'delete'].includes(g.base_map.getTile(i))) {
            pos++;
        }
        for (let j = 0; j < g.mod_maps.length; j++ ) {
            if (name == g.mod_maps[j].name && layer == i) {
                g.viewer.world.setItemIndex(item, pos);
                return;
            }
            if (![undefined, 0, 'loading', 'delete'].includes(g.mod_maps[j].getTile(i))) {
                pos++;
            }
        }
    }
}

function positionAll() {
    let pos = 1;
    for (let i = g.minLayer; i < g.maxLayer; i++) {
        if (![undefined, 0, 'loading', 'delete'].includes(g.base_map.getTile(i))) {
            g.viewer.world.setItemIndex(g.base_map.getTile(i), pos);
            pos++;
        }
        for (let j = 0; j < g.mod_maps.length; j++ ) {
            if (![undefined, 0, 'loading', 'delete'].includes(g.mod_maps[j].getTile(i))) {
                g.viewer.world.setItemIndex(g.mod_maps[j].getTile(i), pos);
                pos++;
            }
        }
    }
}

function rectIntersect(r1, r2) {
    let [x1, y1, w1, h1] = r1;
    let [x2, y2, w2, h2] = r2;
    return (x1 < x2 + w2) && (x2 < x1 + w1) && (y1 < y2 + h2) && (y2 < y1 + h1);
}
