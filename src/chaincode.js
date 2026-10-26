/**
 * LifeChain chaincode "bloodtrace" - business logic for blood unit traceability.
 * Every function runs on the endorsing peers; it reads/writes the world state through ctx.stub.
 */
const crypto = require('crypto');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const SHELF_LIFE_DAYS = { 'Whole Blood': 35, 'Packed RBC': 42, Platelets: 5, Plasma: 365 };
const TESTS = ['HIV', 'HBV', 'HCV', 'Syphilis', 'Malaria'];
const DAY = 864e5;

// Red-cell compatibility: recipient -> donor groups it can receive
const RBC_COMPAT = {
  'O-': ['O-'], 'O+': ['O-', 'O+'], 'A-': ['O-', 'A-'], 'A+': ['O-', 'O+', 'A-', 'A+'],
  'B-': ['O-', 'B-'], 'B+': ['O-', 'O+', 'B-', 'B+'], 'AB-': ['O-', 'A-', 'B-', 'AB-'], 'AB+': BLOOD_GROUPS,
};
// Plasma compatibility (ABO only): recipient ABO -> donor ABO
const PLASMA_COMPAT = { O: ['O', 'A', 'B', 'AB'], A: ['A', 'AB'], B: ['B', 'AB'], AB: ['AB'] };
const abo = g => g.replace(/[+-]/, '');

const pseudonym = (s) => 'REF-' + crypto.createHash('sha256').update(String(s).trim().toUpperCase()).digest('hex').slice(0, 12).toUpperCase();

function requireOrg(ctx, allowed, action) {
  if (!allowed.includes(ctx.creator)) {
    throw new ctx.AccessError(`Access denied: ${ctx.creator} is not permitted to ${action}. Allowed: ${allowed.join(', ')}`);
  }
}

function getUnit(ctx, unitId) {
  const unit = ctx.stub.getState('UNIT_' + unitId);
  if (!unit) throw new Error(`Blood unit ${unitId} does not exist`);
  return unit;
}

function addEvent(unit, ctx, action, details) {
  unit.lastAction = action;
  unit.lastUpdated = ctx.timestamp;
  unit.lastUpdatedBy = ctx.creator;
  unit.lastDetails = details;
}

const hospitals = ctx => ctx.orgs.filter(o => o.type === 'Hospital').map(o => o.id);

