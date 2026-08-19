// 주식 전쟁 — /api/state 의 전투 상태를 3D 저폴리 전장으로 렌더한다.
// 홍군(빨강) = 매수 세력, 청군(파랑) = 매도 세력.
// 병종: 보병 = 개인, 궁병 = 연기금, 기병 = 외국인, 장군 = 기관.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 황혼의 전장. 무기는 양 진영 모두 강철색이다 — 무기까지 진영색이면 실루엣 구별이 죽는다.
const PAL = {
  red: 0xd8342b, blue: 0x2f6fd0, gold: 0xe8c26a, steel: 0x9aa3ad,
  ground: 0x3f4436, dust: 0x4a3526, night: 0x14121c, fog: 0x2b2128,
  horse: 0x4a3a2e, wood: 0x7a5a38, pine: 0x2f4034, stone: 0x6d6560,
  ruin: 0x2b2622, line: 0xf2f0ea,
};
const CROWD = [0x6b5f52, 0x7a6a58, 0x5c5a4e, 0x83705c, 0x4f4a42, 0x6e6156];
const GLOW = { red: new THREE.Color(0x8f2016), blue: new THREE.Color(0x163a72) };
const BASE = new THREE.Color(PAL.ground);

// 퍼센트는 중앙(경계)이 0%, 각 진영 바깥 끝이 100% 다.
// 막사가 본성보다 앞(중앙 쪽)에 서는 전진 진지 배치이고, 전선이 밀리면
// 막사를 차례로 덮은 뒤 본성에 닿는다.
const MAP_HALF = 800;                       // 100% 기준이 되는 맵 가로 반폭
const CASTLE_X = MAP_HALF * 0.35;           // 280 — 본성
const HALF_Z = 160;
// 성과 성 사이가 곧 가격제한폭 60%p 다. 중앙이 기준가(0%), 양 끝이 ±30%.
// 바닥의 모든 눈금과 막사 위치를 이 자 하나로 그린다.
const LIMIT_PCT = 30;                        // 가격제한폭
// ±30% 눈금은 성보다 살짝 안쪽에 긋는다. 성이 선 위에 걸터앉으면 선이 성에 먹혀
// 어디가 상하한가인지 안 보인다. 전선은 그 선까지만 가고 성은 그 너머에 선다.
const LIMIT_X = CASTLE_X - 34;
const PCT_X = LIMIT_X / LIMIT_PCT;           // 등락률 1% 가 차지하는 거리
const FRONT_MAX = LIMIT_X;                   // ±30% 에서 성벽 앞에 닿는다
const CAMP_X = [10 * PCT_X, 20 * PCT_X];     // 전진 막사 — 10% / 20% 눈금 위에 선다
const KINDS = ['infantry', 'archer', 'cavalry', 'general'];
const CAP = { infantry: 170, archer: 110, cavalry: 85, general: 24 };

// 대형. near = 전선에서 첫 열까지 거리, cols = 한 열의 인원, gx/gz = 열·인원 간격.
const FORM = {
  infantry: { near: 9, cols: 22, gx: 11.0, gz: 12.5, chaos: 1.0, bow: 1.8 },
  cavalry: { near: 30, cols: 3, gx: 12.0, gz: 18.0, wing: true, chaos: 0.7, bow: 0.6 },
  archer: { near: 62, cols: 14, gx: 14.4, gz: 16.0, chaos: 0.35, bow: 0.3 },
  general: { near: 112, cols: 5, gx: 20.0, gz: 26.0, chaos: 0.25, bow: 0.2 },
};
const HAND = {   // 무기를 쥔 손의 위치 (유닛 로컬 좌표)
  infantry: [0.30, 1.05, 0.19], archer: [0.34, 1.12, 0.02],
  cavalry: [0.30, 2.06, 0.19], general: [0.44, 1.34, 0.24],
};
const REST = { infantry: 0.35, archer: 0, cavalry: -1.2, general: 0.35 };
const UNIT_SCALE = 3.2;      // 전장이 넓어 유닛을 키워야 사람으로 읽힌다

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const rnd = () => Math.random() * 2 - 1;
// 인덱스 기반 결정적 난수 — 유닛이 매 틱마다 제자리를 바꾸면 안 된다
const hash01 = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// 부위마다 [지오메트리, 색] 으로 준다. 재질은 흰색이고 색은 전부 정점에 실린다.
// 밝기 배수로 두면 진영색의 명암 변주밖에 안 나와 얼굴이든 투구든 죄다 빨강/파랑이
// 된다. 실제 색을 실어야 살색과 쇠붙이와 옷이 따로 읽힌다.
const _mc = new THREE.Color();
const merge = parts => {
  const geos = [], cols = [];
  for (const part of parts) {
    const [g, color = 0xffffff] = Array.isArray(part) ? part : [part, 0xffffff];
    const geo = g.index ? g.toNonIndexed() : g;
    geos.push(geo);
    _mc.set(color);
    for (let i = geo.attributes.position.count; i > 0; i--) cols.push(_mc.r, _mc.g, _mc.b);
  }
  const merged = mergeGeometries(geos);
  merged.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return merged;
};

// 진영과 무관한 부위 색. 살결·쇠·가죽은 양쪽 군대가 같다.
const PART = {
  skin: 0xc98d63, skinDark: 0xa9714c,
  steel: 0x8b929e, steelDark: 0x5d636d,
  leather: 0x6d4a2c, wood: 0x7a5a38,
  boot: 0x33261d, gold: 0xd8b25c,
  horse: 0x4a382a, horseDark: 0x30231a, hoof: 0x1f1712,
};

// 진영색에서 옷·방패·망토 색을 뽑는다. 같은 계열이되 명도를 벌려 겹쳐도 형태가 산다.
function cloth(side) {
  const c = new THREE.Color(side === 'red' ? PAL.red : PAL.blue);
  return {
    main: c.getHex(),
    dark: c.clone().multiplyScalar(0.55).getHex(),
    light: c.clone().lerp(new THREE.Color(0xffffff), 0.34).getHex(),
  };
}

// --- 씬 ---------------------------------------------------------------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PAL.fog, 600, 1680);

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4800);
camera.position.set(0, 240, 600);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 30;
controls.maxDistance = 1680;

const hemi = new THREE.HemisphereLight(0x6a5f74, 0x2e2a1e, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffb974, 1.45);   // 낮게 깔린 황혼빛
sun.position.set(-90, 46, 34);
scene.add(sun);

// --- 하루 ---------------------------------------------------------------------
// 한국 시각을 따라 해가 뜨고 진다. 시각별 하늘색을 몇 개만 박아 두고 사이를 섞는다.
// 값을 시간마다 다 적으면 손대기 어려워서 여명·한낮·노을·심야만 잡았다.
const SKY_KEYS = [
  { h: 0,    top: 0x05060f, horizon: 0x0d1020, ember: 0x151a2e, night: 1.00 },
  { h: 5,    top: 0x111731, horizon: 0x2f2b47, ember: 0x5b3f52, night: 0.72 },
  { h: 6.6,  top: 0x24406b, horizon: 0xc9754c, ember: 0xe2894a, night: 0.14 },
  { h: 9,    top: 0x2c6aa8, horizon: 0x9db9d4, ember: 0xc9d6e2, night: 0.00 },
  { h: 12,   top: 0x2f78c0, horizon: 0xa8c4de, ember: 0xd2e0ec, night: 0.00 },
  { h: 16,   top: 0x2e6ba4, horizon: 0xb3b4c0, ember: 0xd8b48e, night: 0.00 },
  { h: 18.4, top: 0x2b2440, horizon: 0xd4682f, ember: 0xf09040, night: 0.18 },
  { h: 20,   top: 0x101430, horizon: 0x3d2a3e, ember: 0x6b3a34, night: 0.68 },
  { h: 22.5, top: 0x06070f, horizon: 0x0f1222, ember: 0x1a1e30, night: 0.96 },
  { h: 24,   top: 0x05060f, horizon: 0x0d1020, ember: 0x151a2e, night: 1.00 },
];

const _kA = new THREE.Color(), _kB = new THREE.Color(), _kC = new THREE.Color();

function skyAt(hour) {
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].h <= hour) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
  const t = clamp((hour - a.h) / (b.h - a.h), 0, 1);
  return {
    top: _kA.setHex(a.top).lerp(_kB.setHex(b.top), t).clone(),
    horizon: _kB.setHex(a.horizon).lerp(_kC.setHex(b.horizon), t).clone(),
    ember: _kC.setHex(a.ember).lerp(_kA.setHex(b.ember), t).clone(),
    night: a.night + (b.night - a.night) * t,
  };
}

const SKY_R = 2400;
const skyGeo = new THREE.SphereGeometry(SKY_R, 20, 14);
skyGeo.setAttribute('color',
  new THREE.Float32BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
scene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
  vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));

// 별. 밤에만 드러나되 위치는 고정이라 하늘이 도는 느낌은 주지 않는다.
const starMat = new THREE.PointsMaterial({
  color: 0xdfe6f5, size: 9, sizeAttenuation: true, transparent: true,
  opacity: 0, depthWrite: false, fog: false });
{
  const n = 420, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = hash01(i * 1.7) * 2 - 1, a = hash01(i * 3.1) * 6.283;
    const r = Math.sqrt(1 - u * u) * (SKY_R * 0.97);
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.abs(u) * SKY_R * 0.97 + 40;   // 지평선 아래는 안 뿌린다
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, starMat);
  stars.frustumCulled = false;
  scene.add(stars);
}

// 달과 해. 같은 축을 돌되 서로 반대편에 있다.
const moon = new THREE.Mesh(new THREE.SphereGeometry(70, 14, 10),
  new THREE.MeshBasicMaterial({ color: 0xe8ecf5, fog: false, transparent: true, opacity: 0 }));
moon.frustumCulled = false;
scene.add(moon);
const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(85, 14, 10),
  new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: false, transparent: true, opacity: 0 }));
sunDisc.frustumCulled = false;
scene.add(sunDisc);

let kstHour = 18;             // 서버가 알려주기 전까지의 기본값
let skyPaintedAt = -99;

function updateSky(hour) {
  // 해는 06시에 떠서 18시에 진다. 그 사이를 반원으로 돈다.
  const day = clamp((hour - 6) / 12, 0, 1);
  const ang = day * Math.PI;
  const elev = Math.sin(ang), up = hour > 6 && hour < 18;
  const sx = -Math.cos(ang) * 1600, sy = elev * 1400 - 120, sz = 420;
  sun.position.set(sx, Math.max(sy, -400), sz);

  const k = skyAt(hour);
  const lit = clamp(elev, 0, 1);
  sun.intensity = up ? 0.35 + lit * 1.25 : 0.12;
  sun.color.setHex(0xffb974).lerp(new THREE.Color(0xfff3dd), lit);
  hemi.intensity = 0.30 + (1 - k.night) * 0.75;
  hemi.color.copy(k.horizon).lerp(new THREE.Color(0xffffff), 0.25);
  hemi.groundColor.setHex(0x2e2a1e).lerp(k.horizon, 0.2);
  scene.fog.color.copy(k.horizon).lerp(k.top, 0.35);

  sunDisc.position.set(sx, sy, sz).setLength(SKY_R * 0.9);
  sunDisc.material.opacity = up ? clamp(1 - k.night * 2, 0, 1) : 0;
  moon.position.set(-sx, -sy + 300, -sz).setLength(SKY_R * 0.9);
  moon.material.opacity = clamp(k.night * 1.2 - 0.1, 0, 1);
  starMat.opacity = clamp(k.night * 1.15 - 0.15, 0, 1);

  if (Math.abs(hour - skyPaintedAt) < 0.02) return;   // 정점 다시 칠하는 건 가끔만
  skyPaintedAt = hour;
  const pos = skyGeo.attributes.position, col = skyGeo.attributes.color;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / SKY_R;
    if (y < 0.08) c.copy(k.horizon).lerp(k.ember, clamp(1 - Math.abs(y) * 11, 0, 1) * 0.7);
    else c.copy(k.horizon).lerp(k.top, clamp(y * 1.8, 0, 1));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// 전장 안은 거의 평평하게 둔다. 울퉁불퉁하면 땅에 번지는 진영 빛이 지저분해진다.
// 바깥은 이 지형 자체가 배경 산이다. 삼각파를 겹쳐 봉우리와 골을 각지게 접는다.
// 카메라가 있는 앞쪽(+z) 능선은 낮게 눌러야 전장을 가리지 않는다.
const tri = t => Math.abs(((t % 1) + 1) % 1 - 0.5) * 2;    // 0~1 삼각파

function groundY(x, z) {
  const flat = Math.sin(x * 0.0175) * 1.2 + Math.cos(z * 0.0275) * 1.2;
  const edge = clamp((Math.abs(z) - HALF_Z) / 104, 0, 1);
  // 전장 안은 거의 평평해야 한다. 기복이 바닥 눈금보다 높으면 선이 땅에 묻혀
  // 군데군데 끊긴 것처럼 보인다.
  if (edge <= 0) return flat * 0.12;
  const ridge = tri(x * 0.00275) * 0.52 + tri(x * 0.00725 + 0.37) * 0.24
              + tri(x * 0.019 + 0.61) * 0.13 + tri(z * 0.005) * 0.11;
  // 골을 한 번 더 파야 능선이 겹겹으로 보인다
  const fold = 0.72 + 0.42 * tri(x * 0.0041 + z * 0.0016);
  return flat + edge * edge * (z > 0 ? 60 : 152) * (0.40 + ridge) * fold;
}

let CROWD_MESH, CROWD_SEATS;

// 면마다 독립된 색을 주려면 정점을 공유하면 안 된다. non-indexed 라야 접힌 각이
// 색으로도 드러난다.
const groundGeo = new THREE.PlaneGeometry(1840, 1200, 56, 38).rotateX(-Math.PI / 2).toNonIndexed();
const baseCols = new Float32Array(groundGeo.attributes.position.count * 3);
{
  const p = groundGeo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, groundY(p.getX(i), p.getZ(i)));
  groundGeo.computeVertexNormals();   // non-indexed 라 이게 곧 면 법선이다

  // 면이 향한 각도로 색을 나눈다 — 평평하면 마른 풀, 가파르면 드러난 바위,
  // 높이 오를수록 옅은 돌빛. 같은 산이라도 면마다 색이 갈려 각이 살아난다.
  const grass = new THREE.Color(PAL.ground), soil = new THREE.Color(0x4a3f2e);
  const rock = new THREE.Color(0x4d4a46), high = new THREE.Color(0x6d6a63);
  const road = new THREE.Color(0x6f6b64);            // 짓밟혀 다져진 회색 흙바닥
  // 고도에 따라 갈리는 띠. 아래는 마른 덤불, 중턱은 침엽수 그늘, 위는 헐벗은 바위,
  // 꼭대기는 눈. 띠가 있어야 배경이 한 덩어리 갈색으로 안 뭉갠다.
  const scrub = new THREE.Color(0x4d4a30), pine = new THREE.Color(0x2c3a2c);
  const bare = new THREE.Color(0x5b544b), snow = new THREE.Color(0xb9bcc0);
  const n = groundGeo.attributes.normal, c = new THREE.Color();
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const slope = 1 - n.getY(i);                       // 0 = 평평, 1 = 수직
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const z = (p.getZ(i) + p.getZ(i + 2) + p.getZ(i + 1)) / 3;
    // 성과 성 사이는 전장이다. 풀밭이 아니라 다져진 흙길로 깔아 싸움터로 읽히게 한다.
    if (Math.abs(x) <= CASTLE_X + 20 && Math.abs(z) <= HALF_Z) {
      c.copy(road).offsetHSL(0, 0, (hash01(i * 0.31) - 0.5) * 0.06);
      for (let k = 0; k < 3; k++) c.toArray(baseCols, (i + k) * 3);
      continue;
    }
    c.copy(grass).lerp(soil, clamp(slope * 1.6, 0, 1) * 0.55);
    c.lerp(scrub, clamp((y - 4) / 22, 0, 1) * 0.6);
    c.lerp(pine, clamp((y - 20) / 34, 0, 1) * 0.5);
    c.lerp(rock, clamp((slope - 0.16) * 2.4, 0, 1));
    c.lerp(bare, clamp((y - 58) / 46, 0, 1) * 0.8);
    c.lerp(snow, clamp((y - 108) / 34, 0, 1) * clamp(1 - slope * 1.5, 0, 1));
    // 북사면은 그늘지고 남사면은 볕을 받는다. 같은 높이라도 면 방향으로 갈린다
    c.offsetHSL(0, 0, n.getX(i) * 0.055 + n.getZ(i) * 0.045);
    // 등성이(위를 향하면서 높은 면)만 살짝 띄워 능선을 긋는다
    if (n.getY(i) > 0.86 && y > 24) c.offsetHSL(0, -0.04, 0.05);
    for (let k = 0; k < 3; k++) c.toArray(baseCols, (i + k) * 3);
  }
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(baseCols.slice(), 3));
  scene.add(new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true })));
}

