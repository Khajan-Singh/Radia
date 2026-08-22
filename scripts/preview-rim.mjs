/**
 * Renders the real rim shader offscreen and writes a PNG, so the look can be
 * tuned without an overlay on the actual desktop.
 *
 *   npx electron scripts/preview-rim.mjs out.png [mode] [thickness] [colors] [phase] [amp] [head] [intensity]
 *
 *   mode       static | music | snake            (default static)
 *   thickness  0-1 as stored in settings         (default 0.6)
 *   colors     1, 2 or 3                         (default 2)
 *   phase      uWavePhase 0-1                    (default 0)
 *   amp        uWaveAmp 0-1; both music modes rest at 0.6, peak at 1   (default 0.6)
 *   head       uSnakeHead 0-1, clockwise from the top-left        (default 0.25)
 *   intensity  uIntensity 0-1                    (default 1)
 *
 * Pixel mappings come from src/renderer/overlay/geometry.mjs - the same module
 * the overlay uses - so this tool cannot quietly render a geometry the app
 * never shows. Every mode branch of the shader is reachable from here; a seam
 * at the top-left corner (where the perimeter coordinate wraps) shows up as a
 * corner that differs between two renders a small `phase` apart.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GLOW_STRENGTH,
  MODE,
  SNAKE_FEATHER,
  SNAKE_LENGTH,
  cornerPx,
  spillPx,
  thicknessPx
} from '../src/renderer/overlay/geometry.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// electron argv is [exe, script, ...args] when run unpackaged.
const args = process.argv.slice(process.defaultApp ? 2 : 1)
const out = resolve(args[0] ?? join(root, 'rim-preview.png'))
const modeName = args[1] ?? 'static'
const thickness = Number(args[2] ?? 0.6)
const count = Number(args[3] ?? 2)
const phase = Number(args[4] ?? 0)
const amp = Number(args[5] ?? (modeName === 'static' ? 0 : 0.6))
const head = Number(args[6] ?? 0.25)
const intensity = Number(args[7] ?? 1)

if (!(modeName in MODE)) {
  console.error(`unknown mode "${modeName}" - expected static | music | snake`)
  process.exit(1)
}

const WIDTH = 900
const HEIGHT = 560
const DPR = 1
const core = thicknessPx(thickness, DPR)

const vert = readFileSync(join(root, 'src/renderer/overlay/rim.vert'), 'utf8')
const frag = readFileSync(join(root, 'src/renderer/overlay/rim.frag'), 'utf8')

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
gl.uniform3fv(loc('uColors'), new Float32Array(colors));
gl.uniform1fv(loc('uCenters'), new Float32Array(centers));
gl.uniform1i(loc('uCount'), ${count});
gl.uniform1f(loc('uThickness'), ${core});
gl.uniform1f(loc('uSpill'), ${spillPx(core, DPR)});
gl.uniform1f(loc('uGlowStrength'), ${GLOW_STRENGTH});
gl.uniform1f(loc('uCorner'), ${cornerPx(core, DPR)});
gl.uniform1f(loc('uOffset'), 0.0);
gl.uniform1f(loc('uIntensity'), ${intensity});
gl.uniform1i(loc('uMode'), ${MODE[modeName]});
gl.uniform1f(loc('uWavePhase'), ${phase});
gl.uniform1f(loc('uWaveAmp'), ${amp});
gl.uniform1f(loc('uSnakeHead'), ${head});
gl.uniform1f(loc('uSnakeLength'), ${SNAKE_LENGTH});
gl.uniform1f(loc('uSnakeFeather'), ${SNAKE_FEATHER});

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
  console.log(`wrote ${out}  (mode=${modeName} thickness=${thickness} colors=${count} phase=${phase} amp=${amp} head=${head})`)
  app.exit(0)
})
