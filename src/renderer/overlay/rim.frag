#version 300 es
precision highp float;

#define MAX_COLORS 3
#define MAX_PULSES 8

// Wobble cells around the perimeter. The noise lattice loops over exactly this
// many cells, so `along` 0 and 1 - the same point, the top-left corner - sample
// the same value. It is both the sample rate and the period; they must match,
// which is why it is one constant rather than two literals.
#define WARP_CELLS 4.0

uniform vec2  uRes;          // drawing buffer size, px
uniform float uTime;         // seconds since start

uniform vec3  uColors[MAX_COLORS];
uniform float uCenters[MAX_COLORS];   // gradient center of each color, 0-1 around the rim
uniform int   uCount;

uniform float uThickness;    // solid core depth, px
uniform float uSpill;        // how far past the core the light reaches, px
uniform float uGlowStrength; // how bright the spill is relative to the core

uniform float uCorner;       // corner radius of the frame, px
uniform float uOffset;       // gradient rotation around the perimeter, 0-1
uniform float uIntensity;    // global multiplier from the animation mode
uniform float uWarp;         // aurora warp amount, 0 disables

uniform vec2  uPulses[MAX_PULSES];  // (position 0-1, strength 0-1)
uniform float uPulseWidth;

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
  // rounded field is smooth, and it curves the light around the corners the way
  // a real display bezel does.
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

// Cheap value noise, used only to wobble the aurora - not worth a texture.
//
// The lattice index wraps to `period` before hashing, which makes the function
// exactly periodic in x. That matters because the wobble is sampled at
// `along * WARP_CELLS`, and `along` jumps 1 -> 0 at the top-left corner - the one
// point where it wraps. With an unbounded lattice the two sides of that corner
// fell in cells WARP_CELLS apart with unrelated hashes, so the warped gradient
// tore there by up to the full warp amount. The sample point also scrolls with
// time, so the tear changed size and sign every frame: a flicker pinned to that
// one corner, in music mode only, since music is the only mode with warp.
//
// Wrapping also keeps the hash input in [0, period) instead of letting it grow
// with uTime. sin() of a several-thousand-radian argument has spent most of its
// float32 mantissa and its range reduction is vendor-specific, so the old form
// quietly degraded the longer the app ran.
float noise(float x, float period) {
  float i = mod(floor(x), period);
  float f = fract(x);
  float a = fract(sin(i * 127.1) * 43758.5453);
  float b = fract(sin(mod(i + 1.0, period) * 127.1) * 43758.5453);
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

void main() {
  vec2 rim = rimCoord(gl_FragCoord.xy, uRes);
  float depth = rim.x;
  float along = rim.y;

  // Bail early on the vast interior region that contributes nothing. The rim
  // is a thin frame; most pixels are pure discard work.
  float reach = uThickness + uSpill;
  if (depth > reach) {
    fragColor = vec4(0.0);
    return;
  }

  float t = fract(along + uOffset);
  if (uWarp > 0.0) {
    t = fract(t + (noise(along * WARP_CELLS + uTime * 0.15, WARP_CELLS) - 0.5) * uWarp);
  }

  vec3 color = gradient(t);

  // Thickness is the solid band hugging the edge; spill is the bloom inside it.
  // The spill has to reach exactly zero at a finite distance - an exponential
  // tail never quite does, and the residue tints the whole screen.
  float core = 1.0 - smoothstep(0.0, max(uThickness, 1.0), depth);
  float spillT = clamp((depth - uThickness) / max(uSpill, 1.0), 0.0, 1.0);
  float halo = pow(1.0 - spillT, 2.6);
  float alpha = clamp(core + halo * uGlowStrength, 0.0, 1.0);

  // Beat pulses ride around the perimeter, brightening as they pass.
  float pulse = 0.0;
  for (int i = 0; i < MAX_PULSES; i++) {
    float strength = uPulses[i].y;
    if (strength <= 0.0) continue;
    float dist = abs(fract(t - uPulses[i].x + 0.5) - 0.5);
    pulse += strength * exp(-dist * dist / max(uPulseWidth * uPulseWidth, 1e-5));
  }

  alpha *= uIntensity;
  alpha = clamp(alpha * (1.0 + pulse * 0.9), 0.0, 1.0);
  color = mix(color, min(color * 1.6 + 0.25, vec3(1.0)), clamp(pulse, 0.0, 1.0));

  fragColor = vec4(color, alpha);
}
