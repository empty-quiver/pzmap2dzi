Based on OpenSeadragon 6.0.2, the following function behavior has been modified to meet pzmap2dzi requirements.
- Drawer._clipWithPolygons

* Diff details
```
--- openseadragon.js
+++ openseadragon-modify.js
@@ -24002,14 +24002,14 @@
      */
     _clipWithPolygons (polygons, useSketch) {
         const context = this._getContext(useSketch);
-        context.beginPath();
         for(const polygon of polygons){
+            context.beginPath();
             for(const [i, coord] of polygon.entries() ){
                 context[i === 0 ? 'moveTo' : 'lineTo'](coord.x, coord.y);
             }
+            context.clip();
         }

-        context.clip();
     }

     /**

```
