// 화면 흐름 테스트 (빌드된 index.html을 Chromium으로 실행)
// 계약 생성 → 이용·환불 정산 → 환불 정산서 서명(=환불완료), 잔금 결제, 재서명, 계약 간 기록 분리
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '..', process.env.APP_FILE || 'index.html');
let browser;
test.before(async () => { browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); });
test.after(async () => { await browser.close(); });

async function open(seed, opt = {}) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.errors = []; p.dialogs = []; p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => { p.dialogs.push(d.message()); if (opt.handle) return opt.handle(d); d.accept(opt.answer ? opt.answer(d) : undefined); });
  await p.goto(URL);
  await p.evaluate(([c, extra]) => { localStorage.clear(); if (c) localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(c));
    Object.entries(extra || {}).forEach(([k, v]) => localStorage.setItem(k, v)); }, [seed || null, opt.storage || null]);
  await p.reload(); await p.waitForTimeout(2000);
  return p;
}
const click = async (p, t, i = 0) => { await p.getByText(t, { exact: true }).nth(i).click(); await p.waitForTimeout(350); };
const body = p => p.innerText('body');
const finalRefund = async p => (await body(p)).match(/최종 환불금액\s*([\d,]+)/)[1];
const contracts = p => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.v3.contracts') || '[]'));
const docs = p => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.v3.docs') || '[]'));
async function sign(p) {
  await click(p, '터치하여 서명');
  const bb = await p.locator('canvas').first().boundingBox();
  await p.mouse.move(bb.x + 30, bb.y + 40); await p.mouse.down();
  await p.mouse.move(bb.x + 150, bb.y + 20, { steps: 6 }); await p.mouse.move(bb.x + 250, bb.y + 60, { steps: 6 }); await p.mouse.up();
  await click(p, '서명 완료');
}
const allocInputs = p => p.locator('xpath=//*[contains(text(),"원결제")]/ancestor::div[2]//input');

const mk = (id, program, o = {}) => ({ id, docMode: 'full', termsVer: 'T-2026-09',
  patient: { name: '김테스트', birth: '900101', phone: '010-0000-0000' }, program, cat: '스킨부스터', date: '2026-09-01', expiry: '2027-08-31',
  total: 1000000, paid: 1000000, pay: 'full', method: '카드 + 현금', priorDep: 300000, preBal: 0,
  payments: [{ method: '카드', amount: 400000 }, { method: '현금', amount: 300000 }],
  items: [{ kind: '시술', name: '리쥬란 A', qty: 4, price: 200000 }, { kind: '서비스', name: '진정관리', qty: 2, price: 50000 }], used: null, visits: [], ...o });

test('새 계약: 계약 당시 값·상태·서비스 단가 저장, 동의서 A4 1장, 계약 id로 문서 연결', async () => {
  const p = await open();
  await click(p, '새 동의서 작성');
  const ins = p.locator('input');
  await ins.nth(0).fill('신규환자'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '스킨부스터'); await click(p, '정상가'); await click(p, '3회');
  await click(p, '다음 단계'); await click(p, '카드');
  assert.match(await body(p), /330,000원을 결제할게요/);
  await click(p, '동의서 미리보기 · 서명'); await p.waitForTimeout(400);
  await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await p.getByText('동의하고 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const [c] = await contracts(p);
  assert.equal(c.status, '등록완료'); assert.equal(c.total, 330000); assert.equal(c.paid, 330000);
  assert.deepEqual(c.items.map(i => [i.name, i.qty, i.price]), [['인모드 FX', 3, 165000]]);
  assert.ok(c.svcPrices && c.svcPrices.acne.some(r => r.range === '14일 미만' && r.price === 15000));
  const d = await docs(p);
  assert.equal(d.length, 1); assert.equal(d[0].contractId, c.id); assert.match(d[0].html, /data-onepage="1"/);
  assert.match(d[0].html.replace(/<[^>]+>/g, ''), /실제 납부금액 − 위약금 10%/);
  // 재서명: 화면 구성이 계약과 같으면 허용 → 이전 버전 보존 + 새 버전
  await p.getByText(/재서명/).first().click(); await p.waitForTimeout(400);
  await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await click(p, '동의하고 저장'); await p.waitForTimeout(600);
  assert.deepEqual((await docs(p)).map(x => [x.version, !!x.superseded]), [[1, true], [2, false]]);
  // 새로고침 후에는 화면 구성이 없으므로 재서명 차단
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '신규환자'); await click(p, '문서');
  await p.getByText(/재서명/).first().click(); await p.waitForTimeout(300);
  assert.match(await body(p), /재서명할 수 없습니다/);
  assert.deepEqual(p.errors, []);
});

test('환불: 계약 간 기록 분리 → 작성 중 저장·복원 → 서명 시 환불완료, 계산 내역 보관', async () => {
  const p = await open([mk('CT1', '프로그램 A'), mk('CT2', '프로그램 B')]);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '700,000');
  await allocInputs(p).nth(0).fill('400000'); await p.waitForTimeout(500);
  await p.mouse.click(38, 32); await p.waitForTimeout(300);          // 뒤로가기(취소 버튼 없이 나감)
  await click(p, '프로그램 B'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '900,000', 'B에 A의 이용 기록이 섞이면 안 됨');
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '700,000', '작성 중 정산 복원');
  assert.equal(await allocInputs(p).nth(0).inputValue(), '400,000');
  await click(p, '정산서 생성 · 환자 서명');
  assert.match(await body(p), /일치해야|더 배분/, '합계 불일치면 서명 화면으로 못 넘어감');
  await allocInputs(p).nth(1).fill('300000'); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명'); await sign(p);
  await p.getByText('서명 완료 · 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(800);
  const [a, b] = await contracts(p);
  assert.equal(a.status, '환불완료'); assert.equal(a.refunded, true);
  assert.equal(a.refund.penNum, 100000); assert.equal(a.refund.usedAmt, 200000); assert.equal(a.refund.refundNum, 700000);
  assert.deepEqual(a.refund.pays.map(x => [x.method, x.refund]), [['카드', 400000], ['현금', 300000], ['기납부 예약금', 0]]);
  assert.equal(a.total, 1000000); assert.equal(a.items.length, 2, '원 계약 정보 보존');
  assert.equal(b.status || '등록완료', '등록완료');
  assert.equal((await docs(p)).filter(d => d.kind === '환불정산서').length, 1, '더블클릭해도 1건');
  assert.ok(!/환불 정산\n|환불 처리 완료/.test(await body(p)), '환불완료 후 정산 버튼 없음');
  assert.deepEqual(p.errors, []);
});

test('이전 버전 상태값 정리: 중간 상태는 등록완료, 서명 기록이 있으면 환불완료', async () => {
  const p = await open([mk('CT1', '프로그램 A', { status: '환불정산중' }), mk('CT2', '프로그램 B', { status: '환불처리대기', refund: { refundNum: 1 } })]);
  assert.equal(((await body(p)).match(/환불완료/g) || []).length, 1);
  await click(p, '프로그램 A');
  assert.match(await body(p), /환불 정산/);
});

