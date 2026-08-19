"""python test_server.py — 목업 생성기와 전투 변환의 최소 검증."""
import server


def sample(price, vol, retail, foreign, pension, inst):
    """검증용 raw. 거래량 규모만 다르고 수급 구성비는 같게 만들 수 있다."""
    grp = lambda q: {"buy": q, "sell": q, "net": 0}
    return {"price": price, "change": 0.0, "changePct": 0.0,
            "open": price, "high": price, "low": price,
            "volume": vol, "amount": price * vol, "deltaVol": vol * 0.001, "tempo": 0.5,
            "askTotal": 1000, "bidTotal": 1000, "asks": [], "bids": [],
            "investors": {"retail": grp(retail), "foreign": grp(foreign),
                          "pension": grp(pension), "inst": grp(inst)}}


def main():
    raw = None
    for _ in range(500):
        raw = server.mock_raw()

        assert raw["low"] <= raw["price"] <= raw["high"], raw
        assert abs(raw["changePct"]) <= 30.1, raw["changePct"]
        assert len(raw["asks"]) == len(raw["bids"]) == 10
        assert raw["asks"][0][0] > raw["price"] > raw["bids"][0][0], raw["asks"][0]
        assert all(q >= 0 for _, q in raw["asks"] + raw["bids"])
        assert 0 <= raw["tempo"] <= 1, raw["tempo"]

        b = server.to_battle(raw)
        assert -1 <= b["front"] <= 1, b["front"]
        assert -1 <= b["pressure"] <= 1, b["pressure"]
        assert 0 <= b["tempo"] <= 1, b["tempo"]
        for side in ("red", "blue"):
            assert set(b[side]) == set(server.CAPS), b[side]
            for kind, cap in server.CAPS.items():
                assert 0 <= b[side][kind] <= cap, (side, kind, b[side][kind])
            assert 0 <= b["castle"][side] <= 1, b["castle"]
        assert isinstance(b["sidecar"]["active"], bool)
        assert b["sidecar"]["remainMs"] >= 0

    # 전선은 상한가/하한가를 자로 삼는다. 성이 맵의 30% 지점에 있고 상하한가가
    # ±30% 이므로, 몇 % 움직였을 때 성 앞까지 밀려버리면 안 된다.
    def at(price, prev=78000.0):
        return server.to_battle(dict(sample(price, 1e7, 42, 30, 8, 20),
                                     change=price - prev,
                                     changePct=(price - prev) / prev * 100,
                                     high=max(price, prev), low=min(price, prev)))
    up30, dn30 = server.price_limits(78000.0)
    assert at(up30)["front"] == 1.0, at(up30)["front"]
    assert at(dn30)["front"] == -1.0, at(dn30)["front"]
    assert at(78000.0)["front"] == 0.0

    # 7% 하락이면 하한가까지의 1/4 남짓이다. 예전 tanh 는 여기서 이미 -0.99 였다.
    f7 = at(78000.0 * 0.93)["front"]
    assert -0.35 < f7 < -0.2, f7
    # 상승장이면 +, 하락장이면 - 그리고 커질수록 단조 증가
    assert at(80000.0)["front"] > 0 > at(76000.0)["front"]
    assert at(90000.0)["front"] > at(80000.0)["front"] > at(79000.0)["front"]

    # 성벽도 같은 자를 쓴다. 저가가 하한가에 닿아야 홍군 성이 무너진다.
    assert at(dn30)["castle"]["red"] == 0.0
    mild = at(78000.0 * 0.93)["castle"]["red"]
    assert 0.6 < mild < 0.85, mild

    # 핵심: 병력은 점유율로만 정해진다. 거래량이 100배 달라도 구성비가 같으면
    # 같은 병력이 나와야 종목을 바꿔도 상수를 다시 잡을 필요가 없다.
    small = server.to_battle(sample(3200, 1.2e5, 42, 30, 8, 20))
    huge = server.to_battle(sample(410000, 2.4e7, 4200, 3000, 800, 2000))
    assert small["red"] == huge["red"], (small["red"], huge["red"])
    assert small["red"]["infantry"] > small["red"]["general"] > 0, small["red"]

    # 수급이 0이면 유닛도 0 (장 시작 전 / 수급 미발표 구간)
    z = server.to_battle(sample(78000, 1e7, 0, 0, 0, 0))
    assert sum(z["red"].values()) == sum(z["blue"].values()) == 0, z

    # 성벽 손상은 당일 저가/고가에서 오고, 되돌아오지 않는다
    hit = server.to_battle(dict(raw, price=100.0, change=0.0, changePct=0.0,
                                low=71.0, high=100.0))
    assert hit["castle"]["red"] < 0.1 and hit["castle"]["blue"] == 1.0, hit["castle"]

    # 상하한가는 기준가 ±30% 안쪽의 유효 호가에서 멈춘다
    up, dn = server.price_limits(78000.0)
    assert (up, dn) == (101400, 54600), (up, dn)
    assert up <= 78000 * 1.3 and dn >= 78000 * 0.7
    for prev in (1830.0, 4995.0, 19900.0, 49950.0, 199500.0, 480000.0, 1250000.0):
        u, d = server.price_limits(prev)
        assert u <= prev * 1.3 and d >= prev * 0.7, (prev, u, d)
        assert u % server.tick_size(u) == 0 and d % server.tick_size(d) == 0, (prev, u, d)

    # 상한가면 청군 성이, 하한가면 홍군 성이 함락된다
    at_up = server.to_battle(dict(sample(up, 1e7, 42, 30, 8, 20),
                                  change=up - 78000, changePct=30.0, high=up, low=78000.0))
    assert at_up["limit"]["hit"] == "upper" and at_up["castle"]["blue"] == 0.0, at_up
    at_dn = server.to_battle(dict(sample(dn, 1e7, 42, 30, 8, 20),
                                  change=dn - 78000, changePct=-30.0, high=78000.0, low=dn))
    assert at_dn["limit"]["hit"] == "lower" and at_dn["castle"]["red"] == 0.0, at_dn
    assert server.to_battle(sample(78000, 1e7, 42, 30, 8, 20))["limit"]["hit"] is None

    # 장 상태는 KST 기준으로 갈린다
    from datetime import datetime, timedelta, timezone
    kst = timezone(timedelta(hours=9))
    at = lambda mon_offset, h, m: datetime(2026, 8, 17 + mon_offset, h, m, tzinfo=kst)
    assert server.market_session(at(0, 8, 59)) == "장전"
    assert server.market_session(at(0, 9, 0)) == "장중"
    assert server.market_session(at(0, 15, 29)) == "장중"
    assert server.market_session(at(0, 15, 30)) == "장마감"
    assert server.market_session(at(5, 11, 0)) == "휴장", "토요일"
    assert server.market_session(at(6, 11, 0)) == "휴장", "일요일"

    # 뉴스는 호재/악재 둘 중 하나이고, 최근 것만 남긴다
    for _ in range(12):
        server.push_news("호재", 1000.0)
    assert len(server._news["items"]) <= 6, len(server._news["items"])
    n = server._news["items"][-1]
    assert n["tone"] in server.NEWS_POOL and n["title"] and n["id"] > 0, n

    # 사이드카: 2분 안에 3% 넘게 움직이면 발동하고, 유지 시간 동안 켜져 있다
    server._price_hist.clear()
    server._sidecar.update(until=0.0, dir="")
    base = sample(78000, 1e7, 42, 30, 8, 20)
    assert not server.to_battle(base, now=1000.0)["sidecar"]["active"]
    spike = server.to_battle(sample(81500, 1e7, 42, 30, 8, 20), now=1060.0)
    assert spike["sidecar"]["active"] and spike["sidecar"]["dir"] == "급등", spike["sidecar"]
    still = server.to_battle(base, now=1070.0)
    assert still["sidecar"]["active"], "유지 시간 안에는 계속 켜져 있어야 한다"
    after = server.to_battle(base, now=1060.0 + server.SIDECAR_HOLD_S + 1)
    assert not after["sidecar"]["active"], after["sidecar"]

    test_kis_parse()
    test_kiwoom_parse()
    test_static_allowlist()
    print("ok")


