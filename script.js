/**********************************************************************
 *  script.js — Hybrid Waymo Estimator (Sensor + Model + Monte Carlo)
 **********************************************************************/

let cameras = [];
let sensorIntervalId = null;
let sensorSampling = false;

let lastObservedDetections = 0;
let lastObservedCameras = 0;
let lastSensorCitywideEstimate = null;

let histogramChart = null;

/**********************************************************************
 *  Initialization
 **********************************************************************/
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("inputs-form")
    .addEventListener("submit", handleFormSubmit);

  document.getElementById("toggleSensorButton")
    .addEventListener("click", toggleSensorSampling);

  loadCameras();
  setupCoverageLabel();
});

/**********************************************************************
 *  Load cameras.json
 **********************************************************************/
async function loadCameras() {
  const status = document.getElementById("sensorStatus");

  try {
    status.textContent = "Loading camera list…";
    const resp = await fetch("cameras.json");

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    cameras = data.filter(c => c && typeof c.url === "string");

    status.textContent = `Loaded ${cameras.length} cameras.`;
  } catch (err) {
    status.textContent = "Failed to load cameras.json.";
    cameras = [];
  }
}

/**********************************************************************
 *  Start / Stop live sampling
 **********************************************************************/
function toggleSensorSampling() {
  const status = document.getElementById("sensorStatus");
  const button = document.getElementById("toggleSensorButton");

  if (!sensorSampling) {
    if (cameras.length === 0) {
      status.textContent = "No cameras available.";
      return;
    }
    sensorSampling = true;
    button.textContent = "Stop camera sampling";
    sampleAllCameras();
    sensorIntervalId = setInterval(sampleAllCameras, 30000);
    status.textContent = "Sampling cameras every 30s…";

  } else {
    sensorSampling = false;
    button.textContent = "Start camera sampling";
    clearInterval(sensorIntervalId);
    status.textContent = "Camera sampling stopped.";
  }
}

/**********************************************************************
 *  Display coverage fraction
 **********************************************************************/
function setupCoverageLabel() {
  const input = document.getElementById("coverageFraction");
  const label = document.getElementById("coverageFractionLabel");

  const update = () => {
    const v = Number(input.value);
    label.textContent = Number.isFinite(v) ? v.toFixed(2) : "–";
  };

  input.addEventListener("input", update);
  update();
}

/**********************************************************************
 *  Sample all cameras
 **********************************************************************/
async function sampleAllCameras() {
  const status = document.getElementById("sensorStatus");
  const coverage = Number(document.getElementById("coverageFraction").value);

  if (!coverage || coverage <= 0 || coverage > 1) {
    status.textContent = "Coverage must be between 0–1.";
    return;
  }

  let total = 0;
  let used = 0;

  for (const cam of cameras) {
    try {
      const count = await sampleSingleCamera(cam);
      total += count;
      used++;
    } catch (_) {
      /* continue; */
    }
  }

  if (used === 0) {
    lastObservedDetections = 0;
    lastObservedCameras = 0;
    lastSensorCitywideEstimate = null;

    document.getElementById("observedDetections").textContent = "0";
    document.getElementById("observedCameras").textContent = "0";
    document.getElementById("sensorEstimate").textContent = "–";

    status.textContent = "No cameras returned usable images.";

    return;
  }

  lastObservedDetections = total;
  lastObservedCameras = used;

  document.getElementById("observedDetections").textContent = total;
  document.getElementById("observedCameras").textContent = used;

  const citywide = total / coverage;
  lastSensorCitywideEstimate = citywide;

  document.getElementById("sensorEstimate").textContent = Math.round(citywide);
  status.textContent = `Last sample: ${total} detections across ${used} cameras.`;
}

/**********************************************************************
 *  Load + detect for one camera
 **********************************************************************/
async function sampleSingleCamera(cam) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      try { resolve(detectWaymoHeuristic(img)); }
      catch (err) { reject(err); }
    };
    img.onerror = () => reject("load error");

    img.src = cam.url + (cam.url.includes("?") ? "&" : "?") + "t=" + Date.now();
  });
}

/**********************************************************************
 *  Simple visual heuristic for Waymo-like shapes
 **********************************************************************/
function detectWaymoHeuristic(img) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const w = 320;
  const h = Math.round((img.height / img.width) * w);

  canvas.width = w;
  canvas.height = h;

  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h).data;

  let white = 0;

  for (let y = Math.floor(h * 0.4); y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const bright = (r + g + b) / 3 > 180;
      const lowSat = Math.max(r, g, b) - Math.min(r, g, b) < 40;

      if (bright && lowSat) white++;
    }
  }

  if (white < 200) return 0;

  const cars = white / 800;
  if (cars < 0.5) return 0;
  if (cars < 1.5) return 1;
  return 2;
}

/**********************************************************************
 *  Model input handling
 **********************************************************************/
function handleFormSubmit(ev) {
  ev.preventDefault();

  const runButton = document.getElementById("runButton");
  const status = document.getElementById("statusMessage");
  runButton.disabled = true;
  status.textContent = "";

  try {
    const params = readInputs();
    const results = runMonteCarlo(params);

    updateTextResults(results);
    drawHistogram(results.blendedSamples);

    status.textContent = "Simulation complete.";
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }

  runButton.disabled = false;
}