test('잔금 결제: 실제 납부액·결제내역 누적, 초과 차단, 완납 전환, 환불은 전체 납부내역 기준', async () => {
  const dep = { total: 1000000, paid: 100000, pay: 'deposit', method: '카드', priorDep: 0, items: [{ kind: '시술', name: '리쥬란 A', qty: 5, price: 200000 }],
    payments: [{ method: '카드', amount: 100000, bank: '신한', cardNo: '1234', payDate: '2026-09-01', approval: '12345678' }] };
  const p = await open([mk('CT1', '프로그램 A', dep), mk('CT2', '프로그램 B', { ...dep, payments: undefined })]);
  await click(p, '프로그램 A'); await p.getByText('프로그램 A').last().click(); await p.waitForTimeout(300);
  const card = p.locator('xpath=//div[text()="잔금 결제"]/ancestor::div[2]');
  assert.match(await body(p), /남은 잔금 900,000원/);
  await card.getByText('현금', { exact: true }).click();
  const amt = card.locator('input[type=text]');
  await amt.fill('950000'); await click(p, '잔금 결제 기록');
  assert.match(await body(p), /보다 많이 기록할 수 없습니다/);
  await amt.fill('500000'); await click(p, '잔금 결제 기록'); await p.waitForTimeout(1700);
  assert.match(await body(p), /일부 납부 \(잔금 400,000원 미납\)/);
  await card.getByText('카드', { exact: true }).click(); await click(p, '잔금 결제 기록'); await p.waitForTimeout(400);
  let [c] = await contracts(p);
  assert.equal(c.paid, 1000000); assert.equal(c.total, 1000000); assert.equal(c.pay, 'full');
  assert.deepEqual(c.payments.map(x => [x.method, x.amount, !!x.balance]), [['카드', 100000, false], ['현금', 500000, true], ['카드', 400000, true]]);
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '900,000');
  assert.deepEqual((await body(p)).match(/원결제 [\d,]+원/g), ['원결제 100,000원', '원결제 500,000원', '원결제 400,000원']);
  assert.deepEqual(p.errors, []);
});

test('새 동의서 작성: 이전 환자의 기납부 예약금·결제수단이 다음 환자에게 남지 않음', async () => {
  const p = await open();
  const start = async name => {
    await click(p, '새 동의서 작성'); const ins = p.locator('input');
    await ins.nth(0).fill(name); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
    await click(p, '다음 단계'); await click(p, '스킨부스터'); await click(p, '정상가'); await click(p, '3회'); await click(p, '다음 단계');
  };
  await start('환자A');
  const dep = p.locator('xpath=//span[text()="기납부 예약금"]/following-sibling::span//input');
  await dep.fill('100000'); await click(p, '현금');
  assert.match(await body(p), /230,000원을 결제할게요/);
  await p.mouse.click(38, 32); await p.waitForTimeout(300);
  await start('환자B');
  assert.match(await body(p), /330,000원을 결제할게요/);
  assert.equal(await dep.inputValue(), '');
  assert.deepEqual(p.errors, []);
});

test('결제 정보 수정 중에는 잔금 결제 기록 차단 (수정본 저장 시 잔금 기록 유실 방지)', async () => {
  const p = await open([mk('CT1', '프로그램 A', { total: 1000000, paid: 100000, pay: 'deposit', priorDep: 0, payments: [{ method: '카드', amount: 100000, payDate: '2026-09-01' }] })]);
  await click(p, '프로그램 A'); await p.getByText('프로그램 A').last().click(); await p.waitForTimeout(300);
  await p.locator('select').first().selectOption('신한');
  const card = p.locator('xpath=//div[text()="잔금 결제"]/ancestor::div[2]');
  await card.getByText('현금', { exact: true }).click(); await click(p, '잔금 결제 기록');
  assert.match(await body(p), /결제 정보 수정 중입니다/);
  assert.equal((await contracts(p))[0].paid, 100000);
});

test('환불 정산 입력 직후 바로 새로고침해도 작성 중 값 유지', async () => {
  const p = await open([mk('CT1', '프로그램 A')]);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click();
  await p.reload(); await p.waitForTimeout(2000);
  assert.deepEqual((await contracts(p))[0].refundDraft.used, [1, 0]);
});

const pickProgram = async (p, id, label) => {
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill('정상가테스트'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill(id); await p.waitForTimeout(300);
  await click(p, label); await click(p, '다음 단계'); await click(p, '카드');
};
const signAndSave = async p => {
  await click(p, '동의서 미리보기 · 서명'); await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await click(p, '동의하고 저장'); await p.waitForTimeout(700);
};

test('PGM-0037 남성 턱밑라인: 환불용 1회 정상가 입력 전 서명 불가 → 입력값 계약 저장 → 환불 차감', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  assert.match(await body(p), /환불용 1회 정상가 확인 필요/);
  await click(p, '동의서 미리보기 · 서명');
  assert.match(await body(p), /환불용 1회 정상가를 입력해 주세요/);
  assert.doesNotMatch(await body(p), /터치하여 서명/);
  await p.locator('input[placeholder="1회 정상가"]').fill('132000');          // 테스트용 임의 값
  await signAndSave(p);
  const [c] = await contracts(p);
  assert.equal(c.total, 660000);
  assert.deepEqual(c.items.map(i => [i.name, i.qty, i.price, !!i.unitInput]), [['남성 턱밑라인 포함 제모', 5, 132000, true]]);
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '남성 턱밑라인 포함 제모 5회'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '330,000');                               // 660,000 − 66,000 − 2 × 132,000
  assert.deepEqual(p.errors, []);
});

test('얼굴 전체 CO₂ 제거 추가옵션: 가격 데이터의 1회·110,000원으로 계약 저장, 점 CO₂(병변별)와 별도 차감', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0004', '스페셜 토닝 3');
  assert.doesNotMatch(await body(p), /환불용 1회 정상가 확인 필요/, '가격 데이터에 정상가가 있으므로 입력 요구 없음');
  await signAndSave(p);
  const [c] = await contracts(p);
  const k = c.items.findIndex(i => i.name === '얼굴 전체 CO₂ 제거');
  assert.deepEqual([c.items[k].kind, c.items[k].qty, c.items[k].price, !!c.items[k].unitInput, !!c.items[k].actual], ['추가', 1, 110000, false, false]);
  assert.ok(c.items.some(i => i.name === '얼굴 점 CO₂ 제거' && i.actual), '점 CO₂는 병변별 입력 항목으로 유지');
  assert.match((await docs(p))[0].html.replace(/<[^>]+>/g, ' '), /얼굴 전체 CO₂ 제거\s+1회/);
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 3'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '1,485,000');
  await p.getByText('+', { exact: true }).nth(k).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '1,375,000');                             // − 110,000
});

