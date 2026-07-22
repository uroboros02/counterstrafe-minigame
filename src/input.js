import { InputState, IN_A, IN_D, IN_FIRE_LATCH } from './state.js';
import { initAudio } from './audio.js';

// матчим ФИЗИЧЕСКИЕ кнопки (e.code), а не символ (e.key): иначе на русской
// раскладке 'a' приходит как 'ф' и клавиши «не видятся»
const A_CODES = new Set(['KeyA', 'ArrowLeft']);
const D_CODES = new Set(['KeyD', 'ArrowRight']);

// фокус в поле ввода (токен, квоты, BPM) — клавиши принадлежат полю, не игре
const inField = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');

export function initInput(canvasElement, refreshUI, fireCallback) {
    document.addEventListener('keydown', e => {
        if (e.repeat || inField(e)) return;

        // Unlock AudioContext on first gesture
        initAudio();

        if (A_CODES.has(e.code)) {
            InputState[IN_A] = 1;
            refreshUI();
            e.preventDefault();
        } else if (D_CODES.has(e.code)) {
            InputState[IN_D] = 1;
            refreshUI();
            e.preventDefault();
        } else if (e.code === 'Space') {
            e.preventDefault();
            InputState[IN_FIRE_LATCH] = 1;
            fireCallback();
        }
    });

    document.addEventListener('keyup', e => {
        if (inField(e)) return;
        if (A_CODES.has(e.code)) { InputState[IN_A] = 0; refreshUI(); e.preventDefault(); }
        else if (D_CODES.has(e.code)) { InputState[IN_D] = 0; refreshUI(); e.preventDefault(); }
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
