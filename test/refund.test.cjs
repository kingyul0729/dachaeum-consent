// 환불 계산·결제 기준 고정 테스트 (src/refund.js, src/pricing.js)
// 최종 환불금액 = MAX(0, 실제 납부액 − 계약 총액 × 10% − 이용금액)
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/refund.js');
require('../src/pricing.js');
const RF = globalThis.DachaeumRefund, PR = globalThis.DachaeumPricing;

const items = [
  { kind: '시술', name: '리쥬란 HB', qty: 6, price: 500000 },
  { kind: '시술', name: '리쥬란 힐러', qty: 2, price: 300000 },
  { kind: '서비스', name: 'LDM', qty: 4, price: 80000 },
];
const contract = (o = {}) => ({ total: 3600000, paid: 3600000, items, payments: [{ method: '카드', amount: 3600000 }], ...o });

test('시술 시작 전: 실제 납부액 − 총액 10%', () => {
  const r = RF.settle(contract(), { used: [0, 0, 0] });
  assert.equal(r.penNum, 360000);
  assert.equal(r.usedAmt, 0);
  assert.equal(r.refundNum, 3240000);
});

test('시술 시작 후: 항목별 계약 당시 1회 정상가 × 이용 수량 (균등분할 아님)', () => {
  const r = RF.settle(contract(), { used: [2, 1, 3] });
  assert.equal(r.trtAmt, 2 * 500000 + 300000);
  assert.equal(r.svcAmt, 3 * 80000);
  assert.equal(r.refundNum, 3600000 - 360000 - 1540000);
});

test('0원 미만은 0원 (추가 청구 없음)', () => {
  const r = RF.settle(contract(), { used: [6, 2, 4] });
  assert.equal(r.refundNum, 0);
});

test('위약금은 총액 기준, 환불은 실제 납부액 기준 (예약금·잔금)', () => {
  const c = { total: 1000000, items: [{ kind: '시술', name: 'A', qty: 5, price: 200000 }] };
  assert.equal(RF.settle({ ...c, paid: 100000 }, { used: [0] }).refundNum, 0);
  assert.equal(RF.settle({ ...c, paid: 300000 }, { used: [0] }).refundNum, 200000);
  const r = RF.settle({ ...c, paid: 600000 }, { used: [1] });
  assert.equal(r.penNum, 100000);
  assert.equal(r.refundNum, 300000);
});

test('흑자: 시작한 병변만 병변 금액 전액, 5등분 없음', () => {
  const B = { total: 770000, paid: 770000, items: [
    { kind: '시술', lesionUnit: true, qty: 5, price: 330000, name: '흑자 1' },
    { kind: '시술', lesionUnit: true, qty: 5, price: 440000, name: '흑자 2' }] };
  assert.equal(RF.settle(B, { used: [1, 0] }).usedAmt, 330000);
  assert.equal(RF.settle(B, { used: [3, 0] }).usedAmt, 330000);
  assert.equal(RF.settle(B, { used: [0, 0] }).refundNum, 770000 - 77000);
});

test('CO₂ 병변: 입력한 병변별 정상가 합 (쉼표 금액), 기준 미만 입력은 오류', () => {
  const C = { total: 500000, paid: 500000, items: [{ kind: '서비스', actual: true, name: 'CO₂', price: 11000 }] };
  const r = RF.settle(C, { rfLes: { 0: ['22,000', '33,000'] } });
  assert.equal(r.usedAmt, 55000);
  assert.equal(r.U[0], 2);
  assert.ok(RF.settle(C, { rfLes: { 0: ['5,000'] } }).lesBad);
});

test('서비스 기록(약처방 등)은 기록된 단가 합으로 이용금액에 포함', () => {
  const r = RF.settle(contract(), { used: [0, 0, 0], visits: [{ label: '약처방 · 14일 미만', price: 15000 }, { label: '약처방 · 14일 이상', price: 20000 }] });
  assert.equal(r.svcAmt, 35000);
});

test('결제수단별 환불: 원결제 초과·합계 불일치 차단, 일치 시 통과', () => {
  const c = contract({ payments: [{ method: '카드', amount: 2000000 }, { method: '현금', amount: 1600000 }] });
  const ok = RF.settle(c, { used: [0, 0, 0], alloc: { 0: '2,000,000', 1: '1,240,000' } });
  assert.equal(ok.allocOk, true); assert.equal(ok.error, '');
  assert.equal(RF.settle(c, { used: [0, 0, 0], alloc: { 0: '3,240,000', 1: '0' } }).allocOver, true);
  assert.equal(RF.settle(c, { used: [0, 0, 0], alloc: { 0: '1,000,000', 1: '1,000,000' } }).allocOk, false);
});

test('결제수단 1개: 원결제 금액을 넘는 환불은 차단', () => {
  const r = RF.settle({ total: 1000000, paid: 1000000, items: [{ kind: '시술', name: 'A', qty: 5, price: 200000 }], payments: [{ method: '카드', amount: 500000 }] }, { used: [0] });
  assert.equal(r.allocOk, false);
});