test('기존 계약 정상가 누락: 이용 기록이 있을 때만 확정 차단, 근거 보완 시 별도 기록·원 항목 유지', async () => {
  const seed = [mk('CT1', '턱밑 계약', { total: 660000, paid: 660000, priorDep: 0, payments: [{ method: '카드', amount: 660000 }],
    items: [{ kind: '시술', name: '남성 턱밑라인 포함 제모', qty: 5, price: 0 }] })];
  const p = await open(seed, { answer: d => d.type() !== 'prompt' ? undefined : /근거/.test(d.message()) && !/정상가\(원\)/.test(d.message()) ? '2026-03-02 서명 동의서' : '132000' });
  await click(p, '턱밑 계약'); await click(p, '환불 정산');
  assert.doesNotMatch(await body(p), /정상가 확인 필요 · 환불 확정 불가/, '이용 전에는 차단 안 함');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/);
  assert.doesNotMatch(await body(p), /594,000/, '0원 차감 금액을 최종 환불금액으로 보여주지 않음');
  assert.match(await body(p), /정상가 확인 후 계산할 수 있어요/);
  await click(p, '정산서 생성 · 환자 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '확정(서명) 단계로 넘어가지 않음');
  await click(p, '근거 확인 후 보완'); await p.waitForTimeout(400);
  const [c] = await contracts(p);
  assert.equal(c.items[0].price, 0, '원 계약 항목은 바뀌지 않음');
  assert.deepEqual(c.priceFixes.map(f => [f.key, f.price, f.basis]), [['item:0', 132000, '2026-03-02 서명 동의서']]);
  assert.ok(c.priceFixes[0].at);
  assert.equal(await finalRefund(p), '462,000');                               // 660,000 − 66,000 − 132,000
  assert.match(await body(p), /정상가 보완 기록/);
});

test('이전 계약(계약 당시 서비스 단가 없음): 현재 가격표 자동 적용 안 함, 기록하면 확정 차단', async () => {
  const p = await open([mk('CT1', '이전 계약')]);                             // svcPrices 없음
  await click(p, '이전 계약'); await click(p, '환불 정산');
  assert.match(await body(p), /단가 확인 필요/);
  assert.doesNotMatch(await body(p), /14일 미만\s*15,000/);
  assert.doesNotMatch(await body(p), /정상가 확인 필요 · 환불 확정 불가/, '기록 전에는 차단 없음');
  await p.locator('[title="기록 추가"]').nth(1).click(); await p.waitForTimeout(300);   // 약처방 기록 1건
  assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/);
  assert.match(await body(p), /정상가 확인 후 계산할 수 있어요/);
  await click(p, '정산서 생성 · 환자 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/);
});

test('서명 기록 삭제 차단: 문서 삭제 버튼·환자 삭제 버튼 없음', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  await p.locator('input[placeholder="1회 정상가"]').fill('132000');
  await signAndSave(p);
  assert.equal(await p.locator('[title="문서 삭제"]').count(), 0);
  await click(p, '계약 정보');
  assert.equal(await p.getByText('삭제', { exact: true }).count(), 0);
  assert.equal((await docs(p)).length, 1);
});

test('예약금 결제 표시: (10%) 문구 없음, 계산은 그대로', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  await click(p, '예약금 결제');
  const t = await body(p);
  assert.doesNotMatch(t, /예약금 결제 \(10%\)|예약금 \(10%\)/);
  assert.match(t, /66,000원을 결제할게요/);
});

test('백업·복원: 암호화 파일 → 다른 기기(새 환경)에서 복원 후 계약·문서·금액·상태 동일, 다른 앱 자료 유지', async () => {
  const fs = require('node:fs');
  const seed = [mk('CT1', '프로그램 A', { status: '환불완료', refunded: true, refund: { refundNum: 700000, penNum: 100000, usedAmt: 200000, pays: [{ method: '카드', refund: 400000 }] } }),
    mk('CT2', '프로그램 B', { refundDraft: { used: [1, 0], alloc: { 0: '400,000' } }, priceFixes: [{ key: 'item:0', price: 1000, basis: 't' }] })];
  const src = await open(seed, { storage: { 'dachaeum.v3.docs': JSON.stringify([{ id: 'D1', contractId: 'CT1', kind: '이용동의서', version: 1, signedAt: '2026-09-01', html: '<div>서명 문서</div>' }]),
    'dachaeum.priceOverride': JSON.stringify({ programs: { 'PGM-0001': { total: '1' } } }), 'inventory-system:v1': 'SRC-INVENTORY' } });
  const original = await src.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · dachaeum-backup-/).click()]);
  const afterExport = await src.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(afterExport, original, '백업 후 기존 자료 그대로');
  assert.ok(await src.evaluate(() => localStorage.getItem('dachaeum.v3.lastBackup')), '저장 후 마지막 백업 시각 기록');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /김테스트|서명 문서|프로그램 A/, '파일 안에 환자정보·문서가 평문으로 없음');
  const file = JSON.parse(text);
  assert.equal(file.format, 'dachaeum-consent-backup'); assert.equal(file.counts.contracts, 2);

  // 새 환경: 이미 다른 자료가 있는 기기 + 재고관리 자료
  const dst = await open([mk('X9', '기존 기기 계약')], { storage: { 'inventory-system:v1': 'DST-INVENTORY' }, answer: () => undefined });
  const restoreWith = async (pw, buf) => {
    await click(dst, '백업 · 복원');
    await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill(pw);
    await dst.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(buf) });
    await dst.waitForTimeout(2500);
  };
  await restoreWith('wrong-pass', text);
  assert.match(await body(dst), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  assert.equal((await contracts(dst))[0].id, 'X9', '실패 시 기존 자료 그대로');
  const tampered = JSON.stringify({ ...file, data: file.data.slice(0, -8) + 'AAAAAAAA' });
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(tampered) });
  await dst.waitForTimeout(2500);
  assert.match(await body(dst), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'other' })) });
  await dst.waitForTimeout(800);
  assert.match(await body(dst), /다채움 동의서 백업 파일이 아닙니다/);
  await dst.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await dst.waitForTimeout(2500);
  const t = await body(dst);
  assert.match(t, /계약 2건 · 문서 1건 \(환불완료 1건\)/);
  assert.match(t, /교체됩니다.*합쳐지지 않으니/s, '기존 자료가 있으면 교체·비합침 안내');
  assert.equal((await contracts(dst))[0].id, 'X9', '확인 전에는 바뀌지 않음');
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  const restored = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(restored, original, '복원 후 이 앱 자료 전체가 원본과 동일');
  assert.equal(await dst.evaluate(() => localStorage.getItem('inventory-system:v1')), 'DST-INVENTORY', '재고관리 자료는 건드리지 않음');
  assert.ok(dst.dialogs.some(m => /교체/.test(m)), '복원 전 확인창');
  assert.equal(((await body(dst)).match(/환불완료/g) || []).length, 1);
  await click(dst, '프로그램 B'); await click(dst, '환불 정산');
  assert.equal(await allocInputs(dst).nth(0).inputValue(), '400,000', '작성 중 환불 정산도 복원');
  assert.deepEqual(src.errors.concat(dst.errors), []);
});

test('복원 중 저장 실패: 원래 자료로 되돌리고 안내', async () => {
  const fs = require('node:fs');
  const src = await open([mk('CT1', '백업 원본 계약')]);
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const dst = await open([mk('KEEP', '기기 원래 계약')], { storage: { 'dachaeum.priceOverride': '{"keep":1}' } });
  const before = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await dst.waitForTimeout(2500);
  // 백업 자료를 쓰는 도중 저장 공간 부족 상황을 재현 (원래 자료를 되돌리는 쓰기는 허용)
  await dst.evaluate(() => { const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (String(v).includes('백업 원본 계약')) throw new DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); }; });
  await click(dst, '이 백업으로 복원'); await dst.waitForTimeout(500);
  assert.match(await body(dst), /복원에 실패했습니다. 기존 자료는 그대로 남아 있습니다/);
  const after = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(after, before);
});

