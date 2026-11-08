/**
 * Main Application Controller - CAD <-> Map Bidirectional Location & Component Inspector
 */

import { DxfParser } from './dxfParser.js';
import { CoordinateTransformer, CRS_DEFINITIONS } from './coordTransform.js';
import { MapView } from './mapView.js';
import { CadView } from './cadView.js';
import { SAMPLE_DXF_TEXT } from './sampleCad.js';

class CadMapOverlayApp {
  constructor() {
    this.parser = new DxfParser();
    this.transformer = new CoordinateTransformer();

    // Shared State (Single Source of Truth)
    this.cadData = null;
    this.fileName = '도면 없음';
    this.viewMode = 'map'; // 'map' | 'cad' | 'split'
    this.currentSelection = null; // { source, lat, lng, cadX, cadY, entity, title, layerName, typeLabel }

    this.calibPickStep = null; // 1 | 2 when picking map coordinates for 2-point calibration
    this.gpsWatchId = null;
    this.simLocationMode = false;

    this.initViews();
    this.populateCrsSelect();
    this.bindUiEvents();

    // Load rich sample CAD drawing on startup
    setTimeout(() => {
      this.loadSampleDrawing();
    }, 250);
  }

  initViews() {
    this.mapView = new MapView('map-viewport', {
      onSelectLocation: (sel) => this.handleSelection(sel),
      onMapClickForCalib: (latlng) => this.handleMapCalibClick(latlng),
      onHoverCoords: (lat, lng) => this.updateLiveMapHud(lat, lng)
    });

    this.cadView = new CadView('cad-viewport', {
      onSelectLocation: (sel) => this.handleSelection(sel),
      onHoverCoords: (x, y, snapTitle) => this.updateLiveCadHud(x, y, snapTitle)
    });
  }

