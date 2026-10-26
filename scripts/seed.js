// Populates the ledger with a realistic history of blood units (run while the server is stopped)
const path = require('path');
const fs = require('fs');
const { Ledger } = require('../src/ledger');

const dataDir = path.join(__dirname, '..', 'data');
for (const f of ['ledger.json', 'msp.json']) fs.rmSync(path.join(dataDir, f), { force: true });
const ledger = new Ledger({ dataDir });

const DAY = 864e5, HOUR = 36e5;
const now = Date.now();
const at = (daysAgo, hours = 0) => now - daysAgo * DAY + hours * HOUR;

const NEG = { HIV: 'NEGATIVE', HBV: 'NEGATIVE', HCV: 'NEGATIVE', Syphilis: 'NEGATIVE', Malaria: 'NEGATIVE' };

const units = [
  ['BU-2026-0101', 'DNR-48213', 'O+', 'Whole Blood', 450, 12],
  ['BU-2026-0102', 'DNR-48214', 'A+', 'Packed RBC', 300, 11],
  ['BU-2026-0103', 'DNR-48220', 'B+', 'Whole Blood', 450, 10],
  ['BU-2026-0104', 'DNR-48231', 'O-', 'Packed RBC', 300, 9],
  ['BU-2026-0105', 'DNR-48233', 'AB+', 'Plasma', 200, 8],
  ['BU-2026-0106', 'DNR-48240', 'A-', 'Whole Blood', 450, 7],
  ['BU-2026-0107', 'DNR-48244', 'B-', 'Packed RBC', 300, 6],
  ['BU-2026-0108', 'DNR-48250', 'O+', 'Platelets', 60, 4],
  ['BU-2026-0109', 'DNR-48252', 'A+', 'Whole Blood', 450, 3],
  ['BU-2026-0110', 'DNR-48261', 'B+', 'Packed RBC', 300, 2],
  ['BU-2026-0111', 'DNR-48263', 'O+', 'Packed RBC', 300, 1],
  ['BU-2026-0112', 'DNR-48270', 'AB-', 'Whole Blood', 450, 0.5],
];

const log = (r) => console.log(`Block #${String(r.blockNumber).padStart(2)}  ${r.fn.padEnd(14)} ${String(r.response?.unitId || '').padEnd(13)} ${r.validationCode}`);

// Day-wise collections, each batch ordered into one block
for (const [unitId, donorId, bloodGroup, component, volumeMl, daysAgo] of units) {
  ledger.submit('CollectBlood', { unitId, donorId, bloodGroup, component, volumeMl }, 'BloodBankOrg', { timestamp: at(daysAgo) });
}
let b = ledger.cutBlock();
console.log(`Block #${String(b.header.number).padStart(2)}  CollectBlood x${b.data.length} (12 donations registered)`);

// Laboratory screening (unit 0107 tests positive for HBV)
for (const [unitId, , , , , daysAgo] of units.slice(0, 11)) {
  const results = unitId === 'BU-2026-0107' ? { ...NEG, HBV: 'POSITIVE' } : NEG;
  ledger.submit('RecordTest', { unitId, results, reportRef: 'LAB-' + unitId.slice(-4) }, 'LabOrg', { timestamp: at(daysAgo, 6) });
}
b = ledger.cutBlock();
console.log(`Block #${String(b.header.number).padStart(2)}  RecordTest   x${b.data.length} (1 unit rejected: HBV positive)`);

const step = (fn, args, org, daysAgo, h) => log(ledger.invoke(fn, args, org, { timestamp: at(daysAgo, h) }));
step('TransferUnit', { unitId: 'BU-2026-0101', toOrg: 'CityCareOrg' }, 'BloodBankOrg', 9, 2);
step('ReceiveUnit', { unitId: 'BU-2026-0101' }, 'CityCareOrg', 9, 4);
step('TransfuseUnit', { unitId: 'BU-2026-0101', patientId: 'PAT-CC-7781', patientBloodGroup: 'A+' }, 'CityCareOrg', 8, 1);
step('TransferUnit', { unitId: 'BU-2026-0104', toOrg: 'GreenValleyOrg' }, 'BloodBankOrg', 5, 3);
step('ReceiveUnit', { unitId: 'BU-2026-0104' }, 'GreenValleyOrg', 5, 5);
step('TransfuseUnit', { unitId: 'BU-2026-0104', patientId: 'PAT-GV-1029', patientBloodGroup: 'B-' }, 'GreenValleyOrg', 4, 2);
step('TransferUnit', { unitId: 'BU-2026-0102', toOrg: 'CityCareOrg' }, 'BloodBankOrg', 3, 1);
step('ReceiveUnit', { unitId: 'BU-2026-0102' }, 'CityCareOrg', 3, 3);
step('DiscardUnit', { unitId: 'BU-2026-0107', reason: 'Reactive for HBV – destroyed as biomedical waste' }, 'BloodBankOrg', 5, 0);
step('TransferUnit', { unitId: 'BU-2026-0103', toOrg: 'GreenValleyOrg' }, 'BloodBankOrg', 1, 2);

console.log('\nChain valid:', ledger.validateChain().valid, '| Height:', ledger.blocks.length, '| Units:', ledger.units().length);
