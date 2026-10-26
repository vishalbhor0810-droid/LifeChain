/**
 * LifeChain - REST API (client gateway) + static web server. No external dependencies.
 * The caller's identity is passed in the X-Org header (simulates the wallet identity of a Fabric client).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Ledger, AccessError, ORGS, CHANNEL, CHAINCODE, ORDERER, ENDORSEMENT_POLICY } = require('./ledger');
const { BLOOD_GROUPS, SHELF_LIFE_DAYS, TESTS } = require('./chaincode');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ledger = new Ledger({ dataDir: path.join(ROOT, 'data') });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON body')); } });
  });
}

const routes = {
  'GET /api/stats': () => ledger.stats(),
  'GET /api/config': () => ({ channel: CHANNEL, chaincode: CHAINCODE, orderer: ORDERER, endorsementPolicy: ENDORSEMENT_POLICY, bloodGroups: BLOOD_GROUPS, components: SHELF_LIFE_DAYS, tests: TESTS, orgs: ledger.publicOrgs() }),
  'GET /api/units': () => ledger.units(),
  'GET /api/blocks': () => ledger.blocks,
  'GET /api/validate': () => ledger.validateChain(),
  'POST /api/tx': (body, org) => ledger.invoke(body.fn, body.args || {}, org),
  'POST /api/demo/double-allocation': body => ledger.doubleAllocation(body.unitId),
  'POST /api/tamper': body => ledger.tamper(Number(body.blockNumber), body.newGroup),
  'POST /api/restore': () => ledger.restore(),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  const org = req.headers['x-org'];
  try {
    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      return send(res, 200, routes[key](body, org));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/units\/([\w-]+)$/))) {
      const unit = ledger.unit(m[1]);
      return unit ? send(res, 200, { unit, history: ledger.history(m[1]) }) : send(res, 404, { error: `Blood unit ${m[1]} not found on the ledger` });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, err instanceof AccessError ? 403 : 400, { error: err.message, accessDenied: err instanceof AccessError });
  }
});

server.listen(PORT, () => {
  const s = ledger.stats();
  console.log('=====================================================');
  console.log('  LifeChain - Blood Bank Traceability Network');
  console.log('=====================================================');
  console.log(`  Channel           : ${CHANNEL}   Chaincode: ${CHAINCODE}`);
  console.log(`  Organizations     : ${ORGS.map(o => o.mspId).join(', ')}`);
  console.log(`  Endorsement policy: ${ENDORSEMENT_POLICY}`);
  console.log(`  Ledger height     : ${s.blockHeight} blocks, ${s.transactions} transactions`);
  console.log(`  World state       : ${s.totalUnits} blood units`);
  console.log(`  Chain valid       : ${s.chainValid}`);
  console.log(`  Gateway running at: http://localhost:${PORT}`);
});