// 매수/매도 세력이 땅을 물들인다. 경계에서 가장 진하고 뒤로 갈수록 옅어진다.
const gcol = new THREE.Color();
let paintedAt = null;
// 진영 빛은 거래가(현재가) 선에서 갈린다. 지금 값이 곧 두 세력이 맞붙은 자리다.
function paintGround(frontX, redPower, bluePower) {
  // 정점이 만 단위라 매 프레임 다시 칠할 이유가 없다. 눈에 띄게 변했을 때만.
  if (paintedAt && Math.abs(paintedAt.f - frontX) < 0.6 &&
      Math.abs(paintedAt.r - redPower) < 0.01 && Math.abs(paintedAt.b - bluePower) < 0.01) return;
  paintedAt = { f: frontX, r: redPower, b: bluePower };

  const p = groundGeo.attributes.position, c = groundGeo.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const d = p.getX(i) - frontX;
    const red = d < 0;
    const power = red ? redPower : bluePower;
    const fade = Math.exp(-Math.abs(d) / (64 + power * 208)) * power;
    // 바깥 비탈까지 빛이 번지면 전장 경계가 흐려진다
    const edge = clamp(1 - Math.max(0, Math.abs(p.getZ(i)) - HALF_Z) / 36, 0, 1);
    const o = i * 3;
    gcol.fromArray(baseCols, o).lerp(red ? GLOW.red : GLOW.blue, fade * edge);
    c.setXYZ(i, gcol.r, gcol.g, gcol.b);
  }
  c.needsUpdate = true;
}

// --- 관중 --------------------------------------------------------------------
// 앞쪽에는 나무를 세우지 않는다. 시야를 막는 대신 능선에 관중을 앉힌다.
{
  const col = new THREE.Color();
  // 능선 위 관중 — 전투가 격해지면 함성을 지르듯 튄다
  // 관중도 부위를 나눈다. 멀리 있어도 사람 실루엣으로 읽혀야 시점을 옮겨가
  // 들여다볼 대상이 된다. 옷 색은 인스턴스마다 달리 주므로 흰색으로 두고,
  // 살결과 머리만 여기서 고정한다.
  const body = merge([
    [new THREE.CylinderGeometry(0.34, 0.46, 1.00, 5).translate(0, 0.50, 0), 0xffffff],
    [new THREE.BoxGeometry(0.16, 0.42, 0.16).translate(0.30, 0.72, 0), 0xf2f2f2],   // 팔
    [new THREE.BoxGeometry(0.16, 0.42, 0.16).translate(-0.30, 0.72, 0), 0xf2f2f2],
    [new THREE.BoxGeometry(0.18, 0.34, 0.18).translate(0.11, 0.14, 0), 0x6a6a6a],   // 다리
    [new THREE.BoxGeometry(0.18, 0.34, 0.18).translate(-0.11, 0.14, 0), 0x6a6a6a],
    [new THREE.IcosahedronGeometry(0.28, 0).translate(0, 1.22, 0), 0xd9a97e],       // 머리
    [new THREE.CylinderGeometry(0.30, 0.32, 0.16, 6).translate(0, 1.44, 0), 0x5a4a3a],  // 벙거지
    [new THREE.CylinderGeometry(0.44, 0.44, 0.05, 6).translate(0, 1.37, 0), 0x5a4a3a],
  ]);
  const M = 200;
  const crowd = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({
    flatShading: true, vertexColors: true }), M);
  const seats = [];
  for (let i = 0; i < M; i++) {
    const front = i % 3 !== 0;                      // 관중은 앞쪽 능선에 더 많이 앉는다
    const z = (HALF_Z + 20 + hash01(i * 2.9) * (front ? 52 : 88)) * (front ? 1 : -1);
    const x = (hash01(i * 1.3) * 2 - 1) * (CASTLE_X + 25);
    seats.push({ x, y: groundY(x, z), z, ph: hash01(i * 8.1) * 6.283, sc: 3.0 + hash01(i * 4.7) * 1.4 });
    crowd.setColorAt(i, col.setHex(CROWD[Math.floor(hash01(i * 9.3) * CROWD.length)]));
  }
  crowd.frustumCulled = false;
  scene.add(crowd);
  CROWD_MESH = crowd;
  CROWD_SEATS = seats;
}

// --- 말풍선 -----------------------------------------------------------------
// 관중도 병사도 InstancedMesh 라 개별 자식을 붙일 수 없다. 풍선을 여러 개 만들어
// 두고 "누가 말하는가"만 갈아 끼우며 돌려 쓴다. 대상은 좌석 번호이거나
// (진영:병종, 인덱스) 쌍이다.
const BUBBLES = 30;
const bubblePool = [];
{
  for (let i = 0; i < BUBBLES; i++) {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 192;
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 11.25),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.visible = false;
    mesh.renderOrder = 3;
    scene.add(mesh);
    bubblePool.push({ cv, tex, mesh, until: 0, target: null });
  }
}

function drawBubble(b, text, tone) {
  const g = b.cv.getContext('2d');
  g.clearRect(0, 0, 512, 192);
  const w = 512, h = 150, r = 26;
  g.fillStyle = tone || 'rgba(248,244,235,.94)';
  g.strokeStyle = 'rgba(60,50,40,.5)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(w, 0, w, h, r);
  g.arcTo(w, h, 0, h, r);
  g.arcTo(0, h, 0, 0, r);
  g.arcTo(0, 0, w, 0, r);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();                                   // 꼬리
  g.moveTo(w / 2 - 22, h - 2);
  g.lineTo(w / 2, 188);
  g.lineTo(w / 2 + 22, h - 2);
  g.closePath();
  g.fill();
  g.fillStyle = '#2a2118';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '600 54px "Gowun Dodum", system-ui, sans-serif';
  const line = String(text).slice(0, 26);
  if (line.length > 13) {
    const cut = line.lastIndexOf(' ', 13) + 1 || 13;
    g.fillText(line.slice(0, cut).trim(), w / 2, h / 2 - 30);
    g.fillText(line.slice(cut).trim(), w / 2, h / 2 + 30);
  } else {
    g.fillText(line, w / 2, h / 2);
  }
  b.tex.needsUpdate = true;
}

const freeBubble = () => bubblePool.find(x => !x.mesh.visible)
                      || bubblePool.reduce((a, x) => (x.until < a.until ? x : a));

// 관중 한 명이 말한다. seat 를 안 주면 아무나 고른다.
function crowdSay(text, seat = -1, ms = 4200) {
  if (!CROWD_SEATS || !CROWD_SEATS.length) return null;
  const b = freeBubble();
  b.target = { crowd: seat >= 0 ? seat % CROWD_SEATS.length
                                : Math.floor(Math.random() * CROWD_SEATS.length) };
  drawBubble(b, text);
  b.until = performance.now() + ms;
  b.mesh.visible = true;
  return b.target;
}

// 병사 한 명이 말한다. 진영/병종/인덱스를 안 주면 살아 있는 아무나 고른다.
function unitSay(text, side, kind, index = -1, ms = 3600) {
  const pool = [];
  for (const sd of (side ? [side] : ['red', 'blue']))
    for (const kd of (kind ? [kind] : KINDS)) {
      const a = armies[sd + ':' + kd];
      if (a && a.mesh.count) pool.push(a);
    }
  if (!pool.length) return null;
  const a = pool[Math.floor(Math.random() * pool.length)];
  const i = index >= 0 ? index % a.mesh.count : Math.floor(Math.random() * a.mesh.count);
  const b = freeBubble();
  b.target = { army: a.side + ':' + a.kind, index: i };
  drawBubble(b, text, a.side === 'red' ? 'rgba(255,238,232,.95)' : 'rgba(232,240,255,.95)');
  b.until = performance.now() + ms;
  b.mesh.visible = true;
  return b.target;
}

// 바깥에서 들어오는 한마디. 채팅이 붙으면 이 함수 하나로 흘려 보내면 된다.
//   speak('가즈아')                              아무 관중
//   speak('돌격!', { unit: true })               아무 병사
//   speak('...', { seat: 12 })                   12번 관중
//   speak('...', { army: 'red:infantry', index: 3 })
function speak(text, to = {}) {
  if (!text) return null;
  if (to.army) {
    const [sd, kd] = String(to.army).split(':');
    return unitSay(text, sd, kd, to.index != null ? to.index : -1, to.ms || 5200);
  }
  if (to.unit) return unitSay(text, to.side, to.kind, -1, to.ms || 5200);
  return crowdSay(text, to.seat != null ? to.seat : -1, to.ms || 5200);
}

// 지금 전장에 서 있는 머릿수. 채팅으로 아무나 지목할 때 범위를 알아야 한다.
function population() {
  const armiesCount = {};
  let soldiers = 0;
  for (const key in armies) {
    armiesCount[key] = armies[key].mesh.count;
    soldiers += armies[key].mesh.count;
  }
  return { soldiers, crowd: CROWD_SEATS ? CROWD_SEATS.length : 0,
           total: soldiers + (CROWD_SEATS ? CROWD_SEATS.length : 0), byArmy: armiesCount };
}

