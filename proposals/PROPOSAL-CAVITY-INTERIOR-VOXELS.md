# PROPOSAL: Cavity Interior Voxels — 3D fluid tracing inside the vug

**Author:** Claude Opus 4.7 (1M context)
**Date:** 2026-05-27
**Status:** DRAFT — living document. Section markers `[FIRM]` / `[OPEN]` indicate which decisions are settled vs. up for revision.
**Anchor commit:** cabf8ee (v157 — chip reads → mesh.cells)
**Related proposals:** PROPOSAL-CAVITY-MESH.md (wall-side analogue — this is the interior counterpart)
**Skill compatibility:** none yet. Once Phase 1 lands, the `vugg-tune-scenario` skill will likely need updates to teach future agents about voxel-tunable scenarios.

---

## TL;DR

The cavity wall is currently discretized as a mesh of cells (`wall_state.rings[r][c]`, 16×120 per the standard scenario). Each wall cell carries its own fluid composition, mass-balance-debited by engines, diffused locally via `mesh.diffuse`. v157 made this per-cell chemistry visible to chip reads.

**The cavity INTERIOR is not discretized.** It's a single bulk-view fluid (`conditions.fluid`, aliased to `ring_fluids[equator]`). Events mutate this bulk view. The "wall mesh's mesh.cells receive event chemistry uniformly" property we verified in v157 is itself partially aspirational — what's actually happening is the equator wall cells receive event chemistry directly, and inter-cell diffusion propagates it through the wall, but the OPEN SPACE inside the cavity has no spatial chemistry at all.

This proposal voxelizes the interior. Each voxel is a `(ring, cell, depth)` triple matching the wall-mesh address scheme + a radial dimension. Each voxel carries its own fluid composition. Engines couple the wall cell to its adjacent boundary-layer voxel; events optionally target specific spatial zones; diffusion propagates chemistry through the volume.

Three-phase shipping: infra (data model + diffusion, no behavior change) → engine coupling (boundary layer reads + mass balance; baselines drift) → visualization (radial sub-strips, 3D voxel cloud, helicoid depth profiles).

---

## Why now

Three independent conversations recently converged on the same architectural gap:

1. **Multi-condition nucleation envelopes** (boss, 2026-05-27). Per the Clapeyron-slope intuition recorded in HANDOFF-CARBONATE-PHASE-1-COMPLETE.md — nucleation should be a function over (P, T, X) stability fields. To meaningfully vary X across the cavity, the cavity has to HAVE spatial X.

2. **Local competition between crystals** (boss, 2026-05-27). "If there is a big calcite somewhere would it draw other smaller calcites near it or would it strangle competition by sucking out the local chemistry?" Both mechanisms exist in real geology; vugg models the attraction side (heterogeneous nucleation discount via `_pickSubstrate`, CGS via `enclosed_by`) but not the strangulation side (depletion halo). The halo is fundamentally a 3D volume of fluid that's persistently below sigma_crit — and there's no volume to be 3D in until the interior is discretized.

3. **Per-vertex chip selectors** (handoff, original boss request). Strip view's load-bearing prerequisite is "the localized data those accessors return needs to be EXPANDED to reflect how real vuggs work" — fluid stratification, wall-rock diffusion, boundary layers, thermal gradients, pH/redox gradients, evaporation gradients. All of these are 3D phenomena inside the cavity.

All three are blocked on the same missing infrastructure. Building it once unlocks all three.

---

## What's broken without it

The simulator today cannot honestly model:

