const FIELD_LABELS = {
  db: "乾球温度",
  rh: "相対湿度",
  x: "絶対湿度",
  h: "比エンタルピ",
  dp: "露点温度",
  wb: "湿球温度",
};

const FIELD_UNITS = {
  db: "℃",
  rh: "%",
  x: "g/kg'",
  h: "kJ/kg'",
  dp: "℃",
  wb: "℃",
};

const STORAGE_KEY = "air-state-calculator-v2";
const HISTORY_LIMIT = 80;
const KCAL_PER_KJ = 0.2388459;
const KW_PER_USRT = 3.5168525;
const AIR_DENSITY = 1.2;
const AIR_CP = 1.006;
const WATER_LATENT_HEAT = 2501;
const PRESETS = {
  office: { label: "室内標準", db: 26, rh: 50 },
  summer: { label: "夏外気", db: 35, rh: 60 },
  winter: { label: "冬外気", db: 5, rh: 40 },
  dehumidified: { label: "除湿後", db: 15, rh: 90 },
  supply: { label: "冷房吹出", db: 14, rh: 85 },
};
const EPSILON = 0.62198;
const fields = [...document.querySelectorAll("[data-key]")];
const presetButtons = [...document.querySelectorAll("[data-preset]")];
const outputs = {
  db: document.getElementById("out-db"),
  rh: document.getElementById("out-rh"),
  x: document.getElementById("out-x"),
  h: document.getElementById("out-h"),
  dp: document.getElementById("out-dp"),
  wb: document.getElementById("out-wb"),
  di: document.getElementById("out-di"),
};

