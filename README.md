# 🎙️ Ljudmonitor — Klassrumsverktyg

En realtids-ljudmonitor för klassrummet som hjälper elever att bli medvetna om och träna sin ljudmiljö.

## ✨ Features

### Paket 1 (v2.0)
- **🎯 Aktivitetsfaser** — Markera lektionsmoment (Genomgång, Tyst arbete, Diskussion) med automatiska trösklar
- **🔥 Streak-counter** — Visuell belöning för tystnad med 2-sekunders grace period
- **🌌 Nordljus-animation** — Estetisk feedback som intensifieras med streak-längd
- **📊 Sessionsrapporter** — Automatisk sammanfattning med statistik per fas, sparas lokalt
- **🖥️ Fullskärmsläge** — Projiceringsoptimerad vy med VU-meter och streak
- **💾 Persistent kalibrering** — Tystnadsnivå sparas mellan sessioner

### Grundfunktioner (v1.0)
- Realtids VU-meter med färgkodning (grön/orange/röd)
- Rullande 60-sekunders volymgraf
- Justerbar tröskel
- Valfritt varningsljud med cooldown
- En-klicks kalibrering

## 🚀 Användning

1. Öppna `index.html` i Chrome eller Firefox
2. Klicka **▶ Starta mätning** och godkänn mikrofontillgång
3. Välj aktivitetsfas efter lektionsmoment
4. Håll dig under tröskeln för att bygga streak och se nordljuset! ✨
5. Använd **🖥️ Fullskärm** för projicering (dubbelklick fungerar också)
6. Vid stopp genereras automatisk sessionsrapport

## 🎨 Design

- **Mörkt tema** optimerat för projektor
- **Glassmorphism** med ambient glow
- **Premium estetik** — ingen "skolapp-känsla"
- **Responsiv** — fungerar på desktop och surfplatta

## 🧠 Pedagogisk grund

Baserat på VEP-deliberation med experter inom:
- Självreglerat lärande (SRL)
- Klassrumspraktik
- Akustik
- UX/Interaktionsdesign
- Elevperspektiv

Verktyget fungerar som en **metakognitiv spegel** — eleverna ser sitt kollektiva beteende och kan reflektera kring det.

## 🔒 Integritet

- All data sparas **endast lokalt** i webbläsarens localStorage
- Ingen server, ingen datadelning
- Ingen installation krävs

## 📁 Filstruktur

```
SoundMonitor/
├── index.html    # HTML-struktur
├── style.css     # Styling
├── app.js        # Applikationslogik
└── README.md     # Denna fil
```

## 🛠️ Teknisk stack

- **HTML5** — Struktur
- **CSS3** — Styling med custom properties, animations
- **Vanilla JavaScript** — Ingen dependencies
- **Web Audio API** — Mikrofonaccess och RMS-analys
- **Canvas API** — Graf och nordljus-rendering
- **localStorage** — Persistent data

## 📊 Mätmetodik

- **Relativ dB-skala** (0-100) baserad på RMS-värden
- Kalibrering sätter en baseline för "tystnad"
- Ingen absolut dBSPL — fokus på relativa förändringar

## 🎓 Användningsfall

- **Tyst arbete** — Träna koncentration och respekt för arbetsmiljö
- **Gruppdiskussioner** — Balansera engagemang och ljudnivå
- **Metakognition** — Reflektera över klassens beteendemönster
- **Elevdriven förbättring** — Tävla mot tidigare resultat

## 🔮 Framtida features (Paket 2)

- Timer-integration
- Preset-profiler (Tyst/Diskussion/Fri)
- Frekvensindikator (sorl vs skrik)
- CSV-export för elevprojekt
- Achievements/medaljer

## 📝 Licens

Skapad som del av GAIA Klassrumsverktyg.

---

**Version:** 2.0  
**Senast uppdaterad:** 2026-02-11
