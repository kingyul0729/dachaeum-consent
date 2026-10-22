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

test('가격 데이터: 얼굴 전체 CO₂ 추가옵션 4개 프로그램 1회·110,000원 명시, 턱밑라인은 정상가 확인 필요 유지', () => {
  const d = require('../data/programs.json');
  const adds = d.programs.flatMap(p => (p.adds || []).filter(a => a.id === 'pig-co2-fullface').map(a => [p.id, a.price, a.qty, a.unitPrice, a.settleUnit]));
  assert.deepEqual(adds, ['PGM-0004', 'PGM-0006', 'PGM-0008', 'PGM-0010'].map(id => [id, '110000', '1', '110000', '110000']));
  for (const id of ['PGM-0037', 'PGM-0106']) {
    const it = d.programs.find(p => p.id === id).items[0];
    assert.deepEqual([it.unitPrice, it.settleUnit, it.priceState], ['', '', '정상가 확인 필요'], id);
  }
});

test('PGM-0041 흑자 1cm 1개(330,000원): 시작 전 297,000원, 시작 후 병변 금액 전액 차감 → 0원', () => {
  const C = { total: 330000, paid: 330000, items: [{ kind: '시술', lesionUnit: true, qty: 5, price: 330000 }] };
  assert.equal(RF.refund(C, [0]).refundNum, 297000);                         // 330,000 − 33,000
  assert.equal(RF.refund(C, [1]).usedAmt, 330000);                            // 1회 시작 = 병변 금액 전액 (66,000 아님)
  assert.equal(RF.refund(C, [1]).refundNum, 0);                               // 330,000 − 33,000 − 330,000 < 0 → 0
  const d = require('../data/programs.json').programs.find(x => x.id === 'PGM-0041');
  assert.equal(d.total, '330000');
  assert.deepEqual(d.lesionTiers.map(t => t.price), [330000, 440000, 550000]);
});

test('인모드 FX 3회: 정상 440,000 / 리프팅 1년 혜택가 330,000 — 혜택가에 지인 소개·재티켓팅 추가 할인 불가, 선결제권은 정상가 440,000 기준', () => {
  const all = require('../data/programs.json').programs;
  const run = (id, disc, preTier = '') => { const cur = all.find(p => p.id === id);
    return PR.discount({ cur, held: false, hairParts: [], hairRate: 0, listNum: Number(cur.total), optAddSum: 0, all, disc, preTier }); };
  assert.equal(run('PGM-0085', 'none').totalNum, 440000);
  assert.equal(run('PGM-0085B', 'none').totalNum, 330000);
  for (const [t, v] of [['300', 396000], ['400', 374000], ['500', 352000]]) {
    assert.equal(run('PGM-0085', 'pre', t).totalNum, v);
    assert.equal(run('PGM-0085B', 'pre', t).totalNum, v, '혜택가에 추가 할인하지 않고 정상가 기준');
  }
  assert.deepEqual(run('PGM-0085B', 'none').allowed, ['none', 'pre'], '혜택가: 지인 소개·재티켓팅 선택지 없음');
  assert.equal(run('PGM-0085B', 'ref').totalNum, 330000, '313,500 아님');
  assert.equal(run('PGM-0085B', 'ret').totalNum, 330000, '297,000 아님');
  assert.equal(run('PGM-0085', 'ref').totalNum, 418000, '정상 3회의 지인 소개 5%는 그대로');
});

test('가격 관리 기록: 총 등록금액만 기록·제거, 다른 변경 기록은 유지, 원본 기록 객체는 바뀌지 않음', () => {
  require('../src/catalog.js'); const CT = globalThis.DachaeumCatalog;
  const base = { version: 'v1', programs: [{ id: 'A', total: '100' }, { id: 'B', total: '200', name: 'b' }], events: [] };
  const ov0 = { programs: { B: { name: 'b2', total: '250' } }, added: [{ id: 'X', total: '9' }], deleted: [], events: {}, keep: 1 };
  const snap = JSON.stringify(ov0);
  const ov1 = CT.setProgramTotal(ov0, 'A', 150, '2026-10-01 10:00');
  assert.equal(JSON.stringify(ov0), snap);
  assert.deepEqual(CT.applyOverride(base, ov1).programs.map(p => [p.id, p.total]), [['A', '150'], ['B', '250'], ['X', '9']]);
  const ov2 = CT.clearProgramTotal(ov1, 'A', 't'), ov3 = CT.clearProgramTotal(ov2, 'B', 't');
  assert.equal(ov2.programs.A, undefined);
  assert.deepEqual(ov3.programs.B, { name: 'b2' }, '총 등록금액만 제거, 다른 변경은 유지');
  assert.deepEqual([ov3.added, ov3.keep], [[{ id: 'X', total: '9' }], 1]);
  assert.deepEqual(CT.applyOverride(base, ov3).programs.map(p => p.total), ['100', '200', '9']);
  assert.deepEqual(CT.setProgramTotal(null, 'A', 120).programs, { A: { total: '120' } });
});