const pressureInput = document.getElementById("pressure");
const precisionInput = document.getElementById("precision");
const inputCount = document.getElementById("inputCount");
const pairLabel = document.getElementById("pairLabel");
const statusLine = document.getElementById("status");
const calculateBtn = document.getElementById("calculateBtn");
const copyBtn = document.getElementById("copyBtn");
const shareUrlBtn = document.getElementById("shareUrlBtn");
const resetBtn = document.getElementById("resetBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const historyBody = document.getElementById("historyBody");
const chartCanvas = document.getElementById("chartCanvas");
const plotHistoryToggle = document.getElementById("plotHistoryToggle");
const exportChartPngBtn = document.getElementById("exportChartPngBtn");
const printReportBtn = document.getElementById("printReportBtn");
const conditionSelects = [
  document.getElementById("enthalpyAir1"),
  document.getElementById("enthalpyAir2"),
  document.getElementById("mixAir1"),
  document.getElementById("mixAir2"),
  document.getElementById("humidAir1"),
  document.getElementById("humidAir2"),
  document.getElementById("coilAir1"),
  document.getElementById("coilAir2"),
];
const enthalpyControls = {
  air1: document.getElementById("enthalpyAir1"),
  air2: document.getElementById("enthalpyAir2"),
  airflow: document.getElementById("enthalpyAirflow"),
  status: document.getElementById("enthalpyStatus"),
  diff: document.getElementById("enthalpyDiff"),
  load: document.getElementById("enthalpyLoad"),
  kw: document.getElementById("enthalpyKw"),
  kcal: document.getElementById("enthalpyKcal"),
  rt: document.getElementById("enthalpyRt"),
  deltaBody: document.getElementById("deltaBody"),
};
const mixControls = {
  air1: document.getElementById("mixAir1"),
  air2: document.getElementById("mixAir2"),
  airflow1: document.getElementById("mixAirflow1"),
  airflow2: document.getElementById("mixAirflow2"),
  status: document.getElementById("mixStatus"),
  addHistory: document.getElementById("addMixHistoryBtn"),
  outputs: {
    db: document.getElementById("mix-db"),
    rh: document.getElementById("mix-rh"),
    x: document.getElementById("mix-x"),
    h: document.getElementById("mix-h"),
    dp: document.getElementById("mix-dp"),
    wb: document.getElementById("mix-wb"),
    di: document.getElementById("mix-di"),
  },
};
const humidControls = {
  air1: document.getElementById("humidAir1"),
  air2: document.getElementById("humidAir2"),
  airflow: document.getElementById("humidAirflow"),
  status: document.getElementById("humidStatus"),
  outputs: {
    deltaX: document.getElementById("humidDeltaX"),
    kgH: document.getElementById("humidKgH"),
    lDay: document.getElementById("humidLDay"),
    latentKw: document.getElementById("humidLatentKw"),
  },
};
const coilControls = {
  air1: document.getElementById("coilAir1"),
  air2: document.getElementById("coilAir2"),
  airflow: document.getElementById("coilAirflow"),
  status: document.getElementById("coilStatus"),
  outputs: {
    mode: document.getElementById("coilMode"),
    totalKw: document.getElementById("coilTotalKw"),
    sensibleKw: document.getElementById("coilSensibleKw"),
    latentKw: document.getElementById("coilLatentKw"),
    shr: document.getElementById("coilShr"),
  },
};

let currentResult = null;
let currentMixResult = null;
let history = [];
let nextHistoryId = 1;
let debounceTimer = null;
let saveTimer = null;
let isRestoring = false;

function saturationPressure(tC, forceWater = false) {
  const tK = tC + 273.15;
  if (!Number.isFinite(tK) || tK <= 0) {
    return NaN;
  }

  let lnP;
  if (forceWater || tC >= 0.01) {
    lnP =
      -5.8002206e3 / tK +
      1.3914993 -
      4.8640239e-2 * tK +
      4.1764768e-5 * tK ** 2 -
      1.4452093e-8 * tK ** 3 +
      6.5459673 * Math.log(tK);
  } else {
    lnP =
      -5.6745359e3 / tK +
      6.3925247 -
      9.677843e-3 * tK +
      6.2215701e-7 * tK ** 2 +
      2.0747825e-9 * tK ** 3 -
      9.484024e-13 * tK ** 4 +
      4.1635019 * Math.log(tK);
  }

  return Math.exp(lnP) / 1000;
}

function humidityRatioFromVaporPressure(vaporPressure, pressure) {
  if (vaporPressure < 0 || vaporPressure >= pressure) {
    return NaN;
  }
  return (EPSILON * vaporPressure) / (pressure - vaporPressure);
}

function vaporPressureFromHumidityRatio(w, pressure) {
  if (w < 0) {
    return NaN;
  }
  return (pressure * w) / (EPSILON + w);
}

function humidityRatioFromDbRh(db, rh, pressure) {
  const e = saturationPressure(db) * rh / 100;
  return humidityRatioFromVaporPressure(e, pressure);
}

function enthalpyFromDbW(db, w) {
  return 1.006 * db + w * (2501 + 1.86 * db);
}

function discomfortIndex(db, rh) {
  return 0.81 * db + 0.01 * rh * (0.99 * db - 14.3) + 46.3;
}

function psychrometerCoefficient(wb) {
  return wb >= 0.01 ? 0.000662 : 0.000583;
}

function vaporPressureFromDbWb(db, wb, pressure) {
  const coefficient = psychrometerCoefficient(wb);
  return saturationPressure(wb) - coefficient * pressure * (db - wb);
}

function humidityRatioFromDbWb(db, wb, pressure) {
  if (wb > db + 1e-9) {
    return NaN;
  }
  const e = vaporPressureFromDbWb(db, wb, pressure);
  return humidityRatioFromVaporPressure(e, pressure);
}

function dewPointFromVaporPressure(vaporPressure) {
  return solveIncreasing(
    (candidate) => saturationPressure(candidate) - vaporPressure,
    -100,
    200,
    "露点温度を求められません。"
  );
}

function wetBulbFromState(db, w, pressure) {
  const e = vaporPressureFromHumidityRatio(w, pressure);
  if (!Number.isFinite(e)) {
    return NaN;
  }

  const equation = (tw) => {
    const coefficient = psychrometerCoefficient(tw);
    return saturationPressure(tw) - coefficient * pressure * (db - tw) - e;
  };

  let low = Math.min(-100, db - 160);
  const high = db;
  if (equation(high) < -1e-8) {
    return NaN;
  }

  while (equation(low) > 0 && low > -260) {
    low -= 40;
  }
  if (equation(low) > 0) {
    return NaN;
  }

  return bisect(equation, low, high);
}

function solveIncreasing(fn, min, max, message) {
  const root = findBracketedRoot(fn, min, max, true);
  if (!Number.isFinite(root)) {
    throw new Error(message);
  }
  return root;
}

function solveDecreasing(fn, min, max, message) {
  const root = findBracketedRoot(fn, min, max, false);
  if (!Number.isFinite(root)) {
    throw new Error(message);
  }
  return root;
}

function findBracketedRoot(fn, min, max, increasing) {
  const steps = 900;
  let prevX = null;
  let prevY = null;

  for (let i = 0; i <= steps; i += 1) {
    const x = min + ((max - min) * i) / steps;
    const y = fn(x);
    if (!Number.isFinite(y)) {
      continue;
    }
    if (Math.abs(y) < 1e-9) {
      return x;
    }
    if (prevY !== null && prevY * y <= 0) {
      return increasing
        ? bisect(fn, prevX, x)
        : bisect(fn, x, prevX);
    }
    prevX = x;
    prevY = y;
  }
  return NaN;
}

function bisect(fn, low, high) {
  let lowValue = fn(low);
  let highValue = fn(high);

  if (Math.abs(lowValue) < 1e-10) {
    return low;
  }
  if (Math.abs(highValue) < 1e-10) {
    return high;
  }

  for (let i = 0; i < 90; i += 1) {
    const mid = (low + high) / 2;
    const midValue = fn(mid);
    if (!Number.isFinite(midValue)) {
      break;
    }
    if (Math.abs(midValue) < 1e-10) {
      return mid;
    }
    if (lowValue * midValue <= 0) {
      high = mid;
      highValue = midValue;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }
  return (low + high) / 2;
}

function solveDbFromRhH(rh, h, pressure) {
  return solveIncreasing(
    (db) => {
      const w = humidityRatioFromDbRh(db, rh, pressure);
      if (!Number.isFinite(w)) {
        return NaN;
      }
      return enthalpyFromDbW(db, w) - h;
    },
    -100,
    200,
    "相対湿度と比エンタルピから乾球温度を求められません。"
  );
}

function solveDbFromRhWb(rh, wb, pressure) {
  if (Math.abs(rh - 100) < 1e-9) {
    return wb;
  }

  return solveDecreasing(
    (db) => {
      if (db < wb) {
        return NaN;
      }
      const e = vaporPressureFromDbWb(db, wb, pressure);
      if (!Number.isFinite(e) || e <= 0) {
        return -rh;
      }
      return (100 * e) / saturationPressure(db) - rh;
    },
    wb,
    220,
    "相対湿度と湿球温度から乾球温度を求められません。"
  );
}

function dbFromSaturationPressure(targetPressure) {
  return solveIncreasing(
    (db) => saturationPressure(db) - targetPressure,
    -100,
    200,
    "飽和水蒸気圧から温度を求められません。"
  );
}

function parseNumber(input) {
  if (input.value.trim() === "") {
    return null;
  }
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    throw new Error("数値として読み取れない入力があります。");
  }
  return value;
}

function collectInputs() {
  const values = {};
  const active = [];

  for (const input of fields) {
    const key = input.dataset.key;
    const value = parseNumber(input);
    values[key] = value;
    input.closest(".field-card").classList.toggle("is-active", value !== null);
    if (value !== null) {
      active.push(key);
    }
  }

  inputCount.textContent = `${active.length} / 2`;
  return { values, active };
}

function getSettings() {
  const pressure = Number(pressureInput.value);
  const precision = Number.parseInt(precisionInput.value, 10);

  if (!Number.isFinite(pressure) || pressure <= 1 || pressure > 500) {
    throw new Error("空気の全圧は1から500kPaの範囲で入力してください。");
  }
  if (!Number.isFinite(precision) || precision < 0 || precision > 4) {
    throw new Error("小数点以下の桁数は0から4で入力してください。");
  }

  return { pressure, precision };
}

function validatePair(values, active) {
  if (active.length !== 2) {
    throw new Error(active.length < 2 ? "状態値を2つ入力してください。" : "入力する状態値は2つだけにしてください。");
  }

  if (values.rh !== null && (values.rh <= 0 || values.rh > 100)) {
    throw new Error("相対湿度は0より大きく100以下で入力してください。");
  }
  if (values.x !== null && values.x < 0) {
    throw new Error("絶対湿度は0以上で入力してください。");
  }

  const pairKey = active.slice().sort().join("-");
  if (pairKey === "dp-x") {
    throw new Error("絶対湿度と露点温度だけでは乾球温度を決められません。");
  }
  if (pairKey === "h-wb") {
    throw new Error("比エンタルピと湿球温度の組み合わせは解が不安定なため対象外です。");
  }
}

function stateFromInputs(values, active, pressure) {
  validatePair(values, active);

  const has = (key) => active.includes(key);
  let db;
  let w;

  if (has("db") && has("rh")) {
    db = values.db;
    w = humidityRatioFromDbRh(db, values.rh, pressure);
  } else if (has("db") && has("x")) {
    db = values.db;
    w = values.x / 1000;
  } else if (has("db") && has("h")) {
    db = values.db;
    w = (values.h - 1.006 * db) / (2501 + 1.86 * db);
  } else if (has("db") && has("dp")) {
    db = values.db;
    if (values.dp > db + 1e-7) {
      throw new Error("露点温度は乾球温度以下で入力してください。");
    }
    w = humidityRatioFromVaporPressure(saturationPressure(values.dp), pressure);
  } else if (has("db") && has("wb")) {
    db = values.db;
    if (values.wb > db + 1e-7) {
      throw new Error("湿球温度は乾球温度以下で入力してください。");
    }
    w = humidityRatioFromDbWb(db, values.wb, pressure);
  } else if (has("rh") && has("x")) {
    w = values.x / 1000;
    const e = vaporPressureFromHumidityRatio(w, pressure);
    db = dbFromSaturationPressure(e * 100 / values.rh);
  } else if (has("rh") && has("h")) {
    db = solveDbFromRhH(values.rh, values.h, pressure);
    w = humidityRatioFromDbRh(db, values.rh, pressure);
  } else if (has("rh") && has("dp")) {
    const e = saturationPressure(values.dp);
    db = dbFromSaturationPressure(e * 100 / values.rh);
    w = humidityRatioFromVaporPressure(e, pressure);
  } else if (has("rh") && has("wb")) {
    db = solveDbFromRhWb(values.rh, values.wb, pressure);
    w = humidityRatioFromDbWb(db, values.wb, pressure);
  } else if (has("x") && has("h")) {
    w = values.x / 1000;
    db = (values.h - 2501 * w) / (1.006 + 1.86 * w);
  } else if (has("x") && has("wb")) {
    w = values.x / 1000;
    const e = vaporPressureFromHumidityRatio(w, pressure);
    const a = psychrometerCoefficient(values.wb);
    db = values.wb + (saturationPressure(values.wb) - e) / (a * pressure);
  } else if (has("h") && has("dp")) {
    w = humidityRatioFromVaporPressure(saturationPressure(values.dp), pressure);
    db = (values.h - 2501 * w) / (1.006 + 1.86 * w);
  } else if (has("dp") && has("wb")) {
    const e = saturationPressure(values.dp);
    const a = psychrometerCoefficient(values.wb);
    db = values.wb + (saturationPressure(values.wb) - e) / (a * pressure);
    w = humidityRatioFromVaporPressure(e, pressure);
  }

  return completeState(db, w, pressure);
}

function completeState(db, w, pressure) {
  if (!Number.isFinite(db) || !Number.isFinite(w)) {
    throw new Error("入力条件から状態値を求められません。");
  }
  if (w < -1e-10) {
    throw new Error("入力条件では絶対湿度が負になります。");
  }

  w = Math.max(w, 0);
  const e = vaporPressureFromHumidityRatio(w, pressure);
  if (!Number.isFinite(e) || e <= 0 || e >= pressure) {
    throw new Error("水蒸気分圧が計算範囲外です。入力値を確認してください。");
  }

  const rh = (100 * e) / saturationPressure(db);
  if (!Number.isFinite(rh) || rh < -0.05 || rh > 100.05) {
    throw new Error("入力条件は飽和を超えている可能性があります。");
  }

  const cleanRh = Math.min(100, Math.max(0, rh));
  const dp = dewPointFromVaporPressure(e);
  const wb = wetBulbFromState(db, w, pressure);
  const h = enthalpyFromDbW(db, w);

  if (!Number.isFinite(wb)) {
    throw new Error("湿球温度を求められません。");
  }
  if (dp > db + 0.02 || wb > db + 0.02) {
    throw new Error("入力条件の温度関係が成立しません。");
  }

  return {
    db,
    rh: cleanRh,
    x: w * 1000,
    h,
    dp,
    wb,
    di: discomfortIndex(db, cleanRh),
  };
}

function formatNumber(value, precision) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(precision);
}

