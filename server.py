#!/usr/bin/env python3
"""stock-war 데이터 서버.

KIS_APP_KEY / KIS_APP_SECRET 환경변수가 있으면 한국투자증권 OpenAPI 실데이터를,
없으면 목업 랜덤워크를 쓴다. 어느 쪽이든 /api/state 응답 스키마는 동일하므로
프론트엔드(war.js)는 데이터 출처를 몰라도 된다.

전투 수치는 전부 "비율"로 낸다. 거래량 절대값을 기준으로 삼으면 종목을 바꿀 때마다
상수를 다시 잡아야 하는데, 점유율과 상대 강도는 종목·가격대·시간대와 무관하다.

    python server.py     # http://localhost:8000
"""
import json
import math
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

def _load_env(path=".env"):
    """키를 셸마다 export 하지 않아도 되게 .env 를 읽는다.

    이미 설정된 환경변수는 덮어쓰지 않는다 — 셸에서 준 값이 파일보다 우선이다.
    """
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip("\"'"))
    except FileNotFoundError:
        pass


_load_env()

SYMBOL = os.environ.get("STOCK_WAR_SYMBOL", "005930")
NAME = os.environ.get("STOCK_WAR_NAME", "삼성전자")
def kiwoom_creds():
    """실전/모의 키를 따로 둔다.

    키움은 실전 키와 모의 키가 서로 호환되지 않아 두 쌍을 다 갖게 된다. 한 칸만
    두면 환경을 바꿀 때마다 키를 손으로 옮겨야 하고, 그러다 배포에 실전 키가
    섞인다. 환경만 바꾸면 알맞은 쌍이 선택되게 한다.
    """
    if os.environ.get("KIWOOM_ENV", "demo") == "real":
        return (os.environ.get("KIWOOM_APP_KEY", ""),
                os.environ.get("KIWOOM_SECRET_KEY", ""))
    # 모의 전용 칸이 비어 있으면 기본 칸을 쓴다 (모의 키만 가진 배포용)
    return (os.environ.get("KIWOOM_DEMO_APP_KEY") or os.environ.get("KIWOOM_APP_KEY", ""),
            os.environ.get("KIWOOM_DEMO_SECRET_KEY") or os.environ.get("KIWOOM_SECRET_KEY", ""))


# 증권사 두 곳을 지원한다. 어느 쪽을 쓰든 raw 스키마가 같아 프론트는 모른다.
_HAS_KIS = bool(os.environ.get("KIS_APP_KEY") and os.environ.get("KIS_APP_SECRET"))
_HAS_KIWOOM = all(kiwoom_creds())
PROVIDER = (os.environ.get("STOCK_WAR_PROVIDER", "").lower()
            or ("kiwoom" if _HAS_KIWOOM else "kis" if _HAS_KIS else ""))
LIVE = (PROVIDER == "kis" and _HAS_KIS) or (PROVIDER == "kiwoom" and _HAS_KIWOOM)

# 공개 배포 스위치. 켜면 실전 키로는 아예 뜨지 않는다 — 인터넷에 내놓는 화면이
# 실계좌 자격증명을 들고 있을 이유가 없다. 모의투자 키로만 굴린다.
PUBLIC = os.environ.get("STOCK_WAR_PUBLIC") == "1"
if PUBLIC:
    _real = [n for n, v in (("KIWOOM_ENV", "real"), ("KIS_ENV", "prod"))
             if os.environ.get(n) == v]
    if _real:
        raise SystemExit(
            "공개 배포(STOCK_WAR_PUBLIC=1)에서는 실전 키를 쓸 수 없습니다. "
            "%s 을(를) 모의투자 값으로 바꾸세요 (KIWOOM_ENV=demo / KIS_ENV=vts)."
            % ", ".join(_real))

KIS_HOST = ("https://openapi.koreainvestment.com:9443"
            if os.environ.get("KIS_ENV", "vts") == "prod"
            else "https://openapivts.koreainvestment.com:29443")
KIWOOM_HOST = ("https://api.kiwoom.com"
               if os.environ.get("KIWOOM_ENV", "demo") == "real"
               else "https://mockapi.kiwoom.com")

# --- 전투 밸런스 튜닝값 (게임 감각은 전부 여기서만 만진다) -------------------
# 전선 위치는 튜닝값이 없다. 상한가/하한가가 그대로 자다 — 성이 맵의 30% 지점에
# 있고 상하한가가 ±30% 이므로 둘이 맞물린다.

# 한 진영의 총 병력 규모. 여기에 각 투자 주체의 점유율을 곱해 병종별로 배분한다.
ARMY_SCALE = 230
# 유닛 1기가 대표하는 지분 가중치. 클수록 그 병종은 귀하게 나온다.
# 개인은 머릿수, 기관은 소수 정예라는 실제 수급 성격을 옮기되, 전형적인 구성
# (개인 55 / 외국인 22 / 기관 15 / 연기금 8%)에서 네 병종이 모두 화면에 보이도록
# 잡은 값이다. 실제 비중 그대로 두면 장군이 서너 기뿐이라 존재감이 사라진다.
UNIT_WEIGHT = {"infantry": 1.3, "archer": 0.8, "cavalry": 1.7, "general": 5.0}
CAPS = {"infantry": 160, "archer": 100, "cavalry": 75, "general": 20}   # 렌더 상한

