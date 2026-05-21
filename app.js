
(async function() {
  
  // ─── Data Fetching Functions ──────────────────────────────────────────────
  async function fetchGeoData() {
    const url = "https://raw.githubusercontent.com/riley-kemp/Defence-Map/refs/heads/main/data/Canada_CD.json";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
    return response.json();
  }

  async function fetchCsvData() {
    const url = "https://raw.githubusercontent.com/riley-kemp/Defence-Map/refs/heads/main/data/defence_facilities.csv";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch CSV: ${response.statusText}`);
    
    const rawText = await response.text();
    return d3.csvParse(rawText);
  }

  // Load data sources in parallel
  let rawGeo, rawCsv;
  try {
    [rawGeo, rawCsv] = await Promise.all([fetchGeoData(), fetchCsvData()]);
  } catch (error) {
    console.error("Error initializing map data:", error);
    document.getElementById("map-container").innerHTML = `<p style="padding:20px; color:red;">Error loading map datasets. Check browser console for details.</p>`;
    return;
  }

  // ─── Constants ───────────────────────────────────────────────────────────────
  const WIDTH = 1200;
  const HEIGHT = 800;
  const SIDEBAR_WIDTH = 400; // desktop sidebar width in px
  
  const OPERATIONS_MAP = {
    "General_Count_sum":  "All Defence Facilities",
    "Manufacturing_sum":  "Manufacturers",
    "Value-Add/Tech_sum": "Technology Development & Other Related Facilities",
    "MRO/ISS_sum":        "Maintenance, Repair, Overhaul/In-Service Support Facilities",
  };

  const INDUSTRY_KEYS = {
    "Aircraft":          "Aircraft",
    "CnISR":             "C4ISR",
    "Land Sys":          "Land Systems",
    "Marine":            "Marine",
    "Nuclear":           "Nuclear",
    "Ordnance":          "Ordnance Systems",
    "Personnel":         "Personnel Systems",
    "Space":             "Space",
    "Other":             "Other/General Defence",
  };

  // ─── Map Individual Facilities ──────────────────────────────────────────────
  const isTrue = (val) => val && (val.toString().toLowerCase() === "true" || val.toString() === "1");

  const allFacilities = rawCsv.map((row, index) => {
    const facility = {
      id: index,
      cduid: row.CDUID?.toString().trim(),
      isMfg: isTrue(row.Manuf),
      isTech: isTrue(row["Value-Add"]),
      isMro: isTrue(row["MRO/ISS"]),
      isDefence: isTrue(row.General),
      industries: new Set(),                 
      rawRow: row                           
    };

    Object.keys(INDUSTRY_KEYS).forEach(ind => {
      if (isTrue(row[ind])) facility.industries.add(ind);
    });
    return facility;
  });

  function fixWinding(feature) {
    const f = JSON.parse(JSON.stringify(feature));
    const { type, coordinates } = f.geometry ?? {};
    if (type === "Polygon")      coordinates.forEach(r => r.reverse());
    if (type === "MultiPolygon") coordinates.forEach(p => p.forEach(r => r.reverse()));
    return f;
  }
  
  const fixedData = { ...rawGeo, features: rawGeo.features.map(fixWinding) };

  // ─── Updatable State Objects ────────────────────────────────────────────────
  const state = {
    currentAnalyticsKeys: new Set(),
    currentIndustries: new Map(),     
    industryFilterMode: "and",       
    currentTheme: "Classic",         
    isDark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    selectedFeature: null,           
    infoOpen: false,                 
    sidebarOpen: true,               
    legendMin: 0,                    
    legendMax: 1,                    
    legendColourScale: null,          
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const getLabel = (key) => OPERATIONS_MAP[key] ?? key;

  // Cached colour palette — call getC() instead of getColours(state.isDark) throughout.
  // Invalidated whenever state.isDark changes (see updateUI).
  let _cachedColours = null;
  function getC() {
    if (!_cachedColours) _cachedColours = getColours(state.isDark);
    return _cachedColours;
  }
  function invalidateColourCache() { _cachedColours = null; }

  function hasAnyData(feature) {
    const geoId = (feature.properties.CDUID || feature.properties.cduid || feature.properties.CD_UID)?.toString().trim();
    return allFacilities.some(f => f.cduid === geoId && f.isDefence);
  }

  function getFilteredValue(feature) {
    const geoId = (feature.properties.CDUID || feature.properties.cduid || feature.properties.CD_UID)?.toString().trim();
    let matches = allFacilities.filter(f => f.cduid === geoId && f.isDefence);
  
    if (state.currentAnalyticsKeys.size > 0) {
      matches = matches.filter(f => {
        const matchesMfg = state.currentAnalyticsKeys.has("Manufacturing_sum") && f.isMfg;
        const matchesTech = state.currentAnalyticsKeys.has("Value-Add/Tech_sum") && f.isTech;
        const matchesMro = state.currentAnalyticsKeys.has("MRO/ISS_sum") && f.isMro;
        
        return matchesMfg || matchesTech || matchesMro;
      });
    } else {
      matches = matches.filter(f => f.isDefence);
    }
    
    if (state.currentIndustries.size > 0) {
      matches = matches.filter(f => {
        const includes = [...state.currentIndustries.entries()].filter(([, s]) => s === "include").map(([ind]) => ind);
        const excludes = [...state.currentIndustries.entries()].filter(([, s]) => s === "exclude").map(([ind]) => ind);
        
        if (excludes.some(ind => f.industries.has(ind))) return false;
        if (includes.length === 0) return true;
        
        return state.industryFilterMode === "and"
          ? includes.every(ind => f.industries.has(ind))
          : includes.some(ind => f.industries.has(ind));
      });
    }
  
    return matches.length;
  }

  function getTooltipLabel(val) {
    const filtersActive = state.currentIndustries.size > 0 || state.currentAnalyticsKeys.size > 0;
    if (filtersActive) {
      return `${val.toLocaleString()} ${val === 1 ? "Facility" : "Facilities"} (Matching active filters)`;
    }
    return `${val.toLocaleString()} ${val === 1 ? "Facility" : "Facilities"}`;
  }

  function getColours(isDark) {
    return isDark
      ? {
          bg:          "#0e1117",
          surface:     "#161b24",
          border:      "rgba(255,255,255,0.1)",
          text:        "#e8eaf0",
          muted:       "#6b7280",
          accent:      "#00a94f",
          accent2:     "#f0a500",
          noData:      "#2a3040",
          noDataNone:  "#191d25"
        }
      : {
          bg:          "#f8f9fa",
          surface:     "#ffffff",
          border:      "rgba(0,0,0,0.08)",
          text:        "#1a1a1a",
          muted:       "#717171",
          accent:      "#00a94f",
          accent2:     "#d97706",
          noData:      "#adb1ba",
          noDataNone:  "#e0e2e6"
        };
  }

  // ─── Mobile Detection ────────────────────────────────────────────────────────
  const isMobile = () => window.innerWidth <= 768;

  // ─── DOM Setup ───────────────────────────────────────────────────────────────
  const styleLink = Object.assign(document.createElement("link"), {
    rel:  "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=DM+Sans:wght@300;400;500&display=swap",
  });
  document.head.appendChild(styleLink);

  const btnTooltipStyle = document.createElement("style");
  btnTooltipStyle.textContent = `
    .btn-wrap { position: relative; display: inline-flex; }
    .btn-wrap .btn-tip {
      position: absolute;
      right: calc(100% + 8px);
      top: 50%;
      transform: translateY(-50%);
      background: rgba(20,20,30,0.92);
      color: #e8eaf0;
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      padding: 5px 9px;
      border-radius: 5px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      z-index: 9999;
    }
    .btn-wrap:hover .btn-tip { opacity: 1; }

    /* ── Mobile bottom-sheet layout ── */
    @media (max-width: 768px) {
      .btn-wrap .btn-tip { display: none; }
    }
    #mobile-sheet-handle {
      width: 36px; height: 4px; border-radius: 2px;
      margin: 10px auto 4px; flex-shrink: 0;
    }
    #mobile-filter-toggle {
      position: absolute;
      bottom: env(safe-area-inset-bottom, 16px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      padding: 10px 20px;
      border-radius: 24px;
      font-family: 'Inter', sans-serif;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.8px;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      transition: all 0.3s ease;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(btnTooltipStyle);

  function addBtnTooltip(btnSelection, tipText) {
    const node = btnSelection.node();
    const parent = node.parentNode;
    const wrap = document.createElement("div");
    wrap.className = "btn-wrap";
    parent.insertBefore(wrap, node);
    wrap.appendChild(node);
    const tip = document.createElement("span");
    tip.className = "btn-tip";
    tip.textContent = tipText;
    wrap.appendChild(tip);
    return btnSelection;
  }

  // Target the container in index.html instead of calling d3.create()
	const container = d3.select("#map-container")
	  .style("display", "flex")
	  .style("font-family", "'Inter', sans-serif")
	  .style("width", "100%")
	  .style("height", "100%")
	  .style("overflow", "hidden")
	  .style("position", "relative")
	  .style("transition", "background 0.3s ease");

  const controlPanel = container.append("div")
    .style("position", "absolute")
    .style("top", "max(20px, env(safe-area-inset-top, 20px))")
    .style("right", "max(16px, env(safe-area-inset-right, 16px))")
    .style("z-index", "100")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("gap", "6px");

  const btnSize   = isMobile() ? "44px" : "40px";
  const btnPad    = isMobile() ? "10px 14px" : "8px 12px";
  const btnFontSz = isMobile() ? "16px" : "14px";

  const infoBtn = controlPanel.append("button")
    .text("ⓘ")
    .attr("aria-label", "About this map")
    .style("padding", btnPad)
    .style("border-radius", "8px")
    .style("cursor", "pointer")
    .style("font-size", btnFontSz)
    .style("width", btnSize)
    .style("height", btnSize)
    .style("margin-bottom", "4px") 
    .on("click", () => {
      state.infoOpen = !state.infoOpen;
      infoSidebar.style("transform", state.infoOpen ? "translateX(0)" : "translateX(100%)");
    });
  
  const themeToggle = controlPanel.append("button").attr("aria-label", "Toggle light / dark mode").style("padding", btnPad).style("border-radius", "8px").style("cursor", "pointer").style("font-size", btnFontSz).style("margin-bottom", "4px").style("width", btnSize).style("height", btnSize).style("transition", "all 0.3s ease").on("click", () => { state.isDark = !state.isDark; updateUI(); renderMap(); });
  // On mobile, hide zoom buttons — users pinch to zoom natively
  const zoomInBtn  = controlPanel.append("button").attr("aria-label", "Zoom in").style("padding", btnPad).style("border-radius", "8px").style("cursor", "pointer").style("font-size", btnFontSz).style("font-weight", "600").style("width", btnSize).style("height", btnSize).style("transition", "all 0.3s ease").style("display", isMobile() ? "none" : null).text("+").on("click", () => svg.transition().duration(350).call(zoom.scaleBy, 1.5));
  const zoomOutBtn = controlPanel.append("button").attr("aria-label", "Zoom out").style("padding", btnPad).style("border-radius", "8px").style("cursor", "pointer").style("font-size", btnFontSz).style("font-weight", "600").style("margin-bottom", "4px").style("width", btnSize).style("height", btnSize).style("transition", "all 0.3s ease").style("display", isMobile() ? "none" : null).text("−").on("click", () => svg.transition().duration(350).call(zoom.scaleBy, 0.67));
  const homeBtn    = controlPanel.append("button").attr("aria-label", "Reset map view").style("padding", btnPad).style("border-radius", "8px").style("cursor", "pointer").style("font-size", btnFontSz).style("width", btnSize).style("height", btnSize).style("transition", "all 0.3s ease").text("⌂").on("click", () => {
    if (isMobile()) { state.sidebarOpen = false; updateSidebarToggle(); }
    if (state.selectedFeature) resetView(); else zoomToFull();
  });

  addBtnTooltip(infoBtn,     "About this map");
  addBtnTooltip(themeToggle, "Toggle light / dark mode");
  addBtnTooltip(zoomInBtn,   "Zoom in");
  addBtnTooltip(zoomOutBtn,  "Zoom out");
  addBtnTooltip(homeBtn,     "Reset view");

  // Create a flexbox wrapper inside the main container to sit the sidebar and map side-by-side
  const mainWrapper = container.append("div")
    .style("display", "flex")
    .style("width", "100%")
    .style("height", "100%")
    .style("position", "relative");

  // Append the sidebar inside the mainWrapper
  // On mobile: positioned as a bottom sheet (absolute, slides up from bottom)
  // On desktop: left side panel (flex child)
  const sidebar = mainWrapper.append("div")
    .style("box-sizing", "border-box")
    .style("overflow-y", "auto")
    .style("z-index", "10")
    .style("position", isMobile() ? "absolute" : "relative");

  if (isMobile()) {
    sidebar
      .style("width", "100%")
      .style("height", "clamp(220px, 55%, 70%)")
      .style("bottom", "0")
      .style("left", "0")
      .style("padding", "0 18px 18px")
      .style("border-radius", "16px 16px 0 0")
      .style("box-shadow", "0 -4px 24px rgba(0,0,0,0.18)")
      .style("transform", "translateY(100%)")
      .style("transition", "transform 0.4s ease, background 0.3s ease, border 0.3s ease");
  } else {
    sidebar
      .style("width", `${SIDEBAR_WIDTH}px`)
      .style("height", "100%")
      .style("padding", "30px 24px")
      .style("transition", "width 0.4s ease, padding 0.4s ease");
  }

  // A wrapper inside the sidebar to hide elements cleanly when closed
  const sidebarInnerContent = sidebar.append("div")
    .style("width", "100%")
    .style("height", "100%");

  // On mobile: add a visible drag handle bar at top of bottom sheet
  // On desktop: add the ◀/▶ collapse button on the mainWrapper seam
  let collapseBtn;
  if (isMobile()) {
    // Touch-draggable handle bar — swipe up opens, swipe down closes; tap also toggles
    const handle = sidebar.insert("div", ":first-child")
      .attr("id", "mobile-sheet-handle")
      .style("background", "rgba(128,128,128,0.35)")
      .style("cursor", "grab")
      .style("touch-action", "none"); // prevent page scroll during drag

    let dragStartY = null;
    let sheetStartOpen = null;

    handle.on("touchstart", function(event) {
      dragStartY = event.touches[0].clientY;
      sheetStartOpen = state.sidebarOpen;
      event.preventDefault();
    }, { passive: false });

    handle.on("touchend", function(event) {
      if (dragStartY === null) return;
      const dy = event.changedTouches[0].clientY - dragStartY;
      const wasSmallTap = Math.abs(dy) < 8;
      if (wasSmallTap) {
        // treat as tap — toggle
        state.sidebarOpen = !state.sidebarOpen;
      } else {
        // swipe up (dy < 0) → open; swipe down (dy > 0) → close
        state.sidebarOpen = dy < 0;
      }
      dragStartY = null;
      updateSidebarToggle();
    });

    handle.on("touchmove", function(event) {
      event.preventDefault(); // block page scroll while dragging handle
    }, { passive: false });

    // "Filters" pill button floating at bottom of the map
    collapseBtn = container.append("button")
      .attr("id", "mobile-filter-toggle")
      .text("▲  FILTERS")
      .on("click", () => {
        state.sidebarOpen = !state.sidebarOpen;
        updateSidebarToggle();
      });
  } else {
    collapseBtn = mainWrapper.append("button")
      .style("position", "absolute")
      .style("top", "24px")
      .style("left", `${SIDEBAR_WIDTH - 16}px`)
      .style("width", "32px")
      .style("height", "32px")
      .style("border-radius", "50%")
      .style("cursor", "pointer")
      .style("font-size", "12px")
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("box-shadow", "0 2px 8px rgba(0,0,0,0.15)")
      .style("z-index", "999")
      .style("transition", "left 0.4s ease, background 0.3s ease, color 0.3s ease, border 0.3s ease")
      .on("click", () => {
        state.sidebarOpen = !state.sidebarOpen;
        updateSidebarToggle();
        collapseBtn.attr("title", state.sidebarOpen ? "Close side panel" : "Open side panel");
      });
  }

  // Change structural targets to use the newly introduced inner content wrapper
  const controlsDiv = sidebarInnerContent.append("div").style("margin-bottom", "40px");
  const detailsDiv  = sidebarInnerContent.append("div");

  // On mobile: inject a close (✕) button row at the very top of inner content
  if (isMobile()) {
    const closeRow = sidebarInnerContent.insert("div", ":first-child")
      .attr("id", "mobile-sheet-close")
      .style("display", "none")           // shown only when sheet is open (updateSidebarToggle)
      .style("justify-content", "flex-end")
      .style("padding", "6px 0 2px");

    closeRow.append("button")
      .text("✕")
      .style("background", "transparent")
      .style("border", "none")
      .style("font-size", "18px")
      .style("line-height", "1")
      .style("padding", "4px 6px")
      .style("cursor", "pointer")
      .style("color", "inherit")
      .on("click", () => {
        if (state.selectedFeature) {
          restoreMapAppearance(); // clears selection, restores brightness, closes sheet
        } else {
          state.sidebarOpen = false;
          updateSidebarToggle();
        }
      });
  }

  const infoSidebar = container.append("div")
    .style("position", "absolute")
    .style("top", "0")
    .style("right", "0")
    .style("width", isMobile() ? "min(92vw, 360px)" : "300px")
    .style("height", "100%")
    .style("padding", isMobile() ? "24px 18px" : "30px 24px")
    .style("overflow-y", "auto")
    .style("z-index", "200")
    .style("box-shadow", "-4px 0 20px rgba(0,0,0,0.15)")
    .style("transform", "translateX(100%)")
    .style("transition", "transform 0.4s ease, background 0.3s ease, border 0.3s ease")
    .style("box-sizing", "border-box");
  
  const infoModal = infoSidebar;

  const tooltip = d3.select("body").append("div")
    .style("position", "absolute")
    .style("visibility", "hidden")
    .style("padding", "10px 14px")
    .style("border-radius", "2px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("font-family", "'Inter', sans-serif")
    .style("z-index", "1000");

  if (!isMobile()) {
    collapseBtn
      .on("mouseenter.tip", function(event) {
        const label = state.sidebarOpen ? "Close side panel" : "Open side panel";
        const rect = this.getBoundingClientRect();
        tooltip
          .style("visibility", "visible")
        .style("background", "rgba(20,20,30,0.92)")
        .style("color", "#e8eaf0")
        .style("padding", "5px 9px")
        .style("border-radius", "5px")
        .style("font-size", "11px")
        .style("box-shadow", "0 2px 8px rgba(0,0,0,0.25)")
        .html(label)
        .style("top",  `${rect.top  + window.scrollY + rect.height / 2 - 14}px`)
        .style("left", `${rect.right + window.scrollX + 8}px`);
    })
    .on("mouseleave.tip", () => tooltip.style("visibility", "hidden"));
  }

  const mapContainer = mainWrapper.append("div")
    .style("flex", "1")
    .style("position", "relative")
    .style("transition", "all 0.4s ease");
  
  const svg = mapContainer.append("svg")
  .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)
  .attr("preserveAspectRatio", "xMidYMid meet")
  .style("width", "100%")
  .style("height", "100%")
  .on("click", () => {});
  const mapGroup = svg.append("g"); 
  const legendOverlay = mapContainer.append("div")
    .style("position", "absolute")
    .style("bottom", isMobile() ? null : "30px")
    .style("top",    isMobile() ? "max(20px, env(safe-area-inset-top, 20px))" : null)
    .style("left",   isMobile() ? "10px" : null)
    .style("right",  isMobile() ? null   : "30px")
    .style("backdrop-filter", "blur(15px)")
    .style("padding", isMobile() ? "10px 12px" : "20px")
    .style("border-radius", "6px")
    .style("min-width", isMobile() ? null : "260px")
    .style("max-width", isMobile() ? "calc(100vw - 80px)" : null)  // never bleed under buttons
    .style("box-sizing", "border-box")
    .style("overflow", "hidden")
    .style("transition", "all 0.3s ease");

  const COLOUR_THEMES = {
    Classic: d3.interpolateRgbBasis(["#648FFF", "#785EF0", "#DC267F", "#FE6100", "#FFB000"]),
    Greens:  d3.interpolateRgbBasis(["#1a4a3a", "#4ecca3", "#f0a500"]),
    Viridis: d3.interpolateViridis,
    Heat:    d3.interpolateRgbBasis(["#fce2c5", "#a60303"]),
    Plasma:  d3.interpolatePlasma,
  };

  const projection = d3.geoConicConformal()
    .parallels([49, 77])
    .rotate([96, 0])
    .center([0, 60])
    .fitExtent([[10, 20], [WIDTH - 10, HEIGHT - 110]], fixedData);
  const path = d3.geoPath().projection(projection);
  
  const zoom = d3.zoom().scaleExtent([1, 40]).on("zoom", ({ transform }) => mapGroup.attr("transform", transform));
  svg.call(zoom);

  function zoomToFeature(feature) {
    const [[x0, y0], [x1, y1]] = path.bounds(feature);
    const dx = x1 - x0; const dy = y1 - y0;
    const scale = Math.min(40, 0.95 / Math.max(dx / WIDTH, dy / HEIGHT));
    const translate = [WIDTH / 2 - scale * ((x0 + x1) / 2), HEIGHT / 2 - scale * ((y0 + y1) / 2)];
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
  }
  
  function zoomToFull() { svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity); }

  function updateSidebarToggle() {
    if (isMobile()) {
      const c = getC();
      if (state.sidebarOpen) {
        sidebar.style("transform", "translateY(0)");
        // Hide the floating pill — the sheet's own ✕ button handles closing
        d3.select("#mobile-filter-toggle").style("display", "none");
        d3.select("#mobile-sheet-close").style("display", "flex");
      } else {
        sidebar.style("transform", "translateY(100%)");
        // Show the pill so users can reopen the sheet
        d3.select("#mobile-filter-toggle")
          .style("display", null)
          .style("background", c.accent)
          .style("color", "#fff")
          .style("border", `1px solid ${c.accent}`);
        d3.select("#mobile-sheet-close").style("display", "none");
      }
      return;
    }
    // Desktop behaviour (unchanged)
    if (state.sidebarOpen) {
      sidebar.style("width", `${SIDEBAR_WIDTH}px`).style("padding", "30px 24px");
      sidebarInnerContent.style("display", "block");
      collapseBtn.text("◀").style("left", `${SIDEBAR_WIDTH - 16}px`); 
    } else {
      sidebar.style("width", "30px").style("padding", "30px 0px");
      sidebarInnerContent.style("display", "none");
      collapseBtn.text("▶").style("left", "14px"); 
    }
  }

  // ─── Render Frameworks ───────────────────────────────────────────────────────
  function updateLegend(min, max, colourScale) {
    const c = getC();
    // On mobile, derive the bar width from the viewport: legend sits at left:10px,
    // max-width is (100vw - 80px), internal padding is 24px total → bar fills the rest.
    // Using window.innerWidth is reliable even before first paint.
    const BAR_WIDTH = isMobile()
      ? Math.max(80, Math.min(280, window.innerWidth - 80 - 24))
      : 280;
    const BAR_HEIGHT = 4;
    legendOverlay.selectAll("*").remove();
    legendOverlay.append("div").style("font-size", "10px").style("font-weight", "600").style("letter-spacing", "1.2px").style("margin-bottom", "12px").style("color", c.muted).text("DEFENCE FACILITY COUNT");

    const svgL = legendOverlay.append("svg").attr("id", "legend-bar-svg").attr("width", BAR_WIDTH).attr("height", 38).style("display", "block");
    const gradId = `legend-grad-${Math.random().toString(36).slice(2, 11)}`;
    const grad = svgL.append("defs").append("linearGradient").attr("id", gradId);
    
    [0, 0.5, 1].forEach(t => grad.append("stop").attr("offset", `${t * 100}%`).attr("stop-color", colourScale(min + t * (max - min))));

    svgL.append("rect").attr("width", BAR_WIDTH).attr("height", BAR_HEIGHT).attr("rx", 2).style("fill", `url(#${gradId})`);
    svgL.append("text").attr("x", 0).attr("y", BAR_HEIGHT + 15).style("font-size", "11px").style("fill", c.text).text(min.toLocaleString());
    svgL.append("text").attr("x", BAR_WIDTH).attr("y", BAR_HEIGHT + 15).attr("text-anchor", "end").style("font-size", "11px").style("fill", c.text).text(max.toLocaleString());

    const markerG = svgL.append("g").attr("id", "legend-marker").style("display", "none");
    markerG.append("line")
      .attr("id", "legend-marker-line")
      .attr("x1", 0).attr("x2", 0)
      .attr("y1", -4).attr("y2", BAR_HEIGHT + 4)
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round")
      .style("filter", "drop-shadow(0 0 2px rgba(0,0,0,0.6))");
    
    markerG.append("text").attr("id", "legend-marker-label").attr("y", BAR_HEIGHT + 28).attr("text-anchor", "middle").style("font-size", "10px").style("font-weight", "600").style("font-family", "'Inter', sans-serif").style("fill", c.text);

    if (state.selectedFeature) {
      const val = getFilteredValue(state.selectedFeature);
      if (val > 0) updateLegendMarker(val, true);
    }

    const swatchDiv = legendOverlay.append("div").style("margin-top", "12px");
    [{ color: c.noData, label: "No defence facilities with the current filters" }, { color: c.noDataNone, label: "No defence facilities recorded" }].forEach(({ color, label }) => {
      const row = swatchDiv.append("div").style("display", "flex").style("align-items", "flex-start").style("gap", "8px").style("margin-bottom","6px");
      row.append("div").style("width", "16px").style("min-width", "16px").style("height", "10px").style("margin-top", "2px").style("border-radius","2px").style("background", color);
      row.append("span").style("font-size", "10px").style("color", c.muted).style("line-height", "1.4").style("word-break", "break-word").text(label);
    });

    legendOverlay.append("div").style("margin-top", "15px").style("display", "flex").style("justify-content", "space-between").style("gap", "4px").selectAll("button").data(Object.keys(COLOUR_THEMES)).join("button")
      .text(d => d).style("flex", "1").style("background", d => d === state.currentTheme ? (state.isDark ? "rgba(78,204,163,0.1)" : "rgba(5,150,105,0.1)") : "transparent").style("color", d => d === state.currentTheme ? c.accent : c.muted).style("border", d => d === state.currentTheme ? `1px solid ${c.accent}` : `1px solid ${c.border}`).style("padding", "5px 0").style("font-size", "8.5px").style("cursor", "pointer").style("border-radius", "3px").style("text-transform", "uppercase").style("font-family", "'Inter', sans-serif").style("transition", "all 0.2s ease")
      .on("mouseenter", function(_, d) { if (d !== state.currentTheme) d3.select(this).style("border", `1px solid ${c.accent}`).style("transform", "scale(1.08)"); })
      .on("mouseleave", function(_, d) { if (d !== state.currentTheme) d3.select(this).style("border", `1px solid ${c.border}`).style("transform", "scale(1)"); })
      .on("click", (_, d) => { state.currentTheme = d; renderMap(); });
  }

  function updateLegendEmpty() {
    const c = getC(); legendOverlay.selectAll("*").remove();
    legendOverlay.append("div").style("font-size", "10px").style("font-weight", "600").style("letter-spacing", "1.2px").style("color", c.muted).text("DEFENCE FACILITY COUNT");
    legendOverlay.append("div").style("font-size", "12px").style("color", c.muted).style("font-style", "italic").style("margin", "12px 0").text("No facilities match current filters.");
    const swatchDiv = legendOverlay.append("div");
    [{ color: c.noData, label: "No defence facilities with the current filters" }, { color: c.noDataNone, label: "No defence facilities recorded" }].forEach(({ color, label }) => {
      const row = swatchDiv.append("div").style("display", "flex").style("align-items", "flex-start").style("gap", "8px").style("margin-bottom","6px");
      row.append("div").style("width", "16px").style("min-width", "16px").style("height", "10px").style("margin-top", "2px").style("border-radius","2px").style("background", color);
      row.append("span").style("font-size", "10px").style("color", c.muted).style("line-height", "1.4").style("word-break", "break-word").text(label);
    });
  }

  function updateLegendMarker(val, persistent) {
    const svgEl = document.getElementById("legend-bar-svg");
    const BAR_WIDTH = svgEl ? parseFloat(svgEl.getAttribute("width")) : 280;
    const markerG = d3.select("#legend-marker");
    if (markerG.empty()) return;
    
    if (val === null || val === undefined || val <= 0) {
      if (!persistent && state.selectedFeature) {
        const selVal = getFilteredValue(state.selectedFeature);
        if (selVal > 0) { updateLegendMarker(selVal, true); return; }
      }
      markerG.style("display", "none");
      return;
    }
    
    const t = Math.max(0, Math.min(1, (val - state.legendMin) / (state.legendMax - state.legendMin)));
    const xPos = t * BAR_WIDTH;
    
    markerG.style("display", null);
    markerG.select("#legend-marker-line").attr("x1", xPos).attr("x2", xPos);
    
    const lineColour = state.isDark
      ? (persistent ? "#ffffff"       : "rgba(255,255,255,0.6)")
      : (persistent ? "#1a1a1a"       : "rgba(26,26,26,0.5)");
    markerG.select("#legend-marker-line").attr("stroke", lineColour);
  }

  function clearLegendMarker() {
    if (state.selectedFeature) {
      const val = getFilteredValue(state.selectedFeature);
      if (val > 0) { updateLegendMarker(val, true); return; }
    }
    d3.select("#legend-marker").style("display", "none");
  }

  function renderMap() {
    const c = getC();
    const values = fixedData.features.map(d => getFilteredValue(d)).filter(v => v > 0);
    const minVal = d3.min(values) ?? 0; const maxVal = d3.max(values) ?? 1;
    
    const colourScale = d3.scaleSequential([minVal, Math.max(maxVal, minVal + 1)], COLOUR_THEMES[state.currentTheme]);
    state.legendMin = minVal; state.legendMax = Math.max(maxVal, minVal + 1); state.legendColourScale = colourScale;

    if (values.length === 0) updateLegendEmpty(); else updateLegend(minVal, maxVal, colourScale);

    mapGroup.selectAll("path.cd-region")
      .data(fixedData.features)
      .join("path")
        .attr("class", "cd-region").attr("d", path).attr("stroke", c.bg).attr("stroke-width", 0.5).attr("vector-effect", "non-scaling-stroke")
        .style("cursor", d => (getFilteredValue(d) > 0 || hasAnyData(d)) ? "pointer" : "default")
        .on("mouseover", isMobile() ? null : function(event, d) {
          d3.select(this).attr("stroke", c.text).attr("stroke-width", 1).raise();
          const hoverVal = getFilteredValue(d);
          updateLegendMarker(hoverVal > 0 ? hoverVal : null, false);
          
          tooltip.style("visibility", "visible").html(`
            <div style="color:${c.accent}; font-weight:600; font-size:14px; margin-bottom:4px;">${d.properties.CDNAME}</div>
            <div style="font-size:11px; color:${c.muted}; font-weight:400;">${getTooltipLabel(getFilteredValue(d))}</div>
          `);
        })
        .on("mousemove", isMobile() ? null : event => tooltip.style("top", `${event.pageY - 10}px`).style("left", `${event.pageX + 20}px`))
        .on("mouseout", isMobile() ? null : function() {
          const sel = d3.select(this); if (sel.attr("stroke") !== c.accent2) sel.attr("stroke", c.bg).attr("stroke-width", 0.5);
          clearLegendMarker();
          tooltip.style("visibility", "hidden");
        })
        .on("click", function(event, d) {
          event.stopPropagation(); 
          if (!hasAnyData(d)) { restoreMapAppearance(); return; } 
          
          state.selectedFeature = d;
          const selVal = getFilteredValue(d);
          updateLegendMarker(selVal > 0 ? selVal : null, true);
          
          if(!state.sidebarOpen) {
            state.sidebarOpen = true;
            updateSidebarToggle();
          }

          mapGroup.selectAll("path.cd-region").style("opacity", 0.35).attr("stroke", c.bg);
          d3.select(this).style("opacity", 1).attr("stroke", c.accent2).attr("stroke-width", 2).raise();
          
          zoomToFeature(d); 
          updateSidebarDetail();

          // After the detail panel DOM has been built and reflowed, scroll the
          // sidebar so the census division name and donut are visible.
          // A short timeout lets the browser finish laying out the new content
          // before we measure element positions.
          setTimeout(() => {
            const sidebarEl = sidebar.node();
            const detailEl  = detailsDiv.node();
            if (!sidebarEl || !detailEl) return;
            if (isMobile()) {
              sidebarEl.scrollTop = detailEl.offsetTop - 8;
            } else {
              // Ideal target: scroll so the census division name (detailsDiv top)
              // sits near the top of the sidebar, with a small breathing-room gap.
              const idealTop = detailEl.offsetTop - 16;

              // Safety check: also ensure the bottom of the donut is fully visible.
              // If the donut hasn't rendered yet its height is 0, so this gracefully
              // falls back to the ideal position in that case.
              const donutEl = document.getElementById("donut-chart");
              const donutBottom = donutEl
                ? donutEl.offsetTop + donutEl.offsetHeight + 16
                : 0;
              const minScrollTop = donutBottom - sidebarEl.clientHeight;

              const scrollTarget = Math.max(idealTop, minScrollTop);
              sidebarEl.scrollTo({ top: scrollTarget, behavior: "smooth" });
            }
          }, 50);
        })
          .transition().duration(700)
            .style("opacity", d => (state.selectedFeature && d !== state.selectedFeature) ? 0.35 : 1)
            .attr("stroke", d => (d === state.selectedFeature) ? c.accent2 : c.bg)
            .attr("stroke-width", d => (d === state.selectedFeature) ? 2 : 0.5)
            .attr("fill", d => {
              const val = getFilteredValue(d);
              if (val) return colourScale(val);
              return hasAnyData(d) ? c.noData : c.noDataNone;
            });
  }

  function updateSidebarDetail() {
    const c = getC();
    
    if (document.getElementById("mfg-rows")) document.getElementById("mfg-rows").style.display = "none";
    if (document.getElementById("tech-rows")) document.getElementById("tech-rows").style.display = "none";
    if (document.getElementById("mro-rows")) document.getElementById("mro-rows").style.display = "none";

    if (!state.selectedFeature) {
      detailsDiv.html(`<p style="color:${c.muted}; font-size:14px; font-weight:400;">Select a census division to analyse specific industry metrics.</p>`);
      return;
    }

    const props = state.selectedFeature.properties;
    const geoId = (props.CDUID || props.cduid || props.CD_UID)?.toString().trim();

    const activeLocalFacilities = allFacilities.filter(f => {
      if (f.cduid !== geoId) return false;
      
      if (state.currentAnalyticsKeys.size > 0) {
        const matchesMfg = state.currentAnalyticsKeys.has("Manufacturing_sum") && f.isMfg;
        const matchesTech = state.currentAnalyticsKeys.has("Value-Add/Tech_sum") && f.isTech;
        const matchesMro = state.currentAnalyticsKeys.has("MRO/ISS_sum") && f.isMro;
        
        if (!(matchesMfg || matchesTech || matchesMro)) return false;
      } else {
        if (!f.isDefence) return false;
      }

      if (state.currentIndustries.size > 0) {
        const includes = [...state.currentIndustries.entries()].filter(([, s]) => s === "include").map(([ind]) => ind);
        const excludes = [...state.currentIndustries.entries()].filter(([, s]) => s === "exclude").map(([ind]) => ind);
        if (excludes.some(ind => f.industries.has(ind))) return false;
        if (includes.length > 0) {
          const passes = state.industryFilterMode === "and"
            ? includes.every(ind => f.industries.has(ind))
            : includes.some(ind => f.industries.has(ind));
          if (!passes) return false;
        }
      }
      return true;
    });
    
    const stats = [
      ["Manufacturing_sum", activeLocalFacilities.filter(f => f.isMfg).length],
      ["Value-Add/Tech_sum", activeLocalFacilities.filter(f => f.isTech).length],
      ["MRO/ISS_sum",        activeLocalFacilities.filter(f => f.isMro).length]
    ].filter(([_, v]) => v > 0);

    const INDUSTRY_COLOURS = Object.fromEntries(Object.keys(INDUSTRY_KEYS).map((k, i) => [INDUSTRY_KEYS[k], d3.schemeObservable10[i]]));
    const industryData = Object.entries(INDUSTRY_KEYS).map(([k, label]) => ({ label, value: activeLocalFacilities.filter(f => f.industries.has(k)).length })).filter(d => d.value > 0);

    const MFG_KEYS = {
      "M_313": "Textile Mills", "M_314": "Textile Products", "M_315": "Apparel Products",
      "M_316": "Leather & Allied Products", "M_321": "Wood Products", "M_322": "Paper Products",
      "M_323": "Printing & Related Support Products", "M_325": "Chemical Products",
      "M_326": "Plastics & Rubber Products", "M_327": "Non-Metallic Mineral Products",
      "M_332": "Fabricated Metal Products", "M_333": "Machinery", "M_334": "Computer & Electronic Products",
      "M_335": "Electrical Equipment & Components", "M_336": "Transportation Equipment",
      "M_337": "Furniture & Related Products", "M_339": "Miscellaneous Products"
    };

    const TECH_KEYS = {
      "V_238": "Specialty Trade Contractors", "V_414": "Personal Goods Wholesalers",
      "V_416": "Building Material Wholesalers", "V_417": "Machinery & Equipment Wholesalers",
      "V_418": "Miscellaneous Wholesalers", "V_488": "Support Activities for Transport",
      "V_517": "Telecommunications Services", "V_518": "Data Processing & Hosting",
      "V_541": "Professional, Scientific & Technical Services", "V_561": "Administrative & Support Services",
      "V_611": "Educational Services", "V_811": "Repair & Maintenance Services"
    };

    const MRO_KEYS = {
      "I_336": "Transportation Equipment", "I_488": "Transport Support Systems", "I_811": "Heavy Repair & Maintenance"
    };

    const mfgData = Object.entries(MFG_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMfg && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);
    const techData = Object.entries(TECH_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isTech && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);
    const mroData = Object.entries(MRO_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMro && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);

    function buildAccordionRow(k, v, subData, toggleId, rowsId, chevronId) {
      const hasBreakdown = subData.length > 0;
      const subRows = hasBreakdown ? `
        <div id="${rowsId}" style="display:none; padding-bottom:4px;">
          ${subData.map(({ label, value }) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0 6px 14px; border-bottom:1px solid ${c.border}; font-size:11px; font-family:'Inter', sans-serif;">
              <span style="color:${c.muted}; font-weight:400; opacity:0.8;">${label}</span>
              <span style="font-weight:500; color:${c.accent}; margin-left:8px; opacity:0.85;">${value.toLocaleString()}</span>
            </div>
          `).join("")}
        </div>` : "";

      return `
        <div style="border-bottom:1px solid ${c.border};">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; font-size:12px; font-family:'Inter', sans-serif; ${hasBreakdown ? "cursor:pointer;" : ""} user-select:none;" ${hasBreakdown ? `id="${toggleId}" role="button" tabindex="0" aria-expanded="false"` : ""}>
            <span style="color:${c.muted}; font-weight:400;">${getLabel(k)}</span>
            <span style="display:flex; align-items:center;"><span style="font-weight:600; color:${c.accent}">${v.toLocaleString()}</span>${hasBreakdown ? `<span id="${chevronId}" style="font-size:9px; color:${c.accent}; margin-left:8px; display:inline-block; transition:transform 0.2s;">▼</span>` : ""}</span>
          </div>
          ${subRows}
        </div>`;
    }

	const headerHtml = `
      <div id="sidebar-header-container" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; font-family: 'Inter', sans-serif;">
        <div style="flex: 1;">
          <h3 style="font-size: 24px; font-weight: 600; margin: 0 0 4px 0; color: ${c.text}; line-height: 1.2;">${props.CDNAME}</h3>
          <div style="font-size: 11px; color: ${c.muted}; font-weight: 500; letter-spacing: 1px; text-transform: uppercase;">${props.PRNAME ?? ""}</div>
        </div>
      </div>
    `;

    if (activeLocalFacilities.length === 0) {
      detailsDiv.html(`
        ${headerHtml}
        <div style="background: ${state.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}; border: 1px dashed ${c.border}; border-radius: 6px; padding: 24px; text-align: center; margin-top: 20px;">
          <p style="color: ${c.accent}; font-size: 14px; font-weight: 600; margin: 0 0 6px 0;">No facilities match active filters in this region.</p>
          <p style="color: ${c.muted}; font-size: 12px; margin: 0; line-height: 1.4;">Try adjusting or resetting your operations and industry filters to see the regional capabilities.</p>
        </div>
      `);
      

      d3.select("#sidebar-header-container")
        .append("button")
        .attr("id", "sidebar-back")
        .text(isMobile() ? "✕" : "CLOSE CENSUS DIVISION DETAILS")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", isMobile() ? "18px" : "9px")
        .style("font-weight", isMobile() ? "400" : "600")
        .style("background", "transparent")
        .style("border", isMobile() ? "none" : `1px solid ${c.accent}`)
        .style("color", isMobile() ? c.muted : c.accent)
        .style("padding", isMobile() ? "0 4px" : "4px 9px")
        .style("border-radius", "4px")
        .style("cursor", "pointer")
        .style("white-space", "nowrap")
        .style("transition", "all 0.2s ease")
        .style("margin-top", "2px")
        .style("line-height", "1")
        .on("click", restoreMapAppearance)
        .on("mouseenter", function() { if (!isMobile()) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)"); })
        .on("mouseleave", function() { if (!isMobile()) d3.select(this).style("background", "transparent"); });
        
      return;
    }

    const rows = stats.map(([k, v]) => {
      if (k === "Manufacturing_sum") return buildAccordionRow(k, v, mfgData, "mfg-toggle", "mfg-rows", "mfg-chevron");
      if (k === "Value-Add/Tech_sum") return buildAccordionRow(k, v, techData, "tech-toggle", "tech-rows", "tech-chevron");
      if (k === "MRO/ISS_sum")        return buildAccordionRow(k, v, mroData,  "mro-toggle",  "mro-rows",  "mro-chevron");
      return buildAccordionRow(k, v, [], "", "", "");
    }).join("");

    detailsDiv.html(`
      ${headerHtml}
      <div id="donut-chart" style="margin-bottom:28px;"></div>
      <p style="font-size:12px; color:${c.muted}; margin: 28px 0; line-height:1.5; font-weight:400;"><b>Please note:</b> a single facility may serve multiple defence industries.</p>
      <div style="font-size:10px; font-weight:600; letter-spacing:1.5px; color:${c.muted}; margin-top:32px; margin-bottom:8px; text-transform:uppercase;">Facility Operations Type</div>
      ${rows}
      ${isMobile() ? `<div style="height: max(32px, env(safe-area-inset-bottom, 32px));"></div>` : ""}
    `);

    d3.select("#sidebar-header-container")
      .append("button")
      .attr("id", "sidebar-back")
      .text(isMobile() ? "✕" : "CLOSE CENSUS DIVISION DETAILS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", isMobile() ? "18px" : "9px")
      .style("font-weight", isMobile() ? "400" : "600")
      .style("background", "transparent")
      .style("border", isMobile() ? "none" : `1px solid ${c.accent}`)
      .style("color", isMobile() ? c.muted : c.accent)
      .style("padding", isMobile() ? "0 4px" : "4px 9px")
      .style("border-radius", "4px")
      .style("cursor", "pointer")
      .style("white-space", "nowrap")
      .style("transition", "all 0.2s ease")
      .style("margin-top", "2px")
      .style("line-height", "1")
      .on("click", restoreMapAppearance)
      .on("mouseenter", function() { if (!isMobile()) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)"); })
      .on("mouseleave", function() { if (!isMobile()) d3.select(this).style("background", "transparent"); });

    document.getElementById("sidebar-back").addEventListener("click", restoreMapAppearance);
    [["mfg-toggle", "mfg-rows", "mfg-chevron"], ["tech-toggle", "tech-rows", "tech-chevron"], ["mro-toggle", "mro-rows", "mro-chevron"]].forEach(([toggleId, rowsId, chevronId]) => {
      const btn = document.getElementById(toggleId); if (!btn) return;
      const toggle = () => {
        const isOpen = document.getElementById(rowsId).style.display !== "none";
        document.getElementById(rowsId).style.display = isOpen ? "none" : "block";
        document.getElementById(chevronId).style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
        btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
      };
      btn.addEventListener("click", toggle);
      btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });

    if (!industryData.length) return;
    
    // ─── Generate Donut Chart Breakdown ───────────────────────────────────────
    const SIZE = 260; const RADIUS = SIZE / 2; const INNER = RADIUS * 0.55;
    const svgD = d3.select("#donut-chart").append("svg").attr("width", SIZE).attr("height", SIZE + 20).style("overflow", "visible");
    const g = svgD.append("g").attr("transform", `translate(${RADIUS},${RADIUS})`);
    
    const cVal = g.append("text").attr("text-anchor", "middle").attr("dy", "-0.15em").style("font-size", "22px").style("font-weight", "600").style("fill", c.text).style("font-family", "Inter");
    const cLab = g.append("text").attr("text-anchor", "middle").attr("dy", "1.1em").style("font-size", "9px").style("font-weight", "500").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter");

    const showDefault = () => { 
      cVal.text(activeLocalFacilities.length.toLocaleString()); 
      cLab.text(activeLocalFacilities.length === 1 ? "FACILITY" : "FACILITIES"); 
    };
    showDefault();

    g.selectAll("path").data(d3.pie().value(d => d.value).sort(null)(industryData)).join("path").attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)).attr("fill", d => INDUSTRY_COLOURS[d.data.label]).attr("stroke", c.bg).attr("stroke-width", 2).style("cursor", "pointer").style("transition", "d 0.15s ease")
      .on("mouseover", function(_, d) { d3.select(this).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS + 6)(d)); cVal.text(d.data.value); cLab.text(d.data.label.toUpperCase()); })
      .on("mouseout", function(_, d) { d3.select(this).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)(d)); showDefault(); });

    svgD.append("text").attr("transform", `translate(0, ${SIZE + 20})`).style("font-size", "11px").style("font-weight", "600").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter").text("DEFENCE INDUSTRIES SERVED");
    const legendG = svgD.append("g").attr("transform", `translate(0, ${SIZE + 36})`);
    const COLS = 2; const COL_W = SIZE / COLS;
    
    industryData.forEach((d, i) => {
      const x = (i % COLS) * COL_W; const y = Math.floor(i / COLS) * 20;
      const row = legendG.append("g").attr("transform", `translate(${x},${y})`);
      row.append("rect").attr("width", 8).attr("height", 8).attr("rx", 2).attr("fill", INDUSTRY_COLOURS[d.label]);
      row.append("text").attr("x", 12).attr("y", 8).style("font-size", "11px").style("fill", c.muted).style("font-family", "Inter").text(d.label);
    });
    
    svgD.attr("height", SIZE + 12 + Math.ceil(industryData.length / COLS) * 20);
  }

  // ─── Controls DOM: built ONCE, never torn down ───────────────────────────────
  let _controlsBuilt = false;

  function buildControlsDOM() {
    if (_controlsBuilt) return;
    _controlsBuilt = true;

    const c = getC();

    // Logo
    const logoContainer = controlsDiv.append("div")
      .style("margin-bottom", "14px")
      .style("display", "flex")
      .style("align-items", "center");

    const logoUrl = state.isDark
      ? "assets/Trillium_full_color_ondark.svg"
      : "assets/Trillium_full_color_onlight.svg";

    const logoLink = logoContainer.append("a")
      .attr("href", "https://trilliummfg.ca/")
      .attr("target", "_blank")
      .style("display", "inline-block")
      .style("cursor", "pointer");

    logoLink.append("img")
      .attr("id", "logo-img")
      .attr("src", logoUrl)
      .style("height", isMobile() ? "40px" : "70px")
      .style("width", "auto")
      .style("object-fit", "contain")
      .on("error", function() { d3.select(this).style("display", "none"); });

    controlsDiv.append("h2")
      .style("font-size", isMobile() ? "20px" : "26px")
      .style("font-weight", "600")
      .style("color", c.accent)
      .style("font-family", "'Inter', sans-serif")
      .style("margin-bottom", "10px")
      .text("Canada's Defence Manufacturing Industry");

    // ── Operations filters header ──
    const analyticsHeader = controlsDiv.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("align-items", "center")
      .style("margin-bottom", "10px");

    analyticsHeader.append("div")
      .text("OPERATIONS FILTERS")
      .style("font-size", "10px")
      .style("font-weight", "600")
      .style("letter-spacing", "1.5px")
      .style("color", c.muted);

    analyticsHeader.append("button")
      .attr("id", "reset-analytics-btn")
      .text("RESET OPERATIONS FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("background", "transparent")
      .style("padding", "4px 9px")
      .style("border-radius", "4px")
      .style("transition", "all 0.2s ease")
      .on("click", () => {
        state.currentAnalyticsKeys.clear();
        applyFilterAndCheckZoom();
      })
      .on("mouseenter", function() {
        if (state.currentAnalyticsKeys.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });

    // ── Operations chips ──
    const analyticsContainer = controlsDiv.append("div")
      .attr("id", "analytics-selector")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px")
      .style("margin-bottom", "20px");

    Object.entries(OPERATIONS_MAP).forEach(([key, label]) => {
      if (key === "General_Count_sum") return;
      analyticsContainer.append("button")
        .attr("data-ops-key", key)
        .attr("data-label", label)
        .attr("aria-pressed", "false")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", isMobile() ? "12px" : "10px")
        .style("font-weight", "500")
        .style("letter-spacing", "0.3px")
        .style("padding", isMobile() ? "8px 14px" : "5px 10px")
        .style("border-radius", "20px")
        .style("cursor", "pointer")
        .on("click", function() {
          const k = this.getAttribute("data-ops-key");
          if (state.currentAnalyticsKeys.has(k)) state.currentAnalyticsKeys.delete(k);
          else state.currentAnalyticsKeys.add(k);
          applyFilterAndCheckZoom();
        })
        .on("mouseenter", function() {
          const k = this.getAttribute("data-ops-key");
          if (!state.currentAnalyticsKeys.has(k)) d3.select(this).style("border", `1px solid ${getC().accent}`).style("color", getC().accent);
        })
        .on("mouseleave", function() {
          const k = this.getAttribute("data-ops-key");
          if (!state.currentAnalyticsKeys.has(k)) {
            const cc = getC();
            d3.select(this).style("border", `1px solid ${cc.border}`).style("color", cc.muted);
          }
        });
    });

    // ── Industry filters header ──
    const filterHeader = controlsDiv.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("align-items", "center")
      .style("margin-top", "20px")
      .style("margin-bottom", "10px");

    filterHeader.append("div")
      .text("INDUSTRY FILTERS")
      .style("font-size", "10px")
      .style("font-weight", "600")
      .style("letter-spacing", "1.5px")
      .style("color", c.muted);

    const modeToggleDiv = filterHeader.append("div")
      .attr("id", "mode-toggle")
      .style("display", "flex")
      .style("gap", "2px");

    ["and", "or"].forEach(mode => {
      modeToggleDiv.append("button")
        .attr("data-mode", mode)
        .text(mode.toUpperCase())
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", "9px")
        .style("font-weight", "600")
        .style("padding", "3px 7px")
        .style("border-radius", "3px")
        .style("cursor", "pointer")
        .style("letter-spacing", "0.5px")
        .style("transition", "all 0.15s ease")
        .on("click", function() {
          state.industryFilterMode = this.getAttribute("data-mode");
          applyFilterAndCheckZoom();
        });
    });

    filterHeader.append("button")
      .attr("id", "reset-industry-btn")
      .text("RESET INDUSTRY FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("background", "transparent")
      .style("padding", "4px 9px")
      .style("border-radius", "4px")
      .style("transition", "all 0.2s ease")
      .on("click", () => {
        state.currentIndustries.clear();
        applyFilterAndCheckZoom();
      })
      .on("mouseenter", function() {
        if (state.currentIndustries.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("text-decoration", "none").style("background", "transparent"); });


    const chipContainer = controlsDiv.append("div")
      .attr("id", "industry-selector")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px");

    Object.entries(INDUSTRY_KEYS).forEach(([key, label]) => {
      chipContainer.append("button")
        .attr("data-ind-key", key)
        .attr("data-label", label)
        .attr("aria-pressed", "false")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", isMobile() ? "12px" : "10px")
        .style("font-weight", "500")
        .style("letter-spacing", "0.3px")
        .style("padding", isMobile() ? "8px 14px" : "5px 10px")
        .style("border-radius", "20px")
        .style("cursor", "pointer")
        .on("click", function() {
          const k = this.getAttribute("data-ind-key");
          const cur = state.currentIndustries.get(k);
          if (!cur)                  state.currentIndustries.set(k, "include");
          else if (cur === "include") state.currentIndustries.set(k, "exclude");
          else                       state.currentIndustries.delete(k);
          applyFilterAndCheckZoom();
        })
        .on("mouseenter", function() {
          const k = this.getAttribute("data-ind-key");
          if (!state.currentIndustries.has(k)) {
            const cc = getC();
            d3.select(this).style("border", `1px solid ${cc.accent}`).style("color", cc.accent);
          }
        })
        .on("mouseleave", function() {
          const k = this.getAttribute("data-ind-key");
          if (!state.currentIndustries.has(k)) {
            const cc = getC();
            d3.select(this).style("border", `1px solid ${cc.border}`).style("color", cc.muted);
          }
        });
    });

    // ── Reset all ──
    const clearAllRow = controlsDiv.append("div")
      .style("display", "flex")
      .style("justify-content", "flex-end")
      .style("margin-top", isMobile() ? "14px" : "6px")
      .style("margin-bottom", "18px");

    clearAllRow.append("button")
      .attr("id", "reset-all-btn")
      .text("RESET ALL FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("background", "transparent")
      .style("padding", "4px 9px")
      .style("border-radius", "4px")
      .style("transition", "all 0.2s ease")
      .style("letter-spacing", "0.8px")
      .on("click", clearAllFilters)
      .on("mouseenter", function() {
        const either = state.currentAnalyticsKeys.size > 0 || state.currentIndustries.size > 0;
        if (either) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });

    // ── Info panel (built once) ──
    infoModal.html("");

    const infoHeader = infoModal.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("align-items", "center")
      .style("margin-bottom", "24px");

    infoHeader.append("div")
      .style("font-size", "10px")
      .style("font-weight", "600")
      .style("letter-spacing", "1.5px")
      .style("color", c.muted)
      .text("ABOUT THIS MAP");

    infoHeader.append("button")
      .text("✕")
      .style("background", "transparent")
      .style("border", `1px solid ${c.border}`)
      .style("color", c.muted)
      .style("cursor", "pointer")
      .style("font-size", "12px")
      .style("padding", "4px 8px")
      .style("border-radius", "4px")
      .style("font-family", "'Inter', sans-serif")
      .on("click", () => {
        state.infoOpen = false;
        infoSidebar.style("transform", "translateX(100%)");
      });

    infoModal.append("h3")
      .style("font-size", "20px")
      .style("font-weight", "600")
      .style("color", c.accent)
      .style("font-family", "'Inter', sans-serif")
      .style("margin-bottom", "14px")
      .text("Canadian Defence Map");

    infoModal.append("p")
      .style("font-size", "12px")
      .style("color", c.muted)
      .style("line-height", "1.6")
      .style("margin-bottom", "20px")
      .text("This map visualizes the geographic distribution of defence manufacturing and related facilities across Canada, aggregated by Census Division.");

    infoModal.append("div").style("font-size", "10px").style("font-weight", "600").style("letter-spacing", "1.5px").style("color", c.muted).style("margin-bottom", "10px").text("HOW TO USE");

    const tipsList = [
      "Tap/click a census division to view a broad-scale defence manufacturing industry overview.",
	  "Within a census division, facility operations types can be expanded by clicking on each row or by clicking on the ▼.",
      "Use the Operations Filters to narrow results by facility type.",
      'Use the Industry Filters to include ✓ or exclude ✕ specific defence industry sectors served. Industry Filters can be combined using "AND"/"OR" logic.',
	  "Browse the map using your mouse or touch-screen device, with the ability to pinch to zoom, scroll wheel to zoom, or by using the Zoom in (+) and Zoom out (-) buttons.",
	  "Click the Home icon (⌂) to instantly reset the map back to the default national view.",
      "Use the colour theme buttons in the legend to change the choropleth map palette.",
	  "Toggle between dark mode (☾) and light mode (☼) display themes using the display theme button.",
    ];

    tipsList.forEach(tip => {
      const row = infoModal.append("div").style("display", "flex").style("gap", "8px").style("margin-bottom", "10px").style("align-items", "flex-start");
      row.append("span").style("color", c.accent).style("font-size", "10px").style("margin-top", "2px").text("▸");
      row.append("span").style("font-size", "12px").style("color", c.muted).style("line-height", "1.5").text(tip);
    });

    infoModal.append("div").style("margin-top", "24px").style("font-size", "10px").style("font-weight", "600").style("letter-spacing", "1.5px").style("color", c.muted).style("margin-bottom", "8px").text("DATA SOURCES");

    infoModal.append("p")
      .style("font-size", "12px")
      .style("color", c.muted)
      .style("line-height", "1.6")
      .text("Facility-level data was collected as part of a national defence facility identification project, and has been aggregated here at the Census Division level. Geographic data is based on the Statistics Canada Census Subdivision Boundary File. For more detailed data descriptions, download links, and code availability, please ")
      .append("a")
        .attr("href", "https://github.com/riley-kemp/Defence-Map")
        .attr("target", "_blank")
        .style("color", c.accent)
        .style("text-decoration", "underline")
        .text("click here.");
		
	infoModal.append("p")
	  .style("font-size", "12px")
      .style("color", c.muted)
      .style("line-height", "1.6")
      .text("For more information about the Trillium Network for Advanced Manufacturing, please visit ")
	  .append("a")
		.attr("href", "https://trilliummfg.ca/")
        .attr("target", "_blank")
        .style("color", c.accent)
        .style("text-decoration", "underline")
        .text("our website.");
  }

  // ─── Refresh chip/button styles in-place (no DOM rebuild) ────────────────────
  function refreshControlsState() {
    const c = getC();

    // Sync logo src with current theme
    const logoImg = document.getElementById("logo-img");
    if (logoImg) {
      logoImg.src = state.isDark
        ? "assets/Trillium_full_color_ondark.svg"
        : "assets/Trillium_full_color_onlight.svg";
    }
    const operationsActive = state.currentAnalyticsKeys.size > 0;
    const industriesActive = state.currentIndustries.size > 0;
    const bothActive       = operationsActive && industriesActive;

    // Reset operations button
    const rab = d3.select("#reset-analytics-btn");
    rab.style("border",         operationsActive ? `1px solid ${c.accent}` : `1px solid ${c.border}`)
       .style("color",          operationsActive ? c.accent : c.muted)
       .style("cursor",         operationsActive ? "pointer" : "default")
       .style("opacity",        operationsActive ? "1" : "0.3")
       .style("pointer-events", operationsActive ? "auto" : "none");

    // Operations chips
    d3.selectAll("[data-ops-key]").each(function() {
      const key = this.getAttribute("data-ops-key");
      const label = this.getAttribute("data-label");
      const sel = state.currentAnalyticsKeys.has(key);
      d3.select(this)
        .text(sel ? `✓ ${label}` : label)
        .attr("aria-pressed", sel ? "true" : "false")
        .style("background", sel ? (state.isDark ? "rgba(78,204,163,0.2)" : "rgba(0,169,79,0.15)") : (state.isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"))
        .style("color",      sel ? c.accent : c.muted)
        .style("border",     sel ? `1px solid ${c.accent}` : `1px solid ${c.border}`);
    });

    // AND/OR mode toggle
    const hasIncludes = [...state.currentIndustries.values()].some(s => s === "include");
    d3.select("#mode-toggle")
      .style("opacity",        hasIncludes ? "1" : "0.3")
      .style("pointer-events", hasIncludes ? "auto" : "none");
    d3.selectAll("[data-mode]").each(function() {
      const mode = this.getAttribute("data-mode");
      const active = state.industryFilterMode === mode;
      d3.select(this)
        .style("background", active ? c.accent : "transparent")
        .style("color",      active ? (state.isDark ? "#0e1117" : "#ffffff") : c.muted)
        .style("border",     active ? `1px solid ${c.accent}` : `1px solid ${c.border}`);
    });

    // Reset industry button
    const rib = d3.select("#reset-industry-btn");
    rib.style("border",         industriesActive ? `1px solid ${c.accent}` : `1px solid ${c.border}`)
       .style("color",          industriesActive ? c.accent : c.muted)
       .style("cursor",         industriesActive ? "pointer" : "default")
       .style("opacity",        industriesActive ? "1" : "0.3")
       .style("pointer-events", industriesActive ? "auto" : "none");

    // Industry chips
    d3.selectAll("[data-ind-key]").each(function() {
      const key    = this.getAttribute("data-ind-key");
      const label  = this.getAttribute("data-label");
      const status = state.currentIndustries.get(key);
      let bg, color, border, prefix;
      if (status === "include") {
        bg = state.isDark ? "rgba(78,204,163,0.2)" : "rgba(0,169,79,0.15)";
        color = c.accent;
        border = `1px solid ${c.accent}`;
        prefix = "✓ ";
      } else if (status === "exclude") {
        bg = state.isDark ? "rgba(239,68,68,0.2)" : "rgba(239,68,68,0.15)";
        color = state.isDark ? "#fca5a5" : "#dc2626";
        border = state.isDark ? "1px solid #ef4444" : "1px solid #dc2626";
        prefix = "✕ ";
      } else {
        bg = state.isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)";
        color = c.muted;
        border = `1px solid ${c.border}`;
        prefix = "";
      }
      d3.select(this).text(`${prefix}${label}`).attr("aria-pressed", status === "include" || status === "exclude" ? "true" : "false").style("background", bg).style("color", color).style("border", border);
    });

    // Reset all button
    const rall = d3.select("#reset-all-btn");
    rall.style("border",         `1px solid ${bothActive ? c.accent : c.border}`)
        .style("color",          bothActive ? c.accent : c.muted)
        .style("cursor",         bothActive ? "pointer" : "default")
        .style("opacity",        bothActive ? "1" : "0.35")
        .style("pointer-events", bothActive ? "auto" : "none");

    d3.select("#industry-selector").style("opacity", "1").style("pointer-events", "auto");
  }

  function updateUI() {
    invalidateColourCache();
    const c = getC();
    container.style("background", c.bg).style("color", c.text);

    if (isMobile()) {
      sidebar
        .style("background", c.surface)
        .style("border-top", `1px solid ${c.border}`)
        .style("border-right", "none");
      d3.select("#mobile-sheet-handle").style("background", c.muted);
      const pillEl = d3.select("#mobile-filter-toggle");
      if (state.sidebarOpen) {
        pillEl.style("display", "none");
      } else {
        pillEl
          .style("display", null)
          .style("background", c.accent)
          .style("color", "#fff")
          .style("border", `1px solid ${c.accent}`);
      }
    } else {
      sidebar.style("background", c.surface).style("border-right", `1px solid ${c.border}`);
      collapseBtn.style("background", c.surface).style("color", c.accent).style("border", `1px solid ${c.border}`);
    }

    infoSidebar.style("background", c.surface).style("border-left", `1px solid ${c.border}`);
    themeToggle.text(state.isDark ? "☼" : "☾");
    legendOverlay.style("background", state.isDark ? "rgba(22,27,36,0.8)" : "rgba(255,255,255,0.9)").style("border", `1px solid ${c.border}`);
    tooltip.style("background", c.surface).style("color", c.text).style("border", `1px solid ${c.border}`).style("box-shadow", state.isDark ? "0 10px 30px rgba(0,0,0,0.5)" : "0 10px 30px rgba(0,0,0,0.1)");

    [themeToggle, zoomInBtn, zoomOutBtn, homeBtn, infoBtn].forEach(btn => {
      btn
        .style("background", c.surface)
        .style("color",      c.text)
        .style("border",     `1px solid ${c.border}`)
        .on("mouseenter", function() { d3.select(this).style("border", `1px solid ${c.accent}`).style("transform", "scale(1.08)"); })
        .on("mouseleave", function() { d3.select(this).style("border", `1px solid ${c.border}`).style("transform", "scale(1)"); });
    });

    buildControlsDOM();
    refreshControlsState();

    updateSidebarDetail();
    updateSidebarToggle();
  }

  function clearAllFilters() {
    state.currentAnalyticsKeys.clear();
    state.currentIndustries.clear();
    state.industryFilterMode = "and";
    renderMap();
    refreshControlsState();
    if (state.selectedFeature) updateSidebarDetail();
  }
  
  function applyFilterAndCheckZoom() {
    renderMap();
    refreshControlsState();
    // Re-render the detail panel so donut and accordion rows reflect updated filters.
    if (state.selectedFeature) updateSidebarDetail();
  }

  // Restores map opacity/stroke WITHOUT zooming out.
  // Used by the ✕ / "Close Census Division Details" button.
  function restoreMapAppearance() {
    const c = getC();
    const wasSelected = !!state.selectedFeature;
    state.selectedFeature = null;
    d3.select("#legend-marker").style("display", "none");
    d3.select("#analytics-selector").property("disabled", false).style("opacity", "1").style("cursor", "pointer");
    d3.select("#industry-selector").style("pointer-events", "auto").style("opacity", "1");
    mapGroup.selectAll("path.cd-region")
      .transition().duration(750)
      .style("opacity", 1)
      .attr("stroke", c.bg)
      .attr("stroke-width", 0.5);
    // Only close the mobile bottom sheet when actually deselecting a region
    if (isMobile() && wasSelected) {
      state.sidebarOpen = false;
      updateSidebarToggle();
    }
    updateSidebarDetail();
  }

  function resetView() {
    restoreMapAppearance();
    zoomToFull();
  }

  // ─── Resize handler: re-init layout on orientation change ─────────────────
  let _lastMobile = isMobile();
  window.addEventListener("resize", () => {
    const nowMobile = isMobile();
    if (nowMobile !== _lastMobile) {
      _lastMobile = nowMobile;
      // Tear down controls so they rebuild with correct mobile/desktop sizing
      controlsDiv.selectAll("*").remove();
      _controlsBuilt = false;
      updateUI();
      renderMap();
    }
  });

  // ─── Application Bootstrap Initialization ─────────────────────────────────
  // Global Escape key: deselect the active region without zooming out
  window.addEventListener("keydown", (event) => {
    if ((event.key === "Escape" || event.key === "Esc") && state.selectedFeature) {
      resetView();
    }
  });

  updateUI();
  renderMap();
  
})(); // Execute IIFE Immediately