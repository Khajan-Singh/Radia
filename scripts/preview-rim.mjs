/**
 * Renders the real rim shader offscreen and writes a PNG, so the look can be
 * tuned without an overlay on the actual desktop.
 *
 *   npx electron scripts/preview-rim.mjs out.png [thickness] [glow] [colors]
 *
 * thickness/glow are 0-1 as stored in settings; colors is 1, 2 or 3.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// electron argv is [exe, script, ...args] when run unpackaged.
const args = process.argv.slice(process.defaultApp ? 2 : 1)
const out = resolve(args[0] ?? join(root, 'rim-preview.png'))
const thickness = Number(args[1] ?? 0.32)
const glow = Number(args[2] ?? 0.85)
const count = Number(args[3] ?? 2)

const WIDTH = 900
const HEIGHT = 560

const vert = readFileSync(join(root, 'src/renderer/overlay/rim.vert'), 'utf8')
const frag = readFileSync(join(root, 'src/renderer/overlay/rim.frag'), 'utf8')

// Mirrors the mapping in src/renderer/overlay/main.ts.
const THICKNESS_PX = { min: 2, max: 46 }
const SPILL_PX = { min: 8, max: 190 }

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  canvas{display:block;width:100vw;height:100vh}
</style></head>
<body><canvas id="c"></canvas><script>
const vertSource = ${JSON.stringify(vert)};
const fragSource = ${JSON.stringify(frag)};
const canvas = document.getElementById('c');
canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    document.title = 'SHADER ERROR: ' + gl.getShaderInfoLog(s);
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}

const p = gl.createProgram();
gl.attachShader(p, compile(gl.VERTEX_SHADER, vertSource));
gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSource));
gl.linkProgram(p);
if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
  document.title = 'LINK ERROR: ' + gl.getProgramInfoLog(p);
  throw new Error(gl.getProgramInfoLog(p));
}
gl.useProgram(p);
gl.bindVertexArray(gl.createVertexArray());

const loc = (n) => gl.getUniformLocation(p, n);
const colors = [0.92,0.16,0.38, 0.13,0.78,0.52, 0.30,0.42,0.95];
const centers = [0.17, 0.5, 0.83];

gl.uniform2f(loc('uRes'), ${WIDTH}, ${HEIGHT});
gl.uniform1f(loc('uTime'), 0.0);
gl.uniform3fv(loc('uColors'), new Float32Array(colors));
gl.uniform1fv(loc('uCenters'), new Float32Array(centers));
gl.uniform1i(loc('uCount'), ${count});
gl.uniform1f(loc('uThickness'), ${THICKNESS_PX.min + (THICKNESS_PX.max - THICKNESS_PX.min) * thickness});
gl.uniform1f(loc('uSpill'), ${SPILL_PX.min + (SPILL_PX.max - SPILL_PX.min) * glow});
gl.uniform1f(loc('uGlowStrength'), ${0.28 + glow * 0.34});
gl.uniform1f(loc('uCorner'), Math.min(${WIDTH}, ${HEIGHT}) * 0.05);
gl.uniform1f(loc('uOffset'), 0.0);
gl.uniform1f(loc('uIntensity'), 1.0);
gl.uniform1f(loc('uWarp'), 0.0);
gl.uniform2fv(loc('uPulses'), new Float32Array(16));
gl.uniform1f(loc('uPulseWidth'), 0.05);

gl.viewport(0, 0, ${WIDTH}, ${HEIGHT});
gl.clearColor(0, 0, 0, 0);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 3);
document.title = 'ok';
</script></body></html>`

app.disableHardwareAcceleration = undefined

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: { offscreen: true }
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  await new Promise((r) => setTimeout(r, 900))

  const title = win.webContents.getTitle()
  if (title !== 'ok') {
    console.error(decodeURIComponent(title))
    app.exit(1)
    return
  }

  const image = await win.webContents.capturePage()
  writeFileSync(out, image.toPNG())
  console.log(`wrote ${out}  (thickness=${thickness} glow=${glow} colors=${count})`)
  app.exit(0)
})
