import { createTexture2D } from './webgl-utils.js';

export const TEXTURE_SLOT_COUNT = 8;

// Preserve raw normal bytes; albedo color decoding happens in the GPU's sRGB format.
export async function loadBitmap(source) {
  let blob = source;
  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to load image: ${source}`);
    blob = await response.blob();
  }
  return createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

// Adapted from main's texture slots: keep the old GPU texture until its replacement is ready.
export function createTextureManager(gl, onChange = () => {}) {
  const slots = Array.from({ length: TEXTURE_SLOT_COUNT }, (_, index) => ({
    handle: null, bitmap: null, isLinear: index !== 0, revision: 0,
  }));

  function getSlot(index) {
    const slot = slots[index];
    if (!slot) throw new Error(`Invalid texture slot index: ${index}`);
    return slot;
  }

  function replaceSlotTexture(index, bitmap, isLinear) {
    const slot = getSlot(index);
    const handle = createTexture2D(gl, bitmap, { textureUnit: index, isLinear });
    if (slot.handle) gl.deleteTexture(slot.handle);
    if (slot.bitmap && slot.bitmap !== bitmap) slot.bitmap.close();
    Object.assign(slot, { handle, bitmap, isLinear });
    onChange(index, slot);
  }

  async function updateSlot(index, file) {
    const slot = getSlot(index);
    if (!file) return false;
    const revision = ++slot.revision;
    const bitmap = await loadBitmap(file);
    // Rapid selections may decode out of order; only the latest selection may replace the slot.
    if (revision !== slot.revision) {
      bitmap.close();
      return false;
    }
    try {
      replaceSlotTexture(index, bitmap, slot.isLinear);
    } catch (error) {
      bitmap.close();
      throw error;
    }
    return true;
  }

  function updateSlotLinear(index, isLinear) {
    const slot = getSlot(index);
    if (slot.bitmap) replaceSlotTexture(index, slot.bitmap, isLinear);
    else slot.isLinear = isLinear;
  }

  return { slots, updateSlot, updateSlotLinear, setSlotBitmap: replaceSlotTexture };
}

// All eight framework slots remain available; this shader samples only albedo 0 and normal 1.
export function setupTextureSlotUI(manager) {
  const container = document.getElementById('texture-slot-list');
  const extraContainer = document.getElementById('texture-slot-extra');
  for (let index = 0; index < TEXTURE_SLOT_COUNT; index += 1) {
    const row = document.createElement('div');
    row.className = 'texture-slot-row';
    const label = index === 0 ? 'Albedo' : index === 1 ? 'Normal' : `Slot ${index}`;
    row.innerHTML = `
      <label class="texture-slot-title" for="tex-file-${index}">${label}</label>
      <input id="tex-file-${index}" type="file" accept="image/*" />
      <label class="texture-slot-linear">
        <input id="tex-linear-${index}" type="checkbox" /> Linear (RGBA8)
      </label>
      <small id="tex-status-${index}" role="status">${index < 2 ? 'Default texture' : 'Empty'}</small>`;
    // Show the two active maps first; keep framework-only slots in the collapsed section.
    (index < 2 ? container : extraContainer).append(row);
    const fileInput = row.querySelector(`#tex-file-${index}`);
    const linearInput = row.querySelector(`#tex-linear-${index}`);
    const status = row.querySelector('small');
    linearInput.checked = manager.slots[index].isLinear;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      status.textContent = 'Loading…';
      try {
        if (await manager.updateSlot(index, file)) status.textContent = file.name;
      } catch (error) {
        if (fileInput.files?.[0] === file) status.textContent = `Could not load ${file.name}: ${error.message}`;
        console.error(error);
      }
    });
    linearInput.addEventListener('change', () => {
      try {
        manager.updateSlotLinear(index, linearInput.checked);
      } catch (error) {
        linearInput.checked = manager.slots[index].isLinear;
        status.textContent = error.message;
      }
    });
  }
}