test('정상가 보완 입력: 취소·빈값·문자·0원·음수·소수·근거 없음·확인 취소는 저장 안 함, 부분 저장 없음', async () => {
  const seedOf = () => [mk('CT1', '보완 계약', { total: 660000, paid: 660000, priorDep: 0, payments: [{ method: '카드', amount: 660000 }],
    items: [{ kind: '시술', name: '턱밑 A', qty: 5, price: 0 }, { kind: '시술', name: '턱밑 B', qty: 5, price: 0 }] })];
  const cases = [
    ['금액 입력 취소', [null]], ['빈 값', ['']], ['문자', ['abc']], ['0원', ['0']], ['음수', ['-5000']], ['소수', ['1.5']],
    ['근거 입력 취소', ['110000', null]], ['근거 빈 값', ['110000', '  ']], ['최종 확인 취소', ['110000', '근거', false]],
    ['첫 항목 완료 후 두 번째 취소 → 전부 저장 안 함', ['110000', '근거', true, null]],
  ];
  for (const [name, answers] of cases) {
    const q = answers.slice();
    const p = await open(seedOf(), { handle: d => { const a = q.length ? q.shift() : null;
      if (a === null || a === false) return d.dismiss(); return d.accept(a === true ? undefined : a); } });
    await click(p, '보완 계약'); await click(p, '환불 정산');
    await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(1).click(); await p.waitForTimeout(200);
    await click(p, '근거 확인 후 보완'); await p.waitForTimeout(300);
    const [c] = await contracts(p);
    assert.ok(!c.priceFixes || c.priceFixes.length === 0, name + ': 보완 기록 저장 안 됨');
    assert.ok(!c.refund && (c.status || '등록완료') === '등록완료', name + ': 환불 확정 안 됨');
    assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/, name + ': 계속 차단');
    await click(p, '정산서 생성 · 환자 서명');
    assert.doesNotMatch(await body(p), /터치하여 서명/, name + ': 서명 단계로 못 넘어감');
    await p.context().close();
  }
  // 정상 입력 ('110,000원' 형식) → 두 항목 모두 저장, 환불은 여전히 서명해야 확정
  const ok = ['110,000원', '2026-03-02 서명 동의서', true, '99000', '당시 가격표', true];
  const p = await open(seedOf(), { handle: d => { const a = ok.shift(); return d.accept(a === true ? undefined : a); } });
  await click(p, '보완 계약'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(1).click(); await p.waitForTimeout(200);
  await click(p, '근거 확인 후 보완'); await p.waitForTimeout(400);
  const [c] = await contracts(p);
  assert.deepEqual(c.priceFixes.map(f => [f.key, f.price, f.basis]), [['item:0', 110000, '2026-03-02 서명 동의서'], ['item:1', 99000, '당시 가격표']]);
  assert.ok(!c.refund && (c.status || '등록완료') === '등록완료', '보완만으로 환불 확정되지 않음');
  assert.equal(await finalRefund(p), String((660000 - 66000 - 110000 - 99000).toLocaleString('ko-KR')));
});

test('PGM-0041 흑자 1cm 1개: 총 등록금액 330,000원 표시·저장, 병변 금액 전액 차감 유지, 기존 계약 값 불변', async () => {
  const old = mk('c-old-bs', '흑자 제거', { cat: '색소', total: 440000, paid: 440000, priorDep: 0, payments: [{ method: '카드', amount: 440000 }],
    items: [{ kind: '시술', lesionUnit: true, qty: 5, price: 440000, name: '흑자 1 · 이마 2cm (2cm 이하)' }],
    priceSnap: { ver: 'old', programId: 'PGM-0041', total: null, at: '2026-09-01' } });
  const p = await open([old]);
  const before = JSON.stringify((await contracts(p))[0]);
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill('흑자테스트'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill('PGM-0041'); await p.waitForTimeout(300);
  assert.match(await body(p), /1개 330,000원~/);
  await click(p, '흑자 제거');
  await p.locator('input[placeholder="치료 부위 입력"]').first().fill('왼쪽 볼');
  await p.locator('input[placeholder="크기"]').first().fill('1'); await p.locator('input[placeholder="크기"]').first().blur(); await p.waitForTimeout(300);
  await click(p, '다음 단계'); await click(p, '카드');
  assert.match(await body(p), /330,000/);
  await signAndSave(p);
  const all = await contracts(p);
  const c = all.find(x => x.id !== 'c-old-bs');
  assert.equal(c.total, 330000);
  assert.equal(c.paid, 330000);
  assert.deepEqual(c.items.map(i => [i.kind, !!i.lesionUnit, i.qty, i.price]), [['시술', true, 5, 330000]]);
  assert.equal(c.priceSnap.programId, 'PGM-0041');
  assert.equal(c.priceSnap.total, 330000);
  assert.equal(JSON.stringify(all.find(x => x.id === 'c-old-bs')), before, '기존 계약 값 불변');
  assert.deepEqual(p.errors, []);
});


test('가격 관리: 버튼 표시 → 앱 안에서 열림(404 없음) → 수정·저장 → 새 계약 적용, 기존 계약 불변 → 새로고침 유지 → 기본 가격 복귀, 기존 변경 기록 유지', async () => {
  const oldOv = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const p = await open([mk('c-keep', '스페셜 토닝 1', { cat: '색소', total: 1320000, paid: 1320000 })], { storage: { 'dachaeum.priceOverride': JSON.stringify(oldOv) } });
  const keep = JSON.stringify((await contracts(p)).find(c => c.id === 'c-keep'));
  const ovNow = () => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.priceOverride') || 'null'));
  const openPm = async () => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400); };
  assert.equal(await p.locator('[title="가격 관리"]').count(), 1, '가격 관리 버튼 표시');
  assert.equal(await p.locator('a[href*="dc.html"]').count(), 0);
  const url = p.url();
  await openPm();
  assert.equal(p.url(), url, '다른 파일로 이동하지 않음 (404 없음)');
  let b = await body(p);
  assert.match(b, /가격 관리/); assert.match(b, /현재 변경된 가격/);
  assert.match(b, /스페셜 토닝 2[\s\S]*총 등록금액 1,430,000원 → 1,450,000원/, '기존 변경 기록 표시');
  // 수정·저장
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300);
  assert.match(await body(p), /스페셜 토닝 1[\s\S]*1,320,000원/);
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1,400,000');
  await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  assert.match(await body(p), /1,400,000원으로 저장했습니다/);
  let ov = await ovNow();
  assert.equal(ov.programs['PGM-0001'].total, '1400000');
  assert.deepEqual(ov.programs['PGM-0002'], { total: '1450000' }, '기존 변경 기록 유지');
  // 새로고침 후에도 유지 → 새 계약에 변경 가격 적용
  await p.reload(); await p.waitForTimeout(2000);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  let all = await contracts(p);
  const c1 = all.find(c => c.id !== 'c-keep');
  assert.equal(c1.total, 1400000, '새 계약에 변경 가격 적용');
  assert.equal(JSON.stringify(all.find(c => c.id === 'c-keep')), keep, '기존 계약 불변');
  // 기본 가격으로 되돌리기
  await p.goto(URL); await p.waitForTimeout(1500);
  await openPm();
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300);
  await p.getByText('기본 가격으로', { exact: true }).last().click(); await p.waitForTimeout(400);
  ov = await ovNow();
  assert.equal(ov.programs['PGM-0001'], undefined);
  assert.deepEqual(ov.programs['PGM-0002'], { total: '1450000' }, '다른 변경 기록은 그대로');
  assert.match(await body(p), /기본 가격 1,320,000원으로 되돌렸습니다/);
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  all = await contracts(p);
  assert.deepEqual(all.filter(c => c.id !== 'c-keep').map(c => c.total).sort(), [1320000, 1400000], '되돌린 뒤 새 계약은 기본 가격, 앞서 만든 계약은 그대로');
  assert.equal(JSON.stringify(all.find(c => c.id === 'c-keep')), keep);
  assert.deepEqual(p.errors, []);
});