function formatFlexible(value, precision = getDisplayPrecision()) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(precision);
}

function getDisplayPrecision() {
  const precision = Number.parseInt(precisionInput.value, 10);
  return Number.isFinite(precision) ? Math.min(4, Math.max(0, precision)) : 1;
}

function getFieldInput(key) {
  return fields.find((input) => input.dataset.key === key);
}

function getInputSnapshot() {
  return Object.fromEntries(fields.map((input) => [input.dataset.key, input.value]));
}

function setInputSnapshot(values = {}) {
  fields.forEach((input) => {
    const value = values[input.dataset.key];
    input.value = value === undefined || value === null ? "" : String(value);
    input.closest(".field-card").classList.toggle("is-active", input.value.trim() !== "");
  });
}

function scheduleSave() {
  if (isRestoring) {
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveState, 120);
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const normalized = {
    id: Number(item.id),
    label: String(item.label || "履歴"),
    precision: Number.isFinite(Number(item.precision)) ? Number(item.precision) : 1,
    db: Number(item.db),
    rh: Number(item.rh),
    x: Number(item.x),
    h: Number(item.h),
    dp: Number(item.dp),
    wb: Number(item.wb),
    di: Number(item.di),
  };

  if (
    !Number.isFinite(normalized.id) ||
    !Number.isFinite(normalized.db) ||
    !Number.isFinite(normalized.rh) ||
    !Number.isFinite(normalized.x) ||
    !Number.isFinite(normalized.h) ||
    !Number.isFinite(normalized.dp) ||
    !Number.isFinite(normalized.wb) ||
    !Number.isFinite(normalized.di)
  ) {
    return null;
  }
  return normalized;
}

