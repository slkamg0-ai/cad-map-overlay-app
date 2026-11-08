/**
 * High-performance DXF & DWG Parser for CAD-Map Bidirectional Overlay
 * Parses LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, INSERT, POINT, TEXT, MTEXT
 * and assigns unique entity IDs and installation component metadata.
 */

const ACI_COLORS = {
  1: '#ff3b30', // Red
  2: '#facc15', // Yellow
  3: '#4ade80', // Green
  4: '#22d3ee', // Cyan
  5: '#60a5fa', // Blue
  6: '#e879f9', // Magenta
  7: '#f8fafc', // White
  8: '#94a3b8', // Gray
  9: '#cbd5e1', // Light Gray
  30: '#fb923c', // Orange
  40: '#fbbf24'
};

export class DxfParser {
  constructor() {
    this.layers = {};
    this.entities = [];
    this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.wasmModule = null;
  }

  parse(text) {
    const lines = text.split(/\r?\n/);
    const n = lines.length;
    let i = 0;

    this.layers = {
      '0': { name: '0', color: '#22d3ee', visible: true, count: 0 }
    };
    this.entities = [];
    this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    let currentSection = null;

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';
      i += 2;

      if (code === 0 && val === 'SECTION') {
        if (i < n - 1 && parseInt(lines[i].trim(), 10) === 2) {
          currentSection = lines[i + 1].trim();
          i += 2;
        }
        continue;
      }

      if (code === 0 && val === 'ENDSEC') {
        currentSection = null;
        continue;
      }

      if (code === 0 && val === 'EOF') break;

      if (currentSection === 'TABLES') {
        if (code === 0 && val === 'LAYER') {
          i = this.parseLayer(lines, i, n);
        }
      } else if (currentSection === 'ENTITIES') {
        if (code === 0) {
          i = this.parseEntity(val, lines, i, n);
        }
      }
    }

    // Attach nearby text labels to installation objects (e.g. CIRCLE/INSERT/POINT)
    this.enrichComponentNames();