test('1회 정상가 기록: 총 등록금액 기록과 별도, 해당 시술만 반영·제거', () => {
  const CT = globalThis.DachaeumCatalog;
  const base = { version: 'v1', programs: [{ id: 'A', total: '1000', items: [{ id: 'x', unitPrice: '100', settleUnit: '100', listPrice: '100' }, { id: 'y', unitPrice: '200', settleUnit: '200' }] }], events: [] };
  const ov = CT.setProgramTotal(null, 'A', 1500);
  const uo = CT.setUnit(null, 'A', 'x', 150, '2026-10-01 11:00');
  const d = CT.applyUnits(CT.applyOverride(base, ov), uo);
  assert.equal(d.programs[0].total, '1500');
  assert.deepEqual(d.programs[0].items.map(i => [i.unitPrice, i.settleUnit]), [['150', '150'], ['200', '200']]);
  assert.equal(base.programs[0].items[0].unitPrice, '100', '원본 가격 데이터는 그대로');
  assert.deepEqual(CT.applyUnits(CT.applyOverride(base, null), uo).programs[0].total, '1000', '1회 정상가 변경이 총 등록금액을 바꾸지 않음');
  assert.deepEqual(CT.applyUnits(CT.applyOverride(base, ov), null).programs[0].items[0].settleUnit, '100', '총 등록금액 변경이 1회 정상가를 바꾸지 않음');
  const uo2 = CT.clearUnit(uo, 'A', 'x', 't');
  assert.deepEqual(uo2.items, {});
  assert.equal(CT.applyUnits(base, uo2).programs[0].items[0].settleUnit, '100');
  assert.match(d.version, /정상가 변경 2026-10-01 11:00/);
});

test('공통 시술 판정: 시술 ID가 시술 DB에 있고 모든 프로그램의 1회 정상가가 같을 때만 공통, 기준이 다르거나 정상가 없는 항목은 제외', () => {
  const CT = globalThis.DachaeumCatalog, d = require('../data/programs.json');
  const c = CT.commonUnits(d);
  assert.deepEqual(c['pig-revlite'], { price: 198000, programs: 11 });
  assert.equal(c['scar-picofraxel-regen-full'], undefined, '시술 DB 440,000 ≠ 프로그램 275,000');
  assert.equal(c['hair-m-chinline'], undefined, '정상가 확인 필요');
  assert.equal(c['PART_LT_PT'], undefined, '조건별 금액');
  assert.equal(c['scar-simple-calm'], undefined, '시술 DB에 없는 ID');
  const uo = CT.setProcUnit(null, 'pig-revlite', 250000);
  const out = CT.applyUnits(d, uo);
  const rev = out.programs.flatMap(p => p.items.filter(i => i.id === 'pig-revlite'));
  assert.equal(rev.length, 11); assert.ok(rev.every(i => i.settleUnit === '250000' && i.unitPrice === '250000'));
  assert.deepEqual(out.programs.map(p => p.total), d.programs.map(p => p.total), '총 등록금액은 그대로');
  // 공통 시술은 프로그램별 키로 바꿀 수 없고, 프로그램별 항목은 공통 키로 바뀌지 않음
  assert.equal(CT.applyUnits(d, CT.setUnit(null, 'PGM-0001', 'pig-revlite', 1)).programs.find(p => p.id === 'PGM-0001').items[1].settleUnit, '198000');
  assert.ok(CT.applyUnits(d, CT.setProcUnit(null, 'scar-picofraxel-regen-full', 1)).programs.filter(p => p.items.some(i => i.id === 'scar-picofraxel-regen-full'))
    .every(p => p.items.find(i => i.id === 'scar-picofraxel-regen-full').settleUnit === '275000'));
});