function saveState() {
  try {
    const state = {
      pressure: pressureInput.value,
      precision: precisionInput.value,
      inputs: getInputSnapshot(),
      history,
      nextHistoryId,
      controls: {
        enthalpyAir1: enthalpyControls.air1.value,
        enthalpyAir2: enthalpyControls.air2.value,
        enthalpyAirflow: enthalpyControls.airflow.value,
        mixAir1: mixControls.air1.value,
        mixAir2: mixControls.air2.value,
        mixAirflow1: mixControls.airflow1.value,
        mixAirflow2: mixControls.airflow2.value,
        humidAir1: humidControls.air1.value,
        humidAir2: humidControls.air2.value,
        humidAirflow: humidControls.airflow.value,
        coilAir1: coilControls.air1.value,
        coilAir2: coilControls.air2.value,
        coilAirflow: coilControls.airflow.value,
        plotHistory: plotHistoryToggle.checked,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be blocked in strict browser modes.
  }
}

function restoreState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const state = JSON.parse(raw);
    isRestoring = true;

    if (state.pressure !== undefined) {
      pressureInput.value = state.pressure;
    }
    if (state.precision !== undefined) {
      precisionInput.value = state.precision;
    }
    setInputSnapshot(state.inputs || {});

    if (Array.isArray(state.history)) {
      history = state.history.map(normalizeHistoryItem).filter(Boolean).slice(0, HISTORY_LIMIT);
      nextHistoryId = Math.max(0, ...history.map((item) => item.id)) + 1;
    }

    renderHistory();
    updateConditionSelectors();

    if (state.controls) {
      enthalpyControls.air1.value = state.controls.enthalpyAir1 || "";
      enthalpyControls.air2.value = state.controls.enthalpyAir2 || "";
      enthalpyControls.airflow.value = state.controls.enthalpyAirflow || "1000";
      mixControls.air1.value = state.controls.mixAir1 || "";
      mixControls.air2.value = state.controls.mixAir2 || "";
      mixControls.airflow1.value = state.controls.mixAirflow1 || "500";
      mixControls.airflow2.value = state.controls.mixAirflow2 || "500";
      humidControls.air1.value = state.controls.humidAir1 || "";
      humidControls.air2.value = state.controls.humidAir2 || "";
      humidControls.airflow.value = state.controls.humidAirflow || "1000";
      coilControls.air1.value = state.controls.coilAir1 || "";
      coilControls.air2.value = state.controls.coilAir2 || "";
      coilControls.airflow.value = state.controls.coilAirflow || "1000";
      plotHistoryToggle.checked = state.controls.plotHistory !== false;
    }
    return true;
  } catch {
    return false;
  } finally {
    isRestoring = false;
  }
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const keys = ["db", "rh", "x", "h", "dp", "wb"];
  const hasState = keys.some((key) => params.has(key)) || params.has("p") || params.has("precision");
  if (!hasState) {
    return false;
  }

  const values = {};
  keys.forEach((key) => {
    if (params.has(key)) {
      values[key] = params.get(key);
    }
  });
  setInputSnapshot(values);
  if (params.has("p")) {
    pressureInput.value = params.get("p");
  }
  if (params.has("precision")) {
    precisionInput.value = params.get("precision");
  }
  return true;
}

function buildShareUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  const inputs = getInputSnapshot();

  Object.entries(inputs).forEach(([key, value]) => {
    if (value.trim() !== "") {
      url.searchParams.set(key, value.trim());
    }
  });
  url.searchParams.set("p", pressureInput.value);
  url.searchParams.set("precision", precisionInput.value);
  return url.toString();
}

async function copyShareUrl() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    showStatus("共有URLをコピーしました。", "success");
  } catch {
    window.history.replaceState(null, "", url);
    showStatus("共有URLをアドレスバーへ反映しました。", "success");
  }
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    return;
  }
  setInputSnapshot({ db: preset.db, rh: preset.rh });
  collectInputs();
  calculate({ addHistory: false });
  showStatus(`${preset.label}を入力しました。`, "success");
  scheduleSave();
}

function formatSigned(value, precision = getDisplayPrecision()) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  const formatted = Math.abs(value).toFixed(precision);
  if (Math.abs(value) < 10 ** -precision / 2) {
    return formatted;
  }
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function pairText(active, values, precision) {
  return active
    .map((key) => `${FIELD_LABELS[key]} ${formatNumber(values[key], precision)}${FIELD_UNITS[key]}`)
    .join(" / ");
}

function showStatus(message, type = "default") {
  statusLine.textContent = message;
  statusLine.classList.toggle("is-error", type === "error");
  statusLine.classList.toggle("is-success", type === "success");
}

