import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  ScaleControl,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import {
  Check,
  ChevronUp,
  Crosshair,
  Layers,
  Locate,
  Maximize2,
  Minimize2,
  MessageCircle,
  Minus,
  Navigation,
  Phone,
  Plus,
  Search,
  Target,
  X,
} from "lucide-react";

import { BASE, TEL, mapRings, waLink, zones } from "@/lib/site-data";

type LatLngTuple = [number, number];

const TILE_LAYERS = {
  street: {
    label: "Stradal",
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  satellite: {
    label: "Satelit",
    light:
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    dark: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    subdomains: ["a"],
    attribution: "&copy; Esri, Maxar, Earthstar Geographics",
  },
  relief: {
    label: "Relief",
    light: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    dark: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
} as const;

type TileKey = keyof typeof TILE_LAYERS;

const baseIcon = L.divIcon({
  className: "",
  html: `<span class="vm-base"><span class="vm-radar"></span><span class="vm-base-pulse"></span><span class="vm-base-dot"></span></span>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const pinIcon = (color: string, label: string) =>
  L.divIcon({
    className: "",
    html: `<span class="vm-pin2" style="--vm-pin:${color}"><span class="vm-pin2-halo"></span><span class="vm-pin2-dot"></span><span class="vm-pin2-tag">${label}</span></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

const userIcon = pinIcon("#16a34a", "Tu");
const pickIcon = pinIcon("#f59e0b", "Punct");

function useIsDark() {
  const [dark, setDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function distanceKm(a: LatLngTuple, b: LatLngTuple) {
  return L.latLng(a).distanceTo(L.latLng(b)) / 1000;
}

/** ETA aproximativ: 12 min pregătire + drum (factor 1.25 față de linia dreaptă) */
function etaFor(km: number) {
  const road = km * 1.25;
  return `${Math.round(12 + road * 0.95)}–${Math.round(18 + road * 1.4)} min`;
}

function MapEvents({ picking, onPick }: { picking: boolean; onPick: (p: LatLngTuple) => void }) {
  useMapEvents({
    click(e) {
      if (picking) onPick([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

function MapApi({
  onReady,
  onZoom,
}: {
  onReady: (m: L.Map) => void;
  onZoom: (z: number) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
    onZoom(map.getZoom());
    const zoomed = () => onZoom(map.getZoom());
    map.on("zoomend", zoomed);

    const fix = () => map.invalidateSize({ animate: false });
    const t1 = setTimeout(fix, 120);
    const t2 = setTimeout(fix, 600);
    const ro = new ResizeObserver(fix);
    ro.observe(map.getContainer());
    window.addEventListener("orientationchange", fix);

    // desktop: rotița activează zoom doar după un click pe hartă
    const enable = () => map.scrollWheelZoom.enable();
    const disable = () => map.scrollWheelZoom.disable();
    disable();
    map.on("click", enable);
    map.on("mouseout", disable);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      window.removeEventListener("orientationchange", fix);
      map.off("zoomend", zoomed);
      map.off("click", enable);
      map.off("mouseout", disable);
    };
  }, [map, onReady, onZoom]);
  return null;
}

/* Snap-uri pentru bottom sheet, ca fracțiune din înălțimea hărții */
const SNAPS = [0.3, 0.58, 0.9];

export default function CoverageMap() {
  const dark = useIsDark();
  const mapRef = useRef<L.Map | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [tiles, setTiles] = useState<TileKey>("street");
  const [showRings, setShowRings] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(9);
  const [active, setActive] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<LatLngTuple | null>(null);
  const [user, setUser] = useState<LatLngTuple | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  /* ---- bottom sheet drag ---- */
  const [snap, setSnap] = useState(0);
  const [sheetH, setSheetH] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ y: number; h: number } | null>(null);

  const wrapH = () => wrapRef.current?.clientHeight ?? 560;
  const snapH = useCallback((i: number) => Math.round(wrapH() * (SNAPS[i] ?? SNAPS[0]!)), []);

  useEffect(() => {
    const apply = () =>
      setSheetH(Math.round((wrapRef.current?.clientHeight ?? 560) * (SNAPS[snap] ?? SNAPS[0]!)));

    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [snap, fullscreen]);

  const onHandleDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, h: sheetH ?? snapH(snap) };
    setDragging(true);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = dragRef.current.h + (dragRef.current.y - e.clientY);
    setSheetH(Math.max(snapH(0) - 24, Math.min(snapH(2) + 24, next)));
  };
  const onHandleUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    const h = sheetH ?? snapH(snap);
    let best = 0;
    SNAPS.forEach((_, i) => {
      if (Math.abs(snapH(i) - h) < Math.abs(snapH(best) - h)) best = i;
    });
    setSnap(best);
    setSheetH(snapH(best));
  };

  const layer = TILE_LAYERS[tiles];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter(
      (z) =>
        z.name.toLowerCase().includes(q) ||
        z.localities.some((l) => l.toLowerCase().includes(q)) ||
        z.roads.some((r) => r.toLowerCase().includes(q)),
    );
  }, [query]);

  const flyTo = useCallback((coords: LatLngTuple, z = 12) => {
    mapRef.current?.flyTo(coords, z, { duration: 0.8 });
  }, []);

  const fitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const pad = Math.round((sheetH ?? 140) + 24);
    map.flyToBounds(L.latLngBounds([BASE, ...zones.map((z) => z.coords)]).pad(0.15), {
      duration: 0.85,
      paddingTopLeft: [20, 70],
      paddingBottomRight: [20, pad],
    });
    setActive(null);
  }, [sheetH]);

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoError("Locația nu este disponibilă în acest browser.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: LatLngTuple = [pos.coords.latitude, pos.coords.longitude];
        setUser(p);
        setPick(null);
        setLocating(false);
        setSnap(1);
        flyTo(p, 12);
      },
      () => {
        setLocating(false);
        setGeoError("Nu am putut obține locația. Verifică permisiunile.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [flyTo]);

  useEffect(() => {
    if (!geoError) return;
    const t = setTimeout(() => setGeoError(null), 4500);
    return () => clearTimeout(t);
  }, [geoError]);

  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 300);
    return () => clearTimeout(t);
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  const measured = pick ?? user;
  const measuredKm = measured ? distanceKm(BASE, measured) : null;
  const measuredLabel = pick ? "Punct ales pe hartă" : "Locația ta GPS";
  const coordStr = measured ? `${measured[0].toFixed(5)},${measured[1].toFixed(5)}` : "";
  const waHref = measured
    ? waLink(
        `Bună ziua! Am nevoie de vulcanizare mobilă la locația: https://maps.google.com/?q=${coordStr}`,
      )
    : waLink("Bună ziua! Am nevoie de vulcanizare mobilă.");

  const fabs = [
    {
      key: "locate",
      icon: <Locate className={`size-5 ${locating ? "animate-spin" : ""}`} />,
      label: "Localizează-mă",
      on: !!user,
      action: locate,
    },
    {
      key: "pick",
      icon: <Crosshair className="size-5" />,
      label: "Alege punct pe hartă",
      on: picking,
      action: () => setPicking((p) => !p),
    },
    { key: "fit", icon: <Target className="size-5" />, label: "Toată acoperirea", on: false, action: fitAll },
    {
      key: "layers",
      icon: <Layers className="size-5" />,
      label: "Straturi hartă",
      on: layersOpen,
      action: () => setLayersOpen((o) => !o),
    },
    {
      key: "full",
      icon: fullscreen ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />,
      label: fullscreen ? "Ieși din ecran complet" : "Ecran complet",
      on: fullscreen,
      action: () => setFullscreen((f) => !f),
    },
  ];

  const sheetStyle = { height: sheetH ? `${sheetH}px` : undefined };

  return (
    <div
      ref={wrapRef}
      className={
        fullscreen
          ? "fixed inset-0 z-[9999] bg-background"
          : "relative h-[78svh] min-h-[520px] w-full sm:h-[620px]"
      }
    >
      <div className="relative h-full w-full overflow-hidden sm:rounded-2xl">
        <MapContainer
          center={BASE}
          zoom={9}
          minZoom={6}
          maxZoom={18}
          scrollWheelZoom={false}
          zoomControl={false}
          attributionControl
          className="vm-map h-full w-full"
          style={{ background: "transparent" }}
        >
          <MapApi onReady={(m) => (mapRef.current = m)} onZoom={setZoom} />
          <MapEvents
            picking={picking}
            onPick={(p) => {
              setPick(p);
              setPicking(false);
              setSnap(1);
            }}
          />
          <TileLayer
            key={tiles + (dark ? "-d" : "-l")}
            attribution={layer.attribution}
            url={dark ? layer.dark : layer.light}
            subdomains={layer.subdomains as unknown as string[]}
            detectRetina
          />
          <ScaleControl position="bottomleft" imperial={false} />

          {showRoutes &&
            filtered.map((z) => (
              <Polyline
                key={`route-${z.slug}`}
                positions={[BASE, z.coords]}
                pathOptions={{
                  color: "#2563eb",
                  weight: active === z.slug ? 3.4 : 1.2,
                  opacity: active === z.slug ? 0.95 : 0.24,
                  dashArray: active === z.slug ? undefined : "4 9",
                }}
              />
            ))}

          {showRings &&
            [...mapRings].reverse().map((ring, i) => (
              <Circle
                key={ring.km}
                center={BASE}
                radius={ring.radius}
                pathOptions={{
                  color: "#2563eb",
                  weight: 1.4,
                  opacity: 0.35 + i * 0.15,
                  dashArray: "6 7",
                  fillColor: "#2563eb",
                  fillOpacity: 0.04 + i * 0.03,
                  className: "vm-ring",
                }}
              />
            ))}

          <Marker position={BASE} icon={baseIcon} zIndexOffset={1000}>
            <Tooltip direction="top" offset={[0, -12]} className="vm-tip vm-tip-strong">
              Bază · Șos. Mangaliei 126 B
            </Tooltip>
          </Marker>

          {filtered.map((z) => (
            <CircleMarker
              key={z.slug}
              center={z.coords}
              radius={active === z.slug ? 12 : 9}
              eventHandlers={{
                click: () => {
                  setActive(z.slug);
                  setSnap((s) => (s === 0 ? 1 : s));
                  flyTo(z.coords, 12);
                },
              }}
              pathOptions={{
                color: "#ffffff",
                weight: 2.5,
                fillColor: active === z.slug ? "#f59e0b" : "#16a34a",
                fillOpacity: 1,
                className: "vm-zone-dot",
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -10]}
                permanent={zoom >= 10 || active === z.slug}
                className={`vm-tip ${active === z.slug ? "vm-tip-strong" : ""}`}
              >
                {`${z.short ?? z.name} · ${z.etaMinutes}`}
              </Tooltip>
            </CircleMarker>
          ))}

          {user && (
            <>
              <Marker position={user} icon={userIcon} zIndexOffset={900} />
              <Polyline
                positions={[BASE, user]}
                pathOptions={{ color: "#16a34a", weight: 3, opacity: 0.92, dashArray: "2 8", className: "vm-flow" }}
              />
            </>
          )}

          {pick && (
            <>
              <Marker position={pick} icon={pickIcon} zIndexOffset={900} />
              <Polyline
                positions={[BASE, pick]}
                pathOptions={{ color: "#f59e0b", weight: 3, opacity: 0.92, dashArray: "2 8", className: "vm-flow" }}
              />
            </>
          )}
        </MapContainer>

        <div className="pointer-events-none absolute inset-0 z-[500] vm-vignette" />

        {/* ==== BARA DE SUS: căutare mereu vizibilă pe mobil ==== */}
        <div
          className="absolute inset-x-0 top-0 z-[600] flex items-center gap-2 p-2.5 sm:p-3"
          style={{ paddingTop: fullscreen ? "max(0.75rem, env(safe-area-inset-top))" : undefined }}
        >
          <div className="pointer-events-auto flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/15 bg-black/60 px-3.5 text-white backdrop-blur-xl">
            <Search className="size-4 shrink-0 opacity-70" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Caută localitate sau drum…"
              aria-label="Caută localitate sau drum"
              className="w-full min-w-0 bg-transparent text-[15px] font-medium outline-none placeholder:text-white/55"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label="Șterge căutarea" className="p-1">
                <X className="size-4 opacity-80" />
              </button>
            )}
          </div>
          <span className="pointer-events-none hidden shrink-0 items-center gap-2 rounded-full border border-white/15 bg-black/55 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-white backdrop-blur sm:inline-flex">
            <span className="vm-live" /> Live
          </span>
          {fullscreen && (
            <button
              onClick={() => setFullscreen(false)}
              className="vm-fab pointer-events-auto shrink-0"
              aria-label="Închide ecranul complet"
            >
              <X className="size-5" />
            </button>
          )}
        </div>

        {/* ==== FAB-uri: coloană când panoul e restrâns, rând deasupra panoului când e extins ==== */}
        <div
          className={`vm-fabs absolute right-2.5 z-[600] flex gap-2 transition-opacity duration-200 sm:right-3 ${
            snap === 0 ? "top-16 flex-col" : "flex-row-reverse"
          } ${snap === 2 ? "pointer-events-none opacity-0" : "opacity-100"}`}

          style={
            snap === 0
              ? undefined
              : {
                  bottom: `calc(${(sheetH ?? 0) + 12}px + ${fullscreen ? "0px" : "var(--vm-bar, 0px)"})`,
                }
          }
        >
          {fabs.map((f) => (
            <button
              key={f.key}
              onClick={f.action}
              aria-label={f.label}
              aria-pressed={f.on}
              title={f.label}
              className={`vm-fab ${f.on ? "vm-fab-on" : ""}`}
            >
              {f.icon}
            </button>
          ))}
          <div
            className={`hidden overflow-hidden rounded-full border border-white/15 bg-black/60 backdrop-blur-xl sm:flex ${
              snap === 0 ? "mt-1 flex-col" : "flex-row-reverse"
            }`}
          >
            <button
              onClick={() => mapRef.current?.zoomIn()}
              aria-label="Mărește harta"
              className="flex size-11 items-center justify-center text-white active:bg-white/15"
            >
              <Plus className="size-5" />
            </button>
            <span className={snap === 0 ? "mx-auto h-px w-6 bg-white/15" : "my-auto h-6 w-px bg-white/15"} />
            <button
              onClick={() => mapRef.current?.zoomOut()}
              aria-label="Micșorează harta"
              className="flex size-11 items-center justify-center text-white active:bg-white/15"
            >
              <Minus className="size-5" />
            </button>
          </div>
        </div>


        {/* ==== Panou straturi ==== */}
        {layersOpen && (
          <div className="absolute right-2.5 top-16 z-[660] w-[min(17rem,72vw)] rounded-3xl border border-white/15 bg-black/85 p-2 text-white shadow-2xl backdrop-blur-2xl sm:right-16">
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-[10px] uppercase tracking-wide opacity-60">Stil hartă</p>
              <button onClick={() => setLayersOpen(false)} aria-label="Închide" className="p-1">
                <X className="size-4 opacity-80" />
              </button>
            </div>
            {(Object.keys(TILE_LAYERS) as TileKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setTiles(k)}
                className={`flex min-h-12 w-full items-center justify-between rounded-2xl px-3 text-[15px] font-semibold active:bg-white/10 ${
                  tiles === k ? "bg-white/15" : ""
                }`}
              >
                {TILE_LAYERS[k].label}
                {tiles === k && <Check className="size-4" />}
              </button>
            ))}
            <p className="mt-2 px-2 pb-1 text-[10px] uppercase tracking-wide opacity-60">Suprapuneri</p>
            {[
              { label: "Cercuri ETA", v: showRings, set: setShowRings },
              { label: "Trasee", v: showRoutes, set: setShowRoutes },
            ].map((o) => (
              <button
                key={o.label}
                onClick={() => o.set(!o.v)}
                aria-pressed={o.v}
                className="flex min-h-12 w-full items-center justify-between rounded-2xl px-3 text-[15px] font-semibold active:bg-white/10"
              >
                {o.label}
                <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${o.v ? "bg-brand" : "bg-white/25"}`}>
                  <span className={`block size-5 rounded-full bg-white transition-transform ${o.v ? "translate-x-5" : ""}`} />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ==== Toast ==== */}
        {(picking || geoError) && (
          <div className="pointer-events-none absolute left-1/2 top-16 z-[660] w-max max-w-[86%] -translate-x-1/2 rounded-full border border-white/15 bg-black/80 px-4 py-2 text-center text-[13px] font-semibold text-white backdrop-blur">
            {geoError ?? "Atinge harta ca să marchezi locația ta"}
          </div>
        )}

        {/* ==== BOTTOM SHEET glisant ==== */}
        <div
          className={`absolute inset-x-0 bottom-0 z-[640] px-2 sm:px-3 sm:pb-3 ${
            fullscreen ? "pb-2" : "pb-[calc(4.75rem+env(safe-area-inset-bottom))] lg:pb-3"
          }`}
          style={{
            paddingBottom: fullscreen
              ? "max(0.5rem, env(safe-area-inset-bottom))"
              : undefined,
          }}
        >
          <div
            className={`vm-sheet flex flex-col overflow-hidden rounded-[26px] ${
              dragging ? "" : "transition-[height] duration-300 ease-out"
            }`}
            style={sheetStyle}
          >
            {/* mâner */}
            <div
              role="button"
              tabIndex={0}
              aria-label="Trage pentru a extinde panoul"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onClick={() => {
                const next = snap === 2 ? 0 : snap + 1;
                setSnap(next);
                setSheetH(snapH(next));
              }}
              className="flex shrink-0 cursor-grab touch-none items-center justify-center py-2.5 active:cursor-grabbing"
            >
              <span className="h-1.5 w-11 rounded-full bg-white/35" />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {measuredKm !== null ? (
                <div className="rounded-3xl bg-white/5 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-white/60">
                        {measuredLabel}
                      </p>
                      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-white">
                        <span className="text-[2rem] font-black leading-none tabular-nums">
                          {measuredKm.toFixed(1)} km
                        </span>
                        <span className="text-sm font-semibold text-white/70">
                          ≈ {etaFor(measuredKm)}
                        </span>
                      </p>
                      <span
                        className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                          measuredKm <= 50
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-amber-500/20 text-amber-300"
                        }`}
                      >
                        {measuredKm <= 50 ? "În zona de acoperire" : "În afara razei standard"}
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        setPick(null);
                        setUser(null);
                      }}
                      className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/20 text-white/80"
                      aria-label="Resetează punctul"
                    >
                      <X className="size-4" />
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <a href={`tel:${TEL}`} className="vm-act vm-act-brand">
                      <Phone className="size-4" /> Sună acum
                    </a>
                    <a href={waHref} target="_blank" rel="noreferrer" className="vm-act vm-act-wa">
                      <MessageCircle className="size-4" /> Trimite locația
                    </a>
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${coordStr}`}
                      target="_blank"
                      rel="noreferrer"
                      className="vm-act vm-act-ghost col-span-2"
                    >
                      <Navigation className="size-4" /> Deschide în Google Maps
                    </a>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={locate} className="vm-act vm-act-brand">
                    <Navigation className={`size-4 ${locating ? "animate-spin" : ""}`} />
                    {locating ? "Te caut…" : "Calculează ETA"}
                  </button>
                  <a href={`tel:${TEL}`} className="vm-act vm-act-ghost">
                    <Phone className="size-4" /> Sună
                  </a>
                </div>
              )}

              {/* lista de zone */}
              <div className="mt-3">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-white/55">
                    Zone deservite
                  </p>
                  <button
                    onClick={() => {
                      const next = snap === 2 ? 1 : 2;
                      setSnap(next);
                      setSheetH(snapH(next));
                    }}
                    className="inline-flex items-center gap-1 text-[12px] font-bold text-white/70"
                  >
                    {snap === 2 ? "Restrânge" : "Vezi toate"}
                    <ChevronUp className={`size-3.5 transition-transform ${snap === 2 ? "rotate-180" : ""}`} />
                  </button>
                </div>

                {snap === 0 ? (
                  <div className="mt-2 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {filtered.map((z) => (
                      <button
                        key={z.slug}
                        onClick={() => {
                          setActive(z.slug);
                          flyTo(z.coords, 12);
                        }}
                        className={`vm-chip snap-start ${active === z.slug ? "vm-chip-on" : ""}`}
                      >
                        <span className="block text-[13px] font-bold leading-tight">{z.short ?? z.name}</span>
                        <span className="mt-0.5 block text-[11px] opacity-70">
                          {z.etaMinutes} · {distanceKm(BASE, z.coords).toFixed(0)} km
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {filtered.map((z) => (
                      <li key={z.slug}>
                        <button
                          onClick={() => {
                            setActive(z.slug);
                            flyTo(z.coords, 12);
                          }}
                          className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border px-3 text-left transition-colors ${
                            active === z.slug
                              ? "border-transparent bg-brand text-white"
                              : "border-white/10 bg-white/5 text-white"
                          }`}
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-[11px] font-black tabular-nums">
                            {distanceKm(BASE, z.coords).toFixed(0)}
                            <span className="text-[8px]">km</span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-bold leading-tight">
                              {z.name}
                            </span>
                            <span className="mt-0.5 block truncate text-[12px] opacity-70">
                              Sosire {z.etaMinutes} · {z.localities.slice(0, 3).join(", ")}
                            </span>
                          </span>
                          <a
                            href={`/zone/${z.slug}`}
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 rounded-xl border border-white/20 px-2.5 py-1.5 text-[11px] font-bold"
                          >
                            Detalii
                          </a>
                        </button>
                      </li>
                    ))}
                    {filtered.length === 0 && (
                      <li className="px-1 py-4 text-[13px] text-white/70">
                        Nicio potrivire — sună-ne oricum, deservim tot județul.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