// --- 대사 -------------------------------------------------------------------
const CROWD_LINES = {
  up: ['가즈아', '떡상 간다', '존버 승리', '이거 실화냐', '왜 안 샀지', '불장이다',
       '익절은 언제', '더 가라 더', '내 인생 폈다', '오늘 소고기', '홍군 밀어',
       '한 발만 더', '매수벽 두껍다', '오르는 게 정상이지', '아까 판 놈 누구야',
       '지금이라도 탈까', '치킨 시킨다', '이번엔 느낌이 좋아', '월급 필요 없다',
       '퇴사 각인가', '내가 이럴 줄 알았지', '어제 산 나 천재', '더블 가자',
       '차트가 하늘을 뚫네', '홍군 만세', '성문 열어라', '지금 타도 안 늦었지',
       '엄마 나 성공했어', '아 왜 조금만 샀지', '역시 우상향', '눈물이 나네 기뻐서',
       '이게 바로 복리다', '나만 부자 되나', '적금 해지하길 잘했다'],
  down: ['물렸다', '물타기 각', '손절 못 해', '내 계좌 어디감', '아 눈물이',
         '반등 온다니까', '이번엔 다르다더니', '존버는 승리한다...', '성벽 버텨라',
         '청군 너무 세다', '남은 건 희망뿐', '적금이나 들걸', '이게 나라냐',
         '떨어질 때만 빠르네', '커피값 날아갔다', '엄마 미안', '내일은 오르겠지',
         '누가 좀 사줘', '계좌 안 볼래', '나만 물렸나', '이거 실화냐 진짜',
         '어제의 나를 때리고 싶다', '청군 물러가라', '한 번만 살려줘',
         '아직 안 팔았으면 손해 아님', '눈 감고 존버', '이 정도면 기부지',
         '라면만 먹는다', '홍군 정신 차려', '기관은 또 팔았네', '왜 나만 이래',
         '차트가 절벽이다', '떨어지는 칼날 잡았다', '내 노후는 어디로'],
  flat: ['언제 움직이냐', '지루하다', '횡보 지옥', '차라리 예금을', '라면 먹고 올게',
         '누가 좀 사줘라', '심심하다', '장 열린 거 맞나', '둘 다 안 싸우네',
         '집에 가고 싶다', '오늘도 평화롭다', '거래량 어디 갔어', '졸리다',
         '이럴 거면 왜 봤지', '숨 고르는 중', '조용하네 오늘', '움직여라 좀',
         '기다림의 미학', '차트가 자고 있다', '커피나 한 잔', '평화가 제일이지'],
  limitUp: ['상한가다!', '청군 성 무너진다', '역사적인 날', '못 산 사람 어떡해',
            '이런 날도 있구나', '전설이 된다', '내일도 가자', '만세!'],
  limitDown: ['하한가...', '홍군 성이 무너졌다', '오늘은 그만 보자', '다 잃었다',
              '이런 날이 오다니', '내일은 다르겠지', '아무 말도 안 나온다'],
  sidecar: ['사이드카 떴다', '다들 물러난다', '잠깐 쉬어가자', '이게 무슨 일이야',
            '숨 좀 돌리자', '무서워서 못 보겠다'],
};

// 병사는 자기 병종 말투로 말한다. 개인·연기금·외국인·기관을 사람으로 세운 것이라
// 그 주체의 성격이 드러나야 한다.
const UNIT_LINES = {
  infantry: ['돌격!', '내 돈 돌려줘', '한 주라도 더', '개미는 죽지 않는다',
             '뭉치면 산다', '여기서 물러설 순 없다', '나 하나쯤이야', '또 샀다',
             '월급 들어왔다', '이번엔 진짜 간다', '앞으로!', '버틴다 버텨',
             '누가 나 좀 말려줘', '적금 깼다', '다 걸었다', '내 평생 모은 돈이다',
             '숫자는 우리가 많다', '뒤로 못 간다'],
  archer: ['조준한다', '길게 본다', '느리지만 확실하게', '노후는 내가 지킨다',
           '멀리서 쏜다', '분산이 답이다', '천천히 모은다', '장기전이다',
           '흔들리지 않는다', '연금은 배신 안 해', '차분히 간다', '20년 뒤를 본다'],
  cavalry: ['측면을 돌파한다', '환율 좋다', '빠르게 들어간다', '치고 빠진다',
            '외국인은 기다리지 않는다', '기동한다', '지금이 기회다', '돌파!',
            '물량 넣는다', '한 방에 간다', '길게 안 끈다', '달러가 웃는다'],
  general: ['전열을 지켜라', '물량을 아껴라', '때를 기다린다', '기관이 움직인다',
            '전선을 유지하라', '보고는 나중에', '계획대로다', '흔들리지 마라',
            '내 명령을 따르라', '판을 읽어라', '개미는 모르는 게 있다'],
};

const pickLine = pool => pool[Math.floor(Math.random() * pool.length)];
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

// 말이 떠 있는 시간. 고르게 뽑으면 다 같은 박자로 사라져 기계처럼 보인다.
// 제곱을 씌워 짧은 말이 흔하고 긴 말이 드물게 나오도록 치우친다. 아주 가끔
// 한참 붙어 있는 것도 섞는다 — 혼자 오래 떠드는 사람이 꼭 있다.
const talkMs = (min, span) =>
  Math.random() < 0.08 ? min + span * (1.4 + Math.random() * 0.8)
                       : min + Math.pow(Math.random(), 2.2) * span;

// 전황에 맞는 풀. 다만 늘 여기서만 꺼내면 같은 소리만 도니 가끔은 엉뚱한 데서
// 꺼내 온다 — 사람 많은 곳의 소음은 원래 한 방향이 아니다.
function moodPool(battle) {
  const hit = battle.limit && battle.limit.hit;
  return battle.sidecar.active ? CROWD_LINES.sidecar
       : hit === 'upper' ? CROWD_LINES.limitUp
       : hit === 'lower' ? CROWD_LINES.limitDown
       : battle.front > 0.04 ? CROWD_LINES.up
       : battle.front < -0.04 ? CROWD_LINES.down
       : CROWD_LINES.flat;
}

const OFF_POOLS = [CROWD_LINES.up, CROWD_LINES.down, CROWD_LINES.flat];

// 전황을 보고 알아서 떠든다. 프레임마다 검사하므로 폴링 주기와 무관하게 흐른다 —
// apply() 안에서만 부르던 때는 10초에 한 번밖에 못 뱉었다.
let nextChatter = 0;
function crowdChatter(battle, now) {
  if (!battle || now < nextChatter) return;
  nextChatter = now + 420 + Math.random() * 1500;
  const mood = moodPool(battle);
  for (let i = 0, n = 2 + Math.floor(Math.random() * 4); i < n; i++) {
    const pool = Math.random() < 0.18 ? pickOne(OFF_POOLS) : mood;   // 가끔 엉뚱하게
    crowdSay(pickLine(pool), -1, talkMs(1500, 5200));
  }
  for (let i = 0, n = Math.random() < 0.85 ? 1 + Math.floor(Math.random() * 2) : 0;
       i < n; i++) {
    const kind = pickOne(KINDS);
    const side = Math.random() < 0.7 ? (battle.front >= 0 ? 'red' : 'blue')
                                     : (Math.random() < 0.5 ? 'red' : 'blue');
    unitSay(pickLine(UNIT_LINES[kind]), side, kind, -1, talkMs(1300, 4400));
  }
}


// 뒤쪽에만 침엽수를 남긴다
{
  const geo = merge([
    new THREE.CylinderGeometry(0.3, 0.44, 2.2, 5).translate(0, 1.1, 0),
    new THREE.ConeGeometry(1.8, 3.6, 6).translate(0, 3.5, 0),
    new THREE.ConeGeometry(1.3, 2.7, 6).translate(0, 5.3, 0),
  ]);
  const N = 46;
  const trees = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({
    color: PAL.pine, flatShading: true }), N);
  const d = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    const x = (hash01(i * 1.3) * 2 - 1) * (CASTLE_X + 60);
    const z = -(HALF_Z + 28 + hash01(i * 2.7) * 120);
    d.position.set(x, groundY(x, z) - 0.3, z);
    d.rotation.y = hash01(i * 3.1) * 6.283;
    d.scale.setScalar(0.8 + hash01(i * 4.9) * 0.8);
    d.updateMatrix();
    trees.setMatrixAt(i, d.matrix);
  }
  scene.add(trees);
}

// --- 본성과 후방 막사 ---------------------------------------------------------
function makeCastle(color, dir) {
  const grp = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: PAL.stone, flatShading: true });
  const dark = new THREE.MeshLambertMaterial({ color: 0x4c4642, flatShading: true });
  const trim = new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide });
  const gold = new THREE.MeshLambertMaterial({ color: PAL.gold, flatShading: true });
  const add = (geo, x, y, z, m) => {
    const o = new THREE.Mesh(geo, m || stone);
    o.position.set(x, y, z);
    grp.add(o);
    return o;
  };

  add(new THREE.BoxGeometry(30, 4, 46), 0, 2, 0);            // 기단
  add(new THREE.BoxGeometry(26, 7, 42), 0, 7.5, 0);          // 성벽
  // 성벽 위 총안. 하나씩 놓으면 인스턴스가 아까우니 한 메시로 묶는다.
  {
    const merlon = new THREE.BoxGeometry(2.6, 3, 2.6);
    const spots = [];
    for (let z = -19; z <= 19; z += 5.4) spots.push([13 * dir, z], [-13 * dir, z]);
    for (let x = -11; x <= 11; x += 5.5) spots.push([x, 20.5], [x, -20.5]);
    const m = new THREE.InstancedMesh(merlon, stone, spots.length);
    const d = new THREE.Object3D();
    spots.forEach(([x, z], i) => {
      d.position.set(x, 12.5, z);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
    });
    grp.add(m);
  }

  add(new THREE.BoxGeometry(19, 17, 30), 0, 15, 0);          // 본채
  add(new THREE.BoxGeometry(20.5, 1.6, 31.5), 0, 24, 0, dark);
  add(new THREE.ConeGeometry(13, 11, 6), 0, 29.5, 0, trim);  // 지붕
  add(new THREE.ConeGeometry(3, 3.4, 6), 0, 36, 0, gold);    // 지붕 마루

  // 성문 — 방향 쪽 벽에 아치와 문짝
  add(new THREE.BoxGeometry(2.5, 9, 11), 11.5 * dir, 6, 0, dark);
  add(new THREE.CylinderGeometry(5.5, 5.5, 2.6, 8, 1, false, 0, Math.PI)
        .rotateZ(Math.PI / 2).rotateY(Math.PI / 2), 11.5 * dir, 10.5, 0, dark);
  add(new THREE.BoxGeometry(1.2, 1.2, 12), 11.9 * dir, 8.5, 0, gold);

  for (const z of [-17, 17]) for (const x of [-10, 10]) {
    add(new THREE.CylinderGeometry(3, 3.8, 26, 6), x, 15, z);
    add(new THREE.CylinderGeometry(4.2, 4.2, 1.4, 6), x, 28.4, z, dark);
    add(new THREE.ConeGeometry(4.4, 7.5, 6), x, 32.5, z, trim);
    add(new THREE.BoxGeometry(1.1, 2.6, 1.1), x, 20, z + (z > 0 ? 3.6 : -3.6), dark);  // 창
  }

  add(new THREE.CylinderGeometry(0.22, 0.22, 16, 4), 0, 44, 0);
  add(new THREE.PlaneGeometry(9, 5.6), 4.6, 49, 0, trim);    // 성기
  add(new THREE.ConeGeometry(0.5, 1.4, 4), 0, 52.5, 0, gold);

  grp.scale.setScalar(1.56);
  grp.position.x = dir * CASTLE_X;
  grp.userData = { trim, base: new THREE.Color(color), dir };
  scene.add(grp);
  return grp;
}

// 후방 막사 — 천막과 모닥불, 보급 상자. 본성 뒤 살림이 도는 진지로 읽히게 한다.
function makeCamp(color, x) {
  const grp = new THREE.Group();
  const canvasMat = new THREE.MeshLambertMaterial({ color: 0x8a7a63, flatShading: true });
  const wood = new THREE.MeshLambertMaterial({ color: PAL.wood, flatShading: true });
  const ember = new THREE.MeshLambertMaterial({ color: 0xd4703a, flatShading: true });
  const trim = new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide });
  const put = (geo, m, px, py, pz, ry) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(px, py, pz);
    if (ry) o.rotation.y = ry;
    grp.add(o);
  };

  for (let i = 0; i < 9; i++) {
    const tz = (hash01(i * 3.9 + x) * 2 - 1) * 26;
    const tx = (hash01(i * 5.7 + x) * 2 - 1) * 5;
    const sc = 0.8 + hash01(i * 2.1 + x) * 0.5;
    // 천막은 원뿔 하나로 통일한다. 박공 천막을 섞었더니 각진 덩어리가 어둡게
    // 얹혀 상자처럼 보였다. 모양은 크기와 각도로만 흔든다.
    put(new THREE.ConeGeometry(3.2 * sc, 4.2 * sc, 4), canvasMat,
        tx, 2.1 * sc, tz, Math.PI / 4 + (hash01(i * 7.3) - 0.5) * 0.5);
    put(new THREE.ConeGeometry(0.5, 1.1, 4), wood, tx, 4.4 * sc, tz);
    if (i % 4 === 0) {                       // 깃대
      put(new THREE.CylinderGeometry(0.12, 0.12, 8, 4), wood, tx + 3.4, 4, tz);
      put(new THREE.PlaneGeometry(3, 1.9), trim, tx + 5, 7, tz);
    }
  }

  // 모닥불과 그 둘레의 통나무
  put(new THREE.ConeGeometry(1.5, 1.9, 5), ember, 0, 0.9, 0);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.4;
    put(new THREE.CylinderGeometry(0.42, 0.42, 3.4, 5).rotateZ(Math.PI / 2),
        wood, Math.cos(a) * 3.4, 0.42, Math.sin(a) * 3.4, a);
  }
  // 보급 상자
  for (let i = 0; i < 5; i++) {
    const bz = (hash01(i * 8.1 + x) * 2 - 1) * 18;
    put(new THREE.BoxGeometry(1.9, 1.5, 1.9), wood,
        -6 + hash01(i * 4.4 + x) * 3, 0.75, bz, hash01(i * 6.2) * 1.2);
  }

  grp.scale.setScalar(2.8);
  grp.position.x = x;
  scene.add(grp);
  return grp;
}

const castles = { red: makeCastle(PAL.red, -1), blue: makeCastle(PAL.blue, 1) };
for (const cx of CAMP_X) { makeCamp(PAL.red, -cx); makeCamp(PAL.blue, cx); }

