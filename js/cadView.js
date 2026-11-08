/**
 * Pure 2D CAD Drawing Viewer Engine (HTML5 Canvas)
 * Handles:
 * 1. Rendering pure AutoCAD-style drawing without map background
 * 2. Focusing & zooming into a specific CAD coordinate / entity handed off from the Map View
 * 3. Vertex / Entity snapping when clicking on the drawing to trigger "Show Map Overlay at this Location"
 * 4. 2-Point Distance & Delta-X / Delta-Y measurement tool
 */

export class CadView {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'w-full h-full block cursor-grab active:cursor-grabbing';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.onSelectLocation = options.onSelectLocation || null;
    this.onHoverCoords = options.onHoverCoords || null;

    this.cadData = null; // { entities, layers, bounds }
    this.originX = 0;
    this.originY = 0;
    this.scale = 1.0;
    this.minScale = 0.0001;
    this.maxScale = 50000;

    // Selection & Center Crosshair Snap state
    this.selectedPoint = null; // { cadX, cadY, entity, title, layerName, typeLabel }
    this.centerSnap = null;    // { x, y, title, layerName, typeLabel, entity }
    this.hoverSnap = null;     // { x, y, title, entity }

    // Measurement tool state
    this.measureMode = false;
    this.measurePoints = [];

    // Pan/Pinch interaction state
    this.isDragging = false;
    this.dragMoved = 0;
    this.dragStart = { x: 0, y: 0 };
    this.touchPinchDist = null;

    // Pulse animation frame for highlighted target
    this.pulsePhase = 0;
    this.animFrame = null;

    this.resize();
    this.bindEvents();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  setCadData(cadData, fit = true) {
    this.cadData = cadData;
    if (fit) {
      this.fitExtents();
    } else {
      this.render();
    }
  }

  toScreen(wx, wy) {
    return {
      x: (wx - this.originX) * this.scale + this.width / 2,
      y: this.height / 2 - (wy - this.originY) * this.scale
    };
  }

  toWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.scale + this.originX,
      y: (this.height / 2 - sy) / this.scale + this.originY
    };
  }

  fitExtents() {
    if (!this.cadData || !this.cadData.bounds || this.cadData.bounds.minX === Infinity) {
      this.originX = 0;
      this.originY = 0;
      this.scale = 1.0;
      this.render();
      return;
    }

    if (!this.width || !this.height) {
      this.resize();
    }

    const viewW = this.width || window.innerWidth || 360;
    const viewH = this.height || (window.innerHeight - 130) || 560;

    const b = this.cadData.bounds;
    this.originX = (b.minX + b.maxX) / 2;
    this.originY = (b.minY + b.maxY) / 2;

    const dx = Math.max(b.maxX - b.minX, 10);
    const dy = Math.max(b.maxY - b.minY, 10);
    const pad = Math.min(Math.min(viewW, viewH) * 0.12, 56);

    const scaleX = Math.max(viewW - pad * 2, 120) / dx;
    const scaleY = Math.max(viewH - pad * 2, 120) / dy;
    this.scale = Math.max(Math.min(scaleX, scaleY), 0.001);
    this.render();
  }

  /**
   * Focus and zoom into a specific CAD coordinate / entity (triggered when switching from Map -> CAD View)
   */
  focusSelection(selection, zoomIn = true) {
    this.selectedPoint = selection;

    if (!selection || selection.cadX === null || selection.cadY === null) {
      this.render();
      return;
    }

    if (!this.width || !this.height) {
      this.resize();
    }

    if (zoomIn) {
      this.originX = selection.cadX;
      this.originY = selection.cadY;

      // Choose a comfortable detail zoom level (~25m to 35m visible window around the component)
      if (this.cadData && this.cadData.bounds) {
        const b = this.cadData.bounds;
        const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 20);
        const detailWindow = Math.min(Math.max(span * 0.28, 22), 80);
        this.scale = Math.min(this.width, this.height) / detailWindow;
      } else {
        this.scale = 15;
      }
    }

    this.startPulseAnimation();
    this.render();
  }

  startPulseAnimation() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    let frames = 0;
    const step = () => {
      frames++;
      this.pulsePhase = (frames % 60) / 60;
      this.render();
      if (frames < 180 && this.selectedPoint) {
        this.animFrame = requestAnimationFrame(step);
      }
    };
    this.animFrame = requestAnimationFrame(step);
  }

  toggleMeasureMode() {
    this.measureMode = !this.measureMode;
    this.measurePoints = [];
    this.render();
    return this.measureMode;
  }

  render() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. AutoCAD Dark Blueprint Background
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Coordinate Grid & Axes
    this.drawGrid(ctx);

    // 3. Render CAD Entities
    if (this.cadData && this.cadData.entities) {
      this.drawEntities(ctx);
    }

    // 4. Evaluate Fixed Center Crosshair Coordinates & Snap
    this.updateCenterCrosshairState(ctx);

    // 5. Render Measurement Tool Overlay
    if (this.measurePoints.length > 0) {
      this.drawMeasurement(ctx);
    }

    // 6. Render Selected Component Target & Crosshair
    if (this.selectedPoint && this.selectedPoint.cadX !== null && this.selectedPoint.cadY !== null) {
      this.drawSelectionHighlight(ctx, this.selectedPoint);
    }

    ctx.restore();
  }

  /**
   * Always compute the CAD coordinates under the fixed screen-center crosshair (originX, originY)
   * and snap to any nearby vertex/entity within 18px of the center crosshair.
   */
  updateCenterCrosshairState(ctx) {
    const snapRadiusWorld = 18 / this.scale;
    const snap = this.findNearestTarget(this.originX, this.originY, snapRadiusWorld);
    this.centerSnap = snap;

    // Draw cyan snap indicator box & line from center to snapped point
    if (snap) {
      const sp = this.toScreen(snap.x, snap.y);
      const cx = this.width / 2;
      const cy = this.height / 2;

      ctx.save();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.strokeRect(sp.x - 6, sp.y - 6, 12, 12);

      if (Math.hypot(sp.x - cx, sp.y - cy) > 2) {
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.moveTo(cx, cy);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Update DOM Crosshair visual state & Live Coordinate Readout
    const crosshairEl = document.getElementById('cad-center-crosshair');
    const tagEl = document.getElementById('cad-crosshair-tag');
    if (crosshairEl) {
      crosshairEl.classList.toggle('is-snapped', !!snap);
    }
    if (tagEl) {
      if (snap) {
        tagEl.textContent = `🎯 ${snap.title}`;
        tagEl.classList.remove('hidden');
      } else {
        tagEl.classList.add('hidden');
      }
    }

    if (this.onHoverCoords) {
      const targetX = snap ? snap.x : this.originX;
      const targetY = snap ? snap.y : this.originY;
      this.onHoverCoords(targetX, targetY, snap ? snap.title : null);
    }
  }

  /**
   * Return the selection object for whatever is currently under the fixed center crosshair
   */
  getCenterSelection() {
    const snap = this.centerSnap || this.findNearestTarget(this.originX, this.originY, 18 / this.scale);
    const targetX = snap ? snap.x : this.originX;
    const targetY = snap ? snap.y : this.originY;

    const selection = {
      source: 'cad',
      cadX: targetX,
      cadY: targetY,
      lat: null,
      lng: null,
      entity: snap ? snap.entity : null,
      title: snap ? snap.title : '중앙 십자선 지정 위치',
      layerName: snap ? snap.layerName : '도면 중앙 좌표',
      typeLabel: snap ? snap.typeLabel : '십자선 좌표점'
    };

    this.selectedPoint = selection;
    this.startPulseAnimation();
    this.render();
    return selection;
  }

  /**
   * Add a measurement point at the current center crosshair position
   */
  addMeasurePointAtCenter() {
    const snap = this.centerSnap || this.findNearestTarget(this.originX, this.originY, 18 / this.scale);
    const pt = {
      x: snap ? snap.x : this.originX,
      y: snap ? snap.y : this.originY
    };
    if (this.measurePoints.length >= 2) {
      this.measurePoints = [pt];
    } else {
      this.measurePoints.push(pt);
    }
    this.render();
  }

  drawGrid(ctx) {
    const targetPx = 90;
    const rawStep = targetPx / this.scale;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = pow10;
    if (rawStep / pow10 >= 5) step = pow10 * 5;
    else if (rawStep / pow10 >= 2) step = pow10 * 2;

    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.width, this.height);

    const startX = Math.floor(tl.x / step) * step;
    const endX = Math.ceil(br.x / step) * step;
    const startY = Math.floor(br.y / step) * step;
    const endY = Math.ceil(tl.y / step) * step;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.font = '10px monospace';

    let lastLabelX = -100;
    for (let x = startX; x <= endX; x += step) {
      const sp = this.toScreen(x, 0);
      ctx.beginPath();
      ctx.moveTo(sp.x, 0);
      ctx.lineTo(sp.x, this.height);
      ctx.stroke();
      if (sp.x - lastLabelX >= 68) {
        ctx.fillText(x.toFixed(0), sp.x + 4, this.height - 8);
        lastLabelX = sp.x;
      }
    }

    for (let y = startY; y <= endY; y += step) {
      const sp = this.toScreen(0, y);
      ctx.beginPath();
      ctx.moveTo(0, sp.y);
      ctx.lineTo(this.width, sp.y);
      ctx.stroke();
      if (sp.y > 18 && sp.y < this.height - 20) {
        ctx.fillText(y.toFixed(0), 6, sp.y - 4);
      }
    }
  }

  drawEntities(ctx) {
    const selectedId = this.selectedPoint && this.selectedPoint.entity ? this.selectedPoint.entity.id : null;

    this.cadData.entities.forEach((ent) => {
      const layer = this.cadData.layers[ent.layer];
      if (layer && layer.visible === false) return;

      const isSelected = ent.id === selectedId;
      const baseColor = isSelected
        ? '#f43f5e'
        : (ent.color || (layer ? layer.color : '#22d3ee'));

      ctx.strokeStyle = baseColor;
      ctx.fillStyle = baseColor;
      ctx.lineWidth = isSelected ? 3.5 : 1.6;

      switch (ent.type) {
        case 'LINE': {
          const p1 = this.toScreen(ent.x1, ent.y1);
          const p2 = this.toScreen(ent.x2, ent.y2);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          break;
        }

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (!ent.vertices || ent.vertices.length < 2) break;
          ctx.beginPath();
          const first = this.toScreen(ent.vertices[0].x, ent.vertices[0].y);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < ent.vertices.length; i++) {
            const p = this.toScreen(ent.vertices[i].x, ent.vertices[i].y);
            ctx.lineTo(p.x, p.y);
          }
          if (ent.closed) {
            ctx.closePath();
            ctx.save();
            ctx.fillStyle = isSelected ? 'rgba(244, 63, 94, 0.2)' : 'rgba(56, 189, 248, 0.06)';
            ctx.fill();
            ctx.restore();
          }
          ctx.stroke();
          break;
        }

        case 'CIRCLE':
        case 'ARC': {
          const c = this.toScreen(ent.cx, ent.cy);
          const r = Math.max(ent.radius * this.scale, 3);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
          ctx.save();
          ctx.fillStyle = isSelected ? 'rgba(244, 63, 94, 0.35)' : 'rgba(34, 211, 238, 0.15)';
          ctx.fill();
          ctx.restore();
          ctx.stroke();

          // Draw center cross for installation circles (manholes/valves)
          ctx.beginPath();
          ctx.moveTo(c.x - 4, c.y);
          ctx.lineTo(c.x + 4, c.y);
          ctx.moveTo(c.x, c.y - 4);
          ctx.lineTo(c.x, c.y + 4);
          ctx.stroke();
          break;
        }

        case 'INSERT': {
          const p = this.toScreen(ent.x, ent.y);
          // Draw distinct installation block symbol (diamond + cross)
          const sz = isSelected ? 9 : 6;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - sz);
          ctx.lineTo(p.x + sz, p.y);
          ctx.lineTo(p.x, p.y + sz);
          ctx.lineTo(p.x - sz, p.y);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          break;
        }

        case 'POINT': {
          const p = this.toScreen(ent.x, ent.y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, isSelected ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.stroke();
          break;
        }

        case 'TEXT':
        case 'MTEXT': {
          if (!ent.text) break;
          const rawFontPx = (ent.height || 1.8) * this.scale;
          if (rawFontPx < 3.5 && !isSelected) break;
          const p = this.toScreen(ent.x, ent.y);
          const fontPx = Math.max(Math.min(rawFontPx, 20), 9.5);
          ctx.font = `600 ${fontPx}px "Pretendard", system-ui, sans-serif`;
          const clean = ent.text.replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
          ctx.fillStyle = '#0b1120';
          ctx.fillText(clean, p.x + 1, p.y + 1);
          ctx.fillStyle = isSelected ? '#fda4af' : baseColor;
          ctx.fillText(clean, p.x, p.y);
          break;
        }
      }
    });
  }

  drawSelectionHighlight(ctx, sel) {
    const sp = this.toScreen(sel.cadX, sel.cadY);

    // Expanding pulse ring
    const pulseRadius = 14 + this.pulsePhase * 24;
    const pulseAlpha = Math.max(0, 0.85 - this.pulsePhase * 0.85);

    ctx.save();
    ctx.strokeStyle = `rgba(244, 63, 94, ${pulseAlpha})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, pulseRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Target reticle
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 11, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sp.x - 18, sp.y);
    ctx.lineTo(sp.x - 5, sp.y);
    ctx.moveTo(sp.x + 5, sp.y);
    ctx.lineTo(sp.x + 18, sp.y);
    ctx.moveTo(sp.x, sp.y - 18);
    ctx.lineTo(sp.x, sp.y - 5);
    ctx.moveTo(sp.x, sp.y + 5);
    ctx.lineTo(sp.x, sp.y + 18);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = '#fb7185';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Callout Tag above target
    const label = sel.title || '선택 위치';
    ctx.font = 'bold 12px system-ui, sans-serif';
    const textW = ctx.measureText(label).width;
    const boxW = textW + 20;
    const boxH = 24;
    const boxX = sp.x - boxW / 2;
    const boxY = sp.y - 42;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(label, sp.x, boxY + 16);
    ctx.restore();
  }

  drawMeasurement(ctx) {
    const p1 = this.measurePoints[0];
    const centerPt = this.centerSnap
      ? { x: this.centerSnap.x, y: this.centerSnap.y }
      : { x: this.originX, y: this.originY };
    const p2 = this.measurePoints[1] || centerPt;

    const s1 = this.toScreen(p1.x, p1.y);
    const s2 = this.toScreen(p2.x, p2.y);

    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    [s1, s2].forEach((pt) => {
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);

    if (dist > 0.001) {
      const mx = (s1.x + s2.x) / 2;
      const my = (s1.y + s2.y) / 2;
      const text = `거리: ${dist.toFixed(2)}m (ΔX:${dx.toFixed(1)}, ΔY:${dy.toFixed(1)})`;
      ctx.font = 'bold 11px monospace';
      const w = ctx.measureText(text).width + 16;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(mx - w / 2, my - 14, w, 24, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fde047';
      ctx.textAlign = 'center';
      ctx.fillText(text, mx, my + 2);
    }
    ctx.restore();
  }

  /**
   * Find nearest CAD entity or vertex within snap radius
   */
  findNearestTarget(wx, wy, maxRadiusWorld) {
    if (!this.cadData || !this.cadData.entities) return null;

    let best = null;
    let minDist = maxRadiusWorld;

    const consider = (x, y, entity, pointLabel, priorityBonus = 0) => {
      const d = Math.hypot(x - wx, y - wy) - priorityBonus;
      if (d < minDist) {
        minDist = d;
        best = {
          x,
          y,
          entity,
          title: entity.displayName || pointLabel,
          layerName: entity.layer,
          typeLabel: pointLabel || entity.type
        };
      }
    };

    this.cadData.entities.forEach((ent) => {
      const layer = this.cadData.layers[ent.layer];
      if (layer && layer.visible === false) return;

      if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
        consider(ent.cx, ent.cy, ent, '원형 설비 중심', maxRadiusWorld * 0.2);
      } else if (ent.type === 'INSERT') {
        consider(ent.x, ent.y, ent, '설치 블록 기준점', maxRadiusWorld * 0.25);
      } else if (ent.type === 'POINT') {
        consider(ent.x, ent.y, ent, '측점/기준점', maxRadiusWorld * 0.25);
      } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
        consider(ent.x, ent.y, ent, '도면 문자 위치', 0);
      } else if (ent.type === 'LINE') {
        consider(ent.x1, ent.y1, ent, '선 끝점');
        consider(ent.x2, ent.y2, ent, '선 끝점');
        // Also project onto line segment
        const proj = this.projectPointOnSegment(wx, wy, ent.x1, ent.y1, ent.x2, ent.y2);
        if (proj) consider(proj.x, proj.y, ent, '선분 위 지점', -maxRadiusWorld * 0.1);
      } else if (ent.vertices && ent.vertices.length >= 2) {
        ent.vertices.forEach((v, idx) => {
          consider(v.x, v.y, ent, `정점 #${idx + 1}`);
        });
        for (let i = 0; i < ent.vertices.length - 1; i++) {
          const a = ent.vertices[i];
          const b = ent.vertices[i + 1];
          const proj = this.projectPointOnSegment(wx, wy, a.x, a.y, b.x, b.y);
          if (proj) consider(proj.x, proj.y, ent, '폴리라인 선분', -maxRadiusWorld * 0.1);
        }
      }
    });

    return best;
  }

  projectPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return null;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
    return { x: x1 + t * dx, y: y1 + t * dy };
  }

  bindEvents() {
    const el = this.canvas;

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.isDragging = true;
      this.dragMoved = 0;
      this.dragStart = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.dragStart = { x: e.clientX, y: e.clientY };

        this.originX -= dx / this.scale;
        this.originY += dy / this.scale;
        this.render();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Zoom centered around the fixed center crosshair (or mouse if shift held)
      const factor = e.deltaY < 0 ? 1.18 : 0.85;
      this.scale = Math.max(Math.min(this.scale * factor, this.maxScale), this.minScale);
      this.render();
    }, { passive: false });

    // Touch support
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.dragMoved = 0;
        this.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this.touchPinchDist = Math.hypot(dx, dy);
      }
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.dragStart.x;
        const dy = e.touches[0].clientY - this.dragStart.y;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.originX -= dx / this.scale;
        this.originY += dy / this.scale;
        this.render();
      } else if (e.touches.length === 2 && this.touchPinchDist) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const factor = dist / this.touchPinchDist;
        this.touchPinchDist = dist;

        this.scale = Math.max(Math.min(this.scale * factor, this.maxScale), this.minScale);
        this.render();
      }
    }, { passive: true });

    el.addEventListener('touchend', () => {
      this.isDragging = false;
      this.touchPinchDist = null;
    }, { passive: true });

    // Clicking/tapping on an entity/point on the canvas smoothly glides that point to the center crosshair and selects it
    el.addEventListener('click', (e) => {
      if (this.dragMoved > 6) return;

      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = this.toWorld(sx, sy);

      const nearest = this.findNearestTarget(world.x, world.y, 26 / this.scale);
      const targetX = nearest ? nearest.x : world.x;
      const targetY = nearest ? nearest.y : world.y;

      // Move the drawing so the clicked point aligns directly with the center crosshair
      this.originX = targetX;
      this.originY = targetY;

      if (this.measureMode) {
        if (this.measurePoints.length >= 2) {
          this.measurePoints = [{ x: targetX, y: targetY }];
        } else {
          this.measurePoints.push({ x: targetX, y: targetY });
        }
        this.render();
        return;
      }

      const selection = {
        source: 'cad',
        cadX: targetX,
        cadY: targetY,
        lat: null,
        lng: null,
        entity: nearest ? nearest.entity : null,
        title: nearest ? nearest.title : '중앙 십자선 지정 위치',
        layerName: nearest ? nearest.layerName : '도면 중앙 좌표',
        typeLabel: nearest ? nearest.typeLabel : '십자선 좌표점'
      };

      this.selectedPoint = selection;
      this.startPulseAnimation();
      this.render();

      if (this.onSelectLocation) {
        this.onSelectLocation(selection);
      }
    });
  }
}