  populateCrsSelect() {
    const sel = document.getElementById('select-crs');
    if (!sel) return;
    sel.innerHTML = '';
    for (const [code, def] of Object.entries(CRS_DEFINITIONS)) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${code} - ${def.name}`;
      if (code === 'EPSG:5186') opt.selected = true;
      sel.appendChild(opt);
    }
  }

  bindUiEvents() {
    // 1. File Upload (Button + Drag & Drop)
    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-upload-cad').addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.loadCadFile(file);
    });

    // Global Drag & Drop
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.getElementById('drop-overlay').classList.remove('hidden');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        document.getElementById('drop-overlay').classList.add('hidden');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.getElementById('drop-overlay').classList.add('hidden');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) this.loadCadFile(file);
    });

    document.getElementById('btn-load-sample').addEventListener('click', () => {
      this.loadSampleDrawing();
    });

    // 2. View Mode Switcher Tabs (Map Only | Pure CAD Only | Split Dual View)
    document.getElementById('tab-view-map').addEventListener('click', () => {
      this.setViewMode('map', true);
    });
    document.getElementById('tab-view-cad').addEventListener('click', () => {
      this.setViewMode('cad', true);
    });
    document.getElementById('tab-view-split').addEventListener('click', () => {
      this.setViewMode('split', true);
    });

    // 3. Primary Bidirectional Action Buttons inside Inspection Card
    // Scenario 2: Map -> "이 위치 도면보기 (도면만 띄우고 상세 확인)"
    document.getElementById('btn-action-open-cad').addEventListener('click', () => {
      if (!this.currentSelection) return;
      this.setViewMode('cad', false);
      this.cadView.focusSelection(this.currentSelection, true);
      this.showToast(`📐 순수 도면 보기 전환: [${this.currentSelection.title}] 위치를 확대했습니다.`);
    });

    // Scenario 3: CAD -> "이 위치 지도 띄우기 (캐드 오버레이 & 정확한 객체 설치 위치 표시)"
    document.getElementById('btn-action-open-map').addEventListener('click', () => {
      if (!this.currentSelection) return;
      this.setViewMode('map', false);
      this.mapView.focusSelection(this.currentSelection, true);
      this.showToast(`🛰️ 지도 오버레이 전환: [${this.currentSelection.title}] 실제 설치 위치를 표시합니다.`);
    });

    // Close selection card
    document.getElementById('btn-close-card').addEventListener('click', () => {
      this.clearSelection();
    });

    // 4. Map & CAD Viewport Controls
    document.getElementById('btn-map-fit').addEventListener('click', () => {
      this.mapView.fitToCad();
      this.showToast('🗺️ 지도 화면을 전체 도면 영역에 맞췄습니다.');
    });

    document.getElementById('btn-cad-fit').addEventListener('click', () => {
      this.cadView.fitExtents();
      this.showToast('📐 도면 화면을 전체 범위에 맞췄습니다.');
    });

    const btnMeasure = document.getElementById('btn-cad-measure');
    const btnAddMeasurePt = document.getElementById('btn-cad-add-measure-pt');
    btnMeasure.addEventListener('click', () => {
      const active = this.cadView.toggleMeasureMode();
      btnMeasure.classList.toggle('bg-amber-500', active);
      btnMeasure.classList.toggle('text-slate-950', active);
      btnMeasure.classList.toggle('bg-slate-800/90', !active);
      btnMeasure.classList.toggle('text-slate-200', !active);
      if (btnAddMeasurePt) btnAddMeasurePt.classList.toggle('hidden', !active);
      this.showToast(active ? '📏 치수 측정 모드: 중앙 십자선을 맞춰 [측정점 찍기]를 누르거나 도면을 클릭하세요.' : '치수 측정 모드를 종료했습니다.');
    });

    btnAddMeasurePt?.addEventListener('click', () => {
      this.cadView.addMeasurePointAtCenter();
    });

    // Center Crosshair Direct Actions in CAD View
    document.getElementById('btn-cad-lock-center')?.addEventListener('click', () => {
      const sel = this.cadView.getCenterSelection();
      this.handleSelection(sel);
      this.showToast(`📌 중앙 십자선 위치 선택됨: ${sel.title}`);
    });

    document.getElementById('btn-cad-center-to-map')?.addEventListener('click', () => {
      const sel = this.cadView.getCenterSelection();
      this.handleSelection(sel);
      this.setViewMode('map', false);
      this.mapView.focusSelection(this.currentSelection, true);
      this.showToast(`🛰️ 중앙 십자선 위치 지도 띄우기: [${this.currentSelection.title}] 설치 위치를 표시합니다.`);
    });

    // 5. Opacity & Base Map & High Contrast
    const opacitySlider = document.getElementById('slider-opacity');
    opacitySlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this.mapView.setOpacity(v);
      document.getElementById('label-opacity').textContent = `${Math.round(v * 100)}%`;
    });

    document.querySelectorAll('[data-basemap]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.dataset.basemap;
        this.mapView.setBaseMap(key);
        document.querySelectorAll('[data-basemap]').forEach((b) => b.classList.remove('active-basemap-btn'));
        e.currentTarget.classList.add('active-basemap-btn');
      });
    });

    document.getElementById('chk-hybrid-label').addEventListener('change', (e) => {
      this.mapView.setHybridVisible(e.target.checked);
    });

    document.getElementById('chk-high-contrast').addEventListener('change', (e) => {
      this.mapView.setHighContrast(e.target.checked);
      this.mapView.renderCad(this.cadData, this.transformer, false);
      if (this.currentSelection) this.mapView.focusSelection(this.currentSelection, false);
    });

    // 6. CRS & Unit Scale
    document.getElementById('select-crs').addEventListener('change', (e) => {
      const crs = e.target.value;
      if (crs === 'LOCAL_CALIBRATED') {
        this.openCalibModal();
      } else {
        this.transformer.setCrs(crs);
        this.refreshAllViews(true);
        this.showToast(`📐 좌표계 변경: ${crs}`);
      }
    });

    document.getElementById('select-unit').addEventListener('change', (e) => {
      const scale = parseFloat(e.target.value);
      this.transformer.setUnitScale(scale);
      this.refreshAllViews(true);
      this.showToast(`도면 단위 변경: ${scale === 1.0 ? 'm (미터)' : 'mm (밀리미터)'}`);
    });

    // 7. Side Panel Toggle (Components List & Layers & Settings)
    const sidePanel = document.getElementById('side-panel');
    document.getElementById('btn-toggle-panel').addEventListener('click', () => {
      sidePanel.classList.toggle('translate-x-full');
    });
    document.getElementById('btn-close-panel').addEventListener('click', () => {
      sidePanel.classList.add('translate-x-full');
    });

    // Side panel tabs (Components vs Layers & Settings)
    document.querySelectorAll('[data-side-tab]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', (e) => {
        const target = e.currentTarget.dataset.sideTab;
        document.querySelectorAll('[data-side-tab]').forEach((b) => b.classList.remove('active-side-tab'));
        e.currentTarget.classList.add('active-side-tab');

        document.getElementById('panel-tab-components').classList.toggle('hidden', target !== 'components');
        document.getElementById('panel-tab-settings').classList.toggle('hidden', target !== 'settings');
      });
    });

    document.getElementById('input-search-component').addEventListener('input', () => {
      this.renderComponentsList();
    });

    // 8. 2-Point Calibration Modal
    document.getElementById('btn-open-calib').addEventListener('click', () => this.openCalibModal());
    document.getElementById('btn-close-calib').addEventListener('click', () => this.closeCalibModal());
    document.getElementById('btn-apply-calib').addEventListener('click', () => this.applyCalibration());

    // 9. Coordinate Search & Copy Controls
    const openCoordSearch = () => {
      document.getElementById('coord-search-modal').classList.remove('hidden');
      this.fillCurrentCoordSearchInputs();
    };
    const closeCoordSearch = () => {
      document.getElementById('coord-search-modal').classList.add('hidden');
    };

    document.getElementById('btn-open-coord-search')?.addEventListener('click', openCoordSearch);
    document.getElementById('btn-open-coord-search-cad')?.addEventListener('click', openCoordSearch);
    document.getElementById('btn-close-coord-search')?.addEventListener('click', closeCoordSearch);
    document.getElementById('btn-fill-sample-cad-coord')?.addEventListener('click', () => this.fillCurrentCoordSearchInputs());

    document.getElementById('btn-go-cad-on-map')?.addEventListener('click', () => this.goToSearchedCadCoord('map'));
    document.getElementById('btn-go-cad-on-drawing')?.addEventListener('click', () => this.goToSearchedCadCoord('cad'));
    document.getElementById('btn-go-geo-on-map')?.addEventListener('click', () => this.goToSearchedGeoCoord('map'));
    document.getElementById('btn-go-geo-on-drawing')?.addEventListener('click', () => this.goToSearchedGeoCoord('cad'));

    document.getElementById('btn-copy-cad-coord')?.addEventListener('click', () => {
      const cadTxt = document.getElementById('cad-live-coords')?.textContent || '';
      const geoTxt = document.getElementById('cad-live-geo')?.textContent || '';
      this.copyTextToClipboard(`CAD(${cadTxt}) / GPS(${geoTxt})`);
    });

    // Bottom Coordinate Bar Quick Handoff Button (Map <-> CAD 1-Tap Switch)
    document.getElementById('btn-bottom-quick-handoff')?.addEventListener('click', () => {
      if (this.viewMode === 'cad') {
        const sel = this.cadView.getCenterSelection();
        this.handleSelection(sel);
        this.setViewMode('map', false);
        this.mapView.focusSelection(this.currentSelection, true);
        this.showToast(`🛰️ 십자선 위치 지도 띄우기: [${this.currentSelection.title}] 설치 위치를 표시합니다.`);
      } else {
        if (!this.currentSelection) {
          const c = this.mapView.map.getCenter();
          this.handleSelection({
            source: 'map',
            lat: c.lat,
            lng: c.lng,
            cadX: null,
            cadY: null,
            entity: null,
            title: '지도 중심 위치',
            layerName: '지도 중심',
            typeLabel: '좌표점'
          });
        }
        this.setViewMode('cad', false);
        this.cadView.focusSelection(this.currentSelection, true);
        this.showToast(`📐 순수 도면 보기 전환: [${this.currentSelection.title}] 위치를 확대했습니다.`);
      }
    });

    // 10. My Location (Real GPS + Simulated Click Mode)
    document.getElementById('btn-my-location')?.addEventListener('click', () => {
      this.locateUserGps();
    });

    const btnSim = document.getElementById('btn-sim-location');
    btnSim?.addEventListener('click', () => {
      this.simLocationMode = !this.simLocationMode;
      btnSim.classList.toggle('border-amber-400', this.simLocationMode);
      btnSim.classList.toggle('text-amber-300', this.simLocationMode);
      if (this.simLocationMode) {
        this.showToast('🎮 모의 내위치 모드: 지도를 클릭한 지점이 [내 위치]로 설정됩니다.');
      } else {
        this.showToast('모의 내위치 모드를 해제했습니다.');
      }
    });
  }

  /**
   * Switch between 'map' (Map Only), 'cad' (Pure CAD Drawing Only), or 'split' (Side-by-Side)
   */
  setViewMode(mode, focusExisting = true) {
    this.viewMode = mode;

    const mapWrap = document.getElementById('map-container-wrap');
    const cadWrap = document.getElementById('cad-container-wrap');

    const tabMap = document.getElementById('tab-view-map');
    const tabCad = document.getElementById('tab-view-cad');
    const tabSplit = document.getElementById('tab-view-split');

    const toolbarMap = document.getElementById('toolbar-map-controls');
    const toolbarCad = document.getElementById('toolbar-cad-controls');
    const handoffBtn = document.getElementById('btn-bottom-quick-handoff');
    const handoffIcon = document.getElementById('bottom-handoff-icon');
    const handoffLabel = document.getElementById('bottom-handoff-label');

    [tabMap, tabCad, tabSplit].forEach((t) => t.classList.remove('active-mode-btn'));

    if (mode === 'map') {
      tabMap.classList.add('active-mode-btn');
      mapWrap.className = 'relative flex-1 h-full w-full min-h-0';
      cadWrap.className = 'hidden';

      if (toolbarMap) toolbarMap.className = 'flex items-center gap-1 shrink-0';
      if (toolbarCad) toolbarCad.className = 'hidden items-center gap-1 shrink-0';
      if (handoffBtn) {
        handoffBtn.className = 'px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-extrabold shadow transition whitespace-nowrap flex items-center gap-1';
      }
      if (handoffIcon) handoffIcon.textContent = '📐';
      if (handoffLabel) handoffLabel.textContent = '이 위치 도면보기';

      setTimeout(() => {
        this.mapView.invalidateSize();
        if (focusExisting && this.currentSelection) {
          this.mapView.focusSelection(this.currentSelection, true);
        }
        const c = this.mapView.map.getCenter();
        this.updateLiveMapHud(c.lat, c.lng);
      }, 60);
    } else if (mode === 'cad') {
      tabCad.classList.add('active-mode-btn');
      mapWrap.className = 'hidden';
      cadWrap.className = 'relative flex-1 h-full w-full min-h-0';

      if (toolbarMap) toolbarMap.className = 'hidden items-center gap-1 shrink-0';
      if (toolbarCad) toolbarCad.className = 'flex items-center gap-1 shrink-0';
      if (handoffBtn) {
        handoffBtn.className = 'px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-extrabold shadow transition whitespace-nowrap flex items-center gap-1';
      }
      if (handoffIcon) handoffIcon.textContent = '🛰️';
      if (handoffLabel) handoffLabel.textContent = '십자선 지도띄우기';

      setTimeout(() => {
        this.cadView.resize();
        if (focusExisting && this.currentSelection) {
          this.cadView.focusSelection(this.currentSelection, true);
        } else {
          this.cadView.fitExtents();
        }
      }, 60);
    } else if (mode === 'split') {
      tabSplit.classList.add('active-mode-btn');
      mapWrap.className = 'relative w-full md:w-1/2 h-1/2 md:h-full border-b md:border-b-0 md:border-r border-slate-700/80 min-h-0';
      cadWrap.className = 'relative w-full md:w-1/2 h-1/2 md:h-full min-h-0';

      if (toolbarMap) toolbarMap.className = 'flex items-center gap-1 shrink-0';
      if (toolbarCad) toolbarCad.className = 'flex items-center gap-1 shrink-0';

      setTimeout(() => {
        this.mapView.invalidateSize();
        this.cadView.resize();
        if (this.currentSelection) {
          this.mapView.focusSelection(this.currentSelection, true);
          this.cadView.focusSelection(this.currentSelection, true);
        } else {
          this.mapView.fitToCad();
          this.cadView.fitExtents();
        }
      }, 60);
    }

    this.updateSelectionCardButtons();
  }

  /**
   * Central handler when any component or point is clicked on either Map or CAD Drawing
   */
  handleSelection(sel) {
    // If simulated location mode is active and user clicked on the map, set simulated user GPS position
    if (this.simLocationMode && sel.source === 'map' && sel.lat !== null && sel.lng !== null) {
      this.mapView.updateUserLocation(sel.lat, sel.lng, 2.0, false);
      const cadPt = this.transformer.latLngToCad(sel.lat, sel.lng);
      const cadMsg = cadPt ? ` (CAD X:${cadPt[0].toFixed(1)}, Y:${cadPt[1].toFixed(1)})` : '';
      this.showToast(`📍 모의 내 위치 설정됨: ${sel.lat.toFixed(6)}, ${sel.lng.toFixed(6)}${cadMsg}`);
      if (this.currentSelection) {
        this.showSelectionCard(this.currentSelection);
      }
      return;
    }

    // Complete missing coordinate pair via bidirectional transformer
    if ((sel.cadX === null || sel.cadY === null) && sel.lat !== null && sel.lng !== null) {
      const cadPt = this.transformer.latLngToCad(sel.lat, sel.lng);
      if (cadPt) {
        sel.cadX = cadPt[0];
        sel.cadY = cadPt[1];
      }
    } else if ((sel.lat === null || sel.lng === null) && sel.cadX !== null && sel.cadY !== null) {
      const geoPt = this.transformer.cadToLatLng(sel.cadX, sel.cadY);
      if (geoPt) {
        sel.lat = geoPt[0];
        sel.lng = geoPt[1];
      }
    }

    // If user clicked arbitrary map point, check if there's a nearby CAD component within ~3m
    if (!sel.entity && sel.cadX !== null && sel.cadY !== null && this.cadData) {
      const nearest = this.cadView.findNearestTarget(sel.cadX, sel.cadY, 3.0);
      if (nearest && nearest.entity) {
        sel.entity = nearest.entity;
        sel.cadX = nearest.x;
        sel.cadY = nearest.y;
        const refinedGeo = this.transformer.cadToLatLng(sel.cadX, sel.cadY);
        if (refinedGeo) {
          sel.lat = refinedGeo[0];
          sel.lng = refinedGeo[1];
        }
        sel.title = nearest.title;
        sel.layerName = nearest.layerName;
        sel.typeLabel = nearest.typeLabel;
      }
    }

    this.currentSelection = sel;

    // Synchronize both views
    this.mapView.focusSelection(sel, sel.source === 'list' || this.viewMode === 'split');
    this.cadView.focusSelection(sel, sel.source === 'list' || this.viewMode === 'split');

    this.showSelectionCard(sel);
  }

  showSelectionCard(sel) {
    const card = document.getElementById('selection-card');
    card.classList.remove('hidden');

    document.getElementById('sel-title').textContent = sel.title || '선택된 위치';
    document.getElementById('sel-layer-badge').textContent = `레이어: ${sel.layerName || '0'}`;
    document.getElementById('sel-type-badge').textContent = sel.typeLabel || '객체';

    if (sel.cadX !== null && sel.cadY !== null) {
      document.getElementById('sel-cad-coords').textContent = `X: ${sel.cadX.toFixed(2)}, Y: ${sel.cadY.toFixed(2)}`;
    } else {
      document.getElementById('sel-cad-coords').textContent = '좌표 미상';
    }

    if (sel.lat !== null && sel.lng !== null) {
      document.getElementById('sel-geo-coords').textContent = `${sel.lat.toFixed(6)}, ${sel.lng.toFixed(6)}`;
    } else {
      document.getElementById('sel-geo-coords').textContent = '좌표 변환 필요';
    }

    // Distance and Bearing from User's Current Location
    const distEl = document.getElementById('sel-user-dist');
    if (distEl) {
      if (this.mapView.userPos && sel.lat !== null && sel.lng !== null) {
        const d = this.computeDistanceAndBearing(
          this.mapView.userPos.lat,
          this.mapView.userPos.lng,
          sel.lat,
          sel.lng
        );
        const distStr = d.distance < 1000 ? `${d.distance.toFixed(1)}m` : `${(d.distance / 1000).toFixed(2)}km`;
        distEl.textContent = `${distStr} (${d.dirName} ${Math.round(d.bearing)}°)`;
      } else {
        distEl.textContent = '[내 위치 확인] 필요';
      }
    }

    this.updateSelectionCardButtons();
  }

  updateSelectionCardButtons() {
    const btnOpenCad = document.getElementById('btn-action-open-cad');
    const btnOpenMap = document.getElementById('btn-action-open-map');
    if (!btnOpenCad || !btnOpenMap) return;

    if (this.viewMode === 'map') {
      // Currently in Map View -> Highlight "이 위치 도면보기 (도면만 띄우기)"
      btnOpenCad.classList.remove('hidden');
      btnOpenMap.classList.add('hidden');
    } else if (this.viewMode === 'cad') {
      // Currently in Pure CAD View -> Highlight "이 위치 지도띄우기 (캐드 오버레이 설치위치 확인)"
      btnOpenMap.classList.remove('hidden');
      btnOpenCad.classList.add('hidden');
    } else {
      // Split mode: show both for quick zoom focusing
      btnOpenCad.classList.remove('hidden');
      btnOpenMap.classList.remove('hidden');
    }
  }

  clearSelection() {
    this.currentSelection = null;
    document.getElementById('selection-card').classList.add('hidden');
    this.mapView.focusSelection(null);
    this.cadView.focusSelection(null);
  }

  updateLiveMapHud(lat, lng) {
    if (this.viewMode === 'cad') return;

    const coordEl = document.getElementById('cad-live-coords');
    const geoEl = document.getElementById('cad-live-geo');
    const srcBadge = document.getElementById('cad-coord-source-badge');

    const cadPt = this.transformer.latLngToCad(lat, lng);
    if (coordEl) {
      coordEl.textContent = cadPt
        ? `X: ${cadPt[0].toFixed(2)}, Y: ${cadPt[1].toFixed(2)}`
        : '좌표계 미매칭';
    }
    if (geoEl) {
      geoEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
    if (srcBadge) {
      srcBadge.textContent = '지도 좌표';
      srcBadge.className = 'px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[10px] whitespace-nowrap shrink-0';
    }
  }

  updateLiveCadHud(x, y, snapTitle) {
    if (this.viewMode === 'map') return;

    const coordEl = document.getElementById('cad-live-coords');
    const geoEl = document.getElementById('cad-live-geo');
    const srcBadge = document.getElementById('cad-coord-source-badge');
    if (coordEl) {
      coordEl.textContent = `X: ${x.toFixed(2)}, Y: ${y.toFixed(2)}`;
    }
    if (geoEl) {
      const geoPt = this.transformer.cadToLatLng(x, y);
      if (geoPt) {
        geoEl.textContent = `${geoPt[0].toFixed(6)}, ${geoPt[1].toFixed(6)}`;
      } else {
        geoEl.textContent = '-';
      }
    }
    if (srcBadge) {
      if (snapTitle) {
        srcBadge.textContent = '🎯 스냅됨';
        srcBadge.className = 'px-1.5 py-0.5 rounded bg-cyan-500 text-slate-950 font-extrabold text-[10px] whitespace-nowrap shrink-0';
      } else {
        srcBadge.textContent = '십자선 CAD';
        srcBadge.className = 'px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold text-[10px] whitespace-nowrap shrink-0';
      }
    }
  }

  fillCurrentCoordSearchInputs() {
    if (this.currentSelection) {
      if (this.currentSelection.cadX !== null) {
        document.getElementById('search-cad-x').value = this.currentSelection.cadX.toFixed(2);
        document.getElementById('search-cad-y').value = this.currentSelection.cadY.toFixed(2);
      }
      if (this.currentSelection.lat !== null) {
        document.getElementById('search-geo-lat').value = this.currentSelection.lat.toFixed(6);
        document.getElementById('search-geo-lng').value = this.currentSelection.lng.toFixed(6);
      }
      return;
    }

    if (this.cadData && this.cadData.bounds && this.cadData.bounds.minX !== Infinity) {
      const cx = (this.cadData.bounds.minX + this.cadData.bounds.maxX) / 2;
      const cy = (this.cadData.bounds.minY + this.cadData.bounds.maxY) / 2;
      document.getElementById('search-cad-x').value = cx.toFixed(2);
      document.getElementById('search-cad-y').value = cy.toFixed(2);
      const geo = this.transformer.cadToLatLng(cx, cy);
      if (geo) {
        document.getElementById('search-geo-lat').value = geo[0].toFixed(6);
        document.getElementById('search-geo-lng').value = geo[1].toFixed(6);
      }
    }
  }

  goToSearchedCadCoord(targetView) {
    const x = parseFloat(document.getElementById('search-cad-x').value);
    const y = parseFloat(document.getElementById('search-cad-y').value);
    if (isNaN(x) || isNaN(y)) {
      alert('확인할 도면 CAD 좌표 X, Y 숫자를 입력해 주세요.');
      return;
    }

    const geo = this.transformer.cadToLatLng(x, y);
    const sel = {
      source: 'search',
      cadX: x,
      cadY: y,
      lat: geo ? geo[0] : null,
      lng: geo ? geo[1] : null,
      entity: null,
      title: `검색 좌표 (X:${x.toFixed(1)}, Y:${y.toFixed(1)})`,
      layerName: '좌표 직접 조회',
      typeLabel: 'CAD 좌표점'
    };

    document.getElementById('coord-search-modal').classList.add('hidden');
    if (this.viewMode !== 'split') {
      this.setViewMode(targetView, false);
    }
    this.handleSelection(sel);
    if (targetView === 'map') {
      this.mapView.focusSelection(sel, true);
    } else {
      this.cadView.focusSelection(sel, true);
    }
  }

  goToSearchedGeoCoord(targetView) {
    const lat = parseFloat(document.getElementById('search-geo-lat').value);
    const lng = parseFloat(document.getElementById('search-geo-lng').value);
    if (isNaN(lat) || isNaN(lng)) {
      alert('확인할 지도 위도(Latitude)와 경도(Longitude)를 입력해 주세요.');
      return;
    }

    const cadPt = this.transformer.latLngToCad(lat, lng);
    const sel = {
      source: 'search',
      cadX: cadPt ? cadPt[0] : null,
      cadY: cadPt ? cadPt[1] : null,
      lat,
      lng,
      entity: null,
      title: `검색 위경도 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      layerName: '위경도 직접 조회',
      typeLabel: 'GPS 좌표점'
    };

