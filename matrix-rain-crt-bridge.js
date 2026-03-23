/**
 * matrix-rain-crt-bridge.js
 * Integrates matrix-rain-webgpu and telescreen-crt-webgpu into a single
 * THREE.RenderPipeline with one RAF loop and zero intermediate canvas copies.
 *
 * Usage:
 *   import { initMatrixRainCRT } from './matrix-rain-crt-bridge.js';
 *
 *   const bridge = initMatrixRainCRT(element, rainOpts, crtOpts);
 *   // bridge.rain — matrix-rain handle (setColor, setHeat, applyPreset, ...)
 *   // bridge.crt  — CRT handle (setShader, setGlitch, setBloom, ...)
 *   // bridge.destroy() — tear down everything
 */

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { initMatrixRain } from './matrix-rain-webgpu.js';
import { buildCRTNodesFromSource } from '../telescreen-crt-webgpu/telescreen-crt-webgpu.js';

/**
 * Initialise a composited matrix-rain + CRT effect.
 *
 * @param {HTMLElement} element   Host element (canvas appended inside it)
 * @param {object}      [rainOpts] Options forwarded to initMatrixRain (color, opacity, charSet, etc.)
 * @param {object}      [crtOpts]  Options forwarded to buildCRTNodesFromSource (setShader params, etc.)
 * @returns {{ rain: object, crt: object, destroy(): void }}
 */
export function initMatrixRainCRT(element, rainOpts = {}, crtOpts = {}) {
  const rain = initMatrixRain(element, { ...rainOpts, externalLoop: true });

  // Bridge owns the renderer. CRT requires LinearSRGBColorSpace to avoid
  // double-encoding: CRT's buildGammaNode applies γ=2.5; without this flag
  // Three.js would also apply sRGB (γ≈2.2), yielding net γ≈0.4 on display.
  rain.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  let rainNodes = null;
  let crt       = null;
  let pp        = null;
  let rafId     = 0;
  let rendering = false;   // re-entry guard

  // ResizeObserver declared in outer scope so destroy() can call ro?.disconnect()
  // safely even if destroyed before renderer.init() resolves.
  let ro;

  rain.renderer.init().then(() => {
    // Build rain node chain on top of the scene pass
    const sceneColor = pass(rain.scene, rain.camera).getTextureNode('output');
    rainNodes = rain.buildNodes(sceneColor);

    // Build CRT node chain on top of the rain output
    crt = buildCRTNodesFromSource(rain.renderer, rainNodes.outputNode, crtOpts);

    // Assemble single RenderPipeline: rain → CRT → FXAA → screen
    pp = new THREE.RenderPipeline(rain.renderer);
    pp.outputNode = fxaa(crt.outputNode);

    // Bridge ResizeObserver: rain's internal observer is suppressed (externalLoop: true).
    ro = new ResizeObserver(() => {
      if (!pp) return;
      const w = element.clientWidth  || 1;
      const h = element.clientHeight || 1;
      rain.renderer.setSize(w, h);
      rain.camera.aspect = w / h;
      rain.camera.updateProjectionMatrix();
      rain.onResize(w, h);   // updates uAspect (the only dimension-dependent rain uniform)
      rebuildPP();
    });
    ro.observe(element);

    rafId = requestAnimationFrame(animate);
  });

  // Rebuild rain nodes and notify CRT of new source after a resize.
  // The CRT's own mode-transition detection (in tick) handles its own deferred
  // pipeline rebuild; the bridge only needs to update the source node.
  function rebuildPP() {
    rainNodes?.dispose();
    const sceneColor = pass(rain.scene, rain.camera).getTextureNode('output');
    rainNodes = rain.buildNodes(sceneColor);
    crt.setSourceNode(rainNodes.outputNode);
    // pp.outputNode remains valid; crt.tick() returns newOutputNode when its
    // internal rebuild completes, and the bridge swaps pp.outputNode then.
  }

  async function animate(ts) {
    rafId = requestAnimationFrame(animate);
    if (!pp || rendering) return;
    rendering = true;
    try {
      rain.tick(ts * 0.001);          // rain tick takes seconds

      const crtResult = crt.tick(ts); // CRT tick takes raw RAF ms

      // Handle CRT pipeline rebuild (one-frame skip + deferred node swap)
      if (crtResult.skipRender) {
        if (crtResult.newOutputNode) {
          pp.outputNode = fxaa(crtResult.newOutputNode);
        }
        return;
      }

      await pp.render();

      rainNodes.postRender(rain.renderer);
      crt.postRender(rain.renderer);
    } finally {
      rendering = false;
    }
  }

  return {
    rain,
    get crt() { return crt; },
    destroy() {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      rainNodes?.dispose();
      rain.destroy();
      pp?.dispose?.();
    },
  };
}