function clearResults() {
  currentResult = null;
  Object.values(outputs).forEach((node) => {
    node.textContent = "-";
  });
  pairLabel.textContent = "未計算";
  copyBtn.disabled = true;
  drawChart(null);
}

function renderResult(result, precision, label) {
  currentResult = { ...result, label, precision };
  outputs.db.textContent = formatNumber(result.db, precision);
  outputs.rh.textContent = formatNumber(result.rh, precision);
  outputs.x.textContent = formatNumber(result.x, precision);
  outputs.h.textContent = formatNumber(result.h, precision);
  outputs.dp.textContent = formatNumber(result.dp, precision);
  outputs.wb.textContent = formatNumber(result.wb, precision);
  outputs.di.textContent = formatNumber(result.di, precision);
  pairLabel.textContent = label;
  copyBtn.disabled = false;
  drawChart(result);
}

function calculate(options = { addHistory: false }) {
  try {
    const { values, active } = collectInputs();
    const { pressure, precision } = getSettings();
    validatePair(values, active);
    const result = stateFromInputs(values, active, pressure);
    const label = pairText(active, values, precision);
    renderResult(result, precision, label);
    showStatus(options.addHistory ? "計算結果を履歴に追加しました。" : "計算済みです。", "success");

    if (options.addHistory) {
      addHistory(result, label, precision);
    }
    scheduleSave();
  } catch (error) {
    clearResults();
    showStatus(error.message, "error");
  }
}

function scheduleCalculation() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    const { active } = collectInputs();
    if (active.length === 2) {
      calculate({ addHistory: false });
    } else {
      clearResults();
      showStatus(active.length > 2 ? "入力する状態値は2つだけにしてください。" : "状態値を2つ入力してください。");
    }
    scheduleSave();
  }, 180);
}

function addHistory(result, label, precision) {
  history.unshift({
    id: nextHistoryId,
    label,
    precision,
    ...result,
  });
  nextHistoryId += 1;
  history = history.slice(0, HISTORY_LIMIT);
  renderHistory();
  updateConditionSelectors();
  calculateEnthalpyDifference();
  calculateMixedAir();
  calculateHumidification();
  calculateCoilCapacity();
  drawChart(currentResult);
  scheduleSave();
}

