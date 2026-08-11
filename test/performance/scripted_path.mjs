async function drag(page, box, from, to, options = {}) {
    const steps = options.steps ?? 36;
    const stepDelayMs = options.stepDelayMs ?? 10;
    const startX = box.x + box.width * from[0];
    const startY = box.y + box.height * from[1];
    const endX = box.x + box.width * to[0];
    const endY = box.y + box.height * to[1];
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        await page.mouse.move(
            startX + (endX - startX) * progress,
            startY + (endY - startY) * progress,
        );
        await page.waitForTimeout(stepDelayMs);
    }
    await page.mouse.up();
}

async function zoom(page, box, delta, count = 4) {
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.48);
    for (let index = 0; index < count; index += 1) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(85);
    }
}

export async function runScriptedPath(page, options = {}) {
    const map = page.locator('#map_div');
    const box = await map.boundingBox();
    if (!box || box.width < 300 || box.height < 300) {
        throw new Error('Map viewport is not measurable');
    }
    const start = Date.now();
    const states = [];
    const sample = async (label) => {
        states.push(await page.evaluate((name) => {
            const viewport = window.g.viewer.viewport;
            const center = viewport.getCenter(true);
            return {
                label: name,
                center: [center.x, center.y],
                zoom: viewport.getZoom(true),
                minZoom: viewport.getMinZoom(),
                maxZoom: viewport.getMaxZoom(),
            };
        }, label));
    };
    await sample('start');
    if (options.profile === 'fling') {
        for (let index = 1; index <= 3; index += 1) {
            await drag(page, box, [0.86, 0.50], [0.14, 0.48], {steps: 9, stepDelayMs: 2});
            await page.waitForTimeout(25);
            await sample(`fling-forward-${index}`);
        }
        await drag(page, box, [0.14, 0.34], [0.86, 0.68], {steps: 9, stepDelayMs: 2});
        await page.waitForTimeout(25);
        await sample('fling-reverse');
        await page.waitForTimeout(options.settleMs ?? 2200);
        await sample('finish');
        return {durationMs: Date.now() - start, profile: 'fling', states};
    }
    await zoom(page, box, -480, 5);
    await page.waitForTimeout(220);
    await sample('zoom-in-1');
    await drag(page, box, [0.58, 0.52], [0.27, 0.51]);
    await page.waitForTimeout(120);
    await sample('pan-left');
    await drag(page, box, [0.48, 0.60], [0.70, 0.30], {steps: 42});
    await page.waitForTimeout(120);
    await sample('pan-diagonal-1');
    await zoom(page, box, -420, 3);
    await page.waitForTimeout(160);
    await sample('zoom-in-2');
    await drag(page, box, [0.62, 0.42], [0.31, 0.70], {steps: 44});
    await page.waitForTimeout(140);
    await sample('pan-diagonal-2');
    await drag(page, box, [0.40, 0.42], [0.74, 0.56], {steps: 40});
    await page.waitForTimeout(160);
    await sample('pan-right');
    await zoom(page, box, 480, 4);
    await page.waitForTimeout(options.settleMs ?? 1600);
    await sample('finish');
    return {durationMs: Date.now() - start, profile: 'standard', states};
}