// ---- 프로그램 이름 · 이벤트 · 할인 설정 ----
const DB = () => require('../data/programs.json');
const disc = (cur, all, o = {}) => PR.discount({ cur, held: false, hairParts: [], hairRate: 0, listNum: Number(cur.total), optAddSum: 0, all, ...o });

test('프로그램 이름 변경: ID·baseName 유지, 이름 규칙(리프팅 혜택가 정상가 연결·제모 결합)과 금액 그대로', () => {
  require('../src/catalog.js'); const CT = globalThis.DachaeumCatalog;
  let ov = CT.setProgramField(null, 'PGM-0085', 'name', '인모드 FX 정상 3회 (이름 변경)');
  ov = CT.setProgramField(ov, 'PGM-0085B', 'name', '인모드 혜택가 3회');
  ov = CT.setProgramField(ov, 'PGM-0037', 'name', '남성 턱 제모 5회');
  const d = CT.applyOverride(DB(), ov), all = d.programs, P = id => all.find(p => p.id === id);
  assert.equal(P('PGM-0085B').name, '인모드 혜택가 3회');
  assert.equal(P('PGM-0085B').baseName, '인모드 FX 3회 (리프팅 적용가)');
  assert.equal(all.filter(p => /PGM-0085/.test(p.id)).length, 3, '새 프로그램이 생기지 않음');
  assert.equal(disc(P('PGM-0085B'), all).totalNum, 330000);
  for (const [t, v] of [['300', 396000], ['400', 374000], ['500', 352000]])
    assert.equal(disc(P('PGM-0085B'), all, { disc: 'pre', preTier: t }).totalNum, v, '이름을 바꿔도 정상가 440,000 기준 연결 유지');
  assert.equal(PR.hairFixed(P('PGM-0037')), true, '제모 지정 결합상품 판정 유지');
  assert.equal(P('PGM-0085').total, '440000');
  // 이름 기록 제거 → 원래 이름, 다른 기록(총 등록금액)은 유지
  const ov2 = CT.clearProgramField(CT.setProgramTotal(ov, 'PGM-0085', 450000), 'PGM-0085', 'name');
  assert.deepEqual(ov2.programs['PGM-0085'], { total: '450000' });
});

test('이벤트: 정액 적용가·할인율 이벤트 모두 다른 할인과 중복 없음, 할인율 이벤트는 직원 선택 시에만, 기간·사용 여부 반영', () => {
  const CT = globalThis.DachaeumCatalog, today = '2026-10-02';
  const base = DB(), nb2 = base.programs.find(p => p.id === 'PGM-EV-NB2'), ev = base.events.find(e => e.id === 'EV-NEWBIJOU');
  assert.deepEqual(disc(nb2, base.programs, { evDef: ev }).allowed, ['none'], '이벤트 적용가에 추가 할인 불가');
  assert.equal(disc(nb2, base.programs, { evDef: { ...ev, stack: { pre: true } }, disc: 'pre', preTier: '300' }).totalNum, 275000, '예전 중복 설정값이 남아 있어도 무시');
  let eo = CT.addRateEvent(null, { id: 'EV-R-T', name: '가을 이벤트', rate: 0.1, start: '2026-10-01', end: '2026-10-31', active: true, programs: ['PGM-0001'] });
  let d = CT.applyEventOv(base, eo);
  const p1 = d.programs.find(p => p.id === 'PGM-0001');
  const rev = CT.rateEventsFor(d, 'PGM-0001', today);
  const r0 = disc(p1, d.programs, { rateEvents: rev });
  assert.deepEqual(r0.options.map(o => o.label), ['일반', '지인 소개 5%', '재티켓팅 10%', '선결제권', '가을 이벤트 10%']);
  assert.equal(r0.totalNum, 1320000, '선택하지 않으면 자동 적용 안 됨');
  const r1 = disc(p1, d.programs, { rateEvents: rev, disc: 'ev:EV-R-T' });
  assert.deepEqual([r1.totalNum, r1.discLabel, r1.eventId, r1.discKey], [1188000, '가을 이벤트 10%', 'EV-R-T', 'ev:EV-R-T'], '이벤트 하나만 적용');
  assert.equal(CT.rateEventsFor(d, 'PGM-0001', '2026-11-01').length, 0, '기간 밖');
  eo = CT.setEvent(eo, 'EV-R-T', { active: false });
  assert.equal(CT.rateEventsFor(CT.applyEventOv(base, eo), 'PGM-0001', today).length, 0, '사용 중지');
  assert.deepEqual(disc(nb2, base.programs, { evDef: ev, rateEvents: rev }).allowed, ['none']);
  const eo2 = CT.setEvent(null, 'EV-NEWBIJOU', { name: '뉴비쥬 가을 앵콜', end: '2026-12-31', stack: { pre: true } });
  const e2 = CT.applyEventOv(base, eo2).events.find(e => e.id === 'EV-NEWBIJOU');
  assert.deepEqual([e2.name, e2.kind, e2.validMonths, e2.end, e2.stack], ['뉴비쥬 가을 앵콜', 'package', 3, '2026-12-31', undefined], '중복 설정은 저장하지 않음');
});