function renderHistory() {
  if (history.length === 0) {
    historyBody.innerHTML = '<tr class="empty-row"><td colspan="10">-</td></tr>';
    exportCsvBtn.disabled = true;
    return;
  }

  exportCsvBtn.disabled = false;
  historyBody.innerHTML = history
    .map((item, index) => {
      const p = item.precision;
      return `
        <tr>
          <td>${history.length - index}</td>
          <td>${escapeHtml(item.label)}</td>
          <td>${formatNumber(item.db, p)}</td>
          <td>${formatNumber(item.rh, p)}</td>
          <td>${formatNumber(item.x, p)}</td>
          <td>${formatNumber(item.h, p)}</td>
          <td>${formatNumber(item.dp, p)}</td>
          <td>${formatNumber(item.wb, p)}</td>
          <td>${formatNumber(item.di, p)}</td>
          <td>
            <div class="history-actions">
              <button class="table-action" type="button" data-history-action="load" data-id="${item.id}">入力へ</button>
              <button class="table-action" type="button" data-history-action="delete" data-id="${item.id}">削除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function historyDisplayNumber(itemId) {
  const index = history.findIndex((item) => item.id === Number(itemId));
  return index === -1 ? "-" : String(history.length - index);
}

function conditionOptionLabel(item, index) {
  const p = item.precision;
  const no = history.length - index;
  return `No.${no} ${formatNumber(item.db, p)}℃ / ${formatNumber(item.rh, p)}%`;
}

function updateConditionSelectors() {
  const selectedValues = new Map(conditionSelects.map((select) => [select.id, select.value]));
  const optionHtml = ['<option value="">条件を選択</option>']
    .concat(history.map((item, index) => `<option value="${item.id}">${conditionOptionLabel(item, index)}</option>`))
    .join("");

  conditionSelects.forEach((select) => {
    select.innerHTML = optionHtml;
    const previousValue = selectedValues.get(select.id);
    if (previousValue && history.some((item) => String(item.id) === previousValue)) {
      select.value = previousValue;
    }
  });
}

function getCondition(select) {
  const id = Number(select.value);
  return history.find((item) => item.id === id) || null;
}

function loadHistoryToInputs(id) {
  const item = history.find((entry) => entry.id === Number(id));
  if (!item) {
    return;
  }
  setInputSnapshot({ db: item.db, rh: item.rh });
  collectInputs();
  calculate({ addHistory: false });
  showStatus("履歴の条件を入力へ戻しました。", "success");
  scheduleSave();
}

function deleteHistoryItem(id) {
  history = history.filter((item) => item.id !== Number(id));
  renderHistory();
  updateConditionSelectors();
  calculateEnthalpyDifference();
  calculateMixedAir();
  calculateHumidification();
  calculateCoilCapacity();
  drawChart(currentResult);
  showStatus("履歴を削除しました。", "success");
  scheduleSave();
}

function clearMiniOutputs(nodes) {
  Object.values(nodes).forEach((node) => {
    node.textContent = "-";
  });
}

function renderDeltaTable(air1, air2, precision) {
  if (!air1 || !air2) {
    enthalpyControls.deltaBody.innerHTML = '<tr class="empty-row"><td colspan="4">-</td></tr>';
    return;
  }

  const rows = [
    ["乾球温度", "db", "℃"],
    ["相対湿度", "rh", "%"],
    ["絶対湿度", "x", "g/kg'"],
    ["比エンタルピ", "h", "kJ/kg'"],
    ["露点温度", "dp", "℃"],
    ["湿球温度", "wb", "℃"],
    ["不快指数", "di", "-"],
  ];

  enthalpyControls.deltaBody.innerHTML = rows
    .map(([label, key, unit]) => {
      const diff = air2[key] - air1[key];
      const unitText = unit === "-" ? "" : ` ${unit}`;
      return `
        <tr>
          <td>${label}</td>
          <td>${formatFlexible(air1[key], precision)}${unitText}</td>
          <td>${formatFlexible(air2[key], precision)}${unitText}</td>
          <td>${formatSigned(diff, precision)}${unitText}</td>
        </tr>
      `;
    })
    .join("");
}

function calculateEnthalpyDifference() {
  const air1 = getCondition(enthalpyControls.air1);
  const air2 = getCondition(enthalpyControls.air2);
  const airflow = Number(enthalpyControls.airflow.value);
  const precision = getDisplayPrecision();

  enthalpyControls.status.textContent = "未計算";
  enthalpyControls.diff.textContent = "-";
  enthalpyControls.load.textContent = "-";
  enthalpyControls.kw.textContent = "-";
  enthalpyControls.kcal.textContent = "-";
  enthalpyControls.rt.textContent = "-";
  renderDeltaTable(null, null, precision);

  if (!air1 || !air2) {
    return;
  }
  if (!Number.isFinite(airflow) || airflow < 0) {
    enthalpyControls.status.textContent = "風量エラー";
    return;
  }

  const diff = Math.abs(air1.h - air2.h);
  const loadKjH = diff * airflow * 1.2;
  const loadKw = loadKjH / 3600;
  enthalpyControls.diff.textContent = formatFlexible(diff, precision);
  enthalpyControls.load.textContent = formatFlexible(loadKjH, precision);
  enthalpyControls.kw.textContent = formatFlexible(loadKw, precision);
  enthalpyControls.kcal.textContent = formatFlexible(loadKjH * KCAL_PER_KJ, precision);
  enthalpyControls.rt.textContent = formatFlexible(loadKw / KW_PER_USRT, precision);
  renderDeltaTable(air1, air2, precision);
  enthalpyControls.status.textContent = "計算済み";
}

function calculateMixedAir() {
  const air1 = getCondition(mixControls.air1);
  const air2 = getCondition(mixControls.air2);
  const airflow1 = Number(mixControls.airflow1.value);
  const airflow2 = Number(mixControls.airflow2.value);
  const precision = getDisplayPrecision();

  currentMixResult = null;
  mixControls.addHistory.disabled = true;
  mixControls.status.textContent = "未計算";
  clearMiniOutputs(mixControls.outputs);

  if (!air1 || !air2) {
    return;
  }
  if (!Number.isFinite(airflow1) || !Number.isFinite(airflow2) || airflow1 < 0 || airflow2 < 0 || airflow1 + airflow2 <= 0) {
    mixControls.status.textContent = "風量エラー";
    return;
  }

  try {
    const total = airflow1 + airflow2;
    const db = (air1.db * airflow1 + air2.db * airflow2) / total;
    const w = ((air1.x / 1000) * airflow1 + (air2.x / 1000) * airflow2) / total;
    const pressure = Number(pressureInput.value) || 101.325;
    const result = completeState(db, w, pressure);

    mixControls.outputs.db.textContent = formatFlexible(result.db, precision);
    mixControls.outputs.rh.textContent = formatFlexible(result.rh, precision);
    mixControls.outputs.x.textContent = formatFlexible(result.x, precision);
    mixControls.outputs.h.textContent = formatFlexible(result.h, precision);
    mixControls.outputs.dp.textContent = formatFlexible(result.dp, precision);
    mixControls.outputs.wb.textContent = formatFlexible(result.wb, precision);
    mixControls.outputs.di.textContent = formatFlexible(result.di, precision);
    mixControls.status.textContent = "計算済み";
    currentMixResult = {
      result,
      precision,
      label: `混合空気 No.${historyDisplayNumber(air1.id)} ${airflow1}m3/h + No.${historyDisplayNumber(air2.id)} ${airflow2}m3/h`,
    };
    mixControls.addHistory.disabled = false;
  } catch {
    mixControls.status.textContent = "計算エラー";
  }
}

function addMixedAirToHistory() {
  if (!currentMixResult) {
    return;
  }
  addHistory(currentMixResult.result, currentMixResult.label, currentMixResult.precision);
  showStatus("混合空気を履歴に追加しました。", "success");
}

function calculateHumidification() {
  const air1 = getCondition(humidControls.air1);
  const air2 = getCondition(humidControls.air2);
  const airflow = Number(humidControls.airflow.value);
  const precision = getDisplayPrecision();

  humidControls.status.textContent = "未計算";
  clearMiniOutputs(humidControls.outputs);

  if (!air1 || !air2) {
    return;
  }
  if (!Number.isFinite(airflow) || airflow < 0) {
    humidControls.status.textContent = "風量エラー";
    return;
  }

  const deltaX = air2.x - air1.x;
  const waterKgH = airflow * AIR_DENSITY * deltaX / 1000;
  const latentKw = Math.abs(waterKgH) * WATER_LATENT_HEAT / 3600;

  humidControls.outputs.deltaX.textContent = formatSigned(deltaX, precision);
  humidControls.outputs.kgH.textContent = formatSigned(waterKgH, precision);
  humidControls.outputs.lDay.textContent = formatSigned(waterKgH * 24, precision);
  humidControls.outputs.latentKw.textContent = formatFlexible(latentKw, precision);
  humidControls.status.textContent = deltaX >= 0 ? "加湿" : "除湿";
}

function calculateCoilCapacity() {
  const air1 = getCondition(coilControls.air1);
  const air2 = getCondition(coilControls.air2);
  const airflow = Number(coilControls.airflow.value);
  const precision = getDisplayPrecision();

  coilControls.status.textContent = "未計算";
  clearMiniOutputs(coilControls.outputs);

  if (!air1 || !air2) {
    return;
  }
  if (!Number.isFinite(airflow) || airflow < 0) {
    coilControls.status.textContent = "風量エラー";
    return;
  }

  const massFlow = airflow * AIR_DENSITY;
  const deltaH = air2.h - air1.h;
  const deltaDb = air2.db - air1.db;
  const totalKw = Math.abs(massFlow * deltaH / 3600);
  const sensibleKw = Math.abs(massFlow * AIR_CP * deltaDb / 3600);
  const latentKw = Math.max(0, totalKw - sensibleKw);
  const shr = totalKw > 0 ? Math.min(1, sensibleKw / totalKw) : 0;
  const mode = deltaH < 0 ? "冷却" : deltaH > 0 ? "加熱" : "同等";

  coilControls.outputs.mode.textContent = mode;
  coilControls.outputs.totalKw.textContent = formatFlexible(totalKw, precision);
  coilControls.outputs.sensibleKw.textContent = formatFlexible(sensibleKw, precision);
  coilControls.outputs.latentKw.textContent = formatFlexible(latentKw, precision);
  coilControls.outputs.shr.textContent = formatFlexible(shr, 2);
  coilControls.status.textContent = "計算済み";
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportHistoryCsv() {
  if (history.length === 0) {
    return;
  }

  const headers = ["No.", "入力", "乾球温度[℃]", "相対湿度[%]", "絶対湿度[g/kg']", "比エンタルピ[kJ/kg']", "露点温度[℃]", "湿球温度[℃]", "不快指数[-]"];
  const rows = history.map((item, index) => {
    const p = item.precision;
    return [
      history.length - index,
      item.label,
      formatNumber(item.db, p),
      formatNumber(item.rh, p),
      formatNumber(item.x, p),
      formatNumber(item.h, p),
      formatNumber(item.dp, p),
      formatNumber(item.wb, p),
      formatNumber(item.di, p),
    ];
  });
  const csv = "\ufeff" + [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  anchor.href = url;
  anchor.download = `air-state-history-${stamp}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showStatus("履歴CSVを出力しました。", "success");
}

async function copyCurrentResult() {
  if (!currentResult) {
    return;
  }

  const p = currentResult.precision;
  const headers = ["入力", "乾球温度[℃]", "相対湿度[%]", "絶対湿度[g/kg']", "比エンタルピ[kJ/kg']", "露点温度[℃]", "湿球温度[℃]", "不快指数[-]"];
  const values = [
    currentResult.label,
    formatNumber(currentResult.db, p),
    formatNumber(currentResult.rh, p),
    formatNumber(currentResult.x, p),
    formatNumber(currentResult.h, p),
    formatNumber(currentResult.dp, p),
    formatNumber(currentResult.wb, p),
    formatNumber(currentResult.di, p),
  ];
  const text = `${headers.join("\t")}\n${values.join("\t")}`;

  try {
    await navigator.clipboard.writeText(text);
    showStatus("計算結果をコピーしました。", "success");
  } catch {
    showStatus("クリップボードへコピーできませんでした。", "error");
  }
}

function resetInputs() {
  fields.forEach((input) => {
    input.value = "";
    input.closest(".field-card").classList.remove("is-active");
  });
  collectInputs();
  clearResults();
  showStatus("状態値を2つ入力してください。");
  fields[0].focus();
  scheduleSave();
}

function drawChart(result) {
  const canvas = chartCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, rect.width);
  const height = Math.max(260, rect.height);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const margin = { top: 18, right: 24, bottom: 42, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const pressure = Number(pressureInput.value) || 101.325;
  const dbMin = -10;
  const dbMax = 50;
  const shouldPlotHistory = plotHistoryToggle && plotHistoryToggle.checked;
  const historyMaxX = shouldPlotHistory && history.length > 0 ? Math.max(...history.map((item) => item.x)) : 0;
  const resultMaxX = result ? result.x : 0;
  const xMax = Math.max(30, Math.ceil((Math.max(historyMaxX, resultMaxX) * 1.25) / 5) * 5);

  const xToPx = (db) => margin.left + ((db - dbMin) / (dbMax - dbMin)) * plotW;
  const yToPx = (humidity) => margin.top + plotH - (humidity / xMax) * plotH;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#d8e1de";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let db = dbMin; db <= dbMax; db += 10) {
    const x = xToPx(db);
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + plotH);
  }
  for (let h = 0; h <= xMax; h += 5) {
    const y = yToPx(h);
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "#1f2933";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  ctx.fillStyle = "#64748b";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  for (let db = dbMin; db <= dbMax; db += 10) {
    ctx.fillText(String(db), xToPx(db), margin.top + plotH + 22);
  }
  ctx.textAlign = "right";
  for (let h = 0; h <= xMax; h += 5) {
    ctx.fillText(String(h), margin.left - 9, yToPx(h) + 4);
  }

  ctx.textAlign = "center";
  ctx.fillText("乾球温度 ℃", margin.left + plotW / 2, height - 10);
  ctx.save();
  ctx.translate(15, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("絶対湿度 g/kg'", 0, 0);
  ctx.restore();

  [20, 40, 60, 80, 100].forEach((rh) => {
    ctx.beginPath();
    let started = false;
    for (let db = dbMin; db <= dbMax; db += 0.5) {
      const w = humidityRatioFromDbRh(db, rh, pressure) * 1000;
      if (!Number.isFinite(w) || w < 0 || w > xMax) {
        started = false;
        continue;
      }
      const px = xToPx(db);
      const py = yToPx(w);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.strokeStyle = rh === 100 ? "#087f75" : "rgba(37, 99, 235, 0.34)";
    ctx.lineWidth = rh === 100 ? 2 : 1.2;
    ctx.stroke();

    const labelDb = rh === 100 ? 31 : 44;
    const labelW = humidityRatioFromDbRh(labelDb, rh, pressure) * 1000;
    if (Number.isFinite(labelW) && labelW <= xMax) {
      ctx.fillStyle = rh === 100 ? "#087f75" : "#2563eb";
      ctx.fillText(`${rh}%`, xToPx(labelDb), yToPx(labelW) - 5);
    }
  });

  if (shouldPlotHistory && history.length > 0) {
    history.slice().reverse().forEach((item, reverseIndex) => {
      const displayNo = reverseIndex + 1;
      const dotX = xToPx(item.db);
      const dotY = yToPx(item.x);
      if (
        dotX < margin.left ||
        dotX > margin.left + plotW ||
        dotY < margin.top ||
        dotY > margin.top + plotH
      ) {
        return;
      }
      ctx.fillStyle = "rgba(8, 127, 117, 0.78)";
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#075f58";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(displayNo), dotX + 6, dotY + 4);
    });

    ctx.fillStyle = "#075f58";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("履歴点", margin.left + 6, margin.top + 16);
  }

  if (result) {
    const dotX = xToPx(result.db);
    const dotY = yToPx(result.x);
    if (
      dotX >= margin.left &&
      dotX <= margin.left + plotW &&
      dotY >= margin.top &&
      dotY <= margin.top + plotH
    ) {
      ctx.fillStyle = "#d97706";
      ctx.beginPath();
      ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#7c2d12";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#7c2d12";
      ctx.textAlign = "left";
      ctx.fillText("計算点", dotX + 10, dotY - 8);
    }
  }
}

function exportChartPng() {
  drawChart(currentResult);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const filename = `psychrometric-chart-${stamp}.png`;

  const downloadUrl = (url) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  if (chartCanvas.toBlob) {
    chartCanvas.toBlob((blob) => {
      if (!blob) {
        showStatus("PNGを生成できませんでした。", "error");
        return;
      }
      const url = URL.createObjectURL(blob);
      downloadUrl(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus("空気線図PNGを出力しました。", "success");
    }, "image/png");
    return;
  }

  downloadUrl(chartCanvas.toDataURL("image/png"));
  showStatus("空気線図PNGを出力しました。", "success");
}

function printReport() {
  showStatus("印刷画面を開きました。PDF保存は印刷画面で選択してください。", "success");
  window.print();
}

fields.forEach((input) => {
  input.addEventListener("input", scheduleCalculation);
});
pressureInput.addEventListener("input", scheduleCalculation);
precisionInput.addEventListener("input", () => {
  scheduleCalculation();
  calculateEnthalpyDifference();
  calculateMixedAir();
  calculateHumidification();
  calculateCoilCapacity();
  scheduleSave();
});
presetButtons.forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});
calculateBtn.addEventListener("click", () => calculate({ addHistory: true }));
copyBtn.addEventListener("click", copyCurrentResult);
shareUrlBtn.addEventListener("click", copyShareUrl);
resetBtn.addEventListener("click", resetInputs);
plotHistoryToggle.addEventListener("change", () => {
  drawChart(currentResult);
  scheduleSave();
});
exportChartPngBtn.addEventListener("click", exportChartPng);
printReportBtn.addEventListener("click", printReport);
exportCsvBtn.addEventListener("click", exportHistoryCsv);
clearHistoryBtn.addEventListener("click", () => {
  history = [];
  nextHistoryId = 1;
  renderHistory();
  updateConditionSelectors();
  calculateEnthalpyDifference();
  calculateMixedAir();
  calculateHumidification();
  calculateCoilCapacity();
  drawChart(currentResult);
  scheduleSave();
});
historyBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-action]");
  if (!button) {
    return;
  }

  if (button.dataset.historyAction === "load") {
    loadHistoryToInputs(button.dataset.id);
  }
  if (button.dataset.historyAction === "delete") {
    deleteHistoryItem(button.dataset.id);
  }
});
[
  enthalpyControls.air1,
  enthalpyControls.air2,
  enthalpyControls.airflow,
].forEach((control) => {
  control.addEventListener("input", () => {
    calculateEnthalpyDifference();
    scheduleSave();
  });
  control.addEventListener("change", () => {
    calculateEnthalpyDifference();
    scheduleSave();
  });
});
[
  mixControls.air1,
  mixControls.air2,
  mixControls.airflow1,
  mixControls.airflow2,
].forEach((control) => {
  control.addEventListener("input", () => {
    calculateMixedAir();
    scheduleSave();
  });
  control.addEventListener("change", () => {
    calculateMixedAir();
    scheduleSave();
  });
});
[
  humidControls.air1,
  humidControls.air2,
  humidControls.airflow,
].forEach((control) => {
  control.addEventListener("input", () => {
    calculateHumidification();
    scheduleSave();
  });
  control.addEventListener("change", () => {
    calculateHumidification();
    scheduleSave();
  });
});
[
  coilControls.air1,
  coilControls.air2,
  coilControls.airflow,
].forEach((control) => {
  control.addEventListener("input", () => {
    calculateCoilCapacity();
    scheduleSave();
  });
  control.addEventListener("change", () => {
    calculateCoilCapacity();
    scheduleSave();
  });
});
mixControls.addHistory.addEventListener("click", addMixedAirToHistory);

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("input")) {
    event.preventDefault();
    calculate({ addHistory: true });
  }
});

window.addEventListener("resize", () => drawChart(currentResult));

const restored = restoreState();
const appliedUrl = applyUrlState();
collectInputs();
updateConditionSelectors();
calculateEnthalpyDifference();
calculateMixedAir();
calculateHumidification();
calculateCoilCapacity();
drawChart(currentResult);
if (appliedUrl) {
  calculate({ addHistory: false });
  showStatus("共有URLの条件を読み込みました。", "success");
  scheduleSave();
} else if (restored) {
  const { active } = collectInputs();
  if (active.length === 2) {
    calculate({ addHistory: false });
  } else {
    clearResults();
    showStatus("前回の履歴を復元しました。", "success");
  }
}