test('가격 관리: 잘못된 입력·취소는 저장 안 함, 병변·조건별 금액 항목은 수정 칸 없음', async () => {
  let ans = true;
  const p = await open(null, { handle: d => (ans ? d.accept() : d.dismiss()) });
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  const q = p.locator('input[placeholder^="프로그램·시술 검색"]');
  await q.fill('PGM-0001'); await p.waitForTimeout(300);
  for (const bad of ['', 'abc', '-5000', '0', '12.5']) {
    await p.locator('input[placeholder="수정 가격 (원)"]').first().fill(bad);
    await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(200);
  }
  ans = false;
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1500000');
  await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => localStorage.getItem('dachaeum.priceOverride')), null, '아무것도 저장되지 않음');
  await q.fill('PGM-0041'); await p.waitForTimeout(300);
  assert.match(await body(p), /병변 크기별 금액으로 계산/);
  assert.equal(await p.locator('input[placeholder="수정 가격 (원)"]').count(), 0);
  assert.deepEqual(p.errors, []);
});

test('1회 정상가 변경: 총 등록금액과 별도 저장 → 새 계약에 저장·환불 차감, 기존 계약 유지 → 새로고침 유지 → 기본값 복귀', async () => {
  const oldOv = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const old = mk('c-old', '스페셜 토닝 1 (이전 계약)', { cat: '색소', total: 990000, paid: 990000, priorDep: 0, payments: [{ method: '카드', amount: 990000 }],
    items: [{ kind: '시술', name: '레블라이트 SI + 비타민관리', qty: 5, price: 198000 }] });
  const p = await open([old], { storage: { 'dachaeum.priceOverride': JSON.stringify(oldOv) } });
  const keep = JSON.stringify((await contracts(p))[0]);
  const ls = k => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  const pm = async () => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
    await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300); };
  const unitIn = p.locator('input[placeholder="수정 1회 정상가 (원)"]');
  await pm();
  let b = await body(p);
  assert.match(b, /시술별 환불용 1회 정상가/);
  assert.match(b, /레블라이트 SI \+ 비타민관리 5회\s*198,000원/);
  assert.equal(await unitIn.count(), 3, '스타룩스·레블라이트·피코 (약처방 서비스는 수정 칸 없음)');
  assert.match(b, /레블라이트 SI \+ 비타민관리 5회\s*198,000원\s*공통 시술 · 11개 프로그램에 함께 적용/);
  // 1회 정상가 수정 (레블라이트 198,000 → 250,000)
  await unitIn.nth(1).fill('250,000'); await p.getByText('정상가 저장', { exact: true }).nth(1).click(); await p.waitForTimeout(400);
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 1회 정상가를 250,000원으로 저장/);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'proc:pig-revlite': { price: '250000' } }, '공통 시술 단위로 저장');
  assert.deepEqual(await ls('dachaeum.priceOverride'), oldOv, '총 등록금액 기록은 그대로');
  assert.match(await body(p), /스페셜 토닝 1 PGM-0001 · 색소\s*1,320,000원/, '1회 정상가를 바꿔도 총 등록금액 그대로');
  assert.match(await body(p), /변경된 1회 정상가 적용 중 · 기본 198,000원/);
  // 총 등록금액 수정 → 1회 정상가 기록에 영향 없음
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1400000'); await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  assert.equal((await ls('dachaeum.priceOverride')).programs['PGM-0001'].total, '1400000');
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'proc:pig-revlite': { price: '250000' } }, '총 등록금액 변경이 1회 정상가에 영향 없음');
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 5회\s*250,000원/);
  // 새로고침 후 새 계약: 총 등록금액 1,400,000 / 레블라이트 250,000 / 나머지 기본값
  await p.reload(); await p.waitForTimeout(2000);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  let all = await contracts(p);
  const c = all.find(x => x.id !== 'c-old');
  assert.equal(c.total, 1400000);
  assert.deepEqual(c.items.filter(i => i.kind === '시술').map(i => [i.name, i.qty, i.price]),
    [['스타룩스 1540', 1, 330000], ['레블라이트 SI + 비타민관리', 5, 250000], ['피코 PLUS + 비타민관리', 5, 198000]]);
  assert.equal(JSON.stringify(all.find(x => x.id === 'c-old')), keep, '기존 계약 1회 정상가 유지');
  // 환불: 새 계약은 계약 당시 250,000 × 2 차감
  const k = c.items.findIndex(i => /레블라이트/.test(i.name));
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 1'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(k).click(); await p.getByText('+', { exact: true }).nth(k).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '760,000');                                  // 1,400,000 − 140,000 − 2 × 250,000
  // 기존 계약은 계약 당시 198,000 차감
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 1 (이전 계약)'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '693,000');                                  // 990,000 − 99,000 − 198,000
  // 1회 정상가 기본값으로 → 1회 정상가 기록만 제거, 총 등록금액 변경은 유지
  await p.goto(URL); await p.waitForTimeout(1500);
  await pm();
  await p.getByText('정상가 기본값으로', { exact: true }).click(); await p.waitForTimeout(400);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, {});
  assert.equal((await ls('dachaeum.priceOverride')).programs['PGM-0001'].total, '1400000');
  assert.deepEqual((await ls('dachaeum.priceOverride')).programs['PGM-0002'], { total: '1450000' });
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  all = await contracts(p);
  const c3 = all.find(x => x.id !== 'c-old' && x.id !== c.id);
  assert.equal(c3.total, 1400000);
  assert.equal(c3.items.find(i => /레블라이트/.test(i.name)).price, 198000, '기본 1회 정상가로 복귀');
  assert.equal(all.find(x => x.id === c.id).items.find(i => /레블라이트/.test(i.name)).price, 250000, '앞서 만든 계약은 그대로');
  assert.deepEqual(p.errors, []);
});

test('1회 정상가 변경: 정상가 확인 필요 항목(PGM-0037)은 수정 칸 없이 기존 기준 유지', async () => {
  const p = await open();
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0037'); await p.waitForTimeout(300);
  assert.match(await body(p), /남성 턱밑라인 포함 제모[\s\S]*정상가 확인 필요 · 등록 시 입력/);
  assert.equal(await p.locator('input[placeholder="수정 1회 정상가 (원)"]').count(), 0);
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  assert.match(await body(p), /환불용 1회 정상가 확인 필요/, '계약 작성 시 직접 입력 요구 그대로');
});

