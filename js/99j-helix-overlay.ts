// ============================================================
// js/99j-helix-overlay.ts — Helix Record overlay for the 3D vug
// ============================================================
// Boss model (final, post-v2 feedback):
//
//   "outer edge of the helicoid is the maximum value in the range.
//    some of these values are mapped on to the physical reality of
//    the vugg, like the value for distance from center would map to
//    the vugg wall. other dimensions would be mapped on as a more
//    abstract representation. all the way basic is at the 0 point,
//    and all the way acidic is at the far end of the helicoid.
//    temperature high at the outer end, temperature cold on the
//    inner end of the helicoid.
//
//    crystals are represented as plotter points.
//
//    the vertical dimension corresponds directly with what's going on
//    in the vugg at that height. its kind of like a spinning spiral
//    plotter line graph."
//
// What the helicoid IS:
//   - A spinning parameter-space chart embedded in the cavity.
//   - r ∈ [0, R] where R = cavity wall radius. r=0 = MIN of each
//     dimension's range; r=R = MAX. Per-dimension polarity:
//        T:  cold at axis,  hot at outer edge
//        pH: basic at axis, acidic at outer edge
//        any cation [Ca, Fe, Mn, …]: low at axis, high at outer
//        distance-from-center: literally physical; r=R IS the wall
//   - Y matches vugg height literally — a value plotted at Y=10mm
//     sits at Y=10mm in the cavity.
//   - θ is time, advanced by the spin (40 RPM → 2 rev / sim-time-unit
//     at the sim's 3 sec/unit cadence; one rev per 1.5 s real time).
//
// v3 inscriptions (this commit):
//   - per-ring chemistry profile per parameter — a polyline through
//     each ring's (r=normalized-value, Y=ring's-actual-Y) point, plus
//     a radial spoke from the central axis to each point so the
//     "line going in or out away from the central axis" reads clearly.
//   - 6 parameters at v3 launch: T / pH / salinity / Ca / Fe / Mn.
//     Each gets its own colour and a small angular offset so spokes
//     don't perfectly overlap when values coincide.
//
// Removed in v3:
//   - per-zone outer-edge beads (one crystal's zones spread across Y;
//     violated the Y = vugg-height rule)
//   - outer-edge spiral curve (the surface's r=R boundary already
//     defines the edge; the curve was duplicative)
//
// Coming after v3:
//   - crystal plotter dots at literal (X, Y, Z) of each crystal
//   - parameter legend / per-parameter range tuning
//   - optional fade-trail so the spinning needles leave a visible
//     wake (turning the instantaneous needle into accumulated trace)

let _helixOverlayEnabled = true;
const _HELIX_N_TURNS = 3;

// Parameters surfaced as radial needles. Each entry: an id (used in
// the chemistry-state signature), a [min, max] normalization window,
// a colour, and a reader that pulls the per-ring value from the sim.
// Add parameters here — no other change needed.
const _HELIX_CHEM_PARAMS: Array<{
  id: string,
  label: string,
  min: number,
  max: number,
  color: number,
  read: (sim: any, i: number) => number | null | undefined,
}> = [
  { id: 'T',   label: 'temperature', min: 50,  max: 250,  color: 0xff5544,
    read: (sim, i) => (sim.ring_temperatures || [])[i] },
  { id: 'pH',  label: 'pH',          min: 2,   max: 12,   color: 0x9966ee,
    read: (sim, i) => ((sim.ring_fluids || [])[i] || {}).pH },
  { id: 'sal', label: 'salinity',    min: 0,   max: 30,   color: 0x44ccdd,
    read: (sim, i) => ((sim.ring_fluids || [])[i] || {}).salinity },
  { id: 'Ca',  label: 'Ca',          min: 0,   max: 1000, color: 0x66cc77,
    read: (sim, i) => ((sim.ring_fluids || [])[i] || {}).Ca },
  { id: 'Fe',  label: 'Fe',          min: 0,   max: 200,  color: 0xee9944,
    read: (sim, i) => ((sim.ring_fluids || [])[i] || {}).Fe },
  { id: 'Mn',  label: 'Mn',          min: 0,   max: 100,  color: 0xffdd55,
    read: (sim, i) => ((sim.ring_fluids || [])[i] || {}).Mn },
];

function _helixDisposeGroup(g: any) {
  if (!g) return;
  g.traverse((obj: any) => {
    if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose && m.dispose());
      else if (obj.material.dispose) obj.material.dispose();
    }
  });
}

// R matches the cavity wall (so "outer edge = wall" holds literally
// for physical parameters). ySpan = vug_diameter_mm so "Y = vugg Y"
// holds literally. Both fall back to a sensible default if the wall
// hasn't been built yet (first frame).
function _helixGeometry(wall: any): { R: number, ySpan: number } {
  let R: number;
  if (wall && typeof wall.max_seen_radius_mm === 'number' && wall.max_seen_radius_mm > 0) {
    R = wall.max_seen_radius_mm;
  } else if (wall && wall.vug_diameter_mm) {
    R = wall.vug_diameter_mm * 0.5;
  } else {
    R = 25;
  }
  const ySpan = (wall && wall.vug_diameter_mm) ? wall.vug_diameter_mm : 50;
  return { R, ySpan };
}