function readInputs() {
  const get = id => Number(document.getElementById(id).value);

  const fleetSize = get("fleetSize");
  const sfMin = get("sfShareMin");
  const sfMax = get("sfShareMax");
  const utilMin = get("utilMin");
  const utilMax = get("utilMax");
  const tripsPerDay = get("tripsPerDay");
  const tpcMin = get("tripsPerCarMin");
  const tpcMax = get("tripsPerCarMax");
  const samples = get("samples");
  const sensorWeight = get("sensorWeight");

  if (fleetSize <= 0) throw new Error("Fleet size must be > 0.");
  if (sfMin < 0 || sfMax > 100 || sfMin > sfMax)
    throw new Error("SF share % invalid.");
  if (utilMin < 0 || utilMax > 100 || utilMin > utilMax)
    throw new Error("Utilization % invalid.");
  if (tpcMin <= 0 || tpcMax < tpcMin) throw new Error("Trips/car invalid.");
  if (samples < 1000) throw new Error("Samples must be ≥ 1000.");
  if (sensorWeight < 0 || sensorWeight > 1)
    throw new Error("Sensor weight must be 0–1.");

  return {
    fleetSize,
    sfMin: sfMin / 100,
    sfMax: sfMax / 100,
    utilMin: utilMin / 100,
    utilMax: utilMax / 100,
    tripsPerDay,
    tpcMin,
    tpcMax,
    samples,
    sensorWeight
  };
}

/**********************************************************************
 *  Monte Carlo simulation
 **********************************************************************/
function runMonteCarlo(p) {
  const fleet = [];
  const trip = [];
  const sensor = [];
  const blend = [];

  const sensorPoint = lastSensorCitywideEstimate;

  for (let i = 0; i < p.samples; i++) {
    const f = sampleFleet(p);
    const t = sampleTrip(p);
    const s = sampleSensor(sensorPoint);
    const b = blendSamples(f, t, s, p.sensorWeight);

    fleet.push(f);
    trip.push(t);
    sensor.push(s);
    blend.push(b);
  }

  return {
    fleetSamples: fleet,
    tripSamples: trip,
    sensorSamples: sensor,
    blendedSamples: blend,
    fleetStats: summarize(fleet),
    tripStats: summarize(trip),
    sensorStats: summarize(sensor),
    blendedStats: summarize(blend)
  };
}

function sampleFleet(p) {
  const sfShare = rand(p.sfMin, p.sfMax);
  const util = rand(p.utilMin, p.utilMax);
  return p.fleetSize * sfShare * util;
}

function sampleTrip(p) {
  if (p.tripsPerDay <= 0) return 0;
  const tripsPerCar = rand(p.tpcMin, p.tpcMax);
  return p.tripsPerDay / tripsPerCar;
}

function sampleSensor(point) {
  if (!Number.isFinite(point) || point <= 0) return NaN;

  const mean = point;
  const sd = point * 0.3;
  const vr = sd * sd / (mean * mean);

  const sigma2 = Math.log(1 + vr);
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(mean) - sigma2 / 2;

  return Math.exp(mu + sigma * randn());
}

function blendSamples(f, t, s, sensorWeight) {
  const ok = Number.isFinite(s);
  if (!ok || sensorWeight === 0) {
    return 0.5 * f + 0.5 * t;
  }
  const rest = (1 - sensorWeight) / 2;
  return rest * f + rest * t + sensorWeight * s;
}

function summarize(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  if (a.length === 0) return { mean: NaN, p5: NaN, p95: NaN };

  const sorted = [...a].sort((a, b) => a - b);

  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);

  return { mean, p5, p95 };
}

/**********************************************************************
 *  Histogram
 **********************************************************************/
function drawHistogram(values) {
  const finite = values.filter(x => Number.isFinite(x));
  if (finite.length === 0) return;

  const ctx = document.getElementById("histogramCanvas").getContext("2d");

  const min = Math.min(...finite);
  const max = Math.max(...finite);

  if (min === max) {
    if (histogramChart) histogramChart.destroy();

    histogramChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: [min.toFixed(0)],
        datasets: [{ data: [finite.length] }]
      }
    });
    return;
  }

  const n = Math.min(40, Math.max(10, Math.floor(Math.sqrt(finite.length))));
  const binSize = (max - min) / n;

  const bins = Array(n).fill(0);
  const labels = [];

  for (let i = 0; i < n; i++) {
    const mid = min + (i + 0.5) * binSize;
    labels.push(mid.toFixed(0));
  }

  for (const x of finite) {
    let idx = Math.floor((x - min) / binSize);
    idx = Math.max(0, Math.min(n - 1, idx));
    bins[idx]++;
  }

  if (histogramChart) histogramChart.destroy();

  histogramChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: bins }] }
  });
}

/**********************************************************************
 *  Utilities
 **********************************************************************/
function percentile(a, p) {
  const i = p * (a.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  return a[lo] * (hi - i) + a[hi] * (i - lo);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randn() {
  let u1 = 0, u2 = 0;
  while (!u1) u1 = Math.random();
  while (!u2) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function updateTextResults(r) {
  setTxt("fleetMean", r.fleetStats.mean);
  setRange("fleetRange", r.fleetStats);

  setTxt("tripMean", r.tripStats.mean);
  setRange("tripRange", r.tripStats);

  setTxt("sensorMean", r.sensorStats.mean);
  setRange("sensorRange", r.sensorStats);

  setTxt("blendMean", r.blendedStats.mean);
  setRange("blendRange", r.blendedStats);
}

function setTxt(id, v) {
  document.getElementById(id).textContent =
    Number.isFinite(v) ? Math.round(v) : "–";
}

function setRange(id, stats) {
  const el = document.getElementById(id);
  if (!Number.isFinite(stats.p5)) {
    el.textContent = "–";
  } else {
    el.textContent = `${Math.round(stats.p5)}–${Math.round(stats.p95)}`;
  }
}
