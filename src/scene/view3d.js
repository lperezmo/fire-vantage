// 3D fire-vantage view: drape the parcel's satellite imagery over its real
// elevation, tint the spread-risk grid in red, mark the staging point, tint the
// selected spot's escape line-of-sight footprint in cyan, and float a wind
// arrow over the parcel centre showing the way the fire would push.
// Mechanics scaled down to a single parcel, adapted from drone-vantage.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer, raf, controls;

export function openViewer(canvas, result, spot) {
  disposeViewer();

  const { gridW, gridH, heights, metersPerPx } = result;
  const W = (gridW - 1) * metersPerPx;
  const H = (gridH - 1) * metersPerPx;

  const scene = new THREE.Scene();
  // Slightly smoky/warm tone to fit the fire theme.
  scene.background = new THREE.Color(0xb5a89a);
  scene.fog = new THREE.Fog(0xb5a89a, W * 0.9, W * 3.2);

  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight || 1.6, 1, 60000);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  resize(renderer, camera, canvas);

  scene.add(new THREE.HemisphereLight(0xfff0e0, 0x46402f, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.3);
  sun.position.set(-1, 1.4, 0.6);
  scene.add(sun);

  // ---- terrain mesh (origin at grid centre, +x east, +z south, +y up) ----
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(gridW * gridH * 3);
  const uv = new Float32Array(gridW * gridH * 2);
  const halfW = W / 2, halfH = H / 2;
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const i = r * gridW + c;
      pos[i * 3] = c * metersPerPx - halfW;
      pos[i * 3 + 1] = heights[i];
      pos[i * 3 + 2] = r * metersPerPx - halfH;
      uv[i * 2] = c / (gridW - 1);
      uv[i * 2 + 1] = 1 - r / (gridH - 1);
    }
  }
  const idx = [];
  for (let r = 0; r < gridH - 1; r++) {
    for (let c = 0; c < gridW - 1; c++) {
      const a = r * gridW + c;
      idx.push(a, a + gridW, a + 1, a + 1, a + gridW, a + gridW + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(gridW * gridH > 65000 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const texture = buildTexture(result, spot);
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  scene.add(new THREE.Mesh(geo, mat));

  // ---- staging marker (cyan pylon = safe staging point) ----
  const spotGround = heights[spot.oy * gridW + spot.ox];
  const vWorld = new THREE.Vector3(
    spot.ox * metersPerPx - halfW,
    spotGround,
    spot.oy * metersPerPx - halfH
  );
  const coneH = Math.max(28, W * 0.04);
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(8, W * 0.012), coneH, 4),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee })
  );
  marker.position.copy(vWorld).y += coneH / 2 + 6;
  scene.add(marker);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, coneH, 6),
    new THREE.MeshBasicMaterial({ color: 0x0c4a52 })
  );
  stem.position.copy(vWorld).y += coneH / 2 + 6;
  scene.add(stem);

  // ---- wind arrow (the fire touch) ----
  // Float an amber arrow over the parcel centre pointing the way the wind blows
  // TO. Wind direction is meteorological (degrees the wind comes FROM, clockwise
  // from north). The "blows-to" bearing is dirDeg + 180. In this scene +x=east,
  // +z=south, +y=up. A compass bearing b (clockwise from north) maps to a
  // horizontal vector of (dx=sin(b), dz=-cos(b)) when north is -z; but here
  // north is -z (row 0 = north sits at z = -halfH), so north points toward -z
  // and east toward +x. So for bearing b: dx = sin(b), dz = -cos(b).
  try {
    if (result.wind && typeof result.wind.dirDeg === 'number') {
      const toBearing = (result.wind.dirDeg + 180) * Math.PI / 180;
      const dir = new THREE.Vector3(Math.sin(toBearing), 0, -Math.cos(toBearing)).normalize();
      const len = Math.max(W, H) * 0.28;
      const hoverY = spotGround + Math.max(60, W * 0.10);
      const origin = new THREE.Vector3(0, hoverY, 0); // parcel centre
      const arrow = new THREE.ArrowHelper(
        dir, origin, len, 0xffb347,
        len * 0.28, len * 0.16
      );
      // thicken the shaft a touch so it reads at parcel scale
      if (arrow.line && arrow.line.material) arrow.line.material.linewidth = 2;
      scene.add(arrow);
    }
  } catch (e) {
    // defensive: missing or odd wind must never break the viewer
  }

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vWorld);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  const back = Math.max(W, H) * 0.55;
  camera.position.set(vWorld.x - back * 0.4, vWorld.y + back * 0.6, vWorld.z + back * 0.7);
  controls.update();

  const onResize = () => resize(renderer, camera, canvas);
  window.addEventListener('resize', onResize);
  renderer._onResize = onResize;

  const loop = () => {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
}

