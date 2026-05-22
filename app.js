
// ════════════════════════════════════════════════════════════════════════════
//  CANADA DEFENCE MAP — app.js
//  This file builds and runs an interactive map showing where defence
//  manufacturing facilities are located across Canada, broken down by
//  Census Division (a geographic unit slightly larger than a county).
// ════════════════════════════════════════════════════════════════════════════

(async function() {

  // ─── SECTION 1: DATA FETCHING ─────────────────────────────────────────────

  // Downloads the GeoJSON file that contains the shape of every Census Division
  async function fetchGeoData() {
    const url = "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/data/Canada_CD.geojson";
    const response = await fetch(url);
    // If the download fails, throw a descriptive error rather than silently continuing
    if (!response.ok) throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
    return response.json();
  }

  // Downloads the CSV file listing individual defence facilities.
  async function fetchCsvData() {
    const url = "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/data/defence_facilities.csv";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch CSV: ${response.statusText}`);
    
    // d3.csvParse converts the raw CSV text into an array of plain JS objects —
    // one object per row, with column headers as keys.
    const rawText = await response.text();
    return d3.csvParse(rawText);
  }

  // Fetch both files at the same time (in parallel) to save loading time.
  // If either download fails, show an error message in the map container and stop.
  let rawGeo, rawCsv;
  try {
    [rawGeo, rawCsv] = await Promise.all([fetchGeoData(), fetchCsvData()]);
  } catch (error) {
    console.error("Error initializing map data:", error);
    document.getElementById("map-container").innerHTML = `<p style="padding:20px; color:red;">Error loading map datasets. Check browser console for details.</p>`;
    return;
  }

  // ─── SECTION 2: CONSTANTS ─────────────────────────────────────────────────
  //  Fixed values used throughout the application.

  // The internal coordinate space the SVG map is drawn in.
  const WIDTH = 1200;
  const HEIGHT = 800;

  // How wide the left-hand filter/detail sidebar is on desktop.
  const SIDEBAR_WIDTH = 400; // in pixels

  // Maps internal CSV column keys to human-readable display labels.
  // Used to name filter chips and stats rows in the sidebar.
  const OPERATIONS_MAP = {
    "Manufacturing_sum":  "Manufacturers",
    "Value-Add/Tech_sum": "Technology Development & Other Related Facilities",
    "MRO/ISS_sum":        "Maintenance, Repair, Overhaul/In-Service Support Facilities",
  };

  // Maps short CSV column codes to full industry names.
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

  // ─── SECTION 3: FACILITY DATA PROCESSING ─────────────────────────────────
  //  Convert each raw CSV row into a clean, structured facility object
  //  that the rest of the code can work with easily.

  // Helper: returns true if a CSV cell should be treated as "yes/true".
  // Converts boolean csv values.
  const isTrue = (val) => val && (val.toString().toLowerCase() === "true" || val.toString() === "1");

  // Transform every row in the CSV into a structured facility object.
  // Each object stores:
  //   - id        : a unique index number
  //   - cduid     : the Census Division ID — links this facility to a map region
  //   - isMfg     : is this a defence manufacturing facility
  //   - isTech    : is this a value-add / defence technology facility
  //   - isMro     : is this a defence maintenance, repair, and overhaul facility
  //   - isDefence : is this a general facility count
  //   - industries: the set of defence industry sectors it belongs to
  //   - rawRow    : the original CSV row (kept for sub-category drill-downs)
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

    // Check each industry column and add it to the facility's industry set
    Object.keys(INDUSTRY_KEYS).forEach(ind => {
      if (isTrue(row[ind])) facility.industries.add(ind);
    });
    return facility;
  });

  // ─── SECTION 4: GeoJSON WINDING FIX ──────────────────────────────────────
  //  Geographic polygon coordinates must follow a specific winding order
  //  (the direction vertices are listed — clockwise vs counter-clockwise)
  //  for D3 to fill them correctly. This function reverses the order of
  //  each ring's coordinates to match D3's expectations.
  //  We do a targeted coordinate-only copy (not a full deep-clone) to keep
  //  this cheap on large GeoJSON files.
  function fixWinding(feature) {
    const { type, coordinates } = feature.geometry ?? {};
    let newCoords;
    if (type === "Polygon") {
      newCoords = coordinates.map(r => r.slice().reverse());
    } else if (type === "MultiPolygon") {
      newCoords = coordinates.map(p => p.map(r => r.slice().reverse()));
    } else {
      return feature; // Nothing to fix for other geometry types
    }
    return {
      ...feature,
      geometry: { ...feature.geometry, coordinates: newCoords }
    };
  }

  // Apply the winding fix to every region in the GeoJSON dataset.
  const fixedData = { ...rawGeo, features: rawGeo.features.map(fixWinding) };

  // Pre-compute the CDUID string for every feature once at load time.
  // getFilteredValue, hasAnyData, and updateSidebarDetail previously repeated
  // this three-way property lookup + toString().trim() on every call.
  // Storing it as f._cduid eliminates hundreds of redundant lookups per render.
  fixedData.features.forEach(f => {
    f._cduid = (f.properties.CDUID || f.properties.cduid || f.properties.CD_UID)?.toString().trim() ?? "";
  });

  // ─── SECTION 5: APPLICATION STATE ────────────────────────────────────────
  //  A single `state` object holds everything that can change while the user
  //  interacts with the map. Centralising it here makes it easy to reason
  //  about what is currently active.
  const state = {
    currentAnalyticsKeys: new Set(),   // Which "Operations" filter chips are toggled on
    currentIndustries: new Map(),      // Which industry chips are active and their mode ("include" / "exclude")
    industryFilterMode: "and",         // Whether "include" chips require ALL ("and") or ANY ("or") matches
    currentTheme: "Classic",           // Which colour theme is applied to the choropleth
    isDark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false, // Respects the user's OS dark mode preference
    selectedFeature: null,             // The GeoJSON feature (Census Division) that is currently clicked/highlighted
    hoveredFeature: null,              // The GeoJSON feature currently under the mouse cursor (desktop)
    infoOpen: false,                   // Whether the "About this map" info panel is visible
    sidebarOpen: true,                 // Whether the left filter & census division information sidebar is expanded
    legendMin: 0,                      // Lowest facility count currently shown in the legend
    legendMax: 1,                      // Highest facility count currently shown in the legend
    legendColourScale: null,           // The D3 colour-scale function currently in use
  };

  // ─── SECTION 6: HELPER UTILITIES ─────────────────────────────────────────

  // Returns the human-readable label for a given OPERATIONS_MAP key.
  const getLabel = (key) => OPERATIONS_MAP[key] ?? key;

  // Colour palette caching:
  // Computing the colour palette on every render is wasteful.
  // We cache the result and only recompute it when the dark/light mode changes.
  let _cachedColours = null;
  function getC() {
    if (!_cachedColours) _cachedColours = getColours(state.isDark);
    return _cachedColours;
  }
  // Call this whenever dark mode is toggled to force a fresh palette on next render.
  function invalidateColourCache() { _cachedColours = null; }

  // Pre-built set of all CDUIDs that have at least one defence facility.
  // hasAnyData() never changes so we compute it once at startup rather than
  // scanning allFacilities on every render pass.
  const _cduidsWithData = new Set(
    allFacilities.filter(f => f.isDefence).map(f => f.cduid)
  );
  function hasAnyData(feature) {
    return _cduidsWithData.has(feature._cduid);
  }

  // Cache of cduid → filtered facility count, invalidated on every filter/render change.
  // Avoids re-scanning allFacilities for every region multiple times per render.
  let _filteredValueCache = null;
  function invalidateFilteredValueCache() { _filteredValueCache = null; }

  // Returns how many facilities in a given region pass ALL currently active filters.
  // This number determines the colour intensity of the region on the map.
  // ── Shared filter predicate ──────────────────────────────────────────────
  // Returns true if a facility passes all currently active Operations and
  // Industry filters. Used by both getFilteredValue (cache builder) and
  // updateSidebarDetail — previously the same logic was duplicated in both.
  //
  // Call buildFilterPredicate() once per render/filter-change to capture the
  // current filter state, then pass the returned function to per-facility loops.
  function buildFilterPredicate() {
    const analyticsActive  = state.currentAnalyticsKeys.size > 0;
    const industriesActive = state.currentIndustries.size > 0;
    const includes = industriesActive
      ? [...state.currentIndustries.entries()].filter(([, s]) => s === "include").map(([ind]) => ind)
      : [];
    const excludes = industriesActive
      ? [...state.currentIndustries.entries()].filter(([, s]) => s === "exclude").map(([ind]) => ind)
      : [];
    const mode = state.industryFilterMode;

    return function facilityPassesFilters(f) {
      if (!f.isDefence) return false;

      if (analyticsActive) {
        const ok = (state.currentAnalyticsKeys.has("Manufacturing_sum") && f.isMfg)
                || (state.currentAnalyticsKeys.has("Value-Add/Tech_sum") && f.isTech)
                || (state.currentAnalyticsKeys.has("MRO/ISS_sum")        && f.isMro);
        if (!ok) return false;
      }

      if (industriesActive) {
        if (excludes.some(ind => f.industries.has(ind))) return false;
        if (includes.length > 0) {
          const passes = mode === "and"
            ? includes.every(ind => f.industries.has(ind))
            : includes.some(ind => f.industries.has(ind));
          if (!passes) return false;
        }
      }

      return true;
    };
  }

  function getFilteredValue(feature) {
    // Build the cache on first call within a render pass
    if (!_filteredValueCache) {
      const passes = buildFilterPredicate();
      _filteredValueCache = new Map();
      for (const f of allFacilities) {
        if (!passes(f)) continue;
        _filteredValueCache.set(f.cduid, (_filteredValueCache.get(f.cduid) ?? 0) + 1);
      }
    }

    const geoId = feature._cduid;
    return _filteredValueCache.get(geoId) ?? 0;
  }

  // Builds the text shown in the hover tooltip over a region on the map.
  // Adds a note when filters are active so the user knows the count is filtered.
  function getTooltipLabel(val) {
    const filtersActive = state.currentIndustries.size > 0 || state.currentAnalyticsKeys.size > 0;
    if (filtersActive) {
      return `${val.toLocaleString()} ${val === 1 ? "Facility" : "Facilities"} (matching currently active filters)`;
    }
    return `${val.toLocaleString()} ${val === 1 ? "Facility" : "Facilities"}`;
  }

  // Attaches a tap-safe click handler to a D3 selection.
  // On mobile, touchend fires first and we call preventDefault() to stop the
  // browser generating a synthetic click ~300ms later — preventing every button
  // from firing twice per tap. On desktop the normal click handler is used.
  function onTap(selection, fn) {
    return selection
      .on("touchend", function(event) {
        event.preventDefault();
        fn.call(this, event);
      })
      .on("click", function(event) {
        // Ignore clicks on touch devices — already handled by touchend above.
        if (event.pointerType === "touch") return;
        fn.call(this, event);
      });
  }

  // Returns the full set of UI colours for the current dark/light mode.
  // Called via getC() rather than directly (see caching above).
  function getColours(isDark) {
    return isDark
      ? {// dark mode
          bg:          "#0e1117",             // Page background
          surface:     "#161b24",             // Card / sidebar background
          border:      "rgba(255,255,255,0.1)", // Subtle dividing lines
          text:        "#e8eaf0",             // Main body text
          muted:       "#6b7280",             // Secondary / label text
          accent:      "#00a94f",             // Primary green highlight
          accent2:     "#f0a500",             // Selected region border colour
          noData:      "#2a3040",             // Region with facilities, but none match the filter
          noDataNone:  "#191d25"              // Region with zero defence facilities recorded
        }
      : {// light mode
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

  // ─── SECTION 7: MOBILE DETECTION ─────────────────────────────────────────
  // Returns true when the viewport is 768px wide or narrower.
  // Used throughout to switch between mobile (bottom sheet) and desktop (sidebar) layouts.
  const isMobile = () => Math.min(window.innerWidth, window.innerHeight) <= 768;
  const isLandscapeMobile = () => isMobile() && window.innerWidth > window.innerHeight;

  // ─── SECTION 8: DOM & LAYOUT SETUP ───────────────────────────────────────
  //  Builds the HTML structure of the whole application dynamically using D3.
  //  Nothing comes from the HTML file except the #map-container <div>.

  // Load the Inter and DM Sans fonts from Google Fonts
  const styleLink = Object.assign(document.createElement("link"), {
    rel:  "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=DM+Sans:wght@300;400;500&display=swap",
  });
  document.head.appendChild(styleLink);

  // Inject CSS for button tooltips (the small labels that appear when hovering
  // over the zoom/theme/home buttons). Also defines the mobile bottom-sheet
  // handle and the floating "FILTERS" pill button for mobile.
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
    #mobile-sheet-handle-wrap {
      flex-shrink: 0;
      background: inherit;
      padding: 16px 18px 14px;
    }
    #mobile-sheet-handle {
      width: 36px; height: 4px; border-radius: 2px;
      margin: 0 auto;
    }
    #mobile-filter-toggle {
      position: absolute;
      bottom: max(16px, env(safe-area-inset-bottom, 16px));
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

    /* ── Accessibility: visible focus indicators ── */
    path.cd-region:focus,
    path.cd-region:focus-visible {
      outline: none;
    }
    button:focus-visible {
      outline: 3px solid #00a94f;
      outline-offset: 2px;
    }

    /* ── Screen-reader-only utility ── */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0,0,0,0);
      white-space: nowrap;
      border: 0;
    }
  `;
  document.head.appendChild(btnTooltipStyle);

  // ── Accessibility: live region for screen-reader filter announcements ──
  // Updated whenever filters change so screen readers announce the new state.
  const a11yAnnouncer = document.createElement("div");
  a11yAnnouncer.id = "a11y-announcer";
  a11yAnnouncer.className = "sr-only";
  a11yAnnouncer.setAttribute("aria-live", "polite");
  a11yAnnouncer.setAttribute("aria-atomic", "true");
  document.body.appendChild(a11yAnnouncer);

  function announceFilterUpdate() {
    const min = state.legendMin;
    const max = state.legendMax;
    const filtersActive = state.currentIndustries.size > 0 || state.currentAnalyticsKeys.size > 0;
    const msg = filtersActive
      ? `Filtered view updated. The legend now ranges from ${min} to ${max} facilities.`
      : `Filters cleared. The legend now ranges from ${min} to ${max} facilities.`;
    a11yAnnouncer.textContent = "";
    // Small timeout lets the DOM settle so the mutation is picked up by screen readers
    setTimeout(() => { a11yAnnouncer.textContent = msg; }, 50);
  }

  // Wraps a button element in a <div> and appends a hidden tooltip <span>.
  // The tooltip becomes visible on hover via the CSS above.
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

  // Attach D3 to the existing #map-container div from index.html.
  // This becomes the outermost wrapper for the whole application.
	const container = d3.select("#map-container")
	  .style("display", "flex")
	  .style("font-family", "'Inter', sans-serif")
	  .style("width", "100%")
	  .style("height", "100%")
	  .style("overflow", "hidden")
	  .style("position", "relative")
	  .style("transition", "background 0.3s ease");

  // The control panel is a floating column of icon buttons pinned to the
  // top-right corner of the map (info, theme toggle, zoom in/out, home).
  const controlPanel = container.append("div")
    .attr("id", "control-panel")
    .style("position", "absolute")
    .style("top", "max(12px, env(safe-area-inset-top, 12px))")
    .style("right", "max(12px, env(safe-area-inset-right, 12px))")
    .style("z-index", "100")
    .style("display", "grid")
    .style("grid-template-columns", isLandscapeMobile() ? "1fr 1fr" : "1fr")
    .style("gap", "6px");

  // Button dimensions adjust slightly larger on mobile for easier touch targets
  const btnSize   = isMobile() ? "44px" : "40px";
  const btnPad    = isMobile() ? "10px 14px" : "8px 12px";
  const btnFontSz = isMobile() ? "16px" : "14px";

  // Briefly flashes a button with the accent colour so the user gets tactile
  // feedback that their tap/click registered.
  // flashBtn: immediately paints the button accent, then restores after 220 ms.
  // Pass skipRestore=true when the caller's updateUI/renderMap will repaint the
  // button — otherwise the setTimeout would restore stale pre-theme-flip colours.
  function flashBtn(btn, skipRestore = false) {
    const c = getC();
    btn.style("background", c.accent).style("color", "#fff").style("border", `1px solid ${c.accent}`);
    if (!skipRestore) {
      setTimeout(() => {
        // Re-read colours at restore time so we always use the current theme
        const cr = getC();
        btn.style("background", cr.surface).style("color", cr.text).style("border", `1px solid ${cr.border}`);
      }, 220);
    }
  }

  // Helper: creates a styled control button and appends it to the panel
  function makeBtn(label, ariaLabel) {
    return controlPanel.append("button")
      .text(label)
      .attr("aria-label", ariaLabel)
      .style("padding", btnPad)
      .style("border-radius", "8px")
      .style("cursor", "pointer")
      .style("font-size", btnFontSz)
      .style("width", btnSize)
      .style("height", btnSize)
      .style("transition", "background 0.15s ease, color 0.15s ease, border 0.15s ease, transform 0.2s ease");
  }

  // ── Individual control buttons ──

  // "ⓘ" — opens/closes the "About this map" info panel
  const infoBtn = makeBtn("ⓘ", "About this map");
  onTap(infoBtn, function() {
    flashBtn(d3.select(this));
    state.infoOpen = !state.infoOpen;
    infoSidebar.style("transform", state.infoOpen ? "translateX(0)" : "translateX(100%)");
  });

  // "☾" / "☼" — toggles between dark mode and light mode
  const themeToggle = makeBtn("☾", "Toggle light / dark mode");
  onTap(themeToggle, function() {
    flashBtn(d3.select(this), true);
    state.isDark = !state.isDark;
    updateUI();
    renderMap();
  });

  // "⌂" — resets map to the full-Canada view
  const homeBtn = makeBtn("⌂", "Reset map view");
  onTap(homeBtn, function() {
    flashBtn(d3.select(this));
    if (isMobile()) { state.sidebarOpen = false; updateSidebarToggle(); }
    if (state.selectedFeature) resetView(); else zoomToFull();
  });

  // "↩" — clears all active filters (Operations + Industry)
  const resetFiltersBtn = makeBtn("↩", "Reset all filters");
  onTap(resetFiltersBtn, function() {
    flashBtn(d3.select(this));
    clearAllFilters();
  });

  // "+" / "−" — zoom buttons; hidden on mobile (users pinch-to-zoom instead)
  const zoomInBtn  = makeBtn("+", "Zoom in")
    .style("display", isMobile() ? "none" : null)
    .style("font-weight", "600")
    .on("click", function() {
      flashBtn(d3.select(this));
      svg.transition().duration(350).call(zoom.scaleBy, 1.5);
    });
  const zoomOutBtn = makeBtn("−", "Zoom out")
    .style("display", isMobile() ? "none" : null)
    .style("font-weight", "600")
    .on("click", function() {
      flashBtn(d3.select(this));
      svg.transition().duration(350).call(zoom.scaleBy, 0.67);
    });

  // Attach tooltip labels to each button (visible on hover on desktop)
  addBtnTooltip(infoBtn,         "About This Map");
  addBtnTooltip(themeToggle,     "Toggle Light / Dark Mode");
  addBtnTooltip(homeBtn,         "Reset View");
  addBtnTooltip(resetFiltersBtn, "Reset All Filters");
  addBtnTooltip(zoomInBtn,       "Zoom In");
  addBtnTooltip(zoomOutBtn,      "Zoom Out");

  // The main layout wrapper sits the sidebar and map canvas side-by-side on desktop.
  const mainWrapper = container.append("div")
    .style("display", "flex")
    .style("width", "100%")
    .style("height", "100%")
    .style("position", "relative");

  // The sidebar holds the filter controls (left panel on desktop)
  // or slides up from the bottom as a "sheet" on mobile.
  const sidebar = mainWrapper.append("div")
    .style("box-sizing", "border-box")
    .style("overflow-y", "auto")
    .style("z-index", "10")
    .style("position", isMobile() ? "absolute" : "relative");

  if (isMobile()) {
    // On mobile: full-width panel anchored to the bottom of the screen,
    // initially hidden below the viewport (translateY(100%)).
    sidebar
      .style("width", "100%")
      .style("height", "60vh")
      .style("bottom", "0")
      .style("left", "0")
      .style("padding", "0")
      .style("overflow", "hidden")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("border-radius", "16px 16px 0 0")
      .style("box-shadow", "0 -4px 24px rgba(0,0,0,0.18)")
      .style("transform", "translateY(100%)")
      .style("transition", "transform 0.4s ease, background 0.3s ease, border 0.3s ease");
  } else {
    // On desktop: fixed-width panel on the left edge.
    sidebar
      .style("width", `${SIDEBAR_WIDTH}px`)
      .style("height", "100%")
      .style("padding", "30px 24px")
      .style("transition", "width 0.4s ease, padding 0.4s ease");
  }

  // Inner wrapper inside the sidebar — makes it easy to hide/show all contents
  // at once when collapsing the sidebar without altering each child element.
  const sidebarInnerContent = sidebar.append("div")
    .style("width", "100%")
    .style("height", isMobile() ? null : "100%")
    .style("flex", isMobile() ? "1 1 auto" : null)
    .style("overflow-y", isMobile() ? "auto" : null)
    .style("padding",    isMobile() ? "0 18px 18px" : null)
    .style("box-sizing", "border-box");

  // The collapse/expand control differs between mobile and desktop:
  //  • Mobile:  a drag handle bar at the top of the bottom sheet
  //  • Desktop: a small circular ◀/▶ button at the edge of the sidebar
  let collapseBtn;

  if (isMobile()) {
    // Touch-draggable handle bar at the top of the mobile bottom sheet.
    // A short swipe up opens it; a short swipe down closes it.
    // A very small movement (< 8px) is treated as a tap and toggles the state.
    // handleWrap sits directly inside sidebarInnerContent as its first child,
    // with position:sticky top:0 so it pins to the top of the scroll area —
    // always visible above the logo/content regardless of scroll position.
    const handleWrap = sidebar.insert("div", ":first-child")
      .attr("id", "mobile-sheet-handle-wrap")
      .style("cursor", "grab")
      .style("touch-action", "none")
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("position", "relative");

    // Centred drag pill
    const handle = handleWrap.append("div")
      .attr("id", "mobile-sheet-handle")
      .style("background", "rgba(128,128,128,0.35)");

    // ✕ close button — pinned to the right of the handle row, inline with drag pill
    handleWrap.append("button")
      .attr("id", "mobile-sheet-close-btn")
      .text("✕")
      .style("position", "absolute")
      .style("right", "18px")
      .style("top", "50%")
      .style("transform", "translateY(-50%)")
      .style("background", "transparent")
      .style("border", "none")
      .style("font-size", "18px")
      .style("line-height", "1")
      .style("padding", "4px 6px")
      .style("cursor", "pointer")
      .style("color", "inherit")
      .style("touch-action", "auto")
      .on("touchstart", event => event.stopPropagation(), { passive: true })
      .on("click", () => {
        if (state.selectedFeature) {
          restoreMapAppearance();
        } else {
          state.sidebarOpen = false;
          updateSidebarToggle();
        }
      });

    let dragStartY  = null;
    let dragStartH  = null;
    let _userSetHeight = null; // last height user dragged to; null = use default

    const CLOSE_RATIO     = 0.35;
    const DEFAULT_H_RATIO = 0.65;

    function getMaxSheetH() {
      const panel = document.getElementById("control-panel");
      return panel
        ? window.innerHeight - (panel.getBoundingClientRect().bottom + 16)
        : window.innerHeight * 0.85;
    }

    // Attach drag to the whole handleWrap for a generous ~26px touch target
    handleWrap.on("touchstart", function(event) {
      dragStartY = event.touches[0].clientY;
      dragStartH = sidebar.node().getBoundingClientRect().height;
      sidebar.style("transition", "background 0.3s ease, border 0.3s ease");
      event.preventDefault();
    }, { passive: false });

    handleWrap.on("touchmove", function(event) {
      if (dragStartY === null) return;
      const dy   = event.touches[0].clientY - dragStartY;
      const newH = Math.min(Math.max(dragStartH - dy, 40), getMaxSheetH());
      sidebar.style("height", newH + "px");
      event.preventDefault();
    }, { passive: false });

    handleWrap.on("touchend", function(event) {
      if (dragStartY === null) return;
      const dy   = event.changedTouches[0].clientY - dragStartY;
      const curH = sidebar.node().getBoundingClientRect().height;
      const scrH = window.innerHeight;
      sidebar.style("transition", "transform 0.35s ease, height 0.35s ease, background 0.3s ease, border 0.3s ease");
      if (curH < scrH * CLOSE_RATIO) {
        // Below threshold: forget user height, reset to default, close
        _userSetHeight = null;
        sidebar.style("height", (scrH * DEFAULT_H_RATIO) + "px");
        state.sidebarOpen = false;
        // Sliding the sheet down deselects the census division (same as pressing ✕)
        if (state.selectedFeature) restoreMapAppearance();
      } else {
        // User settled at custom height — remember it
        _userSetHeight = curH;
        state.sidebarOpen = true;
      }
      dragStartY = null;
      dragStartH = null;
      updateSidebarToggle();
    });

    // Floating "▲ FILTERS" pill button at the bottom of the map.
    // Only visible when the bottom sheet is closed, giving users a clear way
    // to reopen it.
    collapseBtn = container.append("button")
      .attr("id", "mobile-filter-toggle")
      .text("▲  FILTERS");
    onTap(collapseBtn, () => {
      state.sidebarOpen = !state.sidebarOpen;
      updateSidebarToggle();
    });
  } else {
    // Desktop: small circular button positioned at the right edge of the sidebar.
    // Shows ◀ when open (click to collapse) and ▶ when closed (click to expand).
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

  // Two content sections inside the sidebar:
  //   controlsDiv — the filter chips and heading (always visible)
  //   detailsDiv  — the census division detail panel (shown after clicking a region)
  const controlsDiv = sidebarInnerContent.append("div").style("margin-bottom", "40px");
  const detailsDiv  = sidebarInnerContent.append("div");



  // The "About" info panel — slides in from the right edge of the screen.
  // Triggered by the ⓘ button in the control panel.
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
    .style("transform", "translateX(100%)")           // starts off-screen to the right
    .style("transition", "transform 0.4s ease, background 0.3s ease, border 0.3s ease")
    .style("box-sizing", "border-box");
  
  // Alias for clarity — infoSidebar and infoModal are the same element
  const infoModal = infoSidebar;

  // The hover tooltip that follows the mouse cursor over map regions.
  // Initially hidden; shown on mouseover events in renderMap().
  const tooltip = d3.select("body").append("div")
    .style("position", "absolute")
    .style("visibility", "hidden")
    .style("padding", "10px 14px")
    .style("border-radius", "2px")
    .style("font-size", "12px")
    .style("pointer-events", "none")      // Tooltip never intercepts mouse clicks
    .style("font-family", "'Inter', sans-serif")
    .style("z-index", "1000");

  // On desktop only: show a tooltip label when hovering the collapse/expand button
  if (!isMobile()) {
    collapseBtn
      .on("mouseenter.tip", function() {
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

  // The map canvas area — takes up all remaining horizontal space beside the sidebar
  const mapContainer = mainWrapper.append("div")
    .style("flex", "1")
    .style("position", "relative")
    .style("transition", "all 0.4s ease");
  
  // The SVG element where D3 draws all the geographic regions.
  // viewBox makes it resolution-independent; it scales to fill its container.
  const svg = mapContainer.append("svg")
  .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)
  .attr("preserveAspectRatio", "xMidYMid meet")
  .style("width", "100%")
  .style("height", "100%")
  .style("shape-rendering", "geometricPrecision")
  .style("touch-action", "none")  // Required for D3 zoom to receive touch events in Firefox
  .on("click", () => {});

  // A <g> group element that all map paths are drawn into.
  // D3 zoom transforms are applied to this group rather than the whole SVG,
  // so the buttons and legend (outside this group) stay fixed in place.
  const mapGroup = svg.append("g"); 

  // The legend overlay box (bottom-right on desktop, top-left on mobile).
  // Shows the colour scale and swatch key for the choropleth.
  // On mobile the legend top matches the control panel (max(12px,...)) and its
  // Mobile legend height = 3 buttons × 44px + 2 gaps × 6px, same in both portrait and landscape
  const _legendH = isMobile() ? "144px" : null;
  const legendOverlay = mapContainer.append("div")
    .style("position", "absolute")
    .style("bottom", isMobile() ? null : "30px")
    .style("top",    isMobile() ? "max(12px, env(safe-area-inset-top, 12px))" : null)
    .style("left",   isMobile() ? "10px" : null)
    .style("right",  isMobile() ? null   : "30px")
    .style("height", _legendH)
    .style("backdrop-filter", "blur(15px)")
    .style("padding", isMobile() ? "10px 12px" : "20px")
    .style("border-radius", "6px")
    .style("min-width", isMobile() ? null : "260px")
    .style("max-width", isMobile() ? "calc(100vw - 80px)" : null)
    .style("box-sizing", "border-box")
    .style("overflow", "hidden")
    .style("transition", "all 0.3s ease");

  // ─── SECTION 9: COLOUR THEMES ─────────────────────────────────────────────
  //  Each theme is a D3 colour interpolation function — given a number between
  //  0 (minimum) and 1 (maximum), it returns a colour along a gradient.
  //  Users can switch themes using the small buttons inside the legend.
  const COLOUR_THEMES = {
    Classic: d3.interpolateRgbBasis(["#648FFF", "#785EF0", "#DC267F", "#FE6100", "#FFB000"]),
    Greens:  d3.interpolateRgbBasis(["#1a4a3a", "#4ecca3", "#f0a500"]),
    Viridis: d3.interpolateViridis,
    Heat:    d3.interpolateRgbBasis(["#fce2c5", "#a60303"]),
    Plasma:  d3.interpolatePlasma,
  };

  // ─── SECTION 10: MAP PROJECTION & ZOOM ───────────────────────────────────
  //  A "projection" converts latitude/longitude coordinates from the GeoJSON
  //  into x/y pixel positions on the SVG canvas.
	const projection = d3.geoIdentity()
	  .reflectY(true) // GIS systems have Y going up, SVGs have Y going down
	  .fitExtent([[10, 20], [WIDTH - 10, HEIGHT - 110]], fixedData);
	const path = d3.geoPath().projection(projection);

  //  Define the zoom functionality.
	const zoom = d3.zoom()
	  .scaleExtent([1, 150])
	  .on("zoom", ({ transform }) => {
		mapGroup.attr("transform", transform);
	  });
	svg.call(zoom);

  //  When provided a feature (i.e. a census division is pressed), calculate and provide the map position to zoom into.
	function zoomToFeature(feature) {
    // On mobile, skip programmatic zoom-in — the detail sheet slides up without
    // moving the map backdrop, avoiding disorienting zoom into remote corridors.
    if (isMobile()) return;
	  const [[x0, y0], [x1, y1]] = path.bounds(feature);
	  const dx = x1 - x0; const dy = y1 - y0;
	  const scale = Math.min(150, 0.45 / Math.max(dx / WIDTH, dy / HEIGHT));
	  const translate = [WIDTH / 2 - scale * ((x0 + x1) / 2), HEIGHT / 2 - scale * ((y0 + y1) / 2)];
	  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
	}

  //  Reset the map back to the initial view.
	function zoomToFull() { 
	  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity); 
	}

  // ─── SECTION 11: SIDEBAR OPEN/CLOSE ANIMATION ────────────────────────────
  //  Drives the visual state of the sidebar based on state.sidebarOpen.
  //  Mobile and desktop have completely different mechanisms:
  //    • Mobile:  CSS translateY slides the bottom sheet on/off screen
  //    • Desktop: the sidebar width is animated between full and collapsed
  function updateSidebarToggle() {
    if (isMobile()) {
      const c = getC();
      if (state.sidebarOpen) {
        sidebar.style("height", (typeof _userSetHeight === "number"
          ? _userSetHeight : (window.innerHeight * 0.60)) + "px");
        sidebar.style("transform", "translateY(0)");
        d3.select("#mobile-filter-toggle").style("display", "none");
      } else {
        // Slide the sheet off the bottom of the screen
        sidebar.style("transform", "translateY(100%)");
        // Bring back the "▲ FILTERS" pill so the user can reopen the sheet
        d3.select("#mobile-filter-toggle")
          .style("display", null)
          .style("background", c.accent)
          .style("color", "#fff")
          .style("border", `1px solid ${c.accent}`);

      }
      return;
    }
    // Desktop behaviour: animate the sidebar width and toggle the arrow icon
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

  // ─── SECTION 12: LEGEND RENDERING ────────────────────────────────────────

  // Draws the colour gradient legend bar with min/max labels, theme switcher
  // buttons, and a movable marker line that tracks the hovered/selected region.
  function updateLegend(min, max, colourScale) {
    const c = getC();
    // On mobile the legend box is smaller, so calculate a narrower bar width
    const BAR_WIDTH = isMobile()
      ? Math.max(80, Math.min(280, window.innerWidth - 80 - 24))
      : 280;
    const BAR_HEIGHT = 4;

    legendOverlay.selectAll("*").remove(); // Clear any previous legend content

    legendOverlay.append("div").style("font-size", "10px").style("font-weight", "600").style("letter-spacing", "1.2px").style("margin-bottom", isMobile() ? "6px" : "12px").style("color", c.muted).text("DEFENCE FACILITY COUNT");

    // Create an SVG inside the legend for the gradient bar
    const svgL = legendOverlay.append("svg").attr("id", "legend-bar-svg").attr("width", BAR_WIDTH).attr("height", 38).style("display", "block");
    // Use a stable ID so the browser can reuse the SVG defs across legend rebuilds.
    const gradId = "legend-grad";
    const grad = svgL.append("defs").append("linearGradient").attr("id", gradId);
    
    // Add colour stops at 0%, 50%, and 100% of the value range
    [0, 0.5, 1].forEach(t => grad.append("stop").attr("offset", `${t * 100}%`).attr("stop-color", colourScale(min + t * (max - min))));

    // Draw the gradient bar rectangle
    svgL.append("rect").attr("width", BAR_WIDTH).attr("height", BAR_HEIGHT).attr("rx", 2).style("fill", `url(#${gradId})`);
    // Labels at each end showing the min and max facility counts
    svgL.append("text").attr("x", 0).attr("y", BAR_HEIGHT + 15).style("font-size", "11px").style("fill", c.text).text(min.toLocaleString());
    svgL.append("text").attr("x", BAR_WIDTH).attr("y", BAR_HEIGHT + 15).attr("text-anchor", "end").style("font-size", "11px").style("fill", c.text).text(max.toLocaleString());

    // The marker is a vertical line on the gradient bar that moves to show
    // where the hovered or selected region falls on the colour scale.
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

    // If a region is already selected, immediately show its marker position
    if (state.selectedFeature) {
      const val = getFilteredValue(state.selectedFeature);
      if (val > 0) updateLegendMarker(val, true);
    }

    // Swatch legend: two coloured squares explaining the two "no data" grey shades
    const swatchDiv = legendOverlay.append("div").style("margin-top", isMobile() ? "6px" : "12px");
    [{ color: c.noData, label: "No defence facilities with the current filters" }, { color: c.noDataNone, label: "No defence facilities recorded" }].forEach(({ color, label }) => {
      const row = swatchDiv.append("div").style("display", "flex").style("align-items", "flex-start").style("gap", "8px").style("margin-bottom", isMobile() ? "3px" : "6px");
      row.append("div").style("width", "16px").style("min-width", "16px").style("height", "10px").style("margin-top", "2px").style("border-radius","2px").style("background", color);
      row.append("span").style("font-size", "10px").style("color", c.muted).style("line-height", "1.4").style("word-break", "break-word").text(label);
    });

    // Theme switcher buttons below the gradient bar
    legendOverlay.append("div").style("margin-top", isMobile() ? "6px" : "15px").style("display", "flex").style("justify-content", "space-between").style("gap", "4px").selectAll("button").data(Object.keys(COLOUR_THEMES)).join("button")
      .text(d => d).style("flex", "1").style("background", d => d === state.currentTheme ? (state.isDark ? "rgba(78,204,163,0.1)" : "rgba(5,150,105,0.1)") : "transparent").style("color", d => d === state.currentTheme ? c.accent : c.muted).style("border", d => d === state.currentTheme ? `1px solid ${c.accent}` : `1px solid ${c.border}`).style("padding", "5px 0").style("font-size", "8.5px").style("cursor", "pointer").style("border-radius", "3px").style("text-transform", "uppercase").style("font-family", "'Inter', sans-serif").style("transition", "all 0.2s ease")
      .on("mouseenter", function(_, d) { if (d !== state.currentTheme) d3.select(this).style("border", `1px solid ${c.accent}`).style("transform", "scale(1.08)"); })
      .on("mouseleave", function(_, d) { if (d !== state.currentTheme) d3.select(this).style("border", `1px solid ${c.border}`).style("transform", "scale(1)"); })
      .on("click", (_, d) => { state.currentTheme = d; renderMap(); }); // Re-render the whole map with the new colour theme
  }

  // Shown when the active filters result in zero matching facilities anywhere.
  // Replaces the normal gradient legend with a simple "no match" message.
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

  // Moves the marker line on the gradient bar to position it at the correct
  // point for a given facility count value.
  //   val        — the facility count to mark
  //   persistent — true when the marker should stay after hovering ends (i.e. a region is selected)
  function updateLegendMarker(val, persistent) {
    const svgEl = document.getElementById("legend-bar-svg");
    const BAR_WIDTH = svgEl ? parseFloat(svgEl.getAttribute("width")) : 280;
    const markerG = d3.select("#legend-marker");
    if (markerG.empty()) return;
    
    if (val === null || val === undefined || val <= 0) {
      // If hovering away and a region is still selected, keep the marker at the selected value
      if (!persistent && state.selectedFeature) {
        const selVal = getFilteredValue(state.selectedFeature);
        if (selVal > 0) { updateLegendMarker(selVal, true); return; }
      }
      markerG.style("display", "none");
      return;
    }
    
    // Normalise the value to a 0–1 position along the bar
    const t = Math.max(0, Math.min(1, (val - state.legendMin) / (state.legendMax - state.legendMin)));
    const xPos = t * BAR_WIDTH;
    
    markerG.style("display", null);
    markerG.select("#legend-marker-line").attr("x1", xPos).attr("x2", xPos);
    
    // Persistent markers (selected region) are fully opaque; hover markers are translucent
    const lineColour = state.isDark
      ? (persistent ? "#ffffff"       : "rgba(255,255,255,0.6)")
      : (persistent ? "#1a1a1a"       : "rgba(26,26,26,0.5)");
    markerG.select("#legend-marker-line").attr("stroke", lineColour);
  }

  // Hides the marker, unless a region is selected — in that case
  // restores the marker to the selected region's position instead.
  function clearLegendMarker() {
    if (state.selectedFeature) {
      const val = getFilteredValue(state.selectedFeature);
      if (val > 0) { updateLegendMarker(val, true); return; }
    }
    d3.select("#legend-marker").style("display", "none");
  }

  // ─── SECTION 13: MAIN MAP RENDER ─────────────────────────────────────────
  //  This is the core drawing function. It is called on startup and any time
  //  a filter changes or the colour theme changes.
  //
  //  Steps:
  //    1. Compute filtered facility counts for every region
  //    2. Build a colour scale from the min/max of those counts
  //    3. Update the legend
  //    4. Draw (or update) a <path> SVG element for every Census Division,
  //       coloured by facility count and wired up for hover/click interactions
  function renderMap() {
    const c = getC();
    invalidateFilteredValueCache(); // Ensure counts are recomputed for current filter state
    // Get the filtered count for every region; ignore regions with zero matches
    const values = fixedData.features.map(d => getFilteredValue(d)).filter(v => v > 0);
    const minVal = d3.min(values) ?? 0; const maxVal = d3.max(values) ?? 1;
    
    // Build a sequential colour scale mapping [minVal, maxVal] → colour.
    // Adding 1 to the max avoids a zero-width domain if all counts are equal.
    const colourScale = d3.scaleSequential([minVal, Math.max(maxVal, minVal + 1)], COLOUR_THEMES[state.currentTheme]);
    state.legendMin = minVal; state.legendMax = Math.max(maxVal, minVal + 1); state.legendColourScale = colourScale;

    // Update the legend to reflect the new scale (or show "no data" message)
    if (values.length === 0) updateLegendEmpty(); else updateLegend(minVal, maxVal, colourScale);

    // D3 data join: one <path> per Census Division feature.
    // On first call these are created; on subsequent calls they are updated in place.
    mapGroup.selectAll("path.cd-region")
      .data(fixedData.features)
      .join("path")
        .attr("class", "cd-region")
        .attr("d", path)                          // Converts GeoJSON geometry → SVG path string
        .attr("stroke", c.bg)                     // Region border colour matches background (subtle)
        .attr("stroke-width", 0.5)
        .attr("vector-effect", "non-scaling-stroke") // Keep border width constant regardless of zoom level

        // ── Keyboard accessibility ──
        // Only regions with data are keyboard-navigable; others are hidden from tab order.
        .attr("tabindex", d => (getFilteredValue(d) > 0 || hasAnyData(d)) ? "0" : null)
        .attr("role", d => (getFilteredValue(d) > 0 || hasAnyData(d)) ? "button" : null)
        .attr("aria-label", d => {
          const val = getFilteredValue(d);
          return `${d.properties.CDNAME || "Region"}, ${getTooltipLabel(val)}`;
        })

        // Only show a pointer cursor over regions that have data
        .style("cursor", d => (getFilteredValue(d) > 0 || hasAnyData(d)) ? "pointer" : "default")

	// ── Hover interactions (desktop only — mobile uses tap) ──
        .on("mouseover", isMobile() ? null : function(event, d) {
          state.hoveredFeature = d;
          if (state._hoveredEl && state._hoveredEl !== this) {
            const prev = d3.select(state._hoveredEl);
            if (prev.attr("stroke") !== c.accent2) prev.attr("stroke", c.bg).attr("stroke-width", 0.5);
          }
          state._hoveredEl = this;
          d3.select(this).attr("stroke", c.text).attr("stroke-width", 1).raise();
          const hoverVal = getFilteredValue(d);
          updateLegendMarker(hoverVal > 0 ? hoverVal : null, false);
          tooltip.style("visibility", "visible").html(`
            <div style="color:${c.accent}; font-weight:600; font-size:14px; margin-bottom:4px;">${d.properties.CDNAME}</div>
            <div style="font-size:11px; color:${c.muted}; font-weight:400;">${getTooltipLabel(getFilteredValue(d))}</div>
          `);
        })
        // Tooltip follows the mouse as it moves
        .on("mousemove", isMobile() ? null : (() => {
          // Throttle to one reposition per animation frame (~60 fps max).
          // Without this, mousemove fires on every pixel and queues redundant style writes.
          let _rafPending = false;
          return function(event) {
            if (_rafPending) return;
            _rafPending = true;
            const px = event.pageX, py = event.pageY;
            requestAnimationFrame(() => {
              tooltip.style("top", `${py - 10}px`).style("left", `${px + 20}px`);
              _rafPending = false;
            });
          };
        })())
        .on("mouseleave", isMobile() ? null : function() {
          state.hoveredFeature = null;
          state._hoveredEl = null;
          const sel = d3.select(this);
          if (sel.attr("stroke") !== c.accent2) sel.attr("stroke", c.bg).attr("stroke-width", 0.5);
          clearLegendMarker();
          tooltip.style("visibility", "hidden");
        })

        // ── Keyboard focus: show tooltip at element centre (desktop only) ──
        .on("focus", isMobile() ? null : function(event, d) {
          d3.select(this).attr("stroke", c.text).attr("stroke-width", 1).raise();
          const hoverVal = getFilteredValue(d);
          updateLegendMarker(hoverVal > 0 ? hoverVal : null, false);
          const rect = this.getBoundingClientRect();
          tooltip
            .style("visibility", "visible")
            .html(`
              <div style="color:${c.accent}; font-weight:600; font-size:14px; margin-bottom:4px;">${d.properties.CDNAME}</div>
              <div style="font-size:11px; color:${c.muted}; font-weight:400;">${getTooltipLabel(hoverVal)}</div>
            `)
            .style("top",  `${rect.top  + window.scrollY + rect.height / 2 - 10}px`)
            .style("left", `${rect.right + window.scrollX + 12}px`);
        })
        .on("blur", isMobile() ? null : function() {
          const sel = d3.select(this); if (sel.attr("stroke") !== c.accent2) sel.attr("stroke", c.bg).attr("stroke-width", 0.5);
          clearLegendMarker();
          tooltip.style("visibility", "hidden");
        })

        // ── Click / tap interaction ──
        .on("click", function(event, d) {
          event.stopPropagation(); // Prevent click from bubbling up to the SVG background
          
          // Clicking a region with no data clears any existing selection
          if (!hasAnyData(d)) { restoreMapAppearance(); return; } 
          
          state.selectedFeature = d;
          const selVal = getFilteredValue(d);
          // Pin the legend marker at this region's position
          updateLegendMarker(selVal > 0 ? selVal : null, true);
          
          // Ensure the sidebar is open to show the detail panel
          if(!state.sidebarOpen) {
            state.sidebarOpen = true;
            updateSidebarToggle();
          }

          // Dim all regions to 35% opacity, then fully highlight the selected one
          mapGroup.selectAll("path.cd-region").style("opacity", 0.35).attr("stroke", c.bg);
          d3.select(this).style("opacity", 1).attr("stroke", c.accent2).attr("stroke-width", 2).raise();
          
          zoomToFeature(d);       // Animate the map zooming in on the selected region

          updateSidebarDetail();

          if (isMobile()) {
            // Scroll immediately after layout settles.
            setTimeout(() => {
              const scrollEl = sidebarInnerContent.node();
              if (scrollEl) {
                const scrollTop = detailsDiv.node().offsetTop - sidebarInnerContent.node().offsetTop;
                scrollEl.scrollTo({ top: scrollTop, behavior: "smooth" });
              }
            }, 50);
          } else {
            // Scroll the sidebar so the census division name is visible near the top.
            setTimeout(() => {
              const scrollEl = sidebar.node();
              if (scrollEl) scrollEl.scrollTo({ top: detailsDiv.node().offsetTop - 16, behavior: "smooth" });
            }, 50);
          }
        })

        // Animated transition: smoothly update opacity, stroke, and fill whenever
        // the map is re-rendered (e.g. after a filter change).
          .transition().duration(700)
            .style("opacity", d => (state.selectedFeature && d !== state.selectedFeature) ? 0.35 : 1)
            .attr("stroke", d => (d === state.selectedFeature) ? c.accent2 : c.bg)
            .attr("stroke-width", d => (d === state.selectedFeature) ? 2 : 0.5)
            .attr("fill", d => {
              const val = getFilteredValue(d);
              // Colour the region by facility count if > 0; otherwise use a grey shade
              if (val) return colourScale(val);
              return hasAnyData(d) ? c.noData : c.noDataNone; // Two different greys for "filtered-out" vs "no data"
            });
  }

  // ─── SECTION 14: SIDEBAR DETAIL PANEL ────────────────────────────────────
  //  Builds the content shown in the sidebar after a Census Division is clicked.
  //  Includes: region name, donut chart of industry breakdown,
  //  and an accordion list of facility operation types with sub-categories.

  // Shared helper: appends the "Close / ✕" button to #sidebar-header-container.
  // Previously duplicated verbatim in both the "no match" and normal render paths.
  function buildCloseButton() {
    const c = getC();
    d3.select("#sidebar-header-container")
      .append("button")
      .attr("id", "sidebar-back")
      .text(isMobile() ? "✕" : "CLOSE CENSUS DIVISION DETAILS")
      .style("display", isMobile() ? "none" : null)
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
  }

  function updateSidebarDetail() {
    const c = getC();
    
    // Hide any previously open accordion rows from a prior selection
    if (document.getElementById("mfg-rows")) document.getElementById("mfg-rows").style.display = "none";
    if (document.getElementById("tech-rows")) document.getElementById("tech-rows").style.display = "none";
    if (document.getElementById("mro-rows")) document.getElementById("mro-rows").style.display = "none";

    // If no region is selected, show a prompt inviting the user to click one
    if (!state.selectedFeature) {
      detailsDiv.html(`<p style="color:${c.muted}; font-size:14px; font-weight:400; padding-bottom:32px;">Select a census division to analyse specific industry metrics.</p>`);
      return;
    }

    const props = state.selectedFeature.properties;
    // Use the pre-computed _cduid (avoids repeated three-way property lookup)
    const geoId = state.selectedFeature._cduid;

    // Find all facilities in this region that pass the currently active filters.
    // Uses the shared buildFilterPredicate() — same logic as getFilteredValue(),
    // but was previously duplicated inline here.
    const passesFilters = buildFilterPredicate();
    const activeLocalFacilities = allFacilities.filter(f => f.cduid === geoId && passesFilters(f));
    
    // Summarise how many of the local facilities fall into each operation type.
    // Only include types that have at least one facility.
    const stats = [
      ["Manufacturing_sum", activeLocalFacilities.filter(f => f.isMfg).length],
      ["Value-Add/Tech_sum", activeLocalFacilities.filter(f => f.isTech).length],
      ["MRO/ISS_sum",        activeLocalFacilities.filter(f => f.isMro).length]
    ].filter(([_, v]) => v > 0);

    // Assign a unique colour to each defence industry for the donut chart legend
    const INDUSTRY_COLOURS = Object.fromEntries(Object.keys(INDUSTRY_KEYS).map((k, i) => [INDUSTRY_KEYS[k], d3.schemeObservable10[i]]));
    // Count facilities per industry sector (donut slices), ignoring empty sectors
    const industryData = Object.entries(INDUSTRY_KEYS).map(([k, label]) => ({ label, value: activeLocalFacilities.filter(f => f.industries.has(k)).length })).filter(d => d.value > 0);

    // Sub-category lookup tables for each operation type.
    // These map CSV column codes to human-readable industry sub-sector names.
    // Used to populate the accordion "drill-down" rows.
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
      "V_414": "Personal Goods Wholesalers",
      "V_416": "Building Material Wholesalers", "V_417": "Machinery & Equipment Wholesalers",
      "V_418": "Miscellaneous Wholesalers", "V_488": "Support Activities for Transportation",
      "V_517": "Telecommunications Services", "V_518": "Data Processing, Hosting, & Related Services",
      "V_541": "Professional, Scientific & Technical Services", "V_561": "Administrative & Support Services",
      "V_611": "Educational Services", "V_811": "Repair & Maintenance Services"
    };

    const MRO_KEYS = {
      "I_336": "Transportation Equipment", "I_488": "Transportation Support Activities", "I_811": "Heavy Repair & Maintenance"
    };

    // For each operation type, count how many matching local facilities fall into
    // each sub-category, then sort by count (highest first) and drop zeros.
    const mfgData = Object.entries(MFG_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMfg && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);
    const techData = Object.entries(TECH_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isTech && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);
    const mroData = Object.entries(MRO_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMro && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value);

    // Builds one row of the "Facility Operations Type" accordion list as an HTML string.
    // Each row shows the operation type name and count. If sub-category data exists,
    // the row is expandable (a ▼ chevron toggles the sub-rows visible/hidden).
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

    // HTML for the region name header (shown at the top of the detail panel)
	const headerHtml = `
      <div id="sidebar-header-container" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; font-family: 'Inter', sans-serif;">
        <div style="flex: 1;">
          <h3 style="font-size: 24px; font-weight: 600; margin: 0 0 4px 0; color: ${c.text}; line-height: 1.2;">${props.CDNAME}</h3>
          <div style="font-size: 11px; color: ${c.muted}; font-weight: 500; letter-spacing: 1px; text-transform: uppercase;">${props.PRNAME ?? ""}</div>
        </div>
      </div>
    `;

    // If no facilities pass the filters in this region, show a "no match" message
    // instead of the donut chart and accordion.
    if (activeLocalFacilities.length === 0) {
      detailsDiv.html(`
        ${headerHtml}
        <div style="background: ${state.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}; border: 1px dashed ${c.border}; border-radius: 6px; padding: 24px; text-align: center; margin-top: 20px;">
          <p style="color: ${c.accent}; font-size: 14px; font-weight: 600; margin: 0 0 6px 0;">No facilities match active filters in this region.</p>
          <p style="color: ${c.muted}; font-size: 12px; margin: 0; line-height: 1.4;">Try adjusting or resetting your operations and industry filters to see the regional capabilities.</p>
        </div>
      `);

      // Append the "Close" / ✕ button to deselect the region
      buildCloseButton();
        
      return;
    }

    // Map each stats entry to the correct accordion row (with its specific sub-data and IDs)
    const rows = stats.map(([k, v]) => {
      if (k === "Manufacturing_sum") return buildAccordionRow(k, v, mfgData, "mfg-toggle", "mfg-rows", "mfg-chevron");
      if (k === "Value-Add/Tech_sum") return buildAccordionRow(k, v, techData, "tech-toggle", "tech-rows", "tech-chevron");
      if (k === "MRO/ISS_sum")        return buildAccordionRow(k, v, mroData,  "mro-toggle",  "mro-rows",  "mro-chevron");
      return buildAccordionRow(k, v, [], "", "", "");
    }).join("");

    // Inject the full detail panel HTML into the detailsDiv
    detailsDiv.html(`
      ${headerHtml}
      <div id="donut-chart" style="margin-bottom:28px;"></div>
      <p style="font-size:12px; color:${c.muted}; margin: 28px 0; line-height:1.5; font-weight:400;"><b>Please note:</b> a single facility may serve multiple defence industries.</p>
      <div style="font-size:10px; font-weight:600; letter-spacing:1.5px; color:${c.muted}; margin-top:32px; margin-bottom:8px; text-transform:uppercase;">Facility Operations Type</div>
      ${rows}
      ${isMobile() ? `<div style="height: max(32px, env(safe-area-inset-bottom, 32px));"></div>` : ""}
    `);

    // Add the "Close" button to the now-rendered header container
    buildCloseButton();

    // Wire up the accordion expand/collapse toggle for each operations type row.
    // Clicking a row (or pressing Enter/Space on it) shows/hides its sub-rows
    // and rotates the ▼ chevron to ▲.
    [["mfg-toggle", "mfg-rows", "mfg-chevron"], ["tech-toggle", "tech-rows", "tech-chevron"], ["mro-toggle", "mro-rows", "mro-chevron"]].forEach(([toggleId, rowsId, chevronId]) => {
      const btn = document.getElementById(toggleId); if (!btn) return;
      const toggle = () => {
        const isOpen = document.getElementById(rowsId).style.display !== "none";
        document.getElementById(rowsId).style.display = isOpen ? "none" : "block";
        document.getElementById(chevronId).style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
        btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
      };
      btn.addEventListener("click", toggle);
      // Keyboard accessibility: Enter and Space also trigger the toggle
      btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });

    // If there are no industry sectors to show, skip the donut chart entirely
    if (!industryData.length) return;
    
    // ─── Donut Chart ──────────────────────────────────────────────────────────
    //  Draws a donut chart showing the breakdown of facilities by defence industry.
    //  Hovering a slice updates the centre label to show that industry's count.
    const SIZE = 260; const RADIUS = SIZE / 2; const INNER = RADIUS * 0.55;
    const svgD = d3.select("#donut-chart").append("svg").attr("width", SIZE).attr("height", SIZE + 20).style("overflow", "visible");
    // On mobile, block all pointer events on the donut for 450ms — this absorbs the
    // synthesized ghost mouseover/click the browser fires after a touchend at the
    // same screen coordinates as the map tap that opened this panel.
    if (isMobile()) {
      svgD.style("pointer-events", "none");
      setTimeout(() => svgD.style("pointer-events", null), 450);
    }
    // Centre group — all paths and labels are relative to the donut's centre
    const g = svgD.append("g").attr("transform", `translate(${RADIUS},${RADIUS})`);
    
    // Centre label: shows total facility count by default; updates on hover
    const cVal = g.append("text").attr("text-anchor", "middle").attr("dy", "-0.15em").style("font-size", "22px").style("font-weight", "600").style("fill", c.text).style("font-family", "Inter");
    const cLab = g.append("text").attr("text-anchor", "middle").attr("dy", "1.1em").style("font-size", "9px").style("font-weight", "500").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter");

    // showDefault restores the centre label to the total count when not hovering
    const showDefault = () => { 
      cVal.text(activeLocalFacilities.length.toLocaleString()); 
      cLab.text(activeLocalFacilities.length === 1 ? "FACILITY" : "FACILITIES"); 
    };
    showDefault();

    // Draw the donut slices. d3.pie() converts value counts to arc angles.
    let _activeTouchSlice = null;
    g.selectAll("path").data(d3.pie().value(d => d.value).sort(null)(industryData)).join("path").attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)).attr("fill", d => INDUSTRY_COLOURS[d.data.label]).attr("stroke", c.bg).attr("stroke-width", 2).style("cursor", "pointer").style("-webkit-tap-highlight-color", "transparent")
      // On hover: expand the slice outward and show its sector name/count in the centre
      .on("mouseover", function(_, d) { d3.select(this).transition().duration(150).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS + 6)(d)); cVal.text(d.data.value); cLab.text(d.data.label.toUpperCase()); })
      // On mouse-out: shrink the slice back and restore the default centre label
      .on("mouseout", function(_, d) { d3.select(this).transition().duration(150).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)(d)); showDefault(); })
      // Touch: tap to expand and show label; tap again or tap another to collapse
      .on("touchstart", function(event, d) {
        event.stopPropagation();
        event.preventDefault();
        const self = d3.select(this);
        if (_activeTouchSlice && _activeTouchSlice.node() !== this) {
          _activeTouchSlice.transition().duration(150).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)(_activeTouchSlice.datum()));
        }
        if (_activeTouchSlice && _activeTouchSlice.node() === this) {
          self.transition().duration(150).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2)(d));
          showDefault();
          _activeTouchSlice = null;
        } else {
          self.transition().duration(150).attr("d", d3.arc().innerRadius(INNER).outerRadius(RADIUS + 6)(d));
          cVal.text(d.data.value);
          cLab.text(d.data.label.toUpperCase());
          _activeTouchSlice = self;
        }
      });

    // Chart title below the donut
    svgD.append("text").attr("transform", `translate(0, ${SIZE + 20})`).style("font-size", "11px").style("font-weight", "600").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter").text("DEFENCE INDUSTRIES SERVED");

    // Colour key legend below the chart title, laid out in two columns
    const legendG = svgD.append("g").attr("transform", `translate(0, ${SIZE + 36})`);
    const COLS = 2; const COL_W = SIZE / COLS;
    
    industryData.forEach((d, i) => {
      const x = (i % COLS) * COL_W; const y = Math.floor(i / COLS) * 20;
      const row = legendG.append("g").attr("transform", `translate(${x},${y})`);
      row.append("rect").attr("width", 8).attr("height", 8).attr("rx", 2).attr("fill", INDUSTRY_COLOURS[d.label]);
      row.append("text").attr("x", 12).attr("y", 8).style("font-size", "11px").style("fill", c.muted).style("font-family", "Inter").text(d.label);
    });
    
    // Extend the SVG height to fit the legend rows
    svgD.attr("height", SIZE + 12 + Math.ceil(industryData.length / COLS) * 20);
  }

  // ─── SECTION 15: CONTROLS DOM BUILD ──────────────────────────────────────
  //  Builds the filter controls (Operations chips, Industry chips, logo, title,
  //  and "About" panel text) inside the sidebar.
  //
  //  This function runs only ONCE (guarded by _controlsBuilt). The reason:
  //  these DOM elements are expensive to create, and their visual state can be
  //  updated cheaply in-place by refreshControlsState() without rebuilding.
  let _controlsBuilt = false;

  function buildControlsDOM() {
    if (_controlsBuilt) return; // Already built — do nothing
    _controlsBuilt = true;

    const c = getC();

    // ── Logo ──
    // The logo image has two versions: one for dark mode, one for light mode.
    // refreshControlsState() swaps the src when the theme changes.
    const logoContainer = controlsDiv.append("div")
      .style("margin-bottom", "14px")
      .style("display", "flex")
      .style("align-items", "center");

    const logoUrl = state.isDark
      ? "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/assets/Trillium_full_color_ondark.svg"
      : "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/assets/Trillium_full_color_onlight.svg";

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
      .on("error", function() { d3.select(this).style("display", "none"); }); // Silently hide if image fails to load

    // ── Page title ──
    controlsDiv.append("h2")
      .style("font-size", isMobile() ? "20px" : "26px")
      .style("font-weight", "600")
      .style("color", c.accent)
      .style("font-family", "'Inter', sans-serif")
      .style("margin-bottom", "10px")
      .text("Canada's Defence Manufacturing Industry");

    // ── Operations Filters section header + reset button ──
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
      .on("touchend", (event) => { event.preventDefault(); state.currentAnalyticsKeys.clear(); applyFilterAndCheckZoom(); })
      .on("click", (event) => { if (event.pointerType === "touch") return; state.currentAnalyticsKeys.clear(); applyFilterAndCheckZoom(); })
      .on("mouseenter", function() {
        if (state.currentAnalyticsKeys.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });

    // ── Operations filter "chips" (pill buttons) ──
    // One chip per operation type. Clicking toggles that type on/off.
    // The "All Defence Facilities" entry (General_Count_sum) is skipped —
    // it represents the default unfiltered state, not a filter option.
    const analyticsContainer = controlsDiv.append("div")
      .attr("id", "analytics-selector")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px")
      .style("margin-bottom", "20px");

    Object.entries(OPERATIONS_MAP).forEach(([key, label]) => {
      if (key === "General_Count_sum") return; // Skip the "all" entry
      analyticsContainer.append("button")
        .attr("data-ops-key", key)   // Store the key as a data attribute for event handlers to read
        .attr("data-label", label)
        .attr("aria-pressed", "false")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", isMobile() ? "12px" : "10px")
        .style("font-weight", "500")
        .style("letter-spacing", "0.3px")
        .style("padding", isMobile() ? "8px 14px" : "5px 10px")
        .style("border-radius", "20px")
        .style("cursor", "pointer")
        .on("touchend", function(event) {
          event.preventDefault();
          const k = this.getAttribute("data-ops-key");
          if (state.currentAnalyticsKeys.has(k)) state.currentAnalyticsKeys.delete(k);
          else state.currentAnalyticsKeys.add(k);
          applyFilterAndCheckZoom();
        })
        .on("click", function(event) {
          if (event.pointerType === "touch") return;
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

    // ── Industry Filters section header + AND/OR toggle + reset button ──
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

    // AND/OR mode toggle — controls whether all included industries must match (AND)
    // or just one needs to match (OR). Greyed out until at least one industry is included.
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
        .on("touchend", function(event) {
          event.preventDefault();
          state.industryFilterMode = this.getAttribute("data-mode");
          applyFilterAndCheckZoom();
        })
        .on("click", function(event) {
          if (event.pointerType === "touch") return;
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
      .on("touchend", (event) => { event.preventDefault(); state.currentIndustries.clear(); applyFilterAndCheckZoom(); })
      .on("click", (event) => { if (event.pointerType === "touch") return; state.currentIndustries.clear(); applyFilterAndCheckZoom(); })
      .on("mouseenter", function() {
        if (state.currentIndustries.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("text-decoration", "none").style("background", "transparent"); });


    // ── Industry filter chips ──
    // Each chip cycles through three states on repeated clicks:
    //   (none) → "include" (✓, green) → "exclude" (✕, red) → (none)
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
        .on("touchend", function(event) {
          event.preventDefault();
          const k = this.getAttribute("data-ind-key");
          const cur = state.currentIndustries.get(k);
          if (!cur)                  state.currentIndustries.set(k, "include");
          else if (cur === "include") state.currentIndustries.set(k, "exclude");
          else                       state.currentIndustries.delete(k);
          applyFilterAndCheckZoom();
        })
        .on("click", function(event) {
          if (event.pointerType === "touch") return;
          const k = this.getAttribute("data-ind-key");
          const cur = state.currentIndustries.get(k);
          // Cycle: not set → include → exclude → remove
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

    // ── "Reset All Filters" button ──
    // Resets both Operations and Industry filters at once.
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
      .on("touchend", (event) => { event.preventDefault(); clearAllFilters(); })
      .on("click", (event) => { if (event.pointerType === "touch") return; clearAllFilters(); })
      .on("mouseenter", function() {
        const either = state.currentAnalyticsKeys.size > 0 || state.currentIndustries.size > 0;
        if (either) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });

    // ── "About this map" info panel content ──
    // Populated once here; the panel slides in/out via the ⓘ button.
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

    // Close button inside the info panel
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
      .on("touchend", (event) => { event.preventDefault(); state.infoOpen = false; infoSidebar.style("transform", "translateX(100%)"); })
      .on("click", (event) => { if (event.pointerType === "touch") return; state.infoOpen = false; infoSidebar.style("transform", "translateX(100%)"); });

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

    // Bulleted usage tips
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
	// Display each usage tip in a bulleted list
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
        .attr("href", "https://github.com/riley-kemp/defence-map")
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

  // ─── SECTION 16: REFRESH CHIP/BUTTON STYLES ───────────────────────────────
  //  Updates the visual appearance of all filter chips and reset buttons
  //  to reflect the current filter state — without rebuilding the DOM.
  //  Called after every filter change and after a theme switch.
  function refreshControlsState() {
    const c = getC();

    // Swap the logo image for the correct dark/light version
    const logoImg = document.getElementById("logo-img");
    if (logoImg) {
      logoImg.src = state.isDark
        ? "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/assets/Trillium_full_color_ondark.svg"
        : "https://raw.githubusercontent.com/riley-kemp/defence-map/refs/heads/main/assets/Trillium_full_color_onlight.svg";
    }

    // Determine which groups of filters are currently active
    const operationsActive = state.currentAnalyticsKeys.size > 0;
    const industriesActive = state.currentIndustries.size > 0;
    const bothActive       = operationsActive && industriesActive;

    // ── Reset Operations button: active (coloured) only when filters are on ──
    const rab = d3.select("#reset-analytics-btn");
    rab.style("border",         operationsActive ? `1px solid ${c.accent}` : `1px solid ${c.border}`)
       .style("color",          operationsActive ? c.accent : c.muted)
       .style("cursor",         operationsActive ? "pointer" : "default")
       .style("opacity",        operationsActive ? "1" : "0.3")
       .style("pointer-events", operationsActive ? "auto" : "none");

    // ── Operations chips: highlight selected ones with a green background ──
    d3.selectAll("[data-ops-key]").each(function() {
      const key = this.getAttribute("data-ops-key");
      const label = this.getAttribute("data-label");
      const sel = state.currentAnalyticsKeys.has(key);
      d3.select(this)
        .text(sel ? `${label}` : label)
        .attr("aria-pressed", sel ? "true" : "false")
        .style("background", sel ? (state.isDark ? "rgba(78,204,163,0.2)" : "rgba(0,169,79,0.15)") : (state.isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"))
        .style("color",      sel ? c.accent : c.muted)
        .style("border",     sel ? `1px solid ${c.accent}` : `1px solid ${c.border}`);
    });

    // ── AND/OR toggle: greyed out unless at least one industry is included ──
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

    // ── Reset Industry button: active only when industry filters are on ──
    const rib = d3.select("#reset-industry-btn");
    rib.style("border",         industriesActive ? `1px solid ${c.accent}` : `1px solid ${c.border}`)
       .style("color",          industriesActive ? c.accent : c.muted)
       .style("cursor",         industriesActive ? "pointer" : "default")
       .style("opacity",        industriesActive ? "1" : "0.3")
       .style("pointer-events", industriesActive ? "auto" : "none");

    // ── Industry chips: green for include, red for exclude, grey for inactive ──
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
        // Inactive chip
        bg = state.isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)";
        color = c.muted;
        border = `1px solid ${c.border}`;
        prefix = "";
      }
      d3.select(this).text(`${prefix}${label}`).attr("aria-pressed", status === "include" || status === "exclude" ? "true" : "false").style("background", bg).style("color", color).style("border", border);
    });

    // ── "Reset All" button: only lit up when BOTH filter types are active ──
    const rall = d3.select("#reset-all-btn");
    rall.style("border",         `1px solid ${bothActive ? c.accent : c.border}`)
        .style("color",          bothActive ? c.accent : c.muted)
        .style("cursor",         bothActive ? "pointer" : "default")
        .style("opacity",        bothActive ? "1" : "0.35")
        .style("pointer-events", bothActive ? "auto" : "none");

    d3.select("#industry-selector").style("opacity", "1").style("pointer-events", "auto");
  }

  // ─── SECTION 17: GLOBAL UI UPDATE ────────────────────────────────────────
  //  Called whenever the dark/light theme changes (or on initial load).
  //  Reapplies all colours throughout the UI, then rebuilds/refreshes controls.
  function updateUI() {
    invalidateColourCache(); // Force fresh colours for the new theme
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
        pillEl.style("display", "none"); // Pill hidden when sheet is open
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

    // Apply colours to the info panel, legend box, tooltip, and control buttons
    infoSidebar.style("background", c.surface).style("border-left", `1px solid ${c.border}`);
    themeToggle.text(state.isDark ? "☼" : "☾"); // Moon for light mode (click to go dark); sun for dark mode
    legendOverlay.style("background", state.isDark ? "rgba(22,27,36,0.8)" : "rgba(255,255,255,0.9)").style("border", `1px solid ${c.border}`);
    tooltip.style("background", c.surface).style("color", c.text).style("border", `1px solid ${c.border}`).style("box-shadow", state.isDark ? "0 10px 30px rgba(0,0,0,0.5)" : "0 10px 30px rgba(0,0,0,0.1)");

    // Hover highlight effect on all control panel buttons
    [themeToggle, zoomInBtn, zoomOutBtn, homeBtn, infoBtn, resetFiltersBtn].forEach(btn => {
      btn
        .style("background", c.surface)
        .style("color",      c.text)
        .style("border",     `1px solid ${c.border}`)
        .on("mouseenter", function() { d3.select(this).style("border", `1px solid ${c.accent}`).style("transform", "scale(1.08)"); })
        .on("mouseleave", function() { d3.select(this).style("border", `1px solid ${c.border}`).style("transform", "scale(1)"); });
    });

    // Re-apply grid layout and legend height in case orientation changed
    controlPanel.style("grid-template-columns", isLandscapeMobile() ? "1fr 1fr" : "1fr");
    legendOverlay.style("height", isMobile() ? "144px" : null);

    buildControlsDOM();        // Build the sidebar controls if not already built
    refreshControlsState();    // Apply current filter state to chip appearances

    updateSidebarDetail();     // Re-render detail panel in new theme colours (if a region is selected)
    updateSidebarToggle();     // Ensure sidebar open/close state is visually correct
  }

  // ─── SECTION 18: FILTER ACTIONS ──────────────────────────────────────────

  // Resets ALL filters (both Operations and Industries) and redraws the map.
  function clearAllFilters() {
    state.currentAnalyticsKeys.clear();
    state.currentIndustries.clear();
    // industryFilterMode is intentionally NOT reset — it's a UX preference, not a filter
    renderMap();
    refreshControlsState();
    if (state.selectedFeature) updateSidebarDetail();
    announceFilterUpdate();
  }
  
  // Re-renders the map and refreshes filter chips after any filter change.
  // Also refreshes the detail panel so the donut chart and counts stay in sync.
  function applyFilterAndCheckZoom() {
    renderMap();
    refreshControlsState();
    if (state.selectedFeature) updateSidebarDetail();
    announceFilterUpdate();
  }

  // ─── SECTION 19: MAP APPEARANCE RESTORE ──────────────────────────────────
  //  Restores all map regions to full opacity and normal styling,
  //  and clears the selected region. Does NOT zoom out — used when clicking
  //  the "Close Census Division Details" / ✕ button.
  function restoreMapAppearance() {
    const c = getC();
    const wasSelected = !!state.selectedFeature;
    state.selectedFeature = null;
    d3.select("#legend-marker").style("display", "none");
    // Re-enable the operations/industry selectors (they may have been locked)
    d3.select("#analytics-selector").property("disabled", false).style("opacity", "1").style("cursor", "pointer");
    d3.select("#industry-selector").style("pointer-events", "auto").style("opacity", "1");
    // Animate all regions back to full opacity with their default border
    mapGroup.selectAll("path.cd-region")
      .transition().duration(750)
      .style("opacity", 1)
      .attr("stroke", c.bg)
      .attr("stroke-width", 0.5);
    // On mobile, close the bottom sheet when a region is deselected
    if (isMobile()) {
      state.sidebarOpen = false;
      updateSidebarToggle();
    }
    updateSidebarDetail(); // Reverts detail panel to the "select a region" prompt
  }

  // Clears the selected region AND zooms out to the full-Canada view.
  // Used by the Home (⌂) button when a region is selected.
  function resetView() {
    restoreMapAppearance();
    zoomToFull();
  }

  // ─── SECTION 20: RESIZE HANDLER ──────────────────────────────────────────
  //  On viewport width changes we only do a full teardown-and-rebuild when the
  //  mobile/desktop breakpoint is crossed (≤768 px). Simple resizes within the
  //  same layout tier just re-apply styles and re-render the map, which is much
  //  cheaper. 150 ms debounce collapses the burst of events during rotation.
  let _lastWidth  = window.innerWidth;
  let _lastIsMobile = isMobile();
  let _resizeTimer = null;

  function _doRebuild() {
    const nowMobile = isMobile();
    const crossedBreakpoint = nowMobile !== _lastIsMobile;
    _lastWidth   = window.innerWidth;
    _lastIsMobile = nowMobile;

    if (crossedBreakpoint) {
      // Full teardown required: layout structure differs between mobile and desktop
      controlsDiv.selectAll("*").remove();
      _controlsBuilt = false;
    }

    updateUI();
    renderMap();
  }

  window.addEventListener("resize", () => {
    if (window.innerWidth === _lastWidth) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(_doRebuild, 150);
  });

  if (screen?.orientation) {
    screen.orientation.addEventListener("change", () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(_doRebuild, 150);
    });
  }

  // ─── SECTION 21: KEYBOARD SHORTCUTS ──────────────────────────────────────
  // Escape: deselect the active region (mirrors the ✕ / Close button).
  //         Does NOT zoom out — use the ⌂ Home button to reset the view.
  // Enter / Space: when hovering a region with the mouse, activate it as if clicked.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Esc") {
      if (state.selectedFeature) restoreMapAppearance();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const d = state.hoveredFeature;
      if (!d) return;
      event.preventDefault();
      if (!hasAnyData(d)) { restoreMapAppearance(); return; }
      state.selectedFeature = d;
      const selVal = getFilteredValue(d);
      updateLegendMarker(selVal > 0 ? selVal : null, true);
      if (!state.sidebarOpen) { state.sidebarOpen = true; updateSidebarToggle(); }
      mapGroup.selectAll("path.cd-region").style("opacity", 0.35).attr("stroke", getC().bg);
      // Highlight the hovered path element directly
      mapGroup.selectAll("path.cd-region")
        .filter(p => p === d)
        .style("opacity", 1).attr("stroke", getC().accent2).attr("stroke-width", 2).raise();
      zoomToFeature(d);
      updateSidebarDetail();
      tooltip.style("visibility", "hidden");
    }
  });

  // ─── SECTION 22: APPLICATION STARTUP ─────────────────────────────────────
  //  With all functions defined, kick off the application by:
  //    1. Building the UI (colours, controls, sidebar)
  //    2. Drawing the initial map
  updateUI();
  renderMap();
  
})(); // The outer function is invoked immediately — the map loads as soon as the script runs
