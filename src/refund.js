// 다채움피부과 환불 계산·검증 기준 (동의서 v3 · 회귀 테스트 공용)
// 위약금 · 실제 이용금액 · CO₂/흑자 병변 금액 · 최종 환불금액 · 결제수단별 환불 한도/합계 검증
// 환불 규칙을 바꿀 때는 이 파일만 수정하고 「회귀 테스트」로 결과를 확인합니다.
(function (g) {
  const PENALTY_RATE = 0.1;
  const num = v => Number(String(v || '').replace(/[^0-9]/g, '')) || 0;
  // 금액 값: 숫자는 그대로, 문자열('1,000,000')·빈 값은 숫자로 변환 → NaN·문자열 이어붙이기 방지 (계산식은 그대로)
  const amt = v => typeof v === 'number' && Number.isFinite(v) ? v : num(v);

  // 병변 단위 정산 항목
  // · CO₂(actual): 제거한 병변마다 개별 정상가 입력 → 합계 (계약 1회 정상가 = 최소 기준)
  // · 스페셜 토닝 흑자 추가옵션: 병변마다 크기 선택 → 크기별 정상가 합계 (추가금 110,000원은 사용하지 않음)
  const BS_ADD_ID = 'pig-blackspot-pico532';
  const isBlackspotAdd = it => !!it && it.kind === '추가' && it.name === '흑자 제거';
  const isActual = it => !!it && (!!it.actual || isBlackspotAdd(it));
  // 크기별 정상가: 계약 스냅샷(it.tiers) 우선, 없으면 programs.json → lesionSettle
  const tiersOf = (it, db) => (it && it.tiers) || ((db && db.lesionSettle && db.lesionSettle[BS_ADD_ID]) || []);
  const tierPrice = (tiers, v) => ((tiers || []).find(t => t.label === v) || { price: 0 }).price;
  const lesionValue = (it, v, db) => isBlackspotAdd(it) ? tierPrice(tiersOf(it, db), v) : num(v);
  const lesionRowBad = (it, v, db) => isBlackspotAdd(it) ? !tierPrice(tiersOf(it, db), v) : num(v) < (Number(it.price) || 1);
  function lesions(C, rfLes, db) {
    const of = k => (rfLes || {})[k] || [];
    const lesAmt = C.items.map((it, k) => isActual(it) ? of(k).reduce((t, v) => t + lesionValue(it, v, db), 0) : null);
    const lesBad = C.items.some((it, k) => isActual(it) && of(k).some(v => lesionRowBad(it, v, db)));
    return { lesAmt, lesBad };
  }
  // 이용 개수: 병변 항목은 입력한 병변 행 수
  const usedCounts = (C, used, rfLes) => (used || C.items.map(() => 0)).map((x, k) => isActual(C.items[k]) ? ((rfLes || {})[k] || []).length : x);

  // 환불: 실제 결제금액 − 위약금(총 계약금액 × 10%) − 이용금액, 0원 미만은 0원. 단가는 계약 스냅샷(C.items[].price)
  const amtOf = (it, u) => it.lesionUnit ? (u > 0 ? amt(it.price) : 0) : u * amt(it.price);
  function refund(C, used, visits, extraPaid, lesAmt) {
    const U = used || [], V = visits || [], L = lesAmt || [];
    const a = (it, k) => L[k] != null ? L[k] : amtOf(it, U[k] || 0);
    const trtAmt = C.items.reduce((t, it, k) => t + (it.kind === '서비스' ? 0 : a(it, k)), 0);
    const svcAmt = C.items.reduce((t, it, k) => t + (it.kind === '서비스' ? a(it, k) : 0), 0) + V.reduce((t, v) => t + amt(v.price), 0);
    const usedAmt = trtAmt + svcAmt;
    const penNum = Math.round(amt(C.total) * PENALTY_RATE);
    const paidEff = amt(C.paid) + (extraPaid || 0);
    return { trtAmt, svcAmt, usedAmt, penNum, paidEff, refundNum: Math.max(0, paidEff - penNum - usedAmt) };
  }

  // 결제수단별 환불: 원결제 수단(선결제권 잔액 사용분 포함). 직원이 수단별 금액을 직접 입력
  // 납부금액(C.paid)에는 기납부 예약금이 포함되지만 payments에는 기록되지 않으므로, 차액을 별도 수단으로 추가해 배분 가능하게 함
  const refundPays = C => {
    const pays = (C.payments && C.payments.length ? C.payments : [{ method: C.method || '카드', amount: C.paid }]).map(p => ({ ...p, amount: amt(p.amount) }));
    const gap = amt(C.paid) - pays.reduce((t, p) => t + p.amount, 0);
    return gap > 0 ? pays.concat([{ method: '기납부 예약금', amount: gap, priorDep: true }]) : pays;
  };
  // 참고용 기본 배분(원결제 순서·한도). 화면에서는 자동 배분하지 않음
  function allocDefault(refundNum, pays) { let left = refundNum; return pays.map(p => { const a = Math.min(left, Number(p.amount || 0)); left -= a; return a; }); }
  // 검증: 수단별 금액 ≤ 원결제 금액, 합계 = 최종 환불금액 (결제수단 1개면 해당 수단 = 최종 환불금액, 원결제 한도만 검증)
  function checkAlloc(pays, alloc, refundNum) {
    const amounts = pays.length <= 1 ? [refundNum] : pays.map((_, i) => num((alloc || {})[i]));
    const over = pays.map((p, i) => amounts[i] > amt(p.amount));
    const allocSum = amounts.reduce((t, x) => t + x, 0), allocOver = over.some(Boolean);
    const allocOk = !allocOver && allocSum === refundNum;
    const allocDiff = refundNum - allocSum;
    const allocMsg = allocOver ? '원결제 금액을 넘은 수단이 있습니다'
      : allocDiff > 0 ? allocDiff.toLocaleString('ko-KR') + '원이 더 배분되어야 합니다'
      : allocDiff < 0 ? (-allocDiff).toLocaleString('ko-KR') + '원이 초과 배분되었습니다' : '';
    return { amounts, over, allocSum, allocOver, allocOk, allocDiff, allocMsg };
  }
  // 정상가 누락: 계약 항목·서비스 기록에 1회 정상가가 없으면 0원으로 계산하지 않음.
  // 실제 이용(수량 > 0)이 있는 경우에만 '정상가 확인 필요'로 환불 확정을 막고, 근거를 확인해 보완한 값(C.priceFixes)이 있으면 그 값을 사용
  // 보완 기록은 계약 항목(원 서명 내용)을 바꾸지 않고 별도로 남김: { key, label, price, basis, at }
  const fixOf = (C, key) => { const f = (C.priceFixes || []).filter(x => x.key === key).pop(); return f ? amt(f.price) : null; };
  const itemKey = k => 'item:' + k;
  const svcKey = v => 'svc:' + (v.key || v.label || '');
  function resolvePrices(C, used, visits) {
    const missing = [];
    const items = C.items.map((it, k) => {
      if (isActual(it) || amt(it.price) > 0) return it;
      const f = fixOf(C, itemKey(k));
      if (f != null) return { ...it, price: f, priceFixed: true };
      if ((used || [])[k] > 0) missing.push({ key: itemKey(k), label: it.name });
      return { ...it, price: 0, priceMissing: true };
    });
    const V = (visits || []).map(v => {
      if (v.price != null && v.price !== '' && amt(v.price) > 0) return v;
      const f = fixOf(C, svcKey(v));
      if (f != null) return { ...v, price: f, priceFixed: true };
      if (!missing.some(m => m.key === svcKey(v))) missing.push({ key: svcKey(v), label: v.label });
      return { ...v, price: 0, priceMissing: true };
    });
    return { C2: { ...C, items }, V, missing };
  }
  const MSG = { lesion: '시술한 병변의 정상가(흑자는 크기)를 모두 입력해 주세요', alloc: '결제수단별 환불금액 합계가 최종 환불금액과 일치해야 합니다',
    over: '원결제 금액을 넘는 환불금액이 있습니다', price: '정상가 확인이 필요한 이용 항목이 있어 환불을 확정할 수 없습니다' };
  const validate = ({ lesBad, allocOk, allocOver, missing }) => (missing && missing.length) ? MSG.price : lesBad ? MSG.lesion : allocOver ? MSG.over : !allocOk ? MSG.alloc : '';

  // 한 번에 계산: 동의서 v3 환불 화면은 이 결과만 사용
  function settle(C0, { used, visits, extraPaid, rfLes, alloc } = {}, db) {
    const { lesAmt, lesBad } = lesions(C0, rfLes, db);
    const U = usedCounts(C0, used, rfLes);
    const { C2: C, V, missing } = resolvePrices(C0, U, visits);
    const R = refund(C, U, V, extraPaid || 0, lesAmt);
    const pays = refundPays(C);
    const A = checkAlloc(pays, alloc, R.refundNum);
    return { ...R, U, lesAmt, lesBad, pays, ...A, items: C.items, visits: V, missing,
      error: validate({ lesBad, allocOk: A.allocOk, allocOver: A.allocOver, missing }) };
  }

  g.DachaeumRefund = { PENALTY_RATE, BS_ADD_ID, num, amt, fixOf, itemKey, svcKey, resolvePrices, isBlackspotAdd, isActual, tiersOf, tierPrice, lesionValue, lesionRowBad, lesions, usedCounts,
    amtOf, refund, refundPays, allocDefault, checkAlloc, validate, MSG, settle };
})(typeof window !== 'undefined' ? window : globalThis);
