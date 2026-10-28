// Does the installed starknet.js actually talk to the public Sepolia endpoints?
//
// starknet.js 7.x ships RPC07/RPC08 types and an isSupportedSpecVersion check, while the
// keyless public endpoints serve spec 0.9.0 (Cartridge) and 0.10.3 (dRPC). Rather than
// guess whether that mismatch is fatal, probe both and see.
import * as sn from 'starknet';

const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';

const ENDPOINTS = [
  { name: 'cartridge', url: 'https://api.cartridge.gg/x/starknet/sepolia', spec: '0.9.0' },
  { name: 'drpc', url: 'https://starknet-sepolia.drpc.org', spec: '0.10.3' },
];

console.log('starknet.js version exports RPC07/RPC08:', !!(sn.RPC07 && sn.RPC08));
if (typeof sn.isSupportedSpecVersion === 'function') {
  for (const s of ['0.7.1', '0.8.1', '0.9.0', '0.10.3']) {
    console.log(`  isSupportedSpecVersion('${s}') = ${sn.isSupportedSpecVersion(s)}`);
  }
}

for (const ep of ENDPOINTS) {
  console.log(`\n=== ${ep.name} (${ep.url}) expected spec ${ep.spec} ===`);
  try {
    const p = new sn.RpcProvider({ nodeUrl: ep.url });
    const spec = await p.getSpecVersion();
    console.log(`  getSpecVersion      -> ${spec}`);
    const chain = await p.getChainId();
    console.log(`  getChainId          -> ${chain}`);
    const block = await p.getBlockLatestAccepted();
    console.log(`  getBlockLatestAccepted -> #${block.block_number}`);
    const nonce = await p.getNonceForAddress(GATE);
    console.log(`  getNonceForAddress  -> ${nonce}`);
    // A real call into our deployed contract: prove ABI-less raw call works too.
    const res = await p.callContract({
      contractAddress: GATE,
      entrypoint: 'get_public_key',
      calldata: [],
    });
    console.log(`  callContract(get_public_key) -> ${JSON.stringify(res)}`);
    console.log('  RESULT: usable');
  } catch (e) {
    console.log(`  RESULT: FAILED -> ${e?.message ?? e}`);
  }
}
