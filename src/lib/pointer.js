/**
 * pointer.js — whether a mouse is what is actually being used.
 *
 * The media queries report what the device says it is, and a laptop with a
 * touch screen can say hover: none, pointer: coarse and any-hover: none with a
 * mouse in the hand. So this watches the pointer itself: a mouse moving sets
 * data-mouse on <html>, a finger coming down takes it off again. What depends
 * on hovering checks this as well as the query.
 */

const root = document.documentElement;

const note = (e) => {
  if (e.pointerType === 'mouse') {
    if (!('mouse' in root.dataset)) root.dataset.mouse = '';
  } else if ('mouse' in root.dataset) {
    delete root.dataset.mouse;
  }
};

window.addEventListener('pointermove', note, { passive: true, capture: true });
window.addEventListener('pointerdown', note, { passive: true, capture: true });

export const usingMouse = () => 'mouse' in root.dataset;
