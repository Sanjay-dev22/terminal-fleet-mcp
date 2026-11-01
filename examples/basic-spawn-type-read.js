const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [require('path').join(__dirname, '..', 'src', 'server.js')] });
  const client = new Client({ name: 'terminal-fleet-manual-test', version: '0.1.0' });
  await client.connect(transport);

  console.log('=== tools/list ===');
  const tools = await client.listTools();
  console.log(tools.tools.map(t => t.name).join(', '));

  console.log('\n=== term_spawn ===');
  const spawnRes = await client.callTool({ name: 'term_spawn', arguments: { label: 'demo' } });
  console.log(spawnRes.content[0].text);
  const pid = spawnRes.structuredContent.pid;

  await sleep(1500);

  console.log('\n=== term_send (echo test, referring to the terminal by its label) ===');
  const sendRes = await client.callTool({ name: 'term_send', arguments: { pid: 'demo', text: 'echo TERMINAL_FLEET_TEST_OK', enter: true } });
  console.log(sendRes.content[0].text);

  await sleep(1500);

  console.log('\n=== term_read ===');
  const readRes = await client.callTool({ name: 'term_read', arguments: { pid: 'demo' } });
  console.log(readRes.content[0].text);

  console.log('\n=== term_list ===');
  const listRes = await client.callTool({ name: 'term_list', arguments: {} });
  console.log(listRes.content[0].text);

  console.log('\n=== term_close ===');
  const closeRes = await client.callTool({ name: 'term_close', arguments: { pid } });
  console.log(closeRes.content[0].text);

  await client.close();
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