// 바닥의 등락률 눈금. 기준가(0%)에서 좌우로 1% 마다 옅은 선, 10% 마다 진한 선을
// 긋고 ±30% 에서 성에 닿는다. 흙에 낸 자국처럼 보이도록 지형색보다 살짝 밝은
// 톤만 쓴다 — 여기가 튀면 전장이 아니라 그래프가 된다.
{
  const geo = new THREE.PlaneGeometry(1, HALF_Z * 2).rotateX(-Math.PI / 2);
  const mk = (n, w, opacity) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({
      color: 0x8d8168, transparent: true, opacity, depthWrite: false }), n);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const minor = mk(2 * LIMIT_PCT, 1, 0.10);              // 1% 마다
  const major = mk(2 * (LIMIT_PCT / 10), 1, 0.30);       // 10% 마다
  const d = new THREE.Object3D();
  let mi = 0, ma = 0;
  for (let p = -LIMIT_PCT; p <= LIMIT_PCT; p++) {
    if (p === 0) continue;                               // 0% 는 아래 중앙선이 맡는다
    const tenth = p % 10 === 0;
    d.position.set(p * PCT_X, 0.9, 0);
    d.scale.set(tenth ? 4 : 1.4, 1, 1);
    d.updateMatrix();
    if (tenth) major.setMatrixAt(ma++, d.matrix);
    else minor.setMatrixAt(mi++, d.matrix);
  }
  minor.count = mi;
  major.count = ma;
}

// 중앙선 = 기준가(0%). 전장에 못박혀 움직이지 않는다. 움직이는 금빛 현재가 선과
// 헷갈리지 않도록 흰색으로 두고, 전선이 여기서 얼마나 밀렸는지를 눈으로 잰다.
{
  const white = new THREE.MeshBasicMaterial({
    color: PAL.line, transparent: true, opacity: 0.8, depthWrite: false });
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(3, HALF_Z * 2 + 24).rotateX(-Math.PI / 2), white);
  line.position.set(0, 1.1, 0);
  scene.add(line);
}

// 전장 양옆을 성벽으로 막는다. 싸움터의 경계가 생겨 시선이 배경 산으로 새지 않는다.
{
  const stone = new THREE.MeshLambertMaterial({ color: PAL.stone, flatShading: true });
  const len = (CASTLE_X + 24) * 2;
  for (const sz of [-1, 1]) {
    const wall = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, 16, 11), stone);
    body.position.y = 7;
    wall.add(body);
    // 총안(凸) — 밋밋한 벽보다 성벽으로 읽힌다
    const merlon = new THREE.BoxGeometry(9, 5, 13);
    const n = Math.floor(len / 26);
    const tops = new THREE.InstancedMesh(merlon, stone, n);
    const d = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      d.position.set(-len / 2 + 13 + i * 26, 17.5, 0);
      d.updateMatrix();
      tops.setMatrixAt(i, d.matrix);
    }
    wall.add(tops);
    wall.position.set(0, 0, sz * (HALF_Z + 6));
    scene.add(wall);
  }
}

// 개발자용 눈금. 본성·막사가 의도한 퍼센트 지점에 서 있는지 눈으로 검산한다.
const ruler = new THREE.Group();
ruler.visible = false;
{
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6effa8, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
  for (let p = 0; p <= 100; p += 10) for (const s of (p ? [-1, 1] : [1])) {
    const x = s * (p / 100) * MAP_HALF;
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, HALF_Z * 2 + 280).rotateX(-Math.PI / 2), mat);
    line.position.set(x, 1.6, 0);
    ruler.add(line);

    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 110;
    const g = cv.getContext('2d');
    g.fillStyle = '#6effa8';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 58px ui-monospace, monospace';
    g.fillText(p + '%', 128, 36);
    g.font = '500 34px ui-monospace, monospace';
    g.fillText('x ' + Math.round(x), 128, 84);
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(76, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, fog: false }));
    lab.position.set(x, 1.8, HALF_Z + 120);
    ruler.add(lab);
  }
  scene.add(ruler);
}

// --- 경계선 = 현재가 ---------------------------------------------------------
const frontLine = new THREE.Group();
const priceCv = document.createElement('canvas');
priceCv.width = 640; priceCv.height = 150;
const priceTex = new THREE.CanvasTexture(priceCv);
{
  const gold = new THREE.MeshBasicMaterial({ color: PAL.gold, transparent: true, opacity: 0.95 });
  const halo = new THREE.MeshBasicMaterial({ color: PAL.gold, transparent: true, opacity: 0.11, depthWrite: false });
  const span = HALF_Z * 2 + 32;
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(4.4, span).rotateX(-Math.PI / 2), gold);
  strip.position.y = 0.5;
  const wash = new THREE.Mesh(new THREE.PlaneGeometry(44, span).rotateX(-Math.PI / 2), halo);
  wash.position.y = 0.42;
  frontLine.add(strip, wash);

  // 경계 말뚝 — 선 하나보다 "경계"라는 게 훨씬 분명해진다
  const post = merge([
    new THREE.CylinderGeometry(0.22, 0.3, 3.4, 5).translate(0, 1.7, 0),
    new THREE.ConeGeometry(0.36, 0.7, 5).translate(0, 3.7, 0),
  ]);
  const posts = new THREE.InstancedMesh(post, new THREE.MeshLambertMaterial({
    color: PAL.gold, flatShading: true }), 9);
  const d = new THREE.Object3D();
  for (let i = 0; i < 9; i++) {
    d.position.set(0, 0, -HALF_Z - 8 + i * ((HALF_Z * 2 + 16) / 8));
    d.rotation.y = hash01(i) * 0.5;
    d.updateMatrix();
    posts.setMatrixAt(i, d.matrix);
  }
  frontLine.add(posts);

  // 현재가는 거래선 위에 직접 새긴다. 선과 나란히 눕혀야 어느 선이 지금 값인지
  // 헷갈리지 않는다. 앞뒤로 하나씩 둬 카메라를 돌려도 읽히게 한다.
  const labelMat = new THREE.MeshBasicMaterial({ map: priceTex, transparent: true, depthWrite: false });
  for (const [z, dir] of [[HALF_Z * 0.46, 1], [-HALF_Z * 0.46, -1]]) {
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(118, 27).rotateX(-Math.PI / 2), labelMat);
    label.position.set(0, 1.5, z);
    label.rotation.y = dir * Math.PI / 2;
    frontLine.add(label);
  }
  scene.add(frontLine);
}

function drawPriceLabel(price, pct) {
  const g = priceCv.getContext('2d');
  g.clearRect(0, 0, 640, 150);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 거래선 위에 얹히므로 판은 깔지 않는다. 선 자체가 배경이 된다.
  g.shadowColor = 'rgba(0,0,0,.85)';
  g.shadowBlur = 10;
  g.fillStyle = '#fff6e2';
  g.font = '700 88px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText(Math.round(price).toLocaleString('ko-KR'), 320, 62);
  g.shadowBlur = 12;
  g.fillStyle = pct > 0 ? '#ff8a7e' : pct < 0 ? '#8ab6ff' : '#c9bfa8';
  g.font = '500 38px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText((pct > 0 ? '+' : '') + pct.toFixed(2) + '%', 320, 122);
  priceTex.needsUpdate = true;
}
drawPriceLabel(0, 0);

// --- 유닛 --------------------------------------------------------------------
// 부위마다 제 색을 준다 — 얼굴은 살색, 투구는 쇠색, 옷은 진영색. 몸통 앞에는
// 세로 금장식을 한 줄 넣어 단조로운 통짜 실루엣을 끊는다.
function bodyGeo(kind, side) {
  const C = cloth(side);
  if (kind === 'infantry') return merge([
    [new THREE.CylinderGeometry(0.30, 0.44, 1.20, 6).translate(0, 0.72, 0), C.main],
    [new THREE.BoxGeometry(0.07, 0.86, 0.12).translate(0.33, 0.74, 0), PART.gold],   // 세로 금장식
    [new THREE.BoxGeometry(0.21, 0.58, 0.21).translate(0.02, 0.27, 0.17), C.dark],   // 다리
    [new THREE.BoxGeometry(0.21, 0.58, 0.21).translate(0.02, 0.27, -0.17), C.dark],
    [new THREE.BoxGeometry(0.30, 0.15, 0.26).translate(0.08, 0.05, 0.17), PART.boot],
    [new THREE.BoxGeometry(0.30, 0.15, 0.26).translate(0.08, 0.05, -0.17), PART.boot],
    [new THREE.CylinderGeometry(0.47, 0.47, 0.13, 6).translate(0, 0.92, 0), PART.leather],
    [new THREE.BoxGeometry(0.34, 0.17, 0.86).translate(0, 1.28, 0), PART.steel],     // 어깨 갑옷
    [new THREE.BoxGeometry(0.17, 0.52, 0.17).rotateX(0.2).translate(0.16, 1.02, 0.34), C.main],
    [new THREE.SphereGeometry(0.13, 5, 4).translate(...HAND.infantry), PART.skin],   // 손 — 무기 소켓 자리
    [new THREE.IcosahedronGeometry(0.30, 0).translate(0, 1.55, 0), PART.skin],       // 얼굴
    [new THREE.ConeGeometry(0.37, 0.42, 6).translate(0, 1.88, 0), PART.steel],       // 투구
    [new THREE.TorusGeometry(0.34, 0.05, 3, 8).rotateX(Math.PI / 2).translate(0, 1.70, 0), PART.gold],
    [new THREE.ConeGeometry(0.07, 0.44, 4).translate(0, 2.22, 0), C.light],          // 투구 깃
    [new THREE.BoxGeometry(0.11, 0.78, 0.62).translate(-0.31, 1.04, 0), C.dark],     // 방패
    [new THREE.BoxGeometry(0.07, 0.20, 0.20).translate(-0.38, 1.04, 0), PART.gold],
  ]);

  if (kind === 'archer') return merge([
    [new THREE.CylinderGeometry(0.28, 0.40, 1.16, 6).translate(0, 0.70, 0), C.main],
    [new THREE.BoxGeometry(0.06, 0.82, 0.11).translate(0.30, 0.72, 0), PART.gold],
    [new THREE.BoxGeometry(0.19, 0.54, 0.19).translate(0.02, 0.26, 0.15), C.dark],
    [new THREE.BoxGeometry(0.19, 0.54, 0.19).translate(0.02, 0.26, -0.15), C.dark],
    [new THREE.BoxGeometry(0.27, 0.13, 0.23).translate(0.07, 0.05, 0.15), PART.boot],
    [new THREE.BoxGeometry(0.27, 0.13, 0.23).translate(0.07, 0.05, -0.15), PART.boot],
    [new THREE.CylinderGeometry(0.42, 0.42, 0.11, 6).translate(0, 0.90, 0), PART.leather],
    [new THREE.BoxGeometry(0.16, 0.50, 0.16).rotateX(-0.5).translate(0.20, 1.06, 0.20), C.main],
    [new THREE.SphereGeometry(0.12, 5, 4).translate(...HAND.archer), PART.skin],
    [new THREE.IcosahedronGeometry(0.28, 0).translate(0, 1.48, 0), PART.skin],
    [new THREE.CylinderGeometry(0.33, 0.31, 0.22, 6).translate(0, 1.74, 0), C.light],  // 두건
    [new THREE.ConeGeometry(0.30, 0.26, 6).translate(0, 1.92, 0), C.light],
    [new THREE.TorusGeometry(0.31, 0.045, 3, 8).rotateX(Math.PI / 2).translate(0, 1.64, 0), PART.gold],
    [new THREE.CylinderGeometry(0.17, 0.17, 0.84, 6).rotateZ(0.4).translate(-0.32, 1.16, 0), PART.leather],
    [new THREE.ConeGeometry(0.05, 0.32, 3).rotateZ(0.4).translate(-0.44, 1.64, 0), PART.steel],
    [new THREE.ConeGeometry(0.05, 0.32, 3).rotateZ(0.4).translate(-0.31, 1.68, 0.10), PART.steel],
    [new THREE.ConeGeometry(0.05, 0.32, 3).rotateZ(0.4).translate(-0.37, 1.66, -0.09), PART.steel],
  ]);

  if (kind === 'cavalry') return merge([
    [new THREE.BoxGeometry(2.0, 0.88, 0.78).translate(0, 1.25, 0), PART.horse],
    [new THREE.BoxGeometry(0.9, 0.72, 0.70).translate(0.62, 1.32, 0), PART.horse],
    [new THREE.BoxGeometry(0.56, 0.98, 0.52).rotateZ(-0.5).translate(1.00, 1.75, 0), PART.horse],
    [new THREE.BoxGeometry(0.62, 0.36, 0.44).translate(1.38, 2.05, 0), PART.horse],
    [new THREE.BoxGeometry(0.42, 0.24, 0.34).translate(1.66, 1.94, 0), PART.horseDark],
    [new THREE.ConeGeometry(0.09, 0.26, 3).translate(1.28, 2.30, 0.14), PART.horseDark],
    [new THREE.ConeGeometry(0.09, 0.26, 3).translate(1.28, 2.30, -0.14), PART.horseDark],
    [new THREE.ConeGeometry(0.23, 1.05, 4).rotateZ(-1.9).translate(0.62, 2.02, 0), PART.horseDark],
    [new THREE.ConeGeometry(0.27, 1.00, 4).rotateZ(1.75).translate(-1.06, 1.42, 0), PART.horseDark],
    [new THREE.BoxGeometry(0.23, 1.08, 0.23).translate(0.70, 0.52, 0.29), PART.horse],
    [new THREE.BoxGeometry(0.23, 1.08, 0.23).translate(0.70, 0.52, -0.29), PART.horse],
    [new THREE.BoxGeometry(0.23, 1.08, 0.23).translate(-0.70, 0.52, 0.29), PART.horse],
    [new THREE.BoxGeometry(0.23, 1.08, 0.23).translate(-0.70, 0.52, -0.29), PART.horse],
    [new THREE.BoxGeometry(0.28, 0.18, 0.28).translate(0.70, 0.04, 0.29), PART.hoof],
    [new THREE.BoxGeometry(0.28, 0.18, 0.28).translate(0.70, 0.04, -0.29), PART.hoof],
    [new THREE.BoxGeometry(0.28, 0.18, 0.28).translate(-0.70, 0.04, 0.29), PART.hoof],
    [new THREE.BoxGeometry(0.28, 0.18, 0.28).translate(-0.70, 0.04, -0.29), PART.hoof],
    [new THREE.BoxGeometry(0.86, 0.10, 0.96).translate(0.10, 1.70, 0), C.dark],       // 마의
    [new THREE.BoxGeometry(0.72, 0.16, 0.92).translate(-0.20, 1.72, 0), PART.leather],
    [new THREE.CylinderGeometry(0.27, 0.37, 1.02, 6).translate(-0.20, 2.15, 0), C.main],
    [new THREE.BoxGeometry(0.06, 0.74, 0.10).translate(0.06, 2.15, 0), PART.gold],
    [new THREE.BoxGeometry(0.30, 0.15, 0.80).translate(-0.20, 2.52, 0), PART.steel],
    [new THREE.BoxGeometry(0.18, 0.46, 0.18).rotateZ(0.5).translate(-0.02, 1.92, 0.30), C.dark],
    [new THREE.BoxGeometry(0.18, 0.46, 0.18).rotateZ(0.5).translate(-0.02, 1.92, -0.30), C.dark],
    [new THREE.SphereGeometry(0.13, 5, 4).translate(...HAND.cavalry), PART.skin],
    [new THREE.IcosahedronGeometry(0.27, 0).translate(-0.20, 2.85, 0), PART.skin],
    [new THREE.ConeGeometry(0.31, 0.36, 6).translate(-0.20, 3.15, 0), PART.steel],
    [new THREE.TorusGeometry(0.29, 0.045, 3, 8).rotateX(Math.PI / 2).translate(-0.20, 3.00, 0), PART.gold],
  ]);

  return merge([                                    // general
    [new THREE.CylinderGeometry(0.50, 0.72, 1.90, 6).translate(0, 1.00, 0), C.main],
    [new THREE.BoxGeometry(0.10, 1.42, 0.16).translate(0.52, 1.02, 0), PART.gold],   // 세로 금장식
    [new THREE.BoxGeometry(0.30, 0.66, 0.30).translate(0.03, 0.33, 0.24), C.dark],
    [new THREE.BoxGeometry(0.30, 0.66, 0.30).translate(0.03, 0.33, -0.24), C.dark],
    [new THREE.CylinderGeometry(0.74, 0.74, 0.18, 6).translate(0, 1.16, 0), PART.leather],
    [new THREE.BoxGeometry(1.72, 0.30, 1.06).translate(0, 1.90, 0), PART.steel],
    [new THREE.ConeGeometry(0.34, 0.46, 5).rotateZ(-1.57).translate(0.80, 1.98, 0), PART.gold],
    [new THREE.ConeGeometry(0.34, 0.46, 5).rotateZ(1.57).translate(-0.80, 1.98, 0), PART.gold],
    [new THREE.BoxGeometry(0.24, 0.62, 0.24).rotateX(0.2).translate(0.26, 1.44, 0.44), C.main],
    [new THREE.SphereGeometry(0.17, 5, 4).translate(...HAND.general), PART.skin],
    [new THREE.PlaneGeometry(1.5, 2.1).rotateY(Math.PI / 2).translate(-0.46, 1.10, 0), C.dark],
    [new THREE.IcosahedronGeometry(0.42, 0).translate(0, 2.30, 0), PART.skin],
    [new THREE.ConeGeometry(0.57, 1.02, 6).translate(0, 2.84, 0), PART.steel],
    [new THREE.TorusGeometry(0.50, 0.07, 3, 8).rotateX(Math.PI / 2).translate(0, 2.44, 0), PART.gold],
    [new THREE.ConeGeometry(0.10, 0.88, 4).rotateZ(-0.6).translate(0.30, 3.34, 0), PART.gold],
    [new THREE.ConeGeometry(0.10, 0.88, 4).rotateZ(0.6).translate(-0.30, 3.34, 0), PART.gold],
    [new THREE.ConeGeometry(0.09, 0.60, 4).translate(0, 3.62, 0), C.light],
    [new THREE.CylinderGeometry(0.07, 0.07, 5.0, 4).translate(-0.66, 2.60, 0), PART.wood],
    [new THREE.ConeGeometry(0.11, 0.34, 4).translate(-0.66, 5.22, 0), PART.steel],
  ]);
}