test('이벤트 적용가(총 등록금액) 변경은 환불용 1회 정상가를 바꾸지 않음', () => {
  const CT = globalThis.DachaeumCatalog, base = DB();
  const d = CT.applyOverride(base, CT.setProgramTotal(null, 'PGM-EV-NB2', 200000));
  const nb2 = d.programs.find(p => p.id === 'PGM-EV-NB2'), b = base.programs.find(p => p.id === 'PGM-EV-NB2');
  assert.equal(nb2.total, '200000');
  assert.deepEqual(nb2.items.map(i => [i.id, i.settleUnit, i.unitPrice]), b.items.map(i => [i.id, i.settleUnit, i.unitPrice]));
});

test('선결제권 사용 계약 환불: 사용분 891,000 전액 → 시술 전 801,900 (잔액 복원), 예약금만 납부 → 0원', () => {
  const items = [{ kind: '시술', name: 'A', qty: 4, price: 220000 }];
  const pre = { total: 891000, paid: 891000, items, payments: [{ method: '선결제권 (신규 구매 300)', amount: 891000, prepaid: true, newPurchase: true }] };
  const r = RF.settle(pre, { used: [0] });
  assert.deepEqual([r.penNum, r.usedAmt, r.refundNum, r.amounts[0], r.allocOk], [89100, 0, 801900, 801900, true]);
  assert.equal(r.pays.length, 1, '프로그램에 쓰지 않은 선결제권 잔액은 정산에 포함되지 않음');
  const depOnly = { total: 891000, paid: 89100, items, payments: [{ method: '카드', amount: 89100 }] };
  assert.equal(RF.settle(depOnly, { used: [0] }).refundNum, 0, '89,100 − 89,100 − 0');
  // 잔액 일부 + 카드: 수단별 입력 합계 = 최종 환불금액, 수단별 한도 초과 불가
  const mix = { total: 891000, paid: 891000, items, payments: [{ method: '카드', amount: 591000 }, { method: '선결제권 잔액', amount: 300000, prepaid: true }] };
  assert.equal(RF.settle(mix, { used: [0], alloc: { 0: '591,000', 1: '210,900' } }).allocOk, true);
  assert.equal(RF.settle(mix, { used: [0], alloc: { 0: '501,900', 1: '300,000' } }).allocOk, true);
  assert.equal(RF.settle(mix, { used: [0], alloc: { 0: '401,900', 1: '400,000' } }).allocOver, true);
  assert.equal(RF.settle(mix, { used: [0] }).allocOk, false, '자동 배분 없음');
});