    document.getElementById('coord-search-modal').classList.add('hidden');
    if (this.viewMode !== 'split') {
      this.setViewMode(targetView, false);
    }
    this.handleSelection(sel);
    if (targetView === 'map') {
      this.mapView.focusSelection(sel, true);
    } else {
      this.cadView.focusSelection(sel, true);
    }
  }

  copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast(`📋 좌표가 복사되었습니다: ${text}`);
      });
    } else {
      this.showToast(`📋 좌표: ${text}`);
    }
  }

  /**
   * Real-time GPS My Location Finder & Tracker
   */
  locateUserGps() {
    if (!('geolocation' in navigator)) {
      alert('이 브라우저는 GPS 위치 확인을 지원하지 않습니다.');
      return;
    }

    const btn = document.getElementById('btn-my-location');
    const label = document.getElementById('label-my-location');
    if (label) label.textContent = '위치 수신 중...';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        this.mapView.updateUserLocation(latitude, longitude, accuracy || 5, true);
        if (label) label.textContent = '내 위치 이동';
        btn?.classList.add('bg-blue-600/30', 'border-blue-400');

        const cadPt = this.transformer.latLngToCad(latitude, longitude);
        const cadStr = cadPt ? ` / CAD X:${cadPt[0].toFixed(1)}, Y:${cadPt[1].toFixed(1)}` : '';
        this.showToast(`📍 내 위치 확인 완료 (±${Math.round(accuracy || 5)}m)${cadStr}`);

        if (this.currentSelection) {
          this.showSelectionCard(this.currentSelection);
        }

        // Start continuous watch if not already watching
        if (!this.gpsWatchId) {
          this.gpsWatchId = navigator.geolocation.watchPosition(
            (watchPos) => {
              this.mapView.updateUserLocation(
                watchPos.coords.latitude,
                watchPos.coords.longitude,
                watchPos.coords.accuracy || 5,
                false
              );
              if (this.currentSelection) {
                this.showSelectionCard(this.currentSelection);
              }
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 3000 }
          );
        }
      },
      (err) => {
        if (label) label.textContent = '내 위치 확인';
        // Fallback: if user already has a simulated/default position on map, pan to it
        if (this.mapView.userPos) {
          this.mapView.updateUserLocation(this.mapView.userPos.lat, this.mapView.userPos.lng, 5, true);
          this.showToast('📍 현재 설정된 내 위치로 이동했습니다. (실제 GPS 권한이 거부되었거나 실내입니다)');
        } else {
          alert(`GPS 위치를 가져올 수 없습니다 (${err.message}).\n권한을 허용하시거나 우측 상단 [🎮 모의 내위치] 버튼으로 지도 위 내 위치를 지정해 보세요.`);
        }
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  computeDistanceAndBearing(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    const dirName = dirs[Math.round(bearing / 45) % 8];

    return { distance, bearing, dirName };
  }

  /**
   * Load built-in sample engineering drawing
   */
  loadSampleDrawing() {
    const parsed = this.parser.parse(SAMPLE_DXF_TEXT);
    this.fileName = '서울시청_설비배치_샘플도면.dxf';
    this.cadData = parsed;

    this.transformer.setCrs('EPSG:5186');
    this.transformer.setUnitScale(1.0);
    document.getElementById('select-crs').value = 'EPSG:5186';
    document.getElementById('select-unit').value = '1.0';

    this.updateHeaderFileBadge();
    this.refreshAllViews(true);
    this.renderComponentsList();
    this.renderLayersList();

    // Place initial sample user location near site entrance so user can test immediately
    const sampleUserGeo = this.transformer.cadToLatLng(198035.0, 551835.0);
    if (sampleUserGeo) {
      this.mapView.updateUserLocation(sampleUserGeo[0], sampleUserGeo[1], 3.5, false);
    }

    this.showToast(`✅ '${this.fileName}' 업로드 완료 (설치 구성요소 ${parsed.totalCount}개 지도 오버레이됨)`);
  }

  /**
   * Read and parse user-uploaded .dxf or .dwg file
   */
  async loadCadFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'dxf' && ext !== 'dwg') {
      alert('지원하지 않는 파일 형식입니다. AutoCAD .dxf 또는 .dwg 파일을 선택해 주세요.');
      return;
    }

    try {
      this.showToast(`⏳ '${file.name}' 도면 분석 및 지도 매핑 중...`);
      let parsed;
      if (ext === 'dwg') {
        const buffer = await file.arrayBuffer();
        parsed = await this.parser.parseDwg(buffer);
      } else {
        const text = await file.text();
        parsed = this.parser.parse(text);
      }

      if (!parsed.entities || parsed.entities.length === 0) {
        alert('도면에서 표시할 수 있는 그래픽 객체를 찾지 못했습니다.');
        return;
      }

      this.fileName = file.name;
      this.cadData = parsed;

      const autoScale = this.transformer.autoDetectUnitScale(parsed.bounds);
      document.getElementById('select-unit').value = autoScale.toString();

      this.clearSelection();
      this.updateHeaderFileBadge();
      this.refreshAllViews(true);
      this.renderComponentsList();
      this.renderLayersList();

      this.showToast(`✅ '${file.name}' 업로드 완료! (객체 ${parsed.totalCount}개)`);
    } catch (err) {
      console.error(err);
      alert(`도면 파싱 중 오류가 발생했습니다: ${err.message}`);
    }
  }

  updateHeaderFileBadge() {
    const el = document.getElementById('header-file-name');
    const countEl = document.getElementById('header-entity-count');
    if (el) el.textContent = this.fileName;
    if (countEl && this.cadData) {
      countEl.textContent = `${this.cadData.totalCount}개 객체`;
    }
  }

  refreshAllViews(fit = true) {
    if (!this.cadData) return;
    this.mapView.renderCad(this.cadData, this.transformer, fit);
    this.cadView.setCadData(this.cadData, fit);
  }

  /**
   * Populate the installation components list in the side panel for quick inspection
   */
  renderComponentsList() {
    const listEl = document.getElementById('components-list');
    if (!listEl || !this.cadData) return;

    const query = (document.getElementById('input-search-component')?.value || '').trim().toLowerCase();
    listEl.innerHTML = '';

    // Prioritize key installation components (CIRCLE, INSERT, POINT, LWPOLYLINE, LINE, TEXT)
    const priorityOrder = { INSERT: 1, CIRCLE: 2, POINT: 3, LWPOLYLINE: 4, POLYLINE: 5, LINE: 6, TEXT: 7, MTEXT: 8 };
    const sorted = [...this.cadData.entities].sort((a, b) => {
      return (priorityOrder[a.type] || 9) - (priorityOrder[b.type] || 9);
    });

    const filtered = sorted.filter((ent) => {
      if (!query) return true;
      return (
        (ent.displayName && ent.displayName.toLowerCase().includes(query)) ||
        (ent.layer && ent.layer.toLowerCase().includes(query)) ||
        (ent.type && ent.type.toLowerCase().includes(query))
      );
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">일치하는 도면 구성요소가 없습니다.</div>`;
      return;
    }

    filtered.slice(0, 150).forEach((ent) => {
      const layerObj = this.cadData.layers[ent.layer];
      const color = ent.color || (layerObj ? layerObj.color : '#38bdf8');

      const item = document.createElement('div');
      item.className = 'p-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/70 transition flex items-center justify-between gap-2 cursor-pointer group';

      item.innerHTML = `
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>
            <span class="text-xs font-bold text-slate-100 truncate">${ent.displayName}</span>
          </div>
          <div class="text-[11px] text-slate-400 font-mono mt-0.5 truncate">
            [${ent.layer}] X:${ent.anchor.x.toFixed(1)}, Y:${ent.anchor.y.toFixed(1)}
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-item-map px-2 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 text-[11px] font-semibold transition" title="지도에서 설치위치 확인">
            🛰️ 지도
          </button>
          <button class="btn-item-cad px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 text-[11px] font-semibold transition" title="순수 도면에서 상세 확인">
            📐 도면
          </button>
        </div>
      `;

      const selectThis = (targetMode) => {
        const geo = this.transformer.cadToLatLng(ent.anchor.x, ent.anchor.y);
        const sel = {
          source: 'list',
          cadX: ent.anchor.x,
          cadY: ent.anchor.y,
          lat: geo ? geo[0] : null,
          lng: geo ? geo[1] : null,
          entity: ent,
          title: ent.displayName,
          layerName: ent.layer,
          typeLabel: ent.type
        };

        if (targetMode && this.viewMode !== 'split') {
          this.setViewMode(targetMode, false);
        }
        this.handleSelection(sel);
        if (targetMode === 'map') {
          this.mapView.focusSelection(sel, true);
        } else if (targetMode === 'cad') {
          this.cadView.focusSelection(sel, true);
        }
      };

      item.addEventListener('click', () => selectThis(null));
      item.querySelector('.btn-item-map').addEventListener('click', (e) => {
        e.stopPropagation();
        selectThis('map');
      });
      item.querySelector('.btn-item-cad').addEventListener('click', (e) => {
        e.stopPropagation();
        selectThis('cad');
      });

      listEl.appendChild(item);
    });
  }

  /**
   * Populate Layer visibility toggles
   */
  renderLayersList() {
    const container = document.getElementById('layers-list');
    if (!container || !this.cadData) return;
    container.innerHTML = '';

    for (const [name, layer] of Object.entries(this.cadData.layers)) {
      const row = document.createElement('label');
      row.className = 'flex items-center justify-between py-1.5 px-2.5 bg-slate-900/90 rounded-lg border border-slate-800 cursor-pointer hover:border-slate-700 text-xs';
      row.innerHTML = `
        <div class="flex items-center gap-2 truncate">
          <input type="checkbox" ${layer.visible !== false ? 'checked' : ''} class="rounded text-blue-500 bg-slate-800 border-slate-600">
          <span class="w-3 h-3 rounded-full shrink-0" style="background:${layer.color}"></span>
          <span class="text-slate-200 font-medium truncate">${name}</span>
        </div>
        <span class="text-[11px] font-mono text-slate-400">${layer.count || 0}개</span>
      `;

      row.querySelector('input').addEventListener('change', (e) => {
        layer.visible = e.target.checked;
        this.refreshAllViews(false);
      });

      container.appendChild(row);
    }
  }

  /**
   * 2-Point Calibration Modal logic
   */
  openCalibModal() {
    document.getElementById('calib-modal').classList.remove('hidden');
    if (this.cadData && this.cadData.bounds) {
      const b = this.cadData.bounds;
      document.getElementById('calib-cad-1-x').value = b.minX.toFixed(2);
      document.getElementById('calib-cad-1-y').value = b.minY.toFixed(2);
      document.getElementById('calib-cad-2-x').value = b.maxX.toFixed(2);
      document.getElementById('calib-cad-2-y').value = b.maxY.toFixed(2);
    }
  }

  closeCalibModal() {
    document.getElementById('calib-modal').classList.add('hidden');
  }

  handleMapCalibClick(latlng) {
    if (!this.calibPickStep) return false;
    document.getElementById(`calib-geo-${this.calibPickStep}-lat`).value = latlng.lat.toFixed(7);
    document.getElementById(`calib-geo-${this.calibPickStep}-lng`).value = latlng.lng.toFixed(7);
    this.calibPickStep = null;
    document.getElementById('calib-modal').classList.remove('hidden');
    this.showToast('지도 기준점 좌표가 입력되었습니다.');
    return true;
  }

  applyCalibration() {
    try {
      const pt1 = {
        cad: {
          x: parseFloat(document.getElementById('calib-cad-1-x').value),
          y: parseFloat(document.getElementById('calib-cad-1-y').value)
        },
        geo: {
          lat: parseFloat(document.getElementById('calib-geo-1-lat').value),
          lng: parseFloat(document.getElementById('calib-geo-1-lng').value)
        }
      };
      const pt2 = {
        cad: {
          x: parseFloat(document.getElementById('calib-cad-2-x').value),
          y: parseFloat(document.getElementById('calib-cad-2-y').value)
        },
        geo: {
          lat: parseFloat(document.getElementById('calib-geo-2-lat').value),
          lng: parseFloat(document.getElementById('calib-geo-2-lng').value)
        }
      };

      if (isNaN(pt1.geo.lat) || isNaN(pt1.geo.lng) || isNaN(pt2.geo.lat) || isNaN(pt2.geo.lng)) {
        alert('2개 기준점의 지도 위도/경도를 모두 입력해 주세요.');
        return;
      }

      const res = this.transformer.set2PointCalibration(pt1, pt2);
      this.transformer.setCrs('LOCAL_CALIBRATED');
      document.getElementById('select-crs').value = 'LOCAL_CALIBRATED';

      this.refreshAllViews(true);
      this.closeCalibModal();
      this.showToast(`🎯 2점 보정 적용 완료 (축척 ${res.params.scale.toFixed(3)}, 회전 ${res.params.rotationDeg.toFixed(1)}°)`);
    } catch (err) {
      alert('보정 오류: ' + err.message);
    }
  }

  showToast(message) {
    const toast = document.getElementById('app-toast');
    const text = document.getElementById('app-toast-text');
    if (!toast || !text) return;

    text.textContent = message;
    toast.classList.remove('opacity-0', 'translate-y-3');
    toast.classList.add('opacity-100', 'translate-y-0');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'translate-y-3');
    }, 3800);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.cadMapApp = new CadMapOverlayApp();
});
