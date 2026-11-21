import './bunny.js';
import Module from 'manifold-3d';
import wasm from 'manifold-3d/manifold.wasm';
import { App } from './app.js';

(async () => {
  const status = document.getElementById('boot');
  try {
    const M = await Module({ wasmBinary: wasm });
    M.setup();
    window.app = new App(M);
    if (status) status.remove();
  } catch (e) {
    console.error(e);
    if (status) status.innerHTML = '<b>Geo-CAD 3D could not start.</b><br>' + String(e && e.message || e) + '<br>Try Chrome or Edge, and make sure WebGL is turned on.';
  }
})();
