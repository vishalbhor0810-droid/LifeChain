// LifeChain frontend - vanilla JS single-page app with hash routing
const $view = document.getElementById('view');
const $org = document.getElementById('org-select');
let CONFIG = null;

const getOrg = () => { try { return localStorage.getItem('lifechain-org') || 'BloodBankOrg'; } catch { return 'BloodBankOrg'; } };
const setOrg = v => { try { localStorage.setItem('lifechain-org', v); } catch {} };

const api = async (url, body) => {
  const opts = { headers: { 'X-Org': $org.value || getOrg() } };
  if (body) Object.assign(opts, { method: 'POST', body: JSON.stringify(body), headers: { ...opts.headers, 'Content-Type': 'application/json' } });
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.accessDenied = data.accessDenied; throw e; }
  return data;
};
const tx = (fn, args) => api('/api/tx', { fn, args });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 10) => h ? `${h.slice(0, n)}…${h.slice(-6)}` : '';
const fmt = t => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const daysLeft = t => Math.ceil((t - Date.now()) / 864e5);
const badge = s => `<span class="badge b-${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;
const bg = g => `<span class="bg">${esc(g)}</span>`;
const orgName = id => CONFIG.orgs.find(o => o.id === id)?.name || id;
const isHospital = id => CONFIG.orgs.find(o => o.id === id)?.type === 'Hospital';
const toast = msg => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
const head = (title, sub) => `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>
  <div class="who">Identity: <b>${esc(orgName($org.value))}</b> · ${esc(CONFIG.orgs.find(o => o.id === $org.value).mspId)}</div></div>`;

function expiryCell(u) {
  if (['TRANSFUSED', 'DISCARDED', 'REJECTED'].includes(u.status)) return `<span class="muted">${fmtDate(u.expiryDate)}</span>`;
  const d = daysLeft(u.expiryDate);
  if (d <= 0) return `${fmtDate(u.expiryDate)} ${badge('EXPIRED')}`;
  return `${fmtDate(u.expiryDate)} <span class="${d <= 3 ? 'cross' : 'muted'}">(${d} d)</span>`;
}

function receipt(r, title) {
  return `<div class="banner ${r.validationCode === 'VALID' ? 'ok' : 'bad'}"><span class="big">${r.validationCode === 'VALID' ? '✔' : '✖'}</span>
      ${title} — transaction committed in block #${r.blockNumber} (${r.validationCode})</div>
    <table class="receipt">
      <tr><td>Chaincode function</td><td><b>${esc(r.fn)}</b></td></tr>
      <tr><td>Transaction ID</td><td class="mono">${r.txId}</td></tr>
      <tr><td>Block hash</td><td class="mono">${r.blockHash}</td></tr>
      ${r.endorsements.map(e => `<tr><td>Endorsed by</td><td>${badge('ok')} <b>${e.mspId}</b> <span class="muted">${e.peer}</span><div class="mono muted">sig ${e.signature}</div></td></tr>`).join('')}
      ${Object.entries(r.response || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(k.toLowerCase().includes('date') ? fmt(v) : v)}</td></tr>`).join('')}
    </table>`;
}

const errorBanner = err => `<div class="banner bad"><span class="big">${err.accessDenied ? '⛔' : '✖'}</span>${err.accessDenied ? 'Proposal rejected by endorsing peers. ' : 'Chaincode error. '}${esc(err.message)}</div>`;

async function refreshSide() {
  const v = await api('/api/validate');
  document.getElementById('side-status').innerHTML = v.valid
    ? `<span class="dot"></span>Peer online · ledger valid<br><span class="muted">channel bloodchannel · ${v.height} blocks</span>`
    : `<span class="dot bad"></span>Ledger integrity broken!<br><span class="muted">${v.errors.length} error(s) detected</span>`;
}

