// Demonstrates the actual motivating use case: one controlling session spawning
// and independently driving several labeled worker terminals at once.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [require('path').join(__dirname, '..', 'src', 'server.js')] });
  const client = new Client({ name: 'terminal-fleet-orchestration-demo', version: '0.1.0' });
  await client.connect(transport);

  console.log('=== spawning two labeled workers ===');
  await client.callTool({ name: 'term_spawn', arguments: { label: 'worker-a' } });
  await client.callTool({ name: 'term_spawn', arguments: { label: 'worker-b' } });
  await sleep(1500);

  console.log('=== giving each worker a different task ===');
  await client.callTool({ name: 'term_send', arguments: { pid: 'worker-a', text: 'echo TASK_A_RUNNING', enter: true } });
  await client.callTool({ name: 'term_send', arguments: { pid: 'worker-b', text: 'echo TASK_B_RUNNING', enter: true } });

  console.log('=== waiting for worker-a to settle instead of guessing a sleep ===');
  const waitA = await client.callTool({ name: 'term_wait', arguments: { pid: 'worker-a', idleMs: 1200, timeoutMs: 8000 } });
  console.log('worker-a settled:', waitA.structuredContent);

  console.log('\n=== reading both independently ===');
  const readA = await client.callTool({ name: 'term_read', arguments: { pid: 'worker-a' } });
  const readB = await client.callTool({ name: 'term_read', arguments: { pid: 'worker-b' } });
  console.log('--- worker-a ---\n' + readA.content[0].text);
  console.log('--- worker-b ---\n' + readB.content[0].text);

  console.log('\n=== term_list shows both tracked by label ===');
  const listRes = await client.callTool({ name: 'term_list', arguments: {} });
  console.log(listRes.content[0].text);

  await client.callTool({ name: 'term_close', arguments: { pid: 'worker-a' } });
  await client.callTool({ name: 'term_close', arguments: { pid: 'worker-b' } });
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
