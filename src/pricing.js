// 다채움피부과 프로그램 금액·할인·선결제권·최종 계약금액·결제 계산 기준 (동의서 v3 · 회귀 테스트 공용)
// 환불 계산·검증은 refund.js. 규칙을 바꾼 뒤 「회귀 테스트」 페이지로 결과를 확인합니다.
(function (g) {
  const DISCOUNTS = [['none', '일반', 0], ['ref', '지인 소개 5%', 0.05], ['ret', '재티켓팅 10%', 0.1], ['pre', '선결제권', 0]];
  const PREPAID_TIER = { '300': 0.1, '400': 0.15, '500': 0.2 };
  const RET_PERIODS = ['1개월 이내', '상담 안내 기간'];
  const DEPOSIT_RATE = 0.1;
  const num = v => Number(String(v || '').replace(/[^0-9]/g, '')) || 0;

  // 이름 규칙은 가격 데이터의 원래 이름(baseName)으로 판단 → 가격 관리에서 표시 이름을 바꿔도 규칙·연결 유지
  const nm = p => (p && (p.baseName || p.name)) || '';
  // 제모: 남성 지정 결합상품 / 결합할인 제외 부위
  const hairFixed = p => /하관|전체수염|턱밑라인/.test(nm(p));
  const hairExcluded = p => /인중|겨드랑이/.test(nm(p));
  function hairCombo(parts) {
    const elig = parts.filter(p => !hairExcluded(p) && !hairFixed(p));
    const rate = elig.length >= 3 ? 0.2 : elig.length === 2 ? 0.1 : 0;
    const off = Math.round(elig.reduce((t, p) => t + Number(p.total || 0), 0) * rate);
    const sum = parts.reduce((t, p) => t + Number(p.total || 0), 0);
    return { elig, rate, off, sum };
  }

  // 리프팅 후 1년 이내 스킨부스터 → 선결제권 사용 시 같은 상품 정상가 기준
  const isYearSkinBooster = cur => !!(cur && cur.cat === '스킨부스터' && /리프팅 (할인가|적용가)/.test(nm(cur)));
  const findNormalOf = (cur, all) => (all.find(p => p.id === String(cur.id).replace(/^(PGM-SB-\d)D/, '$1N') && p.id !== cur.id)
    || all.find(p => p.id !== cur.id && p.cat === cur.cat && nm(p) === nm(cur).replace(/\s*[·(]\s*리프팅 (할인가|적용가)\)?\s*$/, ''))) || null;

  // 2단계: 할인 하나 선택 → 최종 계약금액
  // 할인은 한 가지만: 이벤트(정액 적용가·할인율)는 다른 할인과 중복 없음
  // rateEvents: 현재 프로그램에 쓸 수 있는 할인율 이벤트 — 할인 항목 중 하나로 직원이 선택 (자동 적용 없음)
  // 리프팅 후 1년 이내 혜택가: 지인 소개·재티켓팅 추가 할인 불가, 선결제권은 정상가 기준
  function discount({ cur, held, hairParts, hairRate, listNum, optAddSum, all, disc, preTier, evDef, rateEvents }) {
    const isEvProg = !!(cur && cur.event);
    const isYearSB = isYearSkinBooster(cur);
    const isComboFixed = held ? !!(cur && cur.cat === '제모' && hairFixed(cur)) : (hairParts || []).some(hairFixed);
    const noPreHair = isComboFixed || hairRate > 0;
    const noRet = !!(cur && cur.cat === '여드름' && /4주/.test(nm(cur)));
    const RE = (!isEvProg && !noPreHair && cur ? (rateEvents || []) : []);
    const evOf = k => String(k).startsWith('ev:') ? RE.find(e => 'ev:' + e.id === k) || null : null;
    const discOk = k => k === 'none' || (String(k).startsWith('ev:') ? !!evOf(k)
      : !isEvProg && !(k === 'ret' && noRet) && !(isYearSB && (k === 'ref' || k === 'ret')) && !noPreHair);
    const discKey = discOk(disc || 'none') ? (disc || 'none') : 'none';
    const tier = discKey === 'pre' && PREPAID_TIER[preTier] ? preTier : '';
    const normal = isYearSB ? findNormalOf(cur, all) : null;
    const preBase = normal ? Number(normal.total || 0) + optAddSum : listNum;
    const evSel = evOf(discKey);
    const discRate = discKey === 'pre' ? (PREPAID_TIER[tier] || 0) : evSel ? Number(evSel.rate) : (DISCOUNTS.find(d => d[0] === discKey) || [0, 0, 0])[2];
    const discBase = discKey === 'pre' ? preBase : listNum;
    const totalNum = discRate ? Math.round(discBase * (1 - discRate)) : listNum;
    const discLabel = discKey === 'pre' ? (tier ? '선결제권 ' + tier + ' / ' + Math.round(discRate * 100) + '%' : '선결제권')
      : discKey === 'none' ? '' : evSel ? evSel.name + ' ' + Math.round(discRate * 100) + '%' : DISCOUNTS.find(d => d[0] === discKey)[1];
    const options = DISCOUNTS.filter(d => discOk(d[0])).map(d => ({ key: d[0], label: d[1] }))
      .concat(RE.map(e => ({ key: 'ev:' + e.id, label: e.name + ' ' + Math.round(Number(e.rate) * 100) + '%', eventId: e.id })));
    return { isEvProg, isYearSB, isComboFixed, noPreHair, noRet, discOk, discKey, preTier: tier, preBase, discRate, discBase, totalNum, discLabel,
      allowed: options.map(o => o.key), options, eventId: evSel ? evSel.id : null, listTotal: discKey === 'pre' ? preBase : listNum };
  }

  // 3단계: 최종 계약금액 − 기존 선결제권 잔액(직원 입력, 없으면 0) − 기납부 예약금
  function payment({ totalNum, preBal, priorDep, deposit }) {
    const bal = num(preBal), pd = num(priorDep);
    const needNum = Math.max(0, totalNum - bal - pd);
    const leftNum = Math.max(0, bal + pd - totalNum);
    // 예약금: 목표 = 계약 총액 × 10%. 이 계약에 이미 납부·사용된 금액(기납부 예약금 + 선결제권 사용분)을 빼고, 남은 미납금액을 넘지 않음
    const depTarget = Math.round(totalNum * DEPOSIT_RATE), already = Math.min(totalNum, bal + pd);
    const depAmt = Math.min(needNum, Math.max(0, depTarget - already));
    const nowNum = deposit ? depAmt : needNum;
    return { preBal: bal, priorDep: pd, needNum, leftNum, depAmt, depTarget, already, nowNum, restNum: deposit ? needNum - depAmt : 0,
      paid: nowNum + Math.min(totalNum, bal + pd) };
  }

  g.DachaeumPricing = { DISCOUNTS, PREPAID_TIER, RET_PERIODS, num, nm, hairFixed, hairExcluded, hairCombo, isYearSkinBooster, findNormalOf,
    discount, payment };
})(typeof window !== 'undefined' ? window : globalThis);
