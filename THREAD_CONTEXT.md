# THREAD_CONTEXT — Ljudmonitor (SoundMonitor)

> Auto-append destination för konversationsbidrag. Konsolideras vid `/sync`.

---

## Senaste aktivitet

### 2026-02-11 — Fullscreen CSS Layout Fix
*Källa: Konversation f5ca65bd*

**Problem:** Streak-ringen visades som solid svart disc, sidebar hamnade fel, graph strip syntes inte.

**Lösning & kritisk CSS-arkitektur:**

```
.fullscreen-view (fixed, inset: 0, z-index: 100)
├── .fs-content (flex column, padding-right: 280px för sidebar)
│   ├── .fs-header (phase indicator + session time)
│   ├── .fs-center-stage (flex: 1, streak ring)
│   │   └── .fs-streak-ring-container (min(280px, 40vh))
│   │       ├── .fs-streak-svg (transform: rotate(-90deg))
│   │       │   ├── .fs-streak-ring-bg (fill: rgba(0,0,0,0.3), stroke: rgba(255,255,255,0.2))
│   │       │   └── .fs-streak-ring-progress (fill: none ← KRITISKT!)
│   │       └── .fs-streak-inner (absolute, centered text overlay)
│   └── .fs-graph-strip (height: 80px, flex-shrink: 0)
├── .fs-sidebar (absolute, right: 24px, width: 240px)
│   ├── .fs-stats
│   └── .fs-adjust-panel (threshold sliders)
└── .fs-controls (absolute, bottom: 40px, opacity on hover)
```

**⚠️ Kända regressioner att undvika:**

| Problem | Orsak | Fix |
|---------|-------|-----|
| Streak ring = solid svart disc | `.fs-streak-ring-progress` har `fill` satt till en färg | Måste vara `fill: none` |
| Sidebar gömd/felplacerad | `.fs-content` saknar `padding-right: 280px` | Behövs för att ge plats åt `.fs-sidebar` |
| Graph strip osynlig | `.fs-graph-strip` saknar `flex-shrink: 0` | Utan det kollapsar den |
| Controls alltid synliga | `.fs-controls` saknar `opacity: 0` + hover-reveal | Hover-effekt på `.fullscreen-view:hover .fs-controls` |

---

## Projektöversikt

| Fil | Storlek | Syfte |
|-----|---------|-------|
| `index.html` | ~19 KB | Single-page app, all HTML |
| `style.css` | ~26 KB | Full styling inkl. fullscreen |
| `app.js` | ~49 KB | All logic: mic, streaks, phases, graphs |
| `icons/` | 5 filer | Phase icons (SVG/PNG) |

**Stack:** Vanilla HTML/CSS/JS, Web Audio API, localStorage för historik.

**Ingen build-process.** Filer serveras direkt.

---
*gAIa 🌲 — 2026-02-11*
