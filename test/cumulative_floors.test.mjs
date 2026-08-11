import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';


function run(command, args, cwd) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) resolvePromise(stdout);
            else reject(new Error(stderr || stdout || `${command} exited ${code}`));
        });
    });
}


test('builds only changed cumulative floor objects and records alpha coverage', async () => {
    const repo = resolve(import.meta.dirname, '..');
    const temporary = await mkdtemp(join(tmpdir(), 'fanmap-cumulative-'));
    const input = join(temporary, 'input');
    const output = join(temporary, 'output');
    const base = join(input, 'base');
    await mkdir(base, {recursive: true});
    await writeFile(join(base, 'layer0.dzi'), `<?xml version="1.0"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="4" Overlap="0" Format="jpg">
  <Size Width="8" Height="8"/>
</Image>`);
    const fixture = `
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(base)})
def tile(floor, name, rgba):
    path = root / f'layer{floor}_files' / '3' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new('RGBA', (4, 4), (0, 0, 0, 0))
    image.putpixel((0, 0), rgba)
    image.save(path, 'WEBP', quality=80, method=6, exact=True)
tile(1, '0_0.webp', (255, 0, 0, 255))
tile(2, '0_0.webp', (0, 0, 255, 128))
tile(3, '1_0.webp', (0, 255, 0, 255))
`;
    await run('python3', ['-c', fixture], repo);
    await run('python3', [
        'scripts/build_cumulative_floors.py',
        '--input', input,
        '--output', output,
        '--release', 'cumulative-test',
        '--base-release', 'base-test',
        '--family', 'base',
        '--workers', '2',
    ], repo);

    await stat(join(output, 'base_cumulative/layer1_files/3/0_0.webp'));
    await stat(join(output, 'base_cumulative/layer2_files/3/0_0.webp'));
    await stat(join(output, 'base_cumulative/layer3_files/3/1_0.webp'));
    const manifest = JSON.parse(await readFile(join(output, 'cumulative-floor-v1.json')));
    assert.equal(manifest.schema, 'fanmap42.cumulative-floors.v1');
    assert.equal(manifest.base_release, 'base-test');
    assert.equal(manifest.tile_count, 3);
    assert.equal(manifest.delta_tile_count, 3);
    assert.deepEqual(manifest.families.base.changes['1']['3'], [[0, 0, 0]]);
    assert.deepEqual(manifest.families.base.changes['2']['3'], [[0, 0, 0]]);
    assert.deepEqual(manifest.families.base.changes['3']['3'], [[0, 1, 1]]);
    assert.deepEqual(manifest.families.base.coverage['2']['3'], [[0, 0, 1]]);

    const inspect = `
import json
from PIL import Image
image = Image.open(${JSON.stringify(join(output, 'base_cumulative/layer2_files/3/0_0.webp'))}).convert('RGBA')
print(json.dumps(image.getpixel((0, 0))))
`;
    const pixel = JSON.parse((await run('python3', ['-c', inspect], repo)).trim());
    assert.equal(pixel[3], 255);
    assert.ok(pixel[0] > 80 && pixel[2] > 80, `unexpected composite pixel ${pixel}`);
});