// Ring → world-Y. Cavity builds rings at phi_cav = PI * (r+0.5)/N
// south-to-north (see _topoBuildCavityGeometry), so ring 0 sits at
// the bottom and ring N-1 at the top. wallRadius scales the cosine
// so the equator ring really is near y=0 in cavity-mm units.
function _helixRingY(ringIndex: number, ringCount: number, wallRadius: number): number {
  const phiCav = Math.PI * (ringIndex + 0.5) / ringCount;
  return -wallRadius * Math.cos(phiCav);
}

// Coarse signature of the chemistry state across rings. Rebuilds the
// helix only when the per-ring chemistry meaningfully changes (cheap
// integer hash, not perfect — fine for live edits, exact for static
// completed sims).
function _helixChemSig(sim: any): string {
  if (!sim) return 'none';
  const rt = sim.ring_temperatures || [];
  const rf = sim.ring_fluids || [];
  const parts: string[] = [];
  for (let i = 0; i < Math.max(rt.length, rf.length); i++) {
    parts.push((rt[i] || 0).toFixed(0));
    const f = rf[i] || {};
    parts.push(
      (f.pH || 0).toFixed(1),
      (f.salinity || 0).toFixed(0),
      (f.Ca || 0).toFixed(0),
      (f.Fe || 0).toFixed(0),
      (f.Mn || 0).toFixed(0),
    );
  }
  return parts.join('|');
}

// ----- Main entry — called by _topoRenderThree once per frame -----

function _topoHelixOverlayDraw(state: any, sim: any, wall: any) {
  if (!state) return;
  if (!_helixOverlayEnabled) {
    if (state.helixGroup) {
      state.scene.remove(state.helixGroup);
      _helixDisposeGroup(state.helixGroup);
      state.helixGroup = null;
      state.helixSig = '';
    }
    return;
  }
  if (!sim || !wall || !wall.ring_count) return;

  const { R, ySpan } = _helixGeometry(wall);
  const chemSig = _helixChemSig(sim);
  const sig = `${R.toFixed(2)}|${ySpan.toFixed(2)}|${wall.ring_count}|${chemSig}`;
  if (state.helixGroup && state.helixSig === sig) return;

  if (state.helixGroup) {
    state.scene.remove(state.helixGroup);
    _helixDisposeGroup(state.helixGroup);
  }

  const group = new THREE.Group();
  group.name = 'helix-record';

  _helixAddSurface(group, R, ySpan);
  _helixAddChemistryProfiles(group, sim, wall, R);

  // Carry the in-flight rotation across rebuilds so chemistry changes
  // don't snap the helix back to angle 0.
  if (typeof _helixRotationY === 'number') group.rotation.y = _helixRotationY;

  state.scene.add(group);
  state.helixGroup = group;
  state.helixSig = sig;

  _helixStartSpin();
}

// ----- Sub-builders ------------------------------------------------