// 부위 색을 바깥에서 바꿀 수 있게 열어 둔다. PART 를 고치고 이걸 부르면 그 자리에서
// 다시 만들어진다 — 커스텀 유닛을 붙일 때 지오메트리 코드를 건드릴 필요가 없다.
function recolorUnits(overrides) {
  Object.assign(PART, overrides || {});
  for (const key in armies) {
    const a = armies[key];
    a.mesh.geometry.dispose();
    a.mesh.geometry = bodyGeo(a.kind, a.side);
    a.weapon.geometry.dispose();
    a.weapon.geometry = weaponGeo(a.kind);
  }
}

function weaponGeo(kind) {
  if (kind === 'infantry') return merge([
    [new THREE.BoxGeometry(0.09, 1.15, 0.035).translate(0, 0.72, 0), PART.steel],
    [new THREE.BoxGeometry(0.30, 0.07, 0.07).translate(0, 0.13, 0), PART.gold],
    [new THREE.CylinderGeometry(0.05, 0.05, 0.26, 4), PART.leather],
  ]);
  if (kind === 'archer') return merge([
    [new THREE.TorusGeometry(0.62, 0.05, 3, 7, Math.PI * 1.15).rotateZ(Math.PI * 0.42), PART.wood],
    [new THREE.BoxGeometry(0.03, 1.16, 0.03).translate(0.30, 0, 0), 0xe6dcc4],
  ]);
  if (kind === 'cavalry') return merge([
    [new THREE.CylinderGeometry(0.05, 0.07, 3.1, 4).translate(0, 1.35, 0), PART.wood],
    [new THREE.ConeGeometry(0.13, 0.5, 4).translate(0, 3.05, 0), PART.steel],
  ]);
  return merge([                                    // general
    [new THREE.BoxGeometry(0.12, 1.45, 0.045).translate(0, 0.9, 0), PART.steel],
    [new THREE.BoxGeometry(0.40, 0.09, 0.09).translate(0, 0.16, 0), PART.gold],
    [new THREE.CylinderGeometry(0.06, 0.06, 0.32, 4), PART.leather],
  ]);
}

// 같은 진영 안에서는 명도로, 진영 사이에서는 색상으로 갈린다


// 군기에 새길 글씨. 폴리곤 비율(1.8 x 1.2)에 맞춰 캔버스를 잡고, 두 글자를
// 가로로 나란히 눕혀 깃발을 꽉 채운다. 작게 렌더되므로 획이 가늘면 뭉개진다.
function bannerTexture(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 300;
  cv.height = 200;
  const g = cv.getContext('2d');
  g.fillStyle = '#1a1620';
  g.fillRect(0, 0, 300, 200);
  g.strokeStyle = color;
  g.lineWidth = 12;
  g.strokeRect(6, 6, 288, 188);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 108px "Gowun Batang", serif';
  const gap = 78;
  [...text].forEach((ch, i) => g.fillText(ch, 150 + (i - (text.length - 1) / 2) * gap, 104));
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

function bannerGeo(mirror) {
  const g = new THREE.PlaneGeometry(1.8, 1.2);
  if (mirror) g.scale(-1, 1, 1);     // 뒷면으로 보이는 진영은 글씨가 뒤집힌다
  return g.translate(-1.56, 4.34, 0);   // 깃대 뒤로 늘어뜨린다
}

// 기병 투구에 꽂는 깃털. 진영색에 곱해지는 정점색으로는 노랑이 안 나오므로
// 진영과 무관한 금빛 메시로 따로 세운다. 밑동을 원점에 두고 뒤로 젖힌 뒤 투구
// 꼭대기로 옮긴다 — 각도만 바꾸면 여러 가닥을 부챗살처럼 펼 수 있다.
const feather = (r, len, sweep, dz) =>
  new THREE.ConeGeometry(r, len, 4).translate(0, len / 2, 0)
    .rotateZ(sweep).translate(-0.24, 3.28, dz);

const PLUME_GEO = merge([
  feather(0.085, 1.20, 0.82, 0),
  feather(0.062, 0.95, 1.06, 0.11),
  feather(0.062, 0.88, 0.66, -0.11),
  feather(0.048, 0.62, 1.28, 0.02),
]);

const armies = {};
for (const side of ['red', 'blue']) for (const kind of KINDS) {
  const mk = geo => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({
      flatShading: true, side: THREE.DoubleSide, vertexColors: true }), CAP[kind]);
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const a = {
    side, kind, units: [],
    mesh: mk(bodyGeo(kind, side)),
    weapon: mk(weaponGeo(kind)),
  };
  // 진영색을 안 쓰는 장식은 본체에서 떼어 따로 세운다.
  // 장군은 소속을 새긴 군기, 기병은 금빛 깃털.
  const deco = kind === 'general'
    ? [bannerGeo(side === 'blue'), new THREE.MeshBasicMaterial({
        map: bannerTexture('기관', side === 'red' ? '#ff6b5e' : '#8fb6ff'),
        side: THREE.DoubleSide, transparent: true })]
    : kind === 'cavalry'
    ? [PLUME_GEO, new THREE.MeshLambertMaterial({ color: PAL.gold, flatShading: true })]
    : null;
  if (deco) {
    a.deco = new THREE.InstancedMesh(deco[0], deco[1], CAP[kind]);
    a.deco.count = 0;
    a.deco.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    a.deco.frustumCulled = false;
    scene.add(a.deco);
  }
  armies[side + ':' + kind] = a;
}

// --- 파티클 ------------------------------------------------------------------
function makeParticles(n, color, size, opacity) {
  const pos = new Float32Array(n * 3).fill(-9999);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color, size, sizeAttenuation: true, transparent: true, opacity, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  return { pos, geo, n, cur: 0, vel: new Float32Array(n * 3), life: new Float32Array(n) };
}

function emit(P, x, y, z, vx, vy, vz, ttl) {
  const i = P.cur = (P.cur + 1) % P.n, o = i * 3;
  P.pos[o] = x; P.pos[o + 1] = y; P.pos[o + 2] = z;
  P.vel[o] = vx; P.vel[o + 1] = vy; P.vel[o + 2] = vz;
  P.life[i] = ttl;
}

function stepParticles(P, dt, gravity) {
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) continue;
    const o = i * 3;
    P.life[i] -= dt;
    P.vel[o + 1] -= gravity * dt;
    P.pos[o] += P.vel[o] * dt;
    P.pos[o + 1] += P.vel[o + 1] * dt;
    P.pos[o + 2] += P.vel[o + 2] * dt;
    if (P.life[i] <= 0 || P.pos[o + 1] < 0) { P.life[i] = 0; P.pos[o + 1] = -9999; }
  }
  P.geo.attributes.position.needsUpdate = true;
}

const sparks = makeParticles(900, 0xffc47a, 0.95, 0.95);
const arrows = makeParticles(320, 0xd8cbb0, 0.55, 0.9);
const dust = makeParticles(420, 0x6b5847, 1.9, 0.16);
for (let i = 0; i < dust.n; i++)
  emit(dust, rnd() * 520, 1 + Math.random() * 88, rnd() * 280, rnd() * 1.4, 0.15, rnd() * 1.4, 6 + Math.random() * 10);

// 뉴스가 뜨면 해당 진영 본성에서 봉화가 오른다
function beacon(tone) {
  const x = tone === '호재' ? -CASTLE_X : CASTLE_X;
  for (let i = 0; i < 110; i++)
    emit(sparks, x + rnd() * 28, 3 + Math.random() * 12, rnd() * 48,
         rnd() * 7, 24 + Math.random() * 26, rnd() * 7, 1.7 + Math.random() * 1.4);
}

// --- 무기 스윙 ----------------------------------------------------------------
function swordSwing(p) {
  if (p < 0.24) return 0.35 + 0.90 * (p / 0.24);            // 치켜듦
  if (p < 0.34) return 1.25 - 2.15 * ((p - 0.24) / 0.10);   // 내려침
  return -0.90 + 1.25 * Math.min(1, (p - 0.34) / 0.52);     // 복귀
}
function lanceThrust(p) {
  const k = p < 0.16 ? p / 0.16 : Math.max(0, 1 - (p - 0.16) / 0.5);
  return -1.20 - 0.30 * k;
}
const bowDraw = p => 0.07 * Math.sin(p * Math.PI * 2);
const SWING = { infantry: swordSwing, general: swordSwing, cavalry: lanceThrust, archer: bowDraw };

// --- 상태 --------------------------------------------------------------------
let frontX = 0, frontTarget = 0, tempo = 0.15, tempoTarget = 0.15;
let redPower = 0.5, bluePower = 0.5, redTarget = 0.5, blueTarget = 0.5;
let sidecarUntil = 0, halt = false, switching = false;
let lastNewsId = -1;      // -1 = 첫 폴링 전. 이미 쌓여 있던 뉴스는 띄우지 않는다
let dragging = false;     // 개발자 슬라이더를 잡고 있는 동안엔 서버 값으로 덮지 않는다
const fall = { red: 0, blue: 0 }, fallTarget = { red: 0, blue: 0 };