test('공통 시술 1회 정상가: 한 번 수정하면 같은 시술을 쓰는 다른 프로그램 새 계약에도 적용, 가격 기준이 다른 항목은 프로그램별', async () => {
  const p = await open();
  const ls = k => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  const q = p.locator('input[placeholder^="프로그램·시술 검색"]');
  // 흉터 피코프락셀: 같은 시술 ID라도 시술 DB(440,000)와 프로그램 단가(275,000)가 달라 프로그램별 관리
  await q.fill('PGM-0022'); await p.waitForTimeout(300);
  assert.match(await body(p), /피코프락셀 1회\s*275,000원\s*이 프로그램에만 적용/);
  await p.locator('input[placeholder="수정 1회 정상가 (원)"]').first().fill('300000');
  await p.getByText('정상가 저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  // 레블라이트(공통 시술): PGM-0001 화면에서 수정
  await q.fill('PGM-0001'); await p.waitForTimeout(300);
  await p.locator('input[placeholder="수정 1회 정상가 (원)"]').nth(1).fill('250000');
  await p.getByText('정상가 저장', { exact: true }).nth(1).click(); await p.waitForTimeout(400);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'PGM-0022|scar-picofraxel-regen-full': { price: '300000' }, 'proc:pig-revlite': { price: '250000' } });
  await q.fill('PGM-0002'); await p.waitForTimeout(300);
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 4회\s*250,000원/, '다른 프로그램에도 같은 값 표시');
  await q.fill('PGM-0023'); await p.waitForTimeout(300);
  assert.match(await body(p), /피코프락셀 3회\s*275,000원/, '프로그램별 항목은 다른 프로그램에 영향 없음');
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0002', '스페셜 토닝 2'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.equal(c.total, 1430000, '총 등록금액은 그대로');
  assert.equal(c.items.find(i => /레블라이트/.test(i.name)).price, 250000, '다른 프로그램 새 계약에도 공통 정상가 적용');
  assert.equal(c.items.find(i => /피코 PLUS/.test(i.name)).price, 198000);
  assert.deepEqual(p.errors, []);
});

test('백업·복원: 1회 정상가 변경(unitOverride)·총 등록금액 변경이 깨끗한 기기로 그대로 복원, 복원 후 새 계약에 적용, 실패 시 기존 기록 보존', async () => {
  const fs = require('node:fs');
  const ovT = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const src = await open([mk('CT1', '백업 원본 계약')], { storage: { 'dachaeum.priceOverride': JSON.stringify(ovT) } });
  await src.locator('[title="가격 관리"]').click(); await src.waitForTimeout(400);
  await src.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await src.waitForTimeout(300);
  await src.locator('input[placeholder="수정 1회 정상가 (원)"]').nth(1).fill('250000');
  await src.getByText('정상가 저장', { exact: true }).nth(1).click(); await src.waitForTimeout(400);
  await src.getByText('닫기', { exact: true }).last().click(); await src.waitForTimeout(300);
  const srcUo = await src.evaluate(() => localStorage.getItem('dachaeum.unitOverride'));
  assert.deepEqual(JSON.parse(srcUo).items, { 'proc:pig-revlite': { price: '250000' } });
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /pig-revlite|250000/, '백업 파일 안은 암호화');

  // 실패 시 기존 unitOverride 보존: 기존 기록이 있는 기기에서 잘못된 비밀번호·손상 파일·저장 실패
  const keepUo = JSON.stringify({ items: { 'proc:pig-xd': { price: '400000' } }, at: '2026-09-30 09:00' });
  const bad = await open([mk('KEEP', '기기 원래 계약')], { storage: { 'dachaeum.unitOverride': keepUo, 'dachaeum.priceOverride': '{"keep":1}' } });
  const snap = () => bad.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  const before = await snap();
  await click(bad, '백업 · 복원');
  const pw = bad.locator('input[placeholder="백업할 때 정한 비밀번호"]'), fileIn = bad.locator('input[type=file]');
  await pw.fill('wrong-pass'); await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await bad.waitForTimeout(2500);
  assert.match(await body(bad), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  const file = JSON.parse(text);
  await pw.fill('test-pass-1');
  await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...file, data: file.data.slice(0, -8) + 'AAAAAAAA' })) }); await bad.waitForTimeout(2500);
  assert.match(await body(bad), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  assert.deepEqual(await snap(), before);
  await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await bad.waitForTimeout(2500);
  await bad.evaluate(() => { const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'dachaeum.unitOverride' && String(v).includes('pig-revlite')) throw new DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); }; });
  await click(bad, '이 백업으로 복원'); await bad.waitForTimeout(500);
  assert.match(await body(bad), /복원에 실패했습니다. 기존 자료는 그대로 남아 있습니다/);
  assert.deepEqual(await snap(), before, '복원 실패 후 기존 unitOverride·priceOverride·계약 그대로');

  // 깨끗한 기기에 복원
  const dst = await open();
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await dst.waitForTimeout(2500);
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  assert.equal(await dst.evaluate(() => localStorage.getItem('dachaeum.unitOverride')), srcUo, '1회 정상가 변경 기록 동일하게 복원');
  assert.deepEqual(JSON.parse(await dst.evaluate(() => localStorage.getItem('dachaeum.priceOverride'))), ovT, '총 등록금액 변경 기록도 복원');
  await dst.locator('[title="가격 관리"]').click(); await dst.waitForTimeout(400);
  assert.match(await body(dst), /레블라이트 SI \+ 비타민관리 공통 시술 · 11개 프로그램\s*1회 정상가 198,000원 → 250,000원/);
  assert.match(await body(dst), /총 등록금액 1,430,000원 → 1,450,000원/);
  await dst.getByText('닫기', { exact: true }).last().click(); await dst.waitForTimeout(300);
  await pickProgram(dst, 'PGM-0002', '스페셜 토닝 2'); await signAndSave(dst);
  const c = (await contracts(dst)).find(x => x.id !== 'CT1');
  assert.equal(c.total, 1450000, '복원된 총 등록금액 적용');
  assert.equal(c.items.find(i => /레블라이트/.test(i.name)).price, 250000, '복원된 1회 정상가가 새 계약에 저장');
  assert.deepEqual(src.errors.concat(dst.errors, bad.errors), []);
});

// ---- 프로그램 이름 · 이벤트 · 선결제권 결제 안내 · 환불 정산 연결 ----
const pmOpen = async p => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400); };
const pmSearch = async (p, q) => { await p.locator('input[placeholder^="프로그램·시술 검색"]').fill(q); await p.waitForTimeout(300); };
const pmClose = async p => { await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300); };
const lsJ = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
const toStep3 = async (p, id, label, who = '결제테스트') => {
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill(who); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill(id); await p.waitForTimeout(300);
  await click(p, label); await click(p, '다음 단계');
};