test('예약금 계산: 목표 = 계약 총액 10%, 이미 납부·사용한 금액을 빼고 남은 미납금액을 넘지 않음', () => {
  const r1 = PR.payment({ totalNum: 891000, preBal: 0, priorDep: 50000, deposit: true });
  assert.deepEqual([r1.depTarget, r1.depAmt, r1.paid, r1.needNum], [89100, 39100, 89100, 841000], '기납부 50,000 → 오늘 39,100, 총 89,100 (139,100 아님)');
  const r2 = PR.payment({ totalNum: 3300000, preBal: 3000000, priorDep: 0, deposit: true });
  assert.deepEqual([r2.depTarget, r2.depAmt, r2.needNum, r2.paid], [330000, 0, 300000, 3000000], '선결제권 사용 3,000,000 ≥ 목표 → 추가 예약금 0, 미수금 300,000');
  const r3 = PR.payment({ totalNum: 891000, preBal: 0, priorDep: 0, deposit: true });
  assert.deepEqual([r3.depAmt, r3.paid], [89100, 89100], '일반 예약금은 그대로');
  const r4 = PR.payment({ totalNum: 100000, preBal: 0, priorDep: 95000, deposit: true });
  assert.equal(r4.depAmt, 0, '남은 미납금액 5,000이 있어도 목표 10,000 이미 충족');
});

test('리프팅 후 혜택가 7개(인모드 FX + 스킨부스터 리프팅 할인가 6개): 지인 소개·재티켓팅·할인율 이벤트 선택 불가, 혜택가 그대로 / 선결제권은 정상가 기준', () => {
  const all = require('../data/programs.json').programs;
  const ids = all.filter(p => PR.isYearSkinBooster(p)).map(p => p.id).sort();
  assert.deepEqual(ids, ['PGM-0085B', 'PGM-SB-1D1', 'PGM-SB-1D3', 'PGM-SB-2D1', 'PGM-SB-2D3', 'PGM-SB-3D1', 'PGM-SB-3D3']);
  for (const id of ids) {
    const cur = all.find(p => p.id === id), price = Number(cur.total);
    const ev = [{ id: 'EV-R-X', kind: 'rate', name: '가을 이벤트', rate: 0.1, programs: [id] }];
    const run = disc => PR.discount({ cur, held: false, hairParts: [], hairRate: 0, listNum: price, optAddSum: 0, all, disc, preTier: '300', rateEvents: ev });
    assert.deepEqual(run('none').allowed, ['none', 'pre'], id + ': 혜택가 / 선결제권만');
    for (const k of ['ref', 'ret', 'ev:EV-R-X']) {
      const r = run(k);
      assert.deepEqual([r.discKey, r.totalNum, r.eventId], ['none', price, null], id + ' + ' + k + ' → 추가 할인 없음');
    }
    const normal = PR.findNormalOf(cur, all);
    assert.ok(normal && !PR.isYearSkinBooster(normal), id + ': 정상가 상품 연결');
    assert.equal(run('pre').totalNum, Math.round(Number(normal.total) * 0.9), id + ': 선결제권 300은 정상가 기준');
  }
});

test('정상가 프로그램: 할인율 이벤트는 직원 선택 시에만, 선택하면 이벤트 하나만 (지인 소개·재티켓팅·선결제권과 중복 없음) / 정액 이벤트 프로그램은 다른 할인 불가', () => {
  const all = require('../data/programs.json').programs;
  const cur = all.find(p => p.id === 'PGM-0085'), ev = [{ id: 'EV-R-X', kind: 'rate', name: '가을 이벤트', rate: 0.2, programs: ['PGM-0085'] }];
  const run = (disc, c = cur, list = Number(cur.total)) => PR.discount({ cur: c, held: false, hairParts: [], hairRate: 0, listNum: list, optAddSum: 0, all, disc, preTier: '300', rateEvents: ev });
  assert.deepEqual(run('none').allowed, ['none', 'ref', 'ret', 'pre', 'ev:EV-R-X']);
  assert.equal(run('none').totalNum, 440000, '자동 적용 없음');
  const e = run('ev:EV-R-X');
  assert.deepEqual([e.discKey, e.discRate, e.totalNum, e.preTier], ['ev:EV-R-X', 0.2, 352000, ''], '이벤트만 적용, 선결제권 등급 무시');
  assert.equal(run('ref').totalNum, 418000); assert.equal(run('pre').totalNum, 396000);
  const evProg = all.find(p => p.event);
  const pk = run('ref', evProg, Number(evProg.total));
  assert.deepEqual([pk.allowed, pk.discKey, pk.totalNum], [['none'], 'none', Number(evProg.total)], '정액 이벤트 프로그램: 다른 할인 불가');
});
