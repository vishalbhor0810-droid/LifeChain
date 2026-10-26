// Automated tests for the LifeChain ledger and bloodtrace chaincode.
// Run with: npm test   (uses Node's built-in test runner; each test gets a fresh ledger in a temp folder)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger, AccessError } = require('../src/ledger');

const NEG = { HIV: 'NEGATIVE', HBV: 'NEGATIVE', HCV: 'NEGATIVE', Syphilis: 'NEGATIVE', Malaria: 'NEGATIVE' };

function freshLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifechain-'));
  return new Ledger({ dataDir: dir });
}

function collect(ledger, unitId = 'BU-T-001', bloodGroup = 'B+', component = 'Whole Blood') {
  return ledger.invoke('CollectBlood', { unitId, donorId: 'DNR-1', bloodGroup, component, volumeMl: 450 }, 'BloodBankOrg');
}

function readyAtHospital(ledger, unitId = 'BU-T-001', bloodGroup = 'B+') {
  collect(ledger, unitId, bloodGroup);
  ledger.invoke('RecordTest', { unitId, results: NEG }, 'LabOrg');
  ledger.invoke('TransferUnit', { unitId, toOrg: 'CityCareOrg' }, 'BloodBankOrg');
  ledger.invoke('ReceiveUnit', { unitId }, 'CityCareOrg');
}

test('genesis block is created and the chain is valid', () => {
  const l = freshLedger();
  assert.strictEqual(l.blocks.length, 1);
  assert.strictEqual(l.validateChain().valid, true);
});

test('blood bank can collect a unit; it is endorsed by its own peer and the regulator', () => {
  const l = freshLedger();
  const r = collect(l);
  assert.strictEqual(r.validationCode, 'VALID');
  assert.deepStrictEqual(r.endorsements.map(e => e.mspId), ['BloodBankMSP', 'RegulatorMSP']);
  const unit = l.unit('BU-T-001');
  assert.strictEqual(unit.status, 'COLLECTED');
  assert.match(unit.donorRef, /^REF-[0-9A-F]{12}$/);
});

test('organizations cannot perform actions outside their role', () => {
  const l = freshLedger();
  assert.throws(() => l.invoke('CollectBlood', { unitId: 'BU-T-002', donorId: 'D', bloodGroup: 'A+', component: 'Plasma', volumeMl: 200 }, 'CityCareOrg'), AccessError);
  collect(l);
  assert.throws(() => l.invoke('RecordTest', { unitId: 'BU-T-001', results: NEG }, 'BloodBankOrg'), AccessError);
  assert.throws(() => l.invoke('TransferUnit', { unitId: 'BU-T-001', toOrg: 'CityCareOrg' }, 'RegulatorOrg'), AccessError);
  assert.throws(() => l.invoke('CollectBlood', {}, 'UnknownOrg'), AccessError);
});

test('duplicate unit IDs are rejected', () => {
  const l = freshLedger();
  collect(l);
  assert.throws(() => collect(l), /already exists/);
});

test('a positive screening result rejects the unit and blocks its issue', () => {
  const l = freshLedger();
  collect(l);
  const r = l.invoke('RecordTest', { unitId: 'BU-T-001', results: { ...NEG, HIV: 'POSITIVE' } }, 'LabOrg');
  assert.strictEqual(r.response.verdict, 'UNSAFE');
  assert.throws(() => l.invoke('TransferUnit', { unitId: 'BU-T-001', toOrg: 'CityCareOrg' }, 'BloodBankOrg'), /Only tested, available units/);
});

test('untested units cannot be issued and only the addressed hospital can receive', () => {
  const l = freshLedger();
  collect(l);
  assert.throws(() => l.invoke('TransferUnit', { unitId: 'BU-T-001', toOrg: 'CityCareOrg' }, 'BloodBankOrg'), /Only tested/);
  l.invoke('RecordTest', { unitId: 'BU-T-001', results: NEG }, 'LabOrg');
  l.invoke('TransferUnit', { unitId: 'BU-T-001', toOrg: 'CityCareOrg' }, 'BloodBankOrg');
  assert.throws(() => l.invoke('ReceiveUnit', { unitId: 'BU-T-001' }, 'GreenValleyOrg'), AccessError);
  assert.strictEqual(l.invoke('ReceiveUnit', { unitId: 'BU-T-001' }, 'CityCareOrg').validationCode, 'VALID');
});

test('incompatible transfusion is blocked and a compatible one is recorded', () => {
  const l = freshLedger();
  readyAtHospital(l);
  assert.throws(() => l.invoke('TransfuseUnit', { unitId: 'BU-T-001', patientId: 'P1', patientBloodGroup: 'A+' }, 'CityCareOrg'), /Incompatible transfusion blocked/);
  const r = l.invoke('TransfuseUnit', { unitId: 'BU-T-001', patientId: 'P1', patientBloodGroup: 'AB+' }, 'CityCareOrg');
  assert.strictEqual(r.validationCode, 'VALID');
  assert.strictEqual(l.unit('BU-T-001').status, 'TRANSFUSED');
  assert.deepStrictEqual(l.history('BU-T-001').map(e => e.fn), ['CollectBlood', 'RecordTest', 'TransferUnit', 'ReceiveUnit', 'TransfuseUnit']);
});

test('expired units cannot be issued', () => {
  const l = freshLedger();
  const old = Date.now() - 10 * 864e5;
  l.invoke('CollectBlood', { unitId: 'BU-T-003', donorId: 'D', bloodGroup: 'O+', component: 'Platelets', volumeMl: 60 }, 'BloodBankOrg', { timestamp: old });
  l.invoke('RecordTest', { unitId: 'BU-T-003', results: NEG }, 'LabOrg', { timestamp: old });
  assert.throws(() => l.invoke('TransferUnit', { unitId: 'BU-T-003', toOrg: 'CityCareOrg' }, 'BloodBankOrg'), /expired/);
});

test('double allocation: only one of two conflicting transfers is valid (MVCC)', () => {
  const l = freshLedger();
  collect(l);
  l.invoke('RecordTest', { unitId: 'BU-T-001', results: NEG }, 'LabOrg');
  const r = l.doubleAllocation('BU-T-001');
  assert.deepStrictEqual(r.results.map(x => x.validationCode), ['VALID', 'MVCC_READ_CONFLICT']);
  assert.strictEqual(l.unit('BU-T-001').transferTo, 'CityCareOrg');
});

test('tampering with a stored block is detected and restore makes the chain valid again', () => {
  const l = freshLedger();
  collect(l);
  l.tamper(1, 'O-');
  const v = l.validateChain();
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /data hash mismatch/.test(e.reason)));
  assert.strictEqual(l.restore().valid, true);
});