    return {
      entities: this.entities,
      layers: this.layers,
      bounds: this.bounds,
      totalCount: this.entities.length
    };
  }

  parseLayer(lines, startIndex, n) {
    let i = startIndex;
    let layerName = '0';
    let colorIndex = 7;

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';
      if (code === 0) break;

      if (code === 2) layerName = val;
      else if (code === 62) colorIndex = Math.abs(parseInt(val, 10));
      i += 2;
    }

    this.layers[layerName] = {
      name: layerName,
      color: ACI_COLORS[colorIndex] || '#38bdf8',
      colorIndex,
      visible: true,
      count: 0
    };
    return i;
  }

  updateBounds(x, y) {
    if (isNaN(x) || isNaN(y)) return;
    if (x < this.bounds.minX) this.bounds.minX = x;
    if (y < this.bounds.minY) this.bounds.minY = y;
    if (x > this.bounds.maxX) this.bounds.maxX = x;
    if (y > this.bounds.maxY) this.bounds.maxY = y;
  }

  parseEntity(type, lines, startIndex, n) {
    let i = startIndex;
    const entity = {
      id: `ent_${this.entities.length + 1}`,
      type,
      layer: '0',
      color: null,
      vertices: [],
      blockName: null,
      text: null
    };

    let currVertex = null;
    const polylineVertices = [];

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === 0) {
        if (type === 'POLYLINE' && val === 'VERTEX') {
          i += 2;
          const v = this.parseVertex(lines, i, n);
          i = v.nextIndex;
          if (v.point) {
            polylineVertices.push(v.point);
            this.updateBounds(v.point.x, v.point.y);
          }
          continue;
        } else if (type === 'POLYLINE' && val === 'SEQEND') {
          i += 2;
          break;
        } else {
          break;
        }
      }

      if (code === 8) {
        entity.layer = val;
        if (!this.layers[val]) {
          this.layers[val] = { name: val, color: '#38bdf8', visible: true, count: 0 };
        }
      } else if (code === 62) {
        entity.color = ACI_COLORS[Math.abs(parseInt(val, 10))] || null;
      } else if (code === 420) {
        const rgb = parseInt(val, 10);
        entity.color = `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
      }

      switch (type) {
        case 'LINE':
          if (code === 10) entity.x1 = parseFloat(val);
          else if (code === 20) entity.y1 = parseFloat(val);
          else if (code === 11) entity.x2 = parseFloat(val);
          else if (code === 21) entity.y2 = parseFloat(val);
          break;

        case 'POINT':
        case 'INSERT':
          if (code === 2 && type === 'INSERT') entity.blockName = val;
          else if (code === 10) entity.x = parseFloat(val);
          else if (code === 20) entity.y = parseFloat(val);
          else if (code === 50) entity.rotation = parseFloat(val);
          break;

        case 'CIRCLE':
        case 'ARC':
          if (code === 10) entity.cx = parseFloat(val);
          else if (code === 20) entity.cy = parseFloat(val);
          else if (code === 40) entity.radius = parseFloat(val);
          else if (code === 50) entity.startAngle = parseFloat(val);
          else if (code === 51) entity.endAngle = parseFloat(val);
          break;

        case 'LWPOLYLINE':
          if (code === 70) entity.closed = (parseInt(val, 10) & 1) === 1;
          else if (code === 10) {
            currVertex = { x: parseFloat(val), y: 0 };
            entity.vertices.push(currVertex);
          } else if (code === 20 && currVertex) {
            currVertex.y = parseFloat(val);
            this.updateBounds(currVertex.x, currVertex.y);
          }
          break;

        case 'TEXT':
        case 'MTEXT':
          if (code === 1) entity.text = val;
          else if (code === 10) entity.x = parseFloat(val);
          else if (code === 20) entity.y = parseFloat(val);
          else if (code === 40) entity.height = parseFloat(val);
          else if (code === 50) entity.rotation = parseFloat(val);
          break;
      }

      i += 2;
    }

    // Finalize geometry and center point (anchor) for synchronization
    let valid = false;
    if (type === 'LINE' && !isNaN(entity.x1) && !isNaN(entity.y1) && !isNaN(entity.x2) && !isNaN(entity.y2)) {
      this.updateBounds(entity.x1, entity.y1);
      this.updateBounds(entity.x2, entity.y2);
      entity.anchor = { x: (entity.x1 + entity.x2) / 2, y: (entity.y1 + entity.y2) / 2 };
      entity.length = Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1);
      valid = true;
    } else if ((type === 'POINT' || type === 'INSERT' || type === 'TEXT' || type === 'MTEXT') && !isNaN(entity.x) && !isNaN(entity.y)) {
      this.updateBounds(entity.x, entity.y);
      entity.anchor = { x: entity.x, y: entity.y };
      valid = true;
    } else if ((type === 'CIRCLE' || type === 'ARC') && !isNaN(entity.cx) && !isNaN(entity.cy) && !isNaN(entity.radius)) {
      this.updateBounds(entity.cx - entity.radius, entity.cy - entity.radius);
      this.updateBounds(entity.cx + entity.radius, entity.cy + entity.radius);
      entity.anchor = { x: entity.cx, y: entity.cy };
      valid = true;
    } else if (type === 'POLYLINE' && polylineVertices.length >= 2) {
      entity.vertices = polylineVertices;
      entity.anchor = this.computeCentroid(entity.vertices);
      valid = true;
    } else if (type === 'LWPOLYLINE' && entity.vertices.length >= 2) {
      entity.anchor = this.computeCentroid(entity.vertices);
      valid = true;
    }

    if (valid) {
      if (this.layers[entity.layer]) this.layers[entity.layer].count++;
      entity.displayName = this.getDefaultDisplayName(entity);
      this.entities.push(entity);
    }

    return i;
  }

  computeCentroid(vertices) {
    let sx = 0, sy = 0;
    vertices.forEach((v) => { sx += v.x; sy += v.y; });
    return { x: sx / vertices.length, y: sy / vertices.length };
  }

  getDefaultDisplayName(ent) {
    if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      const clean = (ent.text || '').replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
      return `문자: ${clean}`;
    }
    if (ent.type === 'INSERT') return `설치블록 [${ent.blockName || ent.layer}]`;
    if (ent.type === 'CIRCLE') return `원형 설비/맨홀 (R=${ent.radius.toFixed(2)}m)`;
    if (ent.type === 'ARC') return `호 (R=${ent.radius.toFixed(2)}m)`;
    if (ent.type === 'POINT') return `설치 기준점/측점 (${ent.layer})`;
    if (ent.type === 'LINE') return `선형 구간 (L=${(ent.length || 0).toFixed(1)}m)`;
    if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
      return ent.closed ? `구조물/구역 경계 (${ent.layer})` : `연속 관로/선형 (${ent.layer})`;
    }
    return `${ent.type} (${ent.layer})`;
  }

  enrichComponentNames() {
    const texts = this.entities.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text);
    this.entities.forEach((ent) => {
      if (ent.type === 'CIRCLE' || ent.type === 'POINT' || ent.type === 'INSERT') {
        let bestText = null;
        let minDist = 6.5; // Within 6.5 CAD units
        texts.forEach((t) => {
          const d = Math.hypot(t.anchor.x - ent.anchor.x, t.anchor.y - ent.anchor.y);
          if (d < minDist) {
            minDist = d;
            bestText = t.text.replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
          }
        });
        if (bestText) {
          ent.nearbyLabel = bestText;
          ent.displayName = `${bestText} (${ent.type === 'CIRCLE' ? '원형 설비' : ent.type === 'INSERT' ? '블록' : '기준점'})`;
        }
      }
    });
  }

  parseVertex(lines, startIndex, n) {
    let i = startIndex;
    const pt = { x: 0, y: 0 };
    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';
      if (code === 0) break;
      if (code === 10) pt.x = parseFloat(val);
      else if (code === 20) pt.y = parseFloat(val);
      i += 2;
    }
    return { point: pt, nextIndex: i };
  }

  async parseDwg(arrayBuffer) {
    if (!this.wasmModule) {
      const mod = await import('../wasm/libredwg-web.js');
      const factory = mod.default || mod;
      this.wasmModule = await factory({ locateFile: (f) => `./wasm/${f}` });
    }
    const wasm = this.wasmModule;

    this.layers = { '0': { name: '0', color: '#22d3ee', visible: true, count: 0 } };
    this.entities = [];
    this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    const fileName = 'tmp_input.dwg';
    const uint8 = new Uint8Array(arrayBuffer);
    let dataPtr = 0;

    try {
      wasm.FS.writeFile(fileName, uint8);
      const result = wasm.dwg_read_file(fileName);
      if (!result || !result.data) throw new Error('DWG 파일을 읽을 수 없습니다.');
      dataPtr = result.data;

      const modelSpace = wasm.dwg_model_space_object(dataPtr);
      let next = wasm.get_first_owned_entity(modelSpace);

      const DWG_TYPE_LINE = 19;
      const DWG_TYPE_POINT = 27;
      const DWG_TYPE_POLYLINE_2D = 15;
      const DWG_TYPE_POLYLINE_3D = 16;
      const DWG_TYPE_LWPOLYLINE = 77;
      const DWG_TYPE_CIRCLE = 18;

      while (next) {
        const objPtr = next;
        next = wasm.get_next_owned_entity(modelSpace, objPtr);
        const fixedtype = wasm.dwg_object_get_fixedtype(objPtr);
        const entityTio = wasm.dwg_object_to_entity_tio(objPtr);
        if (!entityTio) continue;

        if (fixedtype === DWG_TYPE_LINE) {
          const start = wasm.dwg_dynapi_entity_value(entityTio, 'start')?.data;
          const end = wasm.dwg_dynapi_entity_value(entityTio, 'end')?.data;
          if (start && end) {
            this.updateBounds(start.x, start.y);
            this.updateBounds(end.x, end.y);
            const ent = {
              id: `ent_${this.entities.length + 1}`,
              type: 'LINE',
              layer: '0',
              color: '#4ade80',
              x1: start.x,
              y1: start.y,
              x2: end.x,
              y2: end.y,
              anchor: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
              length: Math.hypot(end.x - start.x, end.y - start.y)
            };
            ent.displayName = this.getDefaultDisplayName(ent);
            this.entities.push(ent);
            this.layers['0'].count++;
          }
        } else if (fixedtype === DWG_TYPE_POINT) {
          const x = wasm.dwg_dynapi_entity_value(entityTio, 'x')?.data;
          const y = wasm.dwg_dynapi_entity_value(entityTio, 'y')?.data;
          if (typeof x === 'number' && typeof y === 'number') {
            this.updateBounds(x, y);
            const ent = {
              id: `ent_${this.entities.length + 1}`,
              type: 'POINT',
              layer: '0',
              color: '#facc15',
              x,
              y,
              anchor: { x, y }
            };
            ent.displayName = this.getDefaultDisplayName(ent);
            this.entities.push(ent);
            this.layers['0'].count++;
          }
        } else if (fixedtype === DWG_TYPE_CIRCLE) {
          const center = wasm.dwg_dynapi_entity_value(entityTio, 'center')?.data;
          const radius = wasm.dwg_dynapi_entity_value(entityTio, 'radius')?.data;
          if (center && typeof radius === 'number') {
            this.updateBounds(center.x - radius, center.y - radius);
            this.updateBounds(center.x + radius, center.y + radius);
            const ent = {
              id: `ent_${this.entities.length + 1}`,
              type: 'CIRCLE',
              layer: '0',
              color: '#22d3ee',
              cx: center.x,
              cy: center.y,
              radius,
              anchor: { x: center.x, y: center.y }
            };
            ent.displayName = this.getDefaultDisplayName(ent);
            this.entities.push(ent);
            this.layers['0'].count++;
          }
        } else if (fixedtype === DWG_TYPE_LWPOLYLINE) {
          const numPoints = wasm.dwg_dynapi_entity_value(entityTio, 'num_points')?.data;
          if (numPoints && numPoints >= 2) {
            const ptsPtr = wasm.dwg_dynapi_entity_value(entityTio, 'points')?.data;
            const pts = wasm.dwg_ptr_to_point2d_array(ptsPtr, numPoints);
            if (pts && Array.isArray(pts)) {
              const vertices = pts.map((pt) => {
                this.updateBounds(pt.x, pt.y);
                return { x: pt.x, y: pt.y };
              });
              const ent = {
                id: `ent_${this.entities.length + 1}`,
                type: 'LWPOLYLINE',
                layer: '0',
                color: '#38bdf8',
                closed: false,
                vertices,
                anchor: this.computeCentroid(vertices)
              };
              ent.displayName = this.getDefaultDisplayName(ent);
              this.entities.push(ent);
              this.layers['0'].count++;
            }
          }
        } else if (fixedtype === DWG_TYPE_POLYLINE_2D || fixedtype === DWG_TYPE_POLYLINE_3D) {
          const rawResult = fixedtype === DWG_TYPE_POLYLINE_2D
            ? wasm.dwg_entity_polyline_2d_get_points(objPtr)
            : wasm.dwg_entity_polyline_3d_get_points(objPtr);
          const pts = rawResult?.data ?? rawResult;
          if (pts && Array.isArray(pts) && pts.length >= 2) {
            const vertices = pts.map((pt) => {
              this.updateBounds(pt.x, pt.y);
              return { x: pt.x, y: pt.y };
            });
            const ent = {
              id: `ent_${this.entities.length + 1}`,
              type: 'POLYLINE',
              layer: '0',
              color: '#38bdf8',
              closed: false,
              vertices,
              anchor: this.computeCentroid(vertices)
            };
            ent.displayName = this.getDefaultDisplayName(ent);
            this.entities.push(ent);
            this.layers['0'].count++;
          }
        }
      }

      return {
        entities: this.entities,
        layers: this.layers,
        bounds: this.bounds,
        totalCount: this.entities.length
      };
    } finally {
      if (dataPtr) wasm.dwg_free(dataPtr);
      if (wasm.FS.analyzePath(fileName, false).exists) {
        wasm.FS.unlink(fileName);
      }
    }
  }
}
