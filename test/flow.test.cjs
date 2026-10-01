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

async function open(seed) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto(URL);
  await p.evaluate(c => { localStorage.clear(); if (c) localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(c)); }, seed || null);
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
