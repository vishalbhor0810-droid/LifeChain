/**
 * LifeChain - permissioned blockchain ledger (Hyperledger Fabric style)
 *
 * Implements the execute -> order -> validate -> commit flow:
 *   1. Client creates a signed transaction proposal
 *   2. Endorsing peers simulate chaincode on the world state and sign the read/write set
 *   3. Ordering service packages endorsed transactions into hash-linked blocks
 *   4. Peers validate (endorsement policy + MVCC version check) and commit valid writes
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contract } = require('./chaincode');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function merkleRoot(hashes) {
  if (hashes.length === 0) return sha256('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
}

const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Organizations of the consortium. Each runs one peer and has its own CA / MSP.
const ORGS = [
  { id: 'BloodBankOrg', mspId: 'BloodBankMSP', name: 'LifeLine Blood Bank', type: 'Blood Bank', peer: 'peer0.bloodbank.lifechain.com' },
  { id: 'LabOrg', mspId: 'LabMSP', name: 'Precision Diagnostics Lab', type: 'Testing Laboratory', peer: 'peer0.lab.lifechain.com' },
  { id: 'CityCareOrg', mspId: 'CityCareMSP', name: 'CityCare Hospital', type: 'Hospital', peer: 'peer0.citycare.lifechain.com' },
  { id: 'GreenValleyOrg', mspId: 'GreenValleyMSP', name: 'Green Valley Hospital', type: 'Hospital', peer: 'peer0.greenvalley.lifechain.com' },
  { id: 'RegulatorOrg', mspId: 'RegulatorMSP', name: 'Health Regulatory Authority', type: 'Regulator / Auditor', peer: 'peer0.regulator.lifechain.com' },
];

const CHANNEL = 'bloodchannel';
const CHAINCODE = 'bloodtrace';
const ORDERER = 'orderer.lifechain.com';
const ENDORSEMENT_POLICY = "AND('<CreatorOrg>.peer', 'RegulatorMSP.peer')";

class AccessError extends Error {}

class Ledger {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.mspFile = path.join(dataDir, 'msp.json');
    this.ledgerFile = path.join(dataDir, 'ledger.json');
    this.queue = []; // ordering service queue
    this.loadMsp();
    this.loadLedger();
  }

  // ---------------- Membership Service Provider (identities issued by each org's CA) ----------------
  loadMsp() {
    if (fs.existsSync(this.mspFile)) {
      this.msp = JSON.parse(fs.readFileSync(this.mspFile, 'utf8'));
      return;
    }
    this.msp = {};
    for (const org of ORGS) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      this.msp[org.id] = {
        ...org,
        ca: 'ca.' + org.peer.split('.').slice(1).join('.'),
        certSerial: crypto.randomBytes(8).toString('hex').toUpperCase(),
        publicKey,
        privateKey,
      };
    }
    fs.writeFileSync(this.mspFile, JSON.stringify(this.msp, null, 2));
  }

  org(id) {
    const o = this.msp[id];
    if (!o) throw new AccessError(`Identity "${id}" is not enrolled in any MSP of channel ${CHANNEL}`);
    return o;
  }

  sign(orgId, data) {
    return crypto.sign('SHA256', Buffer.from(data), this.msp[orgId].privateKey).toString('hex');
  }

  verify(orgId, data, sig) {
    try {
      return crypto.verify('SHA256', Buffer.from(data), this.msp[orgId].publicKey, Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  }

  publicOrgs() {
    return ORGS.map(o => ({ ...o, ca: this.msp[o.id].ca, certSerial: this.msp[o.id].certSerial, keyFingerprint: sha256(this.msp[o.id].publicKey).slice(0, 16) }));
  }

  // ---------------- Ledger: blockchain + world state ----------------
  loadLedger() {
    if (fs.existsSync(this.ledgerFile)) {
      this.blocks = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
    } else {
      this.blocks = [this.genesisBlock()];
      this.save();
    }
    this.rebuildWorldState();
  }

  save() {
    fs.writeFileSync(this.ledgerFile, JSON.stringify(this.blocks, null, 2));
  }

  genesisBlock() {
    const configTx = {
      txId: sha256('genesis-' + Date.now()),
      type: 'CONFIG',
      channel: CHANNEL,
      timestamp: Date.now(),
      config: { organizations: ORGS.map(o => o.mspId), orderer: ORDERER, chaincode: CHAINCODE, endorsementPolicy: ENDORSEMENT_POLICY },
      validationCode: 'VALID',
    };
    return this.makeBlock(0, '0'.repeat(64), [configTx]);
  }

  static txHash(tx) {
    const { validationCode, ...content } = tx;
    return sha256(canonical(content));
  }

  makeBlock(number, previousHash, txs) {
    const header = { number, previousHash, dataHash: merkleRoot(txs.map(Ledger.txHash)) };
    return {
      header,
      hash: sha256(canonical(header)),
      data: txs,
      metadata: { orderer: ORDERER, timestamp: Date.now(), txCount: txs.length, validationCodes: txs.map(t => t.validationCode) },
    };
  }

  // Replays every valid transaction to rebuild the world state (as a Fabric peer does from its block store)
  rebuildWorldState() {
    this.world = {};
    for (const block of this.blocks) {
      block.data.forEach((tx, i) => {
        if (tx.type === 'ENDORSER' && tx.validationCode === 'VALID') this.applyWrites(tx.rwset.writes, block.header.number, i);
      });
    }
  }

  applyWrites(writes, blockNum, txNum) {
    for (const [key, value] of Object.entries(writes)) this.world[key] = { value: clone(value), version: `${blockNum}:${txNum}` };
  }

  // ---------------- Step 1 + 2: proposal and endorsement ----------------
  simulate(proposal) {
    const reads = {}, writes = {};
    const stub = {
      getState: key => {
        if (key in writes) return clone(writes[key]);
        const entry = this.world[key];
        if (!(key in reads)) reads[key] = entry ? entry.version : null;
        return entry ? clone(entry.value) : null;
      },
      putState: (key, value) => { writes[key] = clone(value); },
    };
    const ctx = { creator: proposal.creator, timestamp: proposal.timestamp, txId: proposal.txId, stub, orgs: ORGS, AccessError };
    const fn = contract[proposal.fn];
    if (!fn) throw new Error(`Chaincode function ${proposal.fn} does not exist`);
    const response = fn(ctx, proposal.args);
    return { rwset: { reads, writes }, response };
  }

  endorsingOrgs(creator) {
    return [...new Set([creator, 'RegulatorOrg'])];
  }

  submit(fn, args, creator, { timestamp } = {}) {
    this.org(creator);
    if (creator === 'RegulatorOrg' && fn !== 'QueryUnit') throw new AccessError('RegulatorMSP members have read-only (audit) access');

    const proposal = { channel: CHANNEL, chaincode: CHAINCODE, fn, args, creator, timestamp: timestamp || Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
    proposal.txId = sha256(canonical(proposal));
    const proposalSignature = this.sign(creator, canonical(proposal));

    // Each endorsing peer executes the chaincode independently
    const endorsements = [];
    let result = null;
    for (const orgId of this.endorsingOrgs(creator)) {
      const sim = this.simulate(proposal); // throws on chaincode error -> proposal rejected, never ordered
      if (result && canonical(result.rwset) !== canonical(sim.rwset)) throw new Error('Endorsement mismatch between peers');
      result = sim;
      endorsements.push({ mspId: this.msp[orgId].mspId, org: orgId, peer: this.msp[orgId].peer, signature: this.sign(orgId, proposal.txId + canonical(sim.rwset)) });
    }

    const tx = { txId: proposal.txId, type: 'ENDORSER', proposal, proposalSignature, rwset: result.rwset, response: result.response, endorsements, validationCode: 'PENDING' };
    this.queue.push(tx);
    return tx;
  }

  // ---------------- Step 3 + 4: ordering, validation, commit ----------------
  cutBlock() {
    if (this.queue.length === 0) return null;
    const txs = this.queue.splice(0);
    const number = this.blocks.length;
    const committed = {}; // writes committed earlier in this same block
    txs.forEach((tx, i) => {
      tx.validationCode = this.validateTx(tx, committed);
      if (tx.validationCode === 'VALID') {
        this.applyWrites(tx.rwset.writes, number, i);
        Object.keys(tx.rwset.writes).forEach(k => { committed[k] = true; });
      }
    });
    const block = this.makeBlock(number, this.blocks[number - 1].hash, txs);
    this.blocks.push(block);
    this.save();
    return block;
  }

  validateTx(tx, committedInBlock) {
    const required = this.endorsingOrgs(tx.proposal.creator);
    for (const orgId of required) {
      const e = tx.endorsements.find(x => x.org === orgId);
      if (!e || !this.verify(orgId, tx.txId + canonical(tx.rwset), e.signature)) return 'ENDORSEMENT_POLICY_FAILURE';
    }
    for (const [key, version] of Object.entries(tx.rwset.reads)) {
      const current = this.world[key] ? this.world[key].version : null;
      if (current !== version || committedInBlock[key]) return 'MVCC_READ_CONFLICT';
    }
    return 'VALID';
  }

  invoke(fn, args, creator, opts) {
    const tx = this.submit(fn, args, creator, opts);
    const block = this.cutBlock();
    return this.txReceipt(tx, block);
  }

  txReceipt(tx, block) {
    return { txId: tx.txId, fn: tx.proposal.fn, validationCode: tx.validationCode, blockNumber: block.header.number, blockHash: block.hash, endorsements: tx.endorsements.map(({ signature, ...e }) => ({ ...e, signature: signature.slice(0, 24) + '…' })), response: tx.response };
  }

  // ---------------- Queries ----------------
  units() {
    return Object.entries(this.world).filter(([k]) => k.startsWith('UNIT_')).map(([, v]) => v.value).sort((a, b) => b.collectedAt - a.collectedAt);
  }

  unit(unitId) {
    const e = this.world['UNIT_' + unitId];
    return e ? e.value : null;
  }

  history(unitId) {
    const key = 'UNIT_' + unitId;
    const events = [];
    for (const block of this.blocks) {
      block.data.forEach(tx => {
        if (tx.type !== 'ENDORSER' || !(key in tx.rwset.writes)) return;
        events.push({ txId: tx.txId, fn: tx.proposal.fn, creator: tx.proposal.creator, timestamp: tx.proposal.timestamp, blockNumber: block.header.number, validationCode: tx.validationCode, value: tx.rwset.writes[key], endorsedBy: tx.endorsements.map(e => e.mspId) });
      });
    }
    return events;
  }

  validateChain() {
    const errors = [];
    this.blocks.forEach((b, i) => {
      if (merkleRoot(b.data.map(Ledger.txHash)) !== b.header.dataHash) errors.push({ block: i, reason: 'Block data hash mismatch – transaction contents were modified' });
      if (sha256(canonical(b.header)) !== b.hash) errors.push({ block: i, reason: 'Block header hash mismatch' });
      if (i > 0 && b.header.previousHash !== this.blocks[i - 1].hash) errors.push({ block: i, reason: 'Previous block hash link broken' });
      b.data.forEach(tx => {
        if (tx.type !== 'ENDORSER') return;
        for (const e of tx.endorsements) {
          if (!this.verify(e.org, tx.txId + canonical(tx.rwset), e.signature)) errors.push({ block: i, reason: `Invalid ${e.mspId} endorsement on tx ${tx.txId.slice(0, 10)}…` });
        }
      });
    });
    return { valid: errors.length === 0, errors, height: this.blocks.length };
  }

  // ---------------- Demonstrations ----------------
  // Two hospitals request the same blood unit at the same time; only one can win.
  doubleAllocation(unitId) {
    const tx1 = this.submit('TransferUnit', { unitId, toOrg: 'CityCareOrg' }, 'BloodBankOrg');
    const tx2 = this.submit('TransferUnit', { unitId, toOrg: 'GreenValleyOrg' }, 'BloodBankOrg');
    const block = this.cutBlock();
    return { blockNumber: block.header.number, results: [tx1, tx2].map(t => ({ txId: t.txId, toOrg: t.proposal.args.toOrg, validationCode: t.validationCode })) };
  }

  tamper(blockNumber, newGroup) {
    const block = this.blocks[blockNumber];
    const tx = block && block.data.find(t => t.type === 'ENDORSER' && t.proposal.fn === 'CollectBlood');
    if (!tx) throw new Error('Choose a block that contains a CollectBlood transaction');
    this._backup = JSON.stringify(this.blocks);
    const key = Object.keys(tx.rwset.writes)[0];
    const old = tx.rwset.writes[key].bloodGroup;
    tx.rwset.writes[key].bloodGroup = newGroup || 'O-';
    return { blockNumber, unitId: tx.rwset.writes[key].unitId, oldGroup: old, newGroup: tx.rwset.writes[key].bloodGroup };
  }

  restore() {
    if (this._backup) this.blocks = JSON.parse(this._backup);
    this._backup = null;
    this.rebuildWorldState();
    return this.validateChain();
  }

  stats(now = Date.now()) {
    const units = this.units();
    const byGroup = {};
    for (const g of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) byGroup[g] = 0;
    let expiringSoon = 0;
    for (const u of units) {
      if (u.status === 'AVAILABLE' && u.expiryDate > now) {
        byGroup[u.bloodGroup]++;
        if (u.expiryDate - now < 3 * 864e5) expiringSoon++;
      }
    }
    const count = s => units.filter(u => u.status === s).length;
    let txCount = 0;
    for (const b of this.blocks) txCount += b.data.filter(t => t.type === 'ENDORSER').length;
    return {
      totalUnits: units.length, available: count('AVAILABLE'), awaitingTest: count('COLLECTED'), inTransit: count('IN_TRANSIT'),
      atHospital: count('AT_HOSPITAL'), transfused: count('TRANSFUSED'), discarded: count('DISCARDED') + count('REJECTED'),
      expiringSoon, byGroup, blockHeight: this.blocks.length, transactions: txCount, chainValid: this.validateChain().valid,
      latestHash: this.blocks[this.blocks.length - 1].hash, channel: CHANNEL,
    };
  }
}

module.exports = { Ledger, AccessError, ORGS, CHANNEL, CHAINCODE, ORDERER, ENDORSEMENT_POLICY, sha256 };
