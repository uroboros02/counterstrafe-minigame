# Форк uroboros02 — тренажёр контр-стрейфа с историей тренировок

Форк [crankycs2/counterstrafe-minigame](https://github.com/crankycs2/counterstrafe-minigame) (MPL 2.0).
Добавлено: панель «История тренировок» — пер-дневные агрегаты (SR%/Perfect/Coasted/торможение),
автобэкап в `trainer-history.json` этого репо (переживает чистку куков), цели из разбора демок
(проект cs-demos). Сайт: GitHub Pages из ветки `gh-pages`. Локальная копия: `~/Claude/cs2-trainer`.

---

# pixi-counterstrafe

Counter-Strike 2 counter-strafe trainer built with PIXI.js and a Data-Oriented Design (DOD) architecture. This version is a refactoring of the original trainer, optimized for rendering efficiency and modular logic.

## Quick Start

### Prerequisites
- Node.js (v18+)
- npm

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd counterstrafe-minigame/pixi-counterstrafe

# Install dependencies
npm install
```

### Development
Start the Vite development server:
```bash
npm run dev
```

### Build
Generate a production-ready bundle in the `dist/` directory:
```bash
npm run build
```

---

## Architecture

### Data-Oriented Design (DOD)
The codebase uses a Data-Oriented approach for game state:
- **Typed Arrays**: Player physics, input state, and attempt timings are stored in contiguous `Float32Array`, `Uint8Array`, and `Float64Array` buffers in `src/state.js`.
- **Performance**: Minimizes garbage collection overhead and improves cache locality, supporting high refresh rates.
- **Indices**: Named constants (e.g., `P_VELOCITY`, `A_START_MS`) are used to access specific fields within these buffers.

### Runtime modules (game-dev view)
- `state.js`: Physics constants, weapon table, DOD buffers, shared mode state, symmetry log, and rhythm state.
- `physics.js`: Source-like movement update and the velocity-driven attempt state machine.
- `logic.js`: Shot handling, classification, TTK timing, history/session logging, and symmetry sampling.
- `strafelab.js`: Strafe Lab and Micro-Strafe session management and metrics (RTR, distance breakdowns, shot spread).
- `rhythm.js`: Polyrhythmic metronome presets, schedule builder, and per-frame tick.
- `renderer.js`: PIXI scene setup, arena grid, tear/circle visuals, TTK overlay, rhythm dots, and drag indicators.
- `ui.js`: DOM wiring for the sidebar, averages, symmetry panel, CSV export, and lab/rhythm config panels.
- `main.js`: Bootstraps PIXI, hooks up input, config panels, mode switching, and drives the main loop.
- `input.js` / `audio.js`: Keyboard/mouse input and Web Audio click generator for the rhythm mode.

### Rendering
- **PIXI.js v8**: Used for high-performance WebGL/WebGPU rendering.
- **Visual smoothing**: Character position is decoupled from physics via a lerp-based visual smoother (`P_VISUAL_POS`).
- **Dynamic shapes**: The character's tear shape and color are procedurally generated based on instantaneous velocity.

---

## State Machine

The core game logic in `src/physics.js` is driven by a state machine that manages the lifecycle of a counter-strafe attempt.

### Phases
1.  **IDLE** (`PHASE.IDLE`):
    - Initial state. The system waits for velocity to rise above 15 u/s.
    - Transition to **STRAFING** when `|velocity| > 15`.

2.  **STRAFING** (`PHASE.STRAFING`):
    - The player is building speed or cruising.
    - The system monitors for the start of a deceleration attempt.
    - Transition to **DECELERATING** if `prevSpeed >= MIN_ATTEMPT_SPEED` AND `currentSpeed < prevSpeed - 0.5`.

3.  **DECELERATING** (`PHASE.DECELERATING`):
    - The timing window is active. The system accumulates `gapMs`, `overlapMs`, and `counterMs` based on key states.
    - Transition to **STRAFING** (Aborted) if velocity rebuilds past `ACCURATE_THRESH` before a shot is fired.
    - Transition to **IDLE** after `fireShot()` is called.

---

## Modes

### Freestyle
Baseline counter-strafe timing drill: build speed, counter-strafe, then fire as soon as you are under 73 u/s. The sidebar breakdown shows how much of the decel window was clean counter-key vs gap/overlap.

### TTK (Time to Kill)
Reaction + technique under pressure. While strafing at speed, the arena randomly arms and then flashes a blue glow after a 1.5–10s delay; the time from glow to accurate shot is logged as `ttsMs`. Shooting before the glow is tracked as a "False Start" with its own history rows.

### Strafe Lab
Wide-peek trainer. Run in a chosen direction to cover the distance quota as fast as possible while landing accurate shots (≤73 u/s). The lab results screen reports completion time, shot accuracy, and shot spread along the run.

### Micro-Strafe
Micro-movement trainer. ADAD under the threshold, landing shots while staying evasive; the arena circle shows your real position instead of a stylised tear. Lab metrics include **Realistic Time to Ready (RTR)** and **Inaccurate Distance %** based on your own attempt log.

### Rhythm
Polyrhythmic metronome for movement timing. Reverse direction on accent beats (large dots) and stay in time on sub-beats; presets cover odd signatures (7/8, 11/8) and asymmetric cycles that make your strafing timing harder to read.

---

## Contribution Guide

1.  **Keep it DOD**: Avoid adding complex objects or classes to the main physics loop. Use the existing Typed Array buffers in `state.js` for new stateful variables.
2.  **Respect module boundaries**: Keep physics in `physics.js`, shot/TTK logic in `logic.js`, PIXI drawing in `renderer.js`, and DOM/UI code in `ui.js` / `main.js`. Lab and rhythm behaviour should live in `strafelab.js` and `rhythm.js`.
3.  **Source heritage**: The movement physics are designed to mimic the Source Engine (CS2). Consult `src/state.js` for the `SV` constants (friction, accelerate, stopspeed).
4.  **Comment style**: Prefer short comments that capture intent or non-obvious constraints (e.g. why a threshold exists) rather than narrating each line. Add higher-level explanations here in the README when possible.
5.  **Test changes**: Verify that all modes (Freestyle, TTK, Strafe Lab, Micro-Strafe, Rhythm) still work as expected before opening a PR.

---

## License
Project code is licensed under the Mozilla Public License 2.0.
