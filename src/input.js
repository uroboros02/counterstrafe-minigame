import { InputState, IN_A, IN_D, IN_FIRE_LATCH } from './state.js';
import { initAudio } from './audio.js';

const A_KEYS = new Set(['a', 'arrowleft']);
const D_KEYS = new Set(['d', 'arrowright']);

// фокус в поле ввода (токен, квоты, BPM) — клавиши принадлежат полю, не игре
const inField = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');

export function initInput(canvasElement, refreshUI, fireCallback) {
    document.addEventListener('keydown', e => {
        if (e.repeat || inField(e)) return;
        const k = e.key.toLowerCase();

        // Unlock AudioContext on first gesture
        initAudio();

        if (A_KEYS.has(k)) {
            InputState[IN_A] = 1;
            refreshUI();
            e.preventDefault();
        } else if (D_KEYS.has(k)) {
            InputState[IN_D] = 1;
            refreshUI();
            e.preventDefault();
        } else if (k === ' ') {
            e.preventDefault();
            InputState[IN_FIRE_LATCH] = 1;
            fireCallback();
        }
    });

    document.addEventListener('keyup', e => {
        if (inField(e)) return;
        const k = e.key.toLowerCase();
        if (A_KEYS.has(k)) { InputState[IN_A] = 0; refreshUI(); e.preventDefault(); }
        else if (D_KEYS.has(k)) { InputState[IN_D] = 0; refreshUI(); e.preventDefault(); }
    });

    if (canvasElement) {
        canvasElement.addEventListener('mousedown', e => {
            if (e.button === 0) {
                initAudio();
                InputState[IN_FIRE_LATCH] = 1;
                fireCallback();
            }
        });
    }
}