| Phenomenon | Geological context | Currently |
|---|---|---|
| **Fluid stratification** | Sabkha (hypersaline floor + meteoric ceiling), Coorong-style brines, anoxic basinal stratification | Bulk-view fluid — no vertical chemistry differentiation |
| **Drip plumes** | Cave dripstone (concentrated Ca dripping from ceiling, descending plume of supersaturated fluid) | `zone_chemistry` can pre-load ceiling vs. floor chemistry but it's static — no transport |
| **Thermal convection cells** | Hydrothermal systems, MVT brines, heated pegmatites | Bulk temperature only (`conditions.temperature`); per-ring T exists but no per-voxel T |
| **Boundary-layer depletion** | Every slow-flow vug (most of the catalog) | Mass balance hits the wall cell directly; no boundary-layer fluid to deplete |
| **3D depletion halos** | Single dominant crystals with exclusion zones around them — classic "alpha crystal" textures | Crystals deplete their own wall cell only; no volumetric halo, no strangulation of nearby nucleation |
| **Wallrock chemistry diffusion** | Mg leaching from dolomite host into the cavity, Si enrichment near silicate walls | No mechanism — wall composition is currently a single tag, not a chemistry source |
| **Vertical T gradients (geothermal)** | Cooling-from-above scenarios, geothermal-flux-from-below scenarios | Per-ring T exists but doesn't diffuse vertically |
| **Drip-source point loads** | A ceiling drip locally enriching the floor catchment | No spatial chemistry transport from one cavity location to another |

The strip view's "expand 24 angular sub-strips" feature renders 24 nearly-identical sub-strips today because all 24 angular slots at a given height share the same wall ring chemistry. Until interior voxels exist, the angular dimension is structurally barren of real variation.

---

## The proposal

### [FIRM] Address scheme: spherical voxels matching the wall mesh

Each interior voxel is identified by `(r, c, d)` where:

- `r` ∈ [0, ring_count) — ring index (matches wall mesh)
- `c` ∈ [0, cells_per_ring) — cell index (matches wall mesh)
- `d` ∈ [0, depth_count) — radial depth, where 0 is the wall and depth_count-1 is the cavity center

The voxel at `(r, c, 0)` is the volume IMMEDIATELY ADJACENT to wall cell `(r, c)` — the boundary-layer voxel. The voxel at `(r, c, depth_count-1)` is at the cavity center along the radial line through `(r, c)`.

**Why match the wall mesh address scheme:** the engine path already resolves crystals to (ringIdx, cellIdx) via `wall_state._resolveAnchor`. Adding `d=0` for the adjacent voxel is a single integer lookup. The "boundary layer fluid" becomes `voxels[r][c][0]` with no new resolver needed.

**Voxel geometry:** the (r, c) coordinates pin the angular position on the unit sphere; `d` is the radial offset from the wall inward. Voxel volume scales with `cavity_radius³ × cos(latitude) × depth_factor`. Voxels near the equator are larger than those near the poles, but diffusion math handles this naturally (the Laplacian stencil is volume-weighted).

**Center degeneracy:** all (r, c, depth_count-1) voxels converge on the cavity center. Two options:
  - (a) Treat them as separate voxels with shared boundary (slight redundancy, simple addressing)
  - (b) Collapse the innermost shell to a single "center voxel" (cleaner geometrically, more code)

Phase 1 ships (a) — simpler. Phase 2+ can revisit if it matters.

### [FIRM] Data model: `CavityVoxelGrid`

```typescript
class CavityVoxelGrid {
  ring_count: number;        // matches wall_state.ring_count
  cells_per_ring: number;    // matches wall_state.cells_per_ring
  depth_count: number;       // see [OPEN] below for resolution choice

  // Flat storage: voxels[r * cells_per_ring * depth_count + c * depth_count + d]
  voxels: CavityVoxel[];

  // O(1) lookup
  voxelAt(r: number, c: number, d: number): CavityVoxel;

  // Boundary-layer accessor — the voxel adjacent to wall cell (r, c)
  boundaryVoxel(r: number, c: number): CavityVoxel;

  // Laplacian diffusion across the volume; one step per call
  diffuse(rate: number, fieldNames: string[]): void;

  // Optional: density-driven settling (see [OPEN] D below)
  applyGravitySettling(field: string, settlingRate: number): void;
}

interface CavityVoxel {
  ringIdx: number;
  cellIdx: number;
  depthIdx: number;
  fluid: FluidChemistry;        // mutable, one per voxel
  temperature: number;          // per-voxel T (enables thermal convection)
  volume_mm3: number;           // precomputed at init; used for diffusion weighting
}
```