// Translucent gold helicoid surface — the parameter-space canvas.
// (r, θ) → (r cos θ, (θ/2πN - 0.5)·ySpan, r sin θ). Spans from the
// central axis (r=0) out to the cavity wall (r=R), N_TURNS over the
// full vertical span.
function _helixAddSurface(group: any, R: number, ySpan: number) {
  const NU = 16;
  const NV = Math.max(180, _HELIX_N_TURNS * 60);
  const surfPositions = new Float32Array((NU + 1) * (NV + 1) * 3);
  const surfIndices: number[] = [];
  for (let i = 0; i <= NU; i++) {
    const ri = (i / NU) * R;
    for (let j = 0; j <= NV; j++) {
      const u = j / NV;
      const phi = u * _HELIX_N_TURNS * Math.PI * 2;
      const y = (u - 0.5) * ySpan;
      const vIdx = (i * (NV + 1) + j) * 3;
      surfPositions[vIdx + 0] = ri * Math.cos(phi);
      surfPositions[vIdx + 1] = y;
      surfPositions[vIdx + 2] = ri * Math.sin(phi);
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (NV + 1) + j;
      const d = c + 1;
      surfIndices.push(a, c, b, b, c, d);
    }
  }
  const surfGeom = new THREE.BufferGeometry();
  surfGeom.setAttribute('position', new THREE.BufferAttribute(surfPositions, 3));
  surfGeom.setIndex(surfIndices);
  surfGeom.computeVertexNormals();
  const surfMat = new THREE.MeshBasicMaterial({
    color: 0xf0d5a0,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(surfGeom, surfMat));
}

// Per-parameter chemistry needles + vertical profile lines.
// At each ring (vugg height Y_i), for each parameter:
//   r_i = R * clamp((value - param.min) / (param.max - param.min), 0, 1)
//   spoke from (0, Y_i, 0) → (r_i·cos φ_p, Y_i, r_i·sin φ_p)
//   dot at the spoke tip
// Then a polyline connects the same parameter's dots across rings —
// the vertical profile of that parameter through the cavity.
// φ_p is a small per-parameter angular offset so coincident values
// don't perfectly overlap. Total spread is ~30° across all params.
function _helixAddChemistryProfiles(group: any, sim: any, wall: any, R: number) {
  if (!sim || !wall || !wall.ring_count) return;
  const ringCount = wall.ring_count;
  const wallRadius = wall.max_seen_radius_mm
                   || (wall.vug_diameter_mm ? wall.vug_diameter_mm * 0.5 : R);
  const nParams = _HELIX_CHEM_PARAMS.length;
  const SPREAD = Math.PI / 6;   // 30° total angular spread for the param fan
  const DOT_RADIUS = Math.max(0.2, R * 0.012);
  const SPOKE_OPACITY = 0.35;
  const PROFILE_OPACITY = 0.85;

  for (let p = 0; p < nParams; p++) {
    const param = _HELIX_CHEM_PARAMS[p];
    const phi = (nParams === 1) ? 0 : ((p / (nParams - 1)) - 0.5) * SPREAD;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);

    const profilePts: any[] = [];

    for (let i = 0; i < ringCount; i++) {
      const raw = param.read(sim, i);
      if (typeof raw !== 'number' || isNaN(raw)) continue;
      const norm = Math.max(0, Math.min(1, (raw - param.min) / (param.max - param.min)));
      const r = norm * R;
      const y = _helixRingY(i, ringCount, wallRadius);
      const tipX = r * cosP, tipZ = r * sinP;

      // Spoke from axis to the dot — the radial "line going out from
      // the central axis" the boss explicitly asked for.
      const spokeGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, y, 0),
        new THREE.Vector3(tipX, y, tipZ),
      ]);
      const spokeMat = new THREE.LineBasicMaterial({
        color: param.color, transparent: true, opacity: SPOKE_OPACITY,
      });
      group.add(new THREE.Line(spokeGeom, spokeMat));

      // Bright dot at the spoke tip.
      const dotGeom = new THREE.SphereGeometry(DOT_RADIUS, 8, 6);
      const dotMat = new THREE.MeshBasicMaterial({ color: param.color });
      const dot = new THREE.Mesh(dotGeom, dotMat);
      dot.position.set(tipX, y, tipZ);
      group.add(dot);

      profilePts.push(new THREE.Vector3(tipX, y, tipZ));
    }

    // Connect the parameter's per-ring dots with a vertical profile
    // line so the height-profile reads clearly even when the spokes
    // are hidden behind the cavity wall from one angle.
    if (profilePts.length >= 2) {
      const profGeom = new THREE.BufferGeometry().setFromPoints(profilePts);
      const profMat = new THREE.LineBasicMaterial({
        color: param.color, transparent: true, opacity: PROFILE_OPACITY,
      });
      group.add(new THREE.Line(profGeom, profMat));
    }
  }
}

// =========== SPINNING ==========================================
// Boss spec: 2 rotations per sim-time-unit; sim runs at 3 sec / unit,
// so 1 rotation per 1.5 sec real time = 40 RPM.

let _helixSpinRAF: number | null = null;
let _helixSpinPrevTime = 0;
let _helixRotationY = 0;
const _HELIX_RPM = 40;

function _helixStartSpin() {
  if (_helixSpinRAF != null) return;
  _helixSpinPrevTime = performance.now();
  _helixSpinRAF = requestAnimationFrame(_helixSpinTick);
}

function _helixSpinTick(now: number) {
  const state = (typeof _topoThreeState !== 'undefined') ? _topoThreeState : null;
  if (!_helixOverlayEnabled || !state || !state.helixGroup) {
    _helixSpinRAF = null;
    return;
  }
  // Only spin when the WebGL canvas is actually visible — pauses RAF
  // cost on the title screen, Creative mode, etc.
  const c3 = document.getElementById('topo-canvas-three') as HTMLCanvasElement | null;
  const visible = c3 && c3.offsetParent != null && c3.style.display !== 'none';
  if (visible) {
    const dt = Math.max(0, Math.min(0.1, (now - _helixSpinPrevTime) / 1000));
    const omega = (_HELIX_RPM / 60) * 2 * Math.PI;  // rad/sec
    _helixRotationY = (_helixRotationY + dt * omega) % (Math.PI * 2);
    state.helixGroup.rotation.y = _helixRotationY;
    if (state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera);
    }
  }
  _helixSpinPrevTime = now;
  _helixSpinRAF = requestAnimationFrame(_helixSpinTick);
}

// Toggle handler — wired to a future UI button. Forces the next
// _topoRenderThree to run helix logic regardless of cache.
function helixOverlayToggle() {
  _helixOverlayEnabled = !_helixOverlayEnabled;
  if (typeof topoRender === 'function') topoRender();
}
