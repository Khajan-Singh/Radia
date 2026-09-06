#version 300 es
precision highp float;

#define MAX_COLORS 3
#define MODE_STATIC 0
#define MODE_SYNC   1
#define MODE_SNAKE  2
#define TAU 6.28318530718

uniform vec2  uRes;          // drawing buffer size, px

uniform vec3  uColors[MAX_COLORS];
uniform float uCenters[MAX_COLORS];   // gradient center of each color, 0-1 around the rim
uniform int   uCount;

uniform float uThickness;    // solid core depth, px (before the wave profile)
uniform float uSpill;        // how far past the core the light reaches, px
uniform float uGlowStrength; // how bright the spill is relative to the core
uniform float uCorner;       // corner radius of the frame, px

uniform float uOffset;       // gradient rotation around the perimeter, 0-1
uniform float uIntensity;    // global brightness, 0-1. Never touches hue.

uniform int   uMode;         // MODE_*
uniform float uWavePhase;    // travelling-wave phase, 0-1 (wrapped on the JS side)
uniform float uWaveAmp;      // wave height as a fraction of uThickness, 0-1

uniform float uSnakeHead;    // head position, 0-1 clockwise from top-left
uniform float uSnakeLength;  // body length, fraction of the perimeter
uniform float uSnakeFeather; // taper at each end, fraction of the body length

out vec4 fragColor;

// ─── Perimeter parameterisation ──────────────────────────────────────────────
//
// Returns distance to the nearest edge in x, and position along the perimeter
// (0-1, clockwise from the top-left corner) in y.
//
// The perimeter position comes from casting a ray out of the centre through the
// pixel and taking where it meets the frame, NOT from the nearest edge. Nearest
// edge looks equivalent but is not: along a corner diagonal the two edges give
// arc lengths that differ by the width of the screen, which shows up as a hard
// seam across every corner. The ray hit is continuous everywhere.
vec2 rimCoord(vec2 p, vec2 res) {
  vec2 halfRes = res * 0.5;
  vec2 q = p - halfRes;

  float ax = abs(q.x) / halfRes.x;
  float ay = abs(q.y) / halfRes.y;
  vec2 hit = halfRes + q / max(max(ax, ay), 1e-6);
  float yTop = res.y - hit.y;            // gl_FragCoord.y is 0 at the bottom

  float s;
  if (ay >= ax) {
    s = q.y > 0.0
      ? hit.x                                        // top edge, left to right
      : res.x + res.y + (res.x - hit.x);             // bottom, right to left
  } else {
    s = q.x > 0.0
      ? res.x + yTop                                 // right edge, top to bottom
      : 2.0 * res.x + res.y + (res.y - yTop);        // left edge, bottom to top
  }

  // Depth comes from a rounded-rectangle distance field rather than the nearest
  // edge. min() over four edges is continuous but its gradient is not, and the
  // kink shows up as a mitre line running diagonally out of every corner. The
  // rounded field is smooth. The two halves of this function follow different
  // shapes - `s` a sharp rectangle, `d` a rounded one - and that is fine: `s`
  // only has to be continuous, and it is.
  vec2 b = halfRes - uCorner;
  vec2 e = abs(q) - b;
  float outside = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - uCorner;
  float d = max(0.0, -outside);

  return vec2(d, s / (2.0 * (res.x + res.y)));
}

// ─── Gradient ────────────────────────────────────────────────────────────────
//
// A soft cyclic blend rather than hard stops: each color pulls on the rim with
// a weight that falls off with cyclic distance, normalised across all colors.
// Uneven centre spacing is what makes the primary/secondary weight split show.
//
// Inverse-distance (Shepard) weighting, deliberately, rather than a falloff
// with finite reach. With two colours, the points opposite both centres sit
// outside any finite radius, every weight goes to zero, and the blend has to
// fall back to an arbitrary colour - which appears as a hard seam running out
// of one corner. An inverse law never reaches zero, so there is no dead zone.
vec3 gradient(float t) {
  vec3 acc = vec3(0.0);
  float total = 0.0;

  for (int i = 0; i < MAX_COLORS; i++) {
    if (i >= uCount) break;
    float dist = abs(fract(t - uCenters[i] + 0.5) - 0.5);   // cyclic, 0-0.5
    float w = 1.0 / (dist * dist * dist + 0.0015);
    acc += uColors[i] * w;
    total += w;
  }

  return acc / max(total, 1e-5);
}