Storage allocation at sim startup: clone the initial broth into every voxel. Total memory at 16×120×8 = 15,360 voxels × ~50 fluid fields × 8 bytes = ~6 MB. Acceptable.

### [FIRM] Diffusion: 6-neighbor Laplacian

Each voxel has up to 6 neighbors:
- Radial: `(r, c, d-1)` and `(r, c, d+1)`
- Latitudinal: `(r-1, c, d)` and `(r+1, c, d)`
- Longitudinal: `(r, c-1, d)` and `(r, c+1, d)` (wraps cyclically in c)

Boundary conditions:
- Radial: Neumann (no flux) at d=0 (wall) and d=depth_count-1 (center)
- Latitudinal: Neumann at r=0 (north pole) and r=ring_count-1 (south pole)
- Longitudinal: cyclic at c=0 ↔ c=cells_per_ring-1

Standard discrete Laplacian: `new[v] = old[v] + rate × sum_over_neighbors(old[n] - old[v])`. Snapshot the old values before any writes (same pattern as `wall_state.mesh.diffuse`).

**Coupling to wall mesh diffusion:** the wall cell `(r, c)` shares chemistry with the boundary voxel `(r, c, 0)`. Two options:

- (a) **Aliased fluid object**: `wall.cells[r*N+c].fluid === voxels[r*N*D + c*D + 0].fluid`. Reads and writes naturally synchronize.
- (b) **Periodic sync**: separate fluid objects, sync at end-of-step.

(a) is cleaner and avoids drift. Ship (a) in Phase 1.

### [FIRM] Engine coupling (Phase 2)

`_runEngineForCrystal` currently swaps `conditions.fluid` to the wall cell's fluid. Post-Phase-2, it would swap to a "boundary fluid view" — either the boundary voxel directly, OR a thin wrapper that averages the wall cell + the boundary voxel.