# 병종 = 투자 주체. 연기금은 기관계에서 떼어내 후방 궁병으로 세운다.
KIND_OF = {"retail": "infantry", "pension": "archer",
           "foreign": "cavalry", "inst": "general"}

# 사이드카: 원래는 KOSPI200 선물이 ±5% 로 1분 지속될 때 프로그램매매를 5분 멈추는
# 지수 단위 장치다. 개별 종목에는 발동하지 않으므로, 여기서는 종목 자체의 급변동을
# 트리거로 삼아 이름만 빌려 쓴다.
SIDECAR_TRIGGER = 0.03      # 기준 시점 대비 ±3%
SIDECAR_WINDOW_S = 120      # 기준 시점 = 2분 전
SIDECAR_HOLD_S = 300 if LIVE else 25   # 실제 5분. 목업은 관찰용으로 짧게


KST = timezone(timedelta(hours=9))


def market_session(now=None):
    """KRX 장 상태. 실데이터를 장 밖에 붙이면 값이 안 움직이는데, 그게 고장이
    아니라는 걸 화면에서 바로 알 수 있어야 한다.

    공휴일 달력은 없으므로 주말만 구분한다 — 평일 휴장일은 '장전'으로 보인다.
    """
    t = (now or datetime.now(KST)).astimezone(KST)
    if t.weekday() >= 5:
        return "휴장"
    hm = t.hour * 60 + t.minute
    if hm < 9 * 60:
        return "장전"
    if hm < 15 * 60 + 30:
        return "장중"
    return "장마감"


def tick_size(price):
    """한국거래소 호가단위."""
    for limit, tick in ((2000, 1), (5000, 5), (20000, 10), (50000, 50),
                        (200000, 100), (500000, 500)):
        if price < limit:
            return tick
    return 1000


def snap(price):
    """체결가는 호가단위 위에만 존재한다."""
    t = tick_size(price)
    return round(price / t) * t


def price_limits(prev):
    """상한가 / 하한가. 기준가 ±30% 안쪽의 유효 호가까지만 간다."""
    up, dn = prev * 1.3, prev * 0.7
    return (math.floor(up / tick_size(up)) * tick_size(up),
            math.ceil(dn / tick_size(dn)) * tick_size(dn))


def troops(share, kind):
    """수급 점유율(0~1) -> 유닛 수.

    절대 거래량을 안 쓰기 때문에 삼성전자든 소형주든 상수를 다시 잡을 필요가 없다.
    """
    if share <= 0:
        return 0
    return int(min(CAPS[kind], round(share * ARMY_SCALE / UNIT_WEIGHT[kind])))


def shares(inv, key):
    """네 주체의 매수(또는 매도) 점유율. 합이 1이 되도록 정규화한다."""
    vals = {name: max(0.0, inv[name][key]) for name in KIND_OF}
    total = sum(vals.values())
    return {n: (v / total if total else 0.0) for n, v in vals.items()}


# 직전 폴링 체결량 이력. 절대량 대신 "최근 평균 대비 몇 배"로 전투 강도를 낸다.
_dv_hist = deque(maxlen=40)


def tempo_ratio(delta):
    """폴링당 체결량의 상대 강도(0~1). 평균의 2배면 최고조."""
    _dv_hist.append(max(0.0, delta))
    avg = sum(_dv_hist) / len(_dv_hist)
    return min(1.0, delta / (avg * 2)) if avg > 0 else 0.0


_price_hist = deque()          # (ts, price)
_sidecar = {"until": 0.0, "dir": ""}


def check_sidecar(price, now):
    """2분 전 대비 ±3% 급변동이면 발동. 발동 중에는 재판정하지 않는다."""
    _price_hist.append((now, price))
    while _price_hist and now - _price_hist[0][0] > SIDECAR_WINDOW_S:
        _price_hist.popleft()
    if now < _sidecar["until"] or not _price_hist:
        return
    ref = _price_hist[0][1]
    if ref and abs(price / ref - 1) >= SIDECAR_TRIGGER:
        _sidecar["until"] = now + SIDECAR_HOLD_S
        _sidecar["dir"] = "급등" if price > ref else "급락"
        _price_hist.clear()     # 해제 직후 같은 변동으로 다시 걸리지 않게


