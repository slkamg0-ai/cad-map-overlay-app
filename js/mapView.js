/**
 * Map Overlay View Engine (Leaflet + VWorld Satellite/Hybrid + CAD Vector Overlay)
 * Handles:
 * 1. Rendering uploaded CAD drawings on satellite/road map
 * 2. Clicking any CAD component or arbitrary map location to inspect installation details
 * 3. Highlighting selected installation point with neon target pin & triggers to "View CAD Drawing at this Location"
 */

export class MapView {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.onSelectLocation = options.onSelectLocation || null; // (selectionData) => void
    this.onMapClickForCalib = options.onMapClickForCalib || null;
    this.onHoverCoords = options.onHoverCoords || null; // (lat, lng) => void

    this.map = null;
    this.tileLayers = {};
    this.currentTileKey = 'vworld_sat';
    this.hybridLayer = null;

    this.cadGroup = null;
    this.entityLayerMap = new Map(); // entity.id -> leafletLayer
    this.cadOpacity = 0.92;
    this.highContrast = false;

    this.targetMarker = null;
    this.highlightedLayer = null;
    this.userMarker = null;
    this.userAccuracyCircle = null;
    this.userGuideLine = null;
    this.userPos = null; // { lat, lng, accuracy }

    this.initMap();
  }

  initMap() {
    this.map = L.map(this.containerId, {
      center: [37.5665, 126.9780],
      zoom: 18,
      maxZoom: 22,
      zoomControl: false,
      attributionControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this.tileLayers['vworld_sat'] = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Satellite/service/{z}/{x}/{y}.jpeg',
      { minZoom: 6, maxZoom: 19, maxNativeZoom: 19 }
    );

    this.hybridLayer = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Hybrid/service/{z}/{x}/{y}.png',
      { minZoom: 6, maxZoom: 19, maxNativeZoom: 19, zIndex: 10 }
    );

    this.tileLayers['vworld_base'] = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Base/service/{z}/{x}/{y}.png',
      { minZoom: 6, maxZoom: 19, maxNativeZoom: 19 }
    );

    this.tileLayers['esri_sat'] = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 22, maxNativeZoom: 19 }
    );

    this.tileLayers['osm'] = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 22, maxNativeZoom: 19 }
    );

    this.tileLayers['vworld_sat'].addTo(this.map);
    this.hybridLayer.addTo(this.map);

    this.cadGroup = L.featureGroup().addTo(this.map);

    // Clicking anywhere on the map (when not clicking a specific CAD entity)
    this.map.on('click', (e) => {
      if (this.onMapClickForCalib && this.onMapClickForCalib(e.latlng)) {
        return;
      }
      if (this.onSelectLocation) {
        this.onSelectLocation({
          source: 'map',
          lat: e.latlng.lat,
          lng: e.latlng.lng,
          cadX: null,
          cadY: null,
          entity: null,
          title: '지도 임의 선택 지점',
          layerName: '배경 지도 위치',
          typeLabel: '지점 좌표'
        });
      }
    });

    // Real-time cursor & map center coordinate tracking
    this.map.on('mousemove', (e) => {
      if (this.onHoverCoords) {
        this.onHoverCoords(e.latlng.lat, e.latlng.lng);
      }
    });

    this.map.on('move', () => {
      if (this.onHoverCoords) {
        const c = this.map.getCenter();
        this.onHoverCoords(c.lat, c.lng);
      }
    });
  }

  setBaseMap(key) {
    if (!this.tileLayers[key]) return;
    if (this.tileLayers[this.currentTileKey]) {
      this.map.removeLayer(this.tileLayers[this.currentTileKey]);
    }
    this.tileLayers[key].addTo(this.map);
    this.currentTileKey = key;

    if (key === 'vworld_sat' || key === 'esri_sat') {
      if (!this.map.hasLayer(this.hybridLayer)) this.hybridLayer.addTo(this.map);
    } else {
      if (this.map.hasLayer(this.hybridLayer)) this.map.removeLayer(this.hybridLayer);
    }
  }

  setHybridVisible(visible) {
    if (visible) {
      if (!this.map.hasLayer(this.hybridLayer)) this.hybridLayer.addTo(this.map);
    } else {
      if (this.map.hasLayer(this.hybridLayer)) this.map.removeLayer(this.hybridLayer);
    }
  }

  setOpacity(opacity) {
    this.cadOpacity = opacity;
    this.cadGroup.eachLayer((layer) => {
      if (layer.setStyle && !layer._isHighlighted) {
        layer.setStyle({ opacity, fillOpacity: opacity * 0.3 });
      }
    });
  }

  setHighContrast(enabled) {
    this.highContrast = enabled;
  }

  /**
   * Render parsed CAD data onto the map
   */
  renderCad(cadData, transformer, fitMap = true) {
    this.cadGroup.clearLayers();
    this.entityLayerMap.clear();
    this.highlightedLayer = null;

    if (!cadData || !cadData.entities) return;

    const allPoints = [];

    cadData.entities.forEach((entity) => {
      const layerObj = cadData.layers[entity.layer];
      if (layerObj && layerObj.visible === false) return;

      const baseColor = this.highContrast
        ? '#facc15'
        : (entity.color || (layerObj ? layerObj.color : '#22d3ee'));

      const style = {
        color: baseColor,
        weight: 2.8,
        opacity: this.cadOpacity,
        lineCap: 'round',
        lineJoin: 'round'
      };

      switch (entity.type) {
        case 'LINE': {
          const p1 = transformer.cadToLatLng(entity.x1, entity.y1);
          const p2 = transformer.cadToLatLng(entity.x2, entity.y2);
          if (p1 && p2) {
            const poly = L.polyline([p1, p2], style);
            poly._baseStyle = { ...style };
            this.bindEntityInteraction(poly, entity, transformer);
            this.cadGroup.addLayer(poly);
            this.entityLayerMap.set(entity.id, poly);
            allPoints.push(p1, p2);
          }
          break;
        }

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          const latLngs = [];
          entity.vertices.forEach((v) => {
            const ll = transformer.cadToLatLng(v.x, v.y);
            if (ll) {
              latLngs.push(ll);
              allPoints.push(ll);
            }
          });
          if (latLngs.length >= 2) {
            let poly;
            if (entity.closed && latLngs.length >= 3) {
              const polyStyle = {
                ...style,
                fillColor: baseColor,
                fillOpacity: this.cadOpacity * 0.22
              };
              poly = L.polygon(latLngs, polyStyle);
              poly._baseStyle = polyStyle;
            } else {
              poly = L.polyline(latLngs, style);
              poly._baseStyle = { ...style };
            }
            this.bindEntityInteraction(poly, entity, transformer);
            this.cadGroup.addLayer(poly);
            this.entityLayerMap.set(entity.id, poly);
          }
          break;
        }

        case 'CIRCLE':
        case 'ARC': {
          const center = transformer.cadToLatLng(entity.cx, entity.cy);
          if (center) {
            const radiusM = Math.max(entity.radius * transformer.unitScale, 0.8);
            const cStyle = {
              ...style,
              radius: radiusM,
              fillColor: baseColor,
              fillOpacity: this.cadOpacity * 0.35
            };
            const circle = L.circle(center, cStyle);
            circle._baseStyle = cStyle;
            this.bindEntityInteraction(circle, entity, transformer);
            this.cadGroup.addLayer(circle);
            this.entityLayerMap.set(entity.id, circle);
            allPoints.push(center);
          }
          break;
        }

        case 'INSERT':
        case 'POINT': {
          const pt = transformer.cadToLatLng(entity.x, entity.y);
          if (pt) {
            const mStyle = {
              radius: entity.type === 'INSERT' ? 7 : 5.5,
              color: '#ffffff',
              weight: 2,
              fillColor: baseColor,
              fillOpacity: 1.0
            };
            const marker = L.circleMarker(pt, mStyle);
            marker._baseStyle = mStyle;
            this.bindEntityInteraction(marker, entity, transformer);
            this.cadGroup.addLayer(marker);
            this.entityLayerMap.set(entity.id, marker);
            allPoints.push(pt);
          }
          break;
        }

        case 'TEXT':
        case 'MTEXT': {
          const pt = transformer.cadToLatLng(entity.x, entity.y);
          if (pt && entity.text) {
            const cleanText = entity.text.replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
            const icon = L.divIcon({
              className: 'cad-map-label',
              html: `<div class="cad-label-chip" style="color:${baseColor};">${cleanText}</div>`,
              iconAnchor: [0, 10]
            });
            const textMarker = L.marker(pt, { icon });
            this.bindEntityInteraction(textMarker, entity, transformer);
            this.cadGroup.addLayer(textMarker);
            this.entityLayerMap.set(entity.id, textMarker);
            allPoints.push(pt);
          }
          break;
        }
      }
    });

    if (fitMap && allPoints.length > 0) {
      const bounds = L.latLngBounds(allPoints);
      this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 });
    }
  }

  bindEntityInteraction(leafletLayer, entity, transformer) {
    leafletLayer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);

      // Determine exact CAD anchor or nearest vertex to click
      let cadX = entity.anchor.x;
      let cadY = entity.anchor.y;
      let targetLatLng = transformer.cadToLatLng(cadX, cadY);

      if (entity.type === 'LINE') {
        const p1 = L.latLng(transformer.cadToLatLng(entity.x1, entity.y1));
        const p2 = L.latLng(transformer.cadToLatLng(entity.x2, entity.y2));
        if (e.latlng.distanceTo(p1) < 4) {
          cadX = entity.x1;
          cadY = entity.y1;
          targetLatLng = [p1.lat, p1.lng];
        } else if (e.latlng.distanceTo(p2) < 4) {
          cadX = entity.x2;
          cadY = entity.y2;
          targetLatLng = [p2.lat, p2.lng];
        } else {
          // Click along the line
          const cadPt = transformer.latLngToCad(e.latlng.lat, e.latlng.lng);
          if (cadPt) {
            cadX = cadPt[0];
            cadY = cadPt[1];
            targetLatLng = [e.latlng.lat, e.latlng.lng];
          }
        }
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices.length > 0) {
        let minDist = Infinity;
        let bestV = null;
        entity.vertices.forEach((v) => {
          const ll = transformer.cadToLatLng(v.x, v.y);
          if (ll) {
            const d = e.latlng.distanceTo(L.latLng(ll[0], ll[1]));
            if (d < minDist) {
              minDist = d;
              bestV = { x: v.x, y: v.y, ll };
            }
          }
        });
        if (bestV && minDist < 8) {
          cadX = bestV.x;
          cadY = bestV.y;
          targetLatLng = bestV.ll;
        }
      }

      if (!targetLatLng) {
        targetLatLng = [e.latlng.lat, e.latlng.lng];
      }

      if (this.onSelectLocation) {
        this.onSelectLocation({
          source: 'map',
          lat: targetLatLng[0],
          lng: targetLatLng[1],
          cadX,
          cadY,
          entity,
          title: entity.displayName,
          layerName: entity.layer,
          typeLabel: entity.type
        });
      }
    });
  }

  /**
   * Highlight and optionally pan/zoom to the selected installation point on the map
   */
  focusSelection(selection, panAndZoom = false) {
    // Restore previous highlighted layer
    if (this.highlightedLayer && this.highlightedLayer._baseStyle && this.highlightedLayer.setStyle) {
      this.highlightedLayer._isHighlighted = false;
      this.highlightedLayer.setStyle(this.highlightedLayer._baseStyle);
      this.highlightedLayer = null;
    }

    if (!selection) {
      if (this.targetMarker) {
        this.map.removeLayer(this.targetMarker);
        this.targetMarker = null;
      }
      this.updateUserGuideLine();
      return;
    }

    // Highlight matching CAD entity layer if present
    if (selection.entity && this.entityLayerMap.has(selection.entity.id)) {
      const layer = this.entityLayerMap.get(selection.entity.id);
      if (layer && layer.setStyle) {
        layer._isHighlighted = true;
        layer.setStyle({
          color: '#f43f5e',
          weight: 5,
          opacity: 1.0,
          fillColor: '#fb7185',
          fillOpacity: 0.65
        });
        if (layer.bringToFront) layer.bringToFront();
        this.highlightedLayer = layer;
      }
    }

    // Place Neon Installation Target Pin on Map
    if (selection.lat !== null && selection.lng !== null) {
      const latLng = [selection.lat, selection.lng];
      if (this.targetMarker) {
        this.map.removeLayer(this.targetMarker);
      }

      const pinIcon = L.divIcon({
        className: 'install-target-pin',
        html: `
          <div class="pin-pulse-ring"></div>
          <div class="pin-core-dot">🎯</div>
          <div class="pin-floating-badge">${selection.title || '설치 위치'}</div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      });

      this.targetMarker = L.marker(latLng, { icon: pinIcon, zIndexOffset: 2000 }).addTo(this.map);
      this.updateUserGuideLine();

      if (panAndZoom) {
        this.map.invalidateSize();
        this.map.setView(latLng, 20, { animate: true });
      }
    }
  }

  /**
   * Update user's current GPS position marker on map
   */
  updateUserLocation(lat, lng, accuracy = 5, panToUser = false) {
    this.userPos = { lat, lng, accuracy };
    const latLng = [lat, lng];

    if (!this.userMarker) {
      const userIcon = L.divIcon({
        className: 'user-gps-icon',
        html: `
          <div class="user-gps-marker">
            <div class="user-gps-pulse"></div>
            <div class="user-gps-dot"></div>
            <div class="user-gps-label">내 위치</div>
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });
      this.userMarker = L.marker(latLng, { icon: userIcon, zIndexOffset: 1900 }).addTo(this.map);
      this.userAccuracyCircle = L.circle(latLng, {
        radius: accuracy,
        color: '#38bdf8',
        weight: 1.2,
        fillColor: '#38bdf8',
        fillOpacity: 0.14
      }).addTo(this.map);
    } else {
      this.userMarker.setLatLng(latLng);
      this.userAccuracyCircle.setLatLng(latLng);
      this.userAccuracyCircle.setRadius(accuracy);
    }

    this.updateUserGuideLine();

    if (panToUser) {
      this.map.invalidateSize();
      this.map.setView(latLng, Math.max(this.map.getZoom(), 19), { animate: true });
    }
  }

  updateUserGuideLine() {
    if (!this.userMarker || !this.targetMarker) {
      if (this.userGuideLine) {
        this.map.removeLayer(this.userGuideLine);
        this.userGuideLine = null;
      }
      return;
    }

    const u = this.userMarker.getLatLng();
    const t = this.targetMarker.getLatLng();

    if (!this.userGuideLine) {
      this.userGuideLine = L.polyline([u, t], {
        color: '#38bdf8',
        weight: 2.5,
        dashArray: '6, 6',
        opacity: 0.9
      }).addTo(this.map);
    } else {
      this.userGuideLine.setLatLngs([u, t]);
    }
  }

  fitToCad() {
    if (this.cadGroup && this.cadGroup.getLayers().length > 0) {
      this.map.fitBounds(this.cadGroup.getBounds(), { padding: [50, 50], maxZoom: 19, animate: true });
    }
  }

  invalidateSize() {
    if (this.map) {
      this.map.invalidateSize();
    }
  }
}