// ─── Wave ────────────────────────────────────────────────────────────────────
//
// A travelling wave around the perimeter, 0-1. Two harmonics so it reads as
// water rather than a sine.
//
// Every multiplier on a wrapping coordinate is an INTEGER - the cycle counts
// on `along` AND the rates on `uWavePhase`. `along` wraps 1 -> 0 at the
// top-left corner; `uWavePhase` wraps 1 -> 0 every few seconds (and sooner
// after a beat surge). An integer multiple of a whole turn is invisible to
// sin(); a non-integer one is a step. The second harmonic's rate used to be
// 1.6, so at every phase wrap it snapped 0.6 of a wavelength - which read as
// the wave jumping backwards "every here and there", clustered around beats
// because surges bring the wrap forward. The beat driver was never the cause.
//
// Rates 1 and 2 over 5 and 8 cycles travel at slightly different speeds, so
// the pattern slowly morphs instead of sliding rigidly. That is deliberate.
// Fewer cycles were tried (3 and 5): each crest then spanned more than a
// screen width and read as a slow bulge, not a wave.
float wave(float along) {
  float w = 0.65 * sin(TAU * (5.0 * along - uWavePhase))
          + 0.35 * sin(TAU * (8.0 * along + 0.37 - 2.0 * uWavePhase));
  return 0.5 + 0.5 * w;
}

// Thickness multiplier from the wave: the troughs sit at the bare core (1.0)
// and the crests reach 1 + 3.4 * uWaveAmp - 3.2x at the resting amplitude of
// 0.65, 4.3x at full. The cube flattens the troughs and narrows the crests:
// only ~40% of the rim is above 1.5x at rest (a plain sine put 66% there and
// the crests blended into the base), so the base reads as a rim and the
// crests read as distinct waves riding on it.
// `reach` in main() must cover the same maximum or crests get clipped by the
// early-out.
float swell(float along) {
  return 1.0 + uWaveAmp * 3.4 * pow(wave(along), 3.0);
}

// What the music modes average at their resting amplitude (0.65): the mean
// of swell() over a cycle. Static draws at this so the Thickness slider reads
// the same in every mode - a bare 1.0 made Static look half as thick as Sync.
#define STATIC_SWELL 1.50

void main() {
  vec2 rim = rimCoord(gl_FragCoord.xy, uRes);
  float depth = rim.x;
  float along = rim.y;

  // Bail early on the vast interior region that contributes nothing. The
  // profile can only swell the core, never push the reach past this.
  float reach = uThickness * max(STATIC_SWELL, 1.0 + 3.4 * uWaveAmp) + uSpill;
  if (depth > reach) {
    fragColor = vec4(0.0);
    return;
  }

  // Per-pixel thickness profile (multiplier on uThickness), a coverage term for
  // the snake's tapered ends, and the colour. Colour is ALWAYS the gradient:
  // nothing here lifts it toward white, so a beat can only change brightness.
  float profile = STATIC_SWELL;
  float cover = 1.0;
  vec3 color;

  if (uMode == MODE_SNAKE) {
    // Distance behind the head: 0 at the head, growing toward the tail.
    float u = fract(uSnakeHead - along);
    if (u >= uSnakeLength) {
      fragColor = vec4(0.0);
      return;
    }
    float feather = max(uSnakeFeather * uSnakeLength, 1e-4);
    cover = smoothstep(0.0, feather, u) * smoothstep(0.0, feather, uSnakeLength - u);
    // The body thins to nothing at both ends. Its ripple is in body
    // coordinates (distance behind the head), not screen coordinates, so the
    // waves travel with the snake and flow head -> tail as it swims, rather
    // than the snake sliding over a ripple pinned to the screen. `u` is
    // continuous over the body and both ends are feathered to zero, so its
    // wrap at the head never shows.
    profile = cover * swell(u);
    // Palette runs head -> tail along the body, so the colours travel with it.
    color = gradient(u / uSnakeLength);
  } else {
    if (uMode == MODE_SYNC) {
      // The outer edge stays flush with the screen; only the inner edge moves.
      profile = swell(along);
    }
    color = gradient(fract(along + uOffset));
  }

  float thick = max(uThickness * profile, 1.0);

  // Solid core with a soft inner edge, then a halo that continues from where
  // the edge starts to soften. Starting the halo at `thick` instead would leave
  // a step where the core has reached zero and the halo is still at full
  // strength. The halo has to reach exactly zero at a finite distance - an
  // exponential tail never quite does, and the residue tints the whole screen.
  float inner = thick * 0.55;
  float core = 1.0 - smoothstep(inner, thick, depth);
  float spillT = clamp((depth - inner) / max(uSpill, 1.0), 0.0, 1.0);
  float halo = pow(1.0 - spillT, 2.6);
  float alpha = core + (1.0 - core) * halo * uGlowStrength;

  alpha = clamp(alpha * cover * uIntensity, 0.0, 1.0);
  fragColor = vec4(color, alpha);
}