def to_battle(raw, now=None):
    """시세/수급 원본 -> 전장 상태. 모든 값이 비율이라 종목에 의존하지 않는다."""
    now = time.time() if now is None else now
    prev = raw["price"] - raw["change"] or raw["price"]

    def pct(p):
        return (p - prev) / prev * 100 if prev else 0.0

    check_sidecar(raw["price"], now)
    depth = raw["askTotal"] + raw["bidTotal"]
    buy, sell = shares(raw["investors"], "buy"), shares(raw["investors"], "sell")
    upper, lower = price_limits(prev)   # front_of 의 자가 된다

    def front_of(p):
        """가격 -> 전선 좌표(-1~1).

        자는 상한가/하한가다. 성이 맵의 30% 지점에 서 있고 상하한가가 ±30% 이므로,
        상한가에서 정확히 +1(청군 성)·하한가에서 -1(홍군 성)에 닿는다. tanh 로
        누르면 몇 % 만 움직여도 포화돼 성 앞까지 밀려버린다.
        """
        span = (upper - prev) if p >= prev else (prev - lower)
        if span <= 0:
            return 0.0
        return round(max(-1.0, min(1.0, (p - prev) / span)), 4)

    def army(sh):
        return {KIND_OF[name]: troops(sh[name], KIND_OF[name]) for name in KIND_OF}

    # 호가 잔량 불균형. 땅에 번지는 진영 빛의 세기이자 전선의 미세 압력이 된다
    pressure = (raw["bidTotal"] - raw["askTotal"]) / depth if depth else 0.0
    return {
        # 전선 위치. -1 = 빨강 성 코앞까지 밀림, +1 = 파랑 성 함락 직전
        "front": front_of(raw["price"]),
        "pressure": round(pressure, 4),
        "tempo": round(raw["tempo"], 4),
        "red": army(buy),
        "blue": army(sell),
        # 성벽 손상은 회복되지 않는다 -> 당일 저가/고가 기준
        "castle": {
            "red": round(1 + min(0.0, front_of(raw["low"])), 3),
            "blue": round(1 - max(0.0, front_of(raw["high"])), 3),
        },
        "sidecar": {
            "active": now < _sidecar["until"],
            "dir": _sidecar["dir"],
            "remainMs": max(0, int((_sidecar["until"] - now) * 1000)),
        },
        # 상한가면 청군 성이, 하한가면 홍군 성이 함락된다
        "limit": {
            "upper": upper, "lower": lower,
            "hit": "upper" if raw["price"] >= upper else
                   "lower" if raw["price"] <= lower else None,
        },
    }


# --- 종목 목록 ------------------------------------------------------------------
# 시가총액 상위를 바로 주는 API 가 없다. 대형주 후보를 ka10001 로 훑어 시총(mac)
# 으로 정렬한다. 후보를 늘리면 그만큼 호출이 늘어나므로 열 개로 묶어 뒀다.
CANDIDATES = [
    ("005930", "삼성전자"), ("000660", "SK하이닉스"), ("373220", "LG에너지솔루션"),
    ("207940", "삼성바이오로직스"), ("005380", "현대차"), ("000270", "기아"),
    ("068270", "셀트리온"), ("035420", "NAVER"), ("105560", "KB금융"),
    ("005490", "POSCO홀딩스"),
]
TOP_N = 5
_symbols = {"at": 0.0, "list": []}


PICK_FILE = ".picked.json"
SYMBOLS_FILE = ".symbols.json"


def _load_picked():
    """마지막으로 고른 종목. 서버를 재시작해도 보던 종목이 유지된다."""
    global SYMBOL, NAME
    try:
        with open(PICK_FILE, encoding="utf-8") as f:
            code = json.load(f).get("symbol")
    except (OSError, ValueError):
        return
    name = dict(CANDIDATES).get(code)
    if name:
        SYMBOL, NAME = code, name
SYMBOLS_TTL_S = 6 * 3600