function resize(renderer, camera, canvas) {
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Imagery texture with the spread-risk grid tinted red and the selected spot's
// escape line-of-sight footprint tinted cyan on top.
function buildTexture(result, spot) {
  const { gridW, gridH, texBitmap, texW, texH } = result;
  const tw = texBitmap ? texW : gridW;
  const th = texBitmap ? texH : gridH;
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  const ctx = cv.getContext('2d');
  if (texBitmap) {
    ctx.drawImage(texBitmap, 0, 0);
  } else {
    // fallback: paint fuel density green (more fuel = deeper green)
    const fuel = result.fuel;
    const img = ctx.createImageData(gridW, gridH);
    for (let i = 0; i < gridW * gridH; i++) {
      const f = (fuel ? fuel[i] : 0) / 255;
      img.data[i * 4] = 90 - f * 40;
      img.data[i * 4 + 1] = 110 + f * 70;
      img.data[i * 4 + 2] = 70;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  ctx.imageSmoothingEnabled = true;

  // ---- spread-risk red tint (sampled/scaled up from cgW x cgH) ----
  try {
    const risk = result.risk;
    const cgW = result.cgW, cgH = result.cgH;
    if (risk && cgW && cgH) {
      // find max risk for normalisation so the tint always reads
      let maxR = 0;
      for (let i = 0; i < risk.length; i++) if (risk[i] > maxR) maxR = risk[i];
      if (maxR > 0) {
        const rv = document.createElement('canvas');
        rv.width = cgW; rv.height = cgH;
        const rctx = rv.getContext('2d');
        const rimg = rctx.createImageData(cgW, cgH);
        for (let i = 0; i < cgW * cgH; i++) {
          const n = Math.min(1, risk[i] / maxR);
          // high risk = stronger, more opaque red
          rimg.data[i * 4] = 255;
          rimg.data[i * 4 + 1] = Math.round(90 * (1 - n));
          rimg.data[i * 4 + 2] = 40 * (1 - n);
          rimg.data[i * 4 + 3] = Math.round(n * n * 150);
        }
        rctx.putImageData(rimg, 0, 0);
        ctx.drawImage(rv, 0, 0, tw, th);
      }
    }
  } catch (e) {
    // defensive: a missing or malformed risk grid must never break the texture
  }

  // ---- escape line-of-sight footprint (cyan, scaled grid -> texture res) ----
  try {
    const fp = spot && spot.footprint;
    if (fp) {
      const ov = document.createElement('canvas');
      ov.width = gridW; ov.height = gridH;
      const octx = ov.getContext('2d');
      const oimg = octx.createImageData(gridW, gridH);
      for (let i = 0; i < fp.length; i++) {
        if (fp[i]) {
          oimg.data[i * 4] = 120;
          oimg.data[i * 4 + 1] = 220;
          oimg.data[i * 4 + 2] = 255;
          oimg.data[i * 4 + 3] = 90;
        }
      }
      octx.putImageData(oimg, 0, 0);
      ctx.drawImage(ov, 0, 0, tw, th);
    }
  } catch (e) {
    // defensive
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function disposeViewer() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (controls) { controls.dispose(); controls = null; }
  if (renderer) {
    if (renderer._onResize) window.removeEventListener('resize', renderer._onResize);
    renderer.dispose();
    renderer = null;
  }
}