def test_kis_parse():
    """KIS 응답 파싱. 키가 없으면 실호출을 못 하므로 가짜 응답을 먹여 검산한다."""
    price = {"stck_prpr": "78200", "prdy_vrss": "1200", "prdy_ctrt": "1.56",
             "stck_oprc": "77000", "stck_hgpr": "78500", "stck_lwpr": "76800",
             "acml_vol": "12000000", "acml_tr_pbmn": "930000000000"}
    ask = {"total_askp_rsqn": "300000", "total_bidp_rsqn": "500000"}
    for i in range(1, 11):
        ask["askp%d" % i] = str(78200 + i * 100)
        ask["askp_rsqn%d" % i] = str(1000 * i)
        ask["bidp%d" % i] = str(78200 - i * 100)
        ask["bidp_rsqn%d" % i] = str(2000 * i)
    inv = {"prsn_shnu_qty": "500", "prsn_seln_qty": "400", "prsn_ntby_qty": "100",
           "frgn_shnu_qty": "300", "frgn_seln_qty": "200", "frgn_ntby_qty": "100",
           "pefn_shnu_qty": "40", "pefn_seln_qty": "30", "pefn_ntby_qty": "10",
           "orgn_shnu_qty": "100", "orgn_seln_qty": "70", "orgn_ntby_qty": "30"}

    def fake_get(path, tr_id, extra=None):
        if "inquire-price" in path:
            return {"output": price}
        if "asking-price" in path:
            return {"output1": ask}
        return {"output": [inv]}

    real, server._kis_get = server._kis_get, fake_get
    server._last_vol["v"] = 0
    try:
        raw = server.kis_raw()
    finally:
        server._kis_get = real

    assert raw["price"] == 78200 and raw["changePct"] == 1.56, raw
    assert raw["askTotal"] == 300000 and raw["bidTotal"] == 500000, raw
    assert len(raw["asks"]) == 10 and raw["asks"][0] == [78300.0, 1000.0], raw["asks"][0]
    # 기관계에는 연기금이 포함돼 있으므로 장군 몫에서 빼야 이중 계산이 안 된다
    assert raw["investors"]["inst"]["buy"] == 60, raw["investors"]["inst"]
    assert raw["investors"]["pension"]["buy"] == 40, raw["investors"]["pension"]
    # 목업과 같은 스키마여야 프론트가 출처를 몰라도 된다
    assert set(raw) == set(server.mock_raw()), set(raw) ^ set(server.mock_raw())
    b = server.to_battle(raw)
    assert -1 <= b["front"] <= 1 and b["limit"]["upper"] > raw["price"], b


