import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, match } from '../src/http.ts';

test('routing: a literal path beats a parameter registered earlier, and parameters still bind', () => {
  const calls: string[] = [];
  route.get('/api/t/:cid/pools/:id', 'read', async () => { calls.push('byId'); return null; });
  route.get('/api/t/:cid/pools/summary', 'read', async () => { calls.push('summary'); return null; });
  route.get('/api/t/:cid/pools', 'read', async () => { calls.push('list'); return null; });

  const summary = match('GET', '/api/t/co_1/pools/summary')!;
  assert.deepEqual(summary.params, { cid: 'co_1' });
  const byId = match('GET', '/api/t/co_1/pools/pol_9')!;
  assert.deepEqual(byId.params, { cid: 'co_1', id: 'pol_9' });
  assert.notEqual(summary.route, byId.route);
  assert.deepEqual(match('GET', '/api/t/co_1/pools')!.params, { cid: 'co_1' });
  assert.equal(match('POST', '/api/t/co_1/pools/summary'), null);
  assert.equal(match('GET', '/api/t/co_1/pools/summary/extra'), null);
  assert.equal(match('GET', '/api/t/co%201/pools/x')!.params.cid, 'co 1');
});