const DEATH_S = 1.7;          // 쓰러져 사라지기까지

function spawnUnit(a, u, i) {   // 성문 앞에 선다
  u.x = a.side === 'red' ? -CASTLE_X : CASTLE_X;
  u.z = (hash01(i * 3.7) * 2 - 1) * 40;
  u.dead = 0;
}

// 전선에 가장 가까운 병사부터 쓰러진다. 대형 인덱스가 곧 앞줄부터의 순서다.
function killFront(a, n) {
  let hit = 0;
  for (let i = 0; i < a.mesh.count && hit < n; i++) {
    const u = a.units[i];
    if (u.dead > 0) continue;
    u.dead = DEATH_S;
    hit++;
    for (let k = 0; k < 4; k++)
      emit(dust, u.x + rnd() * 3, 1 + Math.random() * 4, u.z + rnd() * 3,
           rnd() * 5, 3 + Math.random() * 4, rnd() * 5, 1.2 + Math.random());
  }
}

function setCount(a, n) {
  const want = Math.min(n, CAP[a.kind]);
  const spawn = (u, i) => spawnUnit(a, u, i);
  while (a.units.length < want) {
    const i = a.units.length;
    const u = {
      ox: 0, tz: 0, hx: (hash01(i * 6.1) * 2 - 1) * 28, hz: (hash01(i * 8.3) * 2 - 1) * 44,
      ph: hash01(i * 9.1), sp: 0.5 + hash01(i * 5.3) * 0.7,
    };
    spawn(u, i);
    a.units.push(u);
  }
  // 줄었다가 다시 투입되는 병력도 성에서 새로 나오게 한다. 그냥 count 만 늘리면
  // 아까 전선에 서 있던 자리에서 불쑥 나타난다.
  for (let i = a.mesh.count; i < want; i++) spawn(a.units[i], i);
  // 병력이 빠지면 소리 없이 사라지지 않게 그 자리에 먼지를 남긴다
  for (let i = want; i < a.mesh.count; i++) {
    const u = a.units[i];
    if (!u) continue;
    for (let k = 0; k < 3; k++)
      emit(dust, u.x + rnd() * 2, 1 + Math.random() * 3, u.z + rnd() * 2,
           rnd() * 3, 2 + Math.random() * 3, rnd() * 3, 1.6 + Math.random());
  }
  a.mesh.count = a.weapon.count = want;
  if (a.deco) a.deco.count = want;
}

// 대형을 유지한다. 열과 행을 격자로 잡고 아주 조금만 흐트러뜨린다.
function retarget() {
  for (const key in armies) {
    const a = armies[key];
    const dir = a.side === 'red' ? -1 : 1;
    const f = FORM[a.kind];
    a.units.forEach((u, i) => {
      let row, col, base;
      if (f.wing) {                        // 기병은 좌우 익으로 갈라선다
        const k = i >> 1, wing = i & 1 ? 1 : -1;
        row = (k / f.cols) | 0;
        col = k % f.cols;
        base = wing * (HALF_Z * 0.60 + (col - (f.cols - 1) / 2) * f.gz);
      } else {
        row = (i / f.cols) | 0;
        col = i % f.cols;
        base = (col - (f.cols - 1) / 2) * f.gz;
      }
      // 자로 잰 듯한 격자는 열병식이지 전쟁이 아니다. 간격에 비례해 흐트러뜨리고,
      // 가운데가 먼저 부딪혀 앞으로 튀어나온 활 모양으로 전선을 휜다.
      const c = f.chaos, wobble = hash01(i * 2.3);
      const bow = Math.cos(clamp(base / (HALF_Z * 1.05), -1, 1) * 1.5708);
      const depth = f.near + row * f.gx
                  - bow * f.gx * f.bow
                  + (hash01(i * 1.7) - 0.5) * f.gx * 1.05 * c
                  + (wobble < 0.12 ? f.gx * 1.5 * c : 0);   // 대열을 벗어나 뛰쳐나간 병사
      u.ox = dir * Math.max(f.near * 0.35, depth);
      u.tz = base + (hash01(i * 4.1) - 0.5) * f.gz * 0.85 * (0.4 + c);
    });
  }
}
retarget();

const dummy = new THREE.Object3D(), hand = new THREE.Object3D();
const wMat = new THREE.Matrix4();
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  halt = now < sidecarUntil || switching;   // 교체 중에도 성으로 물러난다

  frontX += (frontTarget - frontX) * Math.min(1, dt * 0.7);
  tempo += (tempoTarget - tempo) * Math.min(1, dt * 1.2);
  redPower += (redTarget - redPower) * Math.min(1, dt * 0.8);
  bluePower += (blueTarget - bluePower) * Math.min(1, dt * 0.8);

  kstHour = (kstHour + dt / 3600) % 24;      // 폴링 사이에도 시간이 흐른다
  updateSky(kstHour);
  paintGround(frontX, redPower, bluePower);
  frontLine.position.x = frontX;
  frontLine.visible = !halt;
  frontLine.children[1].material.opacity =
    0.07 + 0.07 * (0.55 + 0.45 * Math.sin(t * 2.2)) * tempo;

  // 성 함락 — 기울어 무너지며 땅으로 가라앉는다
  for (const side of ['red', 'blue']) {
    if (fall[side] === fallTarget[side]) continue;
    const before = fall[side];
    fall[side] = fallTarget[side] > fall[side]
      ? Math.min(fallTarget[side], fall[side] + dt * 0.28)
      : Math.max(fallTarget[side], fall[side] - dt * 0.9);
    const c = castles[side];
    c.rotation.z = fall[side] * 0.42 * c.userData.dir;
    c.position.y = -fall[side] * 14;
    if (before < 0.5 && fall[side] >= 0.5)      // 무너지는 순간 흙먼지
      for (let i = 0; i < 90; i++)
        emit(dust, c.position.x + rnd() * 32, 2 + Math.random() * 12, rnd() * 40,
             rnd() * 11, 4 + Math.random() * 6, rnd() * 11, 3 + Math.random() * 3);
  }

  for (const key in armies) {
    const a = armies[key], m = a.mesh, w = a.weapon;
    const facing = a.side === 'red' ? 0 : Math.PI;
    const home = a.side === 'red' ? -CASTLE_X : CASTLE_X;
    const [hjx, hjy, hjz] = HAND[a.kind];
    for (let i = 0; i < m.count; i++) {
      const u = a.units[i];

      if (u.dead > 0) {           // 쓰러지는 중 — 옆으로 넘어가며 땅에 잠긴다
        u.dead -= dt;
        const k = clamp(1 - u.dead / DEATH_S, 0, 1);
        dummy.position.set(u.x, groundY(u.x, u.z) - k * k * 2.2, u.z);
        dummy.rotation.set(0, facing, Math.min(1.5708, k * 3.4) * (a.side === 'red' ? 1 : -1));
        dummy.scale.setScalar(UNIT_SCALE);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        if (a.deco) a.deco.setMatrixAt(i, dummy.matrix);
        hand.position.set(hjx, hjy, hjz);
        hand.rotation.z = REST[a.kind];
        hand.updateMatrix();
        w.setMatrixAt(i, wMat.multiplyMatrices(dummy.matrix, hand.matrix));
        if (u.dead <= 0) spawnUnit(a, u, i);   // 성에서 새 병력이 나온다
        continue;
      }

      // 사이드카가 걸리면 전선을 버리고 자기 성 안으로 물러난다
      const tx = halt ? home + u.hx : clamp(frontX + u.ox, -CASTLE_X + 12, CASTLE_X - 12);
      const tz = halt ? u.hz : u.tz;
      const k = Math.min(1, dt * u.sp * (halt ? 1.6 : 0.5 + tempo));
      u.x += (tx - u.x) * k;
      u.z += (tz - u.z) * k;

      const reach = a.kind === 'archer' ? 168 : 60;
      const fighting = !halt && Math.abs(u.x - frontX) < reach;
      const swing = fighting ? SWING[a.kind]((t * 1.5 * u.sp + u.ph) % 1) : REST[a.kind];
      const sway = fighting ? tempo : 0.2;

      dummy.position.set(
        u.x + Math.sin(t * 5 * u.sp + u.ph * 6.283) * 0.55 * sway,
        groundY(u.x, u.z) + Math.abs(Math.sin(t * 4 * u.sp + u.ph * 6.283)) * 0.3 * (0.4 + sway),
        u.z + Math.cos(t * 3.4 * u.sp + u.ph * 6.283) * 0.4 * sway);
      dummy.rotation.y = facing + Math.sin(t * 6 * u.sp + u.ph * 6.283) * 0.3 * sway;
      dummy.scale.setScalar(UNIT_SCALE);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);

      if (a.deco) a.deco.setMatrixAt(i, dummy.matrix);

      hand.position.set(hjx, hjy, hjz);
      hand.rotation.z = swing;
      hand.updateMatrix();
      w.setMatrixAt(i, wMat.multiplyMatrices(dummy.matrix, hand.matrix));

      if (a.kind === 'archer' && fighting && Math.random() < dt * 2.6 * tempo) {
        const dir = a.side === 'red' ? 1 : -1;
        emit(arrows, u.x, 2.2, u.z, dir * (26 + Math.random() * 10),
             11 + Math.random() * 5, rnd() * 2.5, 2.6);
      }
    }
    m.instanceMatrix.needsUpdate = true;
    w.instanceMatrix.needsUpdate = true;
    if (a.deco) a.deco.instanceMatrix.needsUpdate = true;
  }

  crowdChatter(lastBattle, now);

  // 관중은 전투가 격할수록 크게 튄다
  for (let i = 0; i < CROWD_SEATS.length; i++) {
    const s = CROWD_SEATS[i];
    dummy.position.set(s.x, s.y + Math.abs(Math.sin(t * 3.4 + s.ph)) * (0.25 + tempo * 1.5), s.z);
    dummy.rotation.set(0, s.z > 0 ? Math.PI : 0, 0);
    dummy.scale.setScalar(s.sc);
    dummy.updateMatrix();
    CROWD_MESH.setMatrixAt(i, dummy.matrix);
  }
  dummy.scale.setScalar(1);
  CROWD_MESH.instanceMatrix.needsUpdate = true;

  // 말풍선은 주인 머리 위에 떠서 늘 카메라를 본다. 병사는 계속 움직이므로
  // 매 프레임 자리를 다시 읽는다.
  for (const b of bubblePool) {
    if (!b.mesh.visible) continue;
    if (now > b.until || !b.target) { b.mesh.visible = false; continue; }
    if (b.target.crowd !== undefined) {
      const st = CROWD_SEATS[b.target.crowd];
      b.mesh.position.set(st.x, st.y + st.sc * 2.2 + 9, st.z);
    } else {
      const a = armies[b.target.army];
      const u = a && a.units[b.target.index];
      if (!u || b.target.index >= a.mesh.count) { b.mesh.visible = false; continue; }
      b.mesh.position.set(u.x, groundY(u.x, u.z) + UNIT_SCALE * 2.8 + 3, u.z);
    }
    b.mesh.quaternion.copy(camera.quaternion);
  }

  // 고른 대상을 표시하는 고리
  if (selected) {
    const p = selectedPos();
    if (p) {
      ring.visible = true;
      ring.position.set(p.x, p.y + 0.6, p.z);
      ring.rotation.z = t * 1.4;
    } else {
      ring.visible = false;
    }
  }

  if (!halt)
    for (let i = 0; i < 3; i++)
      if (Math.random() < tempo * dt * 26)
        emit(sparks, frontX + rnd() * 36, 1 + Math.random() * 2, rnd() * HALF_Z * 0.95,
             rnd() * 9, 10 + Math.random() * 14, rnd() * 9, 0.5 + Math.random() * 0.7);
  if (Math.random() < dt * 5)
    emit(dust, rnd() * 520, 1 + Math.random() * 80, rnd() * 280,
         rnd() * 1.4, 0.2, rnd() * 1.4, 8 + Math.random() * 8);

  stepParticles(sparks, dt, 26);
  stepParticles(arrows, dt, 14);
  stepParticles(dust, dt, 0);

  if (halt) $('alertTime').textContent = Math.ceil((sidecarUntil - now) / 1000) + '초 후 재개';

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- 선택 -------------------------------------------------------------------
// 유닛은 전부 InstancedMesh 라 클릭한 "덩어리"가 아니라 그 안의 몇 번째인지를
// 알아내야 한다. Raycaster 가 instanceId 를 주므로 그걸로 역참조한다.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected = null;

const ring = new THREE.Mesh(
  new THREE.RingGeometry(3.4, 4.6, 20).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: PAL.gold, transparent: true, opacity: 0.75,
                                side: THREE.DoubleSide, depthWrite: false }));
ring.visible = false;
scene.add(ring);

function selectedPos() {
  if (!selected) return null;
  if (selected.crowd !== undefined) {
    const st = CROWD_SEATS[selected.crowd];
    return st && { x: st.x, y: st.y, z: st.z };
  }
  const a = armies[selected.army];
  const u = a && a.units[selected.index];
  if (!u || selected.index >= a.mesh.count) return null;
  return { x: u.x, y: groundY(u.x, u.z), z: u.z };
}

// 클릭 지점에서 유닛 하나를 집는다. 못 집으면 null.
function pickAt(clientX, clientY) {
  pointer.x = (clientX / innerWidth) * 2 - 1;
  pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = [CROWD_MESH];
  for (const key in armies) targets.push(armies[key].mesh);
  for (const hit of raycaster.intersectObjects(targets, false)) {
    if (hit.instanceId === undefined) continue;
    if (hit.object === CROWD_MESH) return { crowd: hit.instanceId };
    for (const key in armies) {
      const a = armies[key];
      if (a.mesh === hit.object && hit.instanceId < a.mesh.count)
        return { army: key, index: hit.instanceId, side: a.side, kind: a.kind };
    }
  }
  return null;
}