def symbol_list():
    """시총 상위 종목. 시총은 하루 사이에 순위가 뒤집히지 않으므로 길게 캐시하고
    파일로도 남긴다 — 재시작마다 열 종목을 다시 때리면 호출 제한에 걸린다."""
    now = time.time()
    if _symbols["list"] and now - _symbols["at"] < SYMBOLS_TTL_S:
        return _symbols["list"]
    try:
        with open(SYMBOLS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("at", 0) + SYMBOLS_TTL_S > now and saved.get("list"):
            _symbols.update(at=saved["at"], list=saved["list"])
            return _symbols["list"]
    except (OSError, ValueError, KeyError):
        pass

    rows = []
    for i, (code, name) in enumerate(CANDIDATES):
        cap = 0.0
        if PROVIDER == "kiwoom" and LIVE:
            if i:
                time.sleep(0.25)     # 연속 조회는 호출 제한에 걸린다
            try:
                p = _kw_post("/api/dostk/stkinfo", "ka10001", {"stk_cd": code})
                cap = _kw_num(p.get("mac"))
                name = (str(p.get("stk_nm") or "").strip() or name)
            except Exception:
                pass          # 한 종목 실패가 목록 전체를 막을 이유는 없다
        rows.append({"symbol": code, "name": name, "cap": cap})
    rows.sort(key=lambda r: -r["cap"])       # cap 이 전부 0 이면 후보 순서가 남는다
    _symbols.update(at=now, list=rows[:TOP_N])
    try:
        with open(SYMBOLS_FILE, "w", encoding="utf-8") as f:
            json.dump({"at": now, "list": _symbols["list"]}, f, ensure_ascii=False)
    except OSError:
        pass
    return _symbols["list"]


def switch_symbol(code):
    """종목을 갈아끼운다. 이전 종목의 이력이 남으면 전투 수치가 오염된다."""
    global SYMBOL, NAME
    # 후보 목록에서 직접 찾는다. symbol_list() 를 부르면 캐시가 식었을 때
    # 열 종목을 조회하느라 전환이 통째로 멎는다.
    name = dict(CANDIDATES).get(code)
    if name is None:
        return False
    cached = next((r for r in _symbols["list"] if r["symbol"] == code), None)
    SYMBOL, NAME = code, (cached["name"] if cached else name)
    try:
        with open(PICK_FILE, "w", encoding="utf-8") as f:
            json.dump({"symbol": SYMBOL}, f)
    except OSError:
        pass
    _live.update(at=0.0, raw=None, stale=False)
    _last_vol["v"] = 0
    _dv_hist.clear()
    _price_hist.clear()
    _sidecar.update(until=0.0, dir="")
    _mock.update(t=0, high=0.0, low=0.0)
    _news["items"].clear()          # 남의 종목 뉴스가 남으면 안 된다
    _news["next"] = 0.0
    return True


# --- 키움 REST API -----------------------------------------------------------
_kw_token = {"value": None, "exp": 0.0}


def _kw_num(v):
    """키움 숫자 문자열. '+61300', '--28837'(음수), '', None 을 모두 받는다."""
    t = str(v or "").strip().replace("+", "")
    if t.startswith("--"):      # 부호가 두 번 붙어 오는 필드가 있다
        t = t[1:]
    try:
        return float(t)
    except ValueError:
        return 0.0


TOKEN_FILE = ".kiwoom_token.json"


def _kiwoom_token():
    """접근토큰. 하루 가까이 살아 있고 반복 발급은 거부당하므로 디스크에 남긴다.

    개발 중에는 서버를 자주 재시작하는데, 메모리에만 두면 그때마다 새로 발급받다가
    막힌다. 파일에 두면 재시작해도 살아 있는 토큰을 그대로 쓴다.
    """
    if _kw_token["value"] and time.time() < _kw_token["exp"]:
        return _kw_token["value"]
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("host") == KIWOOM_HOST and saved.get("exp", 0) > time.time():
            _kw_token.update(value=saved["value"], exp=saved["exp"])
            return _kw_token["value"]
    except (OSError, ValueError, KeyError):
        pass

    appkey, secretkey = kiwoom_creds()
    body = json.dumps({"grant_type": "client_credentials",
                       "appkey": appkey, "secretkey": secretkey}).encode()
    req = urllib.request.Request(KIWOOM_HOST + "/oauth2/token", body,
                                 {"Content-Type": "application/json;charset=UTF-8"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError("키움 토큰 발급 실패: HTTP %d %s (앱키 %d자 / 시크릿 %d자, %s)"
                           % (e.code, _kw_reason(e), len(appkey), len(secretkey),
                              KIWOOM_HOST.split("//")[-1]))
    if "token" not in d:
        # 응답 딕셔너리를 통째로 실으면 토큰이 오류 화면에 찍힐 수 있다
        raise RuntimeError("키움 토큰 발급 거부: %s"
                           % (d.get("return_msg") or "알 수 없는 응답"))
    _kw_token["value"] = d["token"]
    try:
        exp = datetime.strptime(d["expires_dt"], "%Y%m%d%H%M%S").replace(tzinfo=KST)
        _kw_token["exp"] = exp.timestamp() - 600
    except (KeyError, ValueError):
        _kw_token["exp"] = time.time() + 12 * 3600
    try:
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump({"host": KIWOOM_HOST, "value": _kw_token["value"],
                       "exp": _kw_token["exp"]}, f)
    except OSError:
        pass          # 못 남겨도 이번 프로세스는 굴러간다
    return _kw_token["value"]


def _kw_reason(e):
    """상류 오류 본문에서 사람이 읽을 이유만 뽑는다. 본문을 통째로 싣지 않는다."""
    try:
        d = json.loads(e.read().decode("utf-8", "replace"))
        return str(d.get("return_msg") or d.get("error") or "")[:140]
    except Exception:
        return ""


def _kw_post(path, api_id, body, retry=True):
    req = urllib.request.Request(
        KIWOOM_HOST + path, json.dumps(body).encode(),
        headers={"Content-Type": "application/json;charset=UTF-8",
                 "authorization": "Bearer " + _kiwoom_token(), "api-id": api_id})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # 종목을 바꾼 직후엔 네 번을 잇달아 부르느라 호가 제한에 걸리기 쉽다.
        # 한 번은 쉬었다 다시 친다.
        if e.code == 429 and retry:
            time.sleep(0.8)
            return _kw_post(path, api_id, body, retry=False)
        # 어느 API 가 왜 막혔는지 남긴다. 상류 메시지만 싣고 키는 싣지 않는다.
        raise RuntimeError("키움 %s 실패: HTTP %d %s"
                           % (api_id, e.code, _kw_reason(e)))


def _kw_investors(trde_tp, day):
    """종목별 투자자 매수(1) 또는 매도(2) 수량. 단주 기준."""
    rows = _kw_post("/api/dostk/stkinfo", "ka10059",
                    {"dt": day, "stk_cd": SYMBOL, "amt_qty_tp": "2",
                     "trde_tp": trde_tp, "unit_tp": "1"}).get("stk_invsr_orgn") or [{}]
    return rows[0]


def kiwoom_raw():
    p = _kw_post("/api/dostk/stkinfo", "ka10001", {"stk_cd": SYMBOL})
    a = _kw_post("/api/dostk/mrkcond", "ka10004", {"stk_cd": SYMBOL})
    day = datetime.now(KST).strftime("%Y%m%d")
    try:
        bq, sq = _kw_investors("1", day), _kw_investors("2", day)
    except (urllib.error.HTTPError, KeyError, IndexError):
        bq = sq = {}      # 장 시작 전에는 당일 수급이 없다

    price = abs(_kw_num(p.get("cur_prc")))
    change = _kw_num(p.get("pred_pre"))
    # flu_rt 는 소수점이 생략된 정수로 오는 필드라, 직접 계산하는 편이 안전하다
    prev = price - change
    vol = _kw_num(p.get("trde_qty"))
    delta, _last_vol["v"] = max(0.0, vol - _last_vol["v"]), vol

    def level(side, i):
        """1차선만 필드명이 다르다 (sel_fpr_* / buy_fpr_*)."""
        if i == 1:
            return abs(_kw_num(a.get(side + "_fpr_bid"))), _kw_num(a.get(side + "_fpr_req"))
        return (abs(_kw_num(a.get("%s_%dth_pre_bid" % (side, i)))),
                _kw_num(a.get("%s_%dth_pre_req" % (side, i))))

    def group(key):
        return {"buy": abs(_kw_num(bq.get(key))), "sell": abs(_kw_num(sq.get(key))),
                "net": _kw_num(bq.get(key)) - _kw_num(sq.get(key))}

    pension, orgn = group("penfnd_etc"), group("orgn")
    # 기관계에 연기금이 포함돼 있다. 궁병으로 따로 세우므로 장군에서 뺀다.
    inst = {k: max(0.0, orgn[k] - pension[k]) if k != "net" else orgn[k] - pension[k]
            for k in ("buy", "sell", "net")}

    return {
        "price": price, "change": change,
        "changePct": (change / prev * 100) if prev else 0.0,
        "open": abs(_kw_num(p.get("open_pric"))), "high": abs(_kw_num(p.get("high_pric"))),
        "low": abs(_kw_num(p.get("low_pric"))),
        "volume": vol, "amount": 0.0,   # ka10001 에 거래대금 필드가 없다
        "deltaVol": delta, "tempo": tempo_ratio(delta),
        "quoteTime": str(a.get("bid_req_base_tm") or "").strip(),
        "askTotal": _kw_num(a.get("tot_sel_req")), "bidTotal": _kw_num(a.get("tot_buy_req")),
        "asks": [list(level("sel", i)) for i in range(1, 11)],
        "bids": [list(level("buy", i)) for i in range(1, 11)],
        "investors": {"retail": group("ind_invsr"), "foreign": group("frgnr_invsr"),
                      "pension": pension, "inst": inst},
    }


# --- 목업 --------------------------------------------------------------------
_mock = {"prev": 78000.0, "price": 0.0, "open": 0.0, "high": 0.0, "low": 0.0,
         "vol": 9.0e6, "bias": 0.0, "t": 0}   # vol 0 에서 시작하면 전장이 텅 빈다

# 개발자 툴이 현재가를 붙잡고 있을 때의 값. None 이면 랜덤워크가 그대로 돈다.
_dev = {"price": None}

# 데모용 시황 문구다. 실제 기사가 아니므로 출처를 "샘플"로 고정한다 — 실존 언론사
# 이름을 붙이면 없는 기사를 지어내는 셈이 된다. 실연동 때는 연합뉴스·한국경제·
# 매일경제 화이트리스트로 거른 진짜 제목과 언론사명이 그대로 이 자리에 들어간다.
NEWS_POOL = {
    "호재": ["외국인 순매수 확대", "반도체 업황 개선 전망", "기관 대량 매수 유입",
             "실적 개선 기대감 확산", "목표주가 상향"],
    "악재": ["외국인 매도세 지속", "환율 급등 부담", "기관 차익 실현 매물",
             "업황 둔화 우려", "목표주가 하향"],
}
_news = {"items": [], "next": 0.0, "seq": 0}


def push_news(tone, now, title=None):
    _news["seq"] += 1
    _news["items"].append({"id": _news["seq"], "ts": int(now * 1000), "tone": tone,
                           "source": "샘플", "title": title or random.choice(NEWS_POOL[tone])})
    del _news["items"][:-6]


def tick_news(now, bias):
    """목업 뉴스 발생. 추세와 같은 방향의 기사가 더 자주 뜬다."""
    if now < _news["next"]:
        return
    _news["next"] = now + random.uniform(20, 50)
    push_news("호재" if random.random() < 0.5 + 0.35 * bias else "악재", now)


def mock_raw():
    m = _mock
    if m["t"] == 0:
        # 내부 가격은 연속값으로 둔다. 호가단위로 스냅해 버리면 랜덤워크 한 스텝이
        # 호가단위보다 작을 때 반올림에 먹혀 가격이 굳는다.
        m["price"] = m["prev"] * (1 + random.gauss(0, 0.004))
        m["open"] = m["high"] = m["low"] = snap(m["price"])
    m["t"] += 1
    # 세력 편향 자체를 랜덤워크시켜야 한 방향으로 몰아치는 구간이 생긴다.
    # 개발자 툴이 가격을 잡고 있어도 편향은 계속 굴려 호가와 수급은 살아 있게 둔다.
    m["bias"] = max(-1.0, min(1.0, m["bias"] * 0.95 + random.gauss(0, 0.25)))
    upper, lower = price_limits(m["prev"])
    if _dev["price"] is None:
        m["price"] += m["prev"] * (0.0016 * m["bias"] + random.gauss(0, 0.0018))
    else:
        m["price"] = _dev["price"]
    m["price"] = max(lower, min(upper, m["price"]))   # 가격은 상하한가를 못 넘는다
    tick_news(time.time(), m["bias"])
    delta = abs(random.gauss(0, 1)) * 9000 * (1 + abs(m["bias"]))
    m["vol"] += delta

    price = snap(m["price"])
    m["high"] = max(m["high"], price)
    m["low"] = min(m["low"], price)
    t = tick_size(price)

    def qty(skew):
        return int(abs(random.gauss(0, 1)) * 7000 * skew + 400)

    asks = [[price + t * (i + 1), qty(1 - 0.35 * m["bias"])] for i in range(10)]
    bids = [[price - t * (i + 1), qty(1 + 0.35 * m["bias"])] for i in range(10)]

    inv = {}
    for k, share in (("retail", 0.42), ("foreign", 0.30), ("inst", 0.20), ("pension", 0.08)):
        turn = m["vol"] * share
        # 개인은 역행(상승장에 순매도), 나머지는 추세 순행이 흔한 패턴
        tilt = 0.5 - 0.15 * m["bias"] if k == "retail" else 0.5 + 0.20 * m["bias"]
        buy, sell = turn * tilt, turn * (1 - tilt)
        inv[k] = {"buy": int(buy), "sell": int(sell), "net": int(buy - sell)}

    return {
        "price": price, "change": price - m["prev"],
        "changePct": (price - m["prev"]) / m["prev"] * 100,
        "open": m["open"], "high": m["high"], "low": m["low"],
        "volume": int(m["vol"]), "amount": int(m["vol"] * price),
        "deltaVol": int(delta), "tempo": tempo_ratio(delta),
        "quoteTime": datetime.now(KST).strftime("%H%M%S"),
        "askTotal": sum(a[1] for a in asks), "bidTotal": sum(b[1] for b in bids),
        "asks": asks, "bids": bids, "investors": inv,
    }


# --- 한국투자증권 OpenAPI ----------------------------------------------------
_token = {"value": None, "exp": 0.0}
_last_vol = {"v": 0}


def _kis_token():
    if _token["value"] and time.time() < _token["exp"]:
        return _token["value"]
    body = json.dumps({"grant_type": "client_credentials",
                       "appkey": os.environ["KIS_APP_KEY"],
                       "appsecret": os.environ["KIS_APP_SECRET"]}).encode()
    req = urllib.request.Request(KIS_HOST + "/oauth2/tokenP", body,
                                 {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.load(r)
    _token["value"] = d["access_token"]
    _token["exp"] = time.time() + int(d.get("expires_in", 86400)) - 600
    return _token["value"]


def _kis_get(path, tr_id, extra=None):
    params = {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": SYMBOL}
    params.update(extra or {})
    req = urllib.request.Request(
        KIS_HOST + path + "?" + urllib.parse.urlencode(params),
        headers={"authorization": "Bearer " + _kis_token(),
                 "appkey": os.environ["KIS_APP_KEY"],
                 "appsecret": os.environ["KIS_APP_SECRET"],
                 "tr_id": tr_id, "custtype": "P"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


def kis_raw():
    def f(d, k):
        return float(d.get(k) or 0)

    p = _kis_get("/uapi/domestic-stock/v1/quotations/inquire-price",
                 "FHKST01010100")["output"]
    a = _kis_get("/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
                 "FHKST01010200")["output1"]
    try:
        # 투자자별 수급은 장중 잠정치(09:30/11:30/13:20/14:30)에만 갱신된다
        v = _kis_get("/uapi/domestic-stock/v1/quotations/inquire-investor",
                     "FHKST01010900")["output"][0]
    except (KeyError, IndexError, urllib.error.HTTPError):
        v = {}

    vol = f(p, "acml_vol")
    delta, _last_vol["v"] = max(0.0, vol - _last_vol["v"]), vol

    def group(buy_key, sell_key, net_key):
        return {"buy": f(v, buy_key), "sell": f(v, sell_key), "net": f(v, net_key)}

    pension = group("pefn_shnu_qty", "pefn_seln_qty", "pefn_ntby_qty")
    orgn = group("orgn_shnu_qty", "orgn_seln_qty", "orgn_ntby_qty")
    # 기관계에는 연기금이 이미 포함돼 있다. 궁병으로 따로 세우므로 장군에서는 뺀다.
    inst = {k: max(0.0, orgn[k] - pension[k]) if k != "net" else orgn[k] - pension[k]
            for k in ("buy", "sell", "net")}

    return {
        "price": f(p, "stck_prpr"), "change": f(p, "prdy_vrss"),
        "changePct": f(p, "prdy_ctrt"),
        "open": f(p, "stck_oprc"), "high": f(p, "stck_hgpr"), "low": f(p, "stck_lwpr"),
        "volume": vol, "amount": f(p, "acml_tr_pbmn"),
        "deltaVol": delta, "tempo": tempo_ratio(delta),
        "quoteTime": str(a.get("aspr_acpt_hour") or "").strip(),
        "askTotal": f(a, "total_askp_rsqn"), "bidTotal": f(a, "total_bidp_rsqn"),
        "asks": [[f(a, "askp%d" % i), f(a, "askp_rsqn%d" % i)] for i in range(1, 11)],
        "bids": [[f(a, "bidp%d" % i), f(a, "bidp_rsqn%d" % i)] for i in range(1, 11)],
        "investors": {
            "retail": group("prsn_shnu_qty", "prsn_seln_qty", "prsn_ntby_qty"),
            "foreign": group("frgn_shnu_qty", "frgn_seln_qty", "frgn_ntby_qty"),
            "pension": pension,
            "inst": inst,
        },
    }


# /api/state 한 번에 KIS 를 세 번 부른다. 탭을 여러 개 열어도 상류 호출이
# 배로 늘지 않도록 폴링 간격보다 살짝 짧게 캐시한다.
LIVE_TTL_S = 8.0
_live = {"at": 0.0, "raw": None, "stale": False}


def live_raw():
    """상류 시세. 호출 제한(429)에 걸려도 화면이 통째로 죽으면 안 되므로,
    실패하면 마지막으로 받은 값을 그대로 내보내고 잠시 뒤 다시 시도한다."""
    now = time.time()
    if _live["raw"] is None or now - _live["at"] >= LIVE_TTL_S:
        fetch = kiwoom_raw if PROVIDER == "kiwoom" else kis_raw
        # 종목을 갓 바꿨을 때는 기댈 이전 값이 없다. 여기서 502 를 뱉으면 화면이
        # 빈 채로 멎으므로, 이 경우에만 물러서지 않고 몇 번 더 시도한다.
        # 재시도가 길면 배포 환경의 게이트웨이 제한(보통 100초 안팎)을 넘겨
        # 응답 자체가 끊긴다. 그러면 정작 원인 메시지를 못 본다.
        cold = _live["raw"] is None
        for attempt in range(2 if cold else 1):
            try:
                _live["raw"] = fetch()
                _live["at"] = time.time()
                _live["stale"] = False
                return _live["raw"]
            except Exception as e:
                err = e
                if cold and attempt < 1:
                    time.sleep(0.8)
        if cold:
            raise err
        # now 는 함수 진입 시각이라, 상류가 타임아웃까지 끌면 이미 지난 시각이 된다.
        # 지금 시각을 다시 읽어야 의도한 간격이 지켜진다.
        _live["at"] = time.time() - LIVE_TTL_S + 6      # 6초 뒤 재시도
        _live["stale"] = str(err)
    return _live["raw"]


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 내보낼 정적 파일은 이 둘뿐이다. 디렉토리를 통째로 서빙하면 같은 폴더의 .env 와
# 토큰 파일이 그대로 딸려 나간다 — 실제로 GET /.env 가 키를 200 으로 돌려줬다.
# 막을 것을 고르는 대신 내보낼 것만 고른다. 경로 장난에 뚫릴 여지가 없다.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/war.js": ("war.js", "text/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "stock-war"
    sys_version = ""

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass                      # 접근 로그로 콘솔을 채우지 않는다

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/dev":
            return self.do_dev()
        if path == "/api/symbols":
            return self.do_symbols()
        if path == "/api/state":
            return self.do_state()
        if path == "/api/health":
            return self.do_health()
        entry = STATIC.get(path)
        if entry is None:
            self.send_error(404, "not found")
            return
        try:
            with open(os.path.join(BASE_DIR, entry[0]), "rb") as f:
                self._send(f.read(), entry[1])
        except OSError:
            self.send_error(404, "not found")

    def do_health(self):
        """설정과 상류 접속을 한 번에 점검한다. 키 값은 어떤 경우에도 싣지 않는다."""
        appkey, secret = kiwoom_creds() if PROVIDER == "kiwoom" else ("", "")
        info = {
            "provider": PROVIDER or "mock", "live": LIVE, "public": PUBLIC,
            "kiwoomEnv": os.environ.get("KIWOOM_ENV", "(미설정)"),
            "host": KIWOOM_HOST if PROVIDER == "kiwoom" else KIS_HOST,
            "symbol": SYMBOL,
            "keyLen": len(appkey), "secretLen": len(secret),
            "hasDemoKeys": bool(os.environ.get("KIWOOM_DEMO_APP_KEY")),
            "hasBaseKeys": bool(os.environ.get("KIWOOM_APP_KEY")),
        }
        if LIVE and PROVIDER == "kiwoom":
            try:
                _kiwoom_token()
                info["token"] = "정상 발급"
            except Exception as e:
                info["token"] = str(e)[:200]
        body = json.dumps(info, ensure_ascii=False, indent=1).encode("utf-8")
        self._send(body, "application/json; charset=utf-8")

    def do_state(self):
        try:
            raw = live_raw() if LIVE else mock_raw()
        except Exception as e:
            self.send_error(502, "upstream failed: %s" % e)
            return
        body = json.dumps({"ts": int(time.time() * 1000), "symbol": SYMBOL, "name": NAME,
                           "live": LIVE, "provider": PROVIDER or "mock",
                           "pollMs": 10000 if LIVE else 2000,
                           "dev": _dev["price"] is not None, "news": _news["items"],
                           "stale": bool(_live.get("stale")),
                           "session": market_session(),
                           "kst": datetime.now(KST).strftime("%H%M"),
                           "raw": raw, "battle": to_battle(raw)},
                          ensure_ascii=False).encode("utf-8")
        self._send(body, "application/json; charset=utf-8")

    def do_symbols(self):
        """GET /api/symbols        시총 상위 목록
           GET /api/symbols?pick=005930   해당 종목으로 전환
        """
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            if "pick" in q:
                if not switch_symbol(q["pick"][0]):
                    self.send_error(404, "unknown symbol")
                    return
                # 전환 경로에서는 캐시된 목록만 쓴다. 여기서 symbol_list() 를 부르면
                # 캐시가 식었을 때 열 종목을 조회하느라 전환이 그대로 멎는다.
                items = _symbols["list"]
            else:
                items = symbol_list()
            body = json.dumps({"current": SYMBOL, "items": items},
                              ensure_ascii=False).encode("utf-8")
        except Exception as e:
            self.send_error(502, "symbol list failed: %s" % type(e).__name__)
            return
        self._send(body, "application/json; charset=utf-8")

    def do_dev(self):
        """개발자 툴. 목업 현재가를 붙잡거나 놓아준다.

        pct=5.2     전일종가 대비 등락률로 현재가 고정 (종목이 바뀌어도 그대로 통한다)
        auto=1      랜덤워크로 복귀
        reset=1     고가/저가·사이드카·함락을 현재가 기준으로 초기화
        news=호재   뉴스 강제 발생
        """
        if LIVE or PUBLIC:
            self.send_error(403, "dev tool is mock-only")
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        upper, lower = price_limits(_mock["prev"])
        try:
            if "pct" in q:
                want = _mock["prev"] * (1 + float(q["pct"][0]) / 100)
                _dev["price"] = max(lower, min(upper, want))
            if "auto" in q:
                _dev["price"] = None
        except ValueError:
            self.send_error(400, "bad pct")
            return
        if q.get("news", [None])[0] in NEWS_POOL:
            push_news(q["news"][0], time.time())
        if "reset" in q:
            _mock["high"] = _mock["low"] = snap(_mock["price"] or _mock["prev"])
            _sidecar["until"] = 0.0
            _price_hist.clear()
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    _load_picked()
    port = int(os.environ.get("PORT", 8000))
    # 기본은 이 컴퓨터에서만 열린다. 공개 배포일 때만 바깥으로 연다 — 실수로
    # 실전 키를 들고 온 서버가 네트워크에 노출되는 일이 없게 한다.
    host = "0.0.0.0" if PUBLIC else "127.0.0.1"
    print("stock-war  http://%s:%d   [%s]%s"
          % (host, port, ("LIVE " + PROVIDER.upper()) if LIVE else "MOCK",
             "  PUBLIC" if PUBLIC else ""))
    HTTPServer((host, port), Handler).serve_forever()