test('프로그램 이름 변경: 검색·선택·새 계약·새 동의서에 반영, ID·금액 그대로, 기존 계약·서명 문서 유지, 되돌리기', async () => {
  const oldDoc = { id: 'D-OLD', contractId: 'C-OLD', kind: '이용동의서', version: 1, signedAt: '2026-09-01', html: '<div>스페셜 토닝 1 서명 문서</div>' };
  const p = await open([mk('C-OLD', '스페셜 토닝 1', { cat: '색소', total: 1320000, paid: 1320000 })], { storage: { 'dachaeum.v3.docs': JSON.stringify([oldDoc]) } });
  const before = await p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  await pmOpen(p); await pmSearch(p, 'PGM-0001');
  await p.locator('input[placeholder="프로그램 이름 변경"]').first().fill('스페셜 토닝 1 (가을)');
  await click(p, '이름 저장');
  assert.match(await body(p), /프로그램 이름을 ‘스페셜 토닝 1 \(가을\)’\(으\)로 저장/);
  assert.deepEqual((await lsJ(p, 'dachaeum.priceOverride')).programs['PGM-0001'], { name: '스페셜 토닝 1 (가을)' });
  assert.match(await body(p), /스페셜 토닝 1 \(가을\) PGM-0001 · 색소\s*1,320,000원/, '금액 그대로');
  await pmClose(p);
  await p.reload(); await p.waitForTimeout(2000);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1 (가을)');
  assert.match(await body(p), /최종 계약금액 1,320,000원/);
  await click(p, '카드'); await signAndSave(p);
  const all = await contracts(p), c = all.find(x => x.id !== 'C-OLD');
  assert.equal(c.program, '스페셜 토닝 1 (가을)');
  assert.equal(c.priceSnap.programId, 'PGM-0001');
  assert.equal(c.total, 1320000);
  const d = (await docs(p)).find(x => x.contractId === c.id);
  assert.match(d.html.replace(/<[^>]+>/g, ' '), /스페셜 토닝 1 \(가을\)/, '새 동의서에 변경 이름');
  const after = await p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  assert.equal(JSON.stringify(JSON.parse(after[0]).find(x => x.id === 'C-OLD')), JSON.stringify(JSON.parse(before[0])[0]), '기존 계약 그대로');
  assert.deepEqual(JSON.parse(after[1]).find(x => x.id === 'D-OLD'), oldDoc, '기존 서명 문서 그대로');
  // 기본 이름으로
  await p.goto(URL); await p.waitForTimeout(1500);
  await pmOpen(p); await pmSearch(p, 'PGM-0001'); await click(p, '기본 이름으로');
  assert.equal(await lsJ(p, 'dachaeum.priceOverride').then(o => o.programs['PGM-0001']), undefined);
  assert.equal((await contracts(p)).find(x => x.id === c.id).program, '스페셜 토닝 1 (가을)', '되돌려도 저장된 계약 이름은 그대로');
  assert.deepEqual(p.errors, []);
});

test('이벤트 관리: 할인율 이벤트 추가 → 3단계 할인 항목·금액·결제 안내 반영, 1회 정상가 그대로, 중지 시 사라짐 / 정액 이벤트 중복 허용 설정 저장', async () => {
  const p = await open();
  await pmOpen(p); await click(p, '이벤트');
  const evNames = await p.locator('xpath=//label[starts-with(normalize-space(.),"이벤트명")]/input').evaluateAll(els => els.map(e => e.value));
  assert.deepEqual(evNames, ['비마약성 무통주사제 [어나프라주] 1회 제공', '[뉴비쥬] 앵콜 이벤트'], '기존 이벤트 설정을 읽어서 표시');
  assert.match(await body(p), /추가 할인 불가 \(기본\)/);
  await p.locator('input[placeholder="이벤트명"]').fill('가을 이벤트');
  await p.locator('input[placeholder="할인율"]').fill('10');
  await click(p, '이벤트 추가');
  let eo = await lsJ(p, 'dachaeum.eventOverride');
  assert.equal(eo.added.length, 1); const id = eo.added[0].id;
  assert.deepEqual([eo.added[0].name, eo.added[0].rate, eo.added[0].kind], ['가을 이벤트', 0.1, 'rate']);
  await p.locator('input[placeholder="프로그램 ID (예: PGM-0001)"]').fill('PGM-0001'); await click(p, '프로그램 추가');
  await click(p, '이벤트 저장', 2);
  eo = await lsJ(p, 'dachaeum.eventOverride');
  assert.deepEqual(eo.events[id], { programs: ['PGM-0001'] });
  // 정액 적용가 이벤트: 선결제권 함께 선택 허용 저장 (기존 이벤트 값은 유지, 바꾼 항목만 기록)
  await click(p, '선결제권', 0); await click(p, '이벤트 저장', 1);
  assert.deepEqual((await lsJ(p, 'dachaeum.eventOverride')).events['EV-NEWBIJOU'], { stack: { pre: true } });
  await pmClose(p);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1');
  assert.match(await body(p), /가을 이벤트 10%/, '할인 항목에 이벤트 표시');
  assert.match(await body(p), /최종 계약금액 1,320,000원/, '선택 전 자동 적용 없음');
  await click(p, '가을 이벤트 10%');
  assert.match(await body(p), /최종 계약금액 1,188,000원/);
  assert.match(await body(p), /1,188,000원을 결제할게요/, '결제 안내도 같은 금액');
  await click(p, '카드'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.disc.kind, c.disc.eventId, c.disc.label], [1188000, 'ev:' + id, id, '가을 이벤트 10%']);
  assert.deepEqual(c.items.map(i => i.price), [330000, 198000, 198000], '이벤트 할인은 환불용 1회 정상가를 바꾸지 않음');
  // 중지하면 할인 항목에서 사라짐
  await p.goto(URL); await p.waitForTimeout(1500);
  await pmOpen(p); await click(p, '이벤트'); await click(p, '중지', 2); await click(p, '이벤트 저장', 2); await pmClose(p);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1');
  assert.doesNotMatch(await body(p), /가을 이벤트 10%/);
  assert.deepEqual(p.errors, []);
});

test('선결제권 신규 구매: 예정금액·사용액·예상 잔액 구분, 수납 확인 전 서명 불가, 계약 납부액은 사용액만 → 환불 801,900 잔액 복원, 화면·정산서·저장 문서 일치', async () => {
  const p = await open();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '신규구매테스트');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '신규 구매');
  let b = await body(p);
  assert.match(b, /신규 구매금액 \(구매 예정 · 수납 전\)\s*3,000,000원/);
  assert.match(b, /이번 계약에 선결제권 사용\s*891,000원/);
  assert.match(b, /차감 후 예상 잔액 \(수납 확인 후 확정\)\s*2,109,000원/);
  assert.match(b, /선결제권 3,000,000원 수납 확인이 필요해요/);
  await click(p, '동의서 미리보기 · 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '수납 확인 전에는 서명으로 넘어가지 않음');
  await click(p, '카드', 0); await p.getByText(/선결제권 구매금액 3,000,000원을 받았습니다/).click(); await p.waitForTimeout(300);
  b = await body(p);
  assert.match(b, /신규 구매금액 \(수납 확인\)\s*3,000,000원/);
  assert.match(b, /차감 후 선결제권 잔액\s*2,109,000원/);
  assert.match(b, /추가 결제 필요금액\s*0원/);
  await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid], [891000, 891000], '납부액 = 이번 계약 사용액 (구매금액 3,000,000 아님)');
  assert.deepEqual(c.payments, [{ method: '선결제권 (신규 구매 300)', amount: 891000, prepaid: true, newPurchase: true }]);
  assert.deepEqual(c.prepaid, { mode: 'new', tier: '300', purchase: 3000000, purchaseMethod: '카드', received: true, balBefore: 3000000, use: 891000, balAfter: 2109000 });
  assert.match((await docs(p))[0].html.replace(/<[^>]+>/g, ' '), /신규 구매 3,000,000원 중 891,000원 사용 · 차감 후 잔액 2,109,000원/, '동의서에 선결제권 사용 표시');
  // 환불 (시술 전)
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '여드름 8주 프로그램'); await click(p, '환불 정산');
  b = await body(p);
  assert.equal(await finalRefund(p), '801,900');
  assert.match(b, /이 중 선결제권 사용분\s*891,000원/);
  assert.match(b, /환불 방법\s*선결제권 잔액 복원 801,900원/);
  // 서비스 이용 기록: 추가 건수만 바꾸고 추가하지 않으면 차감 없음
  const svcBox = p.locator('xpath=//*[text()="추가 건수"]/ancestor::div[2]');
  await svcBox.getByText('+', { exact: true }).first().click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '801,900', '입력 대기 건수는 차감 안 됨');
  await click(p, '정산서 생성 · 환자 서명');
  const st = (await body(p)).replace(/\s+/g, ' ');
  for (const re of [/납부금액 891,000원/, /선결제권 사용분 891,000원 \(납부금액에 포함\)/, /위약금 \(총 계약금액 891,000원 × 10%\) 89,100원/, /= 최종 환불금액 801,900원/,
    /4\. 환불 방법/, /선결제권 \(잔액 복원\) 891,000원 801,900원/, /합계 \(= 최종 환불금액\) 801,900원/, /선결제권 잔액으로 복원/]) assert.match(st, re);
  await sign(p); await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const done = (await contracts(p))[0];
  assert.ok(done.refund, '정산서 서명 저장 → 환불완료');
  assert.deepEqual([done.refund.refundNum, done.refund.penNum, done.refund.paidEff], [801900, 89100, 891000]);
  assert.deepEqual(done.refund.pays.map(x => [x.method, x.prepaid, x.paid, x.refund]), [['선결제권 잔액 복원', true, 891000, 801900]]);
  const rd = (await docs(p)).find(x => x.kind !== '이용동의서');
  const rt = rd.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const re of [/납부금액 891,000 원/, /선결제권 사용분 891,000원 \(납부금액에 포함\)/, /위약금 \(총 계약금액 891,000 원 × 10%\) 89,100 원/, /= 최종 환불금액 801,900 원/,
    /선결제권 \(잔액 복원\) 891,000원 801,900원/, /합계 \(= 최종 환불금액\) 801,900원/]) assert.match(rt, re, '저장 문서(PDF 원본)도 같은 금액');
  assert.deepEqual(p.errors, []);
});