function describe(sel) {
  if (!sel) return '';
  if (sel.crowd !== undefined) return '관중 #' + sel.crowd;
  const 이름 = { infantry: '보병 개인', archer: '궁병 연기금',
                 cavalry: '기병 외국인', general: '장군 기관' }[sel.kind];
  return (sel.side === 'red' ? '홍군 ' : '청군 ') + 이름 + ' #' + sel.index;
}

function select(sel) {
  selected = sel;
  ring.visible = !!sel;
  $('selInfo').textContent = sel ? describe(sel) : '';
  $('selBox').classList.toggle('on', !!sel);
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  canvas._downAt = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', e => {
  const d = canvas._downAt;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;  // 드래그는 회전
  select(pickAt(e.clientX, e.clientY));
});

// 고른 대상 얼굴 앞으로 카메라를 옮긴다. 방향은 그 유닛이 보는 쪽이다.
function viewSelected() {
  const p = selectedPos();
  if (!p) return;
  const facing = selected.crowd !== undefined
    ? (CROWD_SEATS[selected.crowd].z > 0 ? -1 : 1)      // 관중은 전장을 본다
    : (selected.side === 'red' ? 1 : -1);
  const eye = selected.crowd !== undefined ? p.y + 7 : p.y + UNIT_SCALE * 2.4;
  camera.position.set(p.x - facing * 11, eye + 3.5, p.z + 4);
  controls.target.set(p.x + facing * 40, eye, p.z);
  controls.update();
  userMoved = true;                 // 창 크기가 바뀌어도 이 시점을 덮지 않는다
}

// --- HUD / 폴링 ---------------------------------------------------------------
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const compact = n => n >= 1e8 ? (n / 1e8).toFixed(2) + '억' : n >= 1e4 ? fmt(n / 1e4) + '만' : fmt(n);

// 병종 구성을 도넛으로. 숫자만으로는 어느 주체가 판을 쥐고 있는지 안 보인다.
const PIE_COLORS = { infantry: '#e0574c', archer: '#f0a65e', cavalry: '#8f6bd0', general: '#e8c26a' };
const PIE_NAME = { infantry: '개인', archer: '연기금', cavalry: '외국인', general: '기관' };

function drawPie(cv, counts) {
  const g = cv.getContext('2d');
  const C = cv.width / 2, R = C * 0.56, r = C * 0.33;   // 라벨 자리를 바깥에 남긴다
  g.clearRect(0, 0, cv.width, cv.height);
  const total = KINDS.reduce((s, k) => s + counts[k], 0);
  if (!total) return;

  let a = -Math.PI / 2;
  const labels = [];
  for (const k of KINDS) {
    if (!counts[k]) continue;
    const step = counts[k] / total * Math.PI * 2;
    g.beginPath();
    g.moveTo(C, C);
    g.arc(C, C, R, a, a + step);
    g.closePath();
    g.fillStyle = PIE_COLORS[k];
    g.fill();
    labels.push([k, a + step / 2, counts[k] / total]);
    a += step;
  }
  g.globalCompositeOperation = 'destination-out';   // 가운데를 뚫어 도넛으로
  g.beginPath();
  g.arc(C, C, r, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'source-over';

  // 조각 바깥에 주체 이름과 비중. 너무 얇은 조각은 글자가 겹치므로 건너뛴다.
  g.textBaseline = 'middle';
  g.font = '600 23px "Gowun Dodum", system-ui, sans-serif';
  for (const [k, mid, share] of labels) {
    if (share < 0.06) continue;
    const lx = C + Math.cos(mid) * (R + 22), ly = C + Math.sin(mid) * (R + 16);
    g.textAlign = Math.cos(mid) < -0.15 ? 'right' : Math.cos(mid) > 0.15 ? 'left' : 'center';
    g.fillStyle = PIE_COLORS[k];
    g.fillText(PIE_NAME[k], lx, ly - 12);
    g.fillStyle = 'rgba(201,191,168,.85)';
    g.font = '500 21px "IBM Plex Mono", ui-monospace, monospace';
    g.fillText(Math.round(share * 100) + '%', lx, ly + 11);
    g.font = '600 23px "Gowun Dodum", system-ui, sans-serif';
  }

  g.textAlign = 'center';
  g.fillStyle = '#e9e2d6';
  g.font = '600 30px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText(String(total), C, C - 6);
  g.fillStyle = '#a89e8e';
  g.font = '400 18px "Gowun Dodum", system-ui, sans-serif';
  g.fillText('명', C, C + 20);
}

// --- 종목 선택 ---------------------------------------------------------------
const picker = $('picker'), ticker = $('ticker');
let pickerLoaded = false;

async function loadSymbols() {
  const d = await (await fetch('/api/symbols', { cache: 'no-store' })).json();
  picker.textContent = '';
  for (const it of d.items) {
    const li = document.createElement('li');
    li.setAttribute('aria-current', String(it.symbol === d.current));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;
    const cd = document.createElement('span');
    cd.className = 'cd';
    cd.textContent = it.symbol;
    li.append(nm, cd);
    li.addEventListener('click', e => {
      e.stopPropagation();
      pickSymbol(it.symbol);
    });
    picker.appendChild(li);
  }
  pickerLoaded = true;
}

// 종목 교체. 곧바로 갈아끼우면 남의 종목 병력이 그 자리에서 숫자만 바뀐다.
// 물러나고 → 지우고 → 성에서 새로 나오는 순서를 눈에 보이게 밟는다.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 교체 직후 잠금. 갱신 주기가 10초라 연달아 바꾸면 상류 호출이 겹쳐 밀린다.
const SWITCH_LOCK_MS = 10000;
const BR = String.fromCharCode(10);
let switchLockUntil = 0;

function notice(msg, ms = 2400) {
  const n = $('pickNote');
  n.textContent = msg;
  n.classList.add('on');
  clearTimeout(notice.t);
  notice.t = setTimeout(() => n.classList.remove('on'), ms);
}

function lockLeft() {
  return Math.ceil((switchLockUntil - performance.now()) / 1000);
}

async function pickSymbol(code) {
  if (switching) return;
  if (lockLeft() > 0) {
    picker.classList.remove('on');
    notice('갱신 주기가 지나야 바꿀 수 있습니다.' + BR + lockLeft() + '초 후 다시 시도해 주세요');
    return;
  }
  picker.classList.remove('on');
  switching = true;               // frame() 이 병사들을 성 안으로 물린다
  $('loading').classList.add('on');
  try {
    clearTimeout(pollTimer);      // 교체가 끝날 때까지 기존 폴링은 멈춘다
    stateGen++;                   // 날아가 있는 옛 응답을 무효로 만든다
    const picked = await fetch('/api/symbols?pick=' + encodeURIComponent(code),
                               { cache: 'no-store' });
    if (!picked.ok) throw new Error('종목 전환 거부 · HTTP ' + picked.status);

    // 새 시세를 먼저 손에 쥔다. 병력부터 지우고 요청이 실패하면 빈 전장에서 멎는다.
    // 교체 직후 첫 조회는 상류 캐시가 비어 있어 느리고 호출 제한에 걸리기도 한다.
    let fresh = null;
    for (let i = 0; i < 5 && !fresh; i++) {
      if (i) await sleep(2500);    // 서버도 안에서 재시도하므로 넉넉히 벌린다
      try { fresh = await fetchState(); } catch (e) { console.warn('교체 재시도', i + 1, e); }
    }
    await sleep(400);             // 물러나는 걸 마저 보여준다
    if (!fresh) {
      notice('시세를 받지 못했습니다.' + BR + '잠시 후 다시 시도해 주세요', 3200);
      return;                     // 기존 병력을 그대로 둔다
    }

    for (const key in armies) {   // 여기서부터 이전 종목 병력을 지운다
      setCount(armies[key], 0);   // 먼저 물려야 한다 — 배열을 비우고 부르면 터진다
      armies[key].units.length = 0;
    }
    lastNewsId = -1;
    lastFront = null;
    paintedAt = null;
    pickerLoaded = false;
    switching = false;            // 성문에서 다시 걸어 나오게 한다
    render(fresh);
  } finally {
    switching = false;
    switchLockUntil = performance.now() + SWITCH_LOCK_MS;
    $('loading').classList.remove('on');
    // 어느 경로로 빠져나가든 폴링은 반드시 되살린다. 실패 경로에서 그냥 return 하면
    // 위에서 clearTimeout 한 루프가 영영 안 돌아와 화면이 통째로 멎는다.
    pollTimer = setTimeout(poll, 1200);
  }
}

ticker.addEventListener('click', async () => {
  if (lockLeft() > 0) {
    notice('갱신 주기가 지나야 바꿀 수 있습니다.' + BR + lockLeft() + '초 후 다시 시도해 주세요');
    return;
  }
  const on = !picker.classList.contains('on');
  picker.classList.toggle('on', on);
  if (on && !pickerLoaded) await loadSymbols().catch(() => { pickerLoaded = false; });
});
addEventListener('click', e => {
  if (!ticker.contains(e.target)) picker.classList.remove('on');
});

function showNews(items) {
  if (lastNewsId < 0) {   // 접속 순간 지난 뉴스가 한꺼번에 쏟아지지 않게
    lastNewsId = items.length ? items[items.length - 1].id : 0;
    return;
  }
  const box = $('news');
  for (const n of items) {
    if (n.id <= lastNewsId) continue;
    lastNewsId = n.id;
    const el = document.createElement('div');
    el.className = 'newsItem ' + (n.tone === '호재' ? 'good' : 'bad');
    el.innerHTML = '<b></b><span></span><em></em>';
    el.querySelector('b').textContent = n.tone;
    el.querySelector('span').textContent = n.title;
    el.querySelector('em').textContent = n.source;
    box.appendChild(el);
    beacon(n.tone);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 700); }, 8000);
    while (box.children.length > 4) box.firstChild.remove();
  }
}

function setAlert(big, sub, showTime) {
  $('alertBig').textContent = big;
  $('alertSub').textContent = sub;
  $('alertTime').style.display = showTime ? '' : 'none';
  $('alert').classList.add('on');
}

let lastFront = null;
let lastBattle = null;

// 전선이 밀린 쪽이 그만큼 죽는다. 등락률이 움직인 만큼 앞줄이 갈려 나가고,
// 체결이 활발하면(tempo) 밀리지 않아도 소모가 있다.
function applyCasualties(battle) {
  const move = lastFront === null ? 0 : battle.front - lastFront;
  lastFront = battle.front;
  if (battle.sidecar.active) return;      // 매매가 멈추면 전투도 멈춘다

  // 전선이 그대로면 진 쪽이 없다. 부호로 나누면 move === 0 이 늘 청군 패배로
  // 분류돼 시세가 멈춘 동안 청군만 갈려 나간다.
  const pushed = Math.abs(move) * LIMIT_PCT;            // 몇 %p 밀렸나
  const loser = move < 0 ? 'red' : 'blue';
  const winner = loser === 'red' ? 'blue' : 'red';
  const toll = move === 0 ? [['red', 0.7], ['blue', 0.7]]   // 소모전
                          : [[loser, 1], [winner, 0.45]];
  for (const kind of ['infantry', 'cavalry']) {
    const share = kind === 'infantry' ? 1 : 0.4;
    for (const [side, weight] of toll) {
      const a = armies[side + ':' + kind];
      if (!a.mesh.count) continue;
      // 한 번에 전열이 통째로 지워지면 안 된다. 늘 병력의 일부만 갈리고, 쓰러진
      // 자리는 성에서 나온 병력이 메운다 — 죽고 사는 게 계속 돌아야 전투로 보인다.
      const want = Math.round((pushed * 8 + battle.tempo * 3) * share * weight);
      const n = Math.min(want, Math.ceil(a.mesh.count * 0.16));   // 전열이 통째로 지워지지 않게
      if (n > 0) killFront(a, n);
    }
  }
}

