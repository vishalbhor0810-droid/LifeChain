// Deletes the ledger and MSP identities so the network starts fresh
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
for (const f of ['ledger.json', 'msp.json']) fs.rmSync(path.join(dataDir, f), { force: true });
console.log('Ledger cleared. Run "npm start" to create a new genesis block.');