const contract = {
  CollectBlood(ctx, a) {
    requireOrg(ctx, ['BloodBankOrg'], 'register blood donations');
    if (!a.unitId || !/^BU-[\w-]+$/.test(a.unitId)) throw new Error('Invalid unit ID');
    if (!BLOOD_GROUPS.includes(a.bloodGroup)) throw new Error('Invalid blood group');
    if (!SHELF_LIFE_DAYS[a.component]) throw new Error('Invalid blood component');
    const volume = Number(a.volumeMl);
    if (!(volume >= 50 && volume <= 500)) throw new Error('Volume must be between 50 and 500 ml');
    if (!a.donorId || !String(a.donorId).trim()) throw new Error('Donor ID is required');
    if (ctx.stub.getState('UNIT_' + a.unitId)) throw new Error(`Unit ${a.unitId} already exists`);

    const unit = {
      unitId: a.unitId,
      donorRef: pseudonym(a.donorId), // personal donor data stays off-chain; only a pseudonymous reference is stored
      bloodGroup: a.bloodGroup,
      component: a.component,
      volumeMl: volume,
      collectedAt: ctx.timestamp,
      expiryDate: ctx.timestamp + SHELF_LIFE_DAYS[a.component] * DAY,
      collectionCenter: a.collectionCenter || 'LifeLine Blood Bank',
      status: 'COLLECTED',
      custodian: 'BloodBankOrg',
      testResult: null,
    };
    addEvent(unit, ctx, 'COLLECTED', `${volume} ml ${a.component} collected at ${unit.collectionCenter}`);
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId, donorRef: unit.donorRef, expiryDate: unit.expiryDate };
  },

  RecordTest(ctx, a) {
    requireOrg(ctx, ['LabOrg'], 'record laboratory test results');
    const unit = getUnit(ctx, a.unitId);
    if (unit.status !== 'COLLECTED') throw new Error(`Unit ${a.unitId} is not awaiting testing (status ${unit.status})`);
    const results = {};
    for (const t of TESTS) {
      if (!['NEGATIVE', 'POSITIVE'].includes(a.results?.[t])) throw new Error(`Result for ${t} must be NEGATIVE or POSITIVE`);
      results[t] = a.results[t];
    }
    const safe = TESTS.every(t => results[t] === 'NEGATIVE');
    unit.testResult = { ...results, verdict: safe ? 'SAFE' : 'UNSAFE', testedBy: ctx.creator, testedAt: ctx.timestamp, reportRef: a.reportRef || null };
    unit.status = safe ? 'AVAILABLE' : 'REJECTED';
    addEvent(unit, ctx, safe ? 'TESTED_SAFE' : 'TESTED_UNSAFE', safe ? 'All infection screening tests negative' : 'Positive screening result: ' + TESTS.filter(t => results[t] === 'POSITIVE').join(', '));
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId, verdict: unit.testResult.verdict, status: unit.status };
  },

  TransferUnit(ctx, a) {
    const unit = getUnit(ctx, a.unitId);
    requireOrg(ctx, [unit.custodian], `transfer unit ${a.unitId} (current custodian is ${unit.custodian})`);
    if (unit.status !== 'AVAILABLE') throw new Error(`Only tested, available units can be issued (status ${unit.status})`);
    if (unit.expiryDate <= ctx.timestamp) throw new Error(`Unit ${a.unitId} has expired and cannot be issued`);
    if (!hospitals(ctx).includes(a.toOrg)) throw new Error('Destination must be a registered hospital');
    unit.status = 'IN_TRANSIT';
    unit.transferTo = a.toOrg;
    addEvent(unit, ctx, 'DISPATCHED', `Dispatched to ${a.toOrg}`);
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId, toOrg: a.toOrg };
  },

  ReceiveUnit(ctx, a) {
    const unit = getUnit(ctx, a.unitId);
    if (unit.status !== 'IN_TRANSIT') throw new Error(`Unit ${a.unitId} is not in transit`);
    requireOrg(ctx, [unit.transferTo], `receive unit ${a.unitId} (addressed to ${unit.transferTo})`);
    unit.status = 'AT_HOSPITAL';
    unit.custodian = ctx.creator;
    delete unit.transferTo;
    addEvent(unit, ctx, 'RECEIVED', `Received and stored by ${ctx.creator}`);
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId, custodian: unit.custodian };
  },

  TransfuseUnit(ctx, a) {
    const unit = getUnit(ctx, a.unitId);
    requireOrg(ctx, hospitals(ctx).filter(h => h === unit.custodian), `transfuse unit ${a.unitId} (custodian is ${unit.custodian})`);
    if (unit.status !== 'AT_HOSPITAL') throw new Error(`Unit ${a.unitId} is not available at the hospital`);
    if (unit.expiryDate <= ctx.timestamp) throw new Error(`Unit ${a.unitId} has expired – transfusion blocked`);
    if (!BLOOD_GROUPS.includes(a.patientBloodGroup)) throw new Error('Invalid patient blood group');
    const compatible = unit.component === 'Plasma'
      ? PLASMA_COMPAT[abo(a.patientBloodGroup)].includes(abo(unit.bloodGroup))
      : unit.component === 'Platelets' ? true : RBC_COMPAT[a.patientBloodGroup].includes(unit.bloodGroup);
    if (!compatible) throw new Error(`Incompatible transfusion blocked: ${unit.component} of group ${unit.bloodGroup} cannot be given to a ${a.patientBloodGroup} patient`);
    unit.status = 'TRANSFUSED';
    unit.transfusion = { patientRef: pseudonym(a.patientId), patientBloodGroup: a.patientBloodGroup, at: ctx.timestamp, hospital: ctx.creator };
    addEvent(unit, ctx, 'TRANSFUSED', `Transfused to patient ${unit.transfusion.patientRef} (${a.patientBloodGroup})`);
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId, patientRef: unit.transfusion.patientRef };
  },

  DiscardUnit(ctx, a) {
    const unit = getUnit(ctx, a.unitId);
    requireOrg(ctx, [unit.custodian], `discard unit ${a.unitId}`);
    if (['TRANSFUSED', 'DISCARDED'].includes(unit.status)) throw new Error(`Unit ${a.unitId} is already ${unit.status}`);
    unit.status = 'DISCARDED';
    addEvent(unit, ctx, 'DISCARDED', a.reason || 'Discarded');
    ctx.stub.putState('UNIT_' + a.unitId, unit);
    return { unitId: unit.unitId };
  },
};

module.exports = { contract, BLOOD_GROUPS, SHELF_LIFE_DAYS, TESTS, pseudonym };