def test_kiwoom_parse():
    """키움 REST 응답 파싱. 부호가 붙은 문자열과 1차선 필드명이 관건이다."""
    # '--28837' 처럼 부호가 두 번 붙어 오는 필드가 실제로 있다
    assert server._kw_num("+61300") == 61300
    assert server._kw_num("--28837") == -28837
    assert server._kw_num("-5") == -5 and server._kw_num("") == 0 and server._kw_num(None) == 0

    price = {"cur_prc": "+78200", "pred_pre": "+1200", "flu_rt": "+156",
             "open_pric": "+77000", "high_pric": "+78500", "low_pric": "-76800",
             "trde_qty": "12000000", "trde_pre": "930000"}
    ask = {"tot_sel_req": "300000", "tot_buy_req": "500000",
           "sel_fpr_bid": "+78300", "sel_fpr_req": "1000",
           "buy_fpr_bid": "+78100", "buy_fpr_req": "2000"}
    for i in range(2, 11):
        ask["sel_%dth_pre_bid" % i] = "+%d" % (78200 + i * 100)
        ask["sel_%dth_pre_req" % i] = str(1000 * i)
        ask["buy_%dth_pre_bid" % i] = "+%d" % (78200 - i * 100)
        ask["buy_%dth_pre_req" % i] = str(2000 * i)
    inv = {"1": {"ind_invsr": "500", "frgnr_invsr": "300",
                 "orgn": "100", "penfnd_etc": "40"},
           "2": {"ind_invsr": "400", "frgnr_invsr": "200",
                 "orgn": "70", "penfnd_etc": "30"}}

    def fake_post(path, api_id, body):
        if api_id == "ka10001":
            return price
        if api_id == "ka10004":
            return ask
        return {"stk_invsr_orgn": [inv[body["trde_tp"]]]}

    real, server._kw_post = server._kw_post, fake_post
    server._last_vol["v"] = 0
    try:
        raw = server.kiwoom_raw()
    finally:
        server._kw_post = real

    assert raw["price"] == 78200 and raw["change"] == 1200, raw
    assert abs(raw["changePct"] - 1200 / 77000 * 100) < 1e-9, raw["changePct"]
    assert raw["low"] == 76800, "부호를 떼야 저가가 음수로 안 잡힌다"
    assert raw["askTotal"] == 300000 and raw["bidTotal"] == 500000, raw
    # 1차선은 필드명이 달라서(sel_fpr_*) 빠뜨리기 쉽다
    assert raw["asks"][0] == [78300.0, 1000.0], raw["asks"][0]
    assert raw["bids"][0] == [78100.0, 2000.0], raw["bids"][0]
    assert len(raw["asks"]) == len(raw["bids"]) == 10
    assert raw["asks"][9] == [79200.0, 10000.0], raw["asks"][9]
    # 기관계에서 연기금을 뺀 값이 장군 몫이다
    assert raw["investors"]["inst"]["buy"] == 60, raw["investors"]["inst"]
    assert raw["investors"]["pension"]["sell"] == 30, raw["investors"]["pension"]
    # 세 출처의 스키마가 같아야 프론트가 출처를 몰라도 된다
    assert set(raw) == set(server.mock_raw()), set(raw) ^ set(server.mock_raw())
    b = server.to_battle(raw)
    assert -1 <= b["front"] <= 1 and sum(b["red"].values()) > 0, b


def test_static_allowlist():
    """서버가 내보내는 파일이 허용 목록뿐인지 실제로 띄워서 확인한다.

    예전에는 디렉토리를 통째로 서빙해 GET /.env 가 키를 200 으로 돌려줬다.
    같은 구멍이 다시 나면 배포 즉시 자격증명이 새므로 테스트로 못박는다.
    """
    import threading
    import urllib.error
    import urllib.request
    from http.server import HTTPServer

    srv = HTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]

    def code(path):
        try:
            with urllib.request.urlopen(base + path, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    try:
        for path in ("/.env", "/.kiwoom_token.json", "/.symbols.json", "/.picked.json",
                     "/server.py", "/test_server.py", "/README.md", "/render.yaml",
                     "/./.env", "/%2e/.env", "/static/../.env"):
            assert code(path) == 404, "%s 가 열려 있다" % path
        for path in ("/", "/index.html", "/war.js"):
            assert code(path) == 200, "%s 가 안 나온다" % path
    finally:
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    main()