function apply(s) {
  const { raw, battle } = s;
  frontTarget = battle.front * FRONT_MAX;
  tempoTarget = Math.max(0.08, battle.tempo);
  // 압력이 한쪽으로 쏠려도 반대편 진영 빛이 사라지면 안 된다. 바닥을 깔고
  // 그 위에서 우열을 표현한다.
  redTarget = 0.34 + (0.5 + battle.pressure * 0.5) * 0.66;
  blueTarget = 0.34 + (0.5 - battle.pressure * 0.5) * 0.66;

  // 사이드카 중에는 증원이 끊긴다. 물러나는 병력만 있고 새로 나오지 않는다.
  if (!battle.sidecar.active)
    for (const side of ['red', 'blue']) for (const kind of KINDS)
      setCount(armies[side + ':' + kind], battle[side][kind]);
  retarget();

  for (const side of ['red', 'blue']) {
    const hp = battle.castle[side], p = side[0];
    // 완전히 잿빛까지 가면 성이 배경에 묻혀 어디 있는지도 안 보인다
    castles[side].userData.trim.color.copy(castles[side].userData.base)
      .lerp(new THREE.Color(PAL.ruin), (1 - hp) * 0.7);
    for (const kind of KINDS) $(p + '-' + kind).textContent = fmt(battle[side][kind]);
    drawPie($(p + '-pie'), battle[side]);
  }

  const cls = raw.change > 0 ? 'up' : raw.change < 0 ? 'down' : 'flat';
  const sign = raw.change > 0 ? '▲' : raw.change < 0 ? '▼' : '—';
  $('name').textContent = s.name + ' ' + s.symbol;
  $('price').textContent = fmt(raw.price);
  $('price').className = cls;
  $('chg').className = cls;
  $('chg').textContent = sign + ' ' + fmt(Math.abs(raw.change)) + '  ' + raw.changePct.toFixed(2) + '%';
  $('vol').textContent = compact(raw.volume) + '주';
  $('pres').textContent = (battle.pressure >= 0 ? '+' : '') + (battle.pressure * 100).toFixed(0) + '%';
  $('pres').className = battle.pressure > 0 ? 'up' : battle.pressure < 0 ? 'down' : 'flat';
  $('tempo').textContent = (battle.tempo * 100).toFixed(0) + '%';
  $('frontMark').style.left = (50 + battle.front * 50) + '%';
  drawPriceLabel(raw.price, raw.changePct);

  // 상한가면 청군 성이, 하한가면 홍군 성이 무너진다
  const hit = battle.limit.hit;
  fallTarget.blue = hit === 'upper' ? 1 : 0;
  fallTarget.red = hit === 'lower' ? 1 : 0;

  // 급등이면 매수 사이드카, 급락이면 매도 사이드카 — 정지되는 호가 방향이 반대다
  const sc = battle.sidecar;
  const up = sc.dir === '급등';
  if (sc.active) {
    sidecarUntil = performance.now() + sc.remainMs;
    setAlert(up ? '매수 사이드카' : '매도 사이드카',
             up ? '급 등 · 매 수 호 가 정 지' : '급 락 · 매 도 호 가 정 지', true);
  }
  else if (hit === 'upper') setAlert('상한가', '청 군 성 함 락', false);
  else if (hit === 'lower') setAlert('하한가', '홍 군 성 함 락', false);
  else $('alert').classList.remove('on');

  applyCasualties(battle);
  lastBattle = battle;          // 프레임 루프가 이걸 보고 떠든다
  showNews(s.news || []);
  $('devToggle').hidden = s.live;
  $('devPrice').textContent = fmt(raw.price);
  if (!dragging) $('devPctV').textContent = s.dev ? raw.changePct.toFixed(2) + '%' : '자동';
}

let pollTimer = null;
// 종목이 바뀌면 세대를 올린다. 교체 직전에 이미 날아간 요청이 뒤늦게 돌아와
// 옛 종목으로 화면을 덮어쓰는 걸 막는다 — 갱신 때마다 종목이 되돌아가던 원인이다.
let stateGen = 0;

async function fetchState() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function render(s) {
  apply(s);
  // 폴링한 시각이 아니라 시세 자체의 시각을 보여준다. 장이 닫혀 있으면
  // 시세는 멈춰 있는데 시계만 흐르는 게 더 헷갈린다.
  if (s.kst && s.kst.length === 4)          // 하늘은 한국 시각을 따른다
    kstHour = (+s.kst.slice(0, 2)) + (+s.kst.slice(2)) / 60;
  const q = (s.raw && s.raw.quoteTime || '').replace(/\D/g, '');
  $('upd').textContent = q.length >= 6
    ? q.slice(0, 2) + ':' + q.slice(2, 4) + ':' + q.slice(4, 6)
    : new Date(s.ts).toTimeString().slice(0, 8);
  const wait = s.pollMs || 5000;
  $('cyc').textContent = s.session === '장중' ? (wait / 1000).toFixed(0) + '초'
                                              : (s.session || '—');
  $('src').textContent = (s.live ? (s.provider || '').toUpperCase() + ' LIVE' : 'MOCK') +
                         (s.session ? ' · ' + s.session : '');
  $('src').className = s.session === '장중' && !s.stale ? 'open' : '';
  if (s.stale) $('src').textContent += ' · 지연';
  return wait;
}

async function poll() {
  clearTimeout(pollTimer);        // 중복 루프 방지 — 밖에서 불러도 하나만 돈다
  const gen = stateGen;
  let wait = 5000;
  try {
    const s = await fetchState();
    if (gen !== stateGen) return;      // 그 사이 종목이 바뀌었다. 이 응답은 버린다
    wait = render(s);
  } catch (e) {
    if (gen !== stateGen) return;
    // 조용히 '연결 끊김'만 띄우면 서버가 죽은 건지 렌더가 터진 건지 알 수가 없다
    console.error('poll 실패', e);
    $('src').textContent = '연결 끊김 · ' + (e && e.message ? e.message : e);
  }
  pollTimer = setTimeout(poll, wait);
}
poll();

// --- 컨트롤 -------------------------------------------------------------------
const hud = $('hud'), toggle = $('toggle'), scale = $('scale');
scale.addEventListener('input', () =>
  document.documentElement.style.setProperty('--hud-scale', scale.value));

function setHud(on) {
  hud.hidden = !on;
  $('toggleLabel').textContent = on ? '숨기기' : '보기';
  toggle.setAttribute('aria-pressed', String(!on));
}
toggle.addEventListener('click', () => setHud(hud.hidden));
addEventListener('keydown', e => {
  if (e.key === 'h' || e.key === 'H') setHud(hud.hidden);
});

// 고른 대상에게 한마디 시키기. 채팅이 붙으면 서버에서 받은 문장을 그대로
// speak() 로 넘기면 되고, 여기 입력창은 그 경로를 미리 써 보는 자리다.
$('selSay').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.currentTarget.value.trim()) return;
  speak(e.currentTarget.value.trim(), selected || {});
  e.currentTarget.value = '';
});
$('selView').addEventListener('click', viewSelected);
$('selClose').addEventListener('click', () => select(null));
addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });

// --- 시점 프리셋 --------------------------------------------------------------
// 클릭하면 저장해 둔 시점으로, Shift+클릭이면 지금 화면을 그 칸에 덮어쓴다.
const viewKey = slot => 'stockwar.view.' + slot;

function markView(btn) {
  btn.classList.toggle('set', !!localStorage.getItem(viewKey(btn.dataset.slot)));
}

for (const btn of document.querySelectorAll('.view')) {
  markView(btn);
  btn.addEventListener('click', e => {
    const key = viewKey(btn.dataset.slot);
    const saved = localStorage.getItem(key);
    if (e.shiftKey || !saved) {          // 빈 칸을 그냥 누르면 바로 저장한다
      const c = camera.position, t = controls.target;
      localStorage.setItem(key, JSON.stringify([c.x, c.y, c.z, t.x, t.y, t.z]));
      markView(btn);
      return;
    }
    const [x, y, z, tx, ty, tz] = JSON.parse(saved);
    camera.position.set(x, y, z);
    controls.target.set(tx, ty, tz);
    controls.update();
    userMoved = true;                    // 창 크기가 바뀌어도 이 시점을 덮지 않는다
  });
}

// --- 소리 ---------------------------------------------------------------------
// 파일 없이 WebAudio 로 만든다. 자동재생 정책 때문에 사용자가 켜야 소리가 난다.
const sfx = { ctx: null, master: null, on: false, last: {} };

function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  sfx.ctx = new AC();
  sfx.master = sfx.ctx.createGain();
  sfx.master.gain.value = 0.22;          // 전체를 낮게 깔아둔다
  sfx.master.connect(sfx.ctx.destination);

  // 전장 웅성거림: 노이즈를 저역 필터에 통과시킨 앰비언스
  const len = sfx.ctx.sampleRate * 2;
  const buf = sfx.ctx.createBuffer(1, len, sfx.ctx.sampleRate);
  const d = buf.getChannelData(0);
  let v = 0;
  for (let i = 0; i < len; i++) {        // 브라운 노이즈가 백색보다 덜 거슬린다
    v = (v + (Math.random() * 2 - 1) * 0.04) * 0.985;
    d[i] = v;
  }
  const src = sfx.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = sfx.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;
  sfx.amb = sfx.ctx.createGain();
  sfx.amb.gain.value = 0;
  src.connect(lp).connect(sfx.amb).connect(sfx.master);
  src.start();
  return true;
}

// 같은 소리가 겹쳐 쌓이면 지저분해진다. 종류별 최소 간격을 둔다.
function canPlay(kind, gapMs) {
  const now = performance.now();
  if (now - (sfx.last[kind] || 0) < gapMs) return false;
  sfx.last[kind] = now;
  return true;
}

function blip(kind, { freq, type = 'triangle', dur = 0.12, vol = 0.5, sweep = 0, gap = 90 }) {
  if (!sfx.on || !sfx.ctx || !canPlay(kind, gap)) return;
  const t = sfx.ctx.currentTime;
  const osc = sfx.ctx.createOscillator();
  const g = sfx.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(sfx.master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const sndClash = () => blip('clash', { freq: 2200, type: 'square', dur: 0.07, vol: 0.16, sweep: -1400, gap: 110 });
const sndArrow = () => blip('arrow', { freq: 900, type: 'sawtooth', dur: 0.13, vol: 0.07, sweep: -600, gap: 240 });
const sndNews = tone => blip('news', { freq: tone === '호재' ? 660 : 350, dur: 0.5, vol: 0.3, sweep: tone === '호재' ? 260 : -130, gap: 700 });
const sndAlarm = () => blip('alarm', { freq: 520, type: 'sine', dur: 1.1, vol: 0.42, sweep: -240, gap: 3000 });
const sndFall = () => blip('fall', { freq: 150, type: 'sine', dur: 1.6, vol: 0.5, sweep: -110, gap: 3000 });

const soundBtn = $('sound');
soundBtn.addEventListener('click', () => {
  if (!sfx.ctx && !initAudio()) { soundBtn.disabled = true; soundBtn.textContent = '♪✕'; return; }
  sfx.on = !sfx.on;
  sfx.ctx.resume();
  soundBtn.setAttribute('aria-pressed', String(sfx.on));
  soundBtn.textContent = sfx.on ? '♪' : '♪✕';
  if (sfx.amb) sfx.amb.gain.setTargetAtTime(sfx.on ? 0.5 : 0, sfx.ctx.currentTime, 0.3);
});

// --- 개발자 툴 ----------------------------------------------------------------
let devSent = 0;
const devPanel = $('dev'), devToggle = $('devToggle'), devPct = $('devPct');

const dev = q => fetch('/api/dev?' + q).catch(() => {});

devToggle.addEventListener('click', () => {
  const on = !devPanel.classList.contains('on');
  devPanel.classList.toggle('on', on);
  devToggle.setAttribute('aria-pressed', String(on));
});

devPct.addEventListener('input', () => {
  dragging = true;
  $('devPctV').textContent = (+devPct.value).toFixed(2) + '%';
  const now = performance.now();
  if (now - devSent < 70) return;      // 드래그 중 요청이 쏟아지지 않게
  devSent = now;
  dev('pct=' + devPct.value);
});
devPct.addEventListener('change', () => { dragging = false; dev('pct=' + devPct.value); });

const setPct = v => { devPct.value = v; dragging = false; dev('pct=' + v); };
$('devUp').addEventListener('click', () => setPct(30));
$('devDown').addEventListener('click', () => setPct(-30));
$('devAuto').addEventListener('click', () => { dragging = false; dev('auto=1'); });
$('devReset').addEventListener('click', () => {
  fallTarget.red = fallTarget.blue = 0;
  sidecarUntil = 0;
  dev('reset=1');
});
$('devGood').addEventListener('click', () => dev('news=호재'));
$('devBad').addEventListener('click', () => dev('news=악재'));
$('devRuler').addEventListener('click', e => {
  ruler.visible = !ruler.visible;
  e.currentTarget.setAttribute('aria-pressed', String(ruler.visible));
});

// 창이 아직 안 보이면 innerWidth 가 0 이다. 그대로 쓰면 aspect 가 NaN 이 되고
// 카메라 좌표까지 NaN 으로 굳어, 나중에 창이 열려도 영영 아무것도 안 보인다.
let userMoved = false;
controls.addEventListener('start', () => { userMoved = true; });

function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // 사용자가 아직 카메라를 안 건드렸으면 창 비율이 바뀔 때마다 다시 맞춘다.
  // 한 번만 맞추면 처음 비율로 계산된 거리가 그대로 굳어 전장이 화면 밖으로 나간다.
  if (!userMoved) fitCamera();
}

// 세로로 긴 창에서는 가로 시야가 좁아 전장이 화면 밖으로 나간다. 막사까지 담기는
// 거리로 물러선다. 그 뒤로는 OrbitControls 로 사용자가 잡는다.
function fitCamera() {
  if (innerWidth < 2) return;
  const halfTan = Math.tan(camera.fov * Math.PI / 360) * camera.aspect;
  const dist = clamp((CASTLE_X + 96) / halfTan, 440, 1840);
  camera.position.set(0, dist * 0.40, dist * 0.90);
  controls.target.set(0, 4, 0);
  controls.update();
}

// 개발자 툴이 씬을 수치로 검산할 수 있게 열어둔다 (목업 전용 도구와 같은 성격)
window.__war = { scene, camera, controls, castles, ruler, groundGeo, baseCols,
                 MAP_HALF, CASTLE_X, CAMP_X, FRONT_MAX, PCT_X, LIMIT_PCT, sfx,
                 // 대사 — speak() 하나로 채팅을 흘려 보낼 수 있다
                 speak, crowdSay, unitSay, crowdChatter, population,
                 CROWD_LINES, UNIT_LINES,
                 // 선택
                 select, pickAt, viewSelected, describe,
                 selected: () => selected,
                 // 커스텀
                 PART, recolorUnits, bodyGeo, cloth,
                 // 하늘
                 updateSky, skyAt, sun, hemi, moon, sunDisc, starMat,
                 CROWD_SEATS: () => CROWD_SEATS, armies, THREE, ring };

addEventListener('resize', resize);
resize();