test('선결제권 보유 잔액 사용: 충분(1,000,000)·부족(300,000) 각각 사용액·잔액·추가 결제 일치, 선결제권 기준 금액을 잔액에 더하지 않음', async () => {
  const p = await open();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '잔액충분');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '보유 잔액 사용');
  await click(p, '동의서 미리보기 · 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '잔액 확인 전 진행 불가');
  const balIn = p.locator('xpath=//*[text()="보유 선결제권 잔액 (직원 확인)"]/following-sibling::span//input');
  await balIn.fill('1000000'); await p.waitForTimeout(300);
  let b = await body(p);
  assert.match(b, /보유 선결제권 잔액 \(직원 확인\)\s*1,000,000원/);
  assert.match(b, /이번 계약에 선결제권 사용\s*891,000원/);
  assert.match(b, /사용 후 선결제권 잔액\s*109,000원/);
  assert.match(b, /추가 결제 필요금액\s*0원/);
  await signAndSave(p);
  let [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.preBal], [891000, 891000, 1000000]);
  assert.deepEqual(c.prepaid, { mode: 'bal', tier: '300', purchase: null, purchaseMethod: null, received: null, balBefore: 1000000, use: 891000, balAfter: 109000 });
  // 부족
  await p.goto(URL); await p.waitForTimeout(1500);
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '잔액부족');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '보유 잔액 사용');
  await balIn.fill('300000'); await p.waitForTimeout(300);
  b = await body(p);
  assert.match(b, /이번 계약에 선결제권 사용\s*300,000원/);
  assert.match(b, /사용 후 선결제권 잔액\s*0원/);
  assert.match(b, /추가 결제 필요금액\s*591,000원/);
  assert.match(b, /591,000원을 결제할게요/);
  await click(p, '카드'); await signAndSave(p);
  c = (await contracts(p)).find(x => x.patient.name === '잔액부족');
  assert.deepEqual([c.total, c.paid], [891000, 891000]);
  assert.deepEqual(c.payments.map(x => [x.method, x.amount, !!x.prepaid]), [['카드', 591000, false], ['선결제권 잔액', 300000, true]], '당일 카드 수납과 잔액 사용 구분');
  assert.equal(c.prepaid.balAfter, 0);
  assert.equal(c.method, '카드 + 선결제권 잔액 300,000원');
  assert.deepEqual(p.errors, []);
});

test('백업·복원: 프로그램 이름·이벤트·1회 정상가·총 등록금액 설정이 깨끗한 기기에 그대로 복원되고 새 계약에 적용', async () => {
  const fs = require('node:fs');
  const ov = { programs: { 'PGM-0001': { name: '스페셜 토닝 1 (가을)' }, 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {} };
  const eo = { events: { 'EV-R-T': { programs: ['PGM-0001'] }, 'EV-NEWBIJOU': { stack: { pre: true } } }, added: [{ id: 'EV-R-T', kind: 'rate', name: '가을 이벤트', rate: 0.1, start: '', end: '', active: true, programs: [] }], at: '2026-10-02 10:00' };
  const uo = { items: { 'proc:pig-revlite': { price: '250000' } } };
  const src = await open([mk('CT1', '백업 원본 계약')], { storage: { 'dachaeum.priceOverride': JSON.stringify(ov), 'dachaeum.eventOverride': JSON.stringify(eo), 'dachaeum.unitOverride': JSON.stringify(uo) } });
  const keysOf = pg => pg.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  const original = await keysOf(src);
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /가을 이벤트|스페셜 토닝/, '설정도 암호화');
  const dst = await open();
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await dst.waitForTimeout(2500);
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  assert.deepEqual(await keysOf(dst), original, '이름·이벤트·정상가·가격 설정과 계약 전체 동일');
  await toStep3(dst, 'PGM-0001', '스페셜 토닝 1 (가을)');
  assert.match(await body(dst), /가을 이벤트 10%/);
  await click(dst, '가을 이벤트 10%'); await click(dst, '카드'); await signAndSave(dst);
  const c = (await contracts(dst)).find(x => x.id !== 'CT1');
  assert.deepEqual([c.program, c.total, c.items.find(i => /레블라이트/.test(i.name)).price], ['스페셜 토닝 1 (가을)', 1188000, 250000]);
  assert.deepEqual(src.errors.concat(dst.errors), []);
});

test('기납부 예약금 + 오늘 예약금: 별도 입금으로 안내·합산 (같은 입금인지 여부는 운영 기준 확인 필요 — 현재 동작 기록)', async () => {
  const p = await open();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '예약금테스트');
  const pdIn = p.locator('xpath=//*[text()="기납부 예약금"]/following-sibling::span//input');
  await pdIn.fill('89100'); await click(p, '예약금 결제'); await p.waitForTimeout(200);
  assert.match(await body(p), /기납부 예약금 89,100원은 이미 받은 금액이며, 오늘 예약금 99,000원은 별도로 받습니다/);
  await click(p, '카드'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.priorDep], [990000, 188100, 89100], '기납부 89,100(1회) + 오늘 예약금 99,000 (계약금액 10%)');
  assert.deepEqual(c.payments.map(x => [x.method, x.amount]), [['카드', 99000]], '기납부 예약금은 결제수단 기록에 중복으로 넣지 않음');
});
