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
