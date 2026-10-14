const http = require('http');

const PORT = 4045;

function makeRequest(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (payload.stream) {
          process.stdout.write(chunk.toString());
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('--- 1. Testing Non-Streaming Anthropic Request ---');
  const nonStreamRes = await makeRequest({
    model: 'opencode/space-bunny-free',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'Say "Space Bunny is online!" in 5 words.' }
    ]
  });

  console.log('\nStatus:', nonStreamRes.status);
  console.log('Response:\n', nonStreamRes.body);

  console.log('\n--- 2. Testing Streaming Anthropic Request (SSE) ---');
  const streamRes = await makeRequest({
    model: 'opencode/space-bunny-free',
    max_tokens: 100,
    stream: true,
    messages: [
      { role: 'user', content: 'Say "Hopping through space!"' }
    ]
  });
  console.log('\nStream completed with status:', streamRes.status);
}

runTests().catch(console.error);
