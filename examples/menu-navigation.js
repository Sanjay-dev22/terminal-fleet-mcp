const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [require('path').join(__dirname, '..', 'src', 'server.js')] });
  const client = new Client({ name: 'terminal-fleet-keys-test', version: '0.1.0' });
  await client.connect(transport);

  const spawnRes = await client.callTool({ name: 'term_spawn', arguments: {} });
  const pid = spawnRes.structuredContent.pid;
  await sleep(2500);

  // PSReadLine history recall: type two commands, then press UP twice to recall the first one, then Enter.
  await client.callTool({ name: 'term_send', arguments: { pid, text: 'echo FIRST', enter: true } });
  await sleep(2000);
  await client.callTool({ name: 'term_send', arguments: { pid, text: 'echo SECOND', enter: true } });
  await sleep(2000);

  console.log('=== sending keys:[UP,UP] then enter (should recall "echo FIRST") ===');
  const keysRes = await client.callTool({ name: 'term_send', arguments: { pid, keys: ['UP', 'UP'], enter: true } });
  console.log(keysRes.content[0].text);
  await sleep(2000);

  console.log('\n=== sending a real shortcut: CTRL+C to interrupt a blocking Read-Host ===');
  await client.callTool({ name: 'term_send', arguments: { pid, text: "Read-Host 'blocking'", enter: true } });
  await sleep(1000);
  const ctrlCRes = await client.callTool({ name: 'term_send', arguments: { pid, keys: ['CTRL+C'] } });
  console.log(ctrlCRes.content[0].text);
  await sleep(1000);

  const readRes = await client.callTool({ name: 'term_read', arguments: { pid } });
  console.log('\n=== final screen ===\n' + readRes.content[0].text);

  await client.callTool({ name: 'term_close', arguments: { pid } });
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