test('기납부 예약금은 결제수단별 환불에 별도 줄로 포함', () => {
  const pays = RF.refundPays({ paid: 1000000, payments: [{ method: '카드', amount: 700000 }] });
  assert.deepEqual(pays.map(p => [p.method, p.amount]), [['카드', 700000], ['기납부 예약금', 300000]]);
});

test('결제 계산: 실제 납부액(paid)에 선결제권 사용분·기납부 예약금 포함, 예약금은 총액 10%', () => {
  const full = PR.payment({ totalNum: 1000000, preBal: '200000', priorDep: '300000', deposit: false });
  assert.equal(full.nowNum, 500000); assert.equal(full.paid, 1000000);
  const dep = PR.payment({ totalNum: 1000000, preBal: 0, priorDep: 0, deposit: true });
  assert.equal(dep.nowNum, 100000); assert.equal(dep.paid, 100000); assert.equal(dep.restNum, 900000);
});

test('할인: 지인 5% · 재티켓팅 10% · 선결제권 300/400/500', () => {
  const base = { cur: { cat: '스킨부스터', name: 'X' }, listNum: 1000000, optAddSum: 0, all: [], hairRate: 0, hairParts: [] };
  assert.equal(PR.discount({ ...base, disc: 'ref' }).totalNum, 950000);
  assert.equal(PR.discount({ ...base, disc: 'ret' }).totalNum, 900000);
  assert.equal(PR.discount({ ...base, disc: 'pre', preTier: '500' }).totalNum, 800000);
  assert.equal(PR.discount({ ...base, cur: { ...base.cur, event: 'E1' }, disc: 'ref' }).totalNum, 1000000);
});

test('금액이 빠졌거나 문자열이어도 NaN·문자열 이어붙이기 없이 계산 (계산식 동일)', () => {
  const it = [{ kind: '시술', name: 'A', qty: 5, price: '200,000' }];
  const r = RF.settle({ total: '1,000,000', paid: '1,000,000', items: it, payments: [{ method: '카드', amount: '1,000,000' }] }, { used: [1], visits: [{ label: '약처방', price: '15,000' }] });
  assert.equal(r.penNum, 100000); assert.equal(r.usedAmt, 215000); assert.equal(r.refundNum, 685000); assert.equal(r.allocOk, true);
  const missing = RF.settle({ total: 1000000, items: [{ kind: '시술', name: 'A', qty: 5, price: 200000 }] }, { used: [1] });
  assert.ok(Number.isFinite(missing.refundNum)); assert.equal(missing.refundNum, 0);
});

test('정상가 누락: 이용한 항목은 0원 계산 대신 환불 확정 차단, 이용하지 않았으면 차단 없음', () => {
  const C = { total: 660000, paid: 660000, items: [{ kind: '시술', name: '남성 턱밑라인 포함 제모', qty: 5, price: 0 }, { kind: '서비스', name: '진정관리', qty: 2, price: 50000 }] };
  const unused = RF.settle(C, { used: [0, 1] });
  assert.equal(unused.error, ''); assert.deepEqual(unused.missing, []);
  const used = RF.settle(C, { used: [5, 0] });
  assert.equal(used.missing.length, 1); assert.equal(used.missing[0].label, '남성 턱밑라인 포함 제모');
  assert.match(used.error, /정상가 확인/);
});

test('정상가 보완 기록(priceFixes)이 있으면 그 값으로 차감, 원 계약 항목은 그대로', () => {
  const C = { total: 660000, paid: 660000, items: [{ kind: '시술', name: '턱밑', qty: 5, price: 0 }],
    priceFixes: [{ key: 'item:0', label: '턱밑', price: 132000, basis: '테스트 근거', at: '2026-10-01T00:00:00Z' }] };
  const r = RF.settle(C, { used: [2] });
  assert.equal(r.error, ''); assert.equal(r.usedAmt, 264000); assert.equal(r.refundNum, 660000 - 66000 - 264000);
  assert.equal(C.items[0].price, 0);
});

test('서비스 기록 단가 없음(이전 계약): 0원 처리하지 않고 차단, 보완 후 반영', () => {
  const base = { total: 500000, paid: 500000, items: [] };
  const v = [{ label: '약처방 · 14일 미만', price: null, key: 'rx|14일 미만' }];
  assert.match(RF.settle(base, { visits: v }).error, /정상가 확인/);
  const fixed = RF.settle({ ...base, priceFixes: [{ key: 'svc:rx|14일 미만', price: 15000, basis: '당시 가격표' }] }, { visits: v });
  assert.equal(fixed.error, ''); assert.equal(fixed.svcAmt, 15000);
  assert.equal(RF.settle(base, { visits: [] }).error, '', '기록이 없으면 차단 없음');
});