Mass balance hits the boundary voxel (the fluid that's actually being consumed), which via aliasing is also the wall cell. Diffusion then propagates the depletion radially inward through the voxel column.

**Two open semantic questions** (see [OPEN] section):
- Should the wall cell + boundary voxel be the SAME object (alias) or different objects with periodic sync?
- Should engines see only the boundary voxel, or an averaged "near-wall" view (e.g., boundary + first interior shell)?

### [FIRM] Event coupling (Phase 2)

Events today mutate `conditions.fluid` (= `ring_fluids[equator]`, the bulk view). Post-voxelization, events need to declare their spatial targeting:

| Event type | Default target |
|---|---|
| Bulk thermal pulse (cooling, heating) | All voxels uniformly |
| Bulk chemistry shift (CO2 degas, salinity drop) | All voxels uniformly |
| Drip event (concentrated Ca from above) | Top ring voxels only |
| Evaporation pulse | Vadose-zone voxels (above water level) |
| Wallrock dissolution flush | Boundary voxels only |
| Sealed-cavity diagenesis | All voxels uniformly |

The simplest API: event handlers accept an optional `target: 'all' | 'top' | 'bottom' | 'vadose' | 'boundary' | { r: int, c: int, d: int }` parameter; default `'all'` preserves current behavior. Existing event handlers stay unchanged; new ones can opt into spatial targeting.

---

## Performance budget

### Diffusion cost per step

| Resolution | Voxels | Ops per chip per step | 50 chips | Wall-clock per step (~100M ops/sec) |
|---|---|---|---|---|
| 16 × 120 × 16 | 30,720 | 184k | 9.2M | ~92 ms |
| 16 × 120 × 8 | 15,360 | 92k | 4.6M | ~46 ms |
| 16 × 120 × 4 | 7,680 | 46k | 2.3M | ~23 ms |
| 8 × 60 × 4 (coarse) | 1,920 | 12k | 580k | ~6 ms |

**Target: under 20 ms per step.** That's roughly the existing per-step cost budget; doubling it is acceptable but going much higher would slow scenario runs noticeably (200-step run goes from ~6s to ~10s+).

**Three mitigations** if naive perf is too slow:

1. **Coarser radial axis.** Depth 4 or 8 instead of 16. Most chemistry action is near the wall anyway (boundary layer is the load-bearing physics).

2. **Sparse diffusion.** Maintain a "dirty voxel" set; only diffuse voxels adjacent to a recently-changed voxel. Most voxels in most scenarios sit at equilibrium most of the time — sparse diffusion would only touch ~5-15% of voxels per step in typical runs.

3. **Asymmetric stepping.** Wall-adjacent diffusion every step (where engines hit); radial-inner diffusion every N steps (it's slower in reality anyway). E.g., shells 0–1 diffuse every step, shells 2–3 every 5 steps, shells 4+ every 20 steps.

**Recommendation:** ship Phase 1 with the coarsest resolution that produces visible spatial chemistry (8 or 16 radial slices), measure actual wall-clock against the scenario test suite, optimize only if it's a problem.

### Memory

At 30,720 voxels × ~50 chips × 8 bytes = ~12 MB. Negligible by modern standards. Memory is not a constraint.

---

## Phasing

### Phase 1 — Voxel store + diffusion infra (v158)

**What ships:**
- `js/24-geometry-voxel-grid.ts` — new `CavityVoxelGrid` class + `CavityVoxel` interface
- VugSimulator constructor allocates the grid, aliases wall cells to depth=0 voxels
- New per-step diffusion call: `voxelGrid.diffuse(rate, fieldNames)` runs after wall diffusion
- New accessors: `sim.voxelAt(r, c, d)`, `sim.boundaryVoxel(r, c)`, `sim.fluidAtVoxel(r, c, d)`
- Tests: data model integrity, diffusion symmetry, alias correctness, cycle/Neumann boundary correctness

**What does NOT ship:**
- No engine reads from voxels (engines still read from wall cells, which ARE the boundary voxels via aliasing — so this works without changes)
- No event-targeting semantics (events still mutate bulk view)
- No visualization changes
- No baseline drift (because the alias means wall reads return the same fluid objects as before — same chemistry, same crystal results)

**Risk:** very low. Pure infra commit. Tests verify the data model; sim baselines byte-identical to v157.

**SIM_VERSION bump:** v158. Baseline regen produces byte-identical output.

### Phase 2 — Engine + event coupling (v159+)

**What ships:**
- Engine path updated: `_runEngineForCrystal` debits both the wall cell AND propagates the depletion radially via mass balance + diffusion
- Event-targeting API: event handlers can declare `target` spatial scope
- A few canonical scenarios updated to use spatial targeting (cave drip → top ring voxels, sabkha evap → vadose voxels, etc.)
- Per-mineral nucleation gates rewired to sample the boundary voxel (NOT the bulk view) — this is the "local competition / depletion halo strangulation" mechanism becoming load-bearing

**What does NOT ship:**
- Full scenario re-tune. Each scenario will need a calibration pass against the new spatial physics; that's a follow-up arc per scenario.

**Risk:** medium-high. Engine path changes; baselines drift across most scenarios. Each drift needs verification that it's geologically defensible (the W9–W12 carbonate-promotion pattern: drift is OK if it's toward the science, not away).

**SIM_VERSION bump:** v159 (engine coupling). Baseline drift expected across all event-heavy scenarios. Mineral firings will shift; some currently-firing minerals may no longer fire (strangulation suppresses them); some currently-not-firing minerals may start (stratification puts them in the right local chemistry).

### Phase 3 — Visualization (v160+)

**What ships:**
- Strip view: radial sub-strip expansion (parallels the existing angular sub-strip expansion). Each (time, angle, height) cell expands into N radial sub-strips on click.
- Helicoid trails: optional "depth profile" overlay — instead of one trail per chip at the wall, render N trails at evenly-spaced depths.
- 3D voxel-cloud rendering option in the main 3D view (small Three.js voxel mesh colored by a selected chip value, optional toggle).
- `_HELIX_CHEM_PARAMS` chip reads extended to take an optional `depth` arg (default 0 = wall, matches current behavior).

**Risk:** low. Renderer-only; chemistry unchanged. Baseline byte-identical.

**SIM_VERSION bump:** v160. Renderer-only; baseline byte-identical to v159.

### Phase 4+ — Scenario re-tune (v161+, ongoing)

Each scenario re-anchored against the spatial physics. Per-scenario commits. Phase 1c-style: pick the highest-leverage scenario first, work through the catalog. Some Phase 1c rejections may need to be revisited under the new model.

---

## What this enables

Direct unlocks once Phase 2 ships:

- **Local competition / depletion halos** — fast-growing crystals carve out 3D volumes of fluid below sigma_crit, suppressing nearby nucleation. Strangulation mechanism becomes load-bearing.
- **Fluid stratification** — events that target floor / vadose voxels can establish persistent gradients without `zone_chemistry` boilerplate.
- **Drip plumes** — top-ring events seed downward propagation via diffusion + (eventually) gravity-driven advection.
- **Thermal convection** — per-voxel T enables Rayleigh-Bénard-style cells if a buoyancy term is added (Phase 4+).
- **Geologically-honest per-vertex chip selectors** — strip view's 24 angular sub-strips × 16 heights become spatially meaningful because the underlying chemistry actually varies across them.

Indirect unlocks (Phase 3+):

- **3D crystal-cavity rendering with chemistry overlays** — see at a glance where the depletion halo around a crystal sits.
- **Strip view radial sub-strips** — full 4D recording (time × ring × angle × depth × chips).
- **Multi-condition nucleation envelopes** — the (P, T, X) stability-field architecture (per the handoff) becomes implementable because X actually varies across the cavity.
- **Helicoid-as-recorder 4D potential** — the boss's "tower of math" framing becomes literal: 3D space × 1D time = 4D dataset.

Compatibility with existing arcs:

- **Crystal cipher** (`PROPOSAL-CRYSTAL-CIPHER.md`) — recipe URLs gain a depth coordinate. The strip view corpus expands from (steps × angles × heights) to (steps × angles × heights × depths) — same procedural-compression argument, more data per recipe.
- **Real crystal lattices arc** — per-voxel chemistry feeds into per-crystal lattice substitution decisions naturally.
- **Pitzer-HMW84 activity model** (Phase 2 carbonate refinement) — per-voxel activity calculations become possible, enabling true spatial activity gradients in high-I brines.

---

## What this does NOT solve

Explicit scope boundaries:

- **Not full Navier-Stokes.** No momentum equations, no pressure-velocity coupling. Just diffusion + (optional, Phase 4+) gravity-driven settling + (optional, Phase 4+) thermal buoyancy. The cavity is "stirred" only insofar as Laplacian diffusion + bulk events do the work.
- **Not non-Newtonian flow.** No particle entrainment, no slurries, no debris transport.
- **Not wall erosion as a function of fluid velocity.** Wall dissolution stays governed by chemistry (existing engine path), not by hydrodynamics.
- **Not advection of dissolved chemistry by bulk flow.** If a scenario wants "fluid flushed through the cavity," that's still modeled as an event (replace fluid composition over time) rather than as fluid-velocity-driven transport.

These are all addable later if a scenario demands them. None are foundational; this proposal lays the groundwork that future flow physics could build on.

---

## Open questions

### [OPEN] A. Radial resolution

How many depth slices? 4, 8, 16, more?

**Trade-off:** more slices = finer spatial chemistry = bigger perf hit + more memory. Fewer slices = coarse halos, harder to see boundary-layer effects.

**Recommendation:** ship Phase 1 with 8. Probe representative scenarios; if visible spatial chemistry is too coarse, bump to 16; if perf is too slow, drop to 4.

### [OPEN] B. Wall cell ↔ boundary voxel: alias or sync?

Option A (alias): `wall.cells[r*N+c].fluid === voxelGrid.voxelAt(r, c, 0).fluid` — same object, two access paths.

Option B (sync): separate fluid objects, sync periodically (e.g., end-of-step copy).

**Trade-off:** alias is simpler and avoids drift but makes the two stores semantically coupled (a write through one path is visible through the other immediately). Sync gives clearer semantic separation but introduces a sync window where the two stores can diverge.

**Recommendation:** alias (Option A). Matches the existing pattern where `ring_fluids[equator] === conditions.fluid` was an alias. Phase 2 engine work assumes alias for the boundary-layer reads.

### [OPEN] C. Engine boundary-layer view: single voxel or averaged?

When an engine grows a crystal, does it see (a) just the boundary voxel `(r, c, 0)`, (b) an average of boundary + first interior shell `(r, c, 0..1)`, or (c) some other near-wall stencil?

**Trade-off:** single voxel is simpler and reflects the most local view (most physically correct for very thin boundary layers). Averaged view smooths out per-voxel artifacts.

**Recommendation:** single voxel for v159; revisit if specific scenarios show pathological behavior.

### [OPEN] D. Density-driven settling for stratification

Should the proposal include a buoyancy / settling term for dense brines? Without it, fluid stratification requires explicit `zone_chemistry` or event-targeted writes — you can't have it emerge from gravity acting on density differences.

The physics: if voxel A has higher salinity than voxel B directly above it, equilibrium has A settling. Implementation: extra term in the diffusion step that moves dense fluid downward (rate proportional to density difference × g).

**Trade-off:** adds real physics, makes stratification emergent, costs ~one extra ops-per-voxel per step. But it's a new equation to validate.

**Recommendation:** defer to Phase 4. Phase 2 ships diffusion-only; stratification scenarios that need it use explicit event targeting in the interim. Add settling as a v162-ish enhancement once the basic infrastructure is proven.

### [OPEN] E. Per-voxel temperature

Should every voxel carry its own temperature, or stay per-ring?

**Pro per-voxel:** enables thermal convection (Phase 4 dependency), allows depth-varying geothermal gradients.

**Pro per-ring:** simpler, smaller memory, matches current architecture.

**Recommendation:** per-voxel temperature in Phase 1 (it's small additional storage, ~1 float per voxel = ~120 KB), but no thermal convection physics yet. Thermal diffusion runs alongside chemistry diffusion. This lets Phase 4 add buoyancy without architectural surgery.

### [OPEN] F. Replay snapshot capture

`wall_state_history` currently captures per-ring chemistry for replay. Should it also capture per-voxel chemistry?

**Pro:** replay through scenario time then shows spatial chemistry evolving — way more interesting than per-ring.

**Con:** snapshot size grows by ~depth_count × — at depth=8, every snapshot is 8× bigger.

**Recommendation:** Phase 3 (visualization) handles this. Phase 1 + 2 ship without snapshot capture; replay shows wall-cell chemistry only (via the existing snap path). When per-voxel rendering lands in Phase 3, extend the snapshot schema to capture voxel chemistry too. Consider lossy options (lower temporal resolution, fewer chips, decimated radial axis).

### [OPEN] G. Interaction with zone_chemistry

`zone_chemistry` currently sets initial per-ring chemistry overrides (used by `zoned_dripstone_cave` for ceiling/floor/wall differentiation). Post-voxelization, should `zone_chemistry` extend to per-voxel overrides, or stay per-ring (writing to the boundary voxel only)?

**Recommendation:** stay per-ring in Phase 1 (boundary voxels at that ring get the override; interior voxels start at bulk). Phase 4+ can introduce per-voxel zone overrides if a scenario needs it (e.g., "the inner shell at the top is meteoric, the outer shell at the top is connate" — niche but possible).

### [OPEN] H. How does the existing `_diffuseRingState` interact with voxel diffusion?

`_diffuseRingState` currently calls `mesh.diffuse(rate, fieldNames, ring_temperatures)` on the wall mesh. Once voxels exist (aliased to depth=0), the wall-cell diffusion IS the d=0 slab of voxel diffusion. Either:

- (a) Drop `_diffuseRingState` entirely; voxel diffusion handles everything.
- (b) Keep `_diffuseRingState` as the wall-slab diffusion; voxel diffusion runs on slabs d > 0 only.
- (c) Merge them; voxel diffusion is the canonical path.

**Recommendation:** (c) merge. Phase 1 introduces voxel diffusion that covers ALL slabs (including d=0, which IS the wall via aliasing); `_diffuseRingState` gets folded into the new voxel diffuse call.

---

## Geological motivations (the "follow the science" anchor)

Real cavity fluid behavior the simulator currently can't reach:

**Sabkha-style hypersaline stratification** (Borch 1979 Coorong; Raudsepp et al. 2022). Hypersaline brine (density ~1.2 g/cm³) settles on the floor; meteoric overpour (density ~1.0) floats on top. The mixing zone in between is where Mg-rich + Ca-rich fluids meet and dolomite precipitates. Post-voxelization, this stratification is emergent from density-driven settling (Phase 4) OR explicit event-targeted writes (Phase 2).

**Cave dripstone drip plumes** (Hill & Forti 1997 Cave Minerals of the World, §3.1). A drop hitting the floor delivers a localized punch of supersaturated Ca; the descending plume from drip-source ceiling is concentrated relative to the cavity atmosphere. Speleothem texture variations (smooth flowstone vs. ropy cave-popcorn vs. stalactite-stalagmite pairs) are spatial-chemistry signatures. Post-voxelization, the drip event targets the top ring voxels; diffusion propagates the Ca pulse downward through the column.

**MVT brine mixing** (Leach et al. 2010, Treatise on Geochemistry; Garven 1985 Am. J. Sci.). Basinal brines (saline, hot, reducing) mix with meteoric water (dilute, cool, oxidized) at the cavity margin. The mixing zone is where SO₄ + H₂S meet and barite + galena precipitate. Spatial heterogeneity at the cavity scale is the geological diagnostic. Post-voxelization, the mixing happens naturally as one fluid source enters from one direction and another from another.

**Hydrothermal convection cells** (Hayba & Ingebritsen 1997, USGS Bulletin 2155). Heated cavities develop Rayleigh-Bénard convection — fluid rises in the center, falls along the cooler walls. Mineral zonation around a hot intrusion is the spatial signature. Post-voxelization with Phase 4 buoyancy, this is emergent.

**Boundary-layer depletion around dominant crystals** (Putnis 2009 Reviews in Mineralogy v70, §5). Fast-growing crystals develop a stagnant boundary layer where local σ drops below the threshold for new nucleation. Single-crystal druzes with bare exclusion zones around the dominant crystal are this signature. Post-voxelization, this is automatic — depleting the boundary voxel propagates to nearby voxels via diffusion, lowering nucleation rate in the volumetric halo.

**Competitive Growth Selection at the crystal-aggregate scale** (Bryan 1957 Acta Crystallographica; Buchwald 1977 Handbook of Iron Meteorites). Vugg already models CGS via the `enclosed_by` mechanism (geometric pinning). Post-voxelization, the chemistry side of CGS (the favored crystals get more local chemistry because they're the closest to fresh fluid) becomes naturally modeled too.

---

## Citation hygiene flag

Per the v141+ pastiche-detection discipline, before any citation in this proposal lands in production code:

- **Borch 1979 / Raudsepp 2022** — already cited in HANDOFF-CARBONATE-PHASE-1-COMPLETE.md for Coorong dolomite. Treat as verified.
- **Hill & Forti 1997** — cited in BUG-aragonite-twin-cave-morphology.md. The §3.1 / §5.3.4 / §10 section references in that BUG doc were flagged as confident-from-past-reading-but-not-freshly-verified. Same flag applies here; verify before any code commit cites them.
- **Leach et al. 2010 Treatise** — real publication on MVT formation; I have linked memory of it being a Treatise on Geochemistry chapter but should verify volume + chapter before citing in production.
- **Garven 1985** — real Am. J. Sci. paper on basinal brine flow; chapter on Pine Point MVT. Confident-but-verify.
- **Hayba & Ingebritsen 1997** — real USGS Bulletin on hydrothermal modeling. Confident-but-verify volume.
- **Putnis 2009 Reviews in Mineralogy v70** — real monograph "Mineral Replacement Reactions." Confident; §5 on heterogeneous nucleation barriers is well-established crystallization-theory chapter.
- **Bryan 1957 Acta Crystallographica** — real CGS paper on geometric selection in cavity-fill druses. Confident.
- **Buchwald 1977 Handbook of Iron Meteorites** — real reference work covering CGS in metallurgical contexts. Confident.

All of these need full verification (volume, page, exact title) before being cited in source-code comments or commit messages.

---

## Sequencing relative to other arcs

| Arc | Where this proposal sits |
|---|---|
| **Phase 1c carbonate cleanup** | Aragonite wireframe parity (only real item left) is independent and orthogonal — can ship before or after Phase 1 voxels. |
| **Pitzer-HMW84 activity model** (Phase 2 carbonate) | Independent of voxels but composes well — Pitzer per-voxel activity gives true spatial activity gradients. Probably wants voxels in place before Pitzer lands. |
| **Real crystal lattices arc** | Independent of voxels. Composes naturally (per-voxel chemistry feeds per-crystal lattice substitution decisions). |
| **Multi-condition nucleation envelopes** | DEPENDS on voxels. Without spatial X, the (P, T, X) stability fields can't vary across the cavity. |
| **Local competition / depletion halos** | DEPENDS on voxels. Halo is a 3D object. |
| **Strip view per-vertex spatial chemistry** | DEPENDS on voxels. Without them, all 24 angular sub-strips at a height share the same chemistry. |
| **Crystal cipher Phase 0** (recipe URL infra) | Independent. Compose naturally — voxel addressing extends the recipe URL scheme. |
| **Helicoid-as-recorder 4D potential** | Independent until Phase 3 voxel visualization. |

**Suggested sequencing:** finish Phase 1c (aragonite wireframe parity) → Phase 1 voxels (infra) → choose Phase 2 voxels OR Pitzer based on which feels more pressing. Phase 3 voxels (visualization) is a natural sibling to any of the helicoid / strip view enhancements.

---

## The conversation that produced this proposal

Recording the dialogue lineage so a future agent can reconstruct the reasoning:

1. **v157 chip rewire** revealed that per-cell chemistry was being computed but invisible to the strip view. Boss saw the equator-pyramid artifact and asked "what's going on in the middle of this graph?" — the question that launched the rewire.

2. **Local competition discussion** (post-v157). Boss asked: "if there is a big calcite somewhere would it draw other smaller calcites near it or would it strangle competition by sucking out the local chemistry?" Discussion of attraction (heterogeneous nucleation + CGS) vs. strangulation (depletion halo). Surfaced that vugg models attraction today but not strangulation — and that strangulation needs the halo to be a 3D volume, which needs interior voxels.

3. **The boss's pivot** to this proposal: "can we get something like the per cell subdivision for the open space of the vugg? that seems like the first step for tracing fluids in the vugg." Recognized as the load-bearing architectural unlock that connects multiple pending arcs.

4. **Proposal framing**: "start with the proposal, its a living document that makes handoff easier." Boss's explicit endorsement of the proposal-doc workflow as a hand-off artifact rather than a planning ritual.

The throughline: the boss kept noticing the same architectural gap from different angles (multi-condition envelopes → local competition → per-vertex chips → fluid tracing). Building the interior voxel infrastructure resolves all four in a single foundational arc.

---

## Next steps

1. **Read this proposal end-to-end + react.** Sections marked [OPEN] are explicit questions for the boss — answer them or flag deferrals.
2. **Pick Phase 1 resolution.** Default recommendation: 8 radial slices. Open to changing based on perf intuition or geological need.
3. **Implementation begins with `js/24-geometry-voxel-grid.ts`** (new file) — pure data structure + diffusion + tests. No engine wiring. Should land as v158 with a byte-identical baseline.
4. **Iterate on this doc.** Living document — when implementation surfaces something the proposal got wrong, edit the proposal in the same commit that fixes the code. The doc + the code stay in sync.

— Claude Opus 4.7