// ------------------------------------------------------------------ Views
const views = {
  async dashboard() {
    const [s, blocks] = await Promise.all([api('/api/stats'), api('/api/blocks')]);
    const recentTx = blocks.flatMap(b => b.data.filter(t => t.type === 'ENDORSER').map(t => ({ ...t, block: b.header.number }))).reverse().slice(0, 6);
    return `${head('Dashboard', 'Live view of the LifeChain blood supply network')}
      <div class="banner ${s.chainValid ? 'ok' : 'bad'}"><span class="big">${s.chainValid ? '✔' : '✖'}</span>
        ${s.chainValid ? `Ledger integrity verified — ${s.blockHeight} blocks, ${s.transactions} transactions, all hashes and endorsements valid.` : 'Ledger integrity check FAILED — stored data has been tampered with.'}</div>
      <div class="grid grid-4">
        <div class="stat"><div class="label">Available units</div><div class="value">${s.available}</div><div class="sub">tested safe, in blood bank</div></div>
        <div class="stat"><div class="label">Awaiting lab test</div><div class="value">${s.awaitingTest}</div><div class="sub">collected, not yet screened</div></div>
        <div class="stat"><div class="label">In transit / at hospitals</div><div class="value">${s.inTransit + s.atHospital}</div><div class="sub">${s.inTransit} in transit · ${s.atHospital} stored</div></div>
        <div class="stat"><div class="label">Transfused / discarded</div><div class="value">${s.transfused} / ${s.discarded}</div><div class="sub">${s.totalUnits} units tracked in total</div></div>
      </div>
      <div class="card" style="margin-top:18px"><h2>Available stock by blood group ${s.expiringSoon ? `<span class="badge b-PENDING" style="margin-left:8px">${s.expiringSoon} unit(s) expiring within 3 days</span>` : ''}</h2>
        <div class="grid grid-8">${Object.entries(s.byGroup).map(([g, n]) => `<div class="group ${n === 0 ? 'none' : n < 2 ? 'low' : ''}"><div class="g">${g}</div><div class="n">${n}</div><div class="u">${n === 0 ? 'out of stock' : 'units'}</div></div>`).join('')}</div></div>
      <div class="card"><h2>Latest blocks</h2><div class="chain-strip">
        ${blocks.slice(-5).map((b, i) => `${i ? '<span class="link">⟶</span>' : ''}<div class="mini-block"><b>Block #${b.header.number}</b>
          <div class="muted">${b.data.length} tx · ${b.data[0].type === 'CONFIG' ? 'config' : esc(b.data[0].proposal.fn)}</div>
          <div class="mono">hash: ${short(b.hash, 8)}</div><div class="mono muted">prev: ${short(b.header.previousHash, 8)}</div></div>`).join('')}
      </div></div>
      <div class="card"><h2>Recent transactions</h2><table><tr><th>Block</th><th>Function</th><th>Unit</th><th>Submitted by</th><th>Time</th><th>Status</th></tr>
        ${recentTx.map(t => `<tr><td>#${t.block}</td><td><b>${t.proposal.fn}</b></td><td><a href="#/trace/${t.proposal.args.unitId}">${t.proposal.args.unitId}</a></td><td>${esc(orgName(t.proposal.creator))}</td><td class="muted">${fmt(t.proposal.timestamp)}</td><td>${badge(t.validationCode)}</td></tr>`).join('')}
      </table></div>`;
  },

  async collect() {
    const units = await api('/api/units');
    const next = 'BU-2026-' + String(Math.max(100, ...units.map(u => +u.unitId.split('-')[2])) + 1).padStart(4, '0');
    return `${head('Collect Donation', 'Blood bank registers a new blood unit on the ledger (chaincode: CollectBlood)')}
      <div class="grid grid-2">
        <div class="card"><h2>Donation details</h2>
          <form id="collect-form">
            <div class="row"><div class="field"><label>Blood unit ID (barcode)</label><input name="unitId" value="${next}" required></div>
              <div class="field"><label>Donor ID</label><input name="donorId" placeholder="e.g. DNR-48301" required></div></div>
            <div class="row"><div class="field"><label>Blood group</label><select name="bloodGroup">${CONFIG.bloodGroups.map(g => `<option>${g}</option>`).join('')}</select></div>
              <div class="field"><label>Component</label><select name="component">${Object.entries(CONFIG.components).map(([c, d]) => `<option value="${c}">${c} (${d} days)</option>`).join('')}</select></div></div>
            <div class="row"><div class="field"><label>Volume (ml)</label><input name="volumeMl" type="number" value="450" min="50" max="500" required></div>
              <div class="field"><label>Collection centre</label><input name="collectionCenter" value="LifeLine Blood Bank – Andheri Camp"></div></div>
            <button class="btn">Submit transaction</button>
          </form>
          <p class="muted" style="margin-bottom:0;font-size:12px">The donor's identity is kept off-chain; only a pseudonymous SHA-256 reference is written to the ledger.</p>
        </div>
        <div class="card" id="result"><h2>What happens on submit</h2>
          <ol class="muted" style="line-height:1.85;padding-left:18px;margin:0">
            <li>The client signs a <b>transaction proposal</b> with the blood bank's identity.</li>
            <li>Peers of <b>BloodBankMSP</b> and <b>RegulatorMSP</b> simulate the chaincode and <b>endorse</b> the read/write set.</li>
            <li>The <b>ordering service</b> places the endorsed transaction into a new block.</li>
            <li>Peers <b>validate</b> the endorsements and version checks, then <b>commit</b> the unit to the world state.</li>
          </ol></div>
      </div>`;
  },

  async testing() {
    const units = (await api('/api/units')).filter(u => u.status === 'COLLECTED');
    return `${head('Lab Testing', 'Testing laboratory records infection screening results (chaincode: RecordTest)')}
      <div class="grid grid-2">
        <div class="card"><h2>Record screening result</h2>
          ${units.length ? `<form id="test-form">
            <div class="row"><div class="field"><label>Blood unit</label><select name="unitId">${units.map(u => `<option value="${u.unitId}">${u.unitId} — ${u.bloodGroup} ${u.component}</option>`).join('')}</select></div>
              <div class="field"><label>Lab report no.</label><input name="reportRef" value="LAB-${Date.now().toString().slice(-5)}"></div></div>
            <table>${CONFIG.tests.map(t => `<tr><td><b>${t}</b></td><td><select name="${t}"><option>NEGATIVE</option><option>POSITIVE</option></select></td></tr>`).join('')}</table>
            <button class="btn" style="margin-top:14px">Submit test results</button></form>` : '<div class="empty">No units are waiting for testing.</div>'}
        </div>
        <div class="card" id="result"><h2>Units awaiting testing (${units.length})</h2>
          ${units.length ? `<table><tr><th>Unit</th><th>Group</th><th>Component</th><th>Collected</th></tr>
            ${units.map(u => `<tr><td><a href="#/trace/${u.unitId}">${u.unitId}</a></td><td>${bg(u.bloodGroup)}</td><td>${u.component}</td><td class="muted">${fmt(u.collectedAt)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing pending.</div>'}
        </div>
      </div>`;
  },

  async distribution() {
    const units = await api('/api/units');
    const avail = units.filter(u => u.status === 'AVAILABLE');
    const transit = units.filter(u => u.status === 'IN_TRANSIT');
    const hosp = CONFIG.orgs.filter(o => o.type === 'Hospital');
    return `${head('Distribution', 'Blood bank issues tested units to hospitals (chaincode: TransferUnit)')}
      <div id="result"></div>
      <div class="card"><h2>Tested units available for issue (${avail.length})</h2>
        <table><tr><th>Unit</th><th>Group</th><th>Component</th><th>Volume</th><th>Expiry</th><th>Issue to hospital</th><th></th></tr>
        ${avail.map(u => `<tr><td><a href="#/trace/${u.unitId}">${u.unitId}</a></td><td>${bg(u.bloodGroup)}</td><td>${u.component}</td><td>${u.volumeMl} ml</td><td>${expiryCell(u)}</td>
          <td><select data-dest="${u.unitId}">${hosp.map(h => `<option value="${h.id}">${h.name}</option>`).join('')}</select></td>
          <td><button class="btn sm" data-transfer="${u.unitId}">Issue unit</button></td></tr>`).join('')}</table></div>
      <div class="card"><h2>In transit (${transit.length})</h2>
        ${transit.length ? `<table><tr><th>Unit</th><th>Group</th><th>Component</th><th>Destination</th><th>Dispatched</th></tr>
        ${transit.map(u => `<tr><td><a href="#/trace/${u.unitId}">${u.unitId}</a></td><td>${bg(u.bloodGroup)}</td><td>${u.component}</td><td>${esc(orgName(u.transferTo))}</td><td class="muted">${fmt(u.lastUpdated)}</td></tr>`).join('')}</table>` : '<div class="empty">No units in transit.</div>'}</div>`;
  },

  async hospital() {
    const me = $org.value;
    if (!isHospital(me)) return `${head('Hospital', 'Receive units and record transfusions')}<div class="banner info"><span class="big">ℹ</span>Switch the identity in the sidebar to CityCare Hospital or Green Valley Hospital to use this page.</div>`;
    const units = await api('/api/units');
    const incoming = units.filter(u => u.status === 'IN_TRANSIT' && u.transferTo === me);
    const stock = units.filter(u => u.status === 'AT_HOSPITAL' && u.custodian === me);
    return `${head('Hospital — ' + esc(orgName(me)), 'Receive blood units and record transfusions (chaincode: ReceiveUnit, TransfuseUnit)')}
      <div id="result"></div>
      <div class="grid grid-2">
        <div class="card"><h2>Incoming units (${incoming.length})</h2>
          ${incoming.length ? `<table><tr><th>Unit</th><th>Group</th><th>Component</th><th></th></tr>
            ${incoming.map(u => `<tr><td><a href="#/trace/${u.unitId}">${u.unitId}</a></td><td>${bg(u.bloodGroup)}</td><td>${u.component}</td><td><button class="btn sm ok" data-receive="${u.unitId}">Confirm receipt</button></td></tr>`).join('')}</table>` : '<div class="empty">No incoming units.</div>'}</div>
        <div class="card"><h2>Record transfusion</h2>
          ${stock.length ? `<form id="transfuse-form">
            <div class="field"><label>Blood unit in hospital stock</label><select name="unitId">${stock.map(u => `<option value="${u.unitId}">${u.unitId} — ${u.bloodGroup} ${u.component} (exp. ${fmtDate(u.expiryDate)})</option>`).join('')}</select></div>
            <div class="row"><div class="field"><label>Patient ID</label><input name="patientId" placeholder="e.g. PAT-CC-8120" required></div>
              <div class="field"><label>Patient blood group</label><select name="patientBloodGroup">${CONFIG.bloodGroups.map(g => `<option>${g}</option>`).join('')}</select></div></div>
            <button class="btn">Record transfusion</button>
            <p class="muted" style="font-size:12px;margin-bottom:0">Chaincode blocks expired units and ABO/Rh-incompatible transfusions.</p></form>` : '<div class="empty">No units in hospital stock.</div>'}</div>
      </div>`;
  },

  async inventory(param) {
    const units = await api('/api/units');
    const [fs, fg] = (param || 'ALL,ALL').split(',').map(s => s || 'ALL');
    const list = units.filter(u => (fs === 'ALL' || u.status === fs) && (fg === 'ALL' || u.bloodGroup === fg));
    const statuses = ['ALL', 'COLLECTED', 'AVAILABLE', 'IN_TRANSIT', 'AT_HOSPITAL', 'TRANSFUSED', 'REJECTED', 'DISCARDED'];
    return `${head('Inventory', 'Current world state of every blood unit recorded on the ledger')}
      <div class="card"><div class="row" style="margin-bottom:14px">
        <div class="field" style="max-width:220px;margin:0"><label>Status</label><select id="f-status">${statuses.map(s => `<option ${s === fs ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field" style="max-width:160px;margin:0"><label>Blood group</label><select id="f-group">${['ALL', ...CONFIG.bloodGroups].map(g => `<option ${g === fg ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
        <span class="muted" style="margin-left:auto">${list.length} of ${units.length} units</span></div>
      <table><tr><th>Unit ID</th><th>Group</th><th>Component</th><th>Donor ref.</th><th>Collected</th><th>Expiry</th><th>Custodian</th><th>Status</th></tr>
      ${list.map(u => `<tr><td><a href="#/trace/${u.unitId}">${u.unitId}</a></td><td>${bg(u.bloodGroup)}</td><td>${u.component}</td><td class="mono">${u.donorRef}</td>
        <td class="muted">${fmtDate(u.collectedAt)}</td><td>${expiryCell(u)}</td><td>${esc(orgName(u.custodian))}</td><td>${badge(u.status)}</td></tr>`).join('')}</table></div>`;
  },

  async trace(param) {
    let body = '';
    if (param) {
      try {
        const { unit: u, history } = await api('/api/units/' + encodeURIComponent(param));
        const t = u.testResult;
        body = `<div class="grid grid-2">
          <div class="card"><h2>Unit ${u.unitId} ${badge(u.status)}</h2><table class="receipt">
            <tr><td>Blood group</td><td>${bg(u.bloodGroup)}</td></tr>
            <tr><td>Component / volume</td><td>${u.component} · ${u.volumeMl} ml</td></tr>
            <tr><td>Donor reference</td><td class="mono">${u.donorRef}</td></tr>
            <tr><td>Collected</td><td>${fmt(u.collectedAt)} · ${esc(u.collectionCenter)}</td></tr>
            <tr><td>Expiry</td><td>${expiryCell(u)}</td></tr>
            <tr><td>Current custodian</td><td>${esc(orgName(u.custodian))}</td></tr>
            <tr><td>Screening</td><td>${t ? `${badge(t.verdict)} ${CONFIG.tests.map(x => `<span class="badge b-${t[x]}" title="${x}">${x}</span>`).join(' ')}` : '<span class="muted">Not tested yet</span>'}</td></tr>
            ${u.transfusion ? `<tr><td>Transfused to</td><td>${u.transfusion.patientRef} (${u.transfusion.patientBloodGroup}) at ${esc(orgName(u.transfusion.hospital))}</td></tr>` : ''}
          </table></div>
          <div class="card"><h2>Provenance timeline (${history.length} ledger events)</h2><ul class="timeline">
            ${history.map(h => `<li><div class="t-head"><b>${h.value.lastAction.replace(/_/g, ' ')}</b>${badge(h.validationCode)}<span class="muted">block #${h.blockNumber}</span></div>
              <div>${esc(h.value.lastDetails)}</div>
              <div class="t-meta">${fmt(h.timestamp)} · by ${esc(orgName(h.creator))} · endorsed by ${h.endorsedBy.join(' + ')}</div>
              <div class="t-meta mono">tx ${short(h.txId, 16)}</div></li>`).join('')}
          </ul></div></div>`;
      } catch (err) { body = errorBanner(err); }
    }
    return `${head('Trace Unit', 'Full donor-to-patient history of a blood unit (chaincode query: QueryUnitHistory)')}
      <div class="card"><form id="trace-form" class="row"><input name="unitId" placeholder="Enter blood unit ID, e.g. BU-2026-0101" value="${esc(param || '')}" style="flex:1"><button class="btn">Trace</button></form></div>${body}`;
  },

  async explorer() {
    const [blocks, v] = await Promise.all([api('/api/blocks'), api('/api/validate')]);
    const bad = new Set(v.errors.map(e => e.block));
    return `${head('Block Explorer', 'Blocks created by the ordering service on channel bloodchannel')}
      ${blocks.slice().reverse().map(b => `<div class="block ${bad.has(b.header.number) ? 'bad' : ''}">
        <div class="block-head"><b>Block #${b.header.number}${b.header.number === 0 ? ' (Genesis / channel config)' : ''}</b><span class="muted">${fmt(b.metadata.timestamp)} · ${b.metadata.orderer} · ${b.data.length} tx</span></div>
        <div class="kv"><span class="k">Block hash</span><span class="mono">${b.hash}</span>
          <span class="k">Previous hash</span><span class="mono">${b.header.previousHash}</span>
          <span class="k">Data hash</span><span class="mono">${b.header.dataHash}</span></div>
        ${b.data.slice(0, 6).map(t => t.type === 'CONFIG'
          ? `<div class="tx">${badge('CONFIG')}<span>Channel <b>${t.channel}</b> · orgs: ${t.config.organizations.join(', ')}</span></div>`
          : `<div class="tx">${badge(t.validationCode)}<b>${t.proposal.fn}</b><a href="#/trace/${t.proposal.args.unitId}">${t.proposal.args.unitId}</a>
             <span class="muted">by ${t.proposal.creator}</span><span class="mono muted" style="margin-left:auto">endorsed: ${t.endorsements.map(e => e.mspId).join(' + ')} · tx ${short(t.txId, 8)}</span></div>`).join('')}
        ${b.data.length > 6 ? `<div class="tx muted">… and ${b.data.length - 6} more transactions</div>` : ''}
      </div>`).join('')}`;
  },

  async network() {
    const s = await api('/api/stats');
    return `${head('Network', 'Permissioned consortium: organizations, peers, identities and policies')}
      <div class="card"><h2>Member organizations (MSP)</h2><table><tr><th>MSP ID</th><th>Organization</th><th>Role</th><th>Peer node</th><th>Certificate authority</th><th>Key fingerprint</th></tr>
        ${CONFIG.orgs.map(o => `<tr><td><b>${o.mspId}</b></td><td>${esc(o.name)}</td><td>${o.type}</td><td class="mono">${o.peer}</td><td class="mono">${o.ca}</td><td class="mono">${o.keyFingerprint}</td></tr>`).join('')}</table></div>
      <div class="grid grid-2">
        <div class="card"><h2>Channel configuration</h2><table class="receipt">
          <tr><td>Channel</td><td><b>${CONFIG.channel}</b></td></tr>
          <tr><td>Chaincode</td><td>${CONFIG.chaincode} v1.0</td></tr>
          <tr><td>Ordering service</td><td>${CONFIG.orderer}</td></tr>
          <tr><td>Endorsement policy</td><td class="mono">${esc(CONFIG.endorsementPolicy)}</td></tr>
          <tr><td>Signatures</td><td>ECDSA P-256 with SHA-256</td></tr>
          <tr><td>Ledger height</td><td>${s.blockHeight} blocks · ${s.transactions} transactions</td></tr></table></div>
        <div class="card"><h2>Access control rules (chaincode)</h2><table>
          <tr><th>Function</th><th>Who may invoke</th></tr>
          <tr><td>CollectBlood</td><td>BloodBankMSP</td></tr>
          <tr><td>RecordTest</td><td>LabMSP</td></tr>
          <tr><td>TransferUnit</td><td>Current custodian of the unit</td></tr>
          <tr><td>ReceiveUnit</td><td>Destination hospital only</td></tr>
          <tr><td>TransfuseUnit</td><td>Hospital holding the unit</td></tr>
          <tr><td>Query / audit</td><td>All members incl. RegulatorMSP</td></tr></table></div>
      </div>`;
  },

  async security() {
    const [units, blocks, v] = await Promise.all([api('/api/units'), api('/api/blocks'), api('/api/validate')]);
    const avail = units.filter(u => u.status === 'AVAILABLE');
    const collectBlocks = blocks.filter(b => b.data.some(t => t.proposal?.fn === 'CollectBlood'));
    return `${head('Security Tests', 'Demonstrations of double-allocation prevention and tamper detection')}
      <div class="banner ${v.valid ? 'ok' : 'bad'}"><span class="big">${v.valid ? '✔' : '✖'}</span>
        ${v.valid ? `Ledger is VALID — ${v.height} blocks verified (block hashes, hash links, data hashes and endorsement signatures).` : `Ledger is INVALID — ${v.errors.length} integrity error(s) detected.`}</div>
      <div class="grid grid-2">
        <div class="card"><h2>1. Double allocation (MVCC conflict)</h2>
          <p class="muted" style="margin-top:0">The same blood unit is issued to two hospitals at the same moment. Both proposals are endorsed, but during validation only the first transaction in the block is valid — the second reads an outdated version of the unit.</p>
          <div class="row"><div class="field" style="margin:0"><label>Blood unit</label><select id="d-unit">${avail.map(u => `<option value="${u.unitId}">${u.unitId} — ${u.bloodGroup} ${u.component}</option>`).join('')}</select></div>
            <button class="btn info" id="double-btn">Issue to both hospitals</button></div>
          <div id="double-result" style="margin-top:14px"></div></div>
        <div class="card"><h2>2. Tamper with a stored block</h2>
          <p class="muted" style="margin-top:0">An insider edits the blood group of a unit directly in the stored ledger file, without going through endorsement.</p>
          <div class="row"><div class="field" style="margin:0"><label>Target block</label><select id="t-block">${collectBlocks.map(b => `<option value="${b.header.number}">Block #${b.header.number} (CollectBlood)</option>`).join('')}</select></div>
            <div class="field" style="margin:0;max-width:110px"><label>New group</label><select id="t-group">${CONFIG.bloodGroups.map(g => `<option ${g === 'O-' ? 'selected' : ''}>${g}</option>`).join('')}</select></div></div>
          <div class="row" style="margin-top:12px"><button class="btn" id="tamper-btn">Tamper with block</button><button class="btn ok" id="restore-btn">Restore ledger</button></div>
          ${v.valid ? '' : `<table style="margin-top:14px"><tr><th>Block</th><th>Problem detected</th></tr>${v.errors.slice(0, 6).map(e => `<tr><td><b>#${e.block}</b></td><td class="cross">${esc(e.reason)}</td></tr>`).join('')}</table>`}
        </div>
      </div>
      <div class="card"><h2>Hash-linked blocks</h2><div class="chain-strip">
        ${blocks.slice(0, 7).map((b, i) => `${i ? '<span class="link">⟶</span>' : ''}<div class="mini-block ${v.errors.some(e => e.block === b.header.number) ? 'bad' : ''}"><b>Block #${b.header.number}</b>
          <div class="mono">hash: ${short(b.hash, 8)}</div><div class="mono muted">prev: ${short(b.header.previousHash, 8)}</div></div>`).join('')}
      </div></div>`;
  },
};

// ------------------------------------------------------------------ Event binding
const formData = f => Object.fromEntries(new FormData(f));

function bind(route) {
  const result = document.getElementById('result');
  const run = async (fn, args, title) => {
    try { result.innerHTML = receipt(await tx(fn, args), title); toast(`${fn} committed`); refreshSide(); return true; }
    catch (err) { result.innerHTML = errorBanner(err); return false; }
  };
  if (route === 'collect') document.getElementById('collect-form').onsubmit = e => { e.preventDefault(); run('CollectBlood', formData(e.target), 'Blood unit registered'); };
  if (route === 'testing') {
    const f = document.getElementById('test-form');
    if (f) f.onsubmit = e => {
      e.preventDefault();
      const d = formData(f);
      run('RecordTest', { unitId: d.unitId, reportRef: d.reportRef, results: Object.fromEntries(CONFIG.tests.map(t => [t, d[t]])) }, 'Screening result recorded');
    };
  }
  if (route === 'distribution') document.querySelectorAll('[data-transfer]').forEach(b => b.onclick = async () => {
    const id = b.dataset.transfer;
    const ok = await run('TransferUnit', { unitId: id, toOrg: document.querySelector(`[data-dest="${id}"]`).value }, `Unit ${id} dispatched`);
    if (ok) b.closest('tr').style.opacity = .4;
  });
  if (route === 'hospital') {
    document.querySelectorAll('[data-receive]').forEach(b => b.onclick = () => run('ReceiveUnit', { unitId: b.dataset.receive }, `Unit ${b.dataset.receive} received`));
    const f = document.getElementById('transfuse-form');
    if (f) f.onsubmit = e => { e.preventDefault(); run('TransfuseUnit', formData(f), 'Transfusion recorded'); };
  }
  if (route === 'inventory') {
    const go = () => { location.hash = `#/inventory/${document.getElementById('f-status').value},${encodeURIComponent(document.getElementById('f-group').value)}`; };
    document.getElementById('f-status').onchange = go;
    document.getElementById('f-group').onchange = go;
  }
  if (route === 'trace') document.getElementById('trace-form').onsubmit = e => { e.preventDefault(); location.hash = '#/trace/' + e.target.unitId.value.trim(); };
  if (route === 'security') {
    document.getElementById('double-btn').onclick = async () => {
      try {
        const r = await api('/api/demo/double-allocation', { unitId: document.getElementById('d-unit').value });
        document.getElementById('double-result').innerHTML = `<table><tr><th>Transaction</th><th>Destination</th><th>Validation (block #${r.blockNumber})</th></tr>
          ${r.results.map(x => `<tr><td class="mono">${short(x.txId, 8)}</td><td>${esc(orgName(x.toOrg))}</td><td>${badge(x.validationCode)}</td></tr>`).join('')}</table>
          <p class="muted" style="margin-bottom:0">Only one hospital receives the unit — the conflicting transaction is recorded but marked invalid and does not change the world state.</p>`;
        refreshSide();
      } catch (err) { document.getElementById('double-result').innerHTML = errorBanner(err); }
    };
    document.getElementById('tamper-btn').onclick = async () => {
      try { const r = await api('/api/tamper', { blockNumber: document.getElementById('t-block').value, newGroup: document.getElementById('t-group').value }); toast(`${r.unitId}: blood group ${r.oldGroup} → ${r.newGroup}`); }
      catch (err) { toast(err.message); }
      render();
    };
    document.getElementById('restore-btn').onclick = async () => { await api('/api/restore', {}); toast('Ledger restored from peer copy'); render(); };
  }
}

async function render() {
  const [route, param] = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
  const name = views[route] ? route : 'dashboard';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  try {
    $view.innerHTML = await views[name](param && decodeURIComponent(param));
    bind(name);
  } catch (err) {
    $view.innerHTML = errorBanner(err);
  }
  refreshSide();
}

(async function init() {
  CONFIG = await (await fetch('/api/config')).json();
  $org.innerHTML = CONFIG.orgs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
  $org.value = getOrg();
  $org.onchange = () => { setOrg($org.value); render(); };
  window.addEventListener('hashchange', render);
  render();
})();
