
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

  // Assign a power-of-two bit to each industry key so filter checks can use
  // bitwise AND instead of iterating through a Set on every facility.
  // e.g. Aircraft=1, CnISR=2, Land Sys=4, Marine=8 …
  const INDUSTRY_BITS = Object.fromEntries(
    Object.keys(INDUSTRY_KEYS).map((k, i) => [k, 1 << i])
  );

  // Transform every row in the CSV into a structured facility object.
  // Each object stores:
  //   - id          : a unique index number
  //   - cduid       : the Census Division ID — links this facility to a map region
  //   - isMfg       : is this a defence manufacturing facility
  //   - isTech      : is this a value-add / defence technology facility
  //   - isMro       : is this a defence maintenance, repair, and overhaul facility
  //   - isDefence   : is this a general facility count
  //   - industryMask: bitmask of defence industry sectors (replaces Set for fast filtering)
  //   - industries  : Set of industry keys (still used for donut chart data)
  //   - rawRow      : the original CSV row (kept for sub-category drill-downs)
  const allFacilities = rawCsv.map((row, index) => {
    const facility = {
      id: index,
      cduid: row.CDUID?.toString().trim(),
      isMfg: isTrue(row.Manuf),
      isTech: isTrue(row["Value-Add"]),
      isMro: isTrue(row["MRO/ISS"]),
      isDefence: isTrue(row.General),
      industryMask: 0,
      industries: new Set(),
      rawRow: row
    };

    // Check each industry column, populate both the Set (for chart data) and the bitmask (for filtering)
    Object.keys(INDUSTRY_KEYS).forEach(ind => {
      if (isTrue(row[ind])) {
        facility.industries.add(ind);
        facility.industryMask |= INDUSTRY_BITS[ind];
      }
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
    sidebarOpen: Math.min(window.innerWidth, window.innerHeight) > 768, // Closed on mobile, open on desktop
    isPanning: false,                  // Whether the user is actively panning/dragging the map
	isZooming: false, 				   // Whether the user is actively zooming in the map
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
  // Cached predicate from the last buildFilterPredicate() call. Shared between
  // getFilteredValue (cache builder) and updateSidebarDetail so the predicate is
  // never constructed twice within the same render pass.
  let _cachedPredicate = null;
  function invalidateFilteredValueCache() { _filteredValueCache = null; _cachedPredicate = null; }

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

    // Build include/exclude bitmasks once per render pass — replaces per-facility
    // Set.has() iteration with a pair of fast bitwise AND operations.
    let includeMask = 0;
    let excludeMask = 0;
    if (industriesActive) {
      for (const [ind, status] of state.currentIndustries) {
        if (status === "include") includeMask |= (INDUSTRY_BITS[ind] ?? 0);
        if (status === "exclude") excludeMask |= (INDUSTRY_BITS[ind] ?? 0);
      }
    }
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
        // Exclude check: any excluded industry bit set on this facility → reject
        if (excludeMask && (f.industryMask & excludeMask)) return false;
        // Include check: bitwise AND/OR against includeMask
        if (includeMask) {
          const passes = mode === "and"
            ? (f.industryMask & includeMask) === includeMask  // all bits must match
            : (f.industryMask & includeMask) !== 0;           // any bit must match
          if (!passes) return false;
        }
      }

      return true;
    };
  }

  function getFilteredValue(feature) {
    // Build the cache on first call within a render pass.
    // _cachedPredicate is stored alongside so updateSidebarDetail can reuse it
    // without calling buildFilterPredicate() a second time.
    if (!_filteredValueCache) {
      _cachedPredicate = buildFilterPredicate();
      _filteredValueCache = new Map();
      for (const f of allFacilities) {
        if (!_cachedPredicate(f)) continue;
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
		.on("touchstart", function(event) {
		  const t = event.touches[0];
		  this._tapStartX = t.clientX;
		  this._tapStartY = t.clientY;
		}, { passive: true })
		.on("touchend", function(event) {
		  const t = event.changedTouches[0];
		  const dx = Math.abs(t.clientX - (this._tapStartX ?? t.clientX));
		  const dy = Math.abs(t.clientY - (this._tapStartY ?? t.clientY));
		  if (dx > 8 || dy > 8) return; // finger moved — it was a scroll, not a tap
		  event.preventDefault();
		  fn.call(this, event);
		})
		.on("click", function(event) {
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
  // Layout mode is fixed at page load and never changes during the session.
  // This prevents the mobile/desktop layout from switching mid-use when the
  // browser window is resized across the 768px breakpoint.
  const _setupMobile = Math.min(window.innerWidth, window.innerHeight) <= 768;
  const isMobile = () => _setupMobile;
  const isLandscapeMobile = () => _setupMobile && window.innerWidth > window.innerHeight;

  // Returns true on desktop when the viewport is too short to comfortably
  // display the donut chart and the Facility Operations Type accordion stacked.
  // 680 px is enough to fit both; below that we switch to a side-by-side layout.
  // Also returns true for landscape mobile — the bottom sheet is always too short
  // in landscape to stack these elements comfortably.
  const SIDEBAR_SHORT_THRESHOLD = 680;
  const isSidebarShort = () =>
    isLandscapeMobile() ||
    (!_setupMobile && window.innerHeight < SIDEBAR_SHORT_THRESHOLD);

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
    .btn-wrap { position: relative; display: inline-flex; border-radius: 8px; align-self: start; }
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
    /* Suppress the browser's default square :focus outline on control-panel buttons.
       Keyboard users still get the green ring via :focus-visible below. */
    #control-panel button:focus {
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

  // ── CSS custom-property theme tokens ──────────────────────────────────────
  // Injected once at startup.  All static chrome (sidebar, buttons, tooltip,
  // legend overlay, info panel) reads these variables via CSS rules rather than
  // receiving inline-style mutations on every theme change.  The only values
  // that still need to be written programmatically are the ones D3 must set
  // based on data (choropleth fill, selected-region stroke, etc.) — those
  // continue to use getC() as before.
  const themeStyleEl = document.createElement("style");
  themeStyleEl.id = "theme-vars";
  themeStyleEl.textContent = `
    :root {
      --bg:           #f8f9fa;
      --surface:      #ffffff;
      --border:       rgba(0,0,0,0.08);
      --text:         #1a1a1a;
      --muted:        #717171;
      --accent:       #00a94f;
      --accent2:      #d97706;
      --no-data:      #adb1ba;
      --no-data-none: #e0e2e6;
      --shadow-sm:    0 10px 30px rgba(0,0,0,0.1);
      --legend-bg:    rgba(255,255,255,0.9);
    }
    body.dark {
      background-color: #0e1117;
      --bg:           #0e1117;
      --surface:      #161b24;
      --border:       rgba(255,255,255,0.1);
      --text:         #e8eaf0;
      --muted:        #6b7280;
      --accent2:      #f0a500;
      --no-data:      #2a3040;
      --no-data-none: #191d25;
      --shadow-sm:    0 10px 30px rgba(0,0,0,0.5);
      --legend-bg:    rgba(22,27,36,0.8);
    }

    /* ── Chrome elements wired to tokens ── */
    body {
      background-color: #f8f9fa; /* ensures removing body.dark fully resets the background */
    }
    #map-container {
      background: var(--bg);
      color: var(--text);
      transition: background 0.3s ease;
    }
    /* Sidebar */
    #map-container > div > div:first-child {
      background: var(--surface);
      transition: background 0.3s ease, border 0.3s ease;
    }
    /* Control panel buttons */
    #control-panel button {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      transition: background 0.15s ease, color 0.15s ease, border 0.15s ease, transform 0.2s ease;
    }
    #control-panel button:hover {
      border-color: var(--accent);
      transform: scale(1.08);
    }
    /* Tooltip — appended to <body>, so selector must not be scoped to #map-container */
    .map-tooltip {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-sm);
    }
    /* Legend overlay */
    .legend-overlay {
      background: var(--legend-bg);
      border: 1px solid var(--border);
      transition: background 0.3s ease, border 0.3s ease;
    }
    /* Info sidebar */
    .info-sidebar {
      background: var(--surface);
      border-left: 1px solid var(--border);
      transition: background 0.3s ease, border 0.3s ease;
    }
  `;
  document.head.appendChild(themeStyleEl);

  // Helper: reads a CSS custom property value from :root (used when D3 needs
  // a token value for data-driven attributes such as stroke colours).
  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

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
  const btnSize   = _setupMobile ? "44px" : "40px";
  const btnPad    = _setupMobile ? "10px 14px" : "8px 12px";
  const btnFontSz = _setupMobile ? "16px" : "14px";

  // Briefly flashes a button with the accent colour so the user gets tactile
  // feedback that their tap/click registered.
  // flashBtn: immediately paints the button accent, then restores after 220 ms.
  // Pass skipRestore=true when the caller's updateUI/renderMap will repaint the
  // button — otherwise the setTimeout would restore stale pre-theme-flip colours.
  function flashBtn(btn) {
    const c = getC();
    btn.style("background", c.accent).style("color", "#fff").style("border", `1px solid ${c.accent}`);
    // Always clear the inline styles after the flash so the CSS rule (var(--surface) etc.)
    // takes back control. Previously, skipRestore=true was passed by the theme toggle
    // expecting updateUI() to repaint the button — but updateUI() no longer writes
    // inline styles to #control-panel buttons, so the green would stick permanently.
    setTimeout(() => {
      btn.style("background", null).style("color", null).style("border", null);
    }, 220);
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

  // "ⓘ" — opens/closes the "About this map" info panel.
  // Uses a plain italic "i" instead of the ⓘ Unicode character, which on many
  // platforms/fonts renders its enclosing ring as a visible square outline.
  const infoBtn = makeBtn("ⓘ", "About this map");
  onTap(infoBtn, function() {
    flashBtn(d3.select(this));
    state.infoOpen = !state.infoOpen;
    infoSidebar.style("transform", state.infoOpen ? "translateX(0)" : "translateX(100%)");
  });

  // "☾" / "☼" — toggles between dark mode and light mode
  const themeToggle = makeBtn("☾", "Toggle light / dark mode");
  onTap(themeToggle, function() {
    flashBtn(d3.select(this));
    state.isDark = !state.isDark;
    // One classList toggle flips all CSS-variable-driven chrome in one paint.
    // updateUI still runs to handle mobile pill / collapseBtn / legend colours
    // and to rebuild any controls that depend on getC().
    document.body.classList.toggle("dark", state.isDark);
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
  const resetFiltersBtn = makeBtn("⟳", "Reset all filters");
  onTap(resetFiltersBtn, function() {
    flashBtn(d3.select(this));
    clearAllFilters();
  });

  // "+" / "−" — zoom buttons; hidden on mobile (users pinch-to-zoom instead)
  const zoomInBtn  = makeBtn("+", "Zoom in")
    .style("display", _setupMobile ? "none" : null)
    .style("font-weight", "600")
    .on("click", function() {
      flashBtn(d3.select(this));
      svg.transition().duration(350).call(zoom.scaleBy, 1.5);
    });
  const zoomOutBtn = makeBtn("−", "Zoom out")
    .style("display", _setupMobile ? "none" : null)
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
    .style("z-index", _setupMobile ? "110" : "10")
    .style("position", _setupMobile ? "absolute" : "relative");

  const CLOSE_RATIO      = 0.35;
  const FULLSCREEN_RATIO = 0.70; // drag above this fraction of viewport → snap to top
  // Default open height: shorter in landscape so the map stays usable
  const DEFAULT_H_RATIO  = () => isLandscapeMobile() ? 0.50 : 0.60;

  // Full height: reaches the top of the screen, just inside the safe area.
  // The sheet sits above the control panel buttons (z-index raised to 110).
  function getMaxSheetH() {
    const safeTop = 12; // mirrors the control panel's top offset
    return window.innerHeight - safeTop;
  }

  if (_setupMobile) {
    // On mobile: full-width panel anchored to the bottom of the screen,
    // initially hidden below the viewport (translateY(100%)).
    sidebar
      .style("width", "100%")
      .style("height", (window.innerHeight * DEFAULT_H_RATIO()) + "px")
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
    .style("height", _setupMobile ? null : "100%")
    .style("flex", _setupMobile ? "1 1 auto" : null)
    .style("overflow-y", _setupMobile ? "auto" : null)
    .style("padding",    _setupMobile ? "0 18px 18px" : null)
    .style("box-sizing", "border-box");

  // The collapse/expand control differs between mobile and desktop:
  //  • Mobile:  a drag handle bar at the top of the bottom sheet
  //  • Desktop: a small circular ◀/▶ button at the edge of the sidebar
  let collapseBtn;

  // Mobile bottom-sheet drag state — hoisted here so updateSidebarToggle,
  // restoreMapAppearance, and the ✕ handler can all access them.
  let dragStartY      = null;
  let dragStartH      = null;
  let _userSetHeight  = null;  // last height user dragged to; null = use default
  let _isFullscreen   = false; // true when sheet is snapped to full height
  let _dragRafPending = false;

  if (_setupMobile) {
    // Touch-draggable handle bar at the top of the mobile bottom sheet.
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
      .style("padding", "10px 12px")
      .style("cursor", "pointer")
      .style("color", "inherit")
      .style("touch-action", "auto")
      .on("touchstart", event => event.stopPropagation(), { passive: true })
      .on("click", () => {
        if (state.selectedFeature) {
          // Recentre on the selected region using the full screen height (sheet closing),
          // then clear the selection so the map shows the area without highlighting.
          const feat = state.selectedFeature;
          _isFullscreen = false;
          state.sidebarOpen = false;
          updateSidebarToggle();
          // Small delay so the sheet slide-out animation has started before we zoom
          setTimeout(() => {
            const svgNode = svg.node();
            const w = svgNode ? svgNode.clientWidth : WIDTH;
            const h = svgNode ? svgNode.clientHeight : HEIGHT;
            const [[x0, y0], [x1, y1]] = path.bounds(feat);
            const dx = x1 - x0; const dy = y1 - y0;
            const legendNode2  = legendOverlay.node();
            const legendRect2  = legendNode2 ? legendNode2.getBoundingClientRect() : null;
            const svgTop2      = svgNode ? svgNode.getBoundingClientRect().top : 0;
            const legendBottom = legendRect2 ? legendRect2.bottom - svgTop2 + 8 : 164;
            const safeTop      = Math.min(legendBottom, h * 0.5);
            const safeH        = h - safeTop;
            // In landscape safeH starts below a tall legend, so the midpoint
            // sits too low — weight toward the upper third instead.
            const centreFrac   = isLandscapeMobile() ? 0.35 : 0.5;
            const safeCentreY  = safeTop + safeH * centreFrac;
            const currentScale = d3.zoomTransform(svg.node()).k;
            const targetScale  = Math.min(12, 0.70 / Math.max(dx / w, dy / safeH));
            const scale        = Math.max(currentScale, targetScale);
            const tx = w / 2 - scale * ((x0 + x1) / 2);
            const ty = safeCentreY - scale * ((y0 + y1) / 2);
            svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
            restoreMapAppearance();
          }, 80);
        } else {
          _isFullscreen = false;
          state.sidebarOpen = false;
          updateSidebarToggle();
        }
      });


	// Attach drag to the whole handleWrap for a generous ~26px touch target
	handleWrap.on("touchstart", function(event) {
	  dragStartY = event.touches[0].clientY;
	  dragStartH = sidebar.node().getBoundingClientRect().height;
	  sidebar.style("transition", "background 0.3s ease, border 0.3s ease");
	  event.preventDefault();
	}, { passive: false });

	handleWrap.on("touchmove", function(event) {
	  if (dragStartY === null) return;
	  if (_dragRafPending) return; // Already have a frame queued — skip this event
	  _dragRafPending = true;

	  const dy   = event.touches[0].clientY - dragStartY;
	  const newH = Math.min(Math.max(dragStartH - dy, 40), getMaxSheetH());

	  requestAnimationFrame(() => {
		sidebar.style("height", newH + "px");
		_dragRafPending = false;
	  });

	  event.preventDefault();
	}, { passive: false });

	handleWrap.on("touchend", function(event) {
	  if (dragStartY === null) return;
	  const curH = sidebar.node().getBoundingClientRect().height;
	  const scrH = window.innerHeight;
	  sidebar.style("transition", "transform 0.35s ease, height 0.35s ease, background 0.3s ease, border 0.3s ease");
	  if (curH < scrH * CLOSE_RATIO) {
		// Below close threshold: forget user height, reset to default, close
		_userSetHeight = null;
		_isFullscreen  = false;
		sidebar.style("height", (scrH * DEFAULT_H_RATIO()) + "px");
		state.sidebarOpen = false;
		// Sliding the sheet down: recentre on the selected region then clear it
		if (state.selectedFeature) {
		  const feat = state.selectedFeature;
		  setTimeout(() => {
		    const svgNode = svg.node();
		    const w = svgNode ? svgNode.clientWidth : WIDTH;
		    const h = svgNode ? svgNode.clientHeight : HEIGHT;
		    const [[x0, y0], [x1, y1]] = path.bounds(feat);
		    const dx = x1 - x0; const dy = y1 - y0;
		    // Legend is top-left; keep region centre below it when recentring after close
		    const legendNode2  = legendOverlay.node();
		    const legendRect2  = legendNode2 ? legendNode2.getBoundingClientRect() : null;
		    const svgTop2      = svgNode ? svgNode.getBoundingClientRect().top : 0;
		    const legendBottom = legendRect2 ? legendRect2.bottom - svgTop2 + 8 : 164;
		    const safeTop      = Math.min(legendBottom, h * 0.5);
		    const safeH        = h - safeTop;
		    // In landscape safeH starts below a tall legend, so the midpoint
		    // sits too low — weight toward the upper third instead.
		    const centreFrac  = isLandscapeMobile() ? 0.35 : 0.5;
		    const safeCentreY = safeTop + safeH * centreFrac;
		    const currentScale = d3.zoomTransform(svg.node()).k;
		    const targetScale  = Math.min(12, 0.70 / Math.max(dx / w, dy / safeH));
		    const scale        = Math.max(currentScale, targetScale);
		    const tx = w / 2 - scale * ((x0 + x1) / 2);
		    const ty = safeCentreY - scale * ((y0 + y1) / 2);
		    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
		    restoreMapAppearance();
		  }, 80);
		}
	  } else if (curH >= scrH * FULLSCREEN_RATIO) {
		// Above fullscreen threshold: snap to top
		_isFullscreen  = true;
		_userSetHeight = null;
		sidebar.style("height", getMaxSheetH() + "px");
		state.sidebarOpen = true;
	  } else {
		// User settled at custom height — remember it
		_isFullscreen  = false;
		_userSetHeight = curH;
		state.sidebarOpen = true;
	  }
	  dragStartY = null;
	  dragStartH = null;
	  _dragRafPending = false; // Clear any pending flag on gesture end
	  updateSidebarToggle();
	});

    // Floating "▲ FILTERS" pill button at the bottom of the map.
    // Only visible when the bottom sheet is closed, giving users a clear way
    // to reopen it.
    collapseBtn = container.append("button")
      .attr("id", "mobile-filter-toggle")
      .text("▲  FILTERS");
    onTap(collapseBtn, () => {
      const opening = !state.sidebarOpen;
      state.sidebarOpen = opening;
      updateSidebarToggle();
      // When opening via the pill, scroll back to the top of the controls so the
      // user sees the filters rather than wherever the panel was last scrolled to.
      if (opening) {
        const scrollEl = sidebarInnerContent.node();
        if (scrollEl) scrollEl.scrollTop = 0;
      }
    });
  } else {
    // Desktop: small circular button positioned at the right edge of the sidebar.
    // Shows ◀ when open (click to collapse) and ▶ when closed (click to expand).
    // Colours are set explicitly here and kept in sync by updateUI() — this button
    // sits outside #control-panel so the shared CSS rule doesn't reach it.
    collapseBtn = mainWrapper.append("button")
      .style("position", "absolute")
      .style("top", "24px")
      .style("left", `${SIDEBAR_WIDTH - 16}px`)
      .style("width", "40px")
      .style("height", "40px")
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
    .attr("class", "info-sidebar")
    .style("position", "absolute")
    .style("top", "0")
    .style("right", "0")
    .style("width", _setupMobile ? "min(92vw, 360px)" : "300px")
    .style("height", "100%")
    .style("padding", _setupMobile ? "24px 18px" : "30px 24px")
    .style("overflow-y", "auto")
    .style("z-index", "200")
    .style("box-shadow", "-4px 0 20px rgba(0,0,0,0.15)")
    .style("transform", "translateX(100%)")           // starts off-screen to the right
    .style("transition", "transform 0.4s ease")       // background/border handled by CSS tokens
    .style("box-sizing", "border-box");
  
  // Alias for clarity — infoSidebar and infoModal are the same element
  const infoModal = infoSidebar;

  // The hover tooltip that follows the mouse cursor over map regions.
  // Initially hidden; shown on mouseover events in renderMap().
  // Colours are applied via the .map-tooltip CSS rule (theme tokens).
  const tooltip = d3.select("body").append("div")
    .attr("class", "map-tooltip")
    .style("position", "absolute")
    .style("visibility", "hidden")
    .style("padding", "10px 14px")
    .style("border-radius", "2px")
    .style("font-size", "12px")
    .style("pointer-events", "none")      // Tooltip never intercepts mouse clicks
    .style("font-family", "'Inter', sans-serif")
    .style("z-index", "1000");
  // Cached tooltip dimensions — updated on mouseover when content changes.
  // Avoids offsetWidth/offsetHeight reads (forced layout) inside the mousemove rAF.
  const _tipSize = { w: 200, h: 50 };

  // On desktop only: show a tooltip label when hovering the collapse/expand button
  if (!_setupMobile) {
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
    .style("transition", "width 0.4s ease, flex 0.4s ease");
  
  // The SVG element where D3 draws all the geographic regions.
  // viewBox makes it resolution-independent; it scales to fill its container.
  const svg = mapContainer.append("svg")
  .style("width", "100%")
  .style("height", "100%")
  .style("shape-rendering", "geometricPrecision")
  .style("touch-action", "none")  // Required for D3 zoom to receive touch events in Firefox
  .on("click", () => {});

  // A <g> group element that all map paths are drawn into.
  // D3 zoom transforms are applied to this group rather than the whole SVG,
  // so the buttons and legend (outside this group) stay fixed in place.
  const mapGroup = svg.append("g");

  // Cached D3 selection of all Census Division <path> elements.
  // Assigned inside renderMap() after the .join() call and reused everywhere
  // else that previously called mapGroup.selectAll("path.cd-region") directly —
  // avoiding redundant DOM queries on every interaction.
  let cdPaths = mapGroup.selectAll("path.cd-region"); // empty selection before first render

  // The legend overlay box (bottom-right on desktop, top-left on mobile).
  // Shows the colour scale and swatch key for the choropleth.
  // On mobile the legend top matches the control panel (max(12px,...)) and its
  // Mobile legend height = 3 buttons × 44px + 2 gaps × 6px, same in both portrait and landscape
  const _legendH = _setupMobile ? "144px" : null;
  const legendOverlay = mapContainer.append("div")
    .attr("class", "legend-overlay")
    .style("position", "absolute")
    .style("bottom", _setupMobile ? null : "30px")
    .style("top",    _setupMobile ? "max(12px, env(safe-area-inset-top, 12px))" : null)
    .style("left",   _setupMobile ? "10px" : null)
    .style("right",  _setupMobile ? null   : "30px")
    .style("height", _legendH)
    .style("backdrop-filter", "blur(15px)")
    .style("padding", _setupMobile ? "10px 12px" : "20px")
    .style("border-radius", "6px")
    .style("min-width", _setupMobile ? null : "260px")
    .style("max-width", _setupMobile ? "calc(100vw - 80px)" : null)
    .style("box-sizing", "border-box")
    .style("overflow", "hidden");

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

  // ─── SECTION 11: ZOOM AND PANNING CONFIGURATION ───────────────────────────

	let tickPending = false; // Flag to check if an animation frame is already requested
	let _mousemoveRafPending = false; // Flag to throttle tooltip repositioning on mousemove

	const zoom = d3.zoom()
		.scaleExtent([1, 40])
		.on("start", (event) => {
		  if (event.sourceEvent) {
			const src = event.sourceEvent.type;
			if (src === "mousedown" || src === "touchstart") {
			  state.isPanning = true;
			} else {
			  state.isZooming = true;
			}
		  }
		  tooltip.style("visibility", "hidden");
		})
		.on("zoom", (event) => {
		  // Apply as a CSS transform rather than an SVG attribute transform.
		  // Chrome composites CSS transforms on the GPU; SVG attribute transforms
		  // are processed on the main thread through the SVG renderer every frame.
		  const { x, y, k } = event.transform;
		  mapGroup.style("transform", `translate(${x}px,${y}px) scale(${k})`);
		  mapGroup.style("transform-origin", "0 0");
		})
		.on("end", () => {
		  state.isZooming = false;
		  state.isPanning = false;
		});

  // Attach the zoom behavior to the SVG canvas
  svg.call(zoom);

  //  When provided a feature (i.e. a census division is pressed), calculate and provide the map position to zoom into.
  function zoomToFeature(feature) {
    const svgNode = svg.node();
    const w = svgNode ? svgNode.clientWidth  : WIDTH;
    const h = svgNode ? svgNode.clientHeight : HEIGHT;
    const [[x0, y0], [x1, y1]] = path.bounds(feature);
    const dx = x1 - x0; const dy = y1 - y0;

    if (isMobile()) {
      // Measure the legend's actual rendered bottom so landscape (short viewport)
      // is handled correctly — the fixed 144px is only valid in portrait.
      const legendNode   = legendOverlay.node();
      const legendRect   = legendNode ? legendNode.getBoundingClientRect() : null;
      const svgTop       = svgNode ? svgNode.getBoundingClientRect().top : 0;
      const legendBottom = legendRect ? legendRect.bottom - svgTop + 8 : 164;

      const sheetH   = window.innerHeight * DEFAULT_H_RATIO();
      const visibleH = h - sheetH;   // px of map above the sheet

      // If the legend nearly fills the visible strip (common in landscape),
      // fall back to centring in the full visible strip.
      const safeTop     = Math.min(legendBottom, visibleH * 0.5);
      const safeH       = visibleH - safeTop;
      const safeCentreY = safeTop + safeH / 2;

      // Horizontal centre is always the full map width — the control panel and
      // legend only occupy corners and don't reduce the usable centre.
      const currentScale = d3.zoomTransform(svg.node()).k;
      const targetScale  = Math.min(12, 0.70 / Math.max(dx / w, dy / safeH));
      const scale        = Math.max(currentScale, targetScale);

      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const tx = w / 2 - scale * cx;
      const ty = safeCentreY - scale * cy;
      svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
      return;
    }

    const scale = Math.max(1, Math.min(150, 0.45 / Math.max(dx / w, dy / h)));
    const translate = [w / 2 - scale * ((x0 + x1) / 2), h / 2 - scale * ((y0 + y1) / 2)];
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
  }

  //  Reset the map back to the initial full-Canada view.
  //  The SVG fills its container in native pixels (no viewBox). We refit the
  //  projection to the container's current pixel size so Canada is always
  //  centred and fully visible, then clear the D3 zoom transform.
  function zoomToFull(animate) {
    const svgNode = svg.node();
    const w = svgNode ? svgNode.clientWidth  : WIDTH;
    const h = svgNode ? svgNode.clientHeight : HEIGHT;
    // Refit projection into actual pixel space with a small inset on each side
    projection.fitExtent([[10, 20], [w - 10, h - 20]], fixedData);
    // Redraw all paths using the updated projection
    // Always redraw — cdPaths.enter() is empty after the first render,
    // so the old guard prevented paths from ever updating after a projection refit.
    cdPaths.attr("d", path);
    // Clear any D3 zoom/pan transform — projection now handles the positioning
    if (animate === false) {
      svg.call(zoom.transform, d3.zoomIdentity);
    } else {
      svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
    }
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
        const h = _isFullscreen
          ? getMaxSheetH()
          : (typeof _userSetHeight === "number" ? _userSetHeight : (window.innerHeight * DEFAULT_H_RATIO()));
        sidebar.style("height", h + "px");
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
    // Desktop behaviour: animate the sidebar width and toggle the arrow icon.
    // When the viewport is short, double the sidebar width so the donut chart
    // and Facility Operations Type accordion can sit side-by-side.
    const effectiveWidth = isSidebarShort() ? SIDEBAR_WIDTH * 2 : SIDEBAR_WIDTH;
    if (state.sidebarOpen) {
      sidebar.style("width", `${effectiveWidth}px`).style("padding", "30px 24px");
      sidebarInnerContent.style("display", "block");
      collapseBtn.text("◀").style("left", `${effectiveWidth - 16}px`);
    } else {
      sidebar.style("width", "30px").style("padding", "30px 0px");
      sidebarInnerContent.style("display", "none");
      collapseBtn.text("▶").style("left", "14px"); 
    }
  }

  // ─── SECTION 12: LEGEND RENDERING ────────────────────────────────────────

  // Draws the colour gradient legend bar with min/max labels, theme switcher
  // buttons, and a movable marker line that tracks the hovered/selected region.
  //
  // Performance note: on the first call this builds the skeleton DOM once.
  // On every subsequent call (theme change, filter change) it updates only the
  // *properties* that actually changed — colour stops, label text, button styles —
  // without destroying and recreating any nodes. This eliminates the full DOM
  // teardown that the old `legendOverlay.selectAll("*").remove()` triggered,
  // cutting GC pressure and avoiding a browser layout recalculation per update.
  function updateLegend(min, max, colourScale) {
    const c = getC();
    const BAR_WIDTH = isMobile()
      ? Math.max(80, Math.min(280, window.innerWidth - 80 - 24))
      : 280;
    const BAR_HEIGHT = 4;
    const gradId = "legend-grad";

    // ── First-call skeleton build ──────────────────────────────────────────
    // Guard flag stored on the overlay node so we build the skeleton exactly once.
    // We also clear any leftover content from updateLegendEmpty() before appending,
    // since that function leaves unkeyed nodes that would stack with the new skeleton.
    if (!legendOverlay.node()._legendBuilt) {
      legendOverlay.node()._legendBuilt = true;
      legendOverlay.selectAll("*").remove(); // clear "no match" state before rebuilding

      // Section heading
      legendOverlay.append("div")
        .attr("id", "legend-heading")
        .style("font-size", "10px")
        .style("font-weight", "600")
        .style("letter-spacing", "1.2px")
        .style("margin-bottom", isMobile() ? "6px" : "12px")
        .text("DEFENCE FACILITY COUNT");

      // SVG bar
      const svgL = legendOverlay.append("svg")
        .attr("id", "legend-bar-svg")
        .attr("width", BAR_WIDTH)
        .attr("height", 24)
        .style("display", "block");

      const grad = svgL.append("defs").append("linearGradient").attr("id", gradId);
      // Three colour-stop placeholders; offsets are fixed, colours are updated below
      [0, 0.5, 1].forEach((t, i) =>
        grad.append("stop").attr("class", `legend-stop-${i}`).attr("offset", `${t * 100}%`)
      );

      svgL.append("rect")
        .attr("width", BAR_WIDTH).attr("height", BAR_HEIGHT).attr("rx", 2)
        .style("fill", `url(#${gradId})`);

      svgL.append("text").attr("id", "legend-label-min")
        .attr("x", 0).attr("y", BAR_HEIGHT + 15)
        .style("font-size", "11px");

      svgL.append("text").attr("id", "legend-label-max")
        .attr("x", BAR_WIDTH).attr("y", BAR_HEIGHT + 15)
        .attr("text-anchor", "end")
        .style("font-size", "11px");

      // Marker group (hidden until a region is hovered/selected)
      const markerG = svgL.append("g").attr("id", "legend-marker").style("display", "none");
      markerG.append("line")
        .attr("id", "legend-marker-line")
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", -4).attr("y2", BAR_HEIGHT + 4)
        .attr("stroke-width", 2)
        .attr("stroke-linecap", "round")
        .style("filter", "drop-shadow(0 0 2px rgba(0,0,0,0.6))");
      markerG.append("text")
        .attr("id", "legend-marker-label")
        .attr("y", BAR_HEIGHT + 28)
        .attr("text-anchor", "middle")
        .style("font-size", "10px")
        .style("font-weight", "600")
        .style("font-family", "'Inter', sans-serif");

      // Swatch rows
      const swatchDiv = legendOverlay.append("div")
        .attr("id", "legend-swatches")
        .style("margin-top", isMobile() ? "2px" : "4px");

      [
        { id: "swatch-filter", label: "No defence facilities with the current filters" },
        { id: "swatch-none",   label: "No defence facilities recorded"                 },
      ].forEach(({ id, label }) => {
        const row = swatchDiv.append("div")
          .style("display", "flex").style("align-items", "flex-start")
          .style("gap", "8px").style("margin-bottom", isMobile() ? "3px" : "6px");
        row.append("div")
          .attr("id", id)
          .style("width", "16px").style("min-width", "16px").style("height", "10px")
          .style("margin-top", "2px").style("border-radius", "2px");
        row.append("span")
          .style("font-size", "10px").style("color", c.muted)
          .style("line-height", "1.4").style("word-break", "break-word")
          .text(label);
      });

      // Theme switcher button row — use D3 join so buttons persist across renders
      legendOverlay.append("div")
        .attr("id", "legend-theme-row")
        .style("margin-top", isMobile() ? "15px" : "15px")
        .style("display", "flex")
        .style("justify-content", "space-between")
        .style("gap", "4px");
    }

    // ── Per-render property updates (no node creation) ─────────────────────

    // Heading colour
    legendOverlay.select("#legend-heading").style("color", c.muted);

    // Gradient colour stops
    const svgL = legendOverlay.select("#legend-bar-svg");
    svgL.attr("width", BAR_WIDTH); // update width in case of resize
    svgL.select("rect").attr("width", BAR_WIDTH);
    svgL.select("#legend-label-max").attr("x", BAR_WIDTH);

    [0, 0.5, 1].forEach((t, i) =>
      svgL.select(`.legend-stop-${i}`)
        .attr("stop-color", colourScale(min + t * (max - min)))
    );

    // Min / max labels
    svgL.select("#legend-label-min").style("fill", c.text).text(min.toLocaleString());
    svgL.select("#legend-label-max").style("fill", c.text).text(max.toLocaleString());

    // Marker label colour
    svgL.select("#legend-marker-label").style("fill", c.text);

    // Swatch colours
    legendOverlay.select("#swatch-filter").style("background", c.noData);
    legendOverlay.select("#swatch-none").style("background", c.noDataNone);

    // Theme buttons — join against the stable key list; buttons are reused, not recreated
    legendOverlay.select("#legend-theme-row")
      .selectAll("button")
      .data(Object.keys(COLOUR_THEMES))
      .join("button")
        .text(d => d)
        .style("flex", "1")
        .style("background",  d => d === state.currentTheme ? (state.isDark ? "rgba(78,204,163,0.1)" : "rgba(5,150,105,0.1)") : "transparent")
        .style("color",       d => d === state.currentTheme ? c.accent : c.muted)
        .style("border",      d => d === state.currentTheme ? `1px solid ${c.accent}` : `1px solid ${c.border}`)
        .style("transform",   "scale(1)")
        .style("padding", "10px 0").style("font-size", "8.5px").style("cursor", "pointer")
        .style("border-radius", "3px").style("text-transform", "uppercase")
        .style("font-family", "'Inter', sans-serif").style("transition", "all 0.2s ease")
        .on("mouseenter", function(_, d) {
          if (d !== state.currentTheme)
            d3.select(this).style("border", `1px solid ${c.accent}`).style("transform", "scale(1.08)");
        })
        .on("mouseleave", function(_, d) {
          if (d !== state.currentTheme)
            d3.select(this).style("border", `1px solid ${c.border}`).style("transform", "scale(1)");
        })
        .on("click", (_, d) => { state.currentTheme = d; renderMap(); });

    // Restore marker for the currently-selected region (if any)
    if (state.selectedFeature) {
      const val = getFilteredValue(state.selectedFeature);
      if (val > 0) updateLegendMarker(val, true);
    }
  }

  // Shown when the active filters result in zero matching facilities anywhere.
  // Replaces the normal gradient legend with a simple "no match" message.
  // We do a full clear here (rare path) and reset the skeleton flag so
  // updateLegend() rebuilds the gradient DOM the next time it's called.
  function updateLegendEmpty() {
    const c = getC();
    legendOverlay.selectAll("*").remove();
    legendOverlay.node()._legendBuilt = false; // force skeleton rebuild on next updateLegend call
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
    const _mobile = isMobile(); // capture once — used in enter handler and click handler below
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
    // The result is stored in the module-level cdPaths variable so all other functions
    // (click handler, restoreMapAppearance, keyboard handler) can reuse it without
    // issuing a new selectAll("path.cd-region") DOM query.
    //
    // Event handlers (hover, click, focus) are attached ONLY on enter so they are
    // never re-registered on subsequent filter/theme renders. Handlers read getC()
    // at event time rather than closing over the per-render `c` snapshot, which was
    // the reason they had to be re-bound every call.
    cdPaths = mapGroup.selectAll("path.cd-region")
      .data(fixedData.features, d => d._cduid)
      .join(
        // ── Enter: create paths and attach all event handlers exactly once ──
        enter => {
          const p = enter.append("path")
            .attr("class", "cd-region")
            .attr("vector-effect", "non-scaling-stroke"); // Keep border width constant regardless of zoom level

          // ── Hover interactions (desktop only — mobile uses tap) ──
          if (!_mobile) {
            p.on("mouseover", function(event, d) {
              if (state.isZooming || state.isPanning) return;
              const c = getC();
              state.hoveredFeature = d;
              if (state._hoveredEl && state._hoveredEl !== this) {
                const prev = d3.select(state._hoveredEl);
                if (prev.attr("stroke") !== c.accent2) prev.attr("stroke", c.bg).attr("stroke-width", 0.5);
              }
              state._hoveredEl = this;
              // Only raise if not already the last child — raise() causes a DOM
              // reorder that triggers a style recalc across all sibling paths.
              const el = this;
              if (el.nextSibling) d3.select(el).attr("stroke", c.text).attr("stroke-width", 1).raise();
              else d3.select(el).attr("stroke", c.text).attr("stroke-width", 1);
              const hoverVal = getFilteredValue(d);
              updateLegendMarker(hoverVal > 0 ? hoverVal : null, false);
              tooltip.style("visibility", "visible").html(`
                <div style="color:${c.accent}; font-weight:600; font-size:14px; margin-bottom:4px;">${d.properties.CDNAME}</div>
                <div style="font-size:11px; color:${c.muted}; font-weight:400;">${getTooltipLabel(getFilteredValue(d))}</div>
              `);
              // Cache dimensions now (one layout read on hover, not on every mousemove frame)
              const tipNode = tooltip.node();
              if (tipNode) { _tipSize.w = tipNode.offsetWidth; _tipSize.h = tipNode.offsetHeight; }
            })
            .on("mousemove", function(event) {
              // Throttle to one reposition per animation frame (~60 fps max).
              if (state.isZooming || state.isPanning) {
                tooltip.style("visibility", "hidden");
                return;
              }
              if (_mousemoveRafPending) return;
              _mousemoveRafPending = true;
              const px = event.pageX, py = event.pageY;
              requestAnimationFrame(() => {
                // Use cached dimensions — avoids a forced layout reflow on every frame.
                const left = Math.min(px + 15, window.innerWidth  + window.scrollX - _tipSize.w - 8);
                const top  = Math.min(py + 15, window.innerHeight + window.scrollY - _tipSize.h - 8);
                tooltip.style("top", `${top}px`).style("left", `${left}px`);
                _mousemoveRafPending = false;
              });
            })
            .on("mouseleave", function() {
              const c = getC();
              state.hoveredFeature = null;
              state._hoveredEl = null;
              const sel = d3.select(this);
              if (sel.attr("stroke") !== c.accent2) sel.attr("stroke", c.bg).attr("stroke-width", 0.5);
              clearLegendMarker();
              tooltip.style("visibility", "hidden");
            })
            // ── Keyboard focus: show tooltip at element centre (desktop only) ──
            .on("focus", function(event, d) {
              const c = getC();
              // Only raise if not already the last child — raise() causes a DOM
              // reorder that triggers a style recalc across all sibling paths.
              const el = this;
              if (el.nextSibling) d3.select(el).attr("stroke", c.text).attr("stroke-width", 1).raise();
              else d3.select(el).attr("stroke", c.text).attr("stroke-width", 1);
              const hoverVal = getFilteredValue(d);
              updateLegendMarker(hoverVal > 0 ? hoverVal : null, false);
              const rect = this.getBoundingClientRect();
              const tipNode = tooltip.node();
              const tipW = tipNode ? tipNode.offsetWidth  : 200;
              const tipH = tipNode ? tipNode.offsetHeight : 50;
              const rawLeft = rect.right + window.scrollX + 12;
              const rawTop  = rect.top   + window.scrollY + rect.height / 2 - 10;
              const left = Math.min(rawLeft, window.innerWidth  + window.scrollX - tipW  - 8);
              const top  = Math.min(rawTop,  window.innerHeight + window.scrollY - tipH  - 8);
              tooltip
                .style("visibility", "visible")
                .html(`
                  <div style="color:${c.accent}; font-weight:600; font-size:14px; margin-bottom:4px;">${d.properties.CDNAME}</div>
                  <div style="font-size:11px; color:${c.muted}; font-weight:400;">${getTooltipLabel(hoverVal)}</div>
                `)
                .style("top",  `${top}px`)
                .style("left", `${left}px`);
            })
            .on("blur", function() {
              const c = getC();
              const sel = d3.select(this);
              if (sel.attr("stroke") !== c.accent2) sel.attr("stroke", c.bg).attr("stroke-width", 0.5);
              clearLegendMarker();
              tooltip.style("visibility", "hidden");
            });
          }

          // ── Click / tap interaction (all devices) ──
          p.on("click", function(event, d) {
            event.stopPropagation();
            const c = getC();

            if (!hasAnyData(d)) { restoreMapAppearance(); return; }

            // Clicking the already-selected region deselects it (toggle off)
            if (state.selectedFeature === d) { restoreMapAppearance(); return; }

            // Reset the skeleton flag whenever the selected region changes so
            // buildCloseButton() creates a fresh button rather than appending a
            // duplicate into an existing #sidebar-header-container.
            if (state.selectedFeature !== d) _detailSkeletonBuilt = false;

            state.selectedFeature = d;
            const selVal = getFilteredValue(d);
            // Pin the legend marker at this region's position
            updateLegendMarker(selVal > 0 ? selVal : null, true);

            // Ensure the sidebar is open to show the detail panel
            if (!state.sidebarOpen) {
              state.sidebarOpen = true;
              updateSidebarToggle();
            }

            // Cancel any in-flight restore transition before applying new state.
            // A single interrupt() cancels all transitions (named and unnamed).
            cdPaths.interrupt();

            // Dim all regions except the clicked one via a short transition so
            // D3 batches DOM writes through rAF rather than blocking the main thread.
            const clicked = this;
            cdPaths
              .filter(function() { return this !== clicked; })
              .transition("select").duration(80)
              .style("opacity", 0.35)
              .attr("stroke", c.bg)
              .attr("stroke-width", 0.5);
            d3.select(this)
              .interrupt()
              .style("opacity", 1)
              .attr("stroke", c.accent2)
              .attr("stroke-width", 2)
              .raise();

            zoomToFeature(d);
            updateSidebarDetail();

            if (isMobile()) {
              setTimeout(() => {
                const scrollEl = sidebarInnerContent.node();
                if (scrollEl) {
                  const scrollTop = detailsDiv.node().offsetTop - sidebarInnerContent.node().offsetTop;
                  scrollEl.scrollTo({ top: scrollTop, behavior: "smooth" });
                }
              }, 50);
            } else {
              setTimeout(() => {
                const scrollEl = sidebar.node();
                if (scrollEl) scrollEl.scrollTo({ top: detailsDiv.node().offsetTop - 16, behavior: "smooth" });
              }, 50);
            }
          });

          return p;
        },
        // ── Update: reuse existing paths — handlers already attached ──
        update => update
      );

    // ── Per-render attribute updates (runs on both enter and update) ──
    // These are data-driven and must be refreshed on every render.
    // Snapshot the filtered counts into a new Map so that any in-flight 700ms
    // transition always paints with the counts from *its own* render pass.
    const _valSnapshot = new Map(_filteredValueCache);

    // .attr("d", path) must run on every render — not just the first draw.
    // Hover and click handlers call .raise() which reorders <path> elements in the
    // DOM. D3's index-based data join would then rebind features to the wrong paths
    // if geometry were skipped, causing regions to display another region's data.
    cdPaths
      .attr("d", path)
      .attr("stroke", d => d === state.selectedFeature ? c.accent2 : c.bg)
      .attr("stroke-width", d => d === state.selectedFeature ? 2 : 0.5)
      .style("opacity", d => (state.selectedFeature && d !== state.selectedFeature) ? 0.35 : 1)
      .attr("tabindex", d => {
        const v = _valSnapshot.get(d._cduid) ?? 0;
        return (v > 0 || hasAnyData(d)) ? "0" : null;
      })
      .attr("role", d => {
        const v = _valSnapshot.get(d._cduid) ?? 0;
        return (v > 0 || hasAnyData(d)) ? "button" : null;
      })
      .attr("aria-label", d => {
        const val = _valSnapshot.get(d._cduid) ?? 0;
        return `${d.properties.CDNAME || "Region"}, ${getTooltipLabel(val)}`;
      })
      .style("cursor", d => {
        const v = _valSnapshot.get(d._cduid) ?? 0;
        return (v > 0 || hasAnyData(d)) ? "pointer" : "default";
      })
      .attr("fill", d => {
        const val = _valSnapshot.get(d._cduid) ?? 0;
        if (val) return colourScale(val);
        return hasAnyData(d) ? c.noData : c.noDataNone;
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
      .style("padding", isMobile() ? "10px 12px" : "10px 14px")
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

  // Tracks whether the detail panel skeleton has been built for the current selection.
  // Reset to false when restoreMapAppearance() clears the selection.
  let _detailSkeletonBuilt = false;

  function updateSidebarDetail() {
    const c = getC();

    // ── No region selected: show prompt ──────────────────────────────────────
    if (!state.selectedFeature) {
      _detailSkeletonBuilt = false;
      detailsDiv.selectAll("*").remove();
      detailsDiv.append("p")
        .style("color", c.muted)
        .style("font-size", "14px")
        .style("font-weight", "400")
        .style("padding-bottom", "32px")
        .text("Select a census division from the map to analyse specific defence industry metrics.");
      return;
    }

    const props = state.selectedFeature.properties;
    // Use the pre-computed _cduid (avoids repeated three-way property lookup)
    const geoId = state.selectedFeature._cduid;

    // Find all facilities in this region that pass the currently active filters.
    // Reuse _cachedPredicate built by getFilteredValue during renderMap() — if the
    // cache is cold (e.g. detail panel opened without a preceding renderMap call)
    // fall back to building it fresh.
    const passesFilters = _cachedPredicate ?? buildFilterPredicate();
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
    const subDataMap = {
      "Manufacturing_sum": Object.entries(MFG_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMfg && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value),
      "Value-Add/Tech_sum": Object.entries(TECH_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isTech && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value),
      "MRO/ISS_sum": Object.entries(MRO_KEYS).map(([col, label]) => ({ label, value: activeLocalFacilities.filter(f => f.isMro && isTrue(f.rawRow[col])).length })).filter(d => d.value > 0).sort((a,b)=>b.value-a.value),
    };

    // ── "No match" path — region selected but no facilities pass current filters ──
    if (activeLocalFacilities.length === 0) {
      _detailSkeletonBuilt = false;
      detailsDiv.selectAll("*").remove();

      // Header
      const noMatchHeader = detailsDiv.append("div")
        .attr("id", "sidebar-header-container")
        .style("display", "flex")
        .style("justify-content", "space-between")
        .style("align-items", "flex-start")
        .style("gap", "16px")
        .style("margin-bottom", "12px")
        .style("font-family", "'Inter', sans-serif");
      const noMatchTitleBox = noMatchHeader.append("div").style("flex", "1");
      noMatchTitleBox.append("h3")
        .style("font-size", "24px").style("font-weight", "600")
        .style("margin", "0 0 4px 0").style("color", c.text).style("line-height", "1.2")
        .text(props.CDNAME);
      noMatchTitleBox.append("div")
        .style("font-size", "11px").style("color", c.muted)
        .style("font-weight", "500").style("letter-spacing", "1px").style("text-transform", "uppercase")
        .text(props.PRNAME ?? "");
      buildCloseButton();

      // No-match message
      const msgBox = detailsDiv.append("div")
        .style("background", state.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)")
        .style("border", `1px dashed ${c.border}`)
        .style("border-radius", "6px").style("padding", "24px")
        .style("text-align", "center").style("margin-top", "20px");
      msgBox.append("p")
        .style("color", c.accent).style("font-size", "14px").style("font-weight", "600")
        .style("margin", "0 0 6px 0")
        .text("No facilities match active filters in this census division.");
      msgBox.append("p")
        .style("color", c.muted).style("font-size", "12px").style("margin", "0").style("line-height", "1.4")
        .text("Try adjusting or resetting your operations and industry filters to see the divisional capabilities.");
      return;
    }

    // ── Build skeleton once — reused on every subsequent filter-change call ──
    if (!_detailSkeletonBuilt) {
      _detailSkeletonBuilt = true;
      detailsDiv.selectAll("*").remove();

      // ── Header ──
      const header = detailsDiv.append("div")
        .attr("id", "sidebar-header-container")
        .style("display", "flex")
        .style("justify-content", "space-between")
        .style("align-items", "flex-start")
        .style("gap", "16px")
        .style("margin-bottom", "12px")
        .style("font-family", "'Inter', sans-serif");

      const titleBox = header.append("div").style("flex", "1");
      titleBox.append("h3")
        .attr("id", "detail-cd-name")
        .style("font-size", "24px").style("font-weight", "600")
        .style("margin", "0 0 4px 0").style("color", c.text).style("line-height", "1.2");
      titleBox.append("div")
        .attr("id", "detail-cd-province")
        .style("font-size", "11px").style("color", c.muted)
        .style("font-weight", "500").style("letter-spacing", "1px").style("text-transform", "uppercase");

      // Close button — attached once, never re-created
      buildCloseButton();

      // ── Side-by-side wrapper (used when viewport is short on desktop) ──
      // When isSidebarShort(), the donut and accordion sit in a flex row.
      // When normal height, it falls through to a plain stacked layout.
      const sideBySideRow = detailsDiv.append("div")
        .attr("id", "detail-side-by-side-row")
        .style("display", isSidebarShort() ? "flex" : "block")
        .style("gap", isSidebarShort() ? "24px" : null)
        .style("align-items", isSidebarShort() ? "flex-start" : null);

      // Left column (donut)
      const donutCol = sideBySideRow.append("div")
        .attr("id", "detail-donut-col")
        .style("flex", isSidebarShort() ? "0 0 auto" : null);

      donutCol.append("div").attr("id", "donut-chart").style("margin-bottom", isSidebarShort() ? "16px" : "28px");

      // ── Note ── always lives in the donut column, directly below the chart.
      // In the stacked layout this naturally precedes the accordion.
      // In the side-by-side layout it stays left, below the donut, so it never
      // sits above the Facility Operations Type heading on the right.
      donutCol.append("p")
        .attr("id", "detail-note")
        .style("font-size", "12px").style("color", c.muted)
        .style("margin", isSidebarShort() ? "0" : "28px 0").style("line-height", "1.5").style("font-weight", "400")
        .html("<b>Please note:</b> a single facility may serve multiple defence industries.");

      // Right column (accordion only) — border-left acts as the vertical divider
      const accordionCol = sideBySideRow.append("div")
        .attr("id", "detail-accordion-col")
        .style("flex", isSidebarShort() ? "1 1 0" : null)
        .style("min-width", isSidebarShort() ? "0" : null)
        .style("border-left", isSidebarShort() ? `1px solid ${c.border}` : null)
        .style("padding-left", isSidebarShort() ? "20px" : null);

      // ── Accordion section heading ──
      accordionCol.append("div")
        .style("font-size", "10px").style("font-weight", "600")
        .style("letter-spacing", "1.5px").style("color", c.muted)
        .style("margin-top", isSidebarShort() ? "0" : "32px").style("margin-bottom", "8px").style("text-transform", "uppercase")
        .text("Facility Operations Type");

      // ── Accordion shell ── (rows are joined into this container)
      accordionCol.append("div").attr("id", "accordion-shell");

      // ── Safe-area spacer on mobile ──
      if (isMobile()) {
        detailsDiv.append("div").style("height", "max(32px, env(safe-area-inset-bottom, 32px))");
      }
    }

    // ── Per-render updates (no DOM creation) ─────────────────────────────────

    // Update header text
    detailsDiv.select("#detail-cd-name").style("color", c.text).text(props.CDNAME);
    detailsDiv.select("#detail-cd-province").style("color", c.muted).text(props.PRNAME ?? "");
    detailsDiv.select("#detail-note").style("color", c.muted);

    // ── Accordion rows — D3 join keyed on operation key ──────────────────────
    // Rows are created on enter and updated in-place on subsequent calls.
    // Accordion listener is attached once in `enter`; never re-attached.
    d3.select("#accordion-shell")
      .selectAll(".accordion-row")
      .data(stats, d => d[0])   // key by operation key for stable identity
      .join(
        // ── Enter: build the full row DOM once ──
        enter => {
          const row = enter.append("div")
            .attr("class", "accordion-row")
            .style("border-bottom", `1px solid ${c.border}`);

          // Toggle header row
          const toggleDiv = row.append("div")
            .attr("class", "accordion-toggle")
            .style("display", "flex").style("justify-content", "space-between")
            .style("align-items", "center").style("padding", "12px 0")
            .style("font-size", "12px").style("font-family", "'Inter', sans-serif")
            .style("user-select", "none")
            .style("-webkit-tap-highlight-color", "transparent"); // suppress blue flash on Chrome mobile

          toggleDiv.append("span")
            .attr("class", "accordion-label")
            .style("color", c.muted).style("font-weight", "400");

          const right = toggleDiv.append("span")
            .style("display", "flex").style("align-items", "center");
          right.append("span")
            .attr("class", "accordion-count")
            .style("font-weight", "600").style("color", c.accent);
          right.append("span")
            .attr("class", "accordion-chevron")
            .style("font-size", "9px").style("color", c.accent)
            .style("margin-left", "8px").style("display", "none")
            .style("transition", "transform 0.2s").text("◀");

          // Sub-rows container
          row.append("div")
            .attr("class", "accordion-sub-rows")
            .style("display", "none").style("padding-bottom", "4px");

          // Attach accordion click + keydown listener once on enter
          toggleDiv
            .attr("role", "button").attr("tabindex", "0").attr("aria-expanded", "false")
            .on("click", function() {
              const subEl = this.closest(".accordion-row").querySelector(".accordion-sub-rows");
              const chevEl = this.querySelector(".accordion-chevron");
              if (!subEl || subEl.children.length === 0) return; // no sub-rows, nothing to toggle
              const isOpen = subEl.style.display !== "none";
              subEl.style.display = isOpen ? "none" : "block";
              if (chevEl) chevEl.style.transform = isOpen ? "rotate(0deg)" : "rotate(-90deg)";
              this.setAttribute("aria-expanded", isOpen ? "false" : "true");
            })
            .on("keydown", function(e) {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.click(); }
            });

          return row;
        },
        // ── Update: reuse existing row DOM ──
        update => update
      )
      // Runs on both enter and update — keeps displayed values current
      .each(function([k, v]) {
        const row    = d3.select(this);
        const subData = subDataMap[k] ?? [];
        const hasBreakdown = subData.length > 0;

        row.style("border-bottom", `1px solid ${c.border}`);

        const toggleDiv = row.select(".accordion-toggle");
        toggleDiv.style("cursor", hasBreakdown ? "pointer" : "default");

        row.select(".accordion-label").style("color", c.muted).text(getLabel(k));
        row.select(".accordion-count").style("color", c.accent).text(v.toLocaleString());

        const chevron = row.select(".accordion-chevron");
        chevron.style("display", hasBreakdown ? "inline-block" : "none").style("color", c.accent);

        // Rebuild sub-rows (counts may have changed with filter update).
        // Preserve open/close state unless the breakdown has disappeared entirely —
        // collapsing an expanded row the user is reading on every filter change is disruptive.
        const subContainer = row.select(".accordion-sub-rows");
        const wasOpen = subContainer.style("display") !== "none";
        if (!hasBreakdown && wasOpen) {
          // Breakdown gone: close and reset
          subContainer.style("display", "none");
          chevron.style("transform", "rotate(0deg)");
          toggleDiv.attr("aria-expanded", "false");
        }

        subContainer.selectAll(".sub-row")
          .data(subData, d => d.label)
          .join(
            enter => {
              const subRow = enter.append("div").attr("class", "sub-row")
                .style("display", "flex").style("justify-content", "space-between")
                .style("align-items", "center").style("padding", "6px 0 6px 14px")
                .style("border-bottom", `1px solid ${c.border}`)
                .style("font-size", "11px").style("font-family", "'Inter', sans-serif");
              subRow.append("span").attr("class", "sub-label")
                .style("color", c.muted).style("font-weight", "400").style("opacity", "0.8");
              subRow.append("span").attr("class", "sub-count")
                .style("font-weight", "500").style("color", c.accent)
                .style("margin-left", "8px").style("opacity", "0.85");
              return subRow;
            },
            update => update,
            exit => exit.remove()
          )
          .each(function(d) {
            d3.select(this).select(".sub-label").text(d.label);
            d3.select(this).select(".sub-count").text(d.value.toLocaleString());
          });
      });

    // ── Donut chart — always rebuild when selection changes or filters update ──
    // The donut is fully data-driven and small, so a targeted rebuild here is
    // cheaper than diffing the SVG arcs. Clear and redraw.
    const donutEl = document.getElementById("donut-chart");
    if (!donutEl) return;
    d3.select(donutEl).selectAll("*").remove();
    if (!industryData.length) return;
    
    // ─── Donut Chart ──────────────────────────────────────────────────────────
    //  Draws a donut chart showing the breakdown of facilities by defence industry.
    //  Hovering/tapping a slice updates the centre label to show that industry's count.
    //
    //  Input handling uses the Pointer Events API (pointerenter / pointerleave /
    //  pointerup) which unifies mouse, touch, and stylus in a single event stream.
    //  Calling event.preventDefault() in pointerup suppresses the browser's
    //  synthetic click that would otherwise fire ~300ms later on touch devices —
    //  eliminating the ghost-click race without needing a setTimeout guard.
    const SIZE = 260; const RADIUS = SIZE / 2; const INNER = RADIUS * 0.55;
    const arcNormal   = d3.arc().innerRadius(INNER).outerRadius(RADIUS - 2);
    const arcExpanded = d3.arc().innerRadius(INNER).outerRadius(RADIUS + 6);

    const svgD = d3.select("#donut-chart").append("svg").attr("width", SIZE).attr("height", SIZE + 20).style("overflow", "visible");
    // Centre group — all paths and labels are relative to the donut's centre
    const g = svgD.append("g").attr("transform", `translate(${RADIUS},${RADIUS})`);
    
    // Centre label: shows total facility count by default; updates on hover/tap
    const cVal = g.append("text").attr("text-anchor", "middle").attr("dy", "-0.15em").style("font-size", "22px").style("font-weight", "600").style("fill", c.text).style("font-family", "Inter");
    const cLab = g.append("text").attr("text-anchor", "middle").attr("dy", "1.1em").style("font-size", "9px").style("font-weight", "500").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter");

    // showDefault restores the centre label to the total count when not interacting
    const showDefault = () => { 
      cVal.text(activeLocalFacilities.length.toLocaleString()); 
      cLab.text(activeLocalFacilities.length === 1 ? "FACILITY" : "FACILITIES"); 
    };
    showDefault();

    // Draw the donut slices. d3.pie() converts value counts to arc angles.
    // _activeSlice tracks the currently expanded slice on touch devices.
    let _activeSlice = null;

    g.selectAll("path")
      .data(d3.pie().value(d => d.value).sort(null)(industryData))
      .join("path")
        .attr("d", arcNormal)
        .attr("fill", d => INDUSTRY_COLOURS[d.data.label])
        .attr("stroke", c.bg)
        .attr("stroke-width", 2)
        .style("cursor", "pointer")
        .style("-webkit-tap-highlight-color", "transparent")

        // ── Hover (mouse only — pointerType check skips touch) ──
        .on("pointerenter", function(event, d) {
          if (event.pointerType === "touch") return;
          d3.select(this).transition().duration(150).attr("d", arcExpanded(d));
          cVal.text(d.data.value);
          cLab.text(d.data.label.toUpperCase());
        })
        .on("pointerleave", function(event, d) {
          if (event.pointerType === "touch") return;
          d3.select(this).transition().duration(150).attr("d", arcNormal(d));
          showDefault();
        })

        // ── Tap (touch only) ──
        // preventDefault() on pointerup suppresses the subsequent synthetic click,
        // replacing the old pointer-events:none / setTimeout(450) approach.
        .on("pointerup", function(event, d) {
          if (event.pointerType !== "touch") return;
          event.preventDefault(); // kills the ghost click — no setTimeout needed
          const self = d3.select(this);
          if (_activeSlice?.node() === this) {
            // Tap the active slice again: collapse it
            self.transition().duration(150).attr("d", arcNormal(d));
            showDefault();
            _activeSlice = null;
          } else {
            // Collapse any previously active slice
            if (_activeSlice) {
              _activeSlice.transition().duration(150)
                .attr("d", arcNormal(_activeSlice.datum()));
            }
            // Expand this slice
            self.transition().duration(150).attr("d", arcExpanded(d));
            cVal.text(d.data.value);
            cLab.text(d.data.label.toUpperCase());
            _activeSlice = self;
          }
        });

    if (isSidebarShort()) {
      // ── Short / landscape: legend sits to the right of the donut SVG ──
      // The SVG covers only the donut circle — no title or legend rows inside it.
      svgD.attr("height", SIZE);

      // Wrap SVG in a flex container alongside the legend column
      const donutNode = d3.select("#donut-chart");
      const innerWrap = donutNode.insert("div", "svg")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "16px");
      // Move the SVG inside the wrapper
      innerWrap.node().appendChild(svgD.node());

      // Right column: title above the legend rows
      const legendCol = innerWrap.append("div").style("display", "flex").style("flex-direction", "column").style("gap", "6px");

      // "DEFENCE INDUSTRIES SERVED" title above the colour key
      legendCol.append("div")
        .style("font-size", "11px").style("font-weight", "600").style("letter-spacing", "1px")
        .style("font-family", "Inter").style("color", c.muted).style("margin-bottom", "2px")
        .text("DEFENCE INDUSTRIES SERVED");

      // One row per industry
      industryData.forEach(d => {
        const row = legendCol.append("div").style("display", "flex").style("align-items", "center").style("gap", "6px");
        row.append("div")
          .style("width", "8px").style("height", "8px").style("border-radius", "2px").style("flex-shrink", "0")
          .style("background", INDUSTRY_COLOURS[d.label]);
        row.append("span")
          .style("font-size", "11px").style("font-family", "Inter").style("color", c.muted)
          .text(d.label);
      });
    } else {
      // ── Normal height: title + legend rows below the donut in the SVG ──
      svgD.append("text").attr("transform", `translate(0, ${SIZE + 20})`).style("font-size", "11px").style("font-weight", "600").style("letter-spacing", "1px").style("fill", c.muted).style("font-family", "Inter").text("DEFENCE INDUSTRIES SERVED");

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
      .style("height", _setupMobile ? "40px" : "70px")
      .style("width", "auto")
      .style("object-fit", "contain")
      .on("error", function() {
        // Hide the broken image and show a text fallback so the sidebar header
        // isn't silently blank if the remote SVG fails to load.
        d3.select(this).style("display", "none");
        logoLink.append("span")
          .style("font-family", "'Inter', sans-serif")
          .style("font-size", _setupMobile ? "16px" : "20px")
          .style("font-weight", "600")
          .style("color", getC().accent)
          .text("Trillium");
      });

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

    const resetAnalyticsBtn = analyticsHeader.append("button")
      .attr("id", "reset-analytics-btn")
      .text("RESET OPERATIONS FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("line-height", "1.2")
      .style("background", "transparent")
      .style("padding", _setupMobile ? "10px 14px" : "6px 10px")
      .style("border-radius", "4px")
      .style("box-sizing", "border-box")
      .style("transition", "all 0.2s ease")
      .on("mouseenter", function() {
        if (state.currentAnalyticsKeys.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });
    onTap(resetAnalyticsBtn, () => { state.currentAnalyticsKeys.clear(); applyFilterAndCheckZoom(); });
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
      const chip = analyticsContainer.append("button")
        .attr("data-ops-key", key)   // Store the key as a data attribute for event handlers to read
        .attr("data-label", label)
        .attr("aria-pressed", "false")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", _setupMobile ? "12px" : "10px")
        .style("font-weight", "500")
        .style("letter-spacing", "0.3px")
        .style("padding", _setupMobile ? "8px 14px" : "8px 12px")
        .style("border-radius", "20px")
        .style("cursor", "pointer")
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
      onTap(chip, function() {
        const k = this.getAttribute("data-ops-key");
        if (state.currentAnalyticsKeys.has(k)) state.currentAnalyticsKeys.delete(k);
        else state.currentAnalyticsKeys.add(k);
        applyFilterAndCheckZoom();
      });
    });

    // ── Industry Filters section header + AND/OR toggle + reset button ──
    const filterHeader = controlsDiv.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("align-items", "stretch")
      .style("margin-top", "20px")
      .style("margin-bottom", "10px");

    filterHeader.append("div")
      .text("INDUSTRY FILTERS")
      .style("font-size", "10px")
      .style("font-weight", "600")
      .style("letter-spacing", "1.5px")
      .style("color", c.muted)
      .style("align-self", "center");

    // AND/OR mode toggle — controls whether all included industries must match (AND)
    // or just one needs to match (OR). Greyed out until at least one industry is included.
    const modeToggleDiv = filterHeader.append("div")
      .attr("id", "mode-toggle")
      .style("display", "flex")
      .style("align-items", "stretch")
      .style("gap", "2px")
      .style("margin-right", "12px");

    ["and", "or"].forEach(mode => {
      const btn = modeToggleDiv.append("button")
        .attr("data-mode", mode)
        .text(mode.toUpperCase())
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", "9px")
        .style("font-weight", "600")
        .style("line-height", "1")
        .style("display", "flex")
        .style("align-items", "center")
        .style("padding", _setupMobile ? "0 12px" : "0 10px")
        .style("border-radius", "3px")
        .style("cursor", "pointer")
        .style("letter-spacing", "0.5px")
        .style("box-sizing", "border-box")
        .style("transition", "all 0.15s ease");
      onTap(btn, function() {
        state.industryFilterMode = this.getAttribute("data-mode");
        applyFilterAndCheckZoom();
      });
    });

    const resetIndustryBtn = filterHeader.append("button")
      .attr("id", "reset-industry-btn")
      .text("RESET INDUSTRY FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("line-height", "1.2")
      .style("background", "transparent")
      .style("padding", _setupMobile ? "10px 14px" : "6px 10px")
      .style("border-radius", "4px")
      .style("box-sizing", "border-box")
      .style("transition", "all 0.2s ease")
      .on("mouseenter", function() {
        if (state.currentIndustries.size > 0) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("text-decoration", "none").style("background", "transparent"); });
    onTap(resetIndustryBtn, () => { state.currentIndustries.clear(); applyFilterAndCheckZoom(); });


    // ── Industry filter chips ──
    // Each chip cycles through three states on repeated clicks:
    //   (none) → "include" (✓, green) → "exclude" (✕, red) → (none)
    const chipContainer = controlsDiv.append("div")
      .attr("id", "industry-selector")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px");

    Object.entries(INDUSTRY_KEYS).forEach(([key, label]) => {
      const chip = chipContainer.append("button")
        .attr("data-ind-key", key)
        .attr("data-label", label)
        .attr("aria-pressed", "false")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", _setupMobile ? "12px" : "10px")
        .style("font-weight", "500")
        .style("letter-spacing", "0.3px")
        .style("padding", _setupMobile ? "8px 14px" : "8px 12px")
        .style("border-radius", "20px")
        .style("cursor", "pointer")
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
      onTap(chip, function() {
        const k = this.getAttribute("data-ind-key");
        const cur = state.currentIndustries.get(k);
        // Cycle: not set → include → exclude → remove
        if (!cur)                   state.currentIndustries.set(k, "include");
        else if (cur === "include")  state.currentIndustries.set(k, "exclude");
        else                        state.currentIndustries.delete(k);
        applyFilterAndCheckZoom();
      });
    });

    // ── "Reset All Filters" button ──
    // Resets both Operations and Industry filters at once.
    const clearAllRow = controlsDiv.append("div")
      .style("display", "flex")
      .style("justify-content", "flex-end")
      .style("margin-top", _setupMobile ? "14px" : "6px")
      .style("margin-bottom", "18px");

    const resetAllBtn = clearAllRow.append("button")
      .attr("id", "reset-all-btn")
      .text("RESET ALL FILTERS")
      .style("font-family", "'Inter', sans-serif")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("background", "transparent")
      .style("padding", _setupMobile ? "10px 14px" : "6px 10px")
      .style("border-radius", "4px")
      .style("transition", "all 0.2s ease")
      .style("letter-spacing", "0.8px")
      .on("mouseenter", function() {
        const either = state.currentAnalyticsKeys.size > 0 || state.currentIndustries.size > 0;
        if (either) d3.select(this).style("background", state.isDark ? "rgba(78,204,163,0.12)" : "rgba(0,169,79,0.08)");
      })
      .on("mouseleave", function() { d3.select(this).style("background", "transparent"); });
    onTap(resetAllBtn, () => clearAllFilters());

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
    const infoCloseBtn = infoHeader.append("button")
      .text("✕")
      .style("background", "transparent")
      .style("border", `1px solid ${c.border}`)
      .style("color", c.muted)
      .style("cursor", "pointer")
      .style("font-size", "12px")
      .style("padding", "10px 14px")
      .style("border-radius", "4px")
      .style("font-family", "'Inter', sans-serif");
    onTap(infoCloseBtn, () => { state.infoOpen = false; infoSidebar.style("transform", "translateX(100%)"); });

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
  //  Sets the body.dark class (which flips all CSS token values in one paint),
  //  then handles the remaining items that genuinely need JS: mobile pill colour,
  //  collapse button position, legend height on resize, and the themeToggle icon.
  function updateUI() {
    invalidateColourCache(); // Force fresh colours for the new theme
    const c = getC();

    // Sync body class so CSS custom properties resolve to the correct values.
    document.body.classList.toggle("dark", state.isDark);
    // container background / text colour is now driven by CSS, but D3 still
    // owns the inline style from the initial append — clear it so the CSS rule wins.
    container.style("background", null).style("color", null);

    if (isMobile()) {
      // Border sides differ between mobile and desktop — these can't be expressed
      // purely via the shared CSS rule, so we still set them here.
      sidebar
        .style("border-top", `1px solid var(--border)`)
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
      sidebar.style("border-right", `1px solid var(--border)`);
      // collapseBtn sits outside #control-panel so the shared CSS rule doesn't apply —
      // set all three colour properties explicitly on every theme change.
      collapseBtn
        .style("background", c.surface)
        .style("color",      c.accent)
        .style("border",     `1px solid ${c.border}`);
    }

    themeToggle.text(state.isDark ? "☼" : "☾"); // Moon for light mode; sun for dark mode

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
    if (state.selectedFeature) {
      // Preserve scroll position so the user's place in the detail panel isn't lost
      const scrollEl = isMobile() ? sidebarInnerContent.node() : sidebar.node();
      const savedScroll = scrollEl ? scrollEl.scrollTop : 0;
      updateSidebarDetail();
      if (scrollEl) scrollEl.scrollTop = savedScroll;
    }
    announceFilterUpdate();
  }
  
  // Re-renders the map and refreshes filter chips after any filter change.
  // Also refreshes the detail panel so the donut chart and counts stay in sync.
  function applyFilterAndCheckZoom() {
    renderMap();
    refreshControlsState();
    if (state.selectedFeature) {
      // Preserve scroll position so the user's place in the detail panel isn't lost
      const scrollEl = isMobile() ? sidebarInnerContent.node() : sidebar.node();
      const savedScroll = scrollEl ? scrollEl.scrollTop : 0;
      updateSidebarDetail();
      if (scrollEl) scrollEl.scrollTop = savedScroll;
    }
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
    _detailSkeletonBuilt = false; // Force a full skeleton rebuild on the next region selection
    d3.select("#legend-marker").style("display", "none");
    // Re-enable the operations/industry selectors (they may have been locked)
    d3.select("#analytics-selector").property("disabled", false).style("opacity", "1").style("cursor", "pointer");
    d3.select("#industry-selector").style("pointer-events", "auto").style("opacity", "1");
    // Cancel any in-flight "select" dim transition, then animate back to full
    // opacity. A single interrupt() cancels all transitions including named ones.
    cdPaths.interrupt();
    cdPaths
      .transition("restore").duration(600)
      .style("opacity", 1)
      .attr("stroke", c.bg)
      .attr("stroke-width", 0.5);
    // On mobile, close the bottom sheet when a region is deselected
    if (isMobile()) {
      _isFullscreen = false;
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
  let _lastHeight = window.innerHeight;
  let _lastIsMobile = isMobile();
  let _lastIsSidebarShort = isSidebarShort();
  let _resizeTimer = null;

  function _doRebuild() {
	// isMobile() is now fixed at load time, so crossedBreakpoint will never be
	// true and the teardown block below is effectively dead code. Left in place
	// in case the freeze is ever removed.
	const nowMobile = isMobile();
	const crossedBreakpoint = nowMobile !== _lastIsMobile;
	_lastWidth   = window.innerWidth;
	_lastHeight  = window.innerHeight;
	_lastIsMobile = nowMobile;

	if (crossedBreakpoint) {
		controlsDiv.selectAll("*").remove();
		_controlsBuilt = false;
		_detailSkeletonBuilt = false;
		}

	// When the viewport height crosses the short-sidebar threshold, the detail
	// panel layout switches between stacked and side-by-side. Force a skeleton
	// rebuild so the new layout takes effect immediately.
	const nowShort = isSidebarShort();
	if (nowShort !== _lastIsSidebarShort) {
		_detailSkeletonBuilt = false;
		_lastIsSidebarShort = nowShort;
	}

	updateUI();
	renderMap();
	zoomToFull(false); // Refit projection to new container size after resize
}

  window.addEventListener("resize", () => {
    if (window.innerWidth === _lastWidth && window.innerHeight === _lastHeight) return;
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
      if (state.selectedFeature !== d) _detailSkeletonBuilt = false;
      state.selectedFeature = d;
      const selVal = getFilteredValue(d);
      updateLegendMarker(selVal > 0 ? selVal : null, true);
      if (!state.sidebarOpen) { state.sidebarOpen = true; updateSidebarToggle(); }
      // Dim all regions and highlight the focused one using the cached selection
      cdPaths.style("opacity", 0.35).attr("stroke", getC().bg);
      cdPaths
        .filter(p => p === d)
        .style("opacity", 1).attr("stroke", getC().accent2).attr("stroke-width", 2).raise();
      zoomToFeature(d);
      updateSidebarDetail();
      tooltip.style("visibility", "hidden");
    }
  });

  // ─── SECTION 22: APPLICATION STARTUP ─────────────────────────────────────
  //  With all functions defined, kick off the application by:
  //    1. Fading out the loading overlay (data is ready)
  //    2. Building the UI (colours, controls, sidebar)
  //    3. Drawing the initial map

  // Sync body.dark immediately so CSS custom-property tokens resolve correctly
  // before updateUI() reads them via getComputedStyle.
  document.body.classList.toggle("dark", state.isDark);

  // Dismiss the CSS spinner injected in index.html.
  // Trigger the CSS fade-out transition first, then remove the node once the
  // 400 ms animation completes so it can't intercept clicks or be tab-focused.
  (function dismissLoader() {
    const el = document.getElementById("map-loading");
    if (!el) return;
    el.classList.add("fade-out");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  })();

  updateUI();
  renderMap();
  // Defer the initial fit by one frame so the browser has finished laying out
  // the sidebar and map container — otherwise clientWidth/clientHeight are 0
  // or reflect the wrong size and Canada appears off-centre on first load.
  requestAnimationFrame(() => zoomToFull(false));
})(); // The outer function is invoked immediately — the map loads as soon as the script runs
